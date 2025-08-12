// modules/geocoder.js
import { map } from './Map.js';
import { registerTool, toggleTool } from './toolsBus.js';

/**
 * Geocoder + Ruteo estable
 * - Lupa visible y panel de búsqueda.
 * - Marca el destino con circulito azul + popup.
 * - Rutea SOLO si hay personaje seleccionado y hay destino.
 * - Si se busca primero y luego se elige personaje, rutea automáticamente.
 * - Al elegir "— Personaje —": borra SOLO el ruteo y deja el popup/marker.
 * - Al llegar: borra SOLO el ruteo, deja popup/marker y limpia LAST_DEST.
 * - NO reacciona a clicks del mapa.
 * - Una sola polyline (sin parpadeos) y pausa durante drag del PJ.
 * - Resultados ordenados por cercanía a la vista (viewport primero).
 * - Expone ruta para snap: window.__ACTIVE_ROUTE_LATLNGS__ y window.getActiveRouteLatLngs().
 */

if (!window.__GEOCODER_INITED__) {
    window.__GEOCODER_INITED__ = true;

    /* ======================== Estado/UI ======================== */
    const lang = (navigator.language || 'es').split('-')[0] || 'es';

    // Capas
    const searchGroup = L.layerGroup().addTo(map);
    const routeGroup = L.layerGroup().addTo(map);

    // Ruta estable
    let routeLine = null;
    let routeStartMarker = null;
    // (routeEndMarker opcional; usamos searchMarker para destino)
    let searchMarker = null;   // circulito azul del destino buscado (SIEMPRE)

    // Panel / controles
    let resultsPane = null;
    let loaderEl = null;
    let inputEl = null;
    let boundedChk = null;
    let prioritizeStreetsChk = null;
    let panelEl = null;
    let wrapperEl = null;
    let characterSel = null;
    let routeInfoEl = null;
    let toggleBtn = null;

    // hooks para el bus
    let __openPanel = () => { };
    let __closePanel = () => { };
    let __isOpen = () => false;

    // Estado ruteo
    let LAST_START = null;   // L.LatLng
    let LAST_DEST = null;   // L.LatLng (se mantiene si no hay personaje, para rutar cuando elijas uno)
    let LAST_CHAR_ID = '';   // id de personaje
    const ARRIVAL_EPS_M = 20;

    // Debounces
    let typeTimer = null;
    const TYPE_DELAY_MS = 350;
    let _moveTimer = null;
    const MOVE_DEBOUNCE_MS = 280;

    // rAF scheduler
    let _routeRAF = null;
    function scheduleRouteUpdate(fn) {
        if (_routeRAF) return;
        _routeRAF = requestAnimationFrame(() => { _routeRAF = null; try { fn(); } catch { } });
    }

    // Guardas de repetición
    let _LAST_ARGS_KEY = '';
    let _LAST_GEOM_KEY = '';

    // Cache persistente
    const CACHE = new Map();
    const LS_KEY = 'geo_cache_v1';
    const TTL_MS = 24 * 60 * 60 * 1000;
    const readLS = () => { try { return JSON.parse(localStorage.getItem(LS_KEY) || '{}'); } catch { return {}; } };
    const writeLS = (obj) => localStorage.setItem(LS_KEY, JSON.stringify(obj));
    const fetchCached = async (key, fetcher) => {
        if (CACHE.has(key)) return CACHE.get(key);
        const obj = readLS(); const hit = obj[key];
        if (hit && (Date.now() - hit.t) < TTL_MS) { CACHE.set(key, hit.v); return hit.v; }
        const v = await fetcher(); obj[key] = { v, t: Date.now() }; writeLS(obj); CACHE.set(key, v); return v;
    };

    // Personajes (inyectados desde characters.js)
    let CHARACTERS = []; // [{id,name,lat,lng}]
    function refreshCharacterSelect() {
        if (!characterSel) return;
        characterSel.innerHTML = '';
        const opt0 = document.createElement('option');
        opt0.value = ''; opt0.textContent = '— Personaje —';
        characterSel.appendChild(opt0);
        for (const ch of CHARACTERS) {
            const o = document.createElement('option');
            o.value = ch.id; o.textContent = ch.name || ch.id;
            characterSel.appendChild(o);
        }
        if (LAST_CHAR_ID && !CHARACTERS.find(c => c.id === LAST_CHAR_ID)) {
            characterSel.value = ''; LAST_CHAR_ID = '';
        } else if (LAST_CHAR_ID) {
            characterSel.value = LAST_CHAR_ID;
        }
    }
    window.setGeocoderCharacters = (arr) => {
        CHARACTERS = Array.isArray(arr) ? arr.slice() : [];
        refreshCharacterSelect();
    };

    /* ======================== Helpers ======================== */
    const LATLNG_RE = /^\s*(-?\d{1,3}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)\s*$/;
    const norm = (s) => String(s || '').normalize?.('NFD').replace?.(/[\u0300-\u036f]/g, '')?.replace(/\s+/g, ' ').trim() || String(s || '').trim();
    const fmtDist = (m) => (m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(2)} km`);

    function asLL(v) {
        if (!v) return null;
        const lat = (typeof v.lat === 'number') ? v.lat :
            (typeof v.latitude === 'number') ? v.latitude : null;
        const lng = (typeof v.lng === 'number') ? v.lng :
            (typeof v.lon === 'number') ? v.lon :
                (typeof v.longitude === 'number') ? v.longitude : null;
        if (!isFinite(lat) || !isFinite(lng)) return null;
        try { return L.latLng(lat, lng); } catch { return null; }
    }
    function isArrived(aLL, bLL, eps = ARRIVAL_EPS_M) {
        try { const d = L.latLng(aLL).distanceTo(L.latLng(bLL)); return isFinite(d) && d <= eps; }
        catch { return false; }
    }
    function requireActiveCharacter() {
        const id = (characterSel?.value || LAST_CHAR_ID || '').trim();
        if (!id) return null;
        const pj = CHARACTERS.find(c => c.id === id);
        if (!pj) return null;
        return { id, ll: L.latLng(pj.lat, pj.lng) };
    }
    function showLoader(on = true) { if (loaderEl) loaderEl.style.display = on ? 'inline-block' : 'none'; }
    function hideResults() { if (resultsPane) { resultsPane.style.display = 'none'; resultsPane.innerHTML = ''; } }
    function updateRouteInfo(info) {
        if (!routeInfoEl) return;
        if (!info) { routeInfoEl.style.display = 'none'; routeInfoEl.textContent = ''; return; }
        const dist = fmtDist(info.distance || 0);
        const mins = Math.round((info.duration || 0) / 60);
        routeInfoEl.style.display = 'block';
        routeInfoEl.textContent = `Distancia: ${dist} · Tiempo: ${mins} min (a pie)`;
    }

    // Ordenar resultados por cercanía a la vista
    function sortByViewProximity(list) {
        const center = map.getCenter();
        const bounds = map.getBounds();
        // Penalización si está fuera de la vista (≈200 km)
        const OUT_OF_VIEW_PENALTY_M = 200_000;

        return (list || []).slice().sort((a, b) => {
            const la = L.latLng(+a.lat, +a.lon);
            const lb = L.latLng(+b.lat, +b.lon);

            const da = center.distanceTo(la) + (bounds.contains(la) ? 0 : OUT_OF_VIEW_PENALTY_M);
            const db = center.distanceTo(lb) + (bounds.contains(lb) ? 0 : OUT_OF_VIEW_PENALTY_M);
            return da - db;
        });
    }

    // Exponer ruta activa p/ snap del módulo characters
    function setActiveRouteLatLngs(latlngs) {
        window.__ACTIVE_ROUTE_LATLNGS__ = latlngs || [];
        window.getActiveRouteLatLngs = () => window.__ACTIVE_ROUTE_LATLNGS__ || null;
    }

    function ensureRouteLayers() {
        if (!routeLine) {
            routeLine = L.polyline([], {
                color: '#2563eb',
                weight: 5,
                opacity: 0.9,
                lineCap: 'round',
                lineJoin: 'round'
            }).addTo(routeGroup);
        }
    }

    function clearRouteOnly() {
        if (routeLine) routeLine.setLatLngs([]);
        if (routeStartMarker) { routeGroup.removeLayer(routeStartMarker); routeStartMarker = null; }
        setActiveRouteLatLngs([]);
        updateRouteInfo(null);
        _LAST_ARGS_KEY = '';
        _LAST_GEOM_KEY = '';
        // OJO: NO tocamos LAST_DEST ni el searchMarker/popup
    }

    function clearAllSearchAndRoute() {
        // Botón limpiar del buscador: TODO afuera (ruta + marker + destino)
        clearRouteOnly();
        if (searchMarker) { searchGroup.removeLayer(searchMarker); searchMarker = null; }
        LAST_START = null;
        LAST_DEST = null;
    }

    /* ======================== Ruteo (OSRM) ======================== */
    async function routeBetween(A, B) {
        if (!A || !B) return;
        if (window.__CHAR_IS_DRAGGING) return;

        const argsKey = `${A.lat.toFixed(5)},${A.lng.toFixed(5)}|${B.lat.toFixed(5)},${B.lng.toFixed(5)}`;
        if (argsKey === _LAST_ARGS_KEY && routeLine && routeLine.getLatLngs().length) return;
        _LAST_ARGS_KEY = argsKey;

        ensureRouteLayers();

        const url = `https://router.project-osrm.org/route/v1/foot/${A.lng},${A.lat};${B.lng},${B.lat}?overview=full&geometries=geojson`;
        const data = await fetchCached(`osrm:${argsKey}`, async () => {
            try {
                const res = await fetch(url);
                return await res.json();
            } catch (e) { console.warn('[osrm] fetch error', e); return null; }
        });
        if (!data || !data.routes || !data.routes[0]) return;

        const r0 = data.routes[0];
        const coords = r0.geometry.coordinates || [];
        const latlngs = coords.map(([lng, lat]) => L.latLng(lat, lng));

        const geomKey = `${latlngs.length}:${latlngs[0]?.lat?.toFixed(5)},${latlngs[0]?.lng?.toFixed(5)}-${latlngs.at(-1)?.lat?.toFixed(5)},${latlngs.at(-1)?.lng?.toFixed(5)}`;
        if (geomKey === _LAST_GEOM_KEY) return;
        _LAST_GEOM_KEY = geomKey;

        setActiveRouteLatLngs(latlngs);

        scheduleRouteUpdate(() => {
            routeLine.setLatLngs(latlngs);
            if (!routeStartMarker) routeStartMarker = L.circleMarker(A, { radius: 4, weight: 2 }).addTo(routeGroup);
            routeStartMarker.setLatLng(A);
            updateRouteInfo({ distance: r0.distance, duration: r0.duration });
        });
    }

    function safeRouteBetween(fromMaybe, toMaybe) {
        const A = asLL(fromMaybe);
        const B = asLL(toMaybe);
        if (!A || !B) return;
        LAST_START = A;
        LAST_DEST = B;
        routeBetween(A, B);
    }

    /* ======================== Búsqueda (Nominatim) ======================== */
    async function searchNominatim(q, opts = {}) {
        const vv = map.getBounds();
        const viewBox = opts.bounded ? `${vv.getWest()},${vv.getNorth()},${vv.getEast()},${vv.getSouth()}` : '';
        const key = `nom:${lang}|${opts.bounded ? '1' : '0'}|${q}|${viewBox}`;
        return await fetchCached(key, async () => {
            const url = new URL('https://nominatim.openstreetmap.org/search');
            url.searchParams.set('format', 'jsonv2');
            url.searchParams.set('addressdetails', '1');
            url.searchParams.set('accept-language', lang);
            url.searchParams.set('q', q);
            if (opts.bounded) {
                url.searchParams.set('viewbox', viewBox);
                url.searchParams.set('bounded', '1');
            }
            try {
                const res = await fetch(url.toString(), { headers: { 'User-Agent': 'map-client/1.0' } });
                return await res.json();
            } catch (e) { console.warn('[nominatim] error', e); return []; }
        });
    }

    function showSearchMarker(ll, labelHtml) {
        if (!searchMarker) {
            searchMarker = L.circleMarker(ll, {
                radius: 6,
                color: '#1d4ed8',      // borde azul
                weight: 2,
                fill: true,
                fillColor: '#3b82f6',  // azul claro
                fillOpacity: 0.6
            }).addTo(searchGroup);
        } else {
            searchMarker.setLatLng(ll);
        }
        if (labelHtml) {
            // Abrir/actualizar popup
            const popup = L.popup({ offset: [0, -8], autoClose: false, closeOnClick: false, maxWidth: 360 })
                .setLatLng(ll)
                .setContent(labelHtml);
            searchMarker.bindPopup(popup).openPopup();
        }
    }

    function renderResults(list = []) {
        if (!resultsPane) return;

        // Ordenar por cercanía a la vista
        list = sortByViewProximity(list);

        resultsPane.innerHTML = '';
        resultsPane.style.display = 'block';

        const items = list.map(r => {
            const ll = L.latLng(+r.lat, +r.lon);
            const el = document.createElement('div');
            el.className = 'item';
            Object.assign(el.style, {
                padding: '6px 8px', borderBottom: '1px solid #eee', cursor: 'pointer',
                font: '12px/1.3 system-ui,sans-serif'
            });
            const title = r.display_name || r.name || '(sin nombre)';
            el.innerHTML = `<div style="font-weight:600">${title}</div>
                      <div style="color:#6b7280">${ll.lat.toFixed(5)}, ${ll.lng.toFixed(5)}</div>`;
            el.addEventListener('click', () => {
                resultsPane.style.display = 'none';

                // 1) SIEMPRE: marcar el destino + popup y GUARDAR LAST_DEST
                LAST_DEST = ll;
                showSearchMarker(ll, `<div style="font:12px/1.35 system-ui">${title}</div>
                              <div style="color:#6b7280;font:11px/1.3 system-ui">${ll.lat.toFixed(6)}, ${ll.lng.toFixed(6)}</div>`);
                // Ayuda visual
                map.setView(ll, Math.max(14, map.getZoom?.() || 14));

                // 2) Si hay personaje activo: rutar de inmediato
                const active = requireActiveCharacter();
                if (active) {
                    LAST_CHAR_ID = active.id;
                    LAST_START = active.ll;
                    safeRouteBetween(LAST_START, LAST_DEST);
                } else {
                    // Sin PJ: sólo queda marker+popup y LAST_DEST guardado (para rutar más tarde).
                    updateRouteInfo(null);
                }
            });
            return el;
        });

        if (!items.length) {
            const empty = document.createElement('div');
            empty.style.cssText = 'padding:8px;color:#6b7280;font:12px/1.3 system-ui,sans-serif;';
            empty.textContent = 'Sin resultados';
            resultsPane.appendChild(empty);
            return;
        }
        for (const el of items) resultsPane.appendChild(el);
    }

    async function runSearch(qRaw) {
        const q = norm(qRaw);
        if (!q) { hideResults(); return; }

        // "lat,lng" directo => resultado sintético
        const m = LATLNG_RE.exec(q);
        if (m) {
            const lat = +m[1], lng = +m[2];
            if (isFinite(lat) && isFinite(lng)) {
                renderResults([{ lat, lon: lng, display_name: `Coordenadas: ${lat.toFixed(6)}, ${lng.toFixed(6)}` }]);
                return;
            }
        }

        showLoader(true);
        const bounded = !!boundedChk?.checked;
        const prioritizeStreets = !!prioritizeStreetsChk?.checked; // (disponible por si querés tunear el query a futuro)
        const list = await searchNominatim(q, { bounded, prioritizeStreets });
        showLoader(false);

        renderResults(list);
    }

    /* ======================== UI (lupa/panel) ======================== */
    const GeocoderCtl = L.Control.extend({
        options: { position: 'topleft' },
        onAdd() {
            const box = L.DomUtil.create('div', 'leaflet-bar geocoder-box');
            L.DomEvent.disableClickPropagation(box);
            L.DomEvent.disableScrollPropagation(box);

            // Wrapper
            wrapperEl = L.DomUtil.create('div', 'geocoder-wrapper', box);
            wrapperEl.style.cssText = `
        display:flex; align-items:stretch; background:#fff; border-radius:6px;
        overflow:hidden; box-shadow:0 10px 22px rgba(0,0,0,.12);
      `;

            // Botón lupa (toggle del panel)
            toggleBtn = L.DomUtil.create('a', 'geocoder-toggle', wrapperEl);
            toggleBtn.id = 'btn-geo';
            toggleBtn.href = '#'; toggleBtn.title = 'Buscar'; toggleBtn.setAttribute('aria-label', 'Buscar'); toggleBtn.innerHTML = '🔍';
            Object.assign(toggleBtn.style, { display: 'block', width: '28px', minWidth: '28px', height: '28px', lineHeight: '28px', textAlign: 'center', borderRight: '1px solid #e5e7eb' });
            toggleBtn.onclick = (e) => { e.preventDefault(); toggleTool('geocoder', { manual: true }); };

            // Panel
            panelEl = L.DomUtil.create('div', 'geocoder-panel', wrapperEl);
            panelEl.style.cssText = `display:none; min-width:260px; max-width:340px; background:#fff;`;

            // Row input
            const row = L.DomUtil.create('div', 'geocoder-row', panelEl);
            row.style.cssText = 'display:flex; align-items:center; gap:6px; padding:6px 6px 4px 6px;';

            inputEl = L.DomUtil.create('input', 'geocoder-input', row);
            inputEl.type = 'text'; inputEl.placeholder = 'Buscar…';
            inputEl.autocomplete = 'off'; inputEl.spellcheck = false;
            Object.assign(inputEl.style, { flex: 'none', width: '160px', border: '1px solid #e5e7eb', borderRadius: '6px', padding: '4px 18px 4px 6px', font: '11px/1 system-ui, sans-serif', outline: 'none' });

            // Loader
            loaderEl = L.DomUtil.create('div', 'geocoder-loader', row);
            loaderEl.style.cssText = `
        display:none; width:12px; height:12px; margin-left:-18px;
        border:2px solid rgba(0,0,0,.25); border-top-color:#111; border-radius:50%;
        animation:geo-spin .9s linear infinite;
      `;

            const clearBtn = L.DomUtil.create('a', 'geocoder-clear', row);
            clearBtn.href = '#'; clearBtn.title = 'Limpiar'; clearBtn.textContent = '×';
            Object.assign(clearBtn.style, { width: '20px', height: '20px', lineHeight: '20px', textAlign: 'center', borderRadius: '6px', color: '#111' });

            const closeBtn = L.DomUtil.create('a', 'geocoder-close', row);
            closeBtn.href = '#'; closeBtn.title = 'Cerrar'; closeBtn.textContent = '✕';
            Object.assign(closeBtn.style, { width: '20px', height: '20px', lineHeight: '20px', textAlign: 'center', borderRadius: '6px', color: '#111' });

            // Opciones compactas
            const opts = L.DomUtil.create('div', '', panelEl);
            opts.style.cssText = 'display:flex; gap:10px; align-items:center; padding:0 6px 6px 6px; font:11px/1 system-ui,sans-serif; flex-wrap:wrap;';

            const opt1 = L.DomUtil.create('label', 'geocoder-bounded', opts);
            boundedChk = L.DomUtil.create('input', '', opt1); boundedChk.type = 'checkbox'; boundedChk.checked = false;
            opt1.appendChild(document.createTextNode(' Vista actual'));

            const opt2 = L.DomUtil.create('label', 'geocoder-prioritize-streets', opts);
            prioritizeStreetsChk = L.DomUtil.create('input', '', opt2); prioritizeStreetsChk.type = 'checkbox'; prioritizeStreetsChk.checked = false;
            opt2.appendChild(document.createTextNode(' Calles/dir.'));

            // Selector personaje
            const charWrap = L.DomUtil.create('label', '', opts);
            charWrap.textContent = ' Personaje: ';
            characterSel = document.createElement('select');
            characterSel.style.marginLeft = '4px';
            characterSel.style.font = '11px/1 system-ui,sans-serif';
            charWrap.appendChild(characterSel);
            refreshCharacterSelect();

            // Resultados
            resultsPane = L.DomUtil.create('div', 'geocoder-results', panelEl);
            resultsPane.style.cssText = `display:none; border-top:1px solid #e5e7eb; max-height:260px; overflow:auto;`;
            resultsPane.setAttribute('role', 'listbox');

            // Info ruta
            routeInfoEl = L.DomUtil.create('div', 'geocoder-routeinfo', panelEl);
            routeInfoEl.style.cssText = 'display:none; padding:6px; font:11px/1.2 system-ui,sans-serif; border-top:1px solid #e5e7eb;';

            // Mostrar/ocultar (bus)
            const togglePanel = (open) => {
                panelEl.style.display = open ? 'block' : 'none';
                const mapContainer = map.getContainer();
                if (open) {
                    const pad = (panelEl.offsetWidth || 260) + 6;
                    mapContainer.style.paddingLeft = pad + 'px';
                    setTimeout(() => { map.invalidateSize(); inputEl?.focus(); }, 0);
                } else {
                    mapContainer.style.paddingLeft = '';
                    setTimeout(() => map.invalidateSize(), 0);
                    hideResults(); updateRouteInfo(null);
                }
            };
            const hidePanelLocal = () => togglePanel(false);
            const showPanelLocal = () => togglePanel(true);
            __openPanel = showPanelLocal;
            __closePanel = hidePanelLocal;
            __isOpen = () => panelEl?.style.display !== 'none';

            // Eventos UI
            clearBtn.onclick = (e) => {
                e.preventDefault();
                inputEl.value = '';
                hideResults();
                updateRouteInfo(null);
                clearAllSearchAndRoute(); // << limpia todo
                inputEl.focus();
            };
            closeBtn.onclick = (e) => { e.preventDefault(); toggleTool('geocoder', { manual: true }); };

            inputEl.addEventListener('input', () => {
                clearTimeout(typeTimer);
                const val = inputEl.value.trim();
                if (!val) { hideResults(); return; }
                typeTimer = setTimeout(() => runSearch(val), TYPE_DELAY_MS);
            });
            inputEl.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') { e.preventDefault(); runSearch(inputEl.value.trim()); }
                if (e.key === 'Escape') { e.preventDefault(); toggleTool('geocoder', { manual: true }); }
            });

            // Cambio de personaje
            characterSel.addEventListener('change', () => {
                LAST_CHAR_ID = characterSel.value || '';
                const active = requireActiveCharacter();

                if (active && LAST_DEST) {
                    LAST_START = active.ll;
                    safeRouteBetween(LAST_START, LAST_DEST);  // << ruteo automático al elegir personaje
                } else if (!active) {
                    // Elegiste "— Personaje —": borrar SOLO ruteo, dejar popup/marker y conservar LAST_DEST
                    clearRouteOnly();
                }
            });

            // CSS anim loader
            const cssId = 'geo-spin-css';
            if (!document.getElementById(cssId)) {
                const s = document.createElement('style');
                s.id = cssId; s.textContent = `@keyframes geo-spin { from{transform:rotate(0deg)} to{transform:rotate(360deg)} }`;
                document.head.appendChild(s);
            }

            return box;
        }
    });

    map.addControl(new GeocoderCtl());

    /* ======================== toolsBus ======================== */
    try {
        registerTool('geocoder', {
            sticky: true,
            enable: () => __openPanel(),
            disable: () => __closePanel(),
            isActive: () => __isOpen(),
            buttons: ['#btn-geo']
        });
    } catch (e) { console.warn('[geocoder] registerTool error', e); }

    /* ======================== Hook desde characters.js ======================== */
    window.onCharacterMoved = ({ id, lat, lng }) => {
        if (window.__CHAR_IS_DRAGGING) return; // no recalcular en drag

        const active = requireActiveCharacter();
        if (!active || id !== active.id) return;

        // Llegó al destino -> borrar SOLO ruteo y limpiar LAST_DEST; mantener popup/marker
        if (LAST_DEST && isArrived({ lat, lng }, LAST_DEST, ARRIVAL_EPS_M)) {
            clearRouteOnly();
            LAST_DEST = null; // evita re-ruteos automáticos posteriores
            return;
        }
        if (!LAST_DEST) return;

        clearTimeout(_moveTimer);
        _moveTimer = setTimeout(() => {
            routeBetween(L.latLng(lat, lng), LAST_DEST);
        }, MOVE_DEBOUNCE_MS);
    };

    /* ======================== NO clicks en el mapa ======================== */
    // intencionalmente no registramos map.on('click')

    /* ======================== Helpers expuestos ======================== */
    window.clearGeocoderRoute = clearRouteOnly;
    window.safeRouteBetween = safeRouteBetween;
}
