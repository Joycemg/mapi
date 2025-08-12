// modules/notes.js
// Notas con: crear/editar en modal centrado, borrar con pass "456", lista 📒 con búsqueda y salto,
// íconos (incluye Refugio) y colores (blanco/negro/verde/rojo).
// Anti-deriva: modal dentro del contenedor del mapa + L.Icon (SVG data URL, anchor fijo). Pane propio.
// Mejoras: cache de íconos, batch de snapshot con rAF, render condicional, orden por cercanía a la vista.
// Integración: toolsBus (exclusividad). Tools: "notes" (modo crear), "notes-list" (lista), "notes-edit" (acción momentánea).
// Nuevo: Suscripción pausable por visibilidad + rehidratación desde localStorage con TTL.

import { map } from './Map.js';
import { db } from '../config/firebase.js';
import { registerTool, toggleTool, activateTool } from './toolsBus.js';

/* ================= Firestore ================= */
function getFS() {
    try { if (db && typeof db.collection === 'function') return db; } catch { }
    const fs = (window.firebase && window.firebase.firestore)
        ? window.firebase.firestore()
        : null;
    if (!fs) console.error('[notes] Firestore no inicializado (revisá config/firebase.js)');
    return fs;
}
function notesRef() {
    const fs = getFS();
    if (!fs) throw new Error('Firestore no disponible');
    return fs.collection('notes');
}
const serverTime = () => {
    const fv = window.firebase?.firestore?.FieldValue;
    return fv?.serverTimestamp ? fv.serverTimestamp() : Date.now();
};
function tsToMs(v) {
    if (typeof v === 'number') return v;
    if (v?.toMillis) try { return v.toMillis(); } catch { }
    if (v && typeof v.seconds === 'number') return v.seconds * 1000 + (v.nanoseconds || 0) / 1e6;
    if (v instanceof Date) return v.getTime();
    return 0;
}

/* ================= Estado ================= */
let noteMode = false;
let noteBtn = null;
const markers = new Map();     // id -> L.marker
const notesData = new Map();   // id -> data
let unsub = null;              // suscripción Firestore activa

// creación/edición/borrado
let creationModal = null;
let creationLatLng = null;
let editModal = null;
let deleteModal = null;

/* ===== Lista ===== */
let listBtn = null;
let listPanel = null;
let listOpen = false;
let listFilter = '';

/* ===== Pane (NO superponer a otros) ===== */
const NOTES_PANE = 'notesPane';
const NOTES_PANE_Z = 580;
function ensureNotesPane() {
    if (!map.getPane(NOTES_PANE)) {
        const pane = map.createPane(NOTES_PANE);
        pane.style.zIndex = String(NOTES_PANE_Z);
    }
}

/* ================= Helpers UI ================= */
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

function ensureCssOnce() {
    const id = 'notes-min-css';
    if (document.getElementById(id)) return;
    const s = document.createElement('style');
    s.id = id;
    s.textContent = `
  .leaflet-bar.notes, .leaflet-bar.noteslist { position: relative; }
  .leaflet-bar.notes a, .leaflet-bar.noteslist a { width:30px; height:30px; line-height:30px; text-align:center; }
  .leaflet-bar.notes a.active, .leaflet-bar.noteslist a.active { background:#2563eb; color:#fff; }

  /* Lista */
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
  .noteslist-foot { padding:8px 10px; font-size:12px; color:#6b7280; border-top:1px solid #f3f4f6; }

  /* Modales */
  .notes-modal-backdrop{
    position:absolute; inset:0; z-index:2000;
    display:grid; place-items:center;
    background: rgba(0,0,0,.25);
  }
  .notes-modal{
    width:min(92vw, 420px);
    max-height:80vh; overflow:auto;
    background:#fff; border-radius:10px;
    box-shadow: 0 12px 30px rgba(0,0,0,.25);
    padding:12px; border:1px solid #e5e7eb;
    font: 13px/1.4 system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
  }

  .notes-actions{ display:flex; justify-content:flex-end; gap:8px; margin-top:8px; }
  .btn{ border-radius:6px; padding:6px 10px; cursor:pointer; border:1px solid transparent; }
  .btn-cancel{ border-color:#e5e7eb; background:#f3f4f6; }
  .btn-primary{ border-color:#2563eb; background:#2563eb; color:#fff; }
  .btn-danger{ border-color:#ef4444; background:#ef4444; color:#fff; }

  .notes-toast{ position:fixed; left:50%; bottom:14px; transform:translateX(-50%);
    background:#111; color:#fff; padding:8px 12px; border-radius:8px; opacity:0;
    transition:opacity .2s ease; z-index:9999; pointer-events:none; font:13px/1.3 system-ui;}
  .notes-toast.show{ opacity:.96; }
  `;
    document.head.appendChild(s);
}
function toast(msg) {
    try {
        const el = document.createElement('div');
        el.className = 'notes-toast';
        el.textContent = msg;
        document.body.appendChild(el);
        requestAnimationFrame(() => el.classList.add('show'));
        setTimeout(() => { el.classList.remove('show'); el.remove(); }, 2200);
    } catch { }
}

/* ==== Helpers para coords / clipboard / Street View ==== */
const fmt = (n, d = 6) => (isFinite(n) ? Number(n).toFixed(d) : '');

async function copyToClipboard(text) {
    if (!text) return false;
    if (navigator.clipboard?.writeText) {
        try { await navigator.clipboard.writeText(text); return true; } catch { }
    }
    // fallback
    const ta = document.createElement('textarea');
    ta.value = text; ta.setAttribute('readonly', '');
    ta.style.position = 'absolute'; ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.focus(); ta.select(); ta.setSelectionRange(0, ta.value.length);
    let ok = false; try { ok = document.execCommand('copy'); } catch { }
    document.body.removeChild(ta);
    return ok;
}

