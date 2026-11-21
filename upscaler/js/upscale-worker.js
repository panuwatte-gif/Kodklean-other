// ส่วนประมวลผล AI — ทำงานเบื้องหลัง แยกจากหน้าจอ เพื่อไม่ให้หน้าเว็บค้างระหว่างขยายภาพ
import * as ort from '../vendor/ort/ort.webgpu.bundle.min.mjs';
import { CONFIG } from './config.js';
import { planSteps, tileGrid, countTiles } from './tiling.js';

const SCALE = CONFIG.model.scale;
const base = new URL('../', import.meta.url);

const cores = self.navigator.hardwareConcurrency || 2;
const threads = self.crossOriginIsolated
  ? Math.min(CONFIG.maxThreads, cores <= 2 ? cores : cores - 1)
  : 1;
ort.env.wasm.wasmPaths = new URL('vendor/ort/', base).href;
ort.env.wasm.numThreads = threads;
ort.env.logLevel = 'error';

// ---------- การเตรียมเครื่องยนต์ (เลือก GPU หรือ CPU อัตโนมัติ) ----------
const engine = { model: null, cpu: null, gpu: null, auto: null, info: null };
let cancelRequested = false;

async function loadModel() {
  if (!engine.model) {
    const res = await fetch(new URL(CONFIG.model.url, base));
    if (!res.ok) throw new Error('โหลดไฟล์โมเดลไม่สำเร็จ');
    engine.model = new Uint8Array(await res.arrayBuffer());
  }
  return engine.model.slice();
}

async function createSession(provider) {
  return ort.InferenceSession.create(await loadModel(), {
    executionProviders: [provider],
    graphOptimizationLevel: 'all',
  });
}

function testInput(n) {
  const data = new Float32Array(3 * n * n);
  for (let i = 0; i < data.length; i++) data[i] = ((i * 37) % 251) / 250;
  return new ort.Tensor('float32', data, [1, 3, n, n]);
}

async function timedRun(session, n) {
  const input = testInput(n);
  await session.run({ input });            // รอบอุ่นเครื่อง
  const t0 = performance.now();
  const out = (await session.run({ input })).output;
  return { ms: performance.now() - t0, data: out.data };
}

function maxDiff(a, b) {
  let m = 0;
  for (let i = 0; i < a.length; i += 7) m = Math.max(m, Math.abs(a[i] - b[i]));
  return m;
}

/** เตรียม CPU เสมอ และลอง GPU ถ้ามี — ใช้ GPU ต่อเมื่อผลถูกต้องตรงกับ CPU และเร็วกว่าจริง */
async function ensureEngine() {
  if (engine.auto) return;
  post({ type: 'status', text: 'กำลังโหลดโมเดล AI (ครั้งแรกอาจใช้เวลาสักครู่)…' });
  engine.cpu = await createSession('wasm');
  const cpu = await timedRun(engine.cpu, 96);
  let note = 'ไม่พบ GPU ที่เบราว์เซอร์ใช้ได้';
  engine.auto = 'cpu';
  if (self.navigator.gpu) {
    try {
      const adapter = await self.navigator.gpu.requestAdapter();
      if (adapter) {
        engine.gpu = await createSession('webgpu');
        const gpu = await timedRun(engine.gpu, 96);
        const diff = maxDiff(cpu.data, gpu.data);
        if (!(diff < 0.02)) note = 'GPU ให้ผลไม่ตรง จึงใช้ CPU';
        else if (gpu.ms >= cpu.ms) note = 'GPU ช้ากว่า CPU จึงใช้ CPU';
        else { engine.auto = 'gpu'; note = `GPU เร็วกว่า CPU ราว ${(cpu.ms / gpu.ms).toFixed(1)} เท่า`; }
        if (engine.auto !== 'gpu') { await engine.gpu.release?.(); engine.gpu = null; }
      }
    } catch (e) {
      engine.gpu = null;
      note = 'เปิดใช้ GPU ไม่สำเร็จ จึงใช้ CPU';
    }
  }
  engine.info = { auto: engine.auto, threads, isolated: !!self.crossOriginIsolated, note };
  post({ type: 'engine', ...engine.info });
}

