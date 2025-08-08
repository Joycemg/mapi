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

/** ================= Config ================= */
const ICON_SIZE = 25;   // icono circular (no escala con zoom por el pane)
const ZOOM_LABEL = 15;  // mostrar título a partir de este zoom

/** ================= Estado ================= */
let noteMode = false;
let noteBtn = null;
let labelVisible = false;
const noteMarkers = {};         // id -> { marker, data }
let rtUnsubscribe = null;
let controlAdded = false;

/** ================= Pane propio ================= */
const notesPaneName = 'notesPane';
function ensureNotesPane() {
    if (!map.getPane(notesPaneName)) {
        const pane = map.createPane(notesPaneName);
        pane.classList.add('leaflet-zoom-hide'); // evita escala en animación
        pane.style.zIndex = '650';               // por encima de tiles/overlays
    }
}

/** ================= CSS inyectado ================= */
function ensureNotesCss() {
    const styleId = 'notes-divicon-style';
    if (document.getElementById(styleId)) return;

    const style = document.createElement('style');
    style.id = styleId;
    style.textContent = `
    /* No romper el posicionamiento del marker */
    .note-divicon { will-change: transform; overflow: visible; }

    .leaflet-bar.notes-wrapper a { width: 30px; height: 30px; line-height: 30px; text-align:center; }
    .leaflet-bar.notes-wrapper a.active { background:#2563eb; color:#fff; }

    /* --- POPUP de notas: tamaño fijo + scroll --- */
    .note-popup .leaflet-popup-content {
      max-height: 260px;   /* ajustá a gusto */
      overflow-y: auto;
      overflow-x: hidden;
      padding-right: 6px;  /* que no tape el scroll */
    }

    /* que el body de la vista scrollee sin mover botones */
    .note-popup .note-scroll {
      max-height: 180px;
      overflow-y: auto;
      margin-bottom: 8px;
    }

    /* scroll suave en Win */
    .note-popup .note-scroll, .note-popup .leaflet-popup-content { scrollbar-gutter: stable; }
  `;
    document.head.appendChild(style);
}

/** ================= Iconos predefinidos ================= */
const PRESET_ICONS = [
    { value: 'note', label: 'Nota' },
    { value: 'shelter', label: 'Refugio (Casa)' },
    { value: 'danger', label: 'Peligro (X)' },
    { value: 'skull', label: 'Calavera' },
    { value: 'food', label: 'Comida' },
    { value: 'water', label: 'Agua' },
    { value: 'supply', label: 'Suministros' },
    { value: 'exit', label: 'Salida' },
    { value: 'flag', label: 'Bandera' },
    { value: 'camp', label: 'Fogata' },
    { value: 'radio', label: 'Radio' },
    { value: 'medic', label: 'Médico (+)' },
    { value: 'wrench', label: 'Herramienta' }
];

/** ================= Helpers SVG ================= */
function svgEl(tag, attrs = {}) {
    const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
    return el;
}

