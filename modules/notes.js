// modules/notes.js
import { map } from './Map.js';
import { db } from '../config/firebase.js';
import { deactivateDrawingTools } from './pencil.js';

/** ================= Firestore seguro ================= */
function getFS() {
    try { if (db && typeof db.collection === 'function') return db; } catch { }
    const fs = (window.firebase && window.firebase.firestore)
        ? window.firebase.firestore()
        : null;
    if (!fs) console.error('[notes] Firestore no inicializado. Verifica config/firebase.js');
    return fs;
}
function getNotesRef() {
    const fs = getFS();
    if (!fs) throw new Error('Firestore no disponible');
    return fs.collection('notes');
}
const serverTime = () => {
    const fv = window.firebase?.firestore?.FieldValue;
    return fv?.serverTimestamp ? fv.serverTimestamp() : Date.now();
};

/** ================= Config ================= */
const DPR = Math.min(window.devicePixelRatio || 1, 2);
const ICON_SIZE = Math.round(24 * (DPR > 1 ? 1.05 : 1));
const ZOOM_LABEL = 15;
const FLYTO_ZOOM_DEFAULT = 18;

/** ================= Estado ================= */
let noteMode = false;
let noteBtn = null;
let labelVisible = false;
const noteMarkers = {};   // id -> { marker, data }
let rtUnsubscribe = null;
let controlAdded = false;

let listControlAdded = false;
let listBtn = null;
let listPanel = null;
let listFilter = '';
let listOpen = false;

let longPressTimer = null;
let longPressArmed = false;
let lastTouchLL = null;

const popupOpenBound = new WeakSet();
let creationPopup = null;
let clickLockTs = 0;

/** ====== Suprimir paneos por resize mientras se crea una nota ====== */
function setResizePanSuppressed(on) {
    window.__SUPPRESS_MAP_RESIZE_PAN__ = !!on;
}

/** ================= Pane propio ================= */
const notesPaneName = 'notesPane';
function ensureNotesPane() {
    if (!map.getPane(notesPaneName)) {
        const pane = map.createPane(notesPaneName);
        pane.classList.add('leaflet-zoom-hide');
        pane.style.zIndex = '650';
    }
}

/** ================= CSS ================= */
function ensureNotesCss() {
    const styleId = 'notes-divicon-style';
    if (document.getElementById(styleId)) return;
    const style = document.createElement('style');
    style.id = styleId;
    style.textContent = `
    .note-divicon { position: relative; will-change: transform; overflow: visible; }
    .note-divicon::after{ content:""; position:absolute; left:-10px; top:-10px; right:-10px; bottom:-10px; }

    .leaflet-bar.notes-wrapper a,
    .leaflet-bar.noteslist-wrapper a { width: 30px; height: 30px; line-height: 30px; text-align:center; }
    .leaflet-bar.notes-wrapper a.active,
    .leaflet-bar.noteslist-wrapper a.active { background:#2563eb; color:#fff; }

    .note-popup .leaflet-popup-content {
      max-height: 260px; overflow-y: auto; overflow-x: hidden; padding-right: 6px;
      scrollbar-gutter: stable; font: 13px/1.4 system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
    }
    .note-popup .note-scroll { max-height: 180px; overflow-y: auto; margin-bottom: 8px; scrollbar-gutter: stable; }

    .noteslist-panel {
      position: absolute; top: 36px; left: 0; width: 260px; max-height: 320px; background: #fff;
      border: 1px solid #d1d5db; border-radius: 8px; box-shadow: 0 8px 20px rgba(0,0,0,.12);
      overflow: hidden; display: none; z-index: 1001; font: 13px/1.4 system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
    }
    .noteslist-panel.open { display: block; }

    .noteslist-header { display:flex; gap:6px; align-items:center; padding:8px; border-bottom:1px solid #e5e7eb; background:#f9fafb; }
    .noteslist-header input { flex:1; border:1px solid #d1d5db; border-radius:6px; padding:6px 8px; }
    .noteslist-header button { border:1px solid #d1d5db; background:#fff; border-radius:6px; padding:6px 8px; cursor:pointer; }

    .noteslist-list { max-height: 260px; overflow: auto; }
    .noteslist-item { display:grid; grid-template-columns:1fr auto; gap:8px; padding:8px 10px; border-bottom:1px solid #f3f4f6; cursor:pointer; }
    .noteslist-item:hover { background:#f8fafc; }
    .noteslist-title { font-weight:600; color:#111827; }
    .noteslist-sub { font-size:11px; color:#6b7280; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    .noteslist-pill { align-self:center; font-size:10px; padding:2px 6px; border-radius:999px; border:1px solid #d1d5db; color:#374151; }
    .noteslist-empty { padding:12px; text-align:center; color:#6b7280; }

    .notes-toast{ position:fixed; left:50%; bottom:14px; transform:translateX(-50%);
      background:#111; color:#fff; padding:8px 12px; border-radius:8px; opacity:0; transition:opacity .2s ease; z-index:9999; pointer-events:none; font:13px/1.3 system-ui; }
    .notes-toast.show{ opacity:.96; }
  `;
    document.head.appendChild(style);
}

