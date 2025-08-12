// modules/Map.js
// Mapa Leaflet con mejoras de rendimiento/UX y vector opcional con idioma ES.

let map = window.__APP_MAP__ || null;
export { map };

/* ===== Service Worker (no bloqueante) ===== */
if ("serviceWorker" in navigator) {
    try { navigator.serviceWorker.register("/sw.js").catch(() => { }); } catch { }
}

(() => {
    if (map) return;

    /* ===== Entorno / capacidades ===== */
    const UA_MOBILE = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
    const PREFERS_REDUCED = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
    const DPR = window.devicePixelRatio || 1;
    const conn = navigator.connection || navigator.webkitConnection || navigator.mozConnection;
    const SAVE_DATA = !!(conn && (conn.saveData || /2g/.test(conn.effectiveType || "")));
    const DEV_MEM_GB = Number(navigator.deviceMemory || 4);
    const tinyScreen = Math.min(window.innerWidth, window.innerHeight) < 360;

    /* ===== Constantes ===== */
    const MAP_ELEMENT_ID = "map";
    const WORLD_BOUNDS = L.latLngBounds(L.latLng(-85, -180), L.latLng(85, 180));
    const DEFAULT_CENTER = [20, 0];
    const DEFAULT_ZOOM = tinyScreen ? 2 : 3;
    const MAX_ZOOM = 18;

    // Prefetch adaptativo (más chico si red lenta / memoria baja)
    const PREFETCH_PAD_PX =
        Math.round(
            256 *
            (UA_MOBILE ? 0.7 : 1) *
            Math.min(DPR, 2) *
            (SAVE_DATA ? 0.6 : 1) *
            (DEV_MEM_GB < 4 ? 0.75 : 1)
        );

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
        inertia: UA_MOBILE,
        inertiaDeceleration: 3000,
        tap: true,
        tapTolerance: 22,
        touchZoom: "center",
        doubleClickZoom: false,

        // Animaciones
        zoomAnimation: !PREFERS_REDUCED && !UA_MOBILE,
        fadeAnimation: !PREFERS_REDUCED && !UA_MOBILE,
        markerZoomAnimation: !PREFERS_REDUCED && !UA_MOBILE,

        // Límites del mundo
        maxBounds: WORLD_BOUNDS,
        maxBoundsViscosity: 1,

        // Rueda: la vamos a manejar nosotros (Ctrl+rueda)
        scrollWheelZoom: false,
        wheelDebounceTime: 40,
        wheelPxPerZoomLevel: 120
    });

    const mapEl = map.getContainer();
    mapEl.style.touchAction = "manipulation";

    /* ===== Indicador de red simple (carga de tiles) ===== */
    const netBadge = (() => {
        const el = document.createElement('div');
        el.className = 'map-net-badge';
        Object.assign(el.style, {
            position: 'absolute', top: '8px', left: '8px', zIndex: 1200,
            background: 'rgba(17,24,39,.85)', color: '#fff', padding: '2px 6px',
            borderRadius: '6px', font: '12px/1 system-ui, sans-serif',
            opacity: 0, transition: 'opacity .15s'
        });
        el.textContent = 'Cargando mapa…';
        mapEl.appendChild(el);
        let shown = false, hideTO = 0, counter = 0;
        const show = () => {
            counter++;
            if (!shown) { el.style.opacity = .96; shown = true; }
        };
        const hide = () => {
            counter = Math.max(0, counter - 1);
            if (counter === 0) { clearTimeout(hideTO); hideTO = setTimeout(() => { el.style.opacity = 0; shown = false; }, 120); }
        };
        return { show, hide };
    })();

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

    /* ===== Opciones comunes raster (adaptativas) ===== */
    const rasterOptions = {
        noWrap: true,
        detectRetina: !UA_MOBILE && !SAVE_DATA,
        crossOrigin: "anonymous",
        updateWhenIdle: true,
        updateWhenZooming: true,
        keepBuffer: UA_MOBILE ? (DEV_MEM_GB < 4 ? 0 : 1) : (DEV_MEM_GB < 4 ? 1 : 2),
        className: "filtered-tile",
        maxZoom: MAX_ZOOM,
        maxNativeZoom: SAVE_DATA ? Math.min(17, MAX_ZOOM) : Math.min(18, MAX_ZOOM),
        errorTileUrl: "data:image/gif;base64,R0lGODlhAQABAIABAP///wAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw=="
    };

    /* ===== Base: Raster Positron por defecto ===== */
    const positronUrl = "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png";
    const cartoPositron = L.tileLayer(positronUrl, { ...rasterOptions, subdomains: "abcd", attribution: "© OpenStreetMap contributors · © CARTO" });

    // Reintentos suaves para mosaicos (mejor UX en redes flojas)
    const hookTileLayer = (tl) => {
        tl.on('loading', () => netBadge.show());
        tl.on('load', () => netBadge.hide());
        tl.on('tileerror', (e) => {
            // Reintento 1x tras 800ms (no spamear)
            const img = e.tile;
            if (img && !img.dataset.__retried) {
                img.dataset.__retried = '1';
                setTimeout(() => { img.src = e.url; }, 800);
            }
        });
    };
    cartoPositron.addTo(map);
    hookTileLayer(cartoPositron);

    /* ===== Vector opcional (MapLibre + idioma ES) =====
       Requiere que hayas cargado:
       - maplibre-gl, leaflet-maplibre-gl y openmaptiles-language en index.html
       - window.__MAPTILER_KEY__ = '...'
       Si existen, montamos vector encima y forzamos etiquetas en español.
    */
    (function maybeEnableVector() {
        const key = window.__MAPTILER_KEY__;
        const hasML = !!(window.maplibregl && L.maplibreGL);
        if (!key || !hasML) return;

        const styleUrl = `https://api.maptiler.com/maps/streets-v2/style.json?key=${key}`;

        // Insertamos capa GL en Leaflet (queda sobre Positron; podrías quitar Positron si quieres solo vector)
        const glLayer = L.maplibreGL({ style: styleUrl, interactive: false }).addTo(map);

        const ml = glLayer.getMaplibreMap();
        const applyLang = () => {
            try {
                // Si está el plugin, forzamos español. Si no, tratamos de ajustar el layout property.
                if (window.MapLibreLanguage) {
                    ml.addControl(new MapLibreLanguage({ defaultLanguage: 'es' }));
                } else {
                    // Fallback manual: cambia text-field de capas de labels conocidas
                    const style = ml.getStyle();
                    (style.layers || []).forEach(ly => {
                        if (!ly.layout || !/text-field/.test(Object.keys(ly.layout))) return;
                        try {
                            ml.setLayoutProperty(ly.id, 'text-field', [
                                'coalesce',
                                ['get', 'name:es'],
                                ['get', 'name:es-Latn'],
                                ['get', 'name'],
                            ]);
                        } catch { }
                    });
                }
            } catch { }
        };
        ml.on('styledata', applyLang);
        applyLang();

        // Mostrar también el badge de red cuando vector esté cargando fuentes/tiles
        ml.on('sourcedata', (e) => {
            if (e.isSourceLoaded === false) netBadge.show();
            if (e.isSourceLoaded === true) netBadge.hide();
        });

        // API pública para cambiar idioma más tarde, si lo necesitas
        window.setVectorLanguage = (lang = 'es') => {
            try {
                if (window.MapLibreLanguage) {
                    // remover y volver a agregar para aplicar nuevo default
                    const ctrls = (ml._controls || []).filter(c => c instanceof MapLibreLanguage);
                    ctrls.forEach(c => ml.removeControl(c));
                    ml.addControl(new MapLibreLanguage({ defaultLanguage: lang }));
                }
            } catch { }
        };
    })();

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
        map.setView(DEFAULT_CENTER, DEFAULT_ZOOM, { animate: !PREFERS_REDUCED });
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

    /* ===== Filtro Día / Tarde / Noche (igual a tu versión) ===== */
    (function installTimeOfDayControl() {
        const tilePane = map.getPane('tilePane');

        const PRESET_PARAMS = {
            day: { b: 1.00, c: 1.00, sep: 0.00, sat: 1.00, hue: 0 },
            dusk: { b: 0.82, c: 1.15, sep: 0.55, sat: 1.25, hue: -12 },
            night: { b: 0.42, c: 1.20, sep: 0.00, sat: 1.40, hue: 190 }
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
                Object.assign(box.style, { background: '#fff', padding: '2px' });

                const group = L.DomUtil.create('div', '', box);
                Object.assign(group.style, { display: 'flex', alignItems: 'center', gap: '4px' });

                const btnCol = L.DomUtil.create('div', '', group);
                Object.assign(btnCol.style, { display: 'flex', flexDirection: 'column', gap: '2px' });

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

                const sliderCol = L.DomUtil.create('div', '', group);
                Object.assign(sliderCol.style, { display: 'flex', alignItems: 'center', justifyContent: 'center', width: '22px', height: '100%' });

                const slider = L.DomUtil.create('input', '', sliderCol);
                slider.type = 'range'; slider.min = '0'; slider.max = '100'; slider.step = '1';
                slider.value = String(Math.round((intensityBy[current] ?? 0) * 100));
                Object.assign(slider.style, {
                    transform: 'rotate(-90deg)', transformOrigin: '50% 50%',
                    appearance: 'none', WebkitAppearance: 'none', MozAppearance: 'none',
                    width: '84px', height: '18px', margin: '0', outline: 'none'
                });

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
                    intensityBy[current] = Math.max(0, Math.min(1, t));
                    apply();
                });

                function fitSlider() {
                    requestAnimationFrame(() => {
                        const h = Math.max(70, Math.round(btnCol.getBoundingClientRect().height));
                        slider.style.width = `${h}px`;
                    });
                }

                markActive(current);
                apply();
                fitSlider();
                window.addEventListener('resize', fitSlider, { passive: true });
                document.addEventListener('orientationchange', () => setTimeout(fitSlider, 200), { passive: true });

                window.setTimeOfDay = (k) => {
                    const ok = ['day', 'dusk', 'night'].includes(k);
                    if (ok) { current = k; markActive(k); slider.value = String(Math.round((intensityBy[current] ?? 0) * 100)); apply(); fitSlider(); }
                };
                window.setTimeIntensity = (t01) => {
                    intensityBy[current] = Math.max(0, Math.min(1, Number(t01) || 0));
                    slider.value = String(Math.round(intensityBy[current] * 100));
                    apply(); fitSlider();
                };

                return wrap;
            }
        });

        const tod = new TodControl();
        map.addControl(tod);
        window.__TOD_CTL__ = tod;
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

    /* ===== Zoom con rueda solo con Ctrl/⌘ (mejor UX en páginas largas) ===== */
    (function installCtrlWheelZoom() {
        let tipTO = 0;
        const tip = document.createElement('div');
        tip.textContent = 'Mantén Ctrl (o ⌘) para hacer zoom';
        Object.assign(tip.style, {
            position: 'absolute', bottom: '10px', left: '50%', transform: 'translateX(-50%)',
            background: 'rgba(0,0,0,.75)', color: '#fff', padding: '6px 10px',
            borderRadius: '8px', font: '12px/1 system-ui, sans-serif', opacity: 0, transition: 'opacity .15s',
            pointerEvents: 'none', zIndex: 1200
        });
        mapEl.appendChild(tip);
        const showTip = () => { clearTimeout(tipTO); tip.style.opacity = .96; tipTO = setTimeout(() => tip.style.opacity = 0, 900); };

        mapEl.addEventListener('wheel', (ev) => {
            const accelKey = ev.ctrlKey || ev.metaKey;
            if (!accelKey) { showTip(); return; }
            ev.preventDefault();
            const delta = ev.deltaY;
            const dir = delta > 0 ? -1 : 1;
            const step = (ev.deltaMode === 1) ? 1 : 0.25;
            const targetZoom = map.getZoom() + dir * step * 2; // un poco más “rápido”
            map.setZoomAround(map.mouseEventToLatLng(ev), Math.max(map.getMinZoom(), Math.min(MAX_ZOOM, targetZoom)));
        }, { passive: false });
    })();

    /* ===== Pinch-zoom del navegador a MAX_ZOOM ===== */
    function updatePinchZoomMode() {
        if (!UA_MOBILE) return;
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

            // Clima (si algún día agregas)
            if (window.__WEATHER_CTL__) {
                try { window.__DESTROY_WEATHER__?.(); } catch { }
                window.__WEATHER_CTL__ = null;
                window.__DESTROY_WEATHER__ = null;
            }
        } catch { }
    };
})();