function openStreetView(lat, lng) {
    if (!isFinite(lat) || !isFinite(lng)) { toast('Coordenadas inválidas'); return; }
    const url = `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${lat},${lng}`;
    try { window.open(url, '_blank', 'noopener'); }
    catch { location.href = url; }
}

/* ================= Iconos ================= */
const PRESET_ICONS = [
    { value: 'note', label: 'Nota' },
    { value: 'shelter', label: 'Refugio' },
    { value: 'flag', label: 'Bandera' },
    { value: 'danger', label: 'Peligro' },
    { value: 'water', label: 'Agua' },
    { value: 'food', label: 'Comida' },
    { value: 'medic', label: 'Médico' },
    { value: 'camp', label: 'Fogata' },
];
const PRESET_COLORS = [
    { hex: '#ffffff', label: 'Blanco' },
    { hex: '#000000', label: 'Negro' },
    { hex: '#10b981', label: 'Verde' },
    { hex: '#e11d48', label: 'Rojo' },
];

const ICON_SIZE = 28;
const ICON_ANCHOR = [14, 14];
const iconCache = new Map(); // key: `${type}|${color}` -> L.Icon

function swatchBtn(hex, title, selected = false) {
    return `<button type="button" class="note-color-swatch" data-color="${hex}" title="${title}"
    style="width:28px;height:28px;border-radius:50%;border:1px solid #d1d5db;background:${hex};cursor:pointer;${selected ? 'outline:2px solid #3b82f6;box-shadow:0 0 0 2px rgba(59,130,246,.35);' : ''}"></button>`;
}

function svgFor(type, color = '#000000') {
    const STROKE = '#111', FILL = '#fff', MAIN = color;
    switch (type) {
        case 'shelter':
            return `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
        <path d="M3 11 L12 3 L21 11" fill="none" stroke="${STROKE}" stroke-width="2" stroke-linejoin="round"/>
        <rect x="6" y="10" width="12" height="10" fill="${MAIN}" stroke="${STROKE}" stroke-width="2" rx="2"/>
        <rect x="11" y="14" width="3" height="6" fill="${FILL}" stroke="${STROKE}" stroke-width="1.5" rx="0.5"/>
      </svg>`;
        case 'flag':
            return `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><line x1="6" y1="4" x2="6" y2="20" stroke="${STROKE}" stroke-width="2"/><path d="M6 5h10l-3 3 3 3H6z" fill="${MAIN}" stroke="${STROKE}" stroke-width="1.5"/></svg>`;
        case 'danger':
            return `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><line x1="5" y1="5" x2="19" y2="19" stroke="${MAIN}" stroke-width="4" stroke-linecap="round"/><line x1="19" y1="5" x2="5" y2="19" stroke="${MAIN}" stroke-width="4" stroke-linecap="round"/><circle cx="12" cy="12" r="10" fill="none" stroke="${STROKE}" stroke-width="2"/></svg>`;
        case 'water':
            return `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M12 3c3 4 6 7 6 10a6 6 0 1 1-12 0c0-3 3-6 6-10z" fill="${MAIN}" stroke="${STROKE}" stroke-width="2"/><path d="M9 14a3 3 0 0 0 3 3" fill="none" stroke="${FILL}" stroke-width="2" stroke-linecap="round"/></svg>`;
        case 'food':
            return `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M15 5c3 0 5 2 5 5s-2 6-6 6-5-2-6-3l5-8c1-0.5 1.5-1 2-1z" fill="${MAIN}" stroke="${STROKE}" stroke-width="2"/><path d="M4 20c-1.2 0-2-0.8-2-2s0.8-2 2-2c0-1.2 0.8-2 2-2s2 0.8 2 2-0.8 2-2 2c0 1.2-0.8 2-2 2z" fill="${FILL}" stroke="${STROKE}" stroke-width="2"/></svg>`;
        case 'medic':
            return `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><rect x="5" y="5" width="14" height="14" fill="${FILL}" stroke="${STROKE}" stroke-width="2" rx="3"/><rect x="11" y="7" width="2" height="10" fill="${MAIN}"/><rect x="7" y="11" width="10" height="2" fill="${MAIN}"/></svg>`;
        case 'camp':
            return `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M12 6c2 2 2 3.5 0 5.5C10 10.5 10 8 12 6z" fill="${MAIN}" stroke="${STROKE}" stroke-width="1.5"/><line x1="7" y1="18" x2="17" y2="14" stroke="${STROKE}" stroke-width="2" stroke-linecap="round"/><line x1="7" y1="14" x2="17" y2="18" stroke="${STROKE}" stroke-width="2" stroke-linecap="round"/></svg>`;
        default:
            return `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><rect x="5" y="4" width="14" height="16" rx="2" fill="#fff" stroke="${STROKE}" stroke-width="2"/><path d="M15 4v5h5" fill="${MAIN}" stroke="${STROKE}" stroke-width="1.5"/><line x1="7" y1="11" x2="13" y2="11" stroke="${MAIN}" stroke-width="1.8" stroke-linecap="round"/><line x1="7" y1="14" x2="15" y2="14" stroke="${MAIN}" stroke-width="1.8" stroke-linecap="round"/><line x1="7" y1="17" x2="12" y2="17" stroke="${MAIN}" stroke-width="1.8" stroke-linecap="round"/></svg>`;
    }
}
function getIcon(type = 'note', color = '#000000') {
    const key = `${type}|${color}`;
    if (iconCache.has(key)) return iconCache.get(key);

    const inner = svgFor(type, color).replace(/<\?xml.*\?>/g, '').replace('<svg', '<g').replace('</svg>', '</g>');
    const svg = encodeURIComponent(`
    <svg xmlns="http://www.w3.org/2000/svg" width="${ICON_SIZE}" height="${ICON_SIZE}" viewBox="0 0 28 28">
      <circle cx="14" cy="14" r="12" fill="#fff" stroke="#111" stroke-width="2"/>
      <g transform="translate(2,2) scale(1)">${inner}</g>
    </svg>
  `.trim());
    const url = `data:image/svg+xml;charset=UTF-8,${svg}`;
    const icon = L.icon({
        iconUrl: url,
        iconSize: [ICON_SIZE, ICON_SIZE],
        iconAnchor: ICON_ANCHOR,
        popupAnchor: [0, -14],
        className: 'note-icon'
    });
    iconCache.set(key, icon);
    return icon;
}

