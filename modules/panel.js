// modules/panel.js

/** Cache local para no hacer query del DOM cada vez */
const panelCache = new Map();

/** Obtiene el panel, con cache. */
function getPanel(id = 'panel') {
    if (!id || typeof id !== 'string') return null;
    if (panelCache.has(id)) return panelCache.get(id) || null;
    const el = document.getElementById(id) || null;
    if (el) panelCache.set(id, el);
    return el;
}

/** Devuelve true si el panel está oculto (por clase). */
export function isPanelHidden(id = 'panel') {
    const el = getPanel(id);
    return el ? el.classList.contains('is-hidden') : true;
}

/**
 * Oculta/muestra el panel de forma idempotente.
 * @returns {boolean} visible - estado final (true si visible)
 */
export function setPanelHidden(id = 'panel', hidden = false) {
    const el = getPanel(id);
    if (!el) {
        console.warn(`[panel] No se encontró #${id}`);
        return false;
    }

    const currentlyHidden = el.classList.contains('is-hidden');
    if (hidden === currentlyHidden) {
        // No hay cambio; devolvemos estado actual (visible = !hidden)
        return !hidden;
    }

    if (hidden) el.classList.add('is-hidden');
    else el.classList.remove('is-hidden');

    // Accesibilidad básica: reflejar estado en ARIA
    el.setAttribute('aria-hidden', String(hidden));

    // Notificar cambio de layout para que Leaflet recalcule tamaño
    scheduleLayoutInvalidate(el);

    return !hidden;
}

/** Muestra el panel. Devuelve true si quedó visible. */
export function showPanel(id = 'panel') {
    return setPanelHidden(id, false);
}

/** Oculta el panel. Devuelve false (no visible). */
export function hidePanel(id = 'panel') {
    return !setPanelHidden(id, true);
}

/**
 * Alterna visibilidad del panel.
 * @returns {boolean} visible - estado final (true si visible)
 */
export function togglePanel(id = 'panel') {
    const el = getPanel(id);
    if (!el) {
        console.warn(`[panel] No se encontró #${id}`);
        return false;
    }
    return setPanelHidden(id, el.classList.contains('is-hidden') ? false : true);
}

/* ================================
   Recalculo robusto del mapa
   (layout → invalidateSize)
================================ */
let invalidateScheduled = false;

function scheduleLayoutInvalidate(el) {
    // 1) Intentar tras el fin de transición del panel (si existe)
    //    Lo hacemos "once" para no acumular listeners.
    el.addEventListener('transitionend', fireInvalidateOnce, { once: true });

    // 2) Doble rAF asegura que el layout haya aplicado clases y estilos
    requestAnimationFrame(() => requestAnimationFrame(fireInvalidate));

    // 3) Respaldo por si no hubo transición ni rAF oportuno
    setTimeout(fireInvalidate, 350);
}

function fireInvalidateOnce() {
    fireInvalidate();
}

function fireInvalidate() {
    if (invalidateScheduled) return;
    invalidateScheduled = true;

    // micro-bacheo por si llegan múltiples triggers en cascada
    setTimeout(() => {
        try {
            // Helper directo (si existe)
            window.__invalidateMap__?.();
            // Evento desacoplado (tu Map.js lo escucha)
            document.dispatchEvent(new Event('app:layout-change'));
        } finally {
            invalidateScheduled = false;
        }
    }, 0);
}
