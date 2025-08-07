// modules/map.js

const map = L.map('map', {
    center: [36.85293, -75.97799],
    zoom: 4,
    minZoom: 4,
    zoomSnap: 4,
    zoomControl: false,
    preferCanvas: false,
    attributionControl: false
});

L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; Stadia Maps, OpenMapTiles & OpenStreetMap contributors',
    className: 'filtered-tile'
}).addTo(map);