/* ================= Controles ================= */
const NotesControl = L.Control.extend({
    options: { position: 'topleft' },
    onAdd() {
        const w = L.DomUtil.create('div', 'leaflet-bar notes');
        const a = L.DomUtil.create('a', '', w);
        a.href = '#';
        a.title = 'Agregar nota';
        a.setAttribute('aria-label', 'Agregar nota');
        a.textContent = '📝';
        a.onclick = (e) => { e.preventDefault(); toggleTool('notes', { manual: true }); }; // BUS
        L.DomEvent.disableClickPropagation(w);
        L.DomEvent.disableScrollPropagation(w);
        noteBtn = a;
        return w;
    }
});

const NotesListControl = L.Control.extend({
    options: { position: 'topleft' },
    onAdd() {
        const wrapper = L.DomUtil.create('div', 'leaflet-bar noteslist');
        L.DomEvent.disableClickPropagation(wrapper);
        L.DomEvent.disableScrollPropagation(wrapper);
        Object.assign(wrapper.style, { position: 'relative', overflow: 'visible', zIndex: 1000 });

        listBtn = L.DomUtil.create('a', '', wrapper);
        listBtn.href = '#';
        listBtn.title = 'Notas (lista)';
        listBtn.setAttribute('aria-label', 'Notas (lista)');
        listBtn.textContent = '📒';
        listBtn.onclick = (e) => { e.preventDefault(); toggleTool('notes-list', { manual: true }); }; // BUS

        listPanel = L.DomUtil.create('div', 'noteslist-panel', wrapper);
        listPanel.innerHTML = buildListPanelHtml();
        bindListPanelEvents();

        return wrapper;
    }
});

/* ============== Lista ============== */
function buildListPanelHtml() {
    return `
  <div class="noteslist-header">
    <input type="search" class="noteslist-filter" placeholder="Buscar notas..." />
    <button type="button" class="noteslist-clear" title="Limpiar búsqueda">✕</button>
  </div>
  <div class="noteslist-list"></div>`;
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
        const id = item.getAttribute('data-id'); if (!id || !markers.get(id)) return;
        if (listOpen) closeListPanel();      // cerrar lista al saltar
        openNote(id);
    });
    // cerrar al click afuera
    document.addEventListener('pointerdown', (e) => {
        if (!listOpen || !listPanel) return;
        const inside = listPanel.contains(e.target) || listBtn?.contains(e.target);
        if (!inside) closeListPanel();
    });

    // Reordenar por cercanía cuando cambie la vista
    map.on('moveend zoomend', () => { if (listOpen) renderListDebounced(); });
}
function openListPanel() {
    if (listOpen || !listPanel) return;
    listOpen = true;
    listPanel.classList.add('open');
    listBtn?.classList.add('active');
    renderList();
    const input = listPanel.querySelector('.noteslist-filter'); input?.focus();
}
function closeListPanel() {
    if (!listOpen || !listPanel) return;
    listOpen = false;
    listPanel.classList.remove('open');
    listBtn?.classList.remove('active');
}
const renderListDebounced = debounce(renderList, 80);

function renderList() {
    if (!listPanel) return;
    const listEl = listPanel.querySelector('.noteslist-list'); if (!listEl) return;

    const center = map.getCenter();
    const bounds = map.getBounds();

    // datos base
    let items = Array.from(notesData.entries()).map(([id, d]) => ({
        id,
        title: d.title || 'Nota',
        body: d.body || '',
        iconType: d.iconType || 'note',
        updated: tsToMs(d.updatedAt) || tsToMs(d.createdAt) || 0,
        lat: d.lat, lng: d.lng
    }));

    // filtro por texto
    if (listFilter) {
        const q = listFilter;
        items = items.filter(it =>
            (it.title + ' ' + it.body).toLowerCase().includes(q)
        );
    }

    // orden: en viewport primero, luego por distancia al centro, luego updated desc
    const centerLL = L.latLng(center.lat, center.lng);
    items.forEach(it => {
        const ll = L.latLng(it.lat, it.lng);
        it.inView = bounds.contains(ll) ? 1 : 0;
        it.dist = ll.distanceTo(centerLL) || Number.POSITIVE_INFINITY;
    });
    items.sort((a, b) => {
        if (b.inView !== a.inView) return b.inView - a.inView;
        if (a.dist !== b.dist) return a.dist - b.dist;
        return b.updated - a.updated;
    });

    // recorte por rendimiento si la lista es enorme
    const HARD_LIMIT = 300;
    const SHOW = items.slice(0, HARD_LIMIT);
    const hiddenCount = items.length - SHOW.length;

    if (SHOW.length === 0) {
        listEl.innerHTML = `<div class="noteslist-empty" style="padding:10px 12px;color:#6b7280;">No hay notas${listFilter ? ' que coincidan.' : '.'}</div>`;
        return;
    }

    // render
    listEl.innerHTML = SHOW.map(it => {
        const label = PRESET_ICONS.find(p => p.value === it.iconType)?.label || 'Nota';
        const sub = it.body ? it.body.replace(/\s+/g, ' ').slice(0, 80) : '';
        return `
      <div class="noteslist-item" data-id="${it.id}" title="Ir a: ${escapeHtml(it.title)}">
        <div>
          <div class="noteslist-title">${escapeHtml(it.title)}</div>
          ${sub ? `<div class="noteslist-sub">${escapeHtml(sub)}</div>` : ''}
        </div>
        <div class="noteslist-pill">${escapeHtml(label)}</div>
      </div>`;
    }).join('') + (hiddenCount > 0 ? `<div class="noteslist-foot">+${hiddenCount} más (acotado por rendimiento)</div>` : '');
}

