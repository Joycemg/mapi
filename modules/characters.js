// modules/characters.js
import { map } from './Map.js';
import { db, charactersRef } from '../config/firebase.js';
import { deactivateDrawingTools } from './pencil.js';

const markers = {};
const characterEntries = {};

// id único por cliente para ignorar nuestras propias actualizaciones
const CLIENT_ID = (() => {
    const k = 'clientId';
    let v = sessionStorage.getItem(k);
    if (!v) {
        v = 'c-' + Math.random().toString(36).slice(2);
        sessionStorage.setItem(k, v);
    }
    return v;
})();

// Trails
const trailsLayer = L.layerGroup().addTo(map);
const localTrail = {};
const localTrailPoints = {};
const TRAIL_POINT_MIN_DIST_M = 2;
const TRAIL_FADE_MS = 1400;
const TRAIL_FADE_STEPS = 14;
const TRAIL_PUSH_MS = 120;
const TRAIL_MAX_POINTS = 60;
const lastPushTs = {};

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

function toGeoPoints(latlngs) {
    return (latlngs || []).map(ll => new firebase.firestore.GeoPoint(ll.lat, ll.lng));
}
function fromGeoPoints(geoPoints) {
    return (geoPoints || []).map(gp => L.latLng(gp.latitude, gp.longitude));
}

// ---------- Render Characters ----------
const renderCharacter = (doc) => {
    const data = doc.data();
    const id = doc.id;

    if (!markers[id]) {
        const markerHtml = document.createElement('div');
        Object.assign(markerHtml.style, {
            backgroundColor: data.color,
            width: '20px',
            height: '20px',
            borderRadius: '50%',
            border: '2px solid black',
            position: 'relative'
        });

        const label = document.createElement('div');
        label.textContent = data.name;
        Object.assign(label.style, {
            position: 'absolute',
            top: '-20px',
            left: '50%',
            transform: 'translateX(-50%)',
            padding: '0 4px',
            font: '600 11px/1 system-ui, sans-serif',
            background: 'rgba(255,255,255,.8)',
            borderRadius: '4px',
            whiteSpace: 'nowrap',
            pointerEvents: 'none'
        });
        markerHtml.appendChild(label);

        const icon = L.divIcon({ html: markerHtml.outerHTML, className: '' });
        const marker = L.marker([data.lat, data.lng], { icon, draggable: true }).addTo(map);

        const stopAndDeactivate = (ev) => {
            ev.originalEvent?.preventDefault?.();
            ev.originalEvent?.stopPropagation?.();
            deactivateDrawingTools();
        };
        marker.on('click', stopAndDeactivate);
        marker.on('touchstart', stopAndDeactivate);

        // Drag start
        marker.on('dragstart', (e) => {
            deactivateDrawingTools();
            const startLL = e.target.getLatLng();
            const st = ensureLocalTrail(id, data.color || '#000', startLL);
            if (st.fadeTimer) clearInterval(st.fadeTimer);
            st.poly.setLatLngs([startLL]).setStyle({ opacity: 0.85, color: data.color || '#000' });
            localTrailPoints[id] = [startLL];

            trailsRef.doc(id).set({
                clientId: CLIENT_ID,
                color: data.color || '#000000',
                points: toGeoPoints([startLL]),
                end: false,
                updatedAt: Date.now()
            });
            lastPushTs[id] = 0;
        });

        // Drag move
        marker.on('drag', (e) => {
            const ll = e.target.getLatLng();
            const st = localTrail[id] || ensureLocalTrail(id, data.color || '#000', ll);
            const last = st.lastLL;
            if (last && L.latLng(last).distanceTo(ll) < TRAIL_POINT_MIN_DIST_M) return;
            appendLocalPoint(id, ll);

            const now = Date.now();
            if (!lastPushTs[id] || now - lastPushTs[id] >= TRAIL_PUSH_MS) {
                lastPushTs[id] = now;
                trailsRef.doc(id).set({
                    clientId: CLIENT_ID,
                    color: data.color || '#000000',
                    points: toGeoPoints(localTrailPoints[id].slice(-TRAIL_MAX_POINTS)),
                    end: false,
                    updatedAt: now
                });
            }
        });

        // Drag end
        marker.on('dragend', ({ target }) => {
            const { lat, lng } = target.getLatLng();
            charactersRef.doc(id).update({ lat, lng });

            if (localTrail[id]?.poly) {
                appendLocalPoint(id, target.getLatLng());
                startLocalFade(id);
            }

            // Señal de fin y eliminar doc para que otros desvanezcan y lo quiten
            trailsRef.doc(id).set({
                clientId: CLIENT_ID,
                end: true,
                updatedAt: Date.now()
            }).then(() => {
                setTimeout(() => {
                    trailsRef.doc(id).delete().catch(() => { });
                }, TRAIL_FADE_MS); // esperar a que otros terminen fade
            });
        });

        markers[id] = marker;
    } else {
        markers[id].setLatLng([data.lat, data.lng]);
    }

    // Lista lateral
    if (!characterEntries[id]) {
        const entry = document.createElement('div');
        entry.className = 'character-entry';
        entry.id = `entry-${id}`;
        entry.innerHTML = `
      <span>${data.name}</span>
      <button data-action="locate" data-id="${id}">📍</button>
      <button data-action="delete" data-id="${id}">❌</button>
    `;
        document.getElementById('character-list')?.appendChild(entry);
        characterEntries[id] = entry;

        entry.addEventListener('click', (e) => {
            const btn = e.target.closest('button');
            if (!btn) return;
            const action = btn.dataset.action;
            const targetId = btn.dataset.id;
            if (action === 'locate') locateCharacter(targetId);
            if (action === 'delete') deleteCharacter(targetId);
        });
    } else {
        characterEntries[id].querySelector('span').textContent = data.name;
    }
};

