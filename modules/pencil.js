// modules/pencil.js
import { map } from './Map.js';
import { drawnItems } from './Draw.js';
import { db } from '../config/firebase.js';
import { hidePanel, showPanel } from './panel.js';


import { registerTool, toggleTool, activateTool, deactivateTool, isToolActive } from './toolsBus.js';
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
function swallowNext(ms = 220) { suppressUntil = Date.now() + ms; }

/* =========================
   Helpers UI
========================= */
const setStyles = (el, styles) => Object.assign(el.style, styles);

const chipBase = {
    display: 'flex',
    alignItems: 'center',
    gap: '1px',
    padding: '1px 2px',
    cursor: 'pointer',
    borderRadius: '8px',
    userSelect: 'none',
    border: '1px solid #e5e7eb',
    background: '#fafafa',
    minHeight: '15px'
};

const markSelected = (btn, group) => {
    [...group.children].forEach(c => {
        c.classList.remove('selected');
        c.style.background = '#fafafa';
        c.style.borderColor = '#e5e7eb';
        c.style.boxShadow = 'none';
        c.style.outline = 'none';
    });
    btn.classList.add('selected');
    btn.style.background = '#eef4ff';
    btn.style.borderColor = '#bdd0ff';
    btn.style.boxShadow = '0 0 0 1px #bdd0ff inset';
    btn.style.outline = '2px solid #2563eb';
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
    L.DomEvent.on(b, 'pointerdown', (e) => e.stopPropagation());
    L.DomEvent.on(b, 'touchstart', (e) => e.stopPropagation());
    return b;
};

