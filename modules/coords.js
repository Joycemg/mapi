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

if ('ontouchstart' in window) {
    map.doubleClickZoom?.disable();
}

let lastTouchTime = 0;
let lastTouchPos = null;

map.getContainer().addEventListener('touchend', async (ev) => {
    // Solo un dedo
    if (ev.touches.length > 0 || ev.changedTouches.length !== 1) return;

    const now = Date.now();
    const touch = ev.changedTouches[0];

    // Ignorar toques largos
    if (touch.duration && touch.duration > 300) return;

    const containerPoint = map.mouseEventToContainerPoint(touch);
    const latlng = map.containerPointToLatLng(containerPoint);

    // Comparar con el toque anterior
    const timeDiff = now - lastTouchTime;
    const samePlace = lastTouchPos &&
        Math.abs(containerPoint.x - lastTouchPos.x) < 15 &&
        Math.abs(containerPoint.y - lastTouchPos.y) < 15;

    if (timeDiff < 300 && samePlace) {
        // Es un doble tap real
        ev.preventDefault();
        ev.stopPropagation();
        const text = `${fmt(latlng.lat)}, ${fmt(latlng.lng)}`;
        const copied = await copyToClipboard(text);
        showCoordsPopup(latlng, copied);
        lastTouchTime = 0;
        lastTouchPos = null;
    } else {
        lastTouchTime = now;
        lastTouchPos = containerPoint;
    }
}, { passive: false });