/* ================= Modales ================= */
function modalCreateHtml() {
    return `
  <form class="note-form">
    <div style="display:grid; gap:6px; margin-bottom:6px;">
      <input class="note-title" type="text" placeholder="Título" maxlength="80"
             style="border:1px solid #d1d5db;border-radius:6px;padding:6px 8px;" />
    </div>
    <div style="display:grid; gap:6px; margin-bottom:6px;">
      <select class="note-icon-type" title="Icono"
              style="border:1px solid #d1d5db;border-radius:6px;padding:6px 8px;">
        ${PRESET_ICONS.map(o => `<option value="${o.value}">${o.label}</option>`).join('')}
      </select>
    </div>
    <div class="note-color-wrap" style="display:flex; align-items:center; gap:8px; margin-bottom:6px;">
      <span style="font-size:12px;color:#374151;">Color:</span>
      ${PRESET_COLORS.map(c => swatchBtn(c.hex, c.label, c.hex === '#000000')).join('')}
      <input type="hidden" class="note-color" value="#000000" />
    </div>
    <textarea class="note-body" placeholder="Detalle..." rows="3" maxlength="1000"
      style="width:100%;height:120px;max-height:120px;overflow:auto;border:1px solid #d1d5db;border-radius:6px;padding:6px 8px;resize:vertical;"></textarea>
    <div class="notes-actions">
      <button type="button" class="btn btn-cancel">Cancelar</button>
      <button type="submit" class="btn btn-primary">Guardar</button>
    </div>
  </form>`;
}
function modalEditHtml(d) {
    const currentColor = d.color || '#000000';
    return `
  <form class="note-edit-form" style="font: 13px/1.3 system-ui, sans-serif;">
    <div style="display:grid; gap:6px; margin-bottom:6px;">
      <input class="note-title" type="text" value="${escapeAttr(d.title || 'Nota')}" maxlength="80"
             style="border:1px solid #d1d5db;border-radius:6px;padding:6px 8px;" />
    </div>
    <div style="display:grid; gap:6px; margin-bottom:6px;">
      <select class="note-icon-type" title="Icono" style="border:1px solid #d1d5db;border-radius:6px;padding:6px 8px;">
        ${PRESET_ICONS.map(o => `<option value="${o.value}" ${o.value === (d.iconType || 'note') ? 'selected' : ''}>${o.label}</option>`).join('')}
      </select>
    </div>
    <div class="note-color-wrap" style="display:flex; align-items:center; gap:8px; margin-bottom:6px;">
      <span style="font-size:12px;color:#374151;">Color:</span>
      ${PRESET_COLORS.map(c => swatchBtn(c.hex, c.label, c.hex === currentColor)).join('')}
      <input type="hidden" class="note-color" value="${escapeAttr(currentColor)}" />
    </div>
    <textarea class="note-body" rows="3" maxlength="1000"
      style="width:100%;height:120px;max-height:120px;overflow:auto;border:1px solid #d1d5db;border-radius:6px;padding:6px 8px;resize:vertical;">${escapeHtml(d.body || '')}</textarea>
    <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:8px;">
      <button type="button" class="btn btn-cancel">Cancelar</button>
      <button type="submit" class="btn btn-primary">Guardar</button>
    </div>
  </form>`;
}
function modalDeleteHtml() {
    return `
  <form class="note-delete-form" style="font: 13px/1.3 system-ui, sans-serif;">
    <div style="margin-bottom:8px;">Para borrar la nota, ingresá la contraseña.</div>
    <input class="note-pass" type="password" placeholder="Contraseña" autocomplete="off"
           style="width:100%;border:1px solid #d1d5db;border-radius:6px;padding:6px 8px;" />
    <div class="notes-actions">
      <button type="button" class="btn btn-cancel">Cancelar</button>
      <button type="submit" class="btn btn-danger">Borrar</button>
    </div>
  </form>`;
}

