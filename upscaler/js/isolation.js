// เปิดโหมดหลายแกน CPU: ถ้าโฮสต์ไม่ได้ส่ง header มาให้ จะติดตั้งตัวช่วย (sw.js) แล้วโหลดหน้าใหม่ 1 ครั้ง
const FLAG = 'upscaler-isolation-reloaded';
export async function ensureIsolation() {
  if (self.crossOriginIsolated || !('serviceWorker' in navigator) || !window.isSecureContext) return;
  try {
    await navigator.serviceWorker.register('sw.js');
    await navigator.serviceWorker.ready;
    if (!sessionStorage.getItem(FLAG)) {   // กันโหลดซ้ำวนไม่จบ
      sessionStorage.setItem(FLAG, '1');
      location.reload();
    }
  } catch (e) { /* ใช้งานต่อได้ในโหมดแกนเดียว */ }
}
