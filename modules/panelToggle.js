// modules/panelToggle.js
import { map } from './Map.js';

const TARGET_PANEL_ID = 'panel';

function getPanel() {
    return document.getElementById(TARGET_PANEL_ID);
}
function isHidden() {
    const el = getPanel();
    if (!el) return true;
    const st = getComputedStyle(el);
    return el.classList.contains('is-hidden') || st.display === 'none' || st.visibility === 'hidden';
}
function show() {
    const el = getPanel();
    if (!el) { console.warn('[panelToggle] No existe #panel en el DOM'); return false; }
    el.classList.remove('is-hidden');
    el.setAttribute('aria-hidden', 'false');
    // si quedó inline oculto, limpiamos
    if (el.style.display === 'none') el.style.display = '';
    // notificar (para que otros escuchen que se usó “pjs”)
    dispatchActivate('pjs');
    scheduleInvalidate();
    return true;
}
function hide() {
    const el = getPanel();
    if (!el) return false;
    el.classList.add('is-hidden');
    el.setAttribute('aria-hidden', 'true');
    el.style.display = 'none';
    dispatchActivate('pjs-hide');
    scheduleInvalidate();
    return true;
}
function toggle() { return isHidden() ? show() : hide(); }

function dispatchActivate(name) {
    try { document.dispatchEvent(new CustomEvent('tool:activate', { detail: { name } })); } catch { }
}

/* ================================
   Recalculo robusto del mapa
================================ */
function scheduleInvalidate() {
    const fire = () => {
        try { window.__invalidateMap__?.(); } catch { }
        try { document.dispatchEvent(new Event('app:layout-change')); } catch { }
    };

    const panelEl = getPanel();
    if (!panelEl) { fire(); return; }

    // 1) Si hay transición CSS, esperar (una vez)
    panelEl.addEventListener('transitionend', fire, { once: true });
    // 2) doble rAF
    requestAnimationFrame(() => requestAnimationFrame(fire));
    // 3) respaldo por si no hubo transition
    setTimeout(fire, 350);
}

/* ================================
   Control Leaflet (botón “Pjs”)
================================ */
const PanelToggleControl = L.Control.extend({
    options: { position: 'topright' },
    onAdd() {
        const wrap = L.DomUtil.create('div', 'leaflet-bar panel-toggle-wrap');
        const btn = L.DomUtil.create('a', 'panel-toggle-btn', wrap);

        btn.href = '#';
        btn.title = 'Mostrar/ocultar panel';
        btn.textContent = 'Pjs';
        btn.setAttribute('role', 'button');
        btn.setAttribute('aria-controls', TARGET_PANEL_ID);
        btn.setAttribute('aria-expanded', String(!isHidden()));

        // Evitar que el click llegue al mapa
        L.DomEvent.disableClickPropagation(wrap);
        L.DomEvent.disableScrollPropagation(wrap);

        L.DomEvent.on(btn, 'click', (e) => {
            e.preventDefault();
            const opened = toggle();
            btn.setAttribute('aria-expanded', String(opened));
        });

        // Si #panel todavía no existe, intentamos de nuevo cuando aparezca
        if (!getPanel()) {
            const obs = new MutationObserver(() => {
                if (getPanel()) { btn.setAttribute('aria-expanded', String(!isHidden())); obs.disconnect(); }
            });
            obs.observe(document.documentElement, { childList: true, subtree: true });
            // seguridad: cortar a los 10s
            setTimeout(() => obs.disconnect(), 10000);
        }

        return wrap;
    }
});

map.addControl(new PanelToggleControl());
