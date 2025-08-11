// modules/Map.js
// Leaflet + capa base única: CARTO Positron.
// Móvil: límites de zoom, pellizco centrado, resize/orientación robusto,
// interacción táctil ajustada, prefetch pausado fuera de vista, aware de conexión
// y pantalla completa nativa + MODO PINCH-ZOOM DEL NAVEGADOR cuando se alcanza MAX_ZOOM.

let map = window.__APP_MAP__ || null;
export { map };

/* ===== Service Worker (no bloqueante) ===== */
if ("serviceWorker" in navigator) {
    try {
        navigator.serviceWorker.register("/sw.js").catch(() => { });
    } catch { }
}

(() => {
    if (map) return;

    /* ===== Utilidades / entorno ===== */
    const isMobileUA = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
    const prefersReducedMotion =
        typeof matchMedia === "function" &&
        matchMedia("(prefers-reduced-motion: reduce)").matches;
    const dpr = window.devicePixelRatio || 1;

    // Info de red (aware de conexión)
    const conn =
        navigator.connection ||
        navigator.webkitConnection ||
        navigator.mozConnection;
    const SAVE_DATA = !!(conn && (conn.saveData || /2g/.test(conn.effectiveType || "")));

    // Pantallas muy chicas: baja zoom inicial
    const tinyScreen =
        Math.min(window.innerWidth, window.innerHeight) < 360;

    /* ===== Constantes ===== */
    const MAP_ELEMENT_ID = "map";
    const WORLD_BOUNDS = L.latLngBounds(
        L.latLng(-85, -180),
        L.latLng(85, 180)
    );
    const DEFAULT_CENTER = [20, 0];
    const DEFAULT_ZOOM = tinyScreen ? 2 : 3;
    // En móvil, al llegar a MAX_ZOOM se habilita pinch-zoom del navegador
    const MAX_ZOOM = isMobileUA ? 18 : 18;
    // Prefetch pad adaptado por dispositivo
    const PREFETCH_PAD_PX = Math.round(
        256 * (isMobileUA ? 0.75 : 1) * Math.min(dpr, 2)
    );
    // Doble toque (captura coords)
    const TOUCH_DOUBLE_TAP_MS = 350;

    /* ===== Hot reload limpio ===== */
    const existing = L.DomUtil.get(MAP_ELEMENT_ID);
    if (existing && existing._leaflet_id) existing._leaflet_id = undefined;

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
        touchZoom: "center",       // pellizco centrado (cuando Leaflet tiene el control)
        doubleClickZoom: false,    // reservamos doble tap para coords

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

    const mapEl = map.getContainer();
    mapEl.style.touchAction = "manipulation"; // evita zoom por doble tap del browser

    // Atribuciones
    map.attributionControl.addAttribution("© OpenStreetMap contributors");

    /* ===== Opciones comunes raster (aware de conexión) ===== */
    const rasterOptions = {
        noWrap: true,
        detectRetina: !isMobileUA && !SAVE_DATA,
        crossOrigin: "anonymous",
        updateWhenIdle: true,
        updateWhenZooming: true,
        keepBuffer: isMobileUA ? 1 : 2,
        className: "filtered-tile",
        maxZoom: MAX_ZOOM,
        maxNativeZoom: SAVE_DATA ? Math.min(17, MAX_ZOOM) : Math.min(18, MAX_ZOOM),
        errorTileUrl:
            "data:image/gif;base64,R0lGODlhAQABAIABAP///wAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw=="
    };

    /* ===== Capa base única: CARTO Positron ===== */
    const cartoPositron = L.tileLayer(
        "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png",
        {
            ...rasterOptions,
            subdomains: "abcd",
            attribution: "© OpenStreetMap contributors · © CARTO"
        }
    );
    cartoPositron.addTo(map);

    /* ===== Controles ===== */
    L.control.scale({ imperial: false }).addTo(map);

    // --- Reset view (control simple y accesible) ---
    const ResetViewControl = L.Control.extend({
        options: { position: "topleft" },
        onAdd() {
            const box = L.DomUtil.create("div", "leaflet-bar");
            const a = L.DomUtil.create("a", "", box);
            a.href = "#";
            a.title = "Vista mundial";
            a.setAttribute("aria-label", "Vista mundial");
            a.textContent = "🌐";
            a.onclick = onResetClick;
            L.DomEvent.disableClickPropagation(box);
            L.DomEvent.disableScrollPropagation(box);
            return box;
        }
    });
    function onResetClick(e) {
        e.preventDefault();
        map.setView(DEFAULT_CENTER, DEFAULT_ZOOM, {
            animate: !prefersReducedMotion
        });
    }
    map.addControl(new ResetViewControl());

    // --- Fullscreen nativo ---
    const FullscreenControl = L.Control.extend({
        options: { position: "topleft" },
        onAdd() {
            const box = L.DomUtil.create("div", "leaflet-bar");
            const a = L.DomUtil.create("a", "", box);
            a.href = "#";
            a.title = "Pantalla completa";
            a.setAttribute("aria-label", "Pantalla completa");
            a.textContent = "⛶";
            a.onclick = onFullscreenToggle;
            document.addEventListener("fullscreenchange", onFullscreenChange);
            L.DomEvent.disableClickPropagation(box);
            L.DomEvent.disableScrollPropagation(box);
            return box;
        }
    });
    async function onFullscreenToggle(e) {
        e?.preventDefault();
        const el = mapEl;
        if (!document.fullscreenElement) {
            await el.requestFullscreen?.();
        } else {
            await document.exitFullscreen?.();
        }
    }
    function onFullscreenChange() {
        invalidateNow(false);      // <<< añadido mínimo
        updatePinchZoomMode();
    }
    map.addControl(new FullscreenControl());

    /* ===== Prefetch de mosaicos (pausado si no visible) ===== */
    let mapVisible = true;

    const io = "IntersectionObserver" in window
        ? new IntersectionObserver(onIntersection, { root: null, threshold: 0.01 })
        : null;
    io?.observe(mapEl);

    function onIntersection(entries) {
        mapVisible = entries[0]?.isIntersecting ?? true;
        if (mapVisible) {
            invalidateNow(false);  // <<< añadido mínimo
            updatePinchZoomMode();
        }
    }

    let prefetchRAF = 0;
    function prefetchTiles(padPx = PREFETCH_PAD_PX) {
        if (!mapVisible) return;
        if (prefetchRAF) cancelAnimationFrame(prefetchRAF);
        prefetchRAF = requestAnimationFrame(() => {
            prefetchRAF = 0;
            try {
                const bounds = map.getPixelBounds();
                const paddedBounds = L.bounds(
                    bounds.min.subtract([padPx, padPx]),
                    bounds.max.add([padPx, padPx])
                );
                map.eachLayer((layer) => {
                    if (!(layer instanceof L.TileLayer) || !map.hasLayer(layer)) return;
                    if (
                        typeof layer._update !== "function" ||
                        typeof layer._getTiledPixelBounds !== "function"
                    ) return;

                    const originalFn = layer._getTiledPixelBounds;
                    layer._getTiledPixelBounds = () => paddedBounds;
                    try {
                        layer._update();
                    } finally {
                        layer._getTiledPixelBounds = originalFn;
                    }
                });
            } catch { }
        });
    }
    function onMoveOrZoomEnd() { prefetchTiles(); }

    map.on("moveend zoomend", onMoveOrZoomEnd);
    map.whenReady(() => prefetchTiles());

    /* ===== Captura de coordenadas ===== */
    function fireCoords(e, source) {
        const round = (v) => Math.round(v * 1e6) / 1e6;
        const latlng = L.latLng(round(e.latlng.lat), round(e.latlng.lng));
        map.fire("app:coords", { latlng, source });
    }
    function onContextMenu(e) { fireCoords(e, "contextmenu"); }
    map.on("contextmenu", onContextMenu);

    // Doble toque móvil para coords (no interfiere con pellizco)
    let lastTap = 0;
    function onTouchStart(e) {
        if (!e.touches || e.touches.length !== 1) return;
        const now = Date.now();
        const delta = now - lastTap;

        const touch = e.touches[0];
        const rect = mapEl.getBoundingClientRect();
        const point = L.point(touch.clientX - rect.left, touch.clientY - rect.top);
        const latlng = map.containerPointToLatLng(point);

        if (delta > 0 && delta < TOUCH_DOUBLE_TAP_MS) {
            e.preventDefault();
            lastTap = 0;
            fireCoords({ latlng }, "doubletap");
        } else {
            lastTap = now;
        }
    }
    function preventBrowserContext(e) { e.preventDefault(); }

    mapEl.addEventListener("touchstart", onTouchStart, { passive: false });
    map.on("dblclick", (e) => fireCoords(e, "dblclick"));
    mapEl.addEventListener("contextmenu", preventBrowserContext, { passive: false });

    /* ===== MODO PINCH-ZOOM DEL NAVEGADOR AL LLEGAR A MAX_ZOOM ===== */
    function updatePinchZoomMode() {
        if (!isMobileUA) return;

        const atMax = map.getZoom() >= MAX_ZOOM;
        if (atMax) {
            // Leaflet deja de “comerse” el pellizco
            if (map.touchZoom.enabled()) map.touchZoom.disable();
            // Permitimos pinch-zoom del navegador y que se “quede así”
            mapEl.style.touchAction = "pinch-zoom";
            mapEl.classList.add("pinch-image-mode");
        } else {
            // Volvemos a control normal de Leaflet
            if (!map.touchZoom.enabled()) map.touchZoom.enable();
            mapEl.style.touchAction = "manipulation";
            mapEl.classList.remove("pinch-image-mode");
        }
    }

    function onZoomEnd() { updatePinchZoomMode(); }

    // <<< añadido mínimo: invalidar tamaño al volver de background
    function onVisibilityChange() {
        if (!document.hidden) {
            invalidateNow(false);
            updatePinchZoomMode();
        }
    }

    map.whenReady(updatePinchZoomMode);
    map.on("zoomend", onZoomEnd);
    document.addEventListener("visibilitychange", onVisibilityChange);

    /* ===== Resize / orientación robusto ===== */
    const ro = "ResizeObserver" in window
        ? new ResizeObserver(() => {
            invalidateNow(false);  // <<< añadido mínimo
            updatePinchZoomMode();
        })
        : null;
    ro?.observe(mapEl);

    function onOrientationChange() {
        setTimeout(() => {
            invalidateNow(false);  // <<< añadido mínimo
            updatePinchZoomMode();
        }, 200);
    }
    window.addEventListener("orientationchange", onOrientationChange, { passive: true });

    // <<< añadido mínimo: backup por resize de ventana (desktop)
    let resizeTO = 0;
    function onWindowResize() {
        clearTimeout(resizeTO);
        resizeTO = setTimeout(() => invalidateNow(false), 100);
    }
    window.addEventListener("resize", onWindowResize, { passive: true });

    // <<< añadido mínimo: helper centralizado + API pública
    function invalidateNow(animate = false) {
        try { map.invalidateSize({ animate }); } catch { /* noop */ }
    }
    window.__invalidateMap__ = () => invalidateNow(false);
    document.addEventListener("app:layout-change", () => invalidateNow(false));

    // Guardar referencia global
    window.__APP_MAP__ = map;

    // Limpieza para HMR
    window.__APP_MAP_CLEANUP__?.();
    window.__APP_MAP_CLEANUP__ = () => {
        try {
            mapEl.removeEventListener("touchstart", onTouchStart);
            mapEl.removeEventListener("contextmenu", preventBrowserContext);
            document.removeEventListener("visibilitychange", onVisibilityChange);
            document.removeEventListener("fullscreenchange", onFullscreenChange);
            window.removeEventListener("orientationchange", onOrientationChange);
            window.removeEventListener("resize", onWindowResize);
            io?.disconnect?.();
            ro?.disconnect?.();
            if (prefetchRAF) cancelAnimationFrame(prefetchRAF);
            map.off("moveend", onMoveOrZoomEnd);
            map.off("zoomend", onMoveOrZoomEnd);
            map.off("zoomend", onZoomEnd);
            map.off("contextmenu", onContextMenu);
        } catch { }
    };
})();