/** ================= Iconos ================= */
const PRESET_ICONS = [
    { value: 'shelter', label: 'Refugio (Casa)' }, { value: 'danger', label: 'Peligro (X)' },
    { value: 'skull', label: 'Calavera' }, { value: 'food', label: 'Comida' },
    { value: 'water', label: 'Agua' }, { value: 'supply', label: 'Suministros' },
    { value: 'exit', label: 'Salida' }, { value: 'flag', label: 'Bandera' },
    { value: 'camp', label: 'Fogata' }, { value: 'radio', label: 'Radio' },
    { value: 'medic', label: 'Médico (+)' }, { value: 'wrench', label: 'Herramienta' },
    { value: 'note', label: 'Nota' },
];
function svgEl(tag, attrs = {}) { const el = document.createElementNS('http://www.w3.org/2000/svg', tag); for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v)); return el; }
function presetLabelFor(value) { return PRESET_ICONS.find(p => p.value === value)?.label || 'Nota'; }
function escapeHtml(s) { return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }
function escapeAttr(s) { return escapeHtml(s); }
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

const innerSvgCache = new Map();
function buildPresetIconNode(type, size, color) {
    const key = `${type}|${color}|${size}`; let html = innerSvgCache.get(key);
    if (!html) {
        const wrap = document.createElement('div'); Object.assign(wrap.style, { width: `${size}px`, height: `${size}px`, display: 'grid', placeItems: 'center' });
        const svg = svgEl('svg', { width: size, height: size, viewBox: '0 0 24 24' }); const STROKE = '#111', FILL = '#fff', MAIN = color || '#000';
        switch (type) {
            case 'shelter': { svg.append(svgEl('path', { d: 'M3 11 L12 3 L21 11', fill: 'none', stroke: STROKE, 'stroke-width': 2, 'stroke-linejoin': 'round' }), svgEl('rect', { x: 6, y: 10, width: 12, height: 10, fill: MAIN, stroke: STROKE, 'stroke-width': 2, rx: 2 }), svgEl('rect', { x: 11, y: 14, width: 3, height: 6, fill: FILL, stroke: STROKE, 'stroke-width': 1.5, rx: .5 })); break; }
            case 'danger': { svg.append(svgEl('line', { x1: 5, y1: 5, x2: 19, y2: 19, stroke: MAIN, 'stroke-width': 4, 'stroke-linecap': 'round' }), svgEl('line', { x1: 19, y1: 5, x2: 5, y2: 19, stroke: MAIN, 'stroke-width': 4, 'stroke-linecap': 'round' }), svgEl('circle', { cx: 12, cy: 12, r: 10, fill: 'none', stroke: STROKE, 'stroke-width': 2 })); break; }
            case 'skull': { const head = svgEl('path', { d: 'M7 9a5 5 0 0 1 10 0v3a4 4 0 0 1-4 4v3H11v-3a4 4 0 0 1-4-4V9z', fill: MAIN, stroke: STROKE, 'stroke-width': 2 }); svg.append(head, svgEl('circle', { cx: 9.5, cy: 10.5, r: 1.5, fill: FILL, stroke: STROKE, 'stroke-width': 1 }), svgEl('circle', { cx: 14.5, cy: 10.5, r: 1.5, fill: FILL, stroke: STROKE, 'stroke-width': 1 }), svgEl('rect', { x: 10.5, y: 15, width: 3, height: 1.6, fill: FILL, stroke: STROKE, 'stroke-width': 1 })); break; }
            case 'food': { svg.append(svgEl('path', { d: 'M15 5c3 0 5 2 5 5s-2 6-6 6-5-2-6-3l5-8c1-0.5 1.5-1 2-1z', fill: MAIN, stroke: STROKE, 'stroke-width': 2 }), svgEl('path', { d: 'M4 20c-1.2 0-2-0.8-2-2s0.8-2 2-2c0-1.2 0.8-2 2-2s2 0.8 2 2-0.8 2-2 2c0 1.2-0.8 2-2 2z', fill: FILL, stroke: STROKE, 'stroke-width': 2 })); break; }
            case 'water': { svg.append(svgEl('path', { d: 'M12 3c3 4 6 7 6 10a6 6 0 1 1-12 0c0-3 3-6 6-10z', fill: MAIN, stroke: STROKE, 'stroke-width': 2 }), svgEl('path', { d: 'M9 14a3 3 0 0 0 3 3', fill: 'none', stroke: FILL, 'stroke-width': 2, 'stroke-linecap': 'round' })); break; }
            case 'supply': { svg.append(svgEl('rect', { x: 4, y: 6, width: 16, height: 12, fill: MAIN, stroke: STROKE, 'stroke-width': 2, rx: 2 }), svgEl('rect', { x: 11, y: 6, width: 2, height: 12, fill: FILL, opacity: .9 })); break; }
            case 'exit': { svg.append(svgEl('rect', { x: 7, y: 5, width: 10, height: 14, fill: FILL, stroke: STROKE, 'stroke-width': 2, rx: 1.5 }), svgEl('line', { x1: 4, y1: 12, x2: 12, y2: 12, stroke: MAIN, 'stroke-width': 2.5, 'stroke-linecap': 'round' }), svgEl('path', { d: 'M10 9 L14 12 L10 15 Z', fill: MAIN, stroke: STROKE, 'stroke-width': 1 })); break; }
            case 'flag': { svg.append(svgEl('line', { x1: 6, y1: 4, x2: 6, y2: 20, stroke: STROKE, 'stroke-width': 2 }), svgEl('path', { d: 'M6 5h10l-3 3 3 3H6z', fill: MAIN, stroke: STROKE, 'stroke-width': 1.5 })); break; }
            case 'camp': { svg.append(svgEl('path', { d: 'M12 6c2 2 2 3.5 0 5.5C10 10.5 10 8 12 6z', fill: MAIN, stroke: STROKE, 'stroke-width': 1.5 }), svgEl('line', { x1: 7, y1: 18, x2: 17, y2: 14, stroke: STROKE, 'stroke-width': 2, 'stroke-linecap': 'round' }), svgEl('line', { x1: 7, y1: 14, x2: 17, y2: 18, stroke: STROKE, 'stroke-width': 2, 'stroke-linecap': 'round' })); break; }
            case 'radio': { svg.append(svgEl('rect', { x: 4, y: 7, width: 16, height: 10, fill: FILL, stroke: STROKE, 'stroke-width': 2, rx: 2 }), svgEl('circle', { cx: 16, cy: 12, r: 2.5, fill: MAIN, stroke: STROKE, 'stroke-width': 1.5 }), svgEl('path', { d: 'M7 11h5', stroke: STROKE, 'stroke-width': 1.8, 'stroke-linecap': 'round' }), svgEl('line', { x1: 12, y1: 7, x2: 18, y2: 3, stroke: STROKE, 'stroke-width': 1.6 })); break; }
            case 'medic': { svg.append(svgEl('rect', { x: 5, y: 5, width: 14, height: 14, fill: FILL, stroke: STROKE, 'stroke-width': 2, rx: 3 }), svgEl('rect', { x: 11, y: 7, width: 2, height: 10, fill: MAIN }), svgEl('rect', { x: 7, y: 11, width: 10, height: 2, fill: MAIN })); break; }
            default: { svg.append(svgEl('rect', { x: 5, y: 4, width: 14, height: 16, rx: 2, fill: FILL, stroke: STROKE, 'stroke-width': 2 }), svgEl('path', { d: 'M15 4v5h5', fill: MAIN, stroke: STROKE, 'stroke-width': 1.5 }), svgEl('line', { x1: 7, y1: 11, x2: 13, y2: 11, stroke: MAIN, 'stroke-width': 1.8, 'stroke-linecap': 'round' }), svgEl('line', { x1: 7, y1: 14, x2: 15, y2: 14, stroke: MAIN, 'stroke-width': 1.8, 'stroke-linecap': 'round' }), svgEl('line', { x1: 7, y1: 17, x2: 12, y2: 17, stroke: MAIN, 'stroke-width': 1.8, 'stroke-linecap': 'round' })); }
        }
        wrap.appendChild(svg); html = wrap.innerHTML; innerSvgCache.set(key, html);
    }
    const node = document.createElement('div'); node.innerHTML = html; return node.firstChild;
}