/* ======= Modales: abrir/cerrar ======= */
function openCreationModal(latlng) {
    closeCreationModal();
    creationLatLng = latlng;

    const mapEl = map.getContainer();
    const backdrop = document.createElement('div');
    backdrop.className = 'notes-modal-backdrop';
    backdrop.setAttribute('role', 'dialog');
    backdrop.setAttribute('aria-modal', 'true');
    backdrop.tabIndex = -1;

    const modal = document.createElement('div');
    modal.className = 'notes-modal';
    modal.innerHTML = modalCreateHtml();
    backdrop.appendChild(modal);
    mapEl.appendChild(backdrop);

    L.DomEvent.disableClickPropagation(modal);
    L.DomEvent.disableScrollPropagation(modal);

    const form = modal.querySelector('.note-form');
    const title = modal.querySelector('.note-title');
    const body = modal.querySelector('.note-body');
    const iconSel = modal.querySelector('.note-icon-type');
    const cancel = modal.querySelector('.btn-cancel');
    const colorWrap = modal.querySelector('.note-color-wrap');
    const colorInput = modal.querySelector('.note-color');

    setTimeout(() => title?.focus(), 0);

    colorWrap?.addEventListener('click', (ev) => {
        const btn = ev.target.closest?.('.note-color-swatch'); if (!btn) return;
        ev.preventDefault();
        colorWrap.querySelectorAll('.note-color-swatch').forEach(b => { b.style.outline = 'none'; b.style.boxShadow = 'none'; });
        btn.style.outline = '2px solid #3b82f6'; btn.style.boxShadow = '0 0 0 2px rgba(59,130,246,.35)';
        if (colorInput) colorInput.value = btn.getAttribute('data-color') || '#000000';
    });

    form?.addEventListener('submit', async (ev) => {
        ev.preventDefault(); L.DomEvent.stop(ev);
        if (!creationLatLng) return;

        const t = title?.value.trim() || 'Nota';
        const b = body?.value.trim() || '';
        const iconType = iconSel?.value || 'note';
        const color = colorInput?.value || '#000000';

        let ref;
        try { ref = notesRef(); }
        catch (err) { console.error('[notes] FS:', err); toast('Firestore no inicializado'); return; }

        try {
            await ref.add({
                title: t, body: b, iconType, color,
                lat: creationLatLng.lat, lng: creationLatLng.lng,
                createdAt: serverTime(), updatedAt: serverTime()
            });
            toast('Nota guardada');
            closeCreationModal();
            disableNoteMode(); // snapshot pinta
        } catch (err) {
            console.error('[notes] add error:', err);
            toast('Error al guardar');
        }
    });

    const doClose = () => { closeCreationModal(); };
    cancel?.addEventListener('click', (e) => { e.preventDefault(); doClose(); });
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) doClose(); });
    backdrop.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); doClose(); } });

    creationModal = backdrop;
}
function closeCreationModal() { try { creationModal?.remove(); } catch { } creationModal = null; creationLatLng = null; }

function openEditModal(id, data) {
    // Acción momentánea: apaga otras tools pero no queda "activa"
    activateTool('notes-edit');
    closeEditModal();
    try { markers.get(id)?.closePopup(); } catch { }

    const mapEl = map.getContainer();
    const backdrop = document.createElement('div');
    backdrop.className = 'notes-modal-backdrop';
    backdrop.setAttribute('role', 'dialog');
    backdrop.setAttribute('aria-modal', 'true');
    backdrop.tabIndex = -1;

    const modal = document.createElement('div');
    modal.className = 'notes-modal';
    modal.innerHTML = modalEditHtml(data);
    backdrop.appendChild(modal);
    mapEl.appendChild(backdrop);

    L.DomEvent.disableClickPropagation(modal);
    L.DomEvent.disableScrollPropagation(modal);

    const form = modal.querySelector('.note-edit-form');
    const title = modal.querySelector('.note-title');
    const body = modal.querySelector('.note-body');
    const iconSel = modal.querySelector('.note-icon-type');
    const cancel = modal.querySelector('.btn-cancel');
    const colorWrap = modal.querySelector('.note-color-wrap');
    const colorInput = modal.querySelector('.note-color');

    setTimeout(() => title?.focus(), 0);

    colorWrap?.addEventListener('click', (ev) => {
        const btn = ev.target.closest?.('.note-color-swatch'); if (!btn) return;
        ev.preventDefault();
        colorWrap.querySelectorAll('.note-color-swatch').forEach(b => { b.style.outline = 'none'; b.style.boxShadow = 'none'; });
        btn.style.outline = '2px solid #3b82f6'; btn.style.boxShadow = '0 0 0 2px rgba(59,130,246,.35)';
        if (colorInput) colorInput.value = btn.getAttribute('data-color') || '#000000';
    });

    form?.addEventListener('submit', async (ev) => {
        ev.preventDefault(); L.DomEvent.stop(ev);

        const t = (title?.value || 'Nota').trim() || 'Nota';
        const b = (body?.value || '').trim();
        const iconType = iconSel?.value || 'note';
        const color = colorInput?.value || '#000000';

        try {
            await notesRef().doc(id).update({ title: t, body: b, iconType, color, updatedAt: serverTime() });
            const updated = { ...data, title: t, body: b, iconType, color };
            notesData.set(id, updated);
            const m = markers.get(id);
            if (m) {
                m.setIcon(getIcon(iconType, color));
                bindPopup(m, id, updated);
            }
            toast('Nota actualizada');
            closeEditModal();
            try { m?.openPopup(); } catch { }
            if (listOpen) renderListDebounced();

            // cache
            updateCache(id, updated);
        } catch (err) {
            console.error('[notes] update error:', err);
            toast('No se pudo actualizar', 'error');
        }
    });

    const doClose = () => { closeEditModal(); };
    cancel?.addEventListener('click', (e) => { e.preventDefault(); doClose(); });
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) doClose(); });
    backdrop.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); doClose(); } });

    editModal = backdrop;
}
function closeEditModal() { try { editModal?.remove(); } catch { } editModal = null; }

