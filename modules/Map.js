// modules/Map.js
// Leaflet + capa base única: CARTO Positron.
// Móvil: límites de zoom, pellizco centrado, resize/orientación robusto,
// interacción táctil ajustada, prefetch pausado fuera de vista, aware de conexión
// y pantalla completa nativa + MODO PINCH-ZOOM DEL NAVEGADOR cuando se alcanza MAX_ZOOM.

let map = window.__APP_MAP__ || null;
export { map };

(() => {
    if (map) return;

    /* ===== Utilidades / entorno ===== */
    const isMobileUA = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
    const prefersReducedMotion =
        typeof matchMedia === 'function' &&
        matchMedia('(prefers-reduced-motion: reduce)').matches;
    const dpr = window.devicePixelRatio || 1;

    // Info de red (aware de conexión)
    const conn = navigator.connection || navigator.webkitConnection || navigator.mozConnection;
    const SAVE_DATA = !!(conn && (conn.saveData || /2g/.test(conn.effectiveType || '')));
    // Pantallas muy chicas: baja zoom inicial
    const tinyScreen = Math.min(window.innerWidth, window.innerHeight) < 360;

    const MAP_ELEMENT_ID = 'map';
    const WORLD_BOUNDS = L.latLngBounds(L.latLng(-85, -180), L.latLng(85, 180));
    const DEFAULT_CENTER = [20, 0];
    const DEFAULT_ZOOM = tinyScreen ? 2 : 3;
    // Límite de zoom móvil (más conservador). Cuando llegamos acá, habilitamos pinch-zoom del navegador.
    const MAX_ZOOM = isMobileUA ? 18 : 18;

    // Prefetch pad adaptado por dispositivo
    const PREFETCH_PAD_PX = Math.round(256 * (isMobileUA ? 0.75 : 1) * Math.min(dpr, 2));

    /* ===== Hot reload limpio ===== */
    const el = L.DomUtil.get(MAP_ELEMENT_ID);
    if (el && el._leaflet_id) el._leaflet_id = undefined;

    const container = document.getElementById(MAP_ELEMENT_ID);
    if (!container) {
        console.warn(`[Map] No se encontró #${MAP_ELEMENT_ID}.`);
        window.__APP_MAP__ = null;
        return;
    }

    /* ===== Inicialización del mapa ===== */
    map = L.map(MAP_ELEMENT_ID, {
        center: DEFAULT_CENTER,
        zoom: DEFAULT_ZOOM,
        minZoom: 3,
        maxZoom: MAX_ZOOM,
        zoomControl: true,
        attributionControl: true,
        preferCanvas: true,

        // Interacción
        inertia: isMobileUA,
        inertiaDeceleration: 3000,
        tap: true,
        tapTolerance: 22,
        touchZoom: 'center',        // pellizco centrado (cuando Leaflet tiene el control)
        doubleClickZoom: false,     // reservamos doble tap para coords

        // Animaciones
        zoomAnimation: !prefersReducedMotion && !isMobileUA,
        fadeAnimation: !prefersReducedMotion && !isMobileUA,
        markerZoomAnimation: !prefersReducedMotion && !isMobileUA,

        // Límites del mundo
        maxBounds: WORLD_BOUNDS,
        maxBoundsViscosity: 1,

        // Rueda (desktop)
        wheelDebounceTime: 40,
        wheelPxPerZoomLevel: 120
    });

    // Por defecto: gestos del mapa activos pero sin zoom por doble tap del navegador
    map.getContainer().style.touchAction = 'manipulation';

    // Atribuciones
    map.attributionControl.addAttribution('© OpenStreetMap contributors');

    /* ===== Opciones comunes raster (aware de conexión) ===== */
    const rasterOptions = {
        noWrap: true,
        detectRetina: !isMobileUA && !SAVE_DATA,
        crossOrigin: 'anonymous',
        updateWhenIdle: true,
        updateWhenZooming: true,
        keepBuffer: isMobileUA ? 1 : 2,
        className: 'filtered-tile',
        maxZoom: MAX_ZOOM,
        maxNativeZoom: SAVE_DATA ? Math.min(17, MAX_ZOOM) : Math.min(18, MAX_ZOOM),
        errorTileUrl:
            'data:image/gif;base64,R0lGODlhAQABAIABAP///wAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw=='
    };

    /* ===== Capa base única: CARTO Positron ===== */
    const cartoPositron = L.tileLayer(
        'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
        { ...rasterOptions, subdomains: 'abcd', attribution: '© OpenStreetMap contributors · © CARTO' }
    );
    cartoPositron.addTo(map);

    /* ===== Controles ===== */
    // Escala métrica
    L.control.scale({ imperial: false }).addTo(map);

    // Botón reset vista
    const ResetViewControl = L.Control.extend({
        options: { position: 'topleft' },
        onAdd() {
            const box = L.DomUtil.create('div', 'leaflet-bar');
            const a = L.DomUtil.create('a', '', box);
            a.href = '#';
            a.title = 'Vista mundial';
            a.setAttribute('aria-label', 'Vista mundial');
            a.textContent = '🌐';
            const goHome = (e) => {
                e.preventDefault();
                map.setView(DEFAULT_CENTER, DEFAULT_ZOOM, { animate: !prefersReducedMotion });
            };
            a.onclick = goHome;
            L.DomEvent.disableClickPropagation(box);
            L.DomEvent.disableScrollPropagation(box);
            return box;
        }
    });
    map.addControl(new ResetViewControl());

    // Control: Pantalla completa nativa
    const FullscreenControl = L.Control.extend({
        options: { position: 'topleft' },
        onAdd() {
            const box = L.DomUtil.create('div', 'leaflet-bar');
            const a = L.DomUtil.create('a', '', box);
            a.href = '#';
            a.title = 'Pantalla completa';
            a.setAttribute('aria-label', 'Pantalla completa');
            a.textContent = '⛶';

            const toggle = async (e) => {
                e?.preventDefault();
                const el = map.getContainer();
                if (!document.fullscreenElement) {
                    await el.requestFullscreen?.();
                } else {
                    await document.exitFullscreen?.();
                }
            };
            a.onclick = toggle;

            document.addEventListener('fullscreenchange', () => {
                map.invalidateSize({ animate: false });
                updatePinchZoomMode(); // por si cambió el layout
            });

            L.DomEvent.disableClickPropagation(box);
            L.DomEvent.disableScrollPropagation(box);
            return box;
        }
    });
    map.addControl(new FullscreenControl());

    /* ===== Prefetch de mosaicos (pausado si no visible) ===== */
    let mapVisible = true;
    const io = new IntersectionObserver((entries) => {
        mapVisible = entries[0]?.isIntersecting ?? true;
        if (mapVisible) {
            map.invalidateSize({ animate: false });
            updatePinchZoomMode();
        }
    }, { root: null, threshold: 0.01 });
    io.observe(map.getContainer());

    let prefetchScheduled = false;
    const prefetchTiles = (padPx = PREFETCH_PAD_PX) => {
        if (!mapVisible) return;
        if (prefetchScheduled) return;
        prefetchScheduled = true;
        requestAnimationFrame(() => {
            try {
                const bounds = map.getPixelBounds();
                const paddedBounds = L.bounds(
                    bounds.min.subtract([padPx, padPx]),
                    bounds.max.add([padPx, padPx])
                );
                map.eachLayer((layer) => {
                    if (!(layer instanceof L.TileLayer) || !map.hasLayer(layer)) return;
                    if (typeof layer._update !== 'function' || typeof layer._getTiledPixelBounds !== 'function') return;
                    const originalFn = layer._getTiledPixelBounds;
                    layer._getTiledPixelBounds = () => paddedBounds;
                    try { layer._update(); } finally { layer._getTiledPixelBounds = originalFn; }
                });
            } catch { } finally { prefetchScheduled = false; }
        });
    };
    map.on('moveend zoomend', () => prefetchTiles());
    map.whenReady(() => prefetchTiles());

    /* ===== Captura de coordenadas ===== */
    const fireCoords = (e, source) => {
        const round = (v) => Math.round(v * 1e6) / 1e6;
        const latlng = L.latLng(round(e.latlng.lat), round(e.latlng.lng));
        map.fire('app:coords', { latlng, source });
    };
    map.on('contextmenu', (e) => fireCoords(e, 'contextmenu'));

    // Doble toque móvil para coords
    let lastTap = 0;
    const TOUCH_DOUBLE_TAP_MS = 350;
    const onTouchStart = (e) => {
        if (!e.touches || e.touches.length !== 1) return;
        const now = Date.now();
        const delta = now - lastTap;
        const touch = e.touches[0];
        const rect = map.getContainer().getBoundingClientRect();
        const point = L.point(touch.clientX - rect.left, touch.clientY - rect.top);
        const latlng = map.containerPointToLatLng(point);
        if (delta > 0 && delta < TOUCH_DOUBLE_TAP_MS) {
            e.preventDefault();
            lastTap = 0;
            fireCoords({ latlng }, 'doubletap');
        } else {
            lastTap = now;
        }
    };
    map.getContainer().addEventListener('touchstart', onTouchStart, { passive: false });
    map.on('dblclick', (e) => fireCoords(e, 'dblclick'));
    map.getContainer().addEventListener('contextmenu', (e) => e.preventDefault(), { passive: false });

    /* ===== MODO PINCH-ZOOM DEL NAVEGADOR AL LLEGAR A MAX_ZOOM ===== */
    function updatePinchZoomMode() {
        if (!isMobileUA) return;

        const atMax = map.getZoom() >= MAX_ZOOM;
        const el = map.getContainer();

        if (atMax) {
            // 1) Leaflet deja de “comerse” el pellizco
            if (map.touchZoom.enabled()) map.touchZoom.disable();
            // 2) Permitimos pinch-zoom del navegador y que se “quede así”
            el.style.touchAction = 'pinch-zoom';
            el.classList.add('pinch-image-mode'); // por si querés estilos
        } else {
            // Volvemos a control normal de Leaflet
            if (!map.touchZoom.enabled()) map.touchZoom.enable();
            el.style.touchAction = 'manipulation';
            el.classList.remove('pinch-image-mode');
        }
    }

    map.whenReady(updatePinchZoomMode);
    map.on('zoomend', updatePinchZoomMode);
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden) updatePinchZoomMode();
    });

    /* ===== Resize / orientación robusto ===== */
    let ro = null;
    try {
        ro = new ResizeObserver(() => {
            map.invalidateSize({ animate: false });
            // al cambiar layout podría cambiar el “atMax”; re-evaluamos
            updatePinchZoomMode();
        });
        ro.observe(map.getContainer());
    } catch { }
    window.addEventListener('orientationchange', () => {
        setTimeout(() => {
            map.invalidateSize({ animate: false });
            updatePinchZoomMode();
        }, 200);
    }, { passive: true });

    // Guardar referencia global
    window.__APP_MAP__ = map;

    // Limpieza para HMR
    window.__APP_MAP_CLEANUP__?.();
    window.__APP_MAP_CLEANUP__ = () => {
        try {
            map.getContainer().removeEventListener('touchstart', onTouchStart);
            io.disconnect?.();
            ro?.disconnect?.();
        } catch { }
    };
})();