function buildPresetIconNode(type, size, color) {
    const wrap = document.createElement('div');
    Object.assign(wrap.style, { width: `${size}px`, height: `${size}px`, display: 'grid', placeItems: 'center' });
    const svg = svgEl('svg', { width: size, height: size, viewBox: '0 0 24 24' });
    const STROKE = '#111', FILL = '#fff', MAIN = color || '#000';

    switch (type) {
        case 'shelter': {
            const roof = svgEl('path', { d: 'M3 11 L12 3 L21 11', fill: 'none', stroke: STROKE, 'stroke-width': 2, 'stroke-linejoin': 'round' });
            const home = svgEl('rect', { x: 6, y: 10, width: 12, height: 10, fill: MAIN, stroke: STROKE, 'stroke-width': 2, rx: 2 });
            const door = svgEl('rect', { x: 11, y: 14, width: 3, height: 6, fill: FILL, stroke: STROKE, 'stroke-width': 1.5, rx: 0.5 });
            svg.append(roof, home, door); break;
        }
        case 'danger': {
            svg.append(
                svgEl('line', { x1: 5, y1: 5, x2: 19, y2: 19, stroke: MAIN, 'stroke-width': 4, 'stroke-linecap': 'round' }),
                svgEl('line', { x1: 19, y1: 5, x2: 5, y2: 19, stroke: MAIN, 'stroke-width': 4, 'stroke-linecap': 'round' }),
                svgEl('circle', { cx: 12, cy: 12, r: 10, fill: 'none', stroke: STROKE, 'stroke-width': 2 })
            ); break;
        }
        case 'skull': {
            const head = svgEl('path', { d: 'M7 9a5 5 0 0 1 10 0v3a4 4 0 0 1-4 4v3H11v-3a4 4 0 0 1-4-4V9z', fill: MAIN, stroke: STROKE, 'stroke-width': 2 });
            const eye1 = svgEl('circle', { cx: 9.5, cy: 10.5, r: 1.5, fill: FILL, stroke: STROKE, 'stroke-width': 1 });
            const eye2 = svgEl('circle', { cx: 14.5, cy: 10.5, r: 1.5, fill: FILL, stroke: STROKE, 'stroke-width': 1 });
            const teeth = svgEl('rect', { x: 10.5, y: 15, width: 3, height: 1.6, fill: FILL, stroke: STROKE, 'stroke-width': 1 });
            svg.append(head, eye1, eye2, teeth); break;
        }
        case 'food': {
            const meat = svgEl('path', { d: 'M15 5c3 0 5 2 5 5s-2 6-6 6-5-2-6-3l5-8c1-0.5 1.5-1 2-1z', fill: MAIN, stroke: STROKE, 'stroke-width': 2 });
            const bone = svgEl('path', { d: 'M4 20c-1.2 0-2-0.8-2-2s0.8-2 2-2c0-1.2 0.8-2 2-2s2 0.8 2 2-0.8 2-2 2c0 1.2-0.8 2-2 2z', fill: FILL, stroke: STROKE, 'stroke-width': 2 });
            svg.append(meat, bone); break;
        }
        case 'water': {
            const drop = svgEl('path', { d: 'M12 3c3 4 6 7 6 10a6 6 0 1 1-12 0c0-3 3-6 6-10z', fill: MAIN, stroke: STROKE, 'stroke-width': 2 });
            const shine = svgEl('path', { d: 'M9 14a3 3 0 0 0 3 3', fill: 'none', stroke: FILL, 'stroke-width': 2, 'stroke-linecap': 'round' });
            svg.append(drop, shine); break;
        }
        case 'supply': {
            svg.append(
                svgEl('rect', { x: 4, y: 6, width: 16, height: 12, fill: MAIN, stroke: STROKE, 'stroke-width': 2, rx: 2 }),
                svgEl('rect', { x: 11, y: 6, width: 2, height: 12, fill: FILL, opacity: 0.9 })
            ); break;
        }
        case 'exit': {
            const door = svgEl('rect', { x: 7, y: 5, width: 10, height: 14, fill: FILL, stroke: STROKE, 'stroke-width': 2, rx: 1.5 });
            const arrowShaft = svgEl('line', { x1: 4, y1: 12, x2: 12, y2: 12, stroke: MAIN, 'stroke-width': 2.5, 'stroke-linecap': 'round' });
            const arrowHead = svgEl('path', { d: 'M10 9 L14 12 L10 15 Z', fill: MAIN, stroke: STROKE, 'stroke-width': 1 });
            svg.append(door, arrowShaft, arrowHead); break;
        }
        case 'flag': {
            const pole = svgEl('line', { x1: 6, y1: 4, x2: 6, y2: 20, stroke: STROKE, 'stroke-width': 2 });
            const flag = svgEl('path', { d: 'M6 5h10l-3 3 3 3H6z', fill: MAIN, stroke: STROKE, 'stroke-width': 1.5 });
            svg.append(pole, flag); break;
        }
        case 'camp': {
            const fire = svgEl('path', { d: 'M12 6c2 2 2 3.5 0 5.5C10 10.5 10 8 12 6z', fill: MAIN, stroke: STROKE, 'stroke-width': 1.5 });
            const log1 = svgEl('line', { x1: 7, y1: 18, x2: 17, y2: 14, stroke: STROKE, 'stroke-width': 2, 'stroke-linecap': 'round' });
            const log2 = svgEl('line', { x1: 7, y1: 14, x2: 17, y2: 18, stroke: STROKE, 'stroke-width': 2, 'stroke-linecap': 'round' });
            svg.append(fire, log1, log2); break;
        }
        case 'radio': {
            const body = svgEl('rect', { x: 4, y: 7, width: 16, height: 10, fill: FILL, stroke: STROKE, 'stroke-width': 2, rx: 2 });
            const dial = svgEl('circle', { cx: 16, cy: 12, r: 2.5, fill: MAIN, stroke: STROKE, 'stroke-width': 1.5 });
            const waves = svgEl('path', { d: 'M7 11h5', stroke: STROKE, 'stroke-width': 1.8, 'stroke-linecap': 'round' });
            const antenna = svgEl('line', { x1: 12, y1: 7, x2: 18, y2: 3, stroke: STROKE, 'stroke-width': 1.6 });
            svg.append(body, dial, waves, antenna); break;
        }
        case 'medic': {
            const badge = svgEl('rect', { x: 5, y: 5, width: 14, height: 14, fill: FILL, stroke: STROKE, 'stroke-width': 2, rx: 3 });
            const crossV = svgEl('rect', { x: 11, y: 7, width: 2, height: 10, fill: MAIN });
            const crossH = svgEl('rect', { x: 7, y: 11, width: 10, height: 2, fill: MAIN });
            svg.append(badge, crossV, crossH); break;
        }
        case 'wrench': {
            const wrench = svgEl('path', { d: 'M15 3a4 4 0 0 0 0 6l-6 6a3 3 0 1 0 2 2l6-6a4 4 0 0 0 6 0', fill: MAIN, stroke: STROKE, 'stroke-width': 1.6 });
            svg.append(wrench); break;
        }
        case 'note': {
            const page = svgEl('rect', { x: 5, y: 4, width: 14, height: 16, rx: 2, fill: FILL, stroke: STROKE, 'stroke-width': 2 });
            const fold = svgEl('path', { d: 'M15 4v5h5', fill: MAIN, stroke: STROKE, 'stroke-width': 1.5 });
            const line1 = svgEl('line', { x1: 7, y1: 11, x2: 13, y2: 11, stroke: MAIN, 'stroke-width': 1.8, 'stroke-linecap': 'round' });
            const line2 = svgEl('line', { x1: 7, y1: 14, x2: 15, y2: 14, stroke: MAIN, 'stroke-width': 1.8, 'stroke-linecap': 'round' });
            const line3 = svgEl('line', { x1: 7, y1: 17, x2: 12, y2: 17, stroke: MAIN, 'stroke-width': 1.8, 'stroke-linecap': 'round' });
            svg.append(page, fold, line1, line2, line3); break;
        }
        default: svg.append(svgEl('circle', { cx: 12, cy: 12, r: 9, fill: MAIN, stroke: STROKE, 'stroke-width': 2 }));
    }

    wrap.appendChild(svg);
    return wrap;
}

