// กฎการทำไฟล์ PDF สำหรับส่งร้านพิมพ์: หน้ากระดาษ 1 หน้า ขนาดเท่างานพิมพ์จริง มีรูปเต็มหน้า
// รูปถูกฝังเป็น JPG ทั้งก้อน (ไม่ผ่านการย่อหรือบีบซ้ำในขั้นนี้)

const CM_TO_PT = 72 / 2.54;   // หน่วยของ PDF คือ "พอยต์" (72 พอยต์ = 1 นิ้ว)

// คำนวณขนาดหน้ากระดาษจาก "ด้านยาวของงานพิมพ์" โดยคงสัดส่วนรูป (ด้านสั้นปัดเป็นทศนิยม 1 ตำแหน่ง)
export function pageSizeCm(pxW, pxH, longCm) {
  const shortCm = Math.round((longCm * Math.min(pxW, pxH) / Math.max(pxW, pxH)) * 10) / 10;
  const wCm = pxW >= pxH ? longCm : shortCm;
  const hCm = pxW >= pxH ? shortCm : longCm;
  return { wCm, hCm, dpi: Math.max(pxW, pxH) / (longCm / 2.54) };
}

// อ่านขนาดและชนิดสีจากหัวไฟล์ JPG — คืน null ถ้าอ่านไม่ได้
export function parseJpeg(bytes) {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let i = 2, exif = false;
  while (i + 9 < bytes.length) {
    if (bytes[i] !== 0xff) return null;
    const marker = bytes[i + 1];
    if (marker === 0xff) { i++; continue; }
    const len = (bytes[i + 2] << 8) | bytes[i + 3];
    if (marker === 0xe1 && bytes[i + 4] === 0x45 && bytes[i + 5] === 0x78) exif = true;   // "Ex(if)"
    const isSof = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
    if (isSof) {
      return { h: (bytes[i + 5] << 8) | bytes[i + 6], w: (bytes[i + 7] << 8) | bytes[i + 8], comps: bytes[i + 9], exif };
    }
    if (marker === 0xda) return null;
    i += 2 + len;
  }
  return null;
}

// ประกอบไฟล์ PDF จากไฟล์ JPG (สี RGB) — คืน Blob
export function buildPdf(jpegBlob, pxW, pxH, wCm, hCm) {
  const wPt = (wCm * CM_TO_PT).toFixed(2), hPt = (hCm * CM_TO_PT).toFixed(2);
  const enc = new TextEncoder();
  const parts = [];
  const offsets = [];
  let pos = 0;
  const add = (part) => { parts.push(part); pos += typeof part === 'string' ? enc.encode(part).length : part.size; };
  const obj = (n, body) => { offsets[n] = pos; add(`${n} 0 obj\n${body}\nendobj\n`); };

  add('%PDF-1.4\n%âãÏÓ\n');
  obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  obj(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  obj(3, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${wPt} ${hPt}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>`);
  offsets[4] = pos;
  add(`4 0 obj\n<< /Type /XObject /Subtype /Image /Width ${pxW} /Height ${pxH} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpegBlob.size} >>\nstream\n`);
  add(jpegBlob);
  add('\nendstream\nendobj\n');
  const content = `q ${wPt} 0 0 ${hPt} 0 0 cm /Im0 Do Q`;
  obj(5, `<< /Length ${content.length} >>\nstream\n${content}\nendstream`);

  const xref = pos;
  let table = 'xref\n0 6\n0000000000 65535 f \n';
  for (let n = 1; n <= 5; n++) table += String(offsets[n]).padStart(10, '0') + ' 00000 n \n';
  add(table + `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return new Blob(parts, { type: 'application/pdf' });
}