function locateCharacter(id) {
    if (markers[id]) {
        deactivateDrawingTools();
        map.setView(markers[id].getLatLng(), 17);
    }
}

function deleteCharacter(id) {
    const stL = localTrail[id];
    if (stL?.poly) trailsLayer.removeLayer(stL.poly);
    delete localTrail[id];
    delete localTrailPoints[id];

    const stR = remoteTrails[id];
    if (stR?.poly) map.removeLayer(stR.poly);
    delete remoteTrails[id];

    trailsRef.doc(id).delete().catch(() => { });
    charactersRef.doc(id).delete();
}

document.getElementById('add-button')?.addEventListener('click', () => {
    const nameInput = document.getElementById('name');
    const colorInput = document.getElementById('color');
    const name = nameInput?.value.trim() || 'Sin nombre';
    const color = colorInput?.value || '#000000';
    const { lat, lng } = map.getCenter();
    charactersRef.add({ name, color, lat, lng });
    if (nameInput) nameInput.value = '';
});

charactersRef.onSnapshot((snap) => {
    snap.docChanges().forEach((ch) => {
        const { id } = ch.doc;
        if (ch.type === 'added' || ch.type === 'modified') renderCharacter(ch.doc);
        if (ch.type === 'removed') {
            if (markers[id]) { map.removeLayer(markers[id]); delete markers[id]; }
            if (characterEntries[id]) { characterEntries[id].remove(); delete characterEntries[id]; }
            trailsRef.doc(id).delete().catch(() => { });
        }
    });
});

// Listener de trails remotas
trailsRef.onSnapshot((snap) => {
    snap.docChanges().forEach((ch) => {
        const id = ch.doc.id;
        const d = ch.doc.data() || {};
        if (d.clientId === CLIENT_ID) return;

        if (ch.type === 'removed') {
            if (remoteTrails[id]?.poly) {
                map.removeLayer(remoteTrails[id].poly);
                delete remoteTrails[id];
            }
            return;
        }

        const pts = fromGeoPoints(d.points);
        if (!pts.length && d.end) {
            if (remoteTrails[id]?.poly) map.removeLayer(remoteTrails[id].poly);
            delete remoteTrails[id];
            return;
        }

        let rt = remoteTrails[id];
        if (!rt?.poly) {
            rt = remoteTrails[id] = { poly: makePolyline({ color: d.color || '#000' }), fadeTimer: null };
            map.addLayer(rt.poly);
        }
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