/** ================= Control UI ================= */
const NotesControl = L.Control.extend({
    options: { position: 'topleft' },
    onAdd() {
        const wrapper = L.DomUtil.create('div', 'leaflet-bar notes-wrapper');
        L.DomEvent.disableClickPropagation(wrapper);
        L.DomEvent.disableScrollPropagation(wrapper);
        Object.assign(wrapper.style, { position: 'relative', overflow: 'visible', zIndex: 1000 });

        noteBtn = createBtn('📝', 'notes-btn', 'Agregar nota', wrapper, toggleNoteMode);
        L.DomEvent.on(wrapper, 'pointerdown', (e) => e.stopPropagation());
        L.DomEvent.on(wrapper, 'touchstart', (e) => e.stopPropagation());
        return wrapper;
    }
});

function addControlOnce() {
    if (controlAdded) return;
    map.addControl(new NotesControl());
    controlAdded = true;
}

function createBtn(icon, cls, title, container, onClick) {
    const a = L.DomUtil.create('a', cls, container);
    a.href = '#';
    a.setAttribute('role', 'button');
    a.setAttribute('aria-label', title);
    a.title = title;
    a.innerHTML = `<span style="display:block;line-height:16px;text-align:center;">${icon}</span>`;
    a.onclick = (e) => { e.preventDefault(); onClick(); };
    return a;
}

