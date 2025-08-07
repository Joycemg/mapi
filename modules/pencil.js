// modules/pencil.js
import { map } from './Map.js';
import { drawnItems } from './Draw.js';
import { db } from '../config/firebase.js';
import { hidePanel, showPanel } from './panel.js';

let isDrawing = false;
let currentLine = null;
let currentRef = null;
let points = []; // L.LatLng[]
let lastUpdate = 0;
const UPDATE_EVERY_MS = 100;

let selectedColor = 'black';
let selectedWeight = 2;
let pencilButton = null;
let eraserButton = null;

const PencilControl = L.Control.extend({
    options: { position: 'topleft' },
    onAdd() {
        const wrapper = L.DomUtil.create('div', 'leaflet-bar pencil-wrapper');
        pencilButton = createBtn('✏️', 'custom-pencil', 'Herramienta lápiz', wrapper, handlePencilClick);
        eraserButton = createBtn('🧽', 'custom-eraser', 'Goma', wrapper, handleEraserClick);
        wrapper.append(makeColorSel(wrapper), makeWeightSel(wrapper));
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
function makeColorSel(container) {
    const s = L.DomUtil.create('div', 'color-selector', container);
    ['black', 'white', 'red'].forEach(c => {
        const btn = L.DomUtil.create('div', `pencil-color ${c}`, s);
        btn.onclick = () => { selectedColor = c; if (pencilButton) pencilButton.style.backgroundColor = c; };
    });
    return s;
}
function makeWeightSel(container) {
    const s = L.DomUtil.create('div', 'weight-selector', container);
    [{ w: 2, l: 'Fino' }, { w: 4, l: 'Medio' }, { w: 6, l: 'Grueso' }].forEach(({ w, l }) => {
        const btn = L.DomUtil.create('div', 'weight-option', s);
        btn.innerHTML = `<div style="width:30px;height:0;border-top:${w}px solid black;margin-bottom:2px"></div>${l}`;
        btn.onclick = () => { selectedWeight = w;[...s.children].forEach(c => c.classList.remove('selected')); btn.classList.add('selected'); };
    });
    return s;
}
function toggleUI(d) {
    const p = pencilButton?.parentElement;
    p?.querySelector('.color-selector') && (p.querySelector('.color-selector').style.display = d);
    p?.querySelector('.weight-selector') && (p.querySelector('.weight-selector').style.display = d);
}
function handlePencilClick() { disableEraser(); pencilButton.classList.contains('active') ? disablePencil() : enablePencil(); }
function handleEraserClick() { disablePencil(); eraserButton.classList.contains('active') ? disableEraser() : enableEraser(); }

/* ======= LÁPIZ (eventos Leaflet) ======= */
function enablePencil() {
    pencilButton.classList.add('active');
    pencilButton.style.backgroundColor = selectedColor;
    toggleUI('flex');
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
    if (ev.originalEvent?.button !== undefined && ev.originalEvent.button !== 0) return;
    if (!goodStart(ev)) return;
    L.DomEvent.preventDefault(ev.originalEvent || ev);
    L.DomEvent.stopPropagation(ev.originalEvent || ev);

    isDrawing = true;
    const start = ev.latlng || map.mouseEventToLatLng(ev.originalEvent);
    points = [start];

    const id = `pencil-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    currentRef = db.collection('shapes').doc(id);

    const style = { color: selectedColor, weight: selectedWeight };
    const geoPoints = [new firebase.firestore.GeoPoint(start.lat, start.lng)];

    currentRef.set({ type: 'pencil', points: geoPoints, style, updatedAt: Date.now() });

    currentLine = L.polyline(points, style);
    currentLine._firebaseId = id;
    drawnItems.addLayer(currentLine);
    lastUpdate = 0;
}

function onMove(ev) {
    if (!isDrawing || !currentLine) return;
    const ll = ev.latlng || map.mouseEventToLatLng(ev.originalEvent);
    if (!ll) return;
    L.DomEvent.preventDefault(ev.originalEvent || ev);

    currentLine.addLatLng(ll);
    points.push(ll);
    maybePush();
}

function onUp(ev) {
    if (!isDrawing) return;
    L.DomEvent.preventDefault(ev?.originalEvent || ev);
    isDrawing = false;

    pushAll(); // guardar la geometría final
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
    currentRef.update({ points: geoPointArray(), updatedAt: now })
        .catch(() => currentRef.set({ points: geoPointArray(), updatedAt: now }, { merge: true }));
}

/* ======= GOMA ======= */
function enableEraser() {
    eraserButton.classList.add('active');
    map.dragging.disable();
    hidePanel('panel');
    map.getContainer().style.cursor = 'crosshair';

    drawnItems.eachLayer(layer => {
        if (layer instanceof L.Polyline && !(layer instanceof L.Polygon)) {
            layer.on('click', onEraseClick);
            layer.on('mouseover', () => layer.setStyle({ opacity: 0.4 }));
            layer.on('mouseout', () => layer.setStyle({ opacity: 1 }));
        }
    });
}
function disableEraser() {
    eraserButton.classList.remove('active');
    map.dragging.enable();
    showPanel('panel');
    map.getContainer().style.cursor = '';

    drawnItems.eachLayer(layer => {
        layer.off('click', onEraseClick);
        layer.off('mouseover'); layer.off('mouseout');
        layer.setStyle?.({ opacity: 1 });
    });
}
function onEraseClick(e) {
    const id = e.target._firebaseId;
    if (id) db.collection('shapes').doc(id).delete();
    drawnItems.removeLayer(e.target);
}