/** ================= Controles ================= */
const NotesControl = L.Control.extend({
    options: { position: 'topleft' },
    onAdd() {
        const wrapper = L.DomUtil.create('div', 'leaflet-bar notes-wrapper');
        L.DomEvent.disableClickPropagation(wrapper); L.DomEvent.disableScrollPropagation(wrapper);
        Object.assign(wrapper.style, { position: 'relative', overflow: 'visible', zIndex: 1000 });
        noteBtn = createBtn('📝', 'notes-btn', 'Agregar nota', wrapper, toggleNoteMode);
        return wrapper;
    }
});
function addControlOnce() { if (controlAdded) return; map.addControl(new NotesControl()); controlAdded = true; }

const NotesListControl = L.Control.extend({
    options: { position: 'topleft' },
    onAdd() {
        const wrapper = L.DomUtil.create('div', 'leaflet-bar noteslist-wrapper');
        L.DomEvent.disableClickPropagation(wrapper); L.DomEvent.disableScrollPropagation(wrapper);
        Object.assign(wrapper.style, { position: 'relative', overflow: 'visible', zIndex: 1000 });
        listBtn = createBtn('📒', 'noteslist-btn', 'Notas (lista)', wrapper, toggleListPanel);
        listPanel = L.DomUtil.create('div', 'noteslist-panel', wrapper);
        listPanel.innerHTML = buildListPanelHtml(); bindListPanelEvents();
        return wrapper;
    }
});
function addListControlOnce() { if (listControlAdded) return; map.addControl(new NotesListControl()); listControlAdded = true; }