/** ================= Modo Nota ================= */
function toggleNoteMode() { noteMode ? disableNoteMode() : enableNoteMode(); }
function enableNoteMode() {
    noteMode = true;
    noteBtn?.classList.add('active');
    try { deactivateDrawingTools?.(); } catch { }
    const c = map.getContainer();
    c.style.cursor = 'crosshair';
    c.style.touchAction = 'none';
    map.off('click', onMapClickAddNote);
    map.on('click', onMapClickAddNote); // solo click
}
function disableNoteMode() {
    noteMode = false;
    noteBtn?.classList.remove('active');
    const c = map.getContainer();
    c.style.cursor = '';
    c.style.touchAction = '';
    map.off('click', onMapClickAddNote);
}

/** ================= Crear Nota ================= */
function onMapClickAddNote(e) {
    if (!noteMode) return;
    const latlng = e.latlng;
    if (!latlng) return;

    const popup = L.popup({
        closeOnClick: false,
        autoClose: false,
        maxWidth: 360,
        className: 'note-popup' // <-- clase para el CSS con scroll
    })
        .setLatLng(latlng)
        .setContent(createFormHtml())
        .openOn(map);

    const root = popup.getElement();
    L.DomEvent.disableClickPropagation(root);
    L.DomEvent.disableScrollPropagation(root);

    const formEl = root?.querySelector('.note-form');
    const titleEl = root?.querySelector('.note-title');
    const bodyEl = root?.querySelector('.note-body');
    const colorWrap = root?.querySelector('.note-color-wrap');
    const iconSel = root?.querySelector('.note-icon-type');

    let pickedColor = '#000000'; // default
    colorWrap?.querySelectorAll('button[data-color]').forEach(btn => {
        if (btn.getAttribute('data-color') === pickedColor) selectSwatch(btn, colorWrap);
        btn.addEventListener('click', (ev) => {
            ev.preventDefault();
            pickedColor = btn.getAttribute('data-color') || '#000000';
            selectSwatch(btn, colorWrap);
        });
    });

    formEl?.addEventListener('submit', async (ev) => {
        ev.preventDefault(); L.DomEvent.stop(ev);
        const title = titleEl?.value.trim() || 'Nota';
        const body = bodyEl?.value.trim() || '';
        const color = pickedColor;
        const iconType = iconSel?.value || 'shelter';

        let ref;
        try { ref = getNotesRef(); }
        catch (err) {
            console.error('[notes] Firestore no disponible:', err);
            alert('Firestore no está inicializado. Revisá config/firebase.js o las credenciales.');
            return;
        }

        try {
            await ref.add({
                title, body, color, iconType,
                lat: latlng.lat, lng: latlng.lng,
                createdAt: Date.now(), updatedAt: Date.now()
            });
        } catch (err) {
            console.error('[notes] add error:', err);
            alert('No se pudo guardar la nota. ¿Reglas de Firestore? (ver consola)');
            return;
        }

        map.closePopup(popup);
        disableNoteMode();
    });

    root?.querySelector('.note-cancel')?.addEventListener('click', (ev) => {
        ev.preventDefault(); L.DomEvent.stop(ev);
        map.closePopup(popup);
        disableNoteMode();
    });
}

function selectSwatch(btn, wrap) {
    wrap.querySelectorAll('button[data-color]').forEach(b => { b.style.outline = 'none'; b.style.boxShadow = 'none'; });
    btn.style.outline = '2px solid #3b82f6';
    btn.style.boxShadow = '0 0 0 2px rgba(59,130,246,.35)';
}

