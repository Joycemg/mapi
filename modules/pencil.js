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
let configPanel = null;

/* ===== Anti-fantasma ===== */
let suppressUntil = 0;
function swallowNext(ms = 180) { suppressUntil = Date.now() + ms; }

/* =========================
   Helpers UI
========================= */
const setStyles = (el, styles) => Object.assign(el.style, styles);

// versión compacta
const chipBase = {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    padding: '6px 8px',
    cursor: 'pointer',
    borderRadius: '8px',
    userSelect: 'none',
    border: '1px solid #e5e7eb',
    background: '#fafafa',
    minHeight: '36px'
};

const markSelected = (btn, group) => {
    [...group.children].forEach(c => {
        c.classList.remove('selected');
        c.style.background = '#fafafa';
        c.style.borderColor = '#e5e7eb';
        c.style.boxShadow = 'none';
    });
    btn.classList.add('selected');
    btn.style.background = '#eef4ff';
    btn.style.borderColor = '#bdd0ff';
    btn.style.boxShadow = '0 0 0 1px #bdd0ff inset';
};

const makeChip = (parent) => {
    const b = L.DomUtil.create('button', 'chip', parent);
    b.type = 'button';
    setStyles(b, chipBase);
    b.tabIndex = 0;
    b.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' || ev.key === ' ') {
            ev.preventDefault();
            b.click();
        }
    });
    // 🔒 no dejar que el touch llegue al mapa (pero sin cancelar el click)
    L.DomEvent.on(b, 'pointerdown', (e) => e.stopPropagation());
    L.DomEvent.on(b, 'touchstart', (e) => e.stopPropagation());
    return b;
};

/* =========================
   UI del control
========================= */
const PencilControl = L.Control.extend({
    options: { position: 'topleft' },
    onAdd() {
        const wrapper = L.DomUtil.create('div', 'leaflet-bar pencil-wrapper mobile-friendly');
        L.DomEvent.disableClickPropagation(wrapper);
        L.DomEvent.disableScrollPropagation(wrapper);
        setStyles(wrapper, { position: 'relative', overflow: 'visible' });

        // 🔒 Bloqueo suave: evita que el mapa reciba el evento, pero deja vivir el click
        L.DomEvent.on(wrapper, 'pointerdown', (e) => e.stopPropagation());
        L.DomEvent.on(wrapper, 'touchstart', (e) => e.stopPropagation());

        pencilButton = createBtn('✏️', 'custom-pencil', 'Dibujar', wrapper, handlePencilClick, true);
        eraserButton = createBtn('🧽', 'custom-eraser', 'Borrar', wrapper, handleEraserClick, false);

        // Guard suave en los botones (anti-fantasma)
        guardBtn(pencilButton);
        guardBtn(eraserButton);

        // Panel dropdown (compacto)
        configPanel = L.DomUtil.create('div', 'pencil-config-panel', wrapper);
        setStyles(configPanel, {
            position: 'absolute',
            top: '100%',
            left: '0',
            display: 'none',
            background: '#fff',
            border: '1px solid #d1d5db',
            borderRadius: '10px',
            boxShadow: '0 8px 20px rgba(0,0,0,.16)',
            zIndex: '2000',
            minWidth: '200px',
            padding: '8px'
        });
        L.DomEvent.disableClickPropagation(configPanel);
        L.DomEvent.disableScrollPropagation(configPanel);
        L.DomEvent.on(configPanel, 'pointerdown', (e) => e.stopPropagation());
        L.DomEvent.on(configPanel, 'touchstart', (e) => e.stopPropagation());

        // Grid 2 columnas
        const grid = L.DomUtil.create('div', 'pencil-grid', configPanel);
        setStyles(grid, {
            display: 'grid',
            gridTemplateColumns: '1fr 1fr',
            gap: '8px 12px',
            alignItems: 'start'
        });

        const colorWrap = L.DomUtil.create('div', 'pencil-section-colors', grid);
        colorWrap.innerHTML = `<div style="font:600 11px/1.1 system-ui, sans-serif;margin:0 0 6px;">Color</div>`;
        colorWrap.append(makeColorSelector());

        const weightWrap = L.DomUtil.create('div', 'pencil-section-weights', grid);
        weightWrap.innerHTML = `<div style="font:600 11px/1.1 system-ui, sans-serif;margin:0 0 6px;">Grosor</div>`;
        weightWrap.append(makeWeightSelector());

        const applyResponsive = () => {
            const oneCol = window.innerWidth < 360;
            grid.style.gridTemplateColumns = oneCol ? '1fr' : '1fr 1fr';
            configPanel.style.minWidth = oneCol ? '180px' : '200px';
        };
        applyResponsive();
        window.addEventListener('resize', applyResponsive);

        // Cierre
        document.addEventListener('click', onDocClickClose, true);
        document.addEventListener('keydown', onEscClose, true);

        toggleUI(false);
        updatePencilPreview();
        return wrapper;
    }
});

