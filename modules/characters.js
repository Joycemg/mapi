// modules/characters.js
import { map } from './Map.js';
import { db, charactersRef } from '../config/firebase.js';
import { deactivateDrawingTools } from './pencil.js';

/* ======================================================
   Estado principal
====================================================== */
const markers = {};
const characterEntries = {};
const markerState = {}; // id -> { name, color }

/* -------- GeoPoint compat (v8 global o v9 modular) ---- */
let GeoPointCtor = null;
try {
    if (window.firebase?.firestore?.GeoPoint) GeoPointCtor = window.firebase.firestore.GeoPoint; // v8
    if (!GeoPointCtor && typeof window.GeoPoint === 'function') GeoPointCtor = window.GeoPoint;  // expuesto por tu config v9
} catch { }

/* -------- Flags globales compartidos con geocoder ------ */
window.__CHAR_IS_DRAGGING = window.__CHAR_IS_DRAGGING || false;
window.__CHAR_DRAG_TS__ = window.__CHAR_DRAG_TS__ || 0;

/* -------- Polyfills ------------------------------------ */
if (!L.Util) L.Util = {};
if (typeof L.Util.clamp !== 'function') {
    L.Util.clamp = (n, min, max) => Math.max(min, Math.min(max, n));
}

/* ======================================================
   Helpers de integración con geocoder
====================================================== */
function notifyGeocoderMove(id, ll) {
    if (typeof window.onCharacterMoved === 'function' && ll) {
        try { window.onCharacterMoved({ id, lat: ll.lat, lng: ll.lng }); } catch { }
    }
}

function buildSimpleList() {
    return Object.keys(markers).map(id => {
        const ll = markers[id].getLatLng();
        const st = markerState[id] || {};
        return { id, name: st.name || id, lat: ll.lat, lng: ll.lng };
    });
}
function publishToGeocoder() {
    const list = buildSimpleList();
    if (typeof window.setGeocoderCharacters === 'function') {
        try { window.setGeocoderCharacters(list); } catch (e) { console.warn('setGeocoderCharacters error:', e); }
    }
}
window.getCharactersSimple = () => buildSimpleList();
window.focusCharacter = (id) => locateCharacter(id);

/* -------- Client id (ignorar sender local en trails remotas) */
const CLIENT_ID = (() => {
    const k = 'clientId';
    let v = sessionStorage.getItem(k);
    if (!v) { v = 'c-' + Math.random().toString(36).slice(2); sessionStorage.setItem(k, v); }
    return v;
})();

