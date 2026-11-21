// ส่วนหน้าจอ: เก็บสถานะไว้ที่ state ที่เดียว แล้ววาดหน้าจอจาก state
import { CONFIG } from './config.js';
import { targetSize } from './tiling.js';
import { ensureIsolation } from './isolation.js';

ensureIsolation();

const $ = (id) => document.getElementById(id);
const el = {
  dropzone: $('dropzone'), fileInput: $('fileInput'), scaleChoices: $('scaleChoices'),
  modeLongSide: $('modeLongSide'), longSide: $('longSide'), modeFactor: $('modeFactor'),
  modePrint: $('modePrint'), printCm: $('printCm'), printDpi: $('printDpi'), scaleHint: $('scaleHint'), forceCpu: $('forceCpu'),
  startBtn: $('startBtn'), cancelBtn: $('cancelBtn'), clearBtn: $('clearBtn'),
  status: $('status'), items: $('items'), empty: $('empty'), engineInfo: $('engineInfo'),
  previewCard: $('previewCard'), previewNote: $('previewNote'), afterImg: $('afterImg'),
  beforeImg: $('beforeImg'), divider: $('divider'), slider: $('slider'),
  pdfLongCm: $('pdfLongCm'), pdfPickBtn: $('pdfPickBtn'), pdfFileInput: $('pdfFileInput'),
  pdfHint: $('pdfHint'), pdfItems: $('pdfItems'),
};

const state = {
  items: [],            // {id,file,name,w,h,srcUrl,status,done,total,elapsed,result,error}
  setting: { mode: 'factor', factor: CONFIG.defaultScale, longSide: '', printCm: '', printDpi: String(CONFIG.defaultDpi) },
  format: 'png',
  forceCpu: false,
  running: false,
  stopping: false,
  selectedId: null,
  engine: null,
  pdfLongCm: '',
  pdfs: [],             // {id,name,status,url,bytes,info,error}
};
let nextId = 1;
let worker = null;
let settle = null;      // ฟังก์ชันปลดล็อกเมื่อรูปที่กำลังทำเสร็จ/ผิดพลาด/ถูกหยุด
let wakeLock = null;