map.addControl(new PencilControl());

function createBtn(icon, cls, title, container, onClick, withPreview = false) {
    const a = L.DomUtil.create('a', cls, container);
    a.href = '#';
    a.title = title;
    a.setAttribute('role', 'button');
    a.setAttribute('aria-label', title);

    a.innerHTML = `<span class="icon" style="display:block;line-height:16px;text-align:center;">${icon}</span>`;

    // Solo previsualizador para el lápiz
    if (withPreview) {
        a.innerHTML += `<div class="stroke-preview" 
        style="width:20px;height:0;border-top:4px solid black;margin:4px auto 2px;border-radius:2px;"></div>`;
    }

    a.onclick = (e) => { e.preventDefault(); onClick(); };
    return a;
}

function guardBtn(el) {
    // No dejar que el touch llegue al mapa y activar ventana anti-fantasma
    L.DomEvent.on(el, 'pointerdown', (e) => { e.stopPropagation(); swallowNext(200); });
    L.DomEvent.on(el, 'touchstart', (e) => { e.stopPropagation(); swallowNext(200); });
}

/* =========================
   Selectores (sin texto en opciones)
========================= */
function makeColorSelector() {
    const s = L.DomUtil.create('div', 'color-selector');
    setStyles(s, { display: 'flex', flexDirection: 'column', gap: '6px' });

    const colors = ['black', 'white', '#e11d48', '#10b981'];

    colors.forEach((name) => {
        const btn = makeChip(s);
        btn.className = `chip color-chip`;
        btn.title = `Color ${name}`;
        btn.setAttribute('aria-label', `Color ${name}`);

        const svg = svgEl('svg', { width: 22, height: 22, viewBox: '0 0 22 22', style: 'margin:auto' });
        const circle = svgEl('circle', {
            cx: 11, cy: 11, r: 9,
            fill: name,
            stroke: (name === 'white' ? '#9ca3af' : 'none'),
            'stroke-width': 1
        });
        svg.appendChild(circle);
        btn.append(svg);

        if (selectedColor === name) markSelected(btn, s);

        btn.onclick = () => {
            selectedColor = name;
            markSelected(btn, s);
            updatePencilPreview();
            s.parentElement?.parentElement
                ?.querySelectorAll('.weight-chip svg line')
                .forEach(line => line.setAttribute('stroke', selectedColor));
        };
    });

    return s;
}

function makeWeightSelector() {
    const s = L.DomUtil.create('div', 'weight-selector');
    setStyles(s, { display: 'flex', flexDirection: 'column', gap: '6px' });

    const options = [2, 4, 6, 10];

    options.forEach((w) => {
        const btn = makeChip(s);
        btn.className = 'chip weight-chip';
        btn.title = `Grosor ${w}px`;
        btn.setAttribute('aria-label', `Grosor ${w}px`);

        const svg = svgEl('svg', { width: 60, height: 18, viewBox: '0 0 60 18', style: 'margin:auto' });
        const line = svgEl('line', {
            x1: 6, y1: 9, x2: 54, y2: 9,
            stroke: selectedColor,
            'stroke-width': String(w),
            'stroke-linecap': 'round'
        });
        svg.appendChild(line);
        btn.append(svg);

        if (selectedWeight === w) markSelected(btn, s);

        btn.onclick = () => {
            selectedWeight = w;
            markSelected(btn, s);
            updatePencilPreview();
        };
    });

    return s;
}

