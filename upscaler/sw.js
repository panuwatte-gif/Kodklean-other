// ตัวช่วยเปิด "โหมดหลายแกน CPU" บนโฮสต์ที่ตั้งค่า header เองไม่ได้ (เช่น GitHub Pages)
// ทำหน้าที่เดียว: เติม header ความปลอดภัย 2 ตัวให้ทุกไฟล์ของเว็บนี้ — ไม่เก็บ cache ไม่แก้เนื้อหา
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.cache === 'only-if-cached' && req.mode !== 'same-origin') return;
  e.respondWith(fetch(req).then((res) => {
    if (res.status === 0) return res;
    const headers = new Headers(res.headers);
    headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
    headers.set('Cross-Origin-Opener-Policy', 'same-origin');
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  }));
});