// ---------- ส่วนประมวลผลเบื้องหลัง ----------
function getWorker() {
  if (worker) return worker;
  worker = new Worker(new URL('./upscale-worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = (ev) => onWorkerMessage(ev.data);
  worker.onerror = (ev) => {
    setStatus('ส่วนประมวลผลขัดข้อง: ' + (ev.message || 'ไม่ทราบสาเหตุ') + ' — ลองโหลดหน้าใหม่');
    worker = null;
    settle?.({ type: 'error', message: 'ส่วนประมวลผลขัดข้อง' });
  };
  return worker;
}

function onWorkerMessage(msg) {
  if (msg.type === 'status') return setStatus(msg.text);
  if (msg.type === 'engine') { state.engine = msg; return renderEngine(); }
  if (msg.type === 'engineError') return setStatus('เตรียมโมเดลไม่สำเร็จ: ' + msg.message);
  if (msg.type === 'pdfDone' || msg.type === 'pdfError') return onPdfMessage(msg);
  const item = state.items.find((i) => i.id === msg.id);
  if (msg.type === 'progress') {
    if (!item) return;
    Object.assign(item, { done: msg.done, total: msg.total, elapsed: msg.elapsed });
    updateProgress(item);
    setStatus('');
    return;
  }
  if (['done', 'error', 'cancelled'].includes(msg.type)) settle?.(msg);
}

// ---------- การเพิ่ม/ลบรูป ----------
async function addFiles(fileList) {
  const files = [...fileList].filter((f) => f.type.startsWith('image/'));
  if (!files.length) return setStatus('ไฟล์ที่เลือกไม่ใช่รูปภาพ');
  for (const file of files) {
    const item = { id: nextId++, file, name: file.name, w: 0, h: 0, srcUrl: URL.createObjectURL(file),
      status: 'pending', done: 0, total: 0, elapsed: 0, result: null, error: '' };
    try {
      const bmp = await createImageBitmap(file);
      item.w = bmp.width; item.h = bmp.height; bmp.close();
    } catch (e) {
      item.status = 'error'; item.error = 'เปิดไฟล์ภาพนี้ไม่ได้';
    }
    state.items.push(item);
  }
  getWorker().postMessage({ type: 'warmup' });
  fixFactor();
  render();
}

function releaseResult(item) {
  if (!item.result) return;
  URL.revokeObjectURL(item.result.url);
  if (item.result.previewUrl) URL.revokeObjectURL(item.result.previewUrl);
  item.result = null;
}

function removeItem(id) {
  const i = state.items.findIndex((it) => it.id === id);
  if (i < 0 || state.items[i].status === 'working') return;
  releaseResult(state.items[i]);
  URL.revokeObjectURL(state.items[i].srcUrl);
  state.items.splice(i, 1);
  if (state.selectedId === id) state.selectedId = null;
  fixFactor();
  render();
}

function retryItem(id) {
  const item = state.items.find((it) => it.id === id);
  if (!item || item.status === 'working' || !item.w) return;
  releaseResult(item);
  Object.assign(item, { status: 'pending', error: '', done: 0, total: 0 });
  if (state.selectedId === id) state.selectedId = null;
  render();
}

// ---------- การทำงานหลัก ----------
const planFor = (item) => targetSize(item.w, item.h, state.setting, CONFIG.limits);

// ปุ่มจำนวนเท่าไหนใช้กับรูปที่รออยู่ได้บ้าง (ยังไม่มีรูป = ใช้ได้ทุกปุ่ม)
function factorUsable(f) {
  const waiting = state.items.filter((i) => i.status === 'pending' && i.w);
  return !waiting.length || waiting.some((i) => !targetSize(i.w, i.h, { mode: 'factor', factor: f }, CONFIG.limits).error);
}
// ถ้าจำนวนเท่าที่เลือกอยู่ใช้กับรูปที่ใส่มาไม่ได้ ให้เลื่อนไปค่าที่มากที่สุดที่ใช้ได้
function fixFactor() {
  if (state.setting.mode !== 'factor' || factorUsable(state.setting.factor)) return;
  const ok = CONFIG.scaleChoices.filter(factorUsable);
  if (ok.length) state.setting = { ...state.setting, factor: Math.max(...ok) };
}

function outputName(item, format) {
  const stem = item.name.replace(/\.[^.]+$/, '');
  const tag = state.setting.mode === 'longSide' ? `${Math.max(item.result.width, item.result.height)}px`
    : state.setting.mode === 'print' ? `${Number(state.setting.printDpi)}dpi` : `x${state.setting.factor}`;
  return `${stem}_${tag}.${format}`;
}

async function start() {
  if (state.running) return;            // กันกดซ้ำ
  state.running = true; state.stopping = false;
  render();
  // กันจอดับระหว่างทำงาน (ไม่รอผล — ถ้าเบราว์เซอร์ไม่รองรับก็ทำงานต่อได้)
  navigator.wakeLock?.request('screen').then((lock) => {
    if (state.running) wakeLock = lock; else lock.release();
  }).catch(() => {});
  for (const item of state.items) {
    if (state.stopping) break;
    if (item.status !== 'pending') continue;
    const plan = planFor(item);
    if (plan.error) { item.status = 'error'; item.error = plan.error; render(); continue; }
    item.status = 'working'; item.done = 0; item.total = 0;
    render();
    const msg = await new Promise((resolve) => {
      settle = resolve;
      getWorker().postMessage({ type: 'run', job: { id: item.id, file: item.file, outW: plan.w, outH: plan.h,
        format: state.format, forceCpu: state.forceCpu } });
    });
    settle = null;
    if (msg.type === 'done') {
      item.status = 'done';
      item.result = { url: URL.createObjectURL(msg.blob), width: msg.width, height: msg.height, ms: msg.ms,
        blob: msg.blob, bytes: msg.blob.size, format: msg.format, backend: msg.backend,
        previewUrl: msg.preview ? URL.createObjectURL(msg.preview) : null };
      item.result.name = outputName(item, msg.format);
      state.selectedId = item.id;
    } else if (msg.type === 'cancelled') {
      item.status = 'pending';
    } else {
      item.status = 'error'; item.error = msg.message;
    }
    render();
  }
  state.running = false; state.stopping = false;
  wakeLock?.release().catch(() => {});
  wakeLock = null;
  setStatus('');
  render();
}

function cancel() {
  if (!state.running) return;
  state.stopping = true;
  worker?.postMessage({ type: 'cancel' });
  setStatus('กำลังหยุด…');
  render();
}

function clearAll() {
  if (state.running) return;
  for (const item of state.items) { releaseResult(item); URL.revokeObjectURL(item.srcUrl); }
  state.items = []; state.selectedId = null;
  render();
}

// ---------- ทำไฟล์ PDF ส่งร้านพิมพ์ ----------
const pdfLongCm = () => { const v = Number(state.pdfLongCm); return Number.isFinite(v) && v >= 1 && v <= 500 ? v : 0; };

function requestPdf(file, name) {
  const longCm = pdfLongCm();
  if (!longCm) { el.pdfLongCm.focus(); el.pdfLongCm.scrollIntoView({ behavior: 'smooth', block: 'center' }); return render(); }
  const stem = name.replace(/\.[^.]+$/, '');
  const job = { id: nextId++, name: `${stem}_${longCm}cm.pdf`, status: 'working', url: null, bytes: 0, info: '', error: '' };
  state.pdfs.push(job);
  getWorker().postMessage({ type: 'pdf', job: { id: job.id, file, longCm } });
  render();
}

function onPdfMessage(msg) {
  const job = state.pdfs.find((p) => p.id === msg.id);
  if (!job) return;
  if (msg.type === 'pdfError') { job.status = 'error'; job.error = msg.message; return render(); }
  job.status = 'done';
  job.url = URL.createObjectURL(msg.blob);
  job.bytes = msg.blob.size;
  job.info = `หน้า ${msg.wCm} × ${msg.hCm} ซม. · รูป ${fmtDim(msg.width, msg.height)} พิกเซล = ${Math.round(msg.dpi)} DPI`
    + (msg.reencoded ? ' · แปลงรูปเป็น JPG คุณภาพ 95%' : ' · ฝังรูป JPG ตามเดิม');
  render();
}

function removePdf(id) {
  const i = state.pdfs.findIndex((p) => p.id === id);
  if (i < 0 || state.pdfs[i].status === 'working') return;
  if (state.pdfs[i].url) URL.revokeObjectURL(state.pdfs[i].url);
  state.pdfs.splice(i, 1);
  render();
}

function renderPdf() {
  const busy = state.pdfs.some((p) => p.status === 'working');
  el.pdfLongCm.disabled = busy;
  el.pdfPickBtn.disabled = state.running || busy;
  el.pdfHint.textContent = state.pdfLongCm && !pdfLongCm() ? 'กรอกด้านยาวเป็นเซนติเมตร (1–500)'
    : !pdfLongCm() ? 'กรอกด้านยาวของงานพิมพ์ก่อน เช่น ธง 50 × 150 ซม. ให้กรอก 150' : '';
  el.pdfItems.replaceChildren(...state.pdfs.map((p) => {
    const line = h('div', { className: 'meta state' });
    const side = h('div', { className: 'side' });
    if (p.status === 'working') line.textContent = 'กำลังทำ PDF…';
    else if (p.status === 'error') { line.classList.add('bad'); line.textContent = p.error; }
    else {
      line.classList.add('ok'); line.textContent = `${p.info} · ${fmtBytes(p.bytes)}`;
      side.append(h('a', { className: 'btn', href: p.url, download: p.name, textContent: 'ดาวน์โหลด PDF' }));
    }
    if (p.status !== 'working') side.append(h('button', { className: 'small', textContent: 'ลบ', onclick: () => removePdf(p.id) }));
    return h('li', { className: 'item pdf' }, h('div', {}, h('div', { className: 'name', textContent: p.name }), line), side);
  }));
}

// ---------- การวาดหน้าจอ ----------
const fmtDim = (w, h) => `${w.toLocaleString()} × ${h.toLocaleString()}`;
const fmtTime = (ms) => { const s = Math.round(ms / 1000); return s < 60 ? `${s} วินาที` : `${Math.floor(s / 60)} นาที ${s % 60} วินาที`; };
const fmtBytes = (b) => b > 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.round(b / 1024)} KB`;
function setStatus(text) { el.status.textContent = text; }

function h(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children.filter((c) => c != null));
  return node;
}

function progressText(item) {
  if (!item.total) return 'กำลังเตรียม…';
  const pct = Math.floor((item.done / item.total) * 100);
  const eta = item.done ? ` — เหลือประมาณ ${fmtTime((item.elapsed / item.done) * (item.total - item.done))}` : '';
  return `${pct}%${eta}`;
}

function updateProgress(item) {
  const bar = document.querySelector(`[data-progress="${item.id}"]`);
  const text = document.querySelector(`[data-state="${item.id}"]`);
  if (bar) { bar.max = item.total || 1; bar.value = item.done; }
  if (text) text.textContent = progressText(item);
}

function renderItem(item) {
  const meta = h('div', { className: 'meta' });
  const stateLine = h('div', { className: 'meta state' });
  stateLine.dataset.state = item.id;
  const side = h('div', { className: 'side' });
  let bar = null;

  if (item.status === 'done') {
    const r = item.result;
    meta.textContent = `${fmtDim(item.w, item.h)} → ${fmtDim(r.width, r.height)} พิกเซล`;
    stateLine.classList.add('ok');
    stateLine.textContent = `เสร็จแล้ว ใช้เวลา ${fmtTime(r.ms)} · ${r.format.toUpperCase()} ${fmtBytes(r.bytes)}`;
    side.append(h('a', { className: 'btn', href: r.url, download: r.name, textContent: 'ดาวน์โหลด' }),
      h('button', { className: 'small', textContent: 'ทำ PDF', disabled: state.running, onclick: () => requestPdf(r.blob, r.name) }),
      h('button', { className: 'small', textContent: 'ดูเทียบ', onclick: () => { state.selectedId = item.id; render(); el.previewCard.scrollIntoView({ behavior: 'smooth' }); } }));
  } else if (item.status === 'working') {
    const plan = planFor(item);
    meta.textContent = `${fmtDim(item.w, item.h)} → ${fmtDim(plan.w, plan.h)} พิกเซล`;
    stateLine.textContent = progressText(item);
    bar = h('progress', { max: item.total || 1, value: item.done });
    bar.dataset.progress = item.id;
  } else if (item.status === 'error') {
    meta.textContent = item.w ? `${fmtDim(item.w, item.h)} พิกเซล` : '';
    stateLine.classList.add('bad');
    stateLine.textContent = item.error;
  } else {
    const plan = planFor(item);
    if (plan.error) { meta.textContent = `${fmtDim(item.w, item.h)} พิกเซล`; stateLine.classList.add('bad'); stateLine.textContent = plan.error; }
    else {
      meta.textContent = `${fmtDim(item.w, item.h)} → ${fmtDim(plan.w, plan.h)} พิกเซล`;
      if (plan.warn) { stateLine.classList.add('warn'); stateLine.textContent = 'ภาพใหญ่มาก จะใช้เวลานานและใช้หน่วยความจำมาก'; }
      else stateLine.textContent = 'รอขยาย';
    }
  }
  if (!state.running && item.status !== 'pending' && item.w) side.append(h('button', { className: 'small', textContent: 'ทำใหม่', onclick: () => retryItem(item.id) }));
  if (item.status !== 'working') side.append(h('button', { className: 'small', textContent: 'ลบ', onclick: () => removeItem(item.id) }));

  return h('li', { className: 'item' + (item.id === state.selectedId ? ' selected' : '') },
    h('img', { className: 'thumb', src: item.srcUrl, alt: '' }),
    h('div', {}, h('div', { className: 'name', textContent: item.name }), meta, stateLine, bar),
    side);
}

function renderPreview() {
  const item = state.items.find((i) => i.id === state.selectedId && i.result);
  el.previewCard.hidden = !item;
  if (!item) { el.afterImg.removeAttribute('src'); el.beforeImg.removeAttribute('src'); return; }
  const r = item.result;
  const src = r.previewUrl || r.url;
  if (el.afterImg.dataset.src !== src) { el.afterImg.src = src; el.afterImg.dataset.src = src; el.beforeImg.src = item.srcUrl; }
  el.previewNote.textContent = `${item.name} — เลื่อนเส้นแบ่งเพื่อเทียบ` + (r.previewUrl ? ' (ภาพนี้เป็นตัวอย่างแบบย่อ ไฟล์ที่ดาวน์โหลดละเอียดกว่า)' : '');
}

function renderEngine() {
  const e = state.engine;
  if (!e) { el.engineInfo.textContent = ''; return; }
  const using = e.auto === 'gpu' && !state.forceCpu ? 'GPU ในเครื่อง' : `CPU ${e.threads} แกน`;
  el.engineInfo.textContent = `ประมวลผลด้วย: ${using} — ${e.note}` + (e.isolated ? '' : ' (ยังเปิดโหมดหลายแกนไม่ได้ ลองโหลดหน้าใหม่)');
}

function renderSettings() {
  const blocked = CONFIG.scaleChoices.filter((f) => !factorUsable(f));
  for (const b of el.scaleChoices.children) {
    const f = Number(b.dataset.factor);
    b.setAttribute('aria-checked', String(state.setting.mode === 'factor' && f === state.setting.factor));
    b.disabled = state.running || blocked.includes(f);
    b.title = blocked.includes(f) ? 'รูปที่เลือกใหญ่เกินกว่าจะขยายเท่านี้ได้' : '';
  }
  el.scaleHint.textContent = !blocked.length ? ''
    : `ปุ่ม ${blocked.join(', ')} เท่าถูกปิด เพราะรูปที่เลือกใหญ่อยู่แล้ว ขยายเท่านั้นจะเกินขนาดที่เบราว์เซอร์รับได้ (จำนวนเท่ามาก ๆ มีไว้สำหรับรูปเล็ก) — งานส่งร้านพิมพ์ให้ใช้ "ตามขนาดงานพิมพ์"`;
  el.modeLongSide.checked = state.setting.mode === 'longSide';
  el.modeFactor.checked = state.setting.mode === 'factor';
  el.modePrint.checked = state.setting.mode === 'print';
  for (const c of [el.modeLongSide, el.longSide, el.modeFactor, el.modePrint, el.printCm, el.printDpi, el.forceCpu, ...document.querySelectorAll('input[name=format]')]) c.disabled = state.running;
}

function render() {
  renderSettings();
  el.items.replaceChildren(...state.items.map(renderItem));
  el.empty.hidden = state.items.length > 0;
  const pending = state.items.filter((i) => i.status === 'pending' && !planFor(i).error).length;
  el.startBtn.disabled = state.running || pending === 0;
  el.startBtn.textContent = state.running ? 'กำลังขยายภาพ…' : pending > 1 ? `เริ่มขยายภาพ (${pending} รูป)` : 'เริ่มขยายภาพ';
  el.cancelBtn.hidden = !state.running;
  el.cancelBtn.disabled = state.stopping;
  el.clearBtn.hidden = state.running || state.items.length === 0;
  renderPreview();
  renderEngine();
  renderPdf();
}

// ---------- การผูกปุ่มและช่องกรอก ----------
for (const f of CONFIG.scaleChoices) {
  const b = h('button', { type: 'button', textContent: `${f} เท่า` });
  b.dataset.factor = f; b.setAttribute('role', 'radio');
  b.onclick = () => { state.setting = { ...state.setting, mode: 'factor', factor: f }; render(); };
  el.scaleChoices.append(b);
}
el.modeLongSide.onchange = () => { state.setting = { ...state.setting, mode: 'longSide' }; render(); el.longSide.focus(); };
el.longSide.oninput = () => { state.setting = { ...state.setting, mode: 'longSide', longSide: el.longSide.value }; render(); };
el.modeFactor.onchange = () => { state.setting = { ...state.setting, mode: 'factor' }; fixFactor(); render(); };
el.modePrint.onchange = () => { state.setting = { ...state.setting, mode: 'print' }; render(); el.printCm.focus(); };
el.printDpi.value = state.setting.printDpi;
el.printCm.oninput = () => {
  state.setting = { ...state.setting, mode: 'print', printCm: el.printCm.value };
  state.pdfLongCm = el.printCm.value; el.pdfLongCm.value = el.printCm.value;   // ใช้ขนาดเดียวกันตอนทำ PDF
  render();
};
el.printDpi.oninput = () => { state.setting = { ...state.setting, mode: 'print', printDpi: el.printDpi.value }; render(); };
el.forceCpu.onchange = () => { state.forceCpu = el.forceCpu.checked; renderEngine(); };
for (const r of document.querySelectorAll('input[name=format]')) r.onchange = () => { if (r.checked) state.format = r.value; };
el.fileInput.onchange = () => { addFiles(el.fileInput.files); el.fileInput.value = ''; };
el.pdfLongCm.oninput = () => { state.pdfLongCm = el.pdfLongCm.value; renderPdf(); };
el.pdfPickBtn.onclick = () => { if (pdfLongCm()) el.pdfFileInput.click(); else { el.pdfLongCm.focus(); renderPdf(); } };
el.pdfFileInput.onchange = () => { const f = el.pdfFileInput.files[0]; el.pdfFileInput.value = ''; if (f) requestPdf(f, f.name); };
el.startBtn.onclick = start;
el.cancelBtn.onclick = cancel;
el.clearBtn.onclick = clearAll;

for (const type of ['dragenter', 'dragover']) el.dropzone.addEventListener(type, (e) => { e.preventDefault(); el.dropzone.classList.add('over'); });
for (const type of ['dragleave', 'drop']) el.dropzone.addEventListener(type, (e) => { e.preventDefault(); el.dropzone.classList.remove('over'); });
el.dropzone.addEventListener('drop', (e) => addFiles(e.dataTransfer.files));
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());

el.slider.oninput = () => {
  const v = Number(el.slider.value);
  el.beforeImg.style.clipPath = `inset(0 ${100 - v}% 0 0)`;
  el.divider.style.left = `${v}%`;
};
window.addEventListener('beforeunload', (e) => { if (state.running || state.pdfs.some((p) => p.status === 'working')) { e.preventDefault(); e.returnValue = ''; } });

render();