function svgEl(tag, attrs) {
    const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
    Object.entries(attrs || {}).forEach(([k, v]) => el.setAttribute(k, String(v)));
    return el;
}

function updatePencilPreview() {
    if (pencilButton) {
        const preview = pencilButton.querySelector('.stroke-preview');
        if (preview) preview.style.borderTop = `${selectedWeight}px solid ${selectedColor}`;
        pencilButton.style.boxShadow = (selectedColor === 'white')
            ? 'inset 0 0 0 2px rgba(0,0,0,.25)'
            : 'inset 0 0 0 2px rgba(0,0,0,.08)';
    }
    document.querySelectorAll('.weight-chip svg line').forEach(line => {
        line.setAttribute('stroke', selectedColor);
    });
}

function toggleUI(show) {
    if (!configPanel) return;
    configPanel.style.display = show ? 'block' : 'none';
}
function onDocClickClose(e) {
    if (!configPanel || mode !== 'pencil') return;
    const target = e.target;
    if (!target.closest('.pencil-wrapper')) toggleUI(false);
}
function onEscClose(e) {
    if (e.key === 'Escape' && mode === 'pencil') toggleUI(false);
}

/* =========================
   Botones (modes)
========================= */
function finishOrCancelStroke() {
    if (!isDrawing) return;
    // Si el trazo es mínimo, cancelar (no guardar)
    if (points.length < 2) {
        if (currentLine) drawnItems.removeLayer(currentLine);
        if (currentRef) db.collection('shapes').doc(currentRef.id).delete().catch(() => { });
    } else {
        pushAll();
    }
    isDrawing = false;
    currentLine = null;
    currentRef = null;
    points = [];
}

function handlePencilClick() {
    // cerrar/cancelar trazo activo y suprimir touch fantasma
    finishOrCancelStroke();
    swallowNext(200);

    disableEraser();
    (mode === 'pencil') ? disablePencil() : enablePencil();
}
function handleEraserClick() {
    finishOrCancelStroke();
    swallowNext(200);

    disablePencil();
    (mode === 'eraser') ? disableEraser() : enableEraser();
}

// Export util para apagar cualquier herramienta activa desde otros módulos
export function deactivateDrawingTools() {
    disablePencil();
    disableEraser();
}

/* =========================
   LÁPIZ (Leaflet events)
========================= */
function enablePencil() {
    mode = 'pencil';
    pencilButton.classList.add('active');
    toggleUI(true);
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
    toggleUI(false);

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
    // 🔒 bloquea cualquier control Leaflet y tu wrapper
    if (t.closest?.('.leaflet-control, .leaflet-bar, .pencil-wrapper')) return false;
    return true;
}

