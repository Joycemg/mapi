// modules/leftControlsToggle.js
import { map } from './Map.js';

const CLASS_COLLAPSED = 'map-tools-collapsed-left';
const LS_KEY = 'leftControlsCollapsed';

function scheduleInvalidate() {
    const fire = () => {
        try { window.__invalidateMap__?.(); } catch { }
        try { document.dispatchEvent(new Event('app:layout-change')); } catch { }
    };
    // doble rAF + respaldo + (si hay transición) esperar fin
    const cont = map.getContainer();
    const leftTop = cont.querySelector('.leaflet-top.leaflet-left');
    const leftBottom = cont.querySelector('.leaflet-bottom.leaflet-left');
    if (leftTop) leftTop.addEventListener('transitionend', fire, { once: true });
    if (leftBottom) leftBottom.addEventListener('transitionend', fire, { once: true });
    requestAnimationFrame(() => requestAnimationFrame(fire));
    setTimeout(fire, 350);
}

function apply(collapsed, btn) {
    const cont = map.getContainer();
    cont.classList.toggle(CLASS_COLLAPSED, collapsed);
    if (btn) {
        btn.setAttribute('aria-pressed', String(collapsed));
        btn.title = collapsed ? 'Mostrar herramientas' : 'Ocultar herramientas';
        btn.textContent = collapsed ? '»' : '«'; // « oculta | » muestra
    }
    try { localStorage.setItem(LS_KEY, collapsed ? '1' : '0'); } catch { }
    scheduleInvalidate();
}

function createButton() {
    const btn = document.createElement('a');
    btn.href = '#';
    btn.className = 'tools-collapse-btn';
    btn.setAttribute('role', 'button');
    btn.setAttribute('aria-label', 'Ocultar herramientas');
    btn.setAttribute('aria-pressed', 'false');

    // estilos compactos para que calce junto a “Pjs”
    Object.assign(btn.style, {
        textAlign: 'center',
        width: '28px',
        height: '28px',
        lineHeight: '28px',
        userSelect: 'none',
        borderLeft: '1px solid #ddd'
    });

    btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const collapsed = !map.getContainer().classList.contains(CLASS_COLLAPSED);
        apply(collapsed, btn);
    }, { passive: false });

    // Estado inicial (persistido)
    const initial = (() => { try { return localStorage.getItem(LS_KEY) === '1'; } catch { return false; } })();
    apply(initial, btn);

    return btn;
}

// Inserta el botón *al lado* del botón Pjs (dentro del mismo wrapper)
(function mountNextToPjs() {
    const tryMount = () => {
        // El control de Pjs usa este wrapper (ver panelToggle.js)
        const wrap = document.querySelector('.panel-toggle-wrap');
        if (!wrap) return false;

        // Asegurá layout horizontal de Pjs + este botón
        wrap.style.display = 'inline-flex';
        wrap.style.gap = '4px';
        wrap.style.alignItems = 'center';

        // Evitar burbujeo desde el contenedor
        if (window.L?.DomEvent) {
            try {
                L.DomEvent.disableClickPropagation(wrap);
                L.DomEvent.disableScrollPropagation(wrap);
            } catch { }
        }

        // Añadir botón
        const btn = createButton();
        wrap.appendChild(btn);
        return true;
    };

    if (tryMount()) return;

    // Si aún no existe (por orden de carga), observar hasta 10s
    const obs = new MutationObserver(() => { if (tryMount()) obs.disconnect(); });
    obs.observe(document.documentElement, { childList: true, subtree: true });
    setTimeout(() => obs.disconnect(), 10000);
})();