function createFormHtml() {
    const options = PRESET_ICONS.map(o => `<option value="${o.value}">${o.label}</option>`).join('');
    const colorBtn = (hex, title) => `
    <button type="button" data-color="${hex}" title="${title}"
      style="width:28px;height:28px;border-radius:50%;border:1px solid #d1d5db;background:${hex};
             display:inline-block;cursor:pointer;"></button>
  `;
    return `
    <form class="note-form" style="font: 13px/1.4 system-ui, sans-serif;">
      <div style="display:grid; grid-template-columns:1fr; gap:6px; margin-bottom:6px;">
        <input class="note-title" type="text" placeholder="Título" maxlength="80"
               style="border:1px solid #d1d5db;border-radius:6px;padding:6px 8px;" />
      </div>

      <div class="note-color-wrap" style="display:flex; align-items:center; gap:8px; margin-bottom:6px;">
        <span style="font-size:12px;color:#374151;">Color:</span>
        ${colorBtn('#ffffff', 'Blanco')}
        ${colorBtn('#000000', 'Negro')}
        ${colorBtn('#e11d48', 'Rojo')}
        ${colorBtn('#10b981', 'Verde')}
      </div>

      <div style="display:grid; grid-template-columns:1fr; gap:6px; margin-bottom:6px;">
        <select class="note-icon-type" title="Icono"
                style="border:1px solid #d1d5db;border-radius:6px;padding:6px 8px;">
          ${options}
        </select>
      </div>

      <textarea class="note-body" placeholder="Detalle..." rows="3" maxlength="1000"
        style="width:100%;height:120px;max-height:120px;overflow:auto;border:1px solid #d1d5db;border-radius:6px;padding:6px 8px;resize:vertical;"></textarea>

      <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:8px;">
        <button type="button" class="note-cancel" 
          style="border:1px solid #e5e7eb;border-radius:6px;padding:6px 10px;background:#f3f4f6;cursor:pointer;">Cancelar</button>
        <button type="submit"
          style="border:1px solid #2563eb;border-radius:6px;padding:6px 10px;background:#2563eb;color:#fff;cursor:pointer;">Guardar</button>
      </div>
    </form>
  `;
}

/** ================= Icono + label ================= */
function buildNoteDivHtml(data) {
    const title = data.title || 'Nota';
    const color = data.color || '#000000';
    const type = data.iconType || 'shelter';
    const size = ICON_SIZE;

    const wrap = document.createElement('div');
    Object.assign(wrap.style, {
        position: 'relative',
        width: `${size + 6}px`,
        height: `${size + 6}px`,
        borderRadius: '50%',
        border: '2px solid black',
        background: 'white',
        display: 'grid',
        placeItems: 'center',
        boxSizing: 'border-box',
        overflow: 'visible'   // <- para que el label pueda salir del círculo
    });

    const inner = document.createElement('div');
    Object.assign(inner.style, {
        width: `${size + 2}px`,
        height: `${size + 2}px`,
        borderRadius: '50%',
        background: '#fff',
        display: 'grid',
        placeItems: 'center'
    });
    inner.appendChild(buildPresetIconNode(type, size, color));
    wrap.appendChild(inner);

    if (labelVisible) {
        const label = document.createElement('div');
        label.textContent = title;
        Object.assign(label.style, {
            position: 'absolute',
            top: `-${Math.max(18, Math.round(size * 0.9))}px`,
            left: '50%',
            transform: 'translateX(-50%)',
            padding: '0 4px',
            font: '600 11px/1 system-ui, sans-serif',
            background: 'rgba(255,255,255,.95)',
            borderRadius: '4px',
            whiteSpace: 'nowrap',
            border: '1px solid #d1d5db',
            pointerEvents: 'none'
        });
        wrap.appendChild(label);
    }

    return wrap.outerHTML;
}

function makeNoteIcon(data) {
    const size = ICON_SIZE + 6;
    return L.divIcon({
        html: buildNoteDivHtml(data),
        className: 'note-divicon',
        iconSize: [size, size],
        iconAnchor: [size / 2, size / 2],
        popupAnchor: [0, -Math.max(18, Math.round(ICON_SIZE * 0.9))],
    });
}

