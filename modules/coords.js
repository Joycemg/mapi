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

function openStreetView(lat, lng) {
  if (!isFinite(lat) || !isFinite(lng)) return;
  const url = `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${lat},${lng}`;
  try { window.open(url, '_blank', 'noopener'); }
  catch { location.href = url; }
}

/* ========== Popup reutilizable ========== */
const IS_TOUCH = 'ontouchstart' in window;
const POPUP_OFFSET_Y = IS_TOUCH ? -28 : -16; // anclar un poco arriba (más en móvil)

let coordsPopup = L.popup({
  autoClose: true,
  closeOnClick: true,
  keepInView: true,
  offset: [0, POPUP_OFFSET_Y],
  maxWidth: 260
});

function buildPopupHtml(text, copiedNow = false) {
  // estilos parecidos a notes, botones pequeños
  return `
    <div style="font:12px/1.35 system-ui, -apple-system, Segoe UI, Roboto, sans-serif; min-width:180px">
      <input id="coords-input" value="${text}" readonly
        style="width:100%;box-sizing:border-box;padding:6px 8px;font:inherit;border:1px solid #d1d5db;border-radius:6px;">
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-top:6px;">
        <button id="copy-coords"
          style="border:1px solid #d1d5db;border-radius:6px;background:#fff;padding:4px 8px;cursor:pointer;font-size:12px;">
          ${copiedNow ? '¡Copiado!' : 'Copiar'}
        </button>
        <button id="open-streetview"
          style="border:1px solid #0ea5e9;border-radius:6px;background:#e0f2fe;color:#0c4a6e;padding:4px 8px;cursor:pointer;font-size:12px;">
          Street View
        </button>
      </div>
    </div>
  `;
}

function showCoordsPopup(latlng, copiedNow = false) {
  const text = `${fmt(latlng.lat)}, ${fmt(latlng.lng)}`;

  coordsPopup
    .setLatLng(latlng)
    .setContent(buildPopupHtml(text, copiedNow))
    .openOn(map);

  // Auto-focus + auto-select al abrir
  map.once('popupopen', (e) => {
    if (e.popup !== coordsPopup) return;
    const root = e.popup.getElement?.(); if (!root) return;
    const inp = root.querySelector('#coords-input');
    if (inp) { inp.focus(); inp.select(); inp.setSelectionRange(0, inp.value.length); }
  });
}

/* ========== Eventos del popup (delegados) ========== */
document.addEventListener('click', async (ev) => {
  const t = ev.target; if (!(t instanceof HTMLElement)) return;

  // Solo si el click vino desde un popup Leaflet
  if (!t.closest('.leaflet-popup')) return;

  if (t.id === 'copy-coords') {
    ev.preventDefault(); ev.stopPropagation();
    const root = t.closest('.leaflet-popup-content') || document;
    const inp = root.querySelector('#coords-input');
    const text = inp?.value || '';
    const ok = await copyToClipboard(text);
    t.textContent = ok ? '¡Copiado!' : 'No se pudo copiar';
    setTimeout(() => (t.textContent = 'Copiar'), 1100);
    return;
  }

  if (t.id === 'open-streetview') {
    ev.preventDefault(); ev.stopPropagation();
    const root = t.closest('.leaflet-popup-content') || document;
    const inp = root.querySelector('#coords-input');
    const [latStr, lngStr] = (inp?.value || '').split(',').map(s => s.trim());
    const lat = Number(latStr), lng = Number(lngStr);
    openStreetView(lat, lng);
    try { navigator.vibrate?.(10); } catch { }
    return;
  }
}, { passive: false });

/* ========== Mostrar popup con click derecho ========== */
map.getContainer().addEventListener('contextmenu', (ev) => ev.preventDefault());
map.on('contextmenu', async (e) => {
  const text = `${fmt(e.latlng.lat)}, ${fmt(e.latlng.lng)}`;
  let copied = false; try { copied = await copyToClipboard(text); } catch { }
  showCoordsPopup(e.latlng, copied);
});

/* ========== Cerrar popup al mover el mapa ========== */
map.on('movestart zoomstart dragstart', () => {
  if (map.hasLayer(coordsPopup)) map.closePopup(coordsPopup);
});

/* ========== Mobile: doble pulsación con 1 dedo ========== */
if (IS_TOUCH) { map.doubleClickZoom?.disable(); }

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
  if (ev.touches.length > 1) { multiTouch = true; pinching = true; }
}, { passive: true });

map.getContainer().addEventListener('touchmove', (ev) => {
  if (ev.touches.length > 1) pinching = true;
}, { passive: true });

map.getContainer().addEventListener('touchend', (ev) => {
  if (ev.touches.length === 0) {
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
  const touch = ev.changedTouches && ev.changedTouches[0];
  if (!touch) return;
  if (pinching || multiTouch) return;
  if (isOverUiClientXY(touch.clientX, touch.clientY)) return;

  const tapDuration = Date.now() - startedAt;
  if (moved || tapDuration > 250) { startPoint = null; return; }

  const now = Date.now();
  const p = map.mouseEventToContainerPoint(touch);

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
    lastTapTime = 0;
    lastTapPoint = null;
  } else {
    lastTapTime = now;
    lastTapPoint = p;
  }

  startPoint = null;
}, { passive: false });

