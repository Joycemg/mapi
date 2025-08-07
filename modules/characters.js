// modules/characters.js
import { map } from './Map.js';
import { charactersRef } from '../config/firebase.js';

const markers = {};
const characterEntries = {};

const renderCharacter = (doc) => {
    const data = doc.data();
    const id = doc.id;

    if (!markers[id]) {
        const markerHtml = document.createElement('div');
        Object.assign(markerHtml.style, {
            backgroundColor: data.color,
            width: '20px',
            height: '20px',
            borderRadius: '50%',
            border: '2px solid black',
            position: 'relative'
        });

        const label = document.createElement('div');
        label.className = 'marker-label';
        label.textContent = data.name;
        Object.assign(label.style, { position: 'absolute', top: '-20px', left: '-10px' });

        markerHtml.appendChild(label);

        const icon = L.divIcon({ html: markerHtml.outerHTML, className: '' });
        const marker = L.marker([data.lat, data.lng], { icon, draggable: true }).addTo(map);

        marker.on('dragend', ({ target }) => {
            const { lat, lng } = target.getLatLng();
            charactersRef.doc(id).update({ lat, lng });
        });

        markers[id] = marker;
    } else {
        markers[id].setLatLng([data.lat, data.lng]);
    }

    if (!characterEntries[id]) {
        const entry = document.createElement('div');
        entry.className = 'character-entry';
        entry.id = `entry-${id}`;
        entry.innerHTML = `
      <span>${data.name}</span>
      <button onclick="locateCharacter('${id}')">📍</button>
      <button onclick="deleteCharacter('${id}')">❌</button>
    `;
        document.getElementById('character-list')?.appendChild(entry);
        characterEntries[id] = entry;
    } else {
        characterEntries[id].querySelector('span').textContent = data.name;
    }
};

function locateCharacter(id) {
    if (markers[id]) map.setView(markers[id].getLatLng(), 17);
}

function deleteCharacter(id) {
    charactersRef.doc(id).delete();
}

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

charactersRef.onSnapshot((snapshot) => {
    snapshot.docChanges().forEach((change) => {
        const { id } = change.doc;

        if (change.type === 'added' || change.type === 'modified') {
            renderCharacter(change.doc);
        }

        if (change.type === 'removed') {
            if (markers[id]) { map.removeLayer(markers[id]); delete markers[id]; }
            if (characterEntries[id]) { characterEntries[id].remove(); delete characterEntries[id]; }
        }
    });
});
