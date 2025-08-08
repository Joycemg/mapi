// modules/characters.js
import { map } from './Map.js';
import { charactersRef } from '../config/firebase.js';
import { deactivateDrawingTools } from './pencil.js'; // apaga lápiz/goma

const markers = {};
const characterEntries = {};

// 🔹 Capa para estelas y estado por marker
const trailsLayer = L.layerGroup().addTo(map);
const trailsState = {}; // id -> { poly, lastLL, fadeTimer }

// Utils de trail
function ensureTrail(id, color, startLL) {
    // Si ya existe, reusamos
    if (trailsState[id]?.poly) return trailsState[id];

    const poly = L.polyline([startLL], {
        color,
        weight: 3,
        opacity: 0.85,
        dashArray: '4,6',
        lineCap: 'round',
        pane: 'overlayPane', // sobre el mapa
        className: 'movement-trail'
    }).addTo(trailsLayer);

    const state = { poly, lastLL: startLL, fadeTimer: null };
    trailsState[id] = state;
    return state;
}

function appendToTrail(id, ll) {
    const st = trailsState[id];
    if (!st?.poly) return;
    st.poly.addLatLng(ll);
    st.lastLL = ll;
}

function startTrailFade(id, durationMs = 1200, steps = 12) {
    const st = trailsState[id];
    if (!st?.poly) return;

    // Limpia fade previo si hubiera
    if (st.fadeTimer) {
        clearInterval(st.fadeTimer);
        st.fadeTimer = null;
    }

    const poly = st.poly;
    let step = 0;
    const baseOpacity = poly.options.opacity ?? 0.85;
    const tickMs = Math.max(16, Math.floor(durationMs / steps));

    st.fadeTimer = setInterval(() => {
        step++;
        const k = Math.max(0, 1 - step / steps);
        poly.setStyle({ opacity: baseOpacity * k });
        if (step >= steps) {
            clearInterval(st.fadeTimer);
            st.fadeTimer = null;
            trailsLayer.removeLayer(poly);
            trailsState[id] = { poly: null, lastLL: null, fadeTimer: null };
        }
    }, tickMs);
}

