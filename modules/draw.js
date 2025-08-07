// modules/draw.js

const drawnItems = new L.FeatureGroup();
map.addLayer(drawnItems);

// 🧠 Mapeo local de trazos para manejo individual
const renderedShapes = new Set();
const shapeLayersById = new Map();

// 🔁 Sincronización en tiempo real con Firebase
db.collection("shapes").onSnapshot(snapshot => {
    snapshot.docChanges().forEach(change => {
        const id = change.doc.id;

        if (change.type === "added") {
            if (renderedShapes.has(id)) return;
            renderedShapes.add(id);

            const { type, data, style } = change.doc.data();
            if (type === "pencil") {
                const [layer] = L.geoJSON({ type: "Feature", geometry: data }, { style }).getLayers();

                // Añadir al mapa y guardar referencia
                drawnItems.addLayer(layer);
                shapeLayersById.set(id, layer);

                // Permitir eliminación al hacer clic
                layer.on('click', () => {
                    db.collection("shapes").doc(id).delete();
                });
            }
        }

        if (change.type === "removed") {
            const layer = shapeLayersById.get(id);
            if (layer) {
                drawnItems.removeLayer(layer);
                shapeLayersById.delete(id);
            }
        }
    });
});
