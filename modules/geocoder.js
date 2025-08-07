// modules/geocoder.js
import { map } from './Map.js';

let searchLayer = null;

L.Control.geocoder({ defaultMarkGeocode: false })
    .on('markgeocode', async (e) => {
        const placeName = e.geocode.name;
        const url = `https://nominatim.openstreetmap.org/search?format=geojson&polygon_geojson=1&q=${encodeURIComponent(placeName)}`;

        try {
            const res = await fetch(url);
            const data = await res.json();
            if (!data.features.length) { alert('No se encontró el territorio.'); return; }

            const [feature] = data.features;
            if (searchLayer) { map.removeLayer(searchLayer); }

            searchLayer = L.geoJSON(feature.geometry, {
                style: { color: 'black', weight: 1, fillOpacity: 0 }
            }).addTo(map);

            map.fitBounds(searchLayer.getBounds());
        } catch (err) {
            console.error('Error al buscar el lugar:', err);
            alert('Ocurrió un error al buscar el territorio.');
        }
    })
    .addTo(map);
