// modules/geocoder.js
import { map } from './Map.js';

/**
 * Geocoder + ruteo:
 * - Búsqueda Nominatim (dirección o lat,lng).
 * - Ordena por cercanía al centro del mapa.
 * - Selector de personaje (inyectado desde characters.js).
 * - Ruta con OSRM (solo km).
 * - Expone ruta activa para snap manual desde characters.js:
 *     window.__ACTIVE_ROUTE_LATLNGS__ = [{lat,lng}, ...]
 *     window.getActiveRouteLatLngs = () => window.__ACTIVE_ROUTE_LATLNGS__ || null
 * - Recalcula al mover personaje (onCharacterMoved) con reintentos si estaba arrastrando.
 */

if (!window.__GEOCODER_INITED__) {
    window.__GEOCODER_INITED__ = true;

    /* ========================
       Estado / utilidades
    ========================= */
    const PREFERS_REDUCED = matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const lang = (navigator.language || 'es').split('-')[0] || 'es';
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const ARRIVAL_EPS_M = 20;
    const MOVE_DEBOUNCE_MS = 90;

    const searchGroup = L.layerGroup().addTo(map);
    const routeGroup = L.layerGroup().addTo(map);

    let resultsPane = null;
    let loaderEl = null;
    let inputEl = null;
    let boundedChk = null;
    let prioritizeStreetsChk = null;
    let panelEl = null;
    let wrapperEl = null;
    let characterSel = null;
    let routeInfoEl = null;

    let inFlight = null;
    let lastTs = 0;
    const MIN_GAP_MS_Q = 650;
    const MIN_GAP_MS_ST = 900;
    const CACHE = new Map();
    let typeTimer = null;

    // Cache persistente
    const LS_KEY = 'geo_cache_v1';
    const TTL_MS = 24 * 60 * 60 * 1000;
    const readLS = () => { try { return JSON.parse(localStorage.getItem(LS_KEY) || '{}'); } catch { return {}; } };
    const writeLS = (obj) => localStorage.setItem(LS_KEY, JSON.stringify(obj));
    const fetchCached = async (key, fetcher) => {
        const obj = readLS(); const hit = obj[key];
        if (hit && (Date.now() - hit.t) < TTL_MS) return hit.v;
        const v = await fetcher(); obj[key] = { v, t: Date.now() }; writeLS(obj); return v;
    };

    // Último ruteo
    let LAST_START = null; // L.LatLng
    let LAST_DEST = null; // L.LatLng
    let LAST_CHAR_ID = ''; // id

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
        }
    }
    // API pública para inyectar personajes
    window.setGeocoderCharacters = (arr) => {
        CHARACTERS = Array.isArray(arr) ? arr.slice() : [];
        refreshCharacterSelect();
    };

    /* ========================
       Helpers
    ========================= */
    const STREET_HINT_RE = new RegExp(
        String.raw`(^|\s)(calle|c/|av\.?|avenida|ruta|rd\.?|road|rua|rúa|rue|strada|st\.?|street|ave\.?|aven|bv\.?|bvd\.?|boulevard|boulevar|via|allee|avenue|straße|strasse|ulica)\b|(\d{1,6}\s+[a-záéíóúüñ.'-]{3,})|([a-záéíóúüñ.'-]{3,}\s+\d{1,6}\b)`,
        'i'
    );
    const LATLNG_RE = /^\s*(-?\d{1,3}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)\s*$/;

    const deburr = (s) => s.normalize?.('NFD').replace?.(/[\u0300-\u036f]/g, '') || s;
    const norm = (s) => deburr(String(s || '')).replace(/\s+/g, ' ').trim();
    const looksLikeStreet = (q) => STREET_HINT_RE.test(q);
    const fmtDist = (m) => (m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(2)} km`);

    function isArrived(aLL, bLL, eps = ARRIVAL_EPS_M) {
        try { const d = L.latLng(aLL).distanceTo(L.latLng(bLL)); return isFinite(d) && d <= eps; }
        catch { return false; }
    }

    function parseAddress(qRaw) {
        const q = norm(qRaw);
        const parts = q.split(',').map(s => s.trim()).filter(Boolean);
        const main = parts[0] || '';
        const m1 = /^(\d{1,6})\s+(.{3,})$/i.exec(main);
        const m2 = /^(.{3,}?)\s+(\d{1,6})$/i.exec(main);
        let streetLine = null;
        if (m1) streetLine = `${m1[1]} ${m1[2]}`.trim();
        else if (m2) streetLine = `${m2[2]} ${m2[1]}`.trim();
        let city = null, postalcode = null, extra = parts.slice(1).join(', ');
        if (parts[1]) { if (/^\d{3,10}$/.test(parts[1])) postalcode = parts[1]; else city = parts[1]; }
        if (parts[2]) { if (/^\d{3,10}$/.test(parts[2])) postalcode = parts[2]; else if (!city) city = parts[2]; }
        return { streetLine, city, postalcode, extra };
    }

    // Normalizador a L.LatLng (tolerante)
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
    function safeRouteBetween(fromMaybe, toMaybe, opts = {}) {
        const A = asLL(fromMaybe);
        const B = asLL(toMaybe);
        if (!A || !B) {
            // silencio total si faltan coords (no queremos spam en consola)
            return;
        }
        return routeBetween(A, B, opts);



    }


    function getRouteEndLatLng() {
        // prioriza el último punto de la polilínea activa
        if (Array.isArray(window.__ACTIVE_ROUTE_LATLNGS__) && window.__ACTIVE_ROUTE_LATLNGS__.length) {
            const last = window.__ACTIVE_ROUTE_LATLNGS__[window.__ACTIVE_ROUTE_LATLNGS__.length - 1];
            return asLL(last);
        }
        // si no hay polyline, usa el destino lógico
        return asLL(LAST_DEST);
    }

    function maybeClearRouteOnArrival(currentLL) {
        const cur = asLL(currentLL);
        const end = getRouteEndLatLng();
        if (!cur || !end) return false;
        if (isArrived(cur, end)) {  // usa ARRIVAL_EPS_M (=20m) de tu archivo
            clearRouteAll();
            return true;
        }
        return false;
    }


    /* ========================
       UI (control compacto)
    ========================= */
    const GeocoderCtl = L.Control.extend({
        options: { position: 'topleft' },
        onAdd() {
            const box = L.DomUtil.create('div', 'leaflet-bar geocoder-box');
            L.DomEvent.disableClickPropagation(box);
            L.DomEvent.disableScrollPropagation(box);

            wrapperEl = L.DomUtil.create('div', 'geocoder-wrapper', box);
            wrapperEl.style.cssText = `
        display:flex; align-items:stretch; background:#fff; border-radius:6px;
        overflow:hidden; box-shadow:0 10px 22px rgba(0,0,0,.12);
      `;

            // Toggle
            const toggle = L.DomUtil.create('a', 'geocoder-toggle', wrapperEl);
            toggle.href = '#'; toggle.title = 'Buscar'; toggle.setAttribute('aria-label', 'Buscar'); toggle.innerHTML = '🔍';
            Object.assign(toggle.style, { display: 'block', width: '28px', minWidth: '28px', height: '28px', lineHeight: '28px', textAlign: 'center', borderRight: '1px solid #e5e7eb' });

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

            // Eventos UI
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
                    hideResults(); hideRouteInfo();
                }
            };
            const hidePanel = () => togglePanel(false);
            const showPanel = () => togglePanel(true);

            toggle.onclick = (e) => { e.preventDefault(); const open = panelEl.style.display !== 'none'; open ? hidePanel() : showPanel(); };
            clearBtn.onclick = (e) => { e.preventDefault(); inputEl.value = ''; hideResults(); clearRouteAll(); inputEl.focus(); };
            closeBtn.onclick = (e) => { e.preventDefault(); hidePanel(); };

            // Navegación teclado
            let selIdx = -1;
            function setActive(idx) {
                const items = [...resultsPane.querySelectorAll('.item')];
                if (!items.length) return;
                items.forEach(i => { i.classList.remove('active'); i.setAttribute('aria-selected', 'false'); });
                if (idx >= 0 && idx < items.length) {
                    items[idx].classList.add('active');
                    items[idx].setAttribute('aria-selected', 'true');
                    items[idx].scrollIntoView({ block: 'nearest' });
                    selIdx = idx;
                }
            }

            inputEl.addEventListener('keydown', async (e) => {
                const q = inputEl.value.trim();
                if (e.key === 'Enter') {
                    const items = [...resultsPane.querySelectorAll('.item')];
                    if (selIdx >= 0 && items[selIdx]) { e.preventDefault(); items[selIdx].click(); return; }
                    if (!q) return;
                    e.preventDefault();
                    await runSearch(q, { forceList: true });
                }
                if (e.key === 'Escape') hidePanel();
                if (e.key === 'ArrowDown') { e.preventDefault(); const items = [...resultsPane.querySelectorAll('.item')]; if (items.length) setActive(Math.min(selIdx + 1, items.length - 1)); }
                if (e.key === 'ArrowUp') { e.preventDefault(); const items = [...resultsPane.querySelectorAll('.item')]; if (items.length) setActive(Math.max(selIdx - 1, 0)); }
            });

            inputEl.addEventListener('input', () => {
                const q = inputEl.value.trim();
                if (!q) { hideResults(); return; }
                if (typeTimer) clearTimeout(typeTimer);
                typeTimer = setTimeout(() => runSearch(q, { forceList: true }).then(() => { selIdx = -1; }), 420);
            });

            boundedChk.addEventListener('change', () => {
                const q = inputEl.value.trim(); if (q) runSearch(q, { forceList: true });
            });
            prioritizeStreetsChk.addEventListener('change', () => {
                const q = inputEl.value.trim();
                inputEl.placeholder = prioritizeStreetsChk.checked
                    ? 'Calle o dirección…'
                    : 'Buscar… (ej: Av. Libertador 2000, CABA · 1600 Amphitheatre Pkwy, CA)';
                if (q) runSearch(q, { forceList: true });
            });

            characterSel.addEventListener('change', async () => {
                const selId = characterSel?.value || '';
                LAST_CHAR_ID = selId;
                const ch = CHARACTERS.find(c => c.id === selId);
                if (ch && LAST_DEST) {
                    LAST_START = asLL({ lat: ch.lat, lng: ch.lng });
                    if (!LAST_START) { clearRouteAll(); return; }
                    if (isArrived(LAST_START, LAST_DEST)) { clearRouteAll(); return; }
                    await safeRouteBetween(LAST_START, LAST_DEST, { noFit: false });
                } else {
                    clearRouteAll();
                }
            });

            return box;
        }
    });
    map.addControl(new GeocoderCtl());

    // CSS
    (function injectCss() {
        const id = 'geocoder-css'; if (document.getElementById(id)) return;
        const st = document.createElement('style'); st.id = id;
        st.textContent = `
      @keyframes geo-spin { to { transform: rotate(360deg) } }
      .geocoder-box { background:#fff; border-radius:6px; }
      .geocoder-toggle:hover { background:#f1f5f9; }
      .geocoder-results .item { padding:6px 8px; cursor:pointer; font:11px/1.15 system-ui,sans-serif; display:flex; justify-content:space-between; gap:8px; }
      .geocoder-results .item:hover, .geocoder-results .item.active { background:#eef2f7; }
      .geocoder-results .name { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      .geocoder-results .dist { opacity:.7; white-space:nowrap; }
      .geo-poly { stroke:#111; stroke-width:1.5; fill:#3b82f6; fill-opacity:.08; }
      .geo-poly.hover { stroke:#0f172a; fill-opacity:.16; }
      .geo-line { stroke:#1f2937; stroke-width:3; fill:none; }
      .geo-line.hover { stroke-width:4; }
      .geo-route { stroke:#2563eb; stroke-width:4; fill:none; }
    `;
        document.head.appendChild(st);
    })();

    /* ========================
       Helpers UI
    ========================= */
    function hideResults() { if (!resultsPane) return; resultsPane.style.display = 'none'; resultsPane.innerHTML = ''; }
    function showResults(items) { resultsPane.style.display = 'block'; resultsPane.innerHTML = ''; items.forEach(el => resultsPane.appendChild(el)); }
    function showRouteInfo(text) { routeInfoEl.style.display = 'block'; routeInfoEl.textContent = text; }
    function hideRouteInfo() { routeInfoEl.style.display = 'none'; routeInfoEl.textContent = ''; }

    function currentViewBoxParam() {
        const b = map.getBounds(); const sw = b.getSouthWest(), ne = b.getNorthEast();
        return `${sw.lng},${ne.lat},${ne.lng},${sw.lat}`;
    }
    function qKey(q, bounded) {
        const streetsOnly = !!prioritizeStreetsChk?.checked;
        return bounded ? `${q}@@bounded:${map.getCenter().toString()}@${map.getZoom()}@streets:${streetsOnly}` : `${q}@streets:${streetsOnly}`;
    }

    /* ========================
       Nominatim + Reverse
    ========================= */
    function baseParams({ limit = 50 } = {}) {
        const p = new URLSearchParams({
            format: 'geojson', polygon_geojson: '1', addressdetails: '1',
            namedetails: '0', extratags: '0', limit: String(limit)
        });
        return p;
    }
    async function fetchWithRetry(url, fetchOpts, { tries = 2 } = {}) {
        let attempt = 0, lastErr;
        while (attempt <= tries) {
            try {
                const res = await fetch(url, fetchOpts);
                if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                return await res.json();
            } catch (e) {
                lastErr = e;
                if (attempt === tries) break;
                await sleep(400 * Math.pow(2, attempt));
                attempt++;
            }
        }
        throw lastErr;
    }
    async function fetchNominatimOnce(params, { signal } = {}) {
        const url = `https://nominatim.openstreetmap.org/search?${params.toString()}`;
        const key = `S:${params.toString()}`;
        const fetcher = () => fetchWithRetry(url, {
            method: 'GET',
            headers: { 'Accept-Language': `${lang},es;q=0.9,en;q=0.7`, 'User-Agent': 'LeafletGeocoder/1.8 (+contact)' },
            signal, mode: 'cors'
        });
        return await fetchCached(key, async () => {
            const data = await fetcher(); CACHE.set(key, data); return data;
        });
    }
    async function reverseNominatim(lat, lon, { signal } = {}) {
        const p = new URLSearchParams({ format: 'geojson', polygon_geojson: '0', addressdetails: '1', zoom: '18', lat: String(lat), lon: String(lon) });
        const url = `https://nominatim.openstreetmap.org/reverse?${p.toString()}`;
        return await fetchWithRetry(url, {
            method: 'GET',
            headers: { 'Accept-Language': `${lang},es;q=0.9,en;q=0.7`, 'User-Agent': 'LeafletGeocoder/1.8 (+contact)' },
            signal, mode: 'cors'
        });
    }
    function isStreetFeature(f) {
        const gt = f.geometry?.type;
        const cat = f.properties?.category || f.properties?.class;
        const typ = f.properties?.type;
        return cat === 'highway' || gt === 'LineString' || gt === 'MultiLineString' ||
            ['residential', 'primary', 'secondary', 'tertiary', 'service', 'unclassified', 'living_street', 'trunk', 'motorway'].includes(typ);
    }
    function isAddressPoint(f) {
        const gt = f.geometry?.type;
        const cls = f.properties?.class || f.properties?.category;
        const typ = f.properties?.type || '';
        const addrt = f.properties?.addresstype || '';
        return (gt === 'Point') && (
            cls === 'place' || cls === 'building' || cls === 'highway' ||
            ['house', 'residential', 'yes', 'address', 'entrance'].includes(typ) ||
            ['house', 'building', 'road'].includes(addrt)
        );
    }
    async function withTimeout(promise, ms) {
        let to;
        try {
            return await Promise.race([promise, new Promise((_, rej) => { to = setTimeout(() => rej(new Error('timeout')), ms); })]);
        } finally { clearTimeout(to); }
    }

    async function fetchNominatimVariants(qRaw, { bounded = false, signal } = {}) {
        const q = norm(qRaw);
        const tries = [];
        const wantStreet = looksLikeStreet(q) || !!prioritizeStreetsChk?.checked;

        // Reverse lat,lng
        const latlng = LATLNG_RE.exec(q);
        if (latlng) {
            const lat = parseFloat(latlng[1]), lon = parseFloat(latlng[2]);
            const rev = await withTimeout(reverseNominatim(lat, lon, { signal }), 12000).catch(() => null);
            if (rev) {
                const feat = (rev.features && rev.features[0]) || null;
                if (feat) return { type: 'FeatureCollection', features: [feat] };
            }
        }

        const { streetLine, city, postalcode, extra } = parseAddress(q);
        const MIN_GAP_MS = streetLine || wantStreet ? MIN_GAP_MS_ST : MIN_GAP_MS_Q;

        // 0) Dirección con numeración
        if (streetLine) {
            const regions = [
                '', 'ar,uy,cl,bo,pe,py,br,co,ve,mx',
                'es,pt,fr,it,de,at,ch,nl,be,pl,cz,sk,hu,ro,bg,gr',
                'se,no,fi,dk,ie,gb', 'us,ca'
            ];
            for (const cc of regions) {
                const p = baseParams({ limit: 80 });
                p.set('street', streetLine);
                if (city) p.set('city', city);
                if (postalcode) p.set('postalcode', postalcode);
                if (cc) p.set('countrycodes', cc);
                if (bounded && !cc) { p.set('viewbox', currentViewBoxParam()); p.set('bounded', '1'); }
                tries.push(p);
            }
            if (extra) {
                const pE = baseParams({ limit: 60 });
                pE.set('street', streetLine); pE.set('q', extra);
                tries.push(pE);
            }
            await sleep(MIN_GAP_MS);
        }

        // 1) Global tal cual
        {
            const p = baseParams({ limit: 70 });
            p.set('q', q);
            if (bounded) { p.set('viewbox', currentViewBoxParam()); p.set('bounded', '1'); }
            tries.push(p);
        }
        // 2) Admins/postcode
        for (const k of ['state', 'county', 'city', 'town', 'village', 'postcode']) {
            const p = baseParams({ limit: 50 }); p.set(k, q); tries.push(p);
        }
        // 3) Solo calle si no hay número
        if (wantStreet && !streetLine) {
            const regions2 = ['', 'ar,uy,cl,bo,pe,py,br,co,ve,mx', 'es,pt,fr,it,de,at,ch,nl,be,pl,cz,sk,hu,ro,bg,gr', 'se,no,fi,dk,ie,gb', 'us,ca'];
            for (const cc of regions2) {
                const p = baseParams({ limit: 80 });
                p.set('street', q);
                if (cc) p.set('countrycodes', cc);
                if (bounded && !cc) { p.set('viewbox', currentViewBoxParam()); p.set('bounded', '1'); }
                tries.push(p);
            }
        }
        // 4) sufijos
        const suffixes = [
            ' argentina', ' uruguay', ' chile', ' bolivia', ' peru', ' paraguay', ' brasil', ' colombia', ' venezuela', ' mexico',
            ' españa', ' portugal', ' francia', ' italia', ' alemania', ' austria', ' suiza', ' belgica', ' paises bajos', ' holanda',
            ' suecia', ' noruega', ' finlandia', ' dinamarca', ' irlanda', ' reino unido', ' uk', ' united states', ' usa', ' canada',
            ' california', ' new york', ' texas', ' florida', ' washington'
        ];
        suffixes.forEach(suf => {
            const p = baseParams({ limit: 50 }); p.set('q', q + suf); tries.push(p);
        });

        for (const params of tries) {
            const data = await withTimeout(fetchNominatimOnce(params, { signal }), 12000).catch(() => null);
            if (data?.features?.length) {
                if (streetLine || wantStreet) {
                    data.features.sort((a, b) => {
                        const aw = (streetLine ? +isAddressPoint(a) : +isStreetFeature(a));
                        const bw = (streetLine ? +isAddressPoint(b) : +isStreetFeature(b));
                        return bw - aw;
                    });
                }
                return data;
            }
            await sleep(120);
        }
        return { type: 'FeatureCollection', features: [] };
    }

    async function fetchNominatim(q, { bounded = false, signal } = {}) {
        const key = qKey(q, bounded);
        const cached = CACHE.get(key);
        if (cached) return cached;
        const data = await fetchNominatimVariants(q, { bounded, signal });
        CACHE.set(key, data); return data;
    }

    /* ========================
       Distancia/centroid
    ========================= */
    function centroidLatLngOfFeature(feature) {
        try {
            if (feature.geometry?.type === 'Point') {
                const [lng, lat] = feature.geometry.coordinates || [];
                if (isFinite(lat) && isFinite(lng)) return L.latLng(lat, lng);
            }
            const b = L.geoJSON(feature.geometry).getBounds();
            if (b.isValid()) return b.getCenter();
        } catch { }
        return map.getCenter();
    }

    /* ========================
       Render resultados
    ========================= */
    function layerForFeature(feature) {
        const geomType = feature.geometry?.type;
        const isLine = geomType === 'LineString' || geomType === 'MultiLineString';
        const style = isLine
            ? { className: 'geo-line', color: '#1f2937', weight: 3, fill: false }
            : { className: 'geo-poly', color: '#111', weight: 1.5, fill: false };

        const gj = L.geoJSON(feature.geometry, { style: () => style });
        gj.on('mouseover', () => {
            if (isLine) gj.setStyle({ weight: 4, className: 'geo-line hover' });
            else gj.setStyle({ weight: 2, className: 'geo-poly hover' });
        });
        gj.on('mouseout', () => {
            if (isLine) gj.setStyle({ weight: 3, className: 'geo-line' });
            else gj.setStyle({ weight: 1.5, className: 'geo-poly' });
        });
        return gj;
    }

    function goToBounds(bounds) {
        if (!bounds || !bounds.isValid()) return;
        const pad = { paddingTopLeft: [12, 12], paddingBottomRight: [12, 12], animate: !PREFERS_REDUCED };
        map.fitBounds(bounds, pad);
    }

    async function renderFeature(feature, { fly = false } = {}) {
        searchGroup.clearLayers();

        const geomType = feature.geometry?.type;
        if (geomType && geomType !== 'Point') {
            const layer = layerForFeature(feature).addTo(searchGroup);
            const b = layer.getBounds();
            if (fly && map.flyToBounds) map.flyToBounds(b, { animate: !PREFERS_REDUCED, padding: [20, 20] });
            else goToBounds(b);
            layer.on('click', () => goToBounds(layer.getBounds()));
        } else {
            const c = centroidLatLngOfFeature(feature);
            const title = feature.properties?.display_name || 'Resultado';
            const marker = L.circleMarker(c, { radius: 6, color: '#111', fillColor: '#3b82f6', fillOpacity: .9, weight: 1.5 })
                .addTo(searchGroup)
                .bindPopup(title, { autoClose: true, closeOnClick: true });
            if (fly && map.flyTo) map.flyTo(c, Math.max(map.getZoom(), 17), { animate: !PREFERS_REDUCED });
            else map.setView(c, Math.max(map.getZoom(), 17), { animate: !PREFERS_REDUCED });
            marker.openPopup();
        }
    }

    /* ========================
       Ruta activa (para snap manual en characters.js)
    ========================= */
    window.getActiveRouteLatLngs = () => window.__ACTIVE_ROUTE_LATLNGS__ || null;
    function setActiveRoute(latlngs) {
        window.__ACTIVE_ROUTE_LATLNGS__ = (latlngs || []).map(ll => ({ lat: ll.lat, lng: ll.lng }));
    }
    function clearActiveRoute() {
        window.__ACTIVE_ROUTE_LATLNGS__ = null;
    }

    function clearRouteAll() {
        routeGroup.clearLayers();
        hideRouteInfo();
        clearActiveRoute();
        LAST_START = null;
        LAST_DEST = null;
    }
    // APIs públicas convenientes
    window.clearRoute = clearRouteAll;
    window.setActiveCharacter = (id) => {
        if (!characterSel) return;
        characterSel.value = id || '';
        const ch = CHARACTERS.find(c => c.id === id);
        LAST_CHAR_ID = ch ? id : '';
    };

    /* ========================
       OSRM (solo km, driving) — VALIDADO
    ========================= */
    async function routeBetween(fromLL, toLL, { noFit = false } = {}) {
        const A = asLL(fromLL);
        const B = asLL(toLL);
        if (!A || !B) {
            console.warn('[routing] from/to inválidos', fromLL, toLL);
            clearRouteAll();
            return;
        }
        if (isArrived(A, B)) { clearRouteAll(); return; }

        routeGroup.clearLayers();
        hideRouteInfo();
        clearActiveRoute();

        const coords = `${A.lng},${A.lat};${B.lng},${B.lat}`;
        const url = `https://router.project-osrm.org/route/v1/driving/${coords}?overview=full&geometries=geojson&alternatives=false&steps=false`;

        let data;
        try {
            data = await fetchWithRetry(url, { mode: 'cors' }, { tries: 2 });
            if (!data?.routes?.length) throw new Error('Sin rutas');
        } catch (e) {
            console.error('[routing]', e);
            showRouteInfo('No se pudo calcular una ruta.');
            return;
        }

        const r = data.routes[0];
        const layer = L.geoJSON(r.geometry, { style: { className: 'geo-route', color: '#2563eb', weight: 4 }, interactive: false })
            .addTo(routeGroup);

        const b = layer.getBounds();
        if (!noFit && b?.isValid()) map.fitBounds(b, { padding: [24, 24], animate: !PREFERS_REDUCED });

        // Guardar latlngs para snap manual
        let latlngs = [];
        const gLayers = layer.getLayers?.() || [];
        latlngs = gLayers.length ? gLayers[0].getLatLngs() : (layer.getLatLngs?.() || []);
        latlngs = Array.isArray(latlngs[0]) ? latlngs.flat() : latlngs;
        setActiveRoute(latlngs);
        maybeClearRouteOnArrival(A);

        const km = (r.distance / 1000).toFixed(2);
        showRouteInfo(`${km} km`);
    }

    /* ========================
       Anti-bloqueo de ruteo mientras se arrastra
    ========================= */
    window.__CHAR_IS_DRAGGING = window.__CHAR_IS_DRAGGING || false;
    let rerouteTimer = null;
    let lastMoveTs = 0;

    // Notificado por characters.js en cada movimiento (throttled) y al soltar
    window.onCharacterMoved = ({ id, lat, lng }) => {
        if (!LAST_DEST) return;
        if (!isFinite(lat) || !isFinite(lng)) return;

        const selId = characterSel?.value || '';
        if (selId && selId !== id) return;
        if (!selId && id && CHARACTERS.find(c => c.id === id)) {
            characterSel.value = id;
            LAST_CHAR_ID = id;
        }

        const start = asLL({ lat, lng });
        if (maybeClearRouteOnArrival(start)) return;

        LAST_START = start;

        if (isArrived(LAST_START, dest)) { clearRouteAll(); return; }

        // Si está arrastrando, programar reintento suave cuando suelte
        if (!window.__CHAR_IS_DRAGGING && !maybeClearRouteOnArrival(LAST_START)) {
            const end = getRouteEndLatLng();
            if (end) safeRouteBetween(LAST_START, end, { noFit: true });
        }

        // Debounce para no saturar OSRM
        const now = Date.now();
        if (now - lastMoveTs < MOVE_DEBOUNCE_MS) return;
        lastMoveTs = now;
        const end = getRouteEndLatLng();
        if (!maybeClearRouteOnArrival(LAST_START) && end) {
            safeRouteBetween(LAST_START, end, { noFit: true });
        }
    };

    /* ========================
       Búsqueda (lista + render del más cercano)
    ========================= */
    function showLoader(v) { if (!loaderEl) return; loaderEl.style.display = v ? 'inline-block' : 'none'; }

    async function runSearch(qRaw, { forceList = false } = {}) {
        const q = qRaw.trim();
        const now = Date.now();
        const delta = now - lastTs;
        const wantStreet = looksLikeStreet(q) || !!prioritizeStreetsChk?.checked;
        const MIN_GAP_MS = wantStreet ? MIN_GAP_MS_ST : MIN_GAP_MS_Q;
        if (delta < MIN_GAP_MS) await sleep(MIN_GAP_MS - delta);
        lastTs = Date.now();

        try { inFlight?.abort(); } catch { }
        inFlight = new AbortController();
        const thisSignal = inFlight.signal;

        showLoader(true);
        try {
            const bounded = !!boundedChk?.checked && map.getZoom?.() >= 10;
            const data = await withTimeout(fetchNominatim(q, { bounded, signal: thisSignal }), 18000);
            let feats = data?.features || [];

            if (wantStreet) {
                feats.sort((a, b) => (+isStreetFeature(b) + +isAddressPoint(b)) - (+isStreetFeature(a) + +isAddressPoint(a)));
                feats = feats.filter(f => isStreetFeature(f) || isAddressPoint(f));
            }

            if (!feats.length) {
                showResults([makeInfoItem('No se encontraron resultados')]);
                searchGroup.clearLayers();
                clearRouteAll();
                return;
            }

            // Ordenar por distancia al centro
            const enriched = feats.map((f, idx) => {
                const ll = centroidLatLngOfFeature(f);
                const dist = map.getCenter().distanceTo(ll);
                return { f, dist, idx };
            }).sort((a, b) => a.dist - b.dist);

            // Listado (hasta 20)
            const SHOW_MAX = Math.min(20, enriched.length);
            const elems = [];
            for (let i = 0; i < SHOW_MAX; i++) {
                const { f, dist } = enriched[i];
                const name = f.properties?.display_name || f.properties?.name || q;
                const item = document.createElement('div');
                item.className = 'item';
                item.setAttribute('role', 'option');
                const nameEl = document.createElement('span'); nameEl.className = 'name'; nameEl.textContent = name;
                const distEl = document.createElement('span'); distEl.className = 'dist'; distEl.textContent = fmtDist(dist);
                item.appendChild(nameEl); item.appendChild(distEl);
                item.title = name;
                item.onclick = async () => {
                    await renderFeature(f, { fly: !PREFERS_REDUCED });

                    const selId = characterSel?.value || '';
                    LAST_CHAR_ID = selId;
                    const ch = CHARACTERS.find(c => c.id === selId);
                    if (ch) {
                        const start = asLL({ lat: ch.lat, lng: ch.lng });
                        const dest = asLL(centroidLatLngOfFeature(f));
                        if (!start || !dest) { clearRouteAll(); return; }
                        if (isArrived(start, dest)) { clearRouteAll(); return; }
                        LAST_START = start;
                        LAST_DEST = dest;
                        await safeRouteBetween(LAST_START, LAST_DEST, { noFit: false });
                    } else {
                        clearRouteAll();
                    }
                };
                elems.push(item);
            }
            showResults(elems);

            // Render el más cercano (no dispara ruta hasta click)
            await renderFeature(enriched[0].f, { fly: !PREFERS_REDUCED });

        } catch (err) {
            if (err.name !== 'AbortError') {
                console.error('[geocoder] error:', err);
                showResults([makeInfoItem('Ocurrió un error al buscar')]);
                searchGroup.clearLayers();
                clearRouteAll();
            }
        } finally {
            showLoader(false);
        }
    }

    function makeInfoItem(text) {
        const item = document.createElement('div');
        item.className = 'item';
        item.style.opacity = .8;
        item.textContent = text;
        return item;
    }

} // __GEOCODER_INITED__