/** ================= Popup (ver/editar/borrar) ================= */
function viewHtml(title, body, color = '#000') {
    return `
    <div class="note-view" style="min-width:260px; font: 13px/1.4 system-ui, sans-serif;">
      <div style="display:flex; align-items:center; gap:8px; margin-bottom:6px;">
        <div style="width:10px;height:10px;border-radius:50%;background:${color};border:1px solid #111"></div>
        <strong>${escapeHtml(title || 'Nota')}</strong>
      </div>

      <div class="note-scroll">
        ${body ? `<div style="white-space:pre-wrap;">${escapeHtml(body)}</div>` : ''}
      </div>

      <div style="display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap;margin-top:8px;">
        <button type="button" class="note-edit"   style="border:1px solid #d1d5db;border-radius:6px;padding:4px 8px;background:#fff;cursor:pointer;">Editar</button>
        <button type="button" class="note-delete" style="border:1px solid #ef4444;border-radius:6px;padding:4px 8px;background:#ef4444;color:#fff;cursor:pointer;">Borrar</button>
      </div>
    </div>
  `;
}

function bindNotePopup(marker, id, data) {
    marker.bindPopup(viewHtml(data.title, data.body, data.color), {
        className: 'note-popup',
        maxWidth: 360
    });

    marker.on('popupopen', (e) => {
        try { deactivateDrawingTools?.(); } catch { }
        const cont = e.popup.getElement();
        L.DomEvent.disableClickPropagation(cont);
        L.DomEvent.disableScrollPropagation(cont);

        cont?.querySelector('.note-delete')?.addEventListener('click', async (ev) => {
            ev.preventDefault(); L.DomEvent.stop(ev);
            try { await getNotesRef().doc(id).delete(); } catch (err) { console.error('[notes] delete error:', err); }
        });

        cont?.querySelector('.note-edit')?.addEventListener('click', (ev) => {
            ev.preventDefault(); L.DomEvent.stop(ev);

            const formHtml = `
        <form class="note-edit-form" style="font: 13px/1.3 system-ui, sans-serif;">
          <div style="display:grid; grid-template-columns:1fr; gap:6px; margin-bottom:6px;">
            <input class="note-title" type="text" value="${escapeAttr(data.title || 'Nota')}" maxlength="80"
                   style="border:1px solid #d1d5db;border-radius:6px;padding:6px 8px;" />
          </div>

          <textarea class="note-body" rows="3" maxlength="1000"
            style="width:100%;height:120px;max-height:120px;overflow:auto;border:1px solid #d1d5db;border-radius:6px;padding:6px 8px;resize:vertical;">${escapeHtml(data.body || '')}</textarea>

          <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:8px;">
            <button type="button" class="note-cancel" 
              style="border:1px solid #e5e7eb;border-radius:6px;padding:6px 10px;background:#f3f4f6;cursor:pointer;">Cancelar</button>
            <button type="submit" 
              style="border:1px solid #2563eb;border-radius:6px;padding:6px 10px;background:#2563eb;color:#fff;cursor:pointer;">Guardar</button>
          </div>
        </form>
      `;
            e.popup.setContent(formHtml);

            const root = e.popup.getElement();
            L.DomEvent.disableClickPropagation(root);
            L.DomEvent.disableScrollPropagation(root);

            const form = root?.querySelector('.note-edit-form');
            const titleEl = root?.querySelector('.note-title');
            const bodyEl = root?.querySelector('.note-body');

            form?.addEventListener('submit', async (ev2) => {
                ev2.preventDefault(); L.DomEvent.stop(ev2);
                const title = titleEl?.value.trim() || 'Nota';
                const body = bodyEl?.value.trim() || '';
                try {
                    await getNotesRef().doc(id).update({ title, body, updatedAt: Date.now() });
                    e.popup.setContent(viewHtml(title, body, data.color));
                    const rec = noteMarkers[id];
                    if (rec) {
                        rec.data = { ...rec.data, title, body };
                        rec.marker.setIcon(makeNoteIcon(rec.data));
                    }
                } catch (err) {
                    console.error('[notes] update error:', err);
                    alert('No se pudo actualizar la nota. Revisá reglas de Firestore.');
                }
            });

            root?.querySelector('.note-cancel')?.addEventListener('click', (ev2) => {
                ev2.preventDefault(); L.DomEvent.stop(ev2);
                e.popup.setContent(viewHtml(data.title, data.body, data.color));
            });
        });
    });
}