function openDeleteModal(id) {
    // Acción momentánea para forzar exclusividad
    activateTool('notes-edit');
    closeDeleteModal();
    const mapEl = map.getContainer();
    const backdrop = document.createElement('div');
    backdrop.className = 'notes-modal-backdrop';
    backdrop.setAttribute('role', 'dialog');
    backdrop.setAttribute('aria-modal', 'true');
    backdrop.tabIndex = -1;

    const modal = document.createElement('div');
    modal.className = 'notes-modal';
    modal.innerHTML = modalDeleteHtml();
    backdrop.appendChild(modal);
    mapEl.appendChild(backdrop);

    L.DomEvent.disableClickPropagation(modal);
    L.DomEvent.disableScrollPropagation(modal);

    const form = modal.querySelector('.note-delete-form');
    const passEl = modal.querySelector('.note-pass');
    const cancel = modal.querySelector('.btn-cancel');

    setTimeout(() => passEl?.focus(), 0);

    form?.addEventListener('submit', async (ev) => {
        ev.preventDefault(); L.DomEvent.stop(ev);
        const val = (passEl?.value || '').trim();
        if (val !== '456') { toast('Contraseña incorrecta'); passEl?.select?.(); return; }
        closeDeleteModal();
        await safeDeleteNote(id);
    });

    const doClose = () => { closeDeleteModal(); };
    cancel?.addEventListener('click', (e) => { e.preventDefault(); doClose(); });
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) doClose(); });
    backdrop.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); doClose(); } });

    deleteModal = backdrop;
}
function closeDeleteModal() { try { deleteModal?.remove(); } catch { } deleteModal = null; }

/* ================= Interacción de creación ================= */
function enableNoteMode() {
    if (noteMode) return;
    noteMode = true;
    noteBtn?.classList.add('active');
    map.getContainer().style.cursor = 'crosshair';
    map.on('click', onMapClickForNote);
}
function disableNoteMode() {
    if (!noteMode) return;
    noteMode = false;
    noteBtn?.classList.remove('active');
    map.off('click', onMapClickForNote);
    map.getContainer().style.cursor = '';
    closeCreationModal();
    closeEditModal();
    closeDeleteModal();
}
function toggleNoteMode() { noteMode ? disableNoteMode() : enableNoteMode(); }
function onMapClickForNote(e) {
    if (!noteMode) return;
    const ll = e?.latlng; if (!ll) return;
    openCreationModal(ll);
}

