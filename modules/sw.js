// /sw.js
const CACHE = 'tiles-v1';
const MAX_TILES = 200;

self.addEventListener('fetch', (e) => {
    const url = new URL(e.request.url);
    // cachea tiles de CARTO (z/x/y)
    if (!/\.cartocdn\.com\/.*\/\d+\/\d+\/\d+/.test(url.href)) return;

    e.respondWith((async () => {
        const cache = await caches.open(CACHE);
        const hit = await cache.match(e.request);
        if (hit) return hit;

        const res = await fetch(e.request, { mode: 'cors', credentials: 'omit' });
        // LRU simplona: si supera límite, borra el primer entry
        const keys = await cache.keys();
        if (keys.length >= MAX_TILES) await cache.delete(keys[0]);
        cache.put(e.request, res.clone());
        return res;
    })());
});