/* ===== Helpers puntero/UI ===== */
function getClientXY(ev) {
    const oe = ev.originalEvent;
    if (!oe) return null;
    if (oe.touches && oe.touches[0]) return { x: oe.touches[0].clientX, y: oe.touches[0].clientY };
    if (oe.changedTouches && oe.changedTouches[0]) return { x: oe.changedTouches[0].clientX, y: oe.changedTouches[0].clientY };
    if (typeof oe.clientX === 'number' && typeof oe.clientY === 'number') return { x: oe.clientX, y: oe.clientY };
    return null;
}
function isOverUI(ev) {
    const p = getClientXY(ev);
    if (!p) return false;
    const el = document.elementFromPoint(p.x, p.y);
    return !!el?.closest?.('.leaflet-control, .leaflet-bar, .pencil-wrapper');
}

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

        // Evitar que el mapa reciba el pointer/touch desde la UI
        L.DomEvent.on(wrapper, 'pointerdown', (e) => e.stopPropagation());
        L.DomEvent.on(wrapper, 'touchstart', (e) => e.stopPropagation());

        // Si el dedo entra al wrapper mientras dibujo, cerrar/cancelar trazo
        L.DomEvent.on(wrapper, 'pointerenter', () => {
            if (isDrawing) { finishOrCancelStroke(); swallowNext(240); }
        });

        pencilButton = createBtn('✏️', 'custom-pencil', 'Dibujar', wrapper, handlePencilClick, true);
        eraserButton = createBtn('🧽', 'custom-eraser', 'Borrar', wrapper, handleEraserClick, false);

        guardBtn(pencilButton);
        guardBtn(eraserButton);

        // Panel
        configPanel = L.DomUtil.create('div', 'pencil-config-panel', wrapper);
        setStyles(configPanel, {
            position: 'absolute',
            top: '0',        // 👈 alinear arriba con el botón
            left: '100%',    // 👈 desplazar a la derecha del botón
            marginLeft: '6px', // 👈 pequeña separación para que no se pegue
            display: 'none',
            background: '#fff',
            border: '1px solid #d1d5db',
            borderRadius: '10px',
            boxShadow: '0 8px 20px rgba(0,0,0,.16)',
            zIndex: '2000',
            minWidth: '200px',
            padding: '6px'
        });
        L.DomEvent.disableClickPropagation(configPanel);
        L.DomEvent.disableScrollPropagation(configPanel);
        L.DomEvent.on(configPanel, 'pointerdown', (e) => e.stopPropagation());
        L.DomEvent.on(configPanel, 'touchstart', (e) => e.stopPropagation());

        /* ======= Header compacto con botón cerrar ======= */
        const header = L.DomUtil.create('div', 'pencil-header', configPanel);
        setStyles(header, {
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            gap: '8px', padding: '2px 2px 6px 2px'
        });
        const title = L.DomUtil.create('div', '', header);
        title.textContent = 'Lápiz';
        setStyles(title, { font: '600 12px/1.2 system-ui, sans-serif', color: '#111827' });

        const closeBtn = L.DomUtil.create('button', 'pencil-close', header);
        closeBtn.type = 'button';
        closeBtn.innerHTML = '✕';
        setStyles(closeBtn, {
            border: '1px solid #e5e7eb', borderRadius: '6px',
            background: '#fff', cursor: 'pointer',
            width: '24px', height: '22px', lineHeight: '20px', padding: '0',
            font: '600 12px/1 system-ui, sans-serif'
        });
        L.DomEvent.on(closeBtn, 'click', (e) => { e.preventDefault(); toggleUI(false); });

        /* ======= Controles compactos ======= */
        const toolbar = L.DomUtil.create('div', 'pencil-toolbar', configPanel);
        setStyles(toolbar, {
            display: 'grid',
            gridTemplateColumns: 'auto 1fr',
            gap: '6px 10px',
            alignItems: 'center'
        });

        const colorLabel = L.DomUtil.create('div', '', toolbar);
        colorLabel.textContent = '🎨';
        setStyles(colorLabel, { fontSize: '14px', textAlign: 'center', width: '18px' });
        toolbar.append(makeColorSelector(true));  // compacto

        const weightLabel = L.DomUtil.create('div', '', toolbar);
        weightLabel.textContent = '📏';
        setStyles(weightLabel, { fontSize: '14px', textAlign: 'center', width: '18px' });
        toolbar.append(makeWeightSelector(true)); // compacto

        const applyResponsive = () => {
            const oneCol = window.innerWidth < 360;
            configPanel.style.minWidth = oneCol ? '23px' : '23px';
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


// === toolsBus: registro de herramientas (exclusivo) ===
try {
    registerTool('pencil', {
        sticky: true,
        enable: () => enablePencil(),
        disable: () => disablePencil(),
        isActive: () => mode === 'pencil',
        // Soporta tanto el botón del control Leaflet como un botón opcional en tu HTML
        buttons: ['#btn-pencil']
    });

    registerTool('eraser', {
        sticky: true,
        enable: () => enableEraser(),
        disable: () => disableEraser(),
        isActive: () => mode === 'eraser',
        buttons: ['#btn-eraser']
    });
} catch (e) { console.error('[pencil] toolsBus register error:', e); }


function createBtn(icon, cls, title, container, onClick, withPreview = false) {
    const a = L.DomUtil.create('a', cls, container);
    a.href = '#';
    a.title = title;
    a.setAttribute('role', 'button');
    a.setAttribute('aria-label', title);

    a.innerHTML = `<span class="icon" style="display:block;line-height:16px;text-align:center;">${icon}</span>`;
    if (withPreview) {
        a.innerHTML += `<div class="stroke-preview" 
        style="width:20px;height:0;border-top:4px solid black;margin:4px auto 2px;border-radius:2px;"></div>`;
    }
    a.onclick = (e) => { e.preventDefault(); onClick(); };
    return a;
}

function guardBtn(el) {
    L.DomEvent.on(el, 'pointerdown', (e) => { e.stopPropagation(); swallowNext(260); });
    L.DomEvent.on(el, 'touchstart', (e) => { e.stopPropagation(); swallowNext(260); });
}

/* =========================
   Selectores (compactos)
========================= */
function makeColorSelector(/* compacto = false (ya no lo necesitamos) */) {
    const wrap = L.DomUtil.create('div', 'color-selector');
    // Grid: 2 por fila
    setStyles(wrap, {
        display: 'grid',
        gridTemplateColumns: 'repeat(2, auto)',
        columnGap: '10px',
        rowGap: '8px',
        alignItems: 'center',
        justifyItems: 'start'
    });

    const colors = ['black', 'white', '#e11d48', '#10b981'];

    const mark = (btn) => {
        [...wrap.children].forEach(el => {
            el.style.outline = 'none';
            el.style.boxShadow = 'none';
            el.style.borderColor = '#d1d5db';
        });
        btn.style.outline = '2px solid #2563eb';
        btn.style.boxShadow = '0 0 0 2px rgba(37,99,235,.25)';
        btn.style.borderColor = '#2563eb';
    };

    colors.forEach((name) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'color-chip';
        btn.dataset.color = name;
        btn.title = `Color ${name}`;
        btn.setAttribute('aria-label', `Color ${name}`);

        const size = 15;
        setStyles(btn, {
            width: `${size}px`,
            height: `${size}px`,
            borderRadius: '50%',
            border: `1px solid #d1d5db`,
            background: name,
            cursor: 'pointer',
            display: 'inline-block'
        });
        if (name === 'white') btn.style.boxShadow = 'inset 0 0 0 1px #9ca3af';

        wrap.append(btn);

        if (selectedColor === name) mark(btn);

        btn.onclick = () => {
            selectedColor = name;
            mark(btn);
            updatePencilPreview();
            // actualizar previews de peso
            wrap.parentElement?.parentElement
                ?.querySelectorAll('.weight-chip svg line')
                .forEach(line => line.setAttribute('stroke', selectedColor));
        };

        L.DomEvent.on(btn, 'pointerdown', (e) => e.stopPropagation());
        L.DomEvent.on(btn, 'touchstart', (e) => e.stopPropagation());
    });

    return wrap;
}
function makeWeightSelector(/* compacto = false (ya no lo necesitamos) */) {
    const wrap = L.DomUtil.create('div', 'weight-selector');
    // Grid: 2 por fila
    setStyles(wrap, {
        display: 'grid',
        gridTemplateColumns: 'repeat(2, auto)',
        columnGap: '10px',
        rowGap: '8px',
        alignItems: 'center',
        justifyItems: 'start'
    });

    const options = [2, 4, 6, 10];

    options.forEach((w) => {
        const btn = makeChip(wrap);
        btn.className = 'chip weight-chip';
        btn.title = `Grosor ${w}px`;
        btn.setAttribute('aria-label', `Grosor ${w}px`);

        // Compacto y pareja visual con 2 por fila
        setStyles(btn, {
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '0 4px',
            borderRadius: '8px',
            border: '1px solid #e5e7eb',
            background: '#fafafa',
            minHeight: '15px',
            height: '15px'
        });

        const width = 20;
        const height = 18;

        const svg = svgEl('svg', { width, height, viewBox: `0 0 ${width} ${height}` });
        const line = svgEl('line', {
            x1: 6, y1: height / 2, x2: width - 6, y2: height / 2,
            stroke: selectedColor,
            'stroke-width': String(w),
            'stroke-linecap': 'round'
        });
        svg.appendChild(line);
        btn.innerHTML = '';
        btn.append(svg);

        const selectBtn = () => {
            [...wrap.children].forEach(c => {
                c.classList.remove('selected');
                c.style.background = '#fafafa';
                c.style.borderColor = '#e5e7eb';
                c.style.boxShadow = 'none';
                c.style.outline = 'none';
            });
            btn.classList.add('selected');
            btn.style.background = '#eef4ff';
            btn.style.borderColor = '#bdd0ff';
            btn.style.boxShadow = '0 0 0 1px #bdd0ff inset';
            btn.style.outline = '2px solid #2563eb';
        };

        if (selectedWeight === w) selectBtn();

        btn.onclick = () => {
            selectedWeight = w;
            selectBtn();
            updatePencilPreview();
        };
    });

    return wrap;
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
    // cancelar/terminar trazo actual para evitar estados colgados
    finishOrCancelStroke();
    swallowNext(260);
    // Exclusivo via bus: alternar herramienta lápiz
    if (typeof toggleTool === 'function') toggleTool('pencil', { manual: true });
}

