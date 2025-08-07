// modules/hookExistingToggle.js
import { togglePanel } from './panel.js';

const TARGET_PANEL_ID = 'panel';

function findExistingButton() {
    let btn = document.getElementById('btn-pjs');
    if (btn) return btn;

    btn = document.querySelector('[data-toggle="panel"]');
    if (btn) return btn;

    const scope = document.querySelector('.leaflet-top.leaflet-right') || document;
    const candidates = scope.querySelectorAll('.leaflet-control *');
    for (const el of candidates) {
        const txt = (el.textContent || '').trim().toLowerCase();
        const title = (el.getAttribute?.('title') || '').trim().toLowerCase();
        if (txt === 'pjs' || title === 'pjs') return el;
    }
    return null;
}

function bindTo(btn) {
    if (!btn || btn.dataset.bound === '1') return;
    btn.dataset.bound = '1';
    if (window.L?.DomEvent?.disableClickPropagation) {
        try { L.DomEvent.disableClickPropagation(btn); } catch { }
    }
    btn.addEventListener('click', (e) => {
        e.preventDefault(); e.stopPropagation();
        togglePanel(TARGET_PANEL_ID);
    }, { passive: false });
}

function tryBindNow() { const b = findExistingButton(); if (b) bindTo(b); return !!b; }

function observeUntilFound() {
    if (tryBindNow()) return;
    const obs = new MutationObserver(() => { if (tryBindNow()) obs.disconnect(); });
    obs.observe(document.documentElement, { childList: true, subtree: true });
    setTimeout(() => obs.disconnect(), 15000);
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', observeUntilFound);
} else {
    observeUntilFound();
}
