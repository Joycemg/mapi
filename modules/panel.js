// modules/panel.js
function getPanel(id = 'panel') { return document.getElementById(id); }

export function showPanel(id = 'panel') { getPanel(id)?.classList.remove('is-hidden'); }
export function hidePanel(id = 'panel') { getPanel(id)?.classList.add('is-hidden'); }
export function togglePanel(id = 'panel') {
    const el = getPanel(id);
    if (!el) return console.warn(`No se encontró panel #${id}`);
    el.classList.toggle('is-hidden');
}