function handleEraserClick() {
    // cancelar/terminar trazo actual para evitar estados colgados
    finishOrCancelStroke();
    swallowNext(260);
    // Exclusivo via bus: alternar herramienta goma
    if (typeof toggleTool === 'function') toggleTool('eraser', { manual: true });
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

    // 🔐 Redes de seguridad adicionales:
    // 1) si el puntero sale del mapa, terminar/cancelar
    L.DomEvent.on(map.getContainer(), 'pointerleave', onMapPointerLeave);
    // 2) escucha global en captura: si el dedo cae sobre UI, cortar
    document.addEventListener('pointermove', onGlobalPointerMove, true);
    document.addEventListener('pointerup', onGlobalPointerUp, true);
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

    // quitar redes de seguridad
    L.DomEvent.off(map.getContainer(), 'pointerleave', onMapPointerLeave);
    document.removeEventListener('pointermove', onGlobalPointerMove, true);
    document.removeEventListener('pointerup', onGlobalPointerUp, true);

    isDrawing = false; currentLine = null; currentRef = null; points = [];
}

function onMapPointerLeave() {
    if (!isDrawing) return;
    finishOrCancelStroke();
    swallowNext(280);
}

function onGlobalPointerMove(e) {
    if (!isDrawing) return;
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (el && el.closest('.leaflet-control, .leaflet-bar, .pencil-wrapper')) {
        finishOrCancelStroke();
        swallowNext(280);
    }
}
function onGlobalPointerUp() {
    // si se suelta fuera del mapa, cerrar limpio
    if (isDrawing) {
        pushAll();
        isDrawing = false;
        currentRef = null;
        points = [];
    }
}

