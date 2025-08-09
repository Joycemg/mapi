let map = window.__APP_MAP__;

if (!map) {
    const el = L.DomUtil.get('map');
    if (el && el._leaflet_id) el._leaflet_id = undefined; // hot reload limpio

    // ====== Configuración de límites ======
    const WORLD_BOUNDS = L.latLngBounds(L.latLng(-85, -180), L.latLng(85, 180));
    const DEFAULT_CENTER = [20, 0]; // vista mundial
    const DEFAULT_ZOOM = 3;         // zoom "vista mundial"

    map = L.map('map', {
        center: DEFAULT_CENTER,
        zoom: DEFAULT_ZOOM,
        minZoom: DEFAULT_ZOOM,
        maxZoom: 17,            // zoom máximo nivel ciudad (17)
        zoomSnap: 1,
        zoomDelta: 1,
        zoomControl: true,
        attributionControl: false,

        preferCanvas: true,
        inertia: false,
        wheelDebounceTime: 40,
        wheelPxPerZoomLevel: 90,

        updateWhenZooming: true,  // clave para que las tiles se actualicen al hacer zoom
        zoomAnimation: false,     // evita bugs de animación

        worldCopyJump: false,
        maxBounds: WORLD_BOUNDS,
        maxBoundsViscosity: 0.85,

        tap: true,
        tapTolerance: 22,
        touchZoom: true
    });

    // Forzar recarga de tiles y limitar zoom máximo a 17
    map.on('zoomend', () => {
        if (map.getZoom() > 17) {
            map.setZoom(17);
        }
        map.eachLayer(layer => {
            if (layer instanceof L.TileLayer) {
                layer.redraw();
            }
        });
    });

    const baseOptions = {
        noWrap: true,
        continuousWorld: false,
        detectRetina: true,
        crossOrigin: 'anonymous',
        updateWhenIdle: true,
        updateWhenZooming: false,
        keepBuffer: 1,
        className: 'filtered-tile'
    };

    const osm = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        ...baseOptions,
        maxZoom: 17,
        maxNativeZoom: 17,
        attribution: '&copy; OpenStreetMap contributors'
    });

    const carto = L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
        ...baseOptions,
        subdomains: 'abcd',
        maxZoom: 17,
        maxNativeZoom: 17,
        attribution: '&copy; OpenStreetMap contributors &copy; CARTO'
    });

    let currentBase = null;
    let retryTimer = null;
    const RETRY_MS = 30000;
    const PROBE_TIMEOUT_MS = 10000;

    function useBase(layer) {
        if (currentBase === layer) return;
        if (currentBase) map.removeLayer(currentBase);
        layer.addTo(map);
        currentBase = layer;
    }

    function startRetryOSM() {
        if (!retryTimer) retryTimer = setInterval(tryRestoreOSM, RETRY_MS);
    }

    function stopRetryOSM() {
        if (retryTimer) {
            clearInterval(retryTimer);
            retryTimer = null;
        }
    }

    function tryRestoreOSM() {
        let loaded = false;
        const onLoad = () => {
            loaded = true;
            osm.off('load', onLoad);
            useBase(osm);
            if (map.hasLayer(carto)) map.removeLayer(carto);
            stopRetryOSM();
        };
        osm.once('load', onLoad);

        if (!map.hasLayer(osm)) osm.addTo(map);

        setTimeout(() => {
            if (!loaded) {
                osm.off('load', onLoad);
                if (currentBase !== carto && map.hasLayer(carto)) useBase(carto);
            }
        }, PROBE_TIMEOUT_MS);
    }

    osm.on('tileerror', () => {
        if (currentBase !== carto) {
            useBase(carto);
        }
        startRetryOSM();
    });

    osm.on('load', () => stopRetryOSM());

    useBase(osm);

    L.control.scale({ imperial: false }).addTo(map);

    const ResetView = L.Control.extend({
        options: { position: 'topleft' },
        onAdd() {
            const box = L.DomUtil.create('div', 'leaflet-bar');
            const a = L.DomUtil.create('a', '', box);
            a.href = '#';
            a.title = 'Vista mundial';
            a.setAttribute('aria-label', 'Vista mundial');
            a.textContent = '🌐';
            a.onclick = (e) => {
                e.preventDefault();
                map.setView(DEFAULT_CENTER, DEFAULT_ZOOM);
            };
            L.DomEvent.disableClickPropagation(box);
            L.DomEvent.disableScrollPropagation(box);
            return box;
        }
    });
    map.addControl(new ResetView());

    map.on('resize', () => map.panInsideBounds(WORLD_BOUNDS, { animate: false }));

    (function mobileTuning() {
        const css = document.createElement('style');
        css.textContent = `
            #map { -webkit-touch-callout: none; touch-action: pan-x pan-y; }
            .leaflet-bar, .leaflet-control { user-select: none; -webkit-user-select: none; }
        `;
        document.head.appendChild(css);
        map.getContainer().addEventListener('contextmenu', (e) => e.preventDefault());
    })();

    const PREFETCH_PAD_PX = 256;

    function prefetchTiles(padPx = PREFETCH_PAD_PX) {
        try {
            const b = map.getPixelBounds();
            const padded = L.bounds(
                b.min.subtract([padPx, padPx]),
                b.max.add([padPx, padPx])
            );

            map.eachLayer((layer) => {
                if (!(layer instanceof L.TileLayer)) return;
                if (!map.hasLayer(layer)) return;
                if (typeof layer._update !== 'function' || typeof layer._getTiledPixelBounds !== 'function') return;

                const orig = layer._getTiledPixelBounds;
                layer._getTiledPixelBounds = () => padded;
                try {
                    layer._update();
                } finally {
                    layer._getTiledPixelBounds = orig;
                }
            });
        } catch {
            // ignorar errores
        }
    }

    map.on('moveend zoomend', () => prefetchTiles());

    window.__APP_MAP__ = map;
}

export { map };
                    