/** ================= Render / Sync ================= */
function renderOrUpdateNote(id, data) {
    if (typeof data?.lat !== 'number' || typeof data?.lng !== 'number') return;
    const ll = L.latLng(data.lat, data.lng);

    if (!noteMarkers[id]) {
        const marker = L.marker(ll, { icon: makeNoteIcon(data), pane: notesPaneName }).addTo(map);
        noteMarkers[id] = { marker, data };

        const stopAndDeactivate = (ev) => {
            ev.originalEvent?.preventDefault?.();
            ev.originalEvent?.stopPropagation?.();
            try { deactivateDrawingTools?.(); } catch { }
        };
        marker.on('click', stopAndDeactivate);
        marker.on('touchstart', stopAndDeactivate);

        bindNotePopup(marker, id, data);
    } else {
        noteMarkers[id].marker.setLatLng(ll);
        noteMarkers[id].data = data;
        noteMarkers[id].marker.setIcon(makeNoteIcon(data));
        bindNotePopup(noteMarkers[id].marker, id, data);
    }
}

/** ================= Carga inicial + RT ================= */
async function loadExistingNotesOnce() {
    try {
        const snap = await getNotesRef().get();
        snap.forEach(doc => renderOrUpdateNote(doc.id, doc.data()));
    } catch (err) {
        console.error('[notes] get() error (lectura inicial):', err);
    }
}

function startRealtime() {
    try {
        if (typeof rtUnsubscribe === 'function') { rtUnsubscribe(); rtUnsubscribe = null; }
        rtUnsubscribe = getNotesRef().onSnapshot((snap) => {
            snap.docChanges().forEach((ch) => {
                const id = ch.doc.id;
                if (ch.type === 'added' || ch.type === 'modified') {
                    renderOrUpdateNote(id, ch.doc.data());
                } else if (ch.type === 'removed') {
                    if (noteMarkers[id]) { map.removeLayer(noteMarkers[id].marker); delete noteMarkers[id]; }
                }
            });
        }, (err) => {
            console.error('[notes] onSnapshot error:', err);
        });
    } catch (err) {
        console.error('[notes] No se pudo iniciar onSnapshot:', err);
    }
}

/** ================= Labels por zoom ================= */
function refreshAllNoteIcons() {
    for (const id in noteMarkers) {
        const { data, marker } = noteMarkers[id];
        marker.setIcon(makeNoteIcon(data));
    }
}
function onZoom() {
    const visible = map.getZoom() >= ZOOM_LABEL;
    if (visible !== labelVisible) {
        labelVisible = visible;
        refreshAllNoteIcons();
    }
}
function setupZoomLabelBehavior() {
    labelVisible = map.getZoom() >= ZOOM_LABEL;
    map.off('zoomend', onZoom);
    map.on('zoomend', onZoom);
    refreshAllNoteIcons();
}

/** ================= Utils ================= */
function escapeHtml(str) {
    return (str || '')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}
function escapeAttr(str) { return escapeHtml(str); }

/** ================= Init ================= */
function initNotes() {
    ensureNotesPane();
    ensureNotesCss();
    addControlOnce();
    setupZoomLabelBehavior();
    loadExistingNotesOnce();
    startRealtime();
}

if (map && typeof map.whenReady === 'function') {
    map.whenReady(() => { try { initNotes(); } catch (e) { console.error('[notes] init error:', e); } });
} else {
    try { initNotes(); } catch (e) { console.error('[notes] init error (fallback):', e); }
}

/** ================= Exports ================= */
export function toggleNotes() { toggleNoteMode(); }
export function enableNotes() { enableNoteMode(); }
export function disableNotes() { disableNoteMode(); }