function createBtn(icon, cls, title, container, onClick) {
    const a = L.DomUtil.create('a', cls, container);
    a.href = '#'; a.setAttribute('role', 'button'); a.setAttribute('tabindex', '0'); a.setAttribute('aria-label', title);
    a.title = title; a.innerHTML = `<span style="display:block;line-height:16px;text-align:center;">${icon}</span>`;
    a.onclick = (e) => { e.preventDefault(); onClick(); };
    a.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); } };
    return a;
}

/** ============== Panel Lista ============== */
function toggleListPanel() {
    listOpen = !listOpen;
    if (!listPanel) return;
    listPanel.classList.toggle('open', listOpen);
    listBtn?.classList.toggle('active', listOpen);
    if (listOpen) {
        renderList();
        const input = listPanel.querySelector('.noteslist-filter'); input?.focus();
    }
}
document.addEventListener('pointerdown', (e) => {
    if (!listOpen || !listPanel) return;
    const inside = listPanel.contains(e.target) || listBtn?.contains(e.target);
    if (!inside) toggleListPanel();
});
function buildListPanelHtml() {
    return `
    <div class="noteslist-header">
      <input type="search" class="noteslist-filter" placeholder="Buscar notas..." />
      <button type="button" class="noteslist-clear" title="Limpiar búsqueda">✕</button>
    </div>
    <div class="noteslist-list"></div>
  `;
}
function bindListPanelEvents() {
    if (!listPanel) return;
    const input = listPanel.querySelector('.noteslist-filter');
    const clear = listPanel.querySelector('.noteslist-clear');
    input?.addEventListener('input', (e) => { listFilter = String(e.target.value || '').toLowerCase(); renderListDebounced(); });
    clear?.addEventListener('click', () => { listFilter = ''; if (input) input.value = ''; renderList(); input?.focus(); });
    const listEl = listPanel.querySelector('.noteslist-list');
    listEl?.addEventListener('click', (ev) => {
        const item = ev.target.closest('.noteslist-item'); if (!item) return;
        const id = item.getAttribute('data-id'); if (!id || !noteMarkers[id]) return;
        if (listOpen) toggleListPanel();
        openNote(id);
    });
}
const renderListDebounced = debounce(renderList, 80);
function renderList() {
    if (!listPanel) return;
    const listEl = listPanel.querySelector('.noteslist-list'); if (!listEl) return;
    const items = Object.entries(noteMarkers).map(([id, rec]) => {
        const d = rec.data || {}; return { id, title: d.title || 'Nota', body: d.body || '', iconType: d.iconType || 'note', updatedAt: d.updatedAt || d.createdAt || 0 };
    });
    let filtered = items;
    if (listFilter) {
        const q = listFilter; filtered = items.filter(it => it.title.toLowerCase().includes(q) || it.body.toLowerCase().includes(q));
    }
    filtered.sort((a, b) => (b.updatedAt - a.updatedAt));
    if (filtered.length === 0) { listEl.innerHTML = `<div class="noteslist-empty">No hay notas${listFilter ? ' que coincidan.' : '.'}</div>`; return; }
    listEl.innerHTML = filtered.map(it => {
        const typeLabel = presetLabelFor(it.iconType);
        const sub = it.body ? it.body.replace(/\s+/g, ' ').slice(0, 80) : '';
        return `
      <div class="noteslist-item" data-id="${it.id}" title="Ir a: ${escapeHtml(it.title)}">
        <div>
          <div class="noteslist-title">${escapeHtml(it.title)}</div>
          ${sub ? `<div class="noteslist-sub">${escapeHtml(sub)}</div>` : ''}
        </div>
        <div class="noteslist-pill">${escapeHtml(typeLabel)}</div>
      </div>`;
    }).join('');
}

/** ============== Fly/open popup ============== */
function getClampedFlyToZoom() {
    const maxZ = typeof map.getMaxZoom === 'function' ? map.getMaxZoom() : 17;
    const current = map.getZoom();
    return Math.min(Math.max(current, FLYTO_ZOOM_DEFAULT), maxZ);
}
function openNote(id) {
    const rec = noteMarkers[id]; if (!rec) return;
    const { marker } = rec; const ll = marker.getLatLng();
    try { deactivateDrawingTools?.(); } catch { }
    map.closePopup();
    const targetZoom = getClampedFlyToZoom();
    let opened = false;
    const open = () => { if (opened) return; opened = true; try { marker.openPopup(); } catch { } map.off('moveend', open); };
    map.once('moveend', open);
    const fallback = setTimeout(open, 900);
    const onceOpen = () => { clearTimeout(fallback); marker.off('popupopen', onceOpen); };
    marker.on('popupopen', onceOpen);
    map.flyTo(ll, targetZoom, { animate: true, duration: .6 });
}