/* ================= Popup: view + delegación ================= */
function escapeHtml(s) {
    return (s || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}
function escapeAttr(s) { return escapeHtml(s); }

function viewHtml(d) {
    const title = d.title || 'Nota';
    const body = d.body || '';
    return `
  <div class="note-view" style="min-width:260px; font: 13px/1.4 system-ui, sans-serif;">
    <div style="display:flex; align-items:center; gap:8px; margin-bottom:6px;">
      <strong class="note-title-view" title="Doble clic para renombrar">${escapeHtml(title)}</strong>
    </div>
    ${body ? `<div class="note-scroll" style="max-height:180px; overflow:auto; scrollbar-gutter:stable;"><div style="white-space:pre-wrap;">${escapeHtml(body)}</div></div>` : ''}

    <!-- botones en UNA SOLA FILA -->
    <div class="note-actions"
         style="display:grid; grid-template-columns:repeat(4, minmax(0, 1fr)); gap:6px; margin-top:8px;">
      <button type="button" class="note-copycoords"
        style="width:100%; border:1px solid #d1d5db; border-radius:6px; padding:6px 4px; background:#fff; cursor:pointer; font-size:12px;">Copiar coords</button>
      <button type="button" class="note-streetview"
        style="width:100%; border:1px solid #0ea5e9; border-radius:6px; padding:6px 4px; background:#e0f2fe; color:#0c4a6e; cursor:pointer; font-size:12px;">Street View</button>
      <button type="button" class="note-edit"
        style="width:100%; border:1px solid #d1d5db; border-radius:6px; padding:6px 4px; background:#fff; cursor:pointer; font-size:12px;">Editar</button>
      <button type="button" class="note-delete"
        style="width:100%; border:1px solid #ef4444; border-radius:6px; padding:6px 4px; background:#ef4444; color:#fff; cursor:pointer; font-size:12px;">Borrar</button>
    </div>
  </div>`;
}

function attachDelegatedHandlers(root, marker, id, data, popup) {
    if (root.__delegatedBound) return;
    root.__delegatedBound = true;

    root.addEventListener('click', async (ev) => {
        const delBtn = ev.target.closest?.('.note-delete');
        if (delBtn) { ev.preventDefault(); ev.stopPropagation(); openDeleteModal(id); return; }

        const editBtn = ev.target.closest?.('.note-edit');
        if (editBtn) { ev.preventDefault(); ev.stopPropagation(); openEditModal(id, data); return; }

        const copyBtn = ev.target.closest?.('.note-copycoords');
        if (copyBtn) {
            ev.preventDefault(); ev.stopPropagation();
            const lat = Number(data.lat), lng = Number(data.lng);
            const text = `${fmt(lat)}, ${fmt(lng)}`;
            const ok = await copyToClipboard(text);
            if (navigator.vibrate) try { navigator.vibrate(15); } catch { }
            copyBtn.textContent = ok ? '¡Copiado!' : 'No se pudo copiar';
            setTimeout(() => (copyBtn.textContent = 'Copiar coords'), 1100);
            return;
        }

        const svBtn = ev.target.closest?.('.note-streetview');
        if (svBtn) {
            ev.preventDefault(); ev.stopPropagation();
            openStreetView(data.lat, data.lng);
            if (navigator.vibrate) try { navigator.vibrate(10); } catch { }
            return;
        }
    });

    // Doble clic para renombrar rápido
    root.addEventListener('dblclick', async (ev) => {
        const target = ev.target.closest?.('.note-title-view'); if (!target) return;
        ev.preventDefault(); ev.stopPropagation();

        const input = document.createElement('input');
        input.value = target.textContent || 'Nota';
        input.style.cssText = 'border:1px solid #d1d5db;border-radius:6px;padding:4px 6px;';
        target.replaceWith(input); input.focus(); input.select();

        const commit = async () => {
            const newTitle = (input.value || 'Nota').trim() || 'Nota';
            try {
                await notesRef().doc(id).update({ title: newTitle, updatedAt: serverTime() });
                data.title = newTitle; notesData.set(id, data);
                popup.setContent(viewHtml(data));
                marker.openPopup();
                toast('Título actualizado');
                if (listOpen) renderListDebounced();
                updateCache(id, data);
            } catch (err) { console.error('[notes] quick title update error:', err); toast('No se pudo actualizar', 'error'); }
        };
        input.addEventListener('blur', commit, { once: true });
        input.addEventListener('keydown', (ke) => {
            if (ke.key === 'Enter') { ke.preventDefault(); commit(); }
            if (ke.key === 'Escape') { popup.setContent(viewHtml(data)); marker.openPopup(); }
        });
    });
}

function bindPopup(marker, id, data) {
    marker.off('popupopen'); marker.unbindPopup();
    marker.bindPopup(viewHtml(data), { autoPan: true, keepInView: true, maxWidth: 360 });
    marker.on('popupopen', (e) => {
        const root = e.popup.getElement();
        if (!root) return;
        L.DomEvent.disableClickPropagation(root);
        L.DomEvent.disableScrollPropagation(root);
        attachDelegatedHandlers(root, marker, id, data, e.popup);
    });
}

/* ================= Fly/open desde lista ================= */
function getClampedFlyToZoom() {
    const maxZ = typeof map.getMaxZoom === 'function' ? map.getMaxZoom() : 18;
    const current = map.getZoom();
    const target = 18;
    return Math.min(Math.max(current, target), maxZ);
}
function openNote(id) {
    const m = markers.get(id); if (!m) return;
    const ll = m.getLatLng();
    disableNoteMode();
    try { map.closePopup(); } catch { }
    const z = getClampedFlyToZoom();
    let opened = false;
    const open = () => { if (opened) return; opened = true; try { m.openPopup(); } catch { }; map.off('moveend', open); };
    map.once('moveend', open);
    const fallback = setTimeout(open, 900);
    const onceOpen = () => { clearTimeout(fallback); m.off('popupopen', onceOpen); };
    m.on('popupopen', onceOpen);
    map.flyTo(ll, z, { animate: true, duration: .6 });
}

/* ================= Render (solo snapshot/cache) ================= */
function shallowEqPos(a, b) { return a && b && a.lat === b.lat && a.lng === b.lng; }
function renderOrUpdate(id, data) {
    if (typeof data?.lat !== 'number' || typeof data?.lng !== 'number') return;
    const ll = L.latLng(data.lat, data.lng);
    const iconType = data.iconType || 'note';
    const color = data.color || '#000000';

    const prev = notesData.get(id);
    notesData.set(id, data);

    if (!markers.has(id)) {
        const m = L.marker(ll, {
            pane: NOTES_PANE,
            icon: getIcon(iconType, color),
            keyboard: false,
            riseOnHover: true,
            bubblingMouseEvents: false
        }).addTo(map);
        markers.set(id, m);
        bindPopup(m, id, data);
    } else {
        const m = markers.get(id);
        if (!shallowEqPos(prev, data)) { try { m.setLatLng(ll); } catch { } }
        if (!prev || prev.iconType !== iconType || prev.color !== color) {
            m.setIcon(getIcon(iconType, color));
        }
        if (!prev || prev.title !== data.title || prev.body !== data.body) {
            bindPopup(m, id, data);
        }
    }

    // cache local
    updateCache(id, data);

    if (listOpen) renderListDebounced();
}
function removeMarker(id) {
    const m = markers.get(id);
    if (m) {
        try { m.closePopup?.(); } catch { }
        try { map.removeLayer(m); } catch { }
    }
    markers.delete(id);
    notesData.delete(id);

    // cache local
    removeFromCache(id);

    if (listOpen) renderListDebounced();
}
async function safeDeleteNote(id) {
    const m = markers.get(id);
    if (m) {
        try { m.closePopup?.(); } catch { }
        try { map.removeLayer(m); } catch { }
    }
    markers.delete(id);
    notesData.delete(id);
    if (listOpen) renderListDebounced();
    try {
        await notesRef().doc(id).delete();
        toast('Nota borrada');
    } catch (err) {
        console.error('[notes] delete error:', err);
        toast('No se pudo borrar', 'error');
    } finally {
        try { map.closePopup?.(); } catch { }
    }
}

/* ===== Snapshot batching con rAF ===== */
const pending = new Map(); // id -> { type, data }
let rafScheduled = false;
function scheduleFlush() { if (!rafScheduled) { rafScheduled = true; requestAnimationFrame(flushPending); } }
function flushPending() {
    rafScheduled = false;
    if (pending.size === 0) return;
    const entries = Array.from(pending.entries());
    pending.clear();
    for (const [id, rec] of entries) {
        if (rec.type === 'removed') removeMarker(id);
        else renderOrUpdate(id, rec.data);
    }
}

/* ======= Suscripción pausable ======= */
function subscribeNotes() {
    if (unsub) return;
    try {
        unsub = notesRef().onSnapshot((snap) => {
            snap.docChanges().forEach((ch) => {
                const id = ch.doc.id;
                if (ch.type === 'removed') {
                    pending.set(id, { type: 'removed' });
                } else {
                    const data = ch.doc.data();
                    pending.set(id, { type: 'upsert', data });
                }
            });
            scheduleFlush();
        }, (err) => console.error('[notes] snapshot error:', err));
    } catch (e) {
        console.error('[notes] No se pudo iniciar onSnapshot:', e);
    }
}
function unsubscribeNotes() {
    try { unsub?.(); } catch { }
    unsub = null;
}

/* ======= Cache local (rehidratación) ======= */
const NOTES_CACHE_KEY = 'notes_cache_v2';
const NOTES_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 días
let cacheDirty = false;
const persistCacheDebounced = debounce(persistCache, 500);

function readCache() {
    try {
        const raw = localStorage.getItem(NOTES_CACHE_KEY);
        if (!raw) return {};
        const obj = JSON.parse(raw);
        // prune por TTL
        const now = Date.now();
        const pruned = {};
        for (const [id, d] of Object.entries(obj)) {
            if (d && typeof d.updatedAt === 'number' && (now - d.updatedAt) <= NOTES_CACHE_TTL_MS) {
                pruned[id] = d;
            }
        }
        if (Object.keys(pruned).length !== Object.keys(obj).length) {
            localStorage.setItem(NOTES_CACHE_KEY, JSON.stringify(pruned));
        }
        return pruned;
    } catch { return {}; }
}

function writeCache(obj) {
    try { localStorage.setItem(NOTES_CACHE_KEY, JSON.stringify(obj)); } catch { }
}

function normalizeDocForCache(d = {}) {
    return {
        title: d.title || 'Nota',
        body: d.body || '',
        iconType: d.iconType || 'note',
        color: d.color || '#000000',
        lat: Number(d.lat),
        lng: Number(d.lng),
        updatedAt: tsToMs(d.updatedAt) || tsToMs(d.createdAt) || Date.now()
    };
}

function updateCache(id, data) {
    if (!id) return;
    const obj = readCache();
    obj[id] = normalizeDocForCache(data);
    cacheDirty = true;
    persistCacheDebounced();
}

function removeFromCache(id) {
    const obj = readCache();
    if (obj[id]) {
        delete obj[id];
        cacheDirty = true;
        persistCacheDebounced();
    }
}

function persistCache() {
    if (!cacheDirty) return;
    cacheDirty = false;
    try {
        const obj = {};
        for (const [id, d] of notesData.entries()) {
            obj[id] = normalizeDocForCache(d);
        }
        writeCache(obj);
    } catch { }
}

function hydrateFromCache() {
    const obj = readCache();
    const entries = Object.entries(obj);
    if (!entries.length) return;
    // Render rápido sin esperar snapshot:
    for (const [id, d] of entries) {
        if (isFinite(d.lat) && isFinite(d.lng)) {
            renderOrUpdate(id, d);
        }
    }
}

/* ================= Init ================= */
function init() {
    ensureCssOnce();
    ensureNotesPane();
    map.addControl(new NotesControl());
    map.addControl(new NotesListControl());

    // 1) Pintar desde cache inmediatamente (rehidratación instantánea)
    hydrateFromCache();

    // 2) Suscripción en vivo
    subscribeNotes();

    // 3) Pausable por visibilidad (ahorra lecturas/costo)
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) {
            unsubscribeNotes();
            persistCacheDebounced();
        } else {
            if (notesData.size === 0 && markers.size === 0) hydrateFromCache();
            subscribeNotes();
        }
    });

    // 4) Persistir cache al salir
    window.addEventListener('beforeunload', persistCache);
    window.addEventListener('pagehide', persistCache);

    // ====== Registro en el bus ======
    try {
        // Modo crear nota (sticky)
        registerTool('notes', {
            sticky: true,
            enable: () => enableNoteMode(),
            disable: () => disableNoteMode(),
            buttons: ['#btn-notes'] // opcional: para botones HTML externos
        });

        // Lista de notas (sticky)
        registerTool('notes-list', {
            sticky: true,
            enable: () => openListPanel(),
            disable: () => closeListPanel(),
            buttons: ['#btn-notes-list'] // opcional: botón HTML externo
        });

        // Edición/Borrado (momentáneo): apaga otras tools y si cambia de tool, cierra modales
        registerTool('notes-edit', {
            sticky: false,
            enable: () => { }, // abrimos los modales explícitamente
            disable: () => { closeEditModal(); closeDeleteModal(); }
        });
    } catch (e) {
        console.error('[notes] toolsBus register error:', e);
    }
}
if (map && typeof map.whenReady === 'function') { map.whenReady(init); } else { init(); }

/* ================= Exports ================= */
export function enableNotes() { enableNoteMode(); }
export function disableNotes() { disableNoteMode(); }
export function toggleNotes() { toggleNoteMode(); }
export async function addNoteAt(lat, lng, { title = 'Nota', body = '', iconType = 'note', color = '#000000' } = {}) {
    const ref = notesRef();
    const doc = await ref.add({ title, body, iconType, color, lat, lng, createdAt: serverTime(), updatedAt: serverTime() });
    return doc.id;
}