function goodStart(ev) {
    const t = ev.originalEvent?.target;
    if (!t) return true;
    if (t.closest?.('.leaflet-marker-icon')) return false;
    if (t.closest?.('.leaflet-popup')) return false;
    if (t.closest?.('.leaflet-control, .leaflet-bar, .pencil-wrapper')) return false;
    return true;
}

function onDown(ev) {
    if (mode !== 'pencil') return;
    if (Date.now() < suppressUntil) return;
    if (ev.originalEvent?.button !== undefined && ev.originalEvent.button !== 0) return;
    if (!goodStart(ev)) return;
    if (isOverUI(ev)) return;

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
    if (mode !== 'pencil') return;
    if (!isDrawing || !currentLine) return;

    // si el puntero entra en UI, cortar ya
    if (isOverUI(ev)) {
        finishOrCancelStroke();
        swallowNext(260);
        return;
    }

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

    pushAll();
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

    if (pencilButton) pencilButton.style.display = 'none';

    map.dragging.disable();
    hidePanel('panel');

    const c = map.getContainer();
    c.style.cursor = 'crosshair';
    c.style.touchAction = 'none';

    map.on('pointerdown', onEraseDown);
    map.on('pointermove', onEraseMove);
    map.on('pointerup', onEraseUp);
    map.on('pointercancel', onEraseUp);

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

(function ensurePencilCss() {
    const id = 'pencil-active-style';
    if (document.getElementById(id)) return;
    const style = document.createElement('style');
    style.id = id;
    style.textContent = `
    .pencil-wrapper a.active{
      background:#2563eb!important;
      color:#fff!important;
      box-shadow:0 0 0 2px rgba(37,99,235,.25);
    }
    /* Si querés que la goma se vea distinta al lápiz */
    .pencil-wrapper .custom-eraser.active{
      background:#ef4444!important;
      color:#fff!important;
      box-shadow:0 0 0 2px rgba(239,68,68,.25);
    }
  `;
    document.head.appendChild(style);
})();