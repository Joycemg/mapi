// modules/Map.js
// Leaflet + capas raster.
// Base por defecto: Wikimedia en español. Alternativa: CARTO Positron.
// Extras: hot-reload limpio, límites de mundo, vista mundial, escala, prefetch raster, captura coordenadas.

let map = window.__APP_MAP__;

if (!map) {
    /* ==========
     * Constantes
     * ========== */
    const MAP_ELEMENT_ID = 'map';
    const WORLD_BOUNDS = L.latLngBounds(L.latLng(-85, -180), L.latLng(85, 180));
    const DEFAULT_CENTER = [20, 0];
    const DEFAULT_ZOOM = 3;
    const MAX_ZOOM = 19;
    const PREFETCH_PAD_PX = 256;
    const IS_MOBILE = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

    /* =================
     * Hot reload limpio
     * ================= */
    const el = L.DomUtil.get(MAP_ELEMENT_ID);
    if (el && el._leaflet_id) el._leaflet_id = undefined;

    /* ======================
     * Inicialización del mapa
     * ====================== */
    map = L.map(MAP_ELEMENT_ID, {
        center: DEFAULT_CENTER,
        zoom: DEFAULT_ZOOM,
        minZoom: 1,
        maxZoom: MAX_ZOOM,
        zoomControl: true,
        attributionControl: true,
        preferCanvas: true,
        inertia: false,
        wheelDebounceTime: 40,
        wheelPxPerZoomLevel: 120,
        zoomAnimation: !IS_MOBILE,
        fadeAnimation: !IS_MOBILE,
        maxBounds: WORLD_BOUNDS,
        maxBoundsViscosity: 1,
        tap: true,
        tapTolerance: 22,
        touchZoom: 'center',
        doubleClickZoom: false
    });

    map.attributionControl.addAttribution('© OpenStreetMap contributors');

    /* ======================
     * Opciones comunes raster
     * ====================== */
    const rasterOptions = {
        noWrap: true,
        detectRetina: !IS_MOBILE,
        crossOrigin: 'anonymous',
        updateWhenIdle: true,
        updateWhenZooming: true,
        keepBuffer: IS_MOBILE ? 1 : 2,
        className: 'filtered-tile',
        maxZoom: MAX_ZOOM,
        errorTileUrl:
            'data:image/gif;base64,R0lGODlhAQABAIABAP///wAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw=='
    };

    /* ==========
     * Capas base
     * ========== */
    const wikimediaEs = L.tileLayer(
        'https://maps.wikimedia.org/osm-intl/{z}/{x}/{y}.png?lang=es',
        { ...rasterOptions, attribution: '© OpenStreetMap contributors · © Wikimedia' }
    );

    const cartoPositron = L.tileLayer(
        'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
        { ...rasterOptions, subdomains: 'abcd', attribution: '© OpenStreetMap contributors · © CARTO' }
    );

    let currentBaseLayer = null;
    const setBaseLayer = (layer) => {
        if (layer && currentBaseLayer !== layer) {
            if (currentBaseLayer) map.removeLayer(currentBaseLayer);
            layer.addTo(map);
            currentBaseLayer = layer;
        }
    };

    // Base por defecto
    setBaseLayer(wikimediaEs);

    /* ==========
     * Controles
     * ========== */
    L.control.scale({ imperial: false }).addTo(map);

    L.control.layers(
        { 'Wikimedia (Español)': wikimediaEs, 'CARTO Positron': cartoPositron },
        {},
        { position: 'topleft', collapsed: true }
    ).addTo(map);

    const ResetViewControl = L.Control.extend({
        options: { position: 'topleft' },
        onAdd() {
            const box = L.DomUtil.create('div', 'leaflet-bar');
            const a = L.DomUtil.create('a', '', box);
            a.href = '#';
            a.title = 'Vista mundial';
            a.setAttribute('aria-label', 'Vista mundial');
            a.textContent = '🌐';
            a.onclick = (e) => {
                e.preventDefault();
                map.setView(DEFAULT_CENTER, DEFAULT_ZOOM);
            };
            L.DomEvent.disableClickPropagation(box);
            L.DomEvent.disableScrollPropagation(box);
            return box;
        }
    });
    map.addControl(new ResetViewControl());

    /* ===================
     * Prefetch de mosaicos
     * =================== */
    const prefetchTiles = (padPx = PREFETCH_PAD_PX) => {
        try {
            const bounds = map.getPixelBounds();
            const paddedBounds = L.bounds(bounds.min.subtract([padPx, padPx]), bounds.max.add([padPx, padPx]));

            map.eachLayer((layer) => {
                if (!(layer instanceof L.TileLayer) || !map.hasLayer(layer)) return;
                if (typeof layer._update !== 'function' || typeof layer._getTiledPixelBounds !== 'function') return;

                const originalFn = layer._getTiledPixelBounds;
                layer._getTiledPixelBounds = () => paddedBounds;
                try {
                    layer._update();
                } finally {
                    layer._getTiledPixelBounds = originalFn;
                }
            });
        } catch { /* silencio intencional */ }
    };
    map.on('moveend zoomend', () => prefetchTiles());

    /* ====================
     * Captura de coordenadas
     * ==================== */
    const fireCoords = (e, source) => map.fire('app:coords', { latlng: e.latlng, source });
    map.on('contextmenu', (e) => fireCoords(e, 'contextmenu'));
    map.on('dblclick', (e) => fireCoords(e, 'doubletap'));

    // Evitar menú contextual del navegador
    map.getContainer().addEventListener('contextmenu', (e) => e.preventDefault());

    // Guardar referencia global para hot-reload
    window.__APP_MAP__ = map;
}

export { map };
