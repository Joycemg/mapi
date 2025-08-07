// modules/pencil.js

let isDrawing = false;
let currentLine = null;
let selectedColor = 'black';
let selectedWeight = 2;
const drawnFromFirebase = new Set();
let pencilButton = null;
let eraserButton = null;
let mouseDownOnMap = false;

const PencilControl = L.Control.extend({
    options: { position: 'topleft' },
    onAdd() {
        const wrapper = L.DomUtil.create('div', 'leaflet-bar pencil-wrapper');

        pencilButton = createButton('✏️', 'custom-pencil', 'Herramienta lápiz', wrapper, handlePencilClick);
        eraserButton = createButton('🧽', 'custom-eraser', 'Goma para borrar trazos', wrapper, handleEraserClick);

        const colorSelector = createColorSelector(wrapper);
        const weightSelector = createWeightSelector(wrapper);

        wrapper.append(colorSelector, weightSelector);
        return wrapper;
    }
});

map.addControl(new PencilControl());

function createButton(icon, className, title, container, clickHandler) {
    const button = L.DomUtil.create('a', className, container);
    button.innerHTML = icon;
    button.href = '#';
    button.title = title;
    button.onclick = e => {
        e.preventDefault();
        clickHandler();
    };
    return button;
}

function createColorSelector(container) {
    const selector = L.DomUtil.create('div', 'color-selector', container);
    ['black', 'white', 'red'].forEach(color => {
        const btn = L.DomUtil.create('div', `pencil-color ${color}`, selector);
        btn.onclick = () => {
            selectedColor = color;
            pencilButton.style.backgroundColor = color;
        };
    });
    return selector;
}

function createWeightSelector(container) {
    const selector = L.DomUtil.create('div', 'weight-selector', container);
    const weights = [
        { w: 2, label: 'Fino' },
        { w: 4, label: 'Medio' },
        { w: 6, label: 'Grueso' }
    ];

    weights.forEach(({ w, label }) => {
        const btn = L.DomUtil.create('div', 'weight-option', selector);
        btn.innerHTML = `<div style="width:30px;height:0;border-top:${w}px solid black;margin-bottom:2px"></div>${label}`;
        btn.onclick = () => {
            selectedWeight = w;
            [...selector.children].forEach(child => child.classList.remove('selected'));
            btn.classList.add('selected');
        };
    });

    return selector;
}

function handlePencilClick() {
    disableEraser();
    pencilButton.classList.contains('active') ? disablePencil() : enablePencil();
}

function handleEraserClick() {
    disablePencil();
    eraserButton.classList.contains('active') ? disableEraser() : enableEraser();
}

function enablePencil() {
    pencilButton.classList.add('active');
    pencilButton.style.backgroundColor = selectedColor;
    toggleUI('flex');
    map.dragging.disable();
    document.getElementById('panel').style.display = 'none';

    const container = map.getContainer();
    container.addEventListener('mousedown', onMouseDown);
    container.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
}

function disablePencil() {
    pencilButton.classList.remove('active');
    pencilButton.style.backgroundColor = selectedColor;
    toggleUI('none');
    map.dragging.enable();
    document.getElementById('panel').style.display = 'block';

    const container = map.getContainer();
    container.removeEventListener('mousedown', onMouseDown);
    container.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('mouseup', onMouseUp);

    isDrawing = false;
    currentLine = null;
    mouseDownOnMap = false;
}

function toggleUI(display) {
    const parent = pencilButton.parentElement;
    const colorSelector = parent.querySelector('.color-selector');
    const weightSelector = parent.querySelector('.weight-selector');
    if (colorSelector) colorSelector.style.display = display;
    if (weightSelector) weightSelector.style.display = display;
}

function onMouseDown(e) {
    const target = e.originalEvent?.target || e.target;
    if (
        target.closest('.leaflet-marker-icon') ||
        target.closest('.leaflet-popup') ||
        target.closest('.leaflet-control') ||
        target.closest('.leaflet-interactive')
    ) return;

    if (e.originalEvent?.button !== 0 && e.button !== 0) return;

    mouseDownOnMap = true;
    isDrawing = true;
    const latlng = map.mouseEventToLatLng(e);
    currentLine = L.polyline([latlng], {
        color: selectedColor,
        weight: selectedWeight
    }).addTo(drawnItems);
}

function onMouseMove(e) {
    if (!isDrawing || !currentLine || !mouseDownOnMap || e.buttons !== 1) return;
    currentLine.addLatLng(map.mouseEventToLatLng(e));
}

function onMouseUp() {
    if (!currentLine || !mouseDownOnMap) return;

    const geo = currentLine.toGeoJSON().geometry;
    const style = currentLine.options;
    const id = `pencil-${Date.now()}`;

    db.collection("shapes").doc(id).set({ type: "pencil", data: geo, style });
    currentLine._firebaseId = id;

    isDrawing = false;
    currentLine = null;
    mouseDownOnMap = false;
}

function enableEraser() {
    eraserButton.classList.add('active');
    map.dragging.disable();
    document.getElementById('panel').style.display = 'none';
    map.getContainer().style.cursor = 'crosshair';

    drawnItems.eachLayer(layer => {
        if (layer instanceof L.Polyline && !(layer instanceof L.Polygon)) {
            layer.on('click', onEraseClick);
            layer.on('mouseover', () => layer.setStyle({ opacity: 0.4 }));
            layer.on('mouseout', () => layer.setStyle({ opacity: 1 }));
        }
    });
}

function disableEraser() {
    eraserButton.classList.remove('active');
    map.dragging.enable();
    document.getElementById('panel').style.display = 'block';
    map.getContainer().style.cursor = '';

    drawnItems.eachLayer(layer => {
        layer.off('click', onEraseClick);
        layer.off('mouseover');
        layer.off('mouseout');
        layer.setStyle({ opacity: 1 });
    });
}

function onEraseClick(e) {
    const layer = e.target;
    const id = layer._firebaseId;
    if (id) db.collection("shapes").doc(id).delete();
    drawnItems.removeLayer(layer);
}

db.collection("shapes").onSnapshot(snapshot => {
    snapshot.docChanges().forEach(change => {
        const id = change.doc.id;
        if (change.type === "added") {
            if (drawnFromFirebase.has(id)) return;
            drawnFromFirebase.add(id);

            const shape = change.doc.data();
            if (shape.type === "pencil") {
                const layer = L.geoJSON({ type: "Feature", geometry: shape.data }, {
                    style: shape.style
                }).getLayers()[0];
                layer._firebaseId = id;
                drawnItems.addLayer(layer);
            }
        } else if (change.type === "removed") {
            drawnItems.eachLayer(layer => {
                if (layer._firebaseId === id) {
                    drawnItems.removeLayer(layer);
                }
            });
        }
    });
});
