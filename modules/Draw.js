// modules/Draw.js
import { map } from './Map.js';
import { db } from '../config/firebase.js';

export const drawnItems = new L.FeatureGroup();
map.addLayer(drawnItems);

const layersById = new Map(); // id -> layer
let unsubscribe = null;

function latlngsFromDoc(data) {
    if (Array.isArray(data?.points)) {
        return data.points
            .filter(p => p && typeof p.latitude === 'number' && typeof p.longitude === 'number')
            .map(p => L.latLng(p.latitude, p.longitude));
    }
    if (data?.data?.type === 'LineString' && Array.isArray(data.data.coordinates)) {
        return data.data.coordinates.map(([lng, lat]) => L.latLng(lat, lng));
    }
    return [];
}

function getLayer(id) {
    if (layersById.has(id)) return layersById.get(id);
    let found = null;
    drawnItems.eachLayer(ly => { if (ly._firebaseId === id) found = ly; });
    if (found) layersById.set(id, found);
    return found;
}

/* ====== Aplicar cambios de snapshot ====== */
function applyChange(change) {
    const id = change.doc.id;
    const data = change.doc.data();

    if (change.type === 'added') {
        let layer = getLayer(id);
        if (layer) { if (data?.style && layer.setStyle) layer.setStyle(data.style); return; }
        if (data?.type === 'pencil') {
            const latlngs = latlngsFromDoc(data);
            layer = L.polyline(latlngs, data.style || { color: 'black', weight: 2 });
            layer._firebaseId = id;
            drawnItems.addLayer(layer);
            layersById.set(id, layer);
        }
    }

    if (change.type === 'modified') {
        const layer = getLayer(id);
        const latlngs = latlngsFromDoc(data);
        if (layer && latlngs.length && layer.setLatLngs) {
            layer.setLatLngs(latlngs);
            if (data?.style && layer.setStyle) layer.setStyle(data.style);
        } else if (!layer && data?.type === 'pencil') {
            const newLayer = L.polyline(latlngs, data.style || { color: 'black', weight: 2 });
            newLayer._firebaseId = id;
            drawnItems.addLayer(newLayer);
            layersById.set(id, newLayer);
        }
    }

    if (change.type === 'removed') {
        const layer = getLayer(id);
        if (layer) { drawnItems.removeLayer(layer); layersById.delete(id); }
    }
}

/* ====== Suscripción pausable por visibilidad ====== */
function subscribe() {
    if (unsubscribe) return;
    unsubscribe = db.collection('shapes').onSnapshot((snapshot) => {
        snapshot.docChanges().forEach(applyChange);
    }, (err) => { console.warn('[Draw] snapshot error:', err); });
}
function unsubscribeIfAny() {
    try { unsubscribe?.(); } catch { }
    unsubscribe = null;
}

// Arrancar suscrito
subscribe();

// Pausar cuando la pestaña no está visible (ahorra lecturas/costo)
document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
        unsubscribeIfAny();
    } else {
        subscribe();
    }
});