/** ============== Modo Nota: bloquear “saltos” en móvil ============== */
function disableMapInteractionsForNoteMode() {
    // gestiona en Map.js con el guard de resize
    setResizePanSuppressed(true);
    try {
        map.dragging?.disable(); map.touchZoom?.disable(); map.doubleClickZoom?.disable();
        map.scrollWheelZoom?.disable(); map.boxZoom?.disable(); map.keyboard?.disable(); map.tap?.disable?.();
    } catch { }
}
function restoreMapInteractions() {
    setResizePanSuppressed(false);
    try {
        map.dragging?.enable(); map.touchZoom?.enable(); map.doubleClickZoom?.enable();
        map.scrollWheelZoom?.enable(); map.boxZoom?.enable(); map.keyboard?.enable(); map.tap?.enable?.();
    } catch { }
}

function toggleNoteMode() { noteMode ? disableNoteMode() : enableNoteMode(); }
function enableNoteMode() {
    noteMode = true; noteBtn?.classList.add('active');
    try { deactivateDrawingTools?.(); } catch { }
    const c = map.getContainer(); c.style.cursor = 'crosshair'; c.style.touchAction = 'none';
    disableMapInteractionsForNoteMode();

    map.off('click', onMapClickAddNote);
    map.on('click', onMapClickAddNote);

    // Capturar lat/lng exacta del dedo (para usarla en el click)
    map.on('touchstart', (e) => { lastTouchLL = latLngFromTouchEvent(e) || null; }, { passive: true });

    longPressArmed = true;
    map.on('touchstart', onTouchStartLP, { passive: true });
    map.on('touchmove', cancelLongPress, { passive: true });
    map.on('touchend', cancelLongPress, { passive: true });
}
function disableNoteMode() {
    noteMode = false; noteBtn?.classList.remove('active');
    const c = map.getContainer(); c.style.cursor = ''; c.style.touchAction = '';
    restoreMapInteractions();

    map.off('click', onMapClickAddNote);
    map.off('touchstart', onTouchStartLP);
    map.off('touchmove', cancelLongPress);
    map.off('touchend', cancelLongPress);
    map.off('touchstart'); // quita el capturador de lastTouchLL

    longPressArmed = false; cancelLongPress();

    if (creationPopup) { try { map.closePopup(creationPopup); } catch { } creationPopup = null; }
}

function onTouchStartLP(e) {
    if (!noteMode || !longPressArmed) return;
    cancelLongPress();
    const touchLL = latLngFromTouchEvent(e);
    longPressTimer = setTimeout(() => {
        const target = touchLL || map.getCenter();
        onMapClickAddNote({ latlng: target });
    }, 600);
}
function cancelLongPress() { if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; } }

/** ============== Crear Nota (sin autoPan y usando latlng real) ============== */
function onMapClickAddNote(e) {
    if (!noteMode) return;
    const now = Date.now(); if (now - clickLockTs < 250) return; clickLockTs = now;

    // usar la lat/lng real del toque si la tenemos
    const latlng = lastTouchLL || e.latlng; lastTouchLL = null;
    if (!latlng) return;

    if (creationPopup) { try { map.closePopup(creationPopup); } catch { } creationPopup = null; }

    creationPopup = L.popup({
        closeOnClick: false, autoClose: false, maxWidth: 360, className: 'note-popup',
        autoPan: false, keepInView: false, offset: L.point(0, -10) // no empuja el mapa
    }).setLatLng(latlng)
        .setContent(createFormHtml())
        .openOn(map);

    // mientras esté el popup de creación, suprimir paneos por resize
    setResizePanSuppressed(true);

    const root = creationPopup.getElement();
    L.DomEvent.disableClickPropagation(root);
    L.DomEvent.disableScrollPropagation(root);

    const formEl = root?.querySelector('.note-form');
    const titleEl = root?.querySelector('.note-title');
    const bodyEl = root?.querySelector('.note-body');
    const colorWrap = root?.querySelector('.note-color-wrap');
    const iconSel = root?.querySelector('.note-icon-type');

    let pickedColor = '#000000';
    colorWrap?.querySelectorAll('button[data-color]').forEach(btn => {
        if (btn.getAttribute('data-color') === pickedColor) selectSwatch(btn, colorWrap);
        btn.addEventListener('click', (ev) => { ev.preventDefault(); pickedColor = btn.getAttribute('data-color') || '#000000'; selectSwatch(btn, colorWrap); });
    });

    formEl?.addEventListener('submit', async (ev) => {
        ev.preventDefault(); L.DomEvent.stop(ev);
        const title = titleEl?.value.trim() || 'Nota';
        const body = bodyEl?.value.trim() || '';
        const color = pickedColor;
        const iconType = iconSel?.value || 'shelter';
        let ref; try { ref = getNotesRef(); } catch (err) { console.error('[notes] FS:', err); toast('Firestore no está inicializado.'); return; }
        try {
            await ref.add({ title, body, color, iconType, lat: latlng.lat, lng: latlng.lng, createdAt: serverTime(), updatedAt: serverTime() });
            toast('Nota guardada');
        } catch (err) { console.error('[notes] add error:', err); toast('No se pudo guardar la nota', 'error'); return; }
        try { map.closePopup(creationPopup); } catch { } creationPopup = null;
        setResizePanSuppressed(false);
        disableNoteMode();
    });

    root?.querySelector('.note-cancel')?.addEventListener('click', (ev) => {
        ev.preventDefault(); L.DomEvent.stop(ev);
        try { map.closePopup(creationPopup); } catch { } creationPopup = null;
        setResizePanSuppressed(false);
        disableNoteMode();
    });
}

