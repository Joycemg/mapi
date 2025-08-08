// modules/pencil.js
import { map } from './Map.js';
import { drawnItems } from './Draw.js';
import { db } from '../config/firebase.js';
import { hidePanel, showPanel } from './panel.js';

/* =========================
   Estado / Config
========================= */
let mode = 'idle'; // 'idle' | 'pencil' | 'eraser'

let isDrawing = false;
let currentLine = null;
let currentRef = null;           // doc ref Firestore del trazo en curso
let points = [];                 // L.LatLng[]
let lastUpdate = 0;
const UPDATE_EVERY_MS = 100;

let selectedColor = 'black';
let selectedWeight = 4;          // default medio

let pencilButton = null;
let eraserButton = null;

/* =========================
   UI del control
========================= */
const PencilControl = L.Control.extend({
    options: { position: 'topleft' },
    onAdd() {
        const wrapper = L.DomUtil.create('div', 'leaflet-bar pencil-wrapper mobile-friendly');

        // Evita que el mapa capture drag/click del control
        L.DomEvent.disableClickPropagation(wrapper);
        L.DomEvent.disableScrollPropagation(wrapper);

        pencilButton = createBtn('✏️', 'custom-pencil', 'Dibujar', wrapper, handlePencilClick);
        eraserButton = createBtn('🧽', 'custom-eraser', 'Borrar', wrapper, handleEraserClick);

        const configPanel = L.DomUtil.create('div', 'pencil-config-panel', wrapper);
        configPanel.style.display = 'none';
        configPanel.style.flexDirection = 'column';
        configPanel.style.padding = '6px';
        configPanel.append(makeColorSel(), makeWeightSel());

        wrapper.append(configPanel);
        toggleUI('none');
        return wrapper;
    }
});
map.addControl(new PencilControl());

function createBtn(icon, cls, title, container, onClick) {
    const a = L.DomUtil.create('a', cls, container);
    a.innerHTML = icon; a.href = '#'; a.title = title;
    a.onclick = (e) => { e.preventDefault(); onClick(); };
    return a;
}
function makeColorSel() {
    const s = L.DomUtil.create('div', 'color-selector');
    ['black', 'white', 'red'].forEach(c => {
        const btn = L.DomUtil.create('div', `pencil-color ${c}`, s);
        Object.assign(btn.style, {
            width: '24px', height: '24px', borderRadius: '50%',
            margin: '4px', border: '1px solid #999', backgroundColor: c, cursor: 'pointer'
        });
        btn.onclick = () => {
            selectedColor = c;
            if (pencilButton) pencilButton.style.backgroundColor = c;
        };
    });
    return s;
}
function makeWeightSel() {
    const s = L.DomUtil.create('div', 'weight-selector');
    [{ w: 2, l: 'Fino' }, { w: 4, l: 'Medio' }, { w: 6, l: 'Grueso' }].forEach(({ w, l }) => {
        const btn = L.DomUtil.create('div', 'weight-option', s);
        btn.innerHTML = `<div style="width:24px;height:0;border-top:${w}px solid black;margin-bottom:2px"></div><small>${l}</small>`;
        Object.assign(btn.style, { padding: '4px', textAlign: 'center', cursor: 'pointer' });
        btn.onclick = () => {
            selectedWeight = w;
            [...s.children].forEach(c => c.classList.remove('selected'));
            btn.classList.add('selected');
            updatePencilPreview();
        };
    });
    return s;
}
function updatePencilPreview() {
    if (!pencilButton) return;
    pencilButton.innerHTML = `<div style="width:24px;height:0;border-top:${selectedWeight}px solid ${selectedColor};margin:10px auto;"></div>`;
}
function toggleUI(display) {
    const panel = pencilButton?.parentElement?.querySelector('.pencil-config-panel');
    if (panel) panel.style.display = display;
}

