/* FotoLocalizador — uso offline.
   Estratégia "rede primeiro": com internet, sempre carrega a versão mais nova; sem internet (ou rede lenta), usa a cópia guardada.
   Ao publicar uma versão nova, troque o número em CACHE para limpar as cópias antigas. */
const CACHE = "fl-v11";
const FILES = ["./", "index.html", "styles.css", "app.js", "etiquetas.js", "etiquetas.css", "manifest.webmanifest", "icon-192.png", "icon-512.png"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES.map(f => new Request(f, { cache: "reload" })))).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(k => Promise.all(k.filter(x => x !== CACHE).map(x => caches.delete(x)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", e => {
  const r = e.request;
  if (r.method !== "GET" || new URL(r.url).origin !== location.origin) return;
  e.respondWith((async () => {
    const hit = await caches.match(r, { ignoreSearch: true });
    const net = fetch(r).then(res => { if (res.ok) { const cp = res.clone(); caches.open(CACHE).then(c => c.put(r, cp)); } return res; });
    try {
      if (!hit) return await net;
      return await Promise.race([net, new Promise((_, no) => setTimeout(no, 4000))]); /* rede lenta: usa a cópia guardada */
    } catch (err) {
      return hit || (r.mode === "navigate" ? await caches.match("index.html") : null) || Response.error();
    }
  })());
});
