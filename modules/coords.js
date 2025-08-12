// modules/coords.js
import { map } from './Map.js';

const fmt = (n, d = 6) => Number(n).toFixed(d);

/* ===== Clipboard ===== */
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

/* ===== Abrir Street View (app si es posible) ===== */
function buildMapsUrls(lat, lng) {
  const latS = fmt(lat), lngS = fmt(lng);
  return {
    webStreetView: `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${latS},${lngS}`,
    appStreetView: `comgooglemaps://?api=1&map_action=pano&viewpoint=${latS},${lngS}`
  };
}
function openStreetViewPreferApp(lat, lng) {
  const { webStreetView, appStreetView } = buildMapsUrls(lat, lng);
  const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

  if (isMobile) {
    try {
      const timer = setTimeout(() => {
        try { window.location.href = webStreetView; } catch { window.open(webStreetView, '_blank', 'noopener'); }
      }, 900);
      window.location.href = appStreetView; // intenta app
      setTimeout(() => clearTimeout(timer), 2000);
      return;
    } catch {
      window.location.href = webStreetView;
      return;
    }
  }
  try { window.open(webStreetView, '_blank', 'noopener'); } catch { window.location.href = webStreetView; }
}

/* ========== Popup reutilizable ========== */
const IS_TOUCH = 'ontouchstart' in window;
const POPUP_OFFSET_Y = IS_TOUCH ? -28 : -16;

let coordsPopup = L.popup({
  autoClose: true,
  closeOnClick: true,
  keepInView: true,
  offset: [0, POPUP_OFFSET_Y],
  maxWidth: 320
});

function buttonCompactHtml(id, icon, label) {
  return `
    <button id="${id}" class="btn-compact" style="
      flex:1 1 0;
      min-width:44px;
      height:44px;
      display:grid;
      place-items:center;
      border:1px solid #d1d5db;
      border-radius:8px;
      background:#fff;
      cursor:pointer;
      user-select:none;
      padding:0 8px;
    " title="${label}" aria-label="${label}">
      <div style="display:flex;flex-direction:column;align-items:center;gap:2px;">
        <span style="font-size:15px;line-height:1">${icon}</span>
        <small style="font:600 10px/1.1 system-ui,sans-serif;color:#111">${label}</small>
      </div>
    </button>
  `;
}

function buildPopupHtml(lat, lng, copiedNow = false) {
  const text = `${fmt(lat)}, ${fmt(lng)}`;
  return `
    <div class="coords-popup" data-lat="${lat}" data-lng="${lng}"
         style="font:12px/1.35 system-ui,sans-serif; min-width:220px; max-width:280px;">
      <input id="coords-input" value="${text}" readonly
        style="width:100%;box-sizing:border-box;padding:6px 8px;font:inherit;border:1px solid #d1d5db;border-radius:6px;">
      <div class="btn-row" style="
        display:flex;
        gap:6px;
        margin-top:8px;
        align-items:stretch;
        justify-content:space-between;
      ">
        ${buttonCompactHtml('copy-coords', '📋', copiedNow ? '¡Copiado!' : 'Copiar')}
        ${buttonCompactHtml('select-coords', '🔎', 'Seleccionar')}
        ${buttonCompactHtml('open-street', '🧭', 'Street View')}
      </div>
    </div>
  `;
}

function showCoordsPopup(latlng, copiedNow = false) {
  coordsPopup
    .setLatLng(latlng)
    .setContent(buildPopupHtml(latlng.lat, latlng.lng, copiedNow))
    .openOn(map);

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
  if (!t.closest('.leaflet-popup')) return;

  const root = t.closest('.leaflet-popup-content') || document;
  const wrap = root.querySelector('.coords-popup');

  // Resolver el botón aunque hagan click en elementos internos
  const btn = t.closest('button[id]');
  if (!btn) return;

  if (btn.id === 'copy-coords') {
    ev.preventDefault(); ev.stopPropagation();
    const inp = root.querySelector('#coords-input');
    const text = inp?.value || '';
    const ok = await copyToClipboard(text);
    const label = btn.querySelector('small');
    if (label) {
      label.textContent = ok ? '¡Copiado!' : 'Error';
      setTimeout(() => (label.textContent = 'Copiar'), 1100);
    }
  }

  if (btn.id === 'select-coords') {
    ev.preventDefault(); ev.stopPropagation();
    const inp = root.querySelector('#coords-input');
    inp?.focus(); inp?.select(); inp?.setSelectionRange(0, inp.value.length);
  }

  if (btn.id === 'open-street') {
    ev.preventDefault(); ev.stopPropagation();
    const lat = Number(wrap?.dataset.lat);
    const lng = Number(wrap?.dataset.lng);
    if (isFinite(lat) && isFinite(lng)) openStreetViewPreferApp(lat, lng);
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
const MAX_DT_MS = 350;
const MAX_MOVE_PX = 10;

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

// Doble tap limpio
map.getContainer().addEventListener('touchstart', (ev) => {
  if (ev.touches.length !== 1) return;
  const t = ev.touches[0];
  if (isOverUiClientXY(t.clientX, t.clientY)) return;
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
    let copied = false; try { copied = await copyToClipboard(`${fmt(latlng.lat)}, ${fmt(latlng.lng)}`); } catch { }
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