// ---------- เครื่องมือเกี่ยวกับภาพ ----------
function makeCanvas(w, h) {
  let canvas, ctx;
  try {
    canvas = new OffscreenCanvas(w, h);
    ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#fff';
    ctx.fillRect(w - 1, h - 1, 1, 1);
    if (ctx.getImageData(w - 1, h - 1, 1, 1).data[3] !== 255) throw new Error('blank');
    ctx.clearRect(0, 0, w, h);
  } catch (e) {
    throw new Error(`เครื่องนี้สร้างภาพขนาด ${w.toLocaleString()}×${h.toLocaleString()} ไม่ได้ (หน่วยความจำไม่พอ) — ลองลดขนาดผลลัพธ์`);
  }
  return { canvas, ctx };
}

function freeCanvas(c) { if (c) { c.canvas.width = 0; c.canvas.height = 0; } }

function resize(src, w, h) {
  const dst = makeCanvas(w, h);
  dst.ctx.imageSmoothingEnabled = true;
  dst.ctx.imageSmoothingQuality = 'high';
  dst.ctx.drawImage(src.canvas, 0, 0, w, h);
  return dst;
}

function hasTransparency(c) {
  const { width: w, height: h } = c.canvas;
  for (let y = 0; y < h; y += 512) {
    const d = c.ctx.getImageData(0, y, w, Math.min(512, h - y)).data;
    for (let i = 3; i < d.length; i += 4) if (d[i] < 255) return true;
  }
  return false;
}

/** ดึงชิ้นภาพ (รวมขอบ) ออกมาเป็นตัวเลขสำหรับ AI — ขอบที่เลยภาพใช้สีพิกเซลริมสุดแทน */
function readTile(src, tile, tw, th, pad, buf) {
  const W = src.canvas.width, H = src.canvas.height;
  const x0 = tile.x - pad, y0 = tile.y - pad;
  const cx = Math.max(0, x0), cy = Math.max(0, y0);
  const cw = Math.min(W, x0 + tw) - cx, ch = Math.min(H, y0 + th) - cy;
  const d = src.ctx.getImageData(cx, cy, cw, ch).data;
  const plane = tw * th;
  const xmap = new Int32Array(tw);
  for (let x = 0; x < tw; x++) xmap[x] = (Math.min(W - 1, Math.max(0, x0 + x)) - cx) * 4;
  for (let y = 0; y < th; y++) {
    const row = (Math.min(H - 1, Math.max(0, y0 + y)) - cy) * cw * 4;
    const o = y * tw;
    for (let x = 0; x < tw; x++) {
      const s = row + xmap[x];
      buf[o + x] = d[s] / 255;
      buf[plane + o + x] = d[s + 1] / 255;
      buf[2 * plane + o + x] = d[s + 2] / 255;
    }
  }
}

/** เขียนผลของชิ้นภาพ (เฉพาะส่วนกลาง ไม่เอาขอบ) ลงภาพปลายทาง */
function writeTile(dst, tile, out, tw, th, pad) {
  const OW = tw * SCALE, plane = OW * th * SCALE;
  const w = tile.cw * SCALE, h = tile.ch * SCALE, off = pad * SCALE;
  const img = new ImageData(w, h);
  const p = img.data;
  for (let y = 0; y < h; y++) {
    let s = (y + off) * OW + off, t = y * w * 4;
    for (let x = 0; x < w; x++, s++, t += 4) {
      p[t] = out[s] * 255;                     // Uint8ClampedArray ปัดเศษและตัดค่าเกิน 0–255 ให้เอง
      p[t + 1] = out[plane + s] * 255;
      p[t + 2] = out[2 * plane + s] * 255;
      p[t + 3] = 255;
    }
  }
  dst.ctx.putImageData(img, tile.x * SCALE, tile.y * SCALE);
}

class Cancelled extends Error {}

async function aiPass(session, src, progress) {
  const W = src.canvas.width, H = src.canvas.height;
  const { size, pad } = CONFIG.tile;
  const { tw, th, tiles } = tileGrid(W, H, size, pad);
  const dst = makeCanvas(W * SCALE, H * SCALE);
  const buf = new Float32Array(3 * tw * th);
  try {
    for (const tile of tiles) {
      if (cancelRequested) throw new Cancelled();
      readTile(src, tile, tw, th, pad, buf);
      const result = await session.run({ input: new ort.Tensor('float32', buf, [1, 3, th, tw]) });
      writeTile(dst, tile, result.output.data, tw, th, pad);
      result.output.dispose?.();
      progress();
      await new Promise((r) => setTimeout(r, 0));   // เปิดช่องให้รับคำสั่ง "หยุด" ระหว่างชิ้น
    }
  } catch (e) { freeCanvas(dst); throw e; }
  return dst;
}