/* =========================
   Botones (modes)
========================= */
function handlePencilClick() {
    disableEraser();
    (mode === 'pencil') ? disablePencil() : enablePencil();
}
function handleEraserClick() {
    disablePencil();
    (mode === 'eraser') ? disableEraser() : enableEraser();
}

/* =========================
   LÁPIZ (Leaflet events)
========================= */
function enablePencil() {
    mode = 'pencil';
    pencilButton.classList.add('active');
    pencilButton.style.backgroundColor = selectedColor;
    toggleUI('flex');
    updatePencilPreview();

    map.dragging.disable();
    hidePanel('panel');
    map.getContainer().style.touchAction = 'none';

    map.on('mousedown', onDown);
    map.on('mousemove', onMove);
    L.DomEvent.on(document, 'mouseup', onUp);
    map.on('touchstart', onDown);
    map.on('touchmove', onMove);
    map.on('touchend', onUp);
}
function disablePencil() {
    if (mode === 'pencil') mode = 'idle';
    pencilButton.classList.remove('active');
    pencilButton.style.backgroundColor = selectedColor;
    toggleUI('none');

    map.dragging.enable();
    showPanel('panel');
    map.getContainer().style.touchAction = '';

    map.off('mousedown', onDown);
    map.off('mousemove', onMove);
    L.DomEvent.off(document, 'mouseup', onUp);
    map.off('touchstart', onDown);
    map.off('touchmove', onMove);
    map.off('touchend', onUp);

    isDrawing = false; currentLine = null; currentRef = null; points = [];
}

