// modules/Map.js
let map = window.__APP_MAP__;

if (!map) {
    const el = L.DomUtil.get('map');
    if (el && el._leaflet_id) el._leaflet_id = undefined; // hot reload

    map = L.map('map', {
        center: [-34.6037, -58.3816], // BA
        zoom: 12,
        minZoom: 2,
        zoomControl: true,
        attributionControl: false
    });

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; OpenStreetMap contributors',
        className: 'filtered-tile'
    }).addTo(map);

    window.__APP_MAP__ = map;
}

export { map };