function selectSwatch(btn, wrap) {
    wrap.querySelectorAll('button[data-color]').forEach(b => { b.style.outline = 'none'; b.style.boxShadow = 'none'; });
    btn.style.outline = '2px solid #3b82f6'; btn.style.boxShadow = '0 0 0 2px rgba(59,130,246,.35)';
}
function createFormHtml() {
    const options = PRESET_ICONS.map(o => `<option value="${o.value}">${o.label}</option>`).join('');
    const colorBtn = (hex, title) => `<button type="button" data-color="${hex}" title="${title}"
     style="width:28px;height:28px;border-radius:50%;border:1px solid #d1d5db;background:${hex};display:inline-block;cursor:pointer;"></button>`;
    return `
    <form class="note-form" style="font: 13px/1.4 system-ui, sans-serif;">
      <div style="display:grid; grid-template-columns:1fr; gap:6px; margin-bottom:6px;">
        <input class="note-title" type="text" placeholder="Título" maxlength="80"
               style="border:1px solid #d1d5db;border-radius:6px;padding:6px 8px;" />
      </div>
      <div class="note-color-wrap" style="display:flex; align-items:center; gap:8px; margin-bottom:6px;">
        <span style="font-size:12px;color:#374151;">Color:</span>
        ${colorBtn('#ffffff', 'Blanco')}${colorBtn('#000000', 'Negro')}${colorBtn('#e11d48', 'Rojo')}${colorBtn('#10b981', 'Verde')}
      </div>
      <div style="display:grid; grid-template-columns:1fr; gap:6px; margin-bottom:6px;">
        <select class="note-icon-type" title="Icono"
                style="border:1px solid #d1d5db;border-radius:6px;padding:6px 8px;">${options}</select>
      </div>
      <textarea class="note-body" placeholder="Detalle..." rows="3" maxlength="1000"
        style="width:100%;height:120px;max-height:120px;overflow:auto;border:1px solid #d1d5db;border-radius:6px;padding:6px 8px;resize:vertical;"></textarea>
      <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:8px;">
        <button type="button" class="note-cancel" 
          style="border:1px solid #e5e7eb;border-radius:6px;padding:6px 10px;background:#f3f4f6;cursor:pointer;">Cancelar</button>
        <button type="submit"
          style="border:1px solid #2563eb;border-radius:6px;padding:6px 10px;background:#2563eb;color:#fff;cursor:pointer;">Guardar</button>
      </div>
    </form>`;
}

/** ================= Icono + label ================= */
function buildNoteDivHtml(data) {
    const title = data.title || 'Nota'; const color = data.color || '#000000'; const type = data.iconType || 'shelter'; const size = ICON_SIZE;
    const wrap = document.createElement('div');
    Object.assign(wrap.style, { position: 'relative', width: `${size + 6}px`, height: `${size + 6}px`, borderRadius: '50%', border: '2px solid black', background: 'white', display: 'grid', placeItems: 'center', boxSizing: 'border-box', overflow: 'visible' });
    const inner = document.createElement('div');
    Object.assign(inner.style, { width: `${size + 2}px`, height: `${size + 2}px`, borderRadius: '50%', background: '#fff', display: 'grid', placeItems: 'center' });
    inner.appendChild(buildPresetIconNode(type, size, color)); wrap.appendChild(inner);
    if (labelVisible) {
        const label = document.createElement('div'); label.textContent = title;
        Object.assign(label.style, { position: 'absolute', top: `-${Math.max(18, Math.round(size * .9))}px`, left: '50%', transform: 'translateX(-50%)', padding: '0 4px', font: '600 11px/1 system-ui, sans-serif', background: 'rgba(255,255,255,.95)', borderRadius: '4px', whiteSpace: 'nowrap', border: '1px solid #d1d5db', pointerEvents: 'none' });
        wrap.appendChild(label);
    }
    return wrap.outerHTML;
}
function makeNoteIcon(data) {
    const size = ICON_SIZE + 6;
    return L.divIcon({ html: buildNoteDivHtml(data), className: 'note-divicon', iconSize: [size, size], iconAnchor: [size / 2, size / 2], popupAnchor: [0, -Math.max(18, Math.round(ICON_SIZE * .9))] });
}

/** ================= Toast ================= */
function toast(msg, type = 'info') { try { const el = document.createElement('div'); el.className = `notes-toast notes-${type}`; el.textContent = msg; document.body.appendChild(el); requestAnimationFrame(() => el.classList.add('show')); setTimeout(() => { el.classList.remove('show'); el.remove(); }, 2600); } catch { } }

/** ================= Borrado ================= */
async function safeDeleteNote(id) {
    if (!id) { toast('ID de nota inválido', 'error'); return; }
    const rec = noteMarkers[id]; if (rec) { try { map.removeLayer(rec.marker); } catch { } delete noteMarkers[id]; }
    renderListDebounced(); try { map.closePopup(); } catch { }
    try { await getNotesRef().doc(id).delete(); toast('Nota borrada'); } catch (err) { console.error('[notes] delete error:', err); toast('No se pudo borrar la nota', 'error'); }
}