function goodStart(ev) {
    const t = ev.originalEvent?.target;
    if (!t) return true;
    if (t.closest?.('.leaflet-marker-icon')) return false;
    if (t.closest?.('.leaflet-popup')) return false;
    if (t.closest?.('.leaflet-control')) return false;
    return true;
}
function onDown(ev) {
    if (mode !== 'pencil') return;
    if (ev.originalEvent?.button !== undefined && ev.originalEvent.button !== 0) return;
    if (!goodStart(ev)) return;

    L.DomEvent.preventDefault(ev.originalEvent || ev);
    L.DomEvent.stopPropagation(ev.originalEvent || ev);

    isDrawing = true;
    const start = ev.latlng || map.mouseEventToLatLng(ev.originalEvent);
    points = [start];

    // crea doc en Firestore
    const id = `pencil-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    currentRef = db.collection('shapes').doc(id);

    const style = { color: selectedColor, weight: selectedWeight };
    const geoPoints = [new firebase.firestore.GeoPoint(start.lat, start.lng)];

    currentRef.set({ type: 'pencil', points: geoPoints, style, updatedAt: Date.now() });

    // línea local
    currentLine = L.polyline(points, style);
    currentLine._firebaseId = id;
    drawnItems.addLayer(currentLine);
    lastUpdate = 0;
}
function onMove(ev) {
    if (mode !== 'pencil') return;
    if (!isDrawing || !currentLine) return;

    const ll = ev.latlng || map.mouseEventToLatLng(ev.originalEvent);
    if (!ll) return;

    L.DomEvent.preventDefault(ev.originalEvent || ev);
    currentLine.addLatLng(ll);
    points.push(ll);
    maybePush();
}
function onUp(ev) {
    if (mode !== 'pencil') return;
    if (!isDrawing) return;

    L.DomEvent.preventDefault(ev?.originalEvent || ev);
    isDrawing = false;

    pushAll(); // guardado final
    currentRef = null;
    points = [];
}

function geoPointArray() {
    return points.map(ll => new firebase.firestore.GeoPoint(ll.lat, ll.lng));
}
function pushAll() {
    if (!currentRef) return;
    currentRef.set({ points: geoPointArray(), updatedAt: Date.now() }, { merge: true });
}
function maybePush() {
    const now = Date.now();
    if (!currentRef || now - lastUpdate < UPDATE_EVERY_MS) return;
    lastUpdate = now;
    const payload = { points: geoPointArray(), updatedAt: now };
    currentRef.update(payload).catch(() => currentRef.set(payload, { merge: true }));
}

/* =========================
   GOMA (touch-friendly)
========================= */
const ERASE_TOLERANCE_PX = 22; // “ancho” de acierto alrededor del dedo
let erasing = false;

function enableEraser() {
    mode = 'eraser';
    eraserButton.classList.add('active');
    map.dragging.disable();
    hidePanel('panel');

    const c = map.getContainer();
    c.style.cursor = 'crosshair';
    c.style.touchAction = 'none';

    // Solo pointerdown para evitar duplicados click+pointer
    map.on('pointerdown', onErasePointer);

    // Limpieza por si versiones previas dejaron listeners en capas
    drawnItems.eachLayer(layer => {
        layer.off && layer.off('click');
        layer.off && layer.off('touchstart');
    });
}
function disableEraser() {
    if (mode === 'eraser') mode = 'idle';
    eraserButton.classList.remove('active');
    map.dragging.enable();
    showPanel('panel');

    const c = map.getContainer();
    c.style.cursor = '';
    c.style.touchAction = '';

    map.off('pointerdown', onErasePointer);
    erasing = false;
}

// Borra la polyline más cercana al toque si está dentro de la tolerancia
function onErasePointer(e) {
    if (mode !== 'eraser') return;

    // No borres si el toque viene de un control
    const src = e.originalEvent?.target;
    if (src && (src.closest('.leaflet-control') || src.closest('.pencil-wrapper'))) return;

    e.originalEvent?.preventDefault?.();
    e.originalEvent?.stopPropagation?.();

    if (erasing) return; // evita dobles disparos
    erasing = true;
    setTimeout(() => (erasing = false), 60);

    const latlng = e.latlng || map.mouseEventToLatLng(e.originalEvent);
    if (!latlng) return;

    const targetLayer = findClosestPolyline(latlng, ERASE_TOLERANCE_PX);
    if (!targetLayer) return;

    // feedback visual y háptico
    targetLayer.setStyle?.({ opacity: 0.25 });
    if (navigator.vibrate) navigator.vibrate(25);

    // eliminar de Firebase y del mapa
    const id = targetLayer._firebaseId;
    if (id) db.collection('shapes').doc(id).delete();
    drawnItems.removeLayer(targetLayer);
}

function findClosestPolyline(latlng, tolPx) {
    const p = map.latLngToLayerPoint(latlng);
    let best = null;
    let bestDist = Infinity;

    drawnItems.eachLayer(layer => {
        if (!(layer instanceof L.Polyline) || (layer instanceof L.Polygon)) return;

        const latlngs = layer.getLatLngs();
        const flat = Array.isArray(latlngs[0]) ? latlngs.flat() : latlngs; // MultiPolyline safe
        if (flat.length < 2) return;

        for (let i = 0; i < flat.length - 1; i++) {
            const a = map.latLngToLayerPoint(flat[i]);
            const b = map.latLngToLayerPoint(flat[i + 1]);
            const d = distPointToSegment(p, a, b);
            if (d < bestDist) { bestDist = d; best = layer; }
        }
    });

    return bestDist <= tolPx ? best : null;
}
function distPointToSegment(P, A, B) {
    const vx = B.x - A.x, vy = B.y - A.y;
    const wx = P.x - A.x, wy = P.y - A.y;
    const c1 = vx * wx + vy * wy;
    if (c1 <= 0) return Math.hypot(P.x - A.x, P.y - A.y);
    const c2 = vx * vx + vy * vy;
    if (c2 <= c1) return Math.hypot(P.x - B.x, P.y - B.y);
    const t = c1 / c2;
    const projX = A.x + t * vx;
    const projY = A.y + t * vy;
    return Math.hypot(P.x - projX, P.y - projY);
}
