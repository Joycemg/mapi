// modules/toolsBus.js
// Bus de herramientas: exclusividad, toggles, acciones momentáneas y eventos.
// API:
//  registerTool(name, { enable, disable, isActive?, sticky=true, buttons?: string|string[] })
//  activateTool(name, opts?)
//  deactivateTool(name, opts?)
//  toggleTool(name, opts?)
//  getActiveTool()
//  isToolActive(name)
//  deactivateAll()
// Eventos CustomEvent en document:
//  'bus:will-activate'  {from, to}
//  'bus:did-activate'   {name}
//  'bus:did-deactivate' {name}

const registry = new Map(); // name -> config
let current = null;
let lock = false;

// ---- utils ----
function safe(fn, ...a) { try { return fn?.(...a); } catch (e) { console.error('[toolsBus]', e); } }
function toArray(x) { return Array.isArray(x) ? x : (x ? [x] : []); }
function fire(name, detail) { try { document.dispatchEvent(new CustomEvent(name, { detail })); } catch { } }

// Delegado global para botones declarados por selector (dinámicos también)
const selectorMap = new Map(); // selector -> toolName
document.addEventListener('click', (ev) => {
    const t = ev.target;
    if (!(t instanceof HTMLElement)) return;
    for (const [sel, tool] of selectorMap.entries()) {
        const hit = t.closest(sel);
        if (hit) {
            ev.preventDefault();
            ev.stopPropagation();
            toggleTool(tool, { manual: true, source: 'button', element: hit });
            break;
        }
    }
}, { capture: true });

export function registerTool(name, cfg) {
    if (!name || typeof name !== 'string') throw new Error('registerTool: name inválido');
    const config = {
        enable: cfg.enable || (() => { }),
        disable: cfg.disable || (() => { }),
        isActive: cfg.isActive,           // opcional
        sticky: cfg.sticky !== false,    // por defecto es “modo” (permanece activo)
        buttons: toArray(cfg.buttons)     // selectores que togglean esta tool
    };
    registry.set(name, config);

    // cableado de botones por selector (delegado)
    config.buttons.forEach(sel => selectorMap.set(sel, name));
}

export function getActiveTool() { return current; }

export function isToolActive(name) {
    const cfg = registry.get(name);
    if (!cfg) return false;
    if (typeof cfg.isActive === 'function') return !!safe(cfg.isActive);
    return current === name;
}

export function activateTool(name, opts = {}) {
    if (!registry.has(name)) return false;
    if (lock) return false;
    lock = true;

    const next = registry.get(name);
    const from = current;

    // ya está activa?
    if (isToolActive(name) && next.sticky) { lock = false; return true; }

    fire('bus:will-activate', { from, to: name });

    // 1) apagar todas las demás
    for (const [n, cfg] of registry.entries()) {
        if (n === name) continue;
        safe(cfg.disable, { reason: 'switch', to: name, ...opts });
    }

    // 2) activar la nueva
    safe(next.enable, opts);

    // 3) estado actual (si no es sticky, no queda “activa”)
    current = next.sticky ? name : null;

    fire('bus:did-activate', { name });
    lock = false;
    return true;
}

export function deactivateTool(name, opts = {}) {
    if (!registry.has(name)) return false;
    if (lock) return false;
    lock = true;

    const cfg = registry.get(name);
    safe(cfg.disable, { reason: 'manual', ...opts });
    if (current === name) current = null;

    fire('bus:did-deactivate', { name });
    lock = false;
    return true;
}

export function toggleTool(name, opts = {}) {
    return isToolActive(name)
        ? deactivateTool(name, opts)
        : activateTool(name, opts);
}

export function deactivateAll() {
    for (const [n, cfg] of registry.entries()) safe(cfg.disable, { reason: 'reset' });
    current = null;
}
