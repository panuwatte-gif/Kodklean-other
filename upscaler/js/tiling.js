// กฎการคำนวณล้วน ๆ (ไม่แตะหน้าจอ ไม่แตะ AI) — ทดสอบแยกได้

/** คำนวณขนาดผลลัพธ์จากการตั้งค่า  คืน {w,h} หรือ {error} */
export function targetSize(srcW, srcH, setting, limits) {
  let w, h;
  if (setting.mode === 'longSide') {
    const side = Math.round(Number(setting.longSide));
    if (!Number.isFinite(side) || side <= 0) return { error: 'กรุณากรอกขนาดด้านยาวเป็นตัวเลข' };
    const f = side / Math.max(srcW, srcH);
    w = Math.max(1, Math.round(srcW * f));
    h = Math.max(1, Math.round(srcH * f));
  } else {
    w = srcW * setting.factor;
    h = srcH * setting.factor;
  }
  const factor = w / srcW;
  if (factor <= 1) return { error: 'ขนาดที่ตั้งไว้ไม่ใหญ่กว่าต้นฉบับ' };
  if (factor > limits.maxFactor + 1e-9) return { error: `ขยายได้สูงสุด ${limits.maxFactor} เท่าของต้นฉบับ` };
  if (Math.max(w, h) > limits.maxSide || w * h > limits.maxPixels) {
    // บอกผู้ใช้ว่ารูปนี้ขยายได้มากสุดเท่าไร แทนที่จะบอกแค่ว่าเกิน
    const long = Math.max(srcW, srcH), short = Math.min(srcW, srcH);
    const maxLong = Math.floor(Math.min(limits.maxSide, Math.sqrt(limits.maxPixels * long / short)));
    const maxF = Math.floor((maxLong / long) * 10) / 10;
    if (maxF <= 1) return { error: 'รูปนี้ใหญ่มากอยู่แล้ว เบราว์เซอร์ขยายเพิ่มไม่ได้' };
    return { error: `ใหญ่เกินที่เบราว์เซอร์รับได้ — รูปนี้ขยายได้สูงสุด ${maxF} เท่า (กรอก "กำหนดด้านยาวเอง" ได้ไม่เกิน ${maxLong.toLocaleString()} พิกเซล)` };
  }
  return { w, h, factor, warn: w * h > limits.warnPixels };
}

/**
 * วางแผนขั้นตอนจากขนาดต้นฉบับไปขนาดเป้าหมาย
 * คืนรายการขั้นตอน: {type:'ai', w, h, outW, outH} = ให้ AI ขยายภาพขนาด w×h แล้ววางผลเป็นขนาด outW×outH
 *                      (AI ขยายทีละชิ้น scale เท่า แล้วย่อชิ้นนั้นลงทันทีถ้าเป้าหมายเล็กกว่า
 *                       จึงไม่ต้องสร้างภาพขนาด scale เท่าเต็มใบ ซึ่งอาจใหญ่เกินหน่วยความจำ)
 *                    {type:'resize', w, h} = ย่อ/ปรับขนาดธรรมดาให้ได้ w×h
 */
export function planSteps(srcW, srcH, outW, outH, scale) {
  const factor = Math.max(outW / srcW, outH / srcH);
  const passes = Math.max(1, Math.ceil(Math.log(factor) / Math.log(scale) - 1e-9));
  const steps = [];
  let w = srcW, h = srcH;
  for (let i = 0; i < passes; i++) {
    const last = i === passes - 1;
    if (last && passes > 1) {
      const pw = Math.ceil(outW / scale), ph = Math.ceil(outH / scale);
      if (pw !== w || ph !== h) { steps.push({ type: 'resize', w: pw, h: ph }); w = pw; h = ph; }
    }
    steps.push({ type: 'ai', w, h, outW: last ? outW : w * scale, outH: last ? outH : h * scale });
    w *= scale; h *= scale;
  }
  return steps;
}

/** แบ่งภาพ w×h เป็นชิ้น  คืน {tw, th, tiles:[{x,y,cw,ch}]}  (tw,th = ขนาดชิ้นรวมขอบ) */
export function tileGrid(w, h, size, pad) {
  const cw = Math.min(size - 2 * pad, w), ch = Math.min(size - 2 * pad, h);
  const starts = (len, core) => {
    const out = [];
    for (let p = 0; p + core < len; p += core) out.push(p);
    out.push(len - core);
    return out;
  };
  const tiles = [];
  for (const y of starts(h, ch)) for (const x of starts(w, cw)) tiles.push({ x, y, cw, ch });
  return { tw: cw + 2 * pad, th: ch + 2 * pad, tiles };
}

export function countTiles(steps, size, pad) {
  return steps.filter(s => s.type === 'ai')
    .reduce((n, s) => n + tileGrid(s.w, s.h, size, pad).tiles.length, 0);
}