/* ======================================================
   Icono (divIcon SVG)
====================================================== */
function survivorSVG(name = '', shirt = '#1f77ff', size = 28) {
    const label = `
  <div class="survivor-label" style="
    position:absolute; top:-18px; left:50%; transform:translateX(-50%);
    padding:0 4px; font:600 11px/1 system-ui,sans-serif;
    background:rgba(255,255,255,.9); border-radius:4px; white-space:nowrap; pointer-events:none;">
    ${escapeHtml(name)}
  </div>`;
    const svg = `
  <svg width="${size}" height="${size * 1.4}" viewBox="0 0 64 86" xmlns="http://www.w3.org/2000/svg" aria-label="${escapeAttr(name)}">
    <ellipse cx="32" cy="78" rx="14" ry="6" fill="rgba(0,0,0,0.25)"/>
    <circle cx="32" cy="10" r="8" fill="#f2c89b" stroke="#111" stroke-width="1.5"/>
    <rect x="28" y="17" width="8" height="6" rx="2" fill="#f2c89b" stroke="#111" stroke-width="1"/>
    <path d="M18 24 L46 24 L54 36 L46 42 L18 42 L10 36 Z" fill="${shirt}" stroke="#111" stroke-width="1.6"/>
    <rect x="8" y="32" width="10" height="15" rx="4" fill="#f2c89b" stroke="#111" stroke-width="1"/>
    <rect x="46" y="32" width="10" height="15" rx="4" fill="#f2c89b" stroke="#111" stroke-width="1"/>
    <path d="M18 42 L46 42 L44 60 L36 60 L34 48 L30 48 L28 60 L20 60 Z" fill="#334155" stroke="#111" stroke-width="1.6"/>
    <rect x="18" y="60" width="10" height="8" rx="2" fill="#cbd5e1" stroke="#111" stroke-width="1"/>
    <rect x="36" y="60" width="10" height="8" rx="2" fill="#cbd5e1" stroke="#111" stroke-width="1"/>
  </svg>`;
    return `<div class="survivor-icon" style="position:relative; width:${size}px; height:${size * 1.4}px;">${label}${svg}</div>`;
}
function makeSurvivorIcon(name, color) {
    const html = survivorSVG(name || '', color || '#000000', 28);
    return L.divIcon({
        html,
        className: 'survivor-divicon',
        iconSize: [28, 40],
        iconAnchor: [14, 28],
        popupAnchor: [0, -30]
    });
}
function escapeHtml(str) {
    return String(str || '')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
const escapeAttr = (s) => escapeHtml(s);

/* ======================================================
   Trails (local + remotas)
====================================================== */
const trailsLayer = L.layerGroup().addTo(map);
const localTrail = {};
const localTrailPoints = {};
const TRAIL_POINT_MIN_DIST_M = 2;
const TRAIL_FADE_MS = 1400;
const TRAIL_FADE_STEPS = 14;
const TRAIL_PUSH_MS = 120;
const TRAIL_MAX_POINTS = 60;
const lastPushTs = {};
const lastNotifyTs = {};

const trailsRef = db.collection('trails');
const remoteTrails = {};

function makePolyline(opts = {}) {
    return L.polyline([], {
        color: opts.color || '#000',
        weight: opts.weight ?? 3,
        opacity: opts.opacity ?? 0.85,
        dashArray: opts.dashArray ?? '4,6',
        lineCap: 'round',
        pane: 'overlayPane'
    });
}
function ensureLocalTrail(id, color, startLL) {
    if (localTrail[id]?.poly) return localTrail[id];
    const poly = makePolyline({ color });
    poly.addLatLng(startLL);
    trailsLayer.addLayer(poly);
    const st = { poly, lastLL: startLL, fadeTimer: null };
    localTrail[id] = st;
    localTrailPoints[id] = [startLL];
    return st;
}
function appendLocalPoint(id, ll) {
    const st = localTrail[id];
    if (!st?.poly) return;
    st.poly.addLatLng(ll);
    st.lastLL = ll;
    const arr = localTrailPoints[id] || [];
    arr.push(ll);
    if (arr.length > TRAIL_MAX_POINTS) arr.splice(0, arr.length - TRAIL_MAX_POINTS);
    localTrailPoints[id] = arr;
}
function startLocalFade(id) {
    const st = localTrail[id];
    if (!st?.poly) return;
    if (st.fadeTimer) { clearInterval(st.fadeTimer); st.fadeTimer = null; }
    const poly = st.poly;
    const baseOpacity = poly.options.opacity ?? 0.85;
    let step = 0;
    const tickMs = Math.max(16, Math.floor(TRAIL_FADE_MS / TRAIL_FADE_STEPS));
    st.fadeTimer = setInterval(() => {
        step++;
        poly.setStyle({ opacity: baseOpacity * (1 - step / TRAIL_FADE_STEPS) });
        if (step >= TRAIL_FADE_STEPS) {
            clearInterval(st.fadeTimer);
            trailsLayer.removeLayer(poly);
            delete localTrail[id];
            delete localTrailPoints[id];
        }
    }, tickMs);
}

/* -------- GeoPoint helpers -------- */
function toGeoPoints(latlngs = []) {
    if (GeoPointCtor) return latlngs.map(ll => new GeoPointCtor(ll.lat, ll.lng));
    return latlngs.map(ll => ({ lat: ll.lat, lng: ll.lng, _plain: true }));
}
function fromGeoPoints(geoPoints = []) {
    return geoPoints.map(gp => {
        if (gp && typeof gp.latitude === 'number' && typeof gp.longitude === 'number') {
            return L.latLng(gp.latitude, gp.longitude);
        }
        if (gp && typeof gp.lat === 'number' && typeof gp.lng === 'number') {
            return L.latLng(gp.lat, gp.lng);
        }
        return null;
    }).filter(Boolean);
}
function fmtMeters(m) { if (!isFinite(m)) return '0 m'; return (m < 1000) ? `${Math.round(m)} m` : `${(m / 1000).toFixed(2)} km`; }

/* ======================================================
   Rendimiento / Auto-pan / Simplificación
====================================================== */
const EDGE_PX = 50;
const PAN_STEP_PX = 40;
const PAN_THROTTLE_MS = 40;
let lastPanTs = 0;
const SIMPLIFY_MIN_TOL_M = 2.0;
const SIMPLIFY_MAX_TOL_M = 5.0;

function metersPerPixelAt(ll) {
    const p = map.latLngToLayerPoint(ll);
    const p2 = L.point(p.x + 1, p.y);
    const ll2 = map.layerPointToLatLng(p2);
    return map.distance(ll, ll2) || 1;
}
function rdp(points, epsilonPx) {
    if (points.length <= 2) return points.slice();
    const stack = [[0, points.length - 1]];
    const keep = new Array(points.length).fill(false);
    keep[0] = keep[points.length - 1] = true;
    function perpDist(P, A, B) {
        const vx = B.x - A.x, vy = B.y - A.y;
        const wx = P.x - A.x, wy = P.y - A.y;
        const c1 = vx * wx + vy * wy;
        if (c1 <= 0) return Math.hypot(P.x - A.x, P.y - A.y);
        const c2 = vx * vx + vy * vy;
        if (c2 <= c1) return Math.hypot(P.x - B.x, P.y - B.y);
        const t = c1 / c2;
        const projX = A.x + t * vx, projY = A.y + t * vy;
        return Math.hypot(P.x - projX, P.y - projY);
    }
    while (stack.length) {
        const [i, j] = stack.pop();
        let idx = -1, maxD = 0;
        for (let k = i + 1; k < j; k++) {
            const d = perpDist(points[k], points[i], points[j]);
            if (d > maxD) { maxD = d; idx = k; }
        }
        if (maxD > epsilonPx && idx !== -1) {
            keep[idx] = true; stack.push([i, idx], [idx, j]);
        }
    }
    const out = [];
    for (let i = 0; i < points.length; i++) if (keep[i]) out.push(points[i]);
    return out;
}
function simplifyLatLngs(latlngs, tolMeters) {
    if (!latlngs || latlngs.length <= 2) return latlngs || [];
    const mpp = metersPerPixelAt(latlngs[0]);
    const epsPx = Math.max(0.5, tolMeters / mpp);
    const pts = latlngs.map(ll => map.latLngToLayerPoint(ll));
    const simp = rdp(pts, epsPx);
    return simp.map(p => map.layerPointToLatLng(p));
}
function currentSimplifyToleranceM() {
    const z = map.getZoom?.() ?? 13;
    const t = L.Util.clamp(14 - z, 0, 5);
    return L.Util.clamp(SIMPLIFY_MIN_TOL_M + t, SIMPLIFY_MIN_TOL_M, SIMPLIFY_MAX_TOL_M);
}
function maybeAutoPan(ll) {
    const now = Date.now();
    if (now - lastPanTs < PAN_THROTTLE_MS) return;
    const cpt = map.latLngToContainerPoint(ll);
    const { x: w, y: h } = map.getSize();
    let dx = 0, dy = 0;
    if (cpt.x < EDGE_PX) dx = -PAN_STEP_PX;
    else if (cpt.x > w - EDGE_PX) dx = PAN_STEP_PX;
    if (cpt.y < EDGE_PX) dy = -PAN_STEP_PX;
    else if (cpt.y > h - EDGE_PX) dy = PAN_STEP_PX;
    if (dx || dy) { map.panBy([dx, dy], { animate: false }); lastPanTs = now; }
}

/* ======================================================
   Clustering (opcional)
====================================================== */
let clusterGroup = null;
(function ensureClusterGroup() {
    if (L.markerClusterGroup) {
        clusterGroup = L.markerClusterGroup({
            spiderfyOnMaxZoom: true,
            showCoverageOnHover: false,
            zoomToBoundsOnClick: true,
            chunkedLoading: true,
            removeOutsideVisibleBounds: true,
            maxClusterRadius: 60,
            iconCreateFunction: (cluster) => {
                const count = cluster.getChildCount();
                let c = 'mc-small';
                if (count >= 25) c = 'mc-large';
                else if (count >= 10) c = 'mc-med';
                return L.divIcon({
                    html: `<div class="mc-count">${count}</div>`,
                    className: `mc-cluster ${c}`,
                    iconSize: [36, 36]
                });
            }
        });
        map.addLayer(clusterGroup);
    } else {
        console.warn('[characters] markercluster no encontrado. Sin clustering.');
    }
})();
function addMarkerToMapOrCluster(marker) { if (clusterGroup) clusterGroup.addLayer(marker); else marker.addTo(map); }
function removeMarkerFromMapOrCluster(marker) { if (clusterGroup) clusterGroup.removeLayer(marker); else map.removeLayer(marker); }
function zoomToMarker(marker, zoom = 17) {
    if (!clusterGroup) { map.setView(marker.getLatLng(), zoom); return; }
    clusterGroup.zoomToShowLayer(marker, () => map.setView(marker.getLatLng(), zoom));
}

/* ======================================================
   Snap a ruta (modo MANUAL con SHIFT)
====================================================== */
const SNAP_MODE = 'manual';       // 'manual' | 'auto'
const SNAP_ATTACH_RADIUS_M = 35;
const SNAP_MAX_JUMP_M = 60;

function getActiveRouteLatLngs() {
    if (typeof window.getActiveRouteLatLngs === 'function') {
        try {
            const res = window.getActiveRouteLatLngs();
            if (Array.isArray(res) && res.length) return res.map(v => L.latLng(v.lat, v.lng));
        } catch { }
    }
    const arr = window.__ACTIVE_ROUTE_LATLNGS__;
    if (Array.isArray(arr) && arr.length) return arr.map(v => L.latLng(v.lat, v.lng));
    return null;
}
function nearestOnPolylineMeters(ll, latlngs) {
    if (!latlngs || latlngs.length < 2) return { latlng: ll, segIndex: -1, t: 0, distM: Infinity };
    const p = map.latLngToLayerPoint(ll);
    let best = { latlng: ll, segIndex: -1, t: 0, distM: Infinity };
    for (let i = 0; i < latlngs.length - 1; i++) {
        const aLL = latlngs[i], bLL = latlngs[i + 1];
        const a = map.latLngToLayerPoint(aLL);
        const b = map.latLngToLayerPoint(bLL);
        const ab = L.point(b.x - a.x, b.y - a.y);
        const ap = L.point(p.x - a.x, p.y - a.y);
        const ab2 = ab.x * ab.x + ab.y * ab.y;
        let t = 0; if (ab2 > 0) t = (ap.x * ab.x + ap.y * ab.y) / ab2;
        t = Math.max(0, Math.min(1, t));
        const proj = L.point(a.x + ab.x * t, a.y + ab.y * t);
        const projLL = map.layerPointToLatLng(proj);
        const distM = projLL.distanceTo(ll);
        if (distM < best.distM) best = { latlng: projLL, segIndex: i, t, distM };
    }
    return best;
}

/* ======================================================
   Render de personajes
====================================================== */
const renderCharacter = (doc) => {
    const data = doc.data();
    const id = doc.id;
    const desiredName = data.name || '';
    const desiredColor = data.color || '#000000';

    if (!markers[id]) {
        const icon = makeSurvivorIcon(desiredName, desiredColor);
        const marker = L.marker([data.lat, data.lng], { icon, draggable: true });
        addMarkerToMapOrCluster(marker);

        marker.bindTooltip('', {
            permanent: false, direction: 'top', offset: [0, -30],
            className: 'char-move-tooltip', opacity: 1
        });

        const stopAndDeactivate = (ev) => {
            ev.originalEvent?.preventDefault?.();
            ev.originalEvent?.stopPropagation?.();
            deactivateDrawingTools();
        };
        marker.on('click', stopAndDeactivate);
        marker.on('touchstart', stopAndDeactivate);

        // ----- dragstart
        marker.on('dragstart', (e) => {
            deactivateDrawingTools();
            window.__CHAR_IS_DRAGGING = true;
            window.__CHAR_DRAG_TS__ = Date.now();

            let startLL = e.target.getLatLng();

            if (SNAP_MODE === 'auto') {
                const route = getActiveRouteLatLngs();
                if (route && route.length >= 2) {
                    const cand = nearestOnPolylineMeters(startLL, route);
                    marker._snapActive = cand.distM <= SNAP_ATTACH_RADIUS_M;
                    if (marker._snapActive && cand.latlng) {
                        e.target.setLatLng(cand.latlng);
                        startLL = cand.latlng;
                    }
                } else {
                    marker._snapActive = false;
                }
            } else {
                marker._snapActive = false; // manual
            }
            marker._snappingGuard = false;

            marker._lastDragLL = startLL;
            marker._movedMeters = 0;
            marker.setTooltipContent('0 m');
            marker.openTooltip();

            const st = ensureLocalTrail(id, desiredColor || '#000', startLL);
            if (st.fadeTimer) clearInterval(st.fadeTimer);
            st.poly.setLatLngs([startLL]).setStyle({ opacity: 0.85, color: desiredColor || '#000' });
            localTrailPoints[id] = [startLL];

            try {
                trailsRef.doc(id).set({
                    clientId: CLIENT_ID,
                    color: desiredColor || '#000000',
                    points: toGeoPoints([startLL]),
                    end: false,
                    updatedAt: Date.now()
                });
            } catch (e) { console.warn('[trails.set] inicio falló', e); }

            lastPushTs[id] = 0;
            lastNotifyTs[id] = 0;

            notifyGeocoderMove(id, startLL);
        });

        // ----- drag (move)
        marker.on('drag', (e) => {
            window.__CHAR_DRAG_TS__ = Date.now();

            const route = getActiveRouteLatLngs();
            const shiftPressed = !!e.originalEvent?.shiftKey;
            let ll = e.target.getLatLng();

            if (SNAP_MODE === 'manual') {
                if (shiftPressed && route && route.length >= 2) {
                    const cand = nearestOnPolylineMeters(ll, route);
                    if (cand.latlng && cand.distM <= SNAP_MAX_JUMP_M) {
                        marker._snappingGuard = true;
                        e.target.setLatLng(cand.latlng);
                        marker._snappingGuard = false;
                        ll = cand.latlng;
                    }
                }
            } else {
                if (marker._snapActive && route && route.length >= 2 && !shiftPressed) {
                    const cand = nearestOnPolylineMeters(ll, route);
                    if (cand.latlng) {
                        if (cand.distM <= SNAP_MAX_JUMP_M) {
                            marker._snappingGuard = true;
                            e.target.setLatLng(cand.latlng);
                            marker._snappingGuard = false;
                            ll = cand.latlng;
                        } else {
                            marker._snapActive = false;
                        }
                    } else { marker._snapActive = false; }
                } else if (shiftPressed) { marker._snapActive = false; }
            }

            maybeAutoPan(ll);

            if (e.target._lastDragLL) {
                const delta = e.target._lastDragLL.distanceTo(ll);
                e.target._movedMeters = (e.target._movedMeters || 0) + delta;
            }
            e.target._lastDragLL = ll;

            e.target.setTooltipContent(fmtMeters(e.target._movedMeters || 0));

            const st = localTrail[id] || ensureLocalTrail(id, desiredColor || '#000', ll);
            const last = st.lastLL;
            if (!last || L.latLng(last).distanceTo(ll) >= TRAIL_POINT_MIN_DIST_M) {
                appendLocalPoint(id, ll);
            }

            const now = Date.now();
            if (!lastNotifyTs[id] || now - lastNotifyTs[id] >= TRAIL_PUSH_MS) {
                lastNotifyTs[id] = now;
                notifyGeocoderMove(id, ll);
            }
            if (!lastPushTs[id] || now - lastPushTs[id] >= TRAIL_PUSH_MS) {
                lastPushTs[id] = now;
                const raw = localTrailPoints[id].slice(-TRAIL_MAX_POINTS);
                const tol = currentSimplifyToleranceM();
                const simplified = simplifyLatLngs(raw, tol);
                trailsRef.doc(id).set({
                    clientId: CLIENT_ID,
                    color: desiredColor || '#000000',
                    points: toGeoPoints(simplified),
                    end: false,
                    updatedAt: now
                }).catch(e => console.warn('[trails.set] move falló', e));
            }
        });

        // ----- dragend
        marker.on('dragend', ({ target }) => {
            marker._snapActive = false;
            marker._snappingGuard = false;

            let { lat, lng } = target.getLatLng();

            // snap final SUAVE solo si SIGUE presionado SHIFT en modo manual
            const shiftPressed = !!(window.event && window.event.shiftKey);
            const route = getActiveRouteLatLngs();
            if (SNAP_MODE === 'manual' && shiftPressed && route && route.length >= 2) {
                const cand = nearestOnPolylineMeters(L.latLng(lat, lng), route);
                if (cand?.latlng) {
                    target.setLatLng(cand.latlng);
                    lat = cand.latlng.lat; lng = cand.latlng.lng;
                }
            } else if (SNAP_MODE === 'auto' && route && route.length >= 2) {
                const cand = nearestOnPolylineMeters(L.latLng(lat, lng), route);
                if (cand?.latlng) {
                    target.setLatLng(cand.latlng);
                    lat = cand.latlng.lat; lng = cand.latlng.lng;
                }
            }

            charactersRef.doc(id).update({ lat, lng }).catch(() => { });

            if (localTrail[id]?.poly) {
                appendLocalPoint(id, target.getLatLng());
                const raw = (localTrailPoints[id] || []).slice(-TRAIL_MAX_POINTS);
                const tol = currentSimplifyToleranceM();
                const simplified = simplifyLatLngs(raw, tol);
                trailsRef.doc(id).set({
                    clientId: CLIENT_ID,
                    color: desiredColor || '#000000',
                    points: toGeoPoints(simplified),
                    end: false,
                    updatedAt: Date.now()
                }).catch(e => console.warn('[trails.set] end falló', e));
                startLocalFade(id);
            }

            // Señal de fin + borrado diferido
            trailsRef.doc(id).set({
                clientId: CLIENT_ID,
                end: true,
                updatedAt: Date.now()
            }).then(() => setTimeout(() => trailsRef.doc(id).delete().catch(() => { }), TRAIL_FADE_MS))
                .catch(e => console.warn('[trails.set end:true] falló', e));

            setTimeout(() => target.closeTooltip(), 300);
            target._lastDragLL = null;

            // desbloqueo
            window.__CHAR_IS_DRAGGING = false;
            window.__CHAR_DRAG_TS__ = 0;

            const finalLL = target.getLatLng();
            notifyGeocoderMove(id, finalLL);
            publishToGeocoder();
        });

        markers[id] = marker;
        markerState[id] = { name: desiredName, color: desiredColor };

        publishToGeocoder();
    } else {
        // update existente
        markers[id].setLatLng([data.lat, data.lng]);
        const st = markerState[id] || {};
        if (st.name !== desiredName || st.color !== desiredColor) {
            markers[id].setIcon(makeSurvivorIcon(desiredName, desiredColor));
            markerState[id] = { name: desiredName, color: desiredColor };
        }
        publishToGeocoder();
    }

    // entrada de lista
    if (!characterEntries[id]) {
        const entry = document.createElement('div');
        entry.className = 'character-entry';
        entry.id = `entry-${id}`;
        entry.innerHTML = `
      <span>${escapeHtml(desiredName)}</span>
      <button data-action="locate" data-id="${id}">📍</button>
      <button data-action="delete" data-id="${id}">❌</button>
    `;
        document.getElementById('character-list')?.appendChild(entry);
        characterEntries[id] = entry;
        entry.addEventListener('click', (e) => {
            const btn = e.target.closest('button'); if (!btn) return;
            const action = btn.dataset.action; const targetId = btn.dataset.id;
            if (action === 'locate') locateCharacter(targetId);
            if (action === 'delete') deleteCharacter(targetId);
        });
    } else {
        characterEntries[id].querySelector('span').textContent = desiredName;
    }
};

function locateCharacter(id) {
    if (markers[id]) { deactivateDrawingTools(); zoomToMarker(markers[id], 17); }
}
function deleteCharacter(id) {
    const stL = localTrail[id];
    if (stL?.poly) trailsLayer.removeLayer(stL.poly);
    delete localTrail[id];
    delete localTrailPoints[id];

    const stR = remoteTrails[id];
    if (stR?.poly) map.removeLayer(stR.poly);
    delete remoteTrails[id];

    if (markers[id]) { removeMarkerFromMapOrCluster(markers[id]); delete markers[id]; }

    trailsRef.doc(id).delete().catch(() => { });
    charactersRef.doc(id).delete();

    publishToGeocoder();
}

/* ======================================================
   UI alta
====================================================== */
document.getElementById('add-button')?.addEventListener('click', () => {
    const nameInput = document.getElementById('name');
    const colorInput = document.getElementById('color');
    const name = nameInput?.value.trim() || 'Sin nombre';
    const color = colorInput?.value || '#1f77ff';
    const { lat, lng } = map.getCenter();
    charactersRef.add({ name, color, lat, lng });
    if (nameInput) nameInput.value = '';
});

/* ======================================================
   Firestore listeners
====================================================== */
charactersRef.onSnapshot((snap) => {
    snap.docChanges().forEach((ch) => {
        const { id } = ch.doc;
        if (ch.type === 'added' || ch.type === 'modified') renderCharacter(ch.doc);
        if (ch.type === 'removed') {
            if (markers[id]) { removeMarkerFromMapOrCluster(markers[id]); delete markers[id]; }
            if (characterEntries[id]) { characterEntries[id].remove(); delete characterEntries[id]; }
            trailsRef.doc(id).delete().catch(() => { });
            delete markerState[id];
            publishToGeocoder();
        }
    });
});
trailsRef.onSnapshot((snap) => {
    snap.docChanges().forEach((ch) => {
        const id = ch.doc.id;
        const d = ch.doc.data() || {};
        if (d.clientId === CLIENT_ID) return;

        if (ch.type === 'removed') {
            if (remoteTrails[id]?.poly) { map.removeLayer(remoteTrails[id].poly); delete remoteTrails[id]; }
            return;
        }
        const pts = fromGeoPoints(d.points);
        if (!pts.length && d.end) {
            if (remoteTrails[id]?.poly) map.removeLayer(remoteTrails[id].poly);
            delete remoteTrails[id];
            return;
        }
        let rt = remoteTrails[id];
        if (!rt?.poly) { rt = remoteTrails[id] = { poly: makePolyline({ color: d.color || '#000' }), fadeTimer: null }; map.addLayer(rt.poly); }
        rt.poly.setLatLngs(pts);
        rt.poly.setStyle({ color: d.color || '#000', opacity: 0.85 });

        if (d.end) {
            if (rt.fadeTimer) clearInterval(rt.fadeTimer);
            const poly = rt.poly;
            const baseOpacity = poly.options.opacity ?? 0.85;
            let step = 0;
            const tickMs = Math.max(16, Math.floor(TRAIL_FADE_MS / TRAIL_FADE_STEPS));
            rt.fadeTimer = setInterval(() => {
                step++;
                poly.setStyle({ opacity: baseOpacity * (1 - step / TRAIL_FADE_STEPS) });
                if (step >= TRAIL_FADE_STEPS) {
                    clearInterval(rt.fadeTimer);
                    map.removeLayer(poly);
                    delete remoteTrails[id];
                }
            }, tickMs);
        }
    });
});

/* ======================================================
   Estilos inyectados
====================================================== */
(function ensureInjectedCss() {
    const id = 'char-injected-style';
    if (document.getElementById(id)) return;
    const style = document.createElement('style'); style.id = id;
    style.textContent = `
    .char-move-tooltip.leaflet-tooltip{
      background:#111; color:#fff; border:0; border-radius:6px;
      padding:2px 6px; font:600 11px/1 system-ui, sans-serif;
      box-shadow:0 2px 10px rgba(0,0,0,.25);
    }
    .char-move-tooltip.leaflet-tooltip:before { display:none; }
    .survivor-divicon { will-change: transform; }

    .mc-cluster{
      background:#2563eb; color:#fff; border-radius:9999px; display:flex; align-items:center; justify-content:center;
      box-shadow:0 4px 14px rgba(37,99,235,.25); border:2px solid #fff;
    }
    .mc-count{ font:700 12px/1 system-ui,sans-serif; padding:6px; }
    .mc-small{ width:32px; height:32px; }
    .mc-med{ width:40px; height:40px; }
    .mc-large{ width:48px; height:48px; }
  `;
    document.head.appendChild(style);
})();

/* ======================================================
   Failsafes globales de drag (por si falta dragend)
====================================================== */
(function installDragFailsafes() {
    function hardUnlock() {
        if (window.__CHAR_IS_DRAGGING) {
            window.__CHAR_IS_DRAGGING = false;
            window.__CHAR_DRAG_TS__ = 0;
            try {
                const ids = Object.keys(markers);
                for (const id of ids) {
                    const ll = markers[id]?.getLatLng?.();
                    if (ll) notifyGeocoderMove(id, ll);
                }
            } catch { }
        }
    }
    // Watchdog: si pasan >2000 ms sin pulso, desbloquear
    setInterval(() => {
        const ts = window.__CHAR_DRAG_TS__ || 0;
        if (window.__CHAR_IS_DRAGGING && ts && (Date.now() - ts > 2000)) hardUnlock();
    }, 500);

    ['pointerup', 'touchend', 'touchcancel', 'mouseup'].forEach(ev =>
        window.addEventListener(ev, () => setTimeout(hardUnlock, 0), { passive: true })
    );
    window.addEventListener('blur', () => setTimeout(hardUnlock, 0));
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState !== 'visible') setTimeout(hardUnlock, 0);
    });
})();

export { };
