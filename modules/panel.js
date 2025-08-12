// modules/panel.js
// Panel inferior: arranca oculto y se abre SOLO manualmente.
// Este archivo incluye el botón Leaflet “Pjs” (topright) para mostrar/ocultar el panel.
// Además, cierra el panel cuando usás otras herramientas (geocoder, draw, notas) o
// cuando interactuás con el mapa. No requiere ningún otro módulo para togglear.

import { map } from './Map.js';

const PANEL_ID = 'panel';

const panelCache = new Map();
let mustOpenManually = true;

function getPanel() {
    if (panelCache.has(PANEL_ID)) return panelCache.get(PANEL_ID) || null;
    const el = document.getElementById(PANEL_ID) || null;
    if (el) panelCache.set(PANEL_ID, el);
    return el;
}

export function isPanelHidden() {
    const el = getPanel();
    if (!el) return true;
    const st = getComputedStyle(el);
    return el.classList.contains('is-hidden') || st.display === 'none' || st.visibility === 'hidden';
}

function scheduleLayoutInvalidate(el) {
    const fire = () => {
        try { window.__invalidateMap__?.(); } catch { }
        try { document.dispatchEvent(new Event('app:layout-change')); } catch { }
    };
    if (el) el.addEventListener('transitionend', fire, { once: true });
    requestAnimationFrame(() => requestAnimationFrame(fire));
    setTimeout(fire, 350);
}

function setPanelHidden(hidden = false) {
    const el = getPanel();
    if (!el) { console.warn('[panel] No se encontró #panel'); return false; }

    const currentlyHidden = isPanelHidden();
    if (hidden === currentlyHidden) return !hidden;

    if (hidden) {
        el.classList.add('is-hidden');
        el.setAttribute('aria-hidden', 'true');
        el.style.display = 'none';
        mustOpenManually = true;
    } else {
        el.classList.remove('is-hidden');
        el.setAttribute('aria-hidden', 'false');
        if (el.style.display === 'none') el.style.display = '';
    }
    scheduleLayoutInvalidate(el);
    return !hidden;
}

export function showPanel(opts = {}) {
    const { manual = false, force = false } = opts || {};
    if (mustOpenManually && !manual && !force) return false;
    const ok = setPanelHidden(false);
    if (ok) mustOpenManually = false;
    return ok;
}
export function hidePanel() { return !setPanelHidden(true); }
export function togglePanel(opts = {}) {
    return isPanelHidden() ? showPanel({ manual: opts.manual ?? true }) : hidePanel();
}

function ensurePanelStartsHidden() {
    const hideNow = (el) => {
        if (!el) return;
        if (!el.classList.contains('is-hidden')) el.classList.add('is-hidden');
        el.setAttribute('aria-hidden', 'true');
        el.style.display = 'none';
        mustOpenManually = true;
    };
    let el = getPanel();
    if (el) { hideNow(el); return; }
    const obs = new MutationObserver(() => {
        el = getPanel();
        if (el) { hideNow(el); obs.disconnect(); }
    });
    obs.observe(document.documentElement || document.body, { childList: true, subtree: true });
}

/* =============== Botón Leaflet “Pjs” (integrado) =============== */
const PanelToggleControl = L.Control.extend({
    options: { position: 'topright' },
    onAdd() {
        const wrap = L.DomUtil.create('div', 'leaflet-bar panel-toggle-wrap');
        const btn = L.DomUtil.create('a', 'panel-toggle-btn', wrap);
        btn.href = '#';
        btn.title = 'Mostrar/ocultar panel';
        btn.textContent = 'Pjs';
        btn.setAttribute('role', 'button');
        btn.setAttribute('aria-controls', PANEL_ID);
        btn.setAttribute('aria-expanded', String(!isPanelHidden()));
        L.DomEvent.disableClickPropagation(wrap);
        L.DomEvent.disableScrollPropagation(wrap);
        L.DomEvent.on(btn, 'click', (e) => {
            e.preventDefault();
            const opened = togglePanel({ manual: true });
            btn.setAttribute('aria-expanded', String(opened));
        });

        // Si el panel aún no existe, sincronizar cuando aparezca
        if (!getPanel()) {
            const obs = new MutationObserver(() => {
                if (getPanel()) { btn.setAttribute('aria-expanded', String(!isPanelHidden())); obs.disconnect(); }
            });
            obs.observe(document.documentElement, { childList: true, subtree: true });
            setTimeout(() => obs.disconnect(), 10000);
        }
        return wrap;
    }
});
map.addControl(new PanelToggleControl());

/* =============== Integración / cierres automáticos =============== */
function closeForControlsDelegated() {
    document.addEventListener('click', (ev) => {
        const t = ev.target instanceof HTMLElement ? ev.target : null;
        if (!t) return;

        // Click en otros controles Leaflet (excepto el propio Pjs y zoom)
        const a = t.closest('.leaflet-top .leaflet-bar a');
        if (a) {
            if (a.classList.contains('panel-toggle-btn')) return;
            if (a.classList.contains('leaflet-control-zoom-in') || a.classList.contains('leaflet-control-zoom-out')) return;
            hidePanel(); return;
        }

        // Botones específicos (draw/notas/geocoder/eraser/etc.)
        const selectors = [
            '.leaflet-draw-draw-polyline', '.leaflet-draw-draw-polygon',
            '.leaflet-draw-draw-rectangle', '.leaflet-draw-draw-circle',
            '.leaflet-draw-draw-marker', '.leaflet-draw-edit-remove',
            '.leaflet-draw-edit-edit', '#btn-notes', '#btn-notes-list',
            '#btn-notes-edit', '#btn-eraser', '#btn-geo'
        ];
        for (const sel of selectors) {
            if (t.closest(sel)) { hidePanel(); return; }
        }
    }, { capture: true });
}

function closeOnGeocoderFocus() {
    document.addEventListener('focusin', (ev) => {
        const t = ev.target;
        if (!(t instanceof HTMLElement)) return;
        if (t.closest('.leaflet-control-geocoder, .geocoder-wrapper, .geocoder-box')) hidePanel();
    });
}

function closeOnMapInteraction() {
    try {
        const doHide = () => { if (!isPanelHidden()) hidePanel(); };
        if (map && typeof map.on === 'function') {
            map.on('mousedown touchstart dragstart zoomstart movestart click', doHide);
            map.on('wheel', doHide);
            const mc = map.getContainer?.();
            mc?.addEventListener('pointerdown', (e) => {
                const t = e.target;
                if (!(t instanceof HTMLElement)) return;
                if (t.closest('#panel, .panel-toggle-btn')) return;
                doHide();
            }, { capture: true, passive: true });
        }
    } catch { }
}

/* =============== Hook al posible botón HTML opcional =============== */
// Si en tu HTML tenés <button id="toggle-panel">, también lo cableamos.
function bindOptionalHtmlButton() {
    const bind = () => {
        const b = document.getElementById('toggle-panel');
        if (!b || b.dataset._panelBound === '1') return;
        b.dataset._panelBound = '1';
        b.addEventListener('click', (e) => { e.preventDefault(); togglePanel({ manual: true }); });
    };
    bind();
    const obs = new MutationObserver(bind);
    obs.observe(document.documentElement, { childList: true, subtree: true });
    setTimeout(() => obs.disconnect(), 15000);
}

/* =============== Init =============== */
function init() {
    ensurePanelStartsHidden();
    closeForControlsDelegated();
    closeOnGeocoderFocus();
    closeOnMapInteraction();
    bindOptionalHtmlButton();
}
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
} else {
    init();
}