/** ================= Popup ver/editar ================= */
function viewHtml(title, body, color = '#000') {
    return `
    <div class="note-view" style="min-width:260px; font: 13px/1.4 system-ui, sans-serif;">
      <div style="display:flex; align-items:center; gap:8px; margin-bottom:6px;">
        <div style="width:10px;height:10px;border-radius:50%;background:${color};border:1px solid #111"></div>
        <strong class="note-title-view" title="Doble clic para editar">${escapeHtml(title || 'Nota')}</strong>
      </div>
      <div class="note-scroll">${body ? `<div style="white-space:pre-wrap;">${escapeHtml(body)}</div>` : ''}</div>
      <div style="display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap;margin-top:8px;">
        <button type="button" class="note-edit"   style="border:1px solid #d1d5db;border-radius:6px;padding:4px 8px;background:#fff;cursor:pointer;">Editar</button>
        <button type="button" class="note-delete" style="border:1px solid #ef4444;border-radius:6px;padding:4px 8px;background:#ef4444;color:#fff;cursor:pointer;">Borrar</button>
      </div>
    </div>`;
}
function bindNotePopup(marker, id, data) {
    marker.off('popupopen'); marker.unbindPopup();
    marker.bindPopup(viewHtml(data.title, data.body, data.color), { className: 'note-popup', maxWidth: 360, autoPan: false, keepInView: false });
    marker.on('popupopen', (e) => {
        if (popupOpenBound.has(e.popup)) return; popupOpenBound.add(e.popup);
        try { deactivateDrawingTools?.(); } catch { }
        const cont = e.popup.getElement(); L.DomEvent.disableClickPropagation(cont); L.DomEvent.disableScrollPropagation(cont);
        cont?.querySelector('.note-delete')?.addEventListener('click', async (ev) => { ev.preventDefault(); L.DomEvent.stop(ev); ev.stopPropagation?.(); ev.stopImmediatePropagation?.(); await safeDeleteNote(id); });
        cont?.querySelector('.note-edit')?.addEventListener('click', (ev) => { ev.preventDefault(); L.DomEvent.stop(ev); openEditForm(e, marker, id, data); });
        cont?.querySelector('.note-title-view')?.addEventListener('dblclick', () => quickEditTitle(e, marker, id, data));
    });
}
function openEditForm(e, marker, id, data) {
    const formHtml = `
    <form class="note-edit-form" style="font: 13px/1.3 system-ui, sans-serif;">
      <div style="display:grid; grid-template-columns:1fr; gap:6px; margin-bottom:6px;">
        <input class="note-title" type="text" value="${escapeAttr(data.title || 'Nota')}" maxlength="80" style="border:1px solid #d1d5db;border-radius:6px;padding:6px 8px;" />
      </div>
      <textarea class="note-body" rows="3" maxlength="1000" style="width:100%;height:120px;max-height:120px;overflow:auto;border:1px solid #d1d5db;border-radius:6px;padding:6px 8px;resize:vertical;">${escapeHtml(data.body || '')}</textarea>
      <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:8px;">
        <button type="button" class="note-cancel" style="border:1px solid #e5e7eb;border-radius:6px;padding:6px 10px;background:#f3f4f6;cursor:pointer;">Cancelar</button>
        <button type="submit" style="border:1px solid #2563eb;border-radius:6px;padding:6px 10px;background:#2563eb;color:#fff;cursor:pointer;">Guardar</button>
      </div>
    </form>`;
    e.popup.setContent(formHtml);
    const root = e.popup.getElement(); L.DomEvent.disableClickPropagation(root); L.DomEvent.disableScrollPropagation(root);
    const form = root?.querySelector('.note-edit-form'); const titleEl = root?.querySelector('.note-title'); const bodyEl = root?.querySelector('.note-body');
    form?.addEventListener('submit', async (ev2) => {
        ev2.preventDefault(); L.DomEvent.stop(ev2);
        const title = titleEl?.value.trim() || 'Nota'; const body = bodyEl?.value.trim() || '';
        try {
            await getNotesRef().doc(id).update({ title, body, updatedAt: serverTime() });
            data.title = title; data.body = body;
            e.popup.setContent(viewHtml(title, body, data.color)); marker.setIcon(makeNoteIcon(data)); renderListDebounced(); marker.openPopup(); toast('Nota actualizada');
        } catch (err) { console.error('[notes] update error:', err); toast('No se pudo actualizar', 'error'); }
    });
    root?.querySelector('.note-cancel')?.addEventListener('click', (ev2) => { ev2.preventDefault(); L.DomEvent.stop(ev2); e.popup.setContent(viewHtml(data.title, data.body, data.color)); marker.openPopup(); });
}
function quickEditTitle(e, marker, id, data) {
    const root = e.popup.getElement(); const strong = root?.querySelector('.note-title-view'); if (!strong) return;
    const input = document.createElement('input'); input.value = strong.textContent || 'Nota'; input.style.cssText = 'border:1px solid #d1d5db;border-radius:6px;padding:4px 6px;'; strong.replaceWith(input); input.focus(); input.select();
    const commit = async () => { const newTitle = (input.value || 'Nota').trim() || 'Nota'; try { await getNotesRef().doc(id).update({ title: newTitle, updatedAt: serverTime() }); data.title = newTitle; marker.setIcon(makeNoteIcon(data)); renderListDebounced(); e.popup.setContent(viewHtml(newTitle, data.body, data.color)); marker.openPopup(); toast('Título actualizado'); } catch (err) { console.error('[notes] quick title update error:', err); toast('No se pudo actualizar', 'error'); } };
    input.addEventListener('blur', commit, { once: true });
    input.addEventListener('keydown', (ke) => { if (ke.key === 'Enter') { ke.preventDefault(); commit(); } if (ke.key === 'Escape') { e.popup.setContent(viewHtml(data.title, data.body, data.color)); marker.openPopup(); } });
}