function onDown(ev) {
    if (mode !== 'pencil') return;
    // ⛔ ventana anti-fantasma
    if (Date.now() < suppressUntil) return;
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

const geoPointArray = () =>
    points.map(ll => new firebase.firestore.GeoPoint(ll.lat, ll.lng));

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
   GOMA
========================= */
const ERASE_TOLERANCE_PX = 22;
const ERASE_THROTTLE_MS = 40;
let erasingDrag = false;
let lastEraseTs = 0;

function enableEraser() {
    mode = 'eraser';
    eraserButton.classList.add('active');

    // Ocultar botón del lápiz mientras se usa la goma
    if (pencilButton) pencilButton.style.display = 'none';

    map.dragging.disable();
    hidePanel('panel');

    const c = map.getContainer();
    c.style.cursor = 'crosshair';
    c.style.touchAction = 'none';

    // Pointer Events
    map.on('pointerdown', onEraseDown);
    map.on('pointermove', onEraseMove);
    map.on('pointerup', onEraseUp);
    map.on('pointercancel', onEraseUp);

    // Fallback mouse clásico
    map.on('mousedown', onEraseMouseDown);
    map.on('mousemove', onEraseMouseMove);
    L.DomEvent.on(document, 'mouseup', onEraseMouseUp);

    drawnItems.eachLayer(layer => {
        layer.off && layer.off('click');
        layer.off && layer.off('touchstart');
    });

    toggleUI(false);
}

function disableEraser() {
    if (mode === 'eraser') mode = 'idle';
    eraserButton.classList.remove('active');

    // Mostrar de nuevo el botón del lápiz
    if (pencilButton) pencilButton.style.display = '';

    map.dragging.enable();
    showPanel('panel');

    const c = map.getContainer();
    c.style.cursor = '';
    c.style.touchAction = '';

    map.off('pointerdown', onEraseDown);
    map.off('pointermove', onEraseMove);
    map.off('pointerup', onEraseUp);
    map.off('pointercancel', onEraseUp);

    map.off('mousedown', onEraseMouseDown);
    map.off('mousemove', onEraseMouseMove);
    L.DomEvent.off(document, 'mouseup', onEraseMouseUp);

    erasingDrag = false;
    lastEraseTs = 0;
}

/* ----- Pointer Events ----- */
function onEraseDown(e) {
    if (mode !== 'eraser') return;
    if (!eraseShouldStart(e)) return;

    stopEvt(e);
    erasingDrag = true;
    lastEraseTs = 0;
    eraseAtEvent(e);
}
function onEraseMove(e) {
    if (mode !== 'eraser' || !erasingDrag) return;
    if (!throttleErase()) return;

    stopEvt(e);
    eraseAtEvent(e);
}
function onEraseUp(e) {
    if (mode !== 'eraser') return;
    stopEvt(e);
    erasingDrag = false;
}

/* ----- Fallback Mouse ----- */
function onEraseMouseDown(e) {
    if (mode !== 'eraser') return;
    if (e.originalEvent?.button !== undefined && e.originalEvent.button !== 0) return;
    if (!eraseShouldStart(e)) return;

    stopEvt(e);
    erasingDrag = true;
    lastEraseTs = 0;
    eraseAtEvent(e);
}
function onEraseMouseMove(e) {
    if (mode !== 'eraser' || !erasingDrag) return;
    if (!throttleErase()) return;

    stopEvt(e);
    eraseAtEvent(e);
}
function onEraseMouseUp(e) {
    if (mode !== 'eraser') return;
    stopEvt(e);
    erasingDrag = false;
}

/* ----- Utilidades de goma ----- */
function eraseShouldStart(e) {
    const src = e.originalEvent?.target;
    if (src && (src.closest('.leaflet-control') || src.closest('.leaflet-bar') || src.closest('.pencil-wrapper'))) return false;
    if (e.isPrimary === false) return false;
    if (e.button !== undefined && e.button !== 0) return false;
    return true;
}
function stopEvt(e) {
    e.originalEvent?.preventDefault?.();
    e.originalEvent?.stopPropagation?.();
}
function throttleErase() {
    const now = Date.now();
    if (now - lastEraseTs < ERASE_THROTTLE_MS) return false;
    lastEraseTs = now;
    return true;
}

function eraseAtEvent(e) {
    const latlng = e.latlng || map.mouseEventToLatLng(e.originalEvent);
    if (!latlng) return;

    const targetLayer = findClosestPolyline(latlng, ERASE_TOLERANCE_PX);
    if (!targetLayer) return;

    targetLayer.setStyle?.({ opacity: 0.25 });
    if (navigator.vibrate) navigator.vibrate(20);

    const id = targetLayer._firebaseId;
    if (id) db.collection('shapes').doc(id).delete();
    drawnItems.removeLayer(targetLayer);
}

function findClosestPolyline(latlng, tolPx) {
    const p = map.latLngToLayerPoint(latlng);
    let best = null, bestDist = Infinity;

    drawnItems.eachLayer(layer => {
        if (!(layer instanceof L.Polyline) || (layer instanceof L.Polygon)) return;
        const latlngs = layer.getLatLngs();
        const flat = Array.isArray(latlngs[0]) ? latlngs.flat() : latlngs;
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
