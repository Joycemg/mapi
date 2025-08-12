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
    const MAX_ZOOM = isMobileUA ? 18 : 18;
    const PREFETCH_PAD_PX = Math.round(256 * (isMobileUA ? 0.75 : 1) * Math.min(dpr, 2));
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
        touchZoom: "center",
        doubleClickZoom: false,

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
    mapEl.style.touchAction = "manipulation";

    /* === MINI PARCHE (escucha events del toolsBus) === */
    (() => {
        try {
            const applyChange = (name, prev) => {
                const mapEl = map.getContainer();
                mapEl.dataset.activeTool = name || '';
                if (prev) mapEl.classList.remove(`tool-${prev}`);
                if (name) mapEl.classList.add(`tool-${name}`);
                try { map.closePopup(); } catch { }
                mapEl.style.cursor = '';
                try { (window.__invalidateMap__ || (() => map.invalidateSize()))(); } catch { }
            };

            document.addEventListener('bus:will-activate', (e) => {
                const { from, to } = e.detail || {};
                applyChange(to, from);
            });

            document.addEventListener('bus:did-deactivate', (e) => {
                const { name } = e.detail || {};
                applyChange(null, name);
            });

            const swallowIfGeocoderOpen = (ev) => {
                const panel = document.querySelector('.geocoder-panel');
                if (!panel) return;
                const disp = panel.style.display || getComputedStyle(panel).display;
                if (disp === 'none') return;
                const t = ev.target;
                if (t instanceof HTMLElement && t.closest('.geocoder-box')) return;
                ev.stopPropagation();
            };
            mapEl.addEventListener('pointerdown', swallowIfGeocoderOpen, false);
            mapEl.addEventListener('click', swallowIfGeocoderOpen, false);
            mapEl.__swallowGeoFn = swallowIfGeocoderOpen;
        } catch { }
    })();

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

    // Reset view
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
        map.setView(DEFAULT_CENTER, DEFAULT_ZOOM, { animate: !prefersReducedMotion });
    }
    map.addControl(new ResetViewControl());

    // Fullscreen
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
        if (!document.fullscreenElement) await el.requestFullscreen?.();
        else await document.exitFullscreen?.();
    }
    function onFullscreenChange() { invalidateNow(false); updatePinchZoomMode(); }
    map.addControl(new FullscreenControl());

    /* ===== Día / Tarde / Noche (compacto, botones + slider al lado) ===== */
    (function installTimeOfDayControl() {
        const tilePane = map.getPane('tilePane');

        // Presets con tintes: tarde más rojiza, noche azulada fuerte
        const PRESET_PARAMS = {
            day: { b: 1.00, c: 1.00, sep: 0.00, sat: 1.00, hue: 0 },
            dusk: { b: 0.82, c: 1.15, sep: 0.55, sat: 1.25, hue: -12 }, // rojiza
            night: { b: 0.42, c: 1.20, sep: 0.00, sat: 1.40, hue: 190 }  // azulado
        };

        const clamp01 = (x) => Math.max(0, Math.min(1, x));
        function buildFilter(presetKey, t) {
            const p = PRESET_PARAMS[presetKey] || PRESET_PARAMS.day;
            t = clamp01(t);
            const b = (1 + (p.b - 1) * t).toFixed(2);
            const c = (1 + (p.c - 1) * t).toFixed(2);
            const sep = Math.round((p.sep * t) * 100);
            const sat = (1 + (p.sat - 1) * t).toFixed(2);
            const hue = Math.round(p.hue * t);
            return `brightness(${b}) contrast(${c}) sepia(${sep}%) saturate(${sat}) hue-rotate(${hue}deg)`;
        }

        // Intensidad por preset (editable con el slider por cada preset)
        const intensityBy = { day: 0.00, dusk: 0.70, night: 1.00 };

        let current = 'day';
        function apply() {
            if (!tilePane) return;
            tilePane.style.filter = buildFilter(current, intensityBy[current] ?? 0);
            map.getContainer().dataset.tod = current;
        }

        const TodControl = L.Control.extend({
            options: { position: 'topright' },
            onAdd() {
                const wrap = L.DomUtil.create('div', 'leaflet-bar tod-control tiny');
                L.DomEvent.disableClickPropagation(wrap);
                L.DomEvent.disableScrollPropagation(wrap);

                const box = L.DomUtil.create('div', '', wrap);
                Object.assign(box.style, {
                    background: '#fff',
                    padding: '2px'
                });

                // Contenedor único con DOS columnas: izquierda botones (vertical), derecha slider (vertical)
                const group = L.DomUtil.create('div', '', box);
                Object.assign(group.style, {
                    display: 'flex',
                    alignItems: 'center',
                    gap: '4px'
                });

                // Columna de botones (vertical)
                const btnCol = L.DomUtil.create('div', '', group);
                Object.assign(btnCol.style, {
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '2px'
                });

                const BTN_H = 22;
                const makeBtn = (k, label) => {
                    const a = L.DomUtil.create('a', '', btnCol);
                    a.href = '#'; a.title = label; a.setAttribute('aria-label', label);
                    Object.assign(a.style, {
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        height: `${BTN_H}px`, padding: '0 8px',
                        borderRadius: '5px', userSelect: 'none',
                        border: '1px solid #e5e7eb',
                        fontSize: '11px', fontWeight: '700', color: '#111827',
                        whiteSpace: 'nowrap', minWidth: '52px'
                    });
                    a.textContent = label;
                    a.onclick = (e) => {
                        e.preventDefault();
                        current = k; markActive(k);
                        slider.value = String(Math.round((intensityBy[current] ?? 0) * 100));
                        apply(); fitSlider();
                    };
                    return a;
                };

                makeBtn('day', 'Día');
                makeBtn('dusk', 'Tarde');
                makeBtn('night', 'Noche');

                function markActive(k) {
                    [...btnCol.children].forEach(el => {
                        el.classList.remove('active');
                        el.style.background = '';
                        el.style.boxShadow = '';
                        el.style.border = '1px solid #e5e7eb';
                    });
                    const idx = ['day', 'dusk', 'night'].indexOf(k);
                    const el = btnCol.children[idx];
                    if (el) {
                        el.classList.add('active');
                        el.style.background = '#eef4ff';
                        el.style.boxShadow = '0 0 0 1px #bdd0ff inset';
                        el.style.border = '1px solid #bdd0ff';
                    }
                }

                // Columna del slider (vertical)
                const sliderCol = L.DomUtil.create('div', '', group);
                Object.assign(sliderCol.style, {
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    width: '22px',
                    height: '100%'
                });

                const slider = L.DomUtil.create('input', '', sliderCol);
                slider.type = 'range'; slider.min = '0'; slider.max = '100'; slider.step = '1';
                slider.value = String(Math.round((intensityBy[current] ?? 0) * 100));
                Object.assign(slider.style, {
                    transform: 'rotate(-90deg)',
                    transformOrigin: '50% 50%',
                    appearance: 'none', WebkitAppearance: 'none', MozAppearance: 'none',
                    width: '84px', height: '18px', margin: '0', outline: 'none'
                });

                // Estilos del slider (mini)
                const styleId = 'tod-vertical-slider-style-tiny';
                if (!document.getElementById(styleId)) {
                    const s = document.createElement('style');
                    s.id = styleId;
                    s.textContent = `
          .tod-control.tiny input[type="range"]{background:transparent}
          .tod-control.tiny input[type="range"]::-webkit-slider-runnable-track{height:3px;background:#e5e7eb;border-radius:999px}
          .tod-control.tiny input[type="range"]::-webkit-slider-thumb{-webkit-appearance:none;width:10px;height:10px;border-radius:50%;background:#2563eb;margin-top:-3.5px}
          .tod-control.tiny input[type="range"]::-moz-range-track{height:3px;background:#e5e7eb;border-radius:999px}
          .tod-control.tiny input[type="range"]::-moz-range-thumb{width:10px;height:10px;border-radius:50%;background:#2563eb;border:0}
        `;
                    document.head.appendChild(s);
                }

                ['pointerdown', 'touchstart', 'mousedown', 'dblclick'].forEach(ev =>
                    L.DomEvent.on(slider, ev, (e) => e.stopPropagation(), { passive: true })
                );
                slider.addEventListener('input', () => {
                    const t = Number(slider.value) / 100;
                    intensityBy[current] = clamp01(t);
                    apply();
                });

                // Ajusta el largo del slider al alto total de los botones
                function fitSlider() {
                    requestAnimationFrame(() => {
                        const h = Math.max(70, Math.round(btnCol.getBoundingClientRect().height));
                        slider.style.width = `${h}px`; // rotado: width == alto visual
                    });
                }

                // Inicial
                markActive(current);
                apply();
                fitSlider();
                window.addEventListener('resize', fitSlider, { passive: true });
                document.addEventListener('orientationchange', () => setTimeout(fitSlider, 200), { passive: true });

                // Helpers opcionales
                window.setTimeOfDay = (k) => {
                    const ok = ['day', 'dusk', 'night'].includes(k);
                    if (ok) { current = k; markActive(k); slider.value = String(Math.round((intensityBy[current] ?? 0) * 100)); apply(); fitSlider(); }
                };
                window.setTimeIntensity = (t01) => {
                    intensityBy[current] = clamp01(Number(t01) || 0);
                    slider.value = String(Math.round(intensityBy[current] * 100));
                    apply(); fitSlider();
                };

                return wrap;
            }
        });

        map.addControl(new TodControl());
    })();




    /* ===== Prefetch de mosaicos (pausado si no visible) ===== */
    let mapVisible = true;
    const io = "IntersectionObserver" in window
        ? new IntersectionObserver(onIntersection, { root: null, threshold: 0.01 })
        : null;
    io?.observe(mapEl);
    function onIntersection(entries) {
        mapVisible = entries[0]?.isIntersecting ?? true;
        if (mapVisible) { invalidateNow(false); updatePinchZoomMode(); }
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
                    if (typeof layer._update !== "function" || typeof layer._getTiledPixelBounds !== "function") return;

                    const originalFn = layer._getTiledPixelBounds;
                    layer._getTiledPixelBounds = () => paddedBounds;
                    try { layer._update(); }
                    finally { layer._getTiledPixelBounds = originalFn; }
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

    // Doble toque móvil
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
        } else { lastTap = now; }
    }
    function preventBrowserContext(e) { e.preventDefault(); }
    mapEl.addEventListener("touchstart", onTouchStart, { passive: false });
    map.on("dblclick", (e) => fireCoords(e, "dblclick"));
    mapEl.addEventListener("contextmenu", preventBrowserContext, { passive: false });

    /* ===== Pinch-zoom del navegador a MAX_ZOOM ===== */
    function updatePinchZoomMode() {
        if (!isMobileUA) return;
        const atMax = map.getZoom() >= MAX_ZOOM;
        if (atMax) {
            if (map.touchZoom.enabled()) map.touchZoom.disable();
            mapEl.style.touchAction = "pinch-zoom";
            mapEl.classList.add("pinch-image-mode");
        } else {
            if (!map.touchZoom.enabled()) map.touchZoom.enable();
            mapEl.style.touchAction = "manipulation";
            mapEl.classList.remove("pinch-image-mode");
        }
    }
    function onZoomEnd() { updatePinchZoomMode(); }

    // Volver de background
    function onVisibilityChange() {
        if (!document.hidden) { invalidateNow(false); updatePinchZoomMode(); }
    }
    map.whenReady(updatePinchZoomMode);
    map.on("zoomend", onZoomEnd);
    document.addEventListener("visibilitychange", onVisibilityChange);

    /* ===== Resize / orientación robusto ===== */
    const ro = "ResizeObserver" in window
        ? new ResizeObserver(() => { invalidateNow(false); updatePinchZoomMode(); })
        : null;
    ro?.observe(mapEl);

    function onOrientationChange() {
        setTimeout(() => { invalidateNow(false); updatePinchZoomMode(); }, 200);
    }
    window.addEventListener("orientationchange", onOrientationChange, { passive: true });

    // Backup por resize (desktop)
    let resizeTO = 0;
    function onWindowResize() {
        clearTimeout(resizeTO);
        resizeTO = setTimeout(() => invalidateNow(false), 100);
    }
    window.addEventListener("resize", onWindowResize, { passive: true });

    // Helper centralizado + API pública
    function invalidateNow(animate = false) {
        try { map.invalidateSize({ animate }); } catch { }
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
            if (mapEl.__swallowGeoFn) {
                mapEl.removeEventListener('pointerdown', mapEl.__swallowGeoFn, false);
                mapEl.removeEventListener('click', mapEl.__swallowGeoFn, false);
                delete mapEl.__swallowGeoFn;
            }
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

            if (window.__TOD_CTL__) {
                try { map.removeControl(window.__TOD_CTL__); } catch { }
                window.__TOD_CTL__ = null;
            }
        } catch { }
    };
})();
