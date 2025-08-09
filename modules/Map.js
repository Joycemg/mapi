// modules/Map.js
let map = window.__APP_MAP__;

if (!map) {
    // hot reload limpio
    const el = L.DomUtil.get('map');
    if (el && el._leaflet_id) el._leaflet_id = undefined;

    // ===== Config base =====
    const WORLD_BOUNDS = L.latLngBounds(L.latLng(-85, -180), L.latLng(85, 180));
    const DEFAULT_CENTER = [20, 0];
    const DEFAULT_ZOOM = 3;
    const MAX_ZOOM = 18; // tope requerido

    const IS_MOBILE = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

    map = L.map('map', {
        center: DEFAULT_CENTER,
        zoom: DEFAULT_ZOOM,
        minZoom: DEFAULT_ZOOM,
        maxZoom: MAX_ZOOM,
        zoomControl: true,
        attributionControl: false,

        // UX / perf
        preferCanvas: true,
        inertia: false,
        wheelDebounceTime: 40,
        wheelPxPerZoomLevel: 120,
        zoomAnimation: !IS_MOBILE,
        fadeAnimation: !IS_MOBILE,

        // Límites
        worldCopyJump: false,
        maxBounds: WORLD_BOUNDS,
        maxBoundsViscosity: 0.85,

        // Móvil
        tap: true,
        tapTolerance: 22,
        touchZoom: 'center'
    });

    // ===== Capas base (OSM + Carto) =====
    // Capamos ambas a z=17; detectRetina OFF en móvil para evitar @2x problemáticos
    const baseOptions = {
        noWrap: true,
        continuousWorld: false,
        detectRetina: !IS_MOBILE,
        crossOrigin: 'anonymous',
        updateWhenIdle: true,
        updateWhenZooming: true,
        keepBuffer: IS_MOBILE ? 2 : 1,
        className: 'filtered-tile',
        maxZoom: MAX_ZOOM,
        // tile gris 1x1 (no transparente) para no ver "blanco total"
        errorTileUrl:
            'data:image/gif;base64,R0lGODlhAQABAIABAP///wAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw=='
    };

    const osm = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        ...baseOptions,
        maxNativeZoom: MAX_ZOOM, // 17
        attribution: '&copy; OpenStreetMap contributors'
    });

    const carto = L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
        ...baseOptions,
        subdomains: 'abcd',
        maxNativeZoom: MAX_ZOOM, // 17
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
        if (retryTimer) { clearInterval(retryTimer); retryTimer = null; }
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

    // Control de errores de tiles (evitar pantalla en blanco)
    let tileErrorCountAtZ17 = 0;
    function clampIfNeeded() {
        const z = map.getZoom();
        if (z > MAX_ZOOM) map.setZoom(MAX_ZOOM);
    }

    osm.on('tileerror', () => {
        clampIfNeeded();
        if (!map.hasLayer(carto)) useBase(carto);
        if (map.getZoom() === MAX_ZOOM) {
            tileErrorCountAtZ17++;
            if (tileErrorCountAtZ17 >= 6) { // varios tiles fallaron en z=17
                map.setZoom(MAX_ZOOM - 1);   // bajar a 16 una vez para rellenar
                tileErrorCountAtZ17 = 0;
            }
        }
        startRetryOSM();
    });

    carto.on('tileerror', () => {
        clampIfNeeded();
        // si Carto también falla en z=17, bajamos a 16 para evitar gaps
        if (map.getZoom() === MAX_ZOOM) {
            map.setZoom(MAX_ZOOM - 1);
        }
    });

    osm.on('load', () => stopRetryOSM());
    carto.on('load', clampIfNeeded);

    // Arranque con OSM
    useBase(osm);

    // ===== Escala =====
    L.control.scale({ imperial: false }).addTo(map);

    // ===== Botón "Vista mundial" (sin botón de ubicación) =====
    const ResetView = L.Control.extend({
        options: { position: 'topleft' },
        onAdd() {
            const box = L.DomUtil.create('div', 'leaflet-bar');
            const a = L.DomUtil.create('a', '', box);
            a.href = '#';
            a.title = 'Vista mundial';
            a.setAttribute('aria-label', 'Vista mundial');
            a.textContent = '🌐';
            a.onclick = (e) => { e.preventDefault(); map.setView(DEFAULT_CENTER, DEFAULT_ZOOM); };
            L.DomEvent.disableClickPropagation(box);
            L.DomEvent.disableScrollPropagation(box);
            return box;
        }
    });
    map.addControl(new ResetView());

    // Mantener dentro de límites al cambiar tamaño
    map.on('resize', () => map.panInsideBounds(WORLD_BOUNDS, { animate: false }));

    // ===== Mobile tuning / sin “mi ubicación” + reflow fixes =====
    (() => {
        const css = document.createElement('style');
        css.textContent = `
      #map { -webkit-touch-callout: none; touch-action: manipulation; background:#f5f5f5; }
      .leaflet-bar, .leaflet-control { user-select: none; -webkit-user-select: none; }
      @media (max-width: 480px) {
        .leaflet-bar a, .leaflet-control-zoom a {
          width: 28px; height: 28px; line-height: 28px; font-size: 14px;
        }
        .leaflet-control-scale-line { font-size: 9px; }
      }
    `;
        document.head.appendChild(css);

        map.getContainer().addEventListener('contextmenu', (e) => e.preventDefault());

        // Si algún plugin intentara agregar un botón de "mi ubicación", lo removemos
        const killLocate = () => {
            document.querySelectorAll('.leaflet-control-locate').forEach(n => n.remove());
        };
        map.on('layeradd', killLocate);
        queueMicrotask(killLocate);

        // Reflow/resize fixes (tabs/modales/orientación)
        const invalidate = () => {
            map.invalidateSize(false);
            clampIfNeeded();
        };
        window.addEventListener('orientationchange', () => setTimeout(invalidate, 50), { passive: true });
        document.addEventListener('visibilitychange', () => { if (!document.hidden) setTimeout(invalidate, 50); });
        window.addEventListener('resize', () => setTimeout(invalidate, 50));

        // Si el contenedor cambia con CSS transitions (tabs), forzamos invalidate
        const container = map.getContainer();
        container.addEventListener('transitionend', () => setTimeout(invalidate, 20));
    })();

    // ===== Prefetch suave de tiles alrededor del viewport =====
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
                try { layer._update(); } finally { layer._getTiledPixelBounds = orig; }
            });
        } catch { /* best-effort */ }
    }
    map.on('moveend zoomend', () => prefetchTiles());

    window.__APP_MAP__ = map;
}

export { map };
