// modules/coords.js
import { map } from './Map.js';

const fmt = (n, d = 6) => Number(n).toFixed(d);

async function copyToClipboard(text) {
  if (navigator.clipboard?.writeText) {
    try { await navigator.clipboard.writeText(text); return true; }
    catch { /* fallback */ }
  }
  const ta = document.createElement('textarea');
  ta.value = text; ta.setAttribute('readonly', '');
  ta.style.position = 'absolute'; ta.style.top = '0'; ta.style.left = '-9999px';
  document.body.appendChild(ta);
  ta.focus(); ta.select(); ta.setSelectionRange(0, ta.value.length);
  let ok = false; try { ok = document.execCommand('copy'); } catch { }
  document.body.removeChild(ta);
  return ok;
}

function showCoordsPopup(latlng, copiedNow = false) {
  const text = `${fmt(latlng.lat)}, ${fmt(latlng.lng)}`;

  const html = `
    <div style="font:12px/1.35 sans-serif; min-width:180px">
      <input id="coords-input" value="${text}" readonly
        style="width:100%;box-sizing:border-box;padding:6px 8px;font:inherit;">
      <div style="display:flex;gap:6px;margin-top:6px;">
        <button id="copy-coords" style="flex:1;padding:6px 10px;cursor:pointer;">
          ${copiedNow ? '¡Copiado!' : 'Copiar'}
        </button>
        <button id="select-coords" style="padding:6px 10px;cursor:pointer;">
          Seleccionar
        </button>
      </div>
    </div>
  `;

  const popup = L.popup({ autoClose: true, closeOnClick: true })
    .setLatLng(latlng).setContent(html).openOn(map);

  map.once('popupopen', (e) => {
    if (e.popup !== popup) return;
    const root = e.popup.getElement?.(); if (!root) return;
    const inp = root.querySelector('#coords-input');
    if (inp) { inp.focus(); inp.select(); inp.setSelectionRange(0, inp.value.length); }
  });
}

document.addEventListener('click', async (ev) => {
  const t = ev.target; if (!(t instanceof HTMLElement)) return;

  if (t.id === 'copy-coords') {
    ev.preventDefault(); ev.stopPropagation();
    const root = t.closest('.leaflet-popup-content') || document;
    const inp = root.querySelector('#coords-input');
    const text = inp?.value || '';
    const ok = await copyToClipboard(text);
    t.textContent = ok ? '¡Copiado!' : 'No se pudo copiar';
    setTimeout(() => (t.textContent = 'Copiar'), 1100);
  }

  if (t.id === 'select-coords') {
    ev.preventDefault(); ev.stopPropagation();
    const root = t.closest('.leaflet-popup-content') || document;
    const inp = root.querySelector('#coords-input');
    inp?.focus(); inp?.select(); inp?.setSelectionRange(0, inp.value.length);
  }
}, { passive: false });

map.getContainer().addEventListener('contextmenu', (ev) => ev.preventDefault());
map.on('contextmenu', async (e) => {
  const text = `${fmt(e.latlng.lat)}, ${fmt(e.latlng.lng)}`;
  let copied = false; try { copied = await copyToClipboard(text); } catch { }
  showCoordsPopup(e.latlng, copied);
});

// ===== Mobile: doble pulsación con 1 dedo =====
if ('ontouchstart' in window) { map.doubleClickZoom?.disable(); }

let lastTapTime = 0;
let lastTapPoint = null;
let startedAt = 0;
let startPoint = null;
let moved = false;
let multiTouch = false;
let pinching = false;

// Umbrales
const MAX_DT_MS = 350;       // ventana entre taps
const MAX_MOVE_PX = 10;      // tolerancia de movimiento

// Aux: ¿toca sobre UI?
function isOverUiClientXY(x, y) {
  const el = document.elementFromPoint(x, y);
  return !!el?.closest?.('.leaflet-control, .leaflet-bar, .leaflet-popup, .pencil-wrapper, .noteslist-panel');
}

// Detectar pinza (más de 1 dedo activo)
map.getContainer().addEventListener('touchstart', (ev) => {
  if (ev.touches.length > 1) {
    multiTouch = true;
    pinching = true;
  }
}, { passive: true });

map.getContainer().addEventListener('touchmove', (ev) => {
  if (ev.touches.length > 1) pinching = true;
}, { passive: true });

map.getContainer().addEventListener('touchend', (ev) => {
  if (ev.touches.length === 0) {
    // cuando no quedan dedos, reseteamos pinching en el próximo tick
    setTimeout(() => { pinching = false; multiTouch = false; }, 0);
  }
}, { passive: true });

// Detección de doble tap limpio
map.getContainer().addEventListener('touchstart', (ev) => {
  if (ev.touches.length !== 1) return;                // solo 1 dedo
  const t = ev.touches[0];
  if (isOverUiClientXY(t.clientX, t.clientY)) return; // no sobre UI
  startedAt = Date.now();
  startPoint = map.mouseEventToContainerPoint(t);
  moved = false;
}, { passive: true });

map.getContainer().addEventListener('touchmove', (ev) => {
  if (!startPoint || ev.touches.length !== 1) return;
  const t = ev.touches[0];
  const p = map.mouseEventToContainerPoint(t);
  if (p && startPoint && p.distanceTo(startPoint) > MAX_MOVE_PX) moved = true;
}, { passive: true });

map.getContainer().addEventListener('touchend', async (ev) => {
  // Rechazar si hubo multi-touch/pinch o si no hay touch para medir
  const touch = ev.changedTouches && ev.changedTouches[0];
  if (!touch) return;
  if (pinching || multiTouch) return;

  // No sobre UI
  if (isOverUiClientXY(touch.clientX, touch.clientY)) return;

  // Solo considerar si casi no se movió y fue un tap corto
  const tapDuration = Date.now() - startedAt;
  if (moved || tapDuration > 250) { startPoint = null; return; }

  const now = Date.now();
  const p = map.mouseEventToContainerPoint(touch);

  // ¿doble tap dentro de ventana y cerca del punto anterior?
  const isDouble =
    (now - lastTapTime) <= MAX_DT_MS &&
    lastTapPoint &&
    p &&
    lastTapPoint.distanceTo(p) <= MAX_MOVE_PX;

  if (isDouble) {
    const latlng = map.containerPointToLatLng(p);
    const text = `${fmt(latlng.lat)}, ${fmt(latlng.lng)}`;
    let copied = false; try { copied = await copyToClipboard(text); } catch { }
    showCoordsPopup(latlng, copied);
    ev.preventDefault();
    ev.stopPropagation();
    // reset para evitar triple tap encadenado
    lastTapTime = 0;
    lastTapPoint = null;
  } else {
    lastTapTime = now;
    lastTapPoint = p;
  }

  // reset de estado de este gesto
  startPoint = null;
}, { passive: false });
