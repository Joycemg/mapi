// /sw.js  — tiles CARTO con stale-while-revalidate y limpieza de cachés
const CACHE = 'tiles-v2';
const TILE_RE = /\.cartocdn\.com\/.*\/\d+\/\d+\/\d+(\.png|\.jpg|\.webp)?$/i;
const MAX_ENTRIES = 500;

self.addEventListener('install', (e) => {
    // tomar control rápido
    self.skipWaiting();
});

self.addEventListener('activate', (e) => {
    e.waitUntil((async () => {
        // borrar caches viejos
        const keys = await caches.keys();
        await Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)));
        await self.clients.claim();
    })());
});

self.addEventListener('fetch', (e) => {
    const url = new URL(e.request.url);
    if (!TILE_RE.test(url.href)) return;

    e.respondWith((async () => {
        const cache = await caches.open(CACHE);
        const cached = await cache.match(e.request);

        const fetchAndUpdate = fetch(e.request, { mode: 'cors', credentials: 'omit' })
            .then(async (res) => {
                try {
                    // LRU simple: limita tamaño
                    const keys = await cache.keys();
                    if (keys.length >= MAX_ENTRIES) await cache.delete(keys[0]);
                    await cache.put(e.request, res.clone());
                } catch { }
                return res;
            })
            .catch(() => null);

        // SWR: devuelve caché si existe; en paralelo actualiza. Si no hay caché, espera red.
        return cached || (await fetchAndUpdate) || Response.error();
    })());
});
