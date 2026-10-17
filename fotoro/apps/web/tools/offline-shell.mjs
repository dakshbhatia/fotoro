import {createHash} from "node:crypto";

// Only build-time public application files enter this cache. No API responses,
// original photos, previews, credentials or URL parameters are persisted here.
export function offlineWorker(html, assets) {
  const files = [...new Set(assets)].filter(path => /^\/assets\/[a-zA-Z0-9_.-]+\.(?:js|css)$/.test(path)).sort();
  const version = createHash("sha256").update(html + JSON.stringify(files)).digest("hex").slice(0, 20);
  return `const CACHE = ${JSON.stringify("fotoro-shell-" + version)};
const FILES = ${JSON.stringify(files)};
const HTML = ${JSON.stringify(html)};
const shellRequest = new Request(new URL('/__fotoro_offline_shell__', self.location.origin));
self.addEventListener('install', event => event.waitUntil((async () => {
  const cache = await caches.open(CACHE);
  try {
    await cache.addAll(FILES.map(path => new Request(path, {credentials: 'omit', cache: 'reload'})));
    await cache.put(shellRequest, new Response(HTML, {headers: {'Content-Type': 'text/html; charset=utf-8', 'X-Content-Type-Options': 'nosniff'}}));
  } catch (error) {await caches.delete(CACHE); throw error;}
})()));
// Let existing tabs keep their matching shell until they close. Do not force a
// worker/version switch while an encrypted save or background task is running.
self.addEventListener('activate', event => event.waitUntil((async () => {
  for (const key of await caches.keys()) if (key.startsWith('fotoro-shell-') && key !== CACHE) await caches.delete(key);
  await self.clients.claim();
})()));
self.addEventListener('fetch', event => {
  const request = event.request, url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin || url.search) return;
  if (request.mode === 'navigate' && ['/', '/saved', '/saved/'].includes(url.pathname)) {
    event.respondWith(fetch(request).catch(async () => {
      const cached = await (await caches.open(CACHE)).match(shellRequest);
      return cached || Response.error();
    }));
  } else if (FILES.includes(url.pathname)) {
    event.respondWith((async () => (await (await caches.open(CACHE)).match(url.pathname)) || fetch(request))());
  }
});
`;
}