/** ================= Render / Sync ================= */
function renderOrUpdateNote(id, data) {
    if (typeof data?.lat !== 'number' || typeof data?.lng !== 'number') return;
    const ll = L.latLng(data.lat, data.lng);
    if (!noteMarkers[id]) {
        const marker = L.marker(ll, { icon: makeNoteIcon(data), pane: notesPaneName }).addTo(map);
        noteMarkers[id] = { marker, data };
        const stop = (ev) => { ev.originalEvent?.preventDefault?.(); ev.originalEvent?.stopPropagation?.(); try { deactivateDrawingTools?.(); } catch { } };
        marker.on('click', stop); marker.on('touchstart', stop);
        bindNotePopup(marker, id, data);
    } else {
        const rec = noteMarkers[id]; rec.marker.setLatLng(ll); rec.data = data; rec.marker.setIcon(makeNoteIcon(data)); bindNotePopup(rec.marker, id, data);
    }
    if (listOpen) renderListDebounced();
}
async function loadExistingNotesOnce() {
    try {
        const ref = getNotesRef(); let snap;
        try { snap = await ref.orderBy('updatedAt', 'desc').get(); } catch { snap = await ref.get(); }
        snap.forEach(doc => renderOrUpdateNote(doc.id, doc.data()));
    } catch (err) { console.error('[notes] get() error:', err); toast('No se pudieron cargar notas', 'error'); }
}
function startRealtime() {
    try {
        if (typeof rtUnsubscribe === 'function') { rtUnsubscribe(); rtUnsubscribe = null; }
        rtUnsubscribe = getNotesRef().onSnapshot((snap) => {
            snap.docChanges().forEach((ch) => {
                const id = ch.doc.id;
                if (ch.type === 'added' || ch.type === 'modified') { renderOrUpdateNote(id, ch.doc.data()); }
                else if (ch.type === 'removed') { if (noteMarkers[id]) { map.removeLayer(noteMarkers[id].marker); delete noteMarkers[id]; } if (listOpen) renderListDebounced(); }
            });
        }, (err) => { console.error('[notes] onSnapshot error:', err); toast('Desconectado de tiempo real', 'error'); });
    } catch (err) { console.error('[notes] No se pudo iniciar onSnapshot:', err); }
}

/** ================= Labels por zoom ================= */
function refreshAllNoteIcons() { for (const id in noteMarkers) { const { data, marker } = noteMarkers[id]; marker.setIcon(makeNoteIcon(data)); } }
function onZoom() { const visible = map.getZoom() >= ZOOM_LABEL; if (visible !== labelVisible) { labelVisible = visible; refreshAllNoteIcons(); } }
function setupZoomLabelBehavior() { labelVisible = map.getZoom() >= ZOOM_LABEL; map.off('zoomend', onZoom); map.on('zoomend', onZoom); refreshAllNoteIcons(); }

/** ================= Init ================= */
function initNotes() {
    ensureNotesPane();
    ensureNotesCss();
    addControlOnce();
    addListControlOnce();
    setupZoomLabelBehavior();
    loadExistingNotesOnce();
    startRealtime();
}
if (map && typeof map.whenReady === 'function') { map.whenReady(() => { try { initNotes(); } catch (e) { console.error('[notes] init error:', e); } }); }
else { try { initNotes(); } catch (e) { console.error('[notes] init error (fallback):', e); } }

/** ================= Exports ================= */
export function toggleNotes() { noteMode ? disableNoteMode() : enableNoteMode(); }
export function enableNotes() { enableNoteMode(); }
export function disableNotes() { disableNoteMode(); }
export function toggleNotesList() { toggleListPanel(); }

// Crear nota programáticamente
export async function addNoteAt(lat, lng, { title = 'Nota', body = '', color = '#000', iconType = 'note' } = {}) {
    const ref = getNotesRef();
    const doc = await ref.add({ title, body, color, iconType, lat, lng, createdAt: serverTime(), updatedAt: serverTime() });
    return doc.id;
}
