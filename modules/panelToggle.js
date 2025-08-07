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

        L.DomEvent.disableClickPropagation(btn);
        L.DomEvent.on(btn, 'click', (e) => {
            e.preventDefault();
            togglePanel(TARGET_PANEL_ID);
        });

        return wrap;
    }
});

map.addControl(new PanelToggleControl());