const renderCharacter = (doc) => {
    const data = doc.data();
    const id = doc.id;

    if (!markers[id]) {
        // HTML del marker
        const markerHtml = document.createElement('div');
        Object.assign(markerHtml.style, {
            backgroundColor: data.color,
            width: '20px',
            height: '20px',
            borderRadius: '50%',
            border: '2px solid black',
            position: 'relative',
            boxSizing: 'border-box'
        });

        // Label centrado
        const label = document.createElement('div');
        label.className = 'marker-label';
        label.textContent = data.name;
        Object.assign(label.style, {
            position: 'absolute',
            top: '-20px',
            left: '50%',
            transform: 'translateX(-50%)',
            padding: '0 4px',
            font: '600 11px/1 system-ui, sans-serif',
            background: 'rgba(0, 0, 0, 0.8)',
            borderRadius: '4px',
            whiteSpace: 'nowrap',
            pointerEvents: 'none'
        });

        markerHtml.appendChild(label);

        const icon = L.divIcon({ html: markerHtml.outerHTML, className: '' });
        const marker = L.marker([data.lat, data.lng], { icon, draggable: true }).addTo(map);

        // 🔸 Al tocar/arrastrar un marker, desactiva herramientas
        const stopAndDeactivate = (ev) => {
            ev.originalEvent?.preventDefault?.();
            ev.originalEvent?.stopPropagation?.();
            deactivateDrawingTools();
        };

        marker.on('click', stopAndDeactivate);
        marker.on('touchstart', stopAndDeactivate);

        // 🔹 Trail: iniciar al comenzar el drag
        marker.on('dragstart', (e) => {
            deactivateDrawingTools();

            const startLL = e.target.getLatLng();
            const st = ensureTrail(id, data.color || '#000', startLL);

            // Por si tenía un fade anterior corriendo
            if (st.fadeTimer) {
                clearInterval(st.fadeTimer);
                st.fadeTimer = null;
            }
            // Reiniciamos la polyline con el punto inicial
            st.poly.setLatLngs([startLL]);
            st.poly.setStyle({ opacity: 0.85, color: data.color || '#000' });
            st.lastLL = startLL;
        });

        // 🔹 Trail: agregar puntos mientras se arrastra
        marker.on('drag', (e) => {
            const ll = e.target.getLatLng();
            const st = ensureTrail(id, data.color || '#000', ll);

            // Umbral para no generar demasiados puntos
            const last = st.lastLL;
            const dist = last ? L.latLng(last).distanceTo(ll) : Infinity; // en metros
            if (dist >= 2) { // ajustá el umbral a gusto (2–5m suele ir bien)
                appendToTrail(id, ll);
            }
        });

        // 🔹 Trail: al soltar, cerrar y desvanecer
        marker.on('dragend', ({ target }) => {
            const { lat, lng } = target.getLatLng();
            charactersRef.doc(id).update({ lat, lng });

            // agrega último punto por si quedó uno pendiente
            const st = trailsState[id];
            if (st?.poly) {
                const ll = target.getLatLng();
                appendToTrail(id, ll);
                startTrailFade(id, 1400, 14); // duración/steps del fade
            }
        });

        markers[id] = marker;
    } else {
        markers[id].setLatLng([data.lat, data.lng]);
    }

    // Lista lateral / panel
    if (!characterEntries[id]) {
        const entry = document.createElement('div');
        entry.className = 'character-entry';
        entry.id = `entry-${id}`;
        entry.innerHTML = `
      <span>${data.name}</span>
      <button data-action="locate" data-id="${id}" title="Centrar">📍</button>
      <button data-action="delete" data-id="${id}" title="Eliminar">❌</button>
    `;
        document.getElementById('character-list')?.appendChild(entry);
        characterEntries[id] = entry;

        // Delegación simple de eventos en la entry
        entry.addEventListener('click', (e) => {
            const btn = e.target.closest('button');
            if (!btn) return;
            const action = btn.getAttribute('data-action');
            const targetId = btn.getAttribute('data-id');
            if (action === 'locate') locateCharacter(targetId);
            if (action === 'delete') deleteCharacter(targetId);
        });
    } else {
        characterEntries[id].querySelector('span').textContent = data.name;
    }
};

function locateCharacter(id) {
    if (markers[id]) {
        deactivateDrawingTools();
        map.setView(markers[id].getLatLng(), 17);
    }
}

function deleteCharacter(id) {
    // limpiar trail si existiera
    const st = trailsState[id];
    if (st?.poly) {
        if (st.fadeTimer) clearInterval(st.fadeTimer);
        trailsLayer.removeLayer(st.poly);
        delete trailsState[id];
    }
    charactersRef.doc(id).delete();
}

// Compat global (si lo venías usando así)
window.locateCharacter = locateCharacter;
window.deleteCharacter = deleteCharacter;

function addCharacter() {
    const nameInput = document.getElementById('name');
    const colorInput = document.getElementById('color');
    const name = nameInput?.value.trim() || 'Sin nombre';
    const color = colorInput?.value || '#000000';
    const { lat, lng } = map.getCenter();

    charactersRef.add({ name, color, lat, lng });
    if (nameInput) nameInput.value = '';
}

document.getElementById('add-button')?.addEventListener('click', addCharacter);

// Suscripción a Firestore
charactersRef.onSnapshot((snapshot) => {
    snapshot.docChanges().forEach((change) => {
        const { id } = change.doc;

        if (change.type === 'added' || change.type === 'modified') {
            renderCharacter(change.doc);
        }

        if (change.type === 'removed') {
            if (markers[id]) { map.removeLayer(markers[id]); delete markers[id]; }
            if (characterEntries[id]) { characterEntries[id].remove(); delete characterEntries[id]; }

            // limpiar trail al remover personaje
            const st = trailsState[id];
            if (st?.poly) {
                if (st.fadeTimer) clearInterval(st.fadeTimer);
                trailsLayer.removeLayer(st.poly);
                delete trailsState[id];
            }
        }
    });
});
