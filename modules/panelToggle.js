// modules/panelToggle.js
import { map } from './Map.js';
import { togglePanel } from './panel.js';

const TARGET_PANEL_ID = 'panel';

const PanelToggleControl = L.Control.extend({
    options: { position: 'topright' }, // junto al buscador
    onAdd() {
        const wrap = L.DomUtil.create('div', 'leaflet-bar panel-toggle-wrap');
        const btn = L.DomUtil.create('a', 'panel-toggle-btn', wrap);
        btn.href = '#';
        btn.title = 'Mostrar/ocultar panel';
        btn.textContent = 'Pjs';

        // Evitar que el click burbujee al mapa
        L.DomEvent.disableClickPropagation(btn);

        L.DomEvent.on(btn, 'click', (e) => {
            e.preventDefault();
            togglePanel(TARGET_PANEL_ID);
            scheduleInvalidate(); // <- recalcular Leaflet de forma robusta
        });

        return wrap;
    }
});

map.addControl(new PanelToggleControl());

/* ================================
   Recalculo robusto del mapa
   ================================ */
function scheduleInvalidate() {
    const panelEl = document.getElementById(TARGET_PANEL_ID);

    const fire = () => {
        // helper directo (si lo definiste en Map.js)
        window.__invalidateMap__?.();
        // evento desacoplado (también lo escucha Map.js)
        document.dispatchEvent(new Event('app:layout-change'));
    };

    if (!panelEl) {
        fire();
        return;
    }

    // 1) Si el panel tiene transición CSS, esperamos su fin (una vez)
    const onEnd = () => fire();
    panelEl.addEventListener('transitionend', onEnd, { once: true });

    // 2) Doble rAF para asegurar que el layout se haya asentado
    requestAnimationFrame(() => requestAnimationFrame(fire));

    // 3) Respaldo por si no hubo transición ni rAF oportuno
    setTimeout(fire, 350);
}