// ---------- งานขยายภาพ 1 รูป ----------
async function process(job, useGpu) {
  const session = useGpu ? engine.gpu : engine.cpu;
  let bmp;
  try { bmp = await createImageBitmap(job.file); }
  catch (e) { throw new Error('เปิดไฟล์ภาพนี้ไม่ได้ (รองรับ JPG, PNG, WebP)'); }
  const source = makeCanvas(bmp.width, bmp.height);
  source.ctx.drawImage(bmp, 0, 0);
  bmp.close();
  const alpha = job.file.type !== 'image/jpeg' && hasTransparency(source);

  const steps = planSteps(source.canvas.width, source.canvas.height, job.outW, job.outH, SCALE);
  const total = countTiles(steps, CONFIG.tile.size, CONFIG.tile.pad);
  let done = 0, lastPost = 0;
  const t0 = performance.now();
  const progress = () => {
    done++;
    const now = performance.now();
    if (now - lastPost > 200 || done === total) {
      lastPost = now;
      post({ type: 'progress', id: job.id, done, total, elapsed: now - t0 });
    }
  };
  post({ type: 'progress', id: job.id, done: 0, total, elapsed: 0 });

  let cur = source;
  try {
    for (const step of steps) {
      const next = step.type === 'ai' ? await aiPass(session, cur, progress) : resize(cur, step.w, step.h);
      if (cur !== source) freeCanvas(cur);
      cur = next;
    }
    if (alpha) {  // คืนความโปร่งใสตามต้นฉบับ
      cur.ctx.imageSmoothingQuality = 'high';
      cur.ctx.globalCompositeOperation = 'destination-in';
      cur.ctx.drawImage(source.canvas, 0, 0, job.outW, job.outH);
      cur.ctx.globalCompositeOperation = 'source-over';
    }
    post({ type: 'status', text: 'กำลังบันทึกไฟล์ผลลัพธ์…' });
    const format = alpha ? 'png' : job.format;   // JPG เก็บความโปร่งใสไม่ได้
    const blob = await cur.canvas.convertToBlob(format === 'jpg'
      ? { type: 'image/jpeg', quality: CONFIG.output.jpegQuality }
      : { type: 'image/png' });
    let preview = null;
    const { previewMaxPixels, previewMaxSide } = CONFIG.output;
    if (job.outW * job.outH > previewMaxPixels) {
      const f = previewMaxSide / Math.max(job.outW, job.outH);
      const small = resize(cur, Math.round(job.outW * f), Math.round(job.outH * f));
      preview = await small.canvas.convertToBlob({ type: alpha ? 'image/png' : 'image/jpeg', quality: 0.9 });
      freeCanvas(small);
    }
    return { blob, preview, format, width: job.outW, height: job.outH, ms: performance.now() - t0 };
  } finally {
    if (cur !== source) freeCanvas(cur);
    freeCanvas(source);
  }
}

async function runJob(job) {
  cancelRequested = false;
  try {
    await ensureEngine();
    let useGpu = engine.auto === 'gpu' && !job.forceCpu;
    let result;
    try {
      result = await process(job, useGpu);
    } catch (e) {
      if (!useGpu || e instanceof Cancelled) throw e;
      // GPU ล้มเหลวกลางทาง → เปลี่ยนไปใช้ CPU แล้วเริ่มรูปนี้ใหม่
      engine.auto = 'cpu'; engine.gpu = null; useGpu = false;
      engine.info = { ...engine.info, auto: 'cpu', note: 'GPU ขัดข้องระหว่างทำงาน จึงเปลี่ยนไปใช้ CPU' };
      post({ type: 'engine', ...engine.info });
      result = await process(job, false);
    }
    post({ type: 'done', id: job.id, backend: useGpu ? 'gpu' : 'cpu', ...result });
  } catch (e) {
    if (e instanceof Cancelled) post({ type: 'cancelled', id: job.id });
    else post({ type: 'error', id: job.id, message: e?.message || String(e) });
  }
}

function post(msg) { self.postMessage(msg); }

let queue = Promise.resolve();
self.onmessage = (ev) => {
  const msg = ev.data;
  if (msg.type === 'cancel') cancelRequested = true;
  else if (msg.type === 'run') queue = queue.then(() => runJob(msg.job));
  else if (msg.type === 'warmup') queue = queue.then(() => ensureEngine().catch(e =>
    post({ type: 'engineError', message: e?.message || String(e) })));
};
