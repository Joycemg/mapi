// modules/Map.js
// Leaflet + capas raster.
// Base por defecto: Wikimedia en español (rótulos ES).
// También incluye CARTO Positron para que puedas alternar (rótulos en inglés/local).
// Extras:
// - hot-reload limpio
// - límites de mundo y UX/perf
// - control "Vista mundial", escala, prefetch raster
// - captura de coordenadas (clic derecho / doble-tap)

let map = window.__APP_MAP__;

if (!map) {
    // ===== Hot reload limpio =====
    const el = L.DomUtil.get('map');
    if (el && el._leaflet_id) el._leaflet_id = undefined;

    // ===== Config base =====
    const WORLD_BOUNDS = L.latLngBounds(L.latLng(-85, -180), L.latLng(85, 180));
    const DEFAULT_CENTER = [20, 0];
    const DEFAULT_ZOOM = 3;
    const MAX_ZOOM = 19;
    const IS_MOBILE = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

    map = L.map('map', {
        center: DEFAULT_CENTER,
        zoom: DEFAULT_ZOOM,
        minZoom: 1,
        maxZoom: MAX_ZOOM,
        zoomControl: true,
        attributionControl: true,

        // UX / perf
        preferCanvas: true,
        inertia: false,
        wheelDebounceTime: 40,
        wheelPxPerZoomLevel: 120,
        zoomAnimation: !IS_MOBILE,
        fadeAnimation: !IS_MOBILE,

        // Límites
        maxBounds: WORLD_BOUNDS,
        maxBoundsViscosity: 1,

        // Móvil
        tap: true,
        tapTolerance: 22,
        touchZoom: 'center',

        // Para usar doble-tap como gesto de selección (sin zoom)
        doubleClickZoom: false
    });

    // ===== Atribuciones mínimas =====
    map.attributionControl.addAttribution('© OpenStreetMap contributors');

    // ===== Opciones comunes raster =====
    const baseOptions = {
        noWrap: true,
        continuousWorld: false,
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

    // ===== Base en ESPAÑOL (por defecto) =====
    // Wikimedia admite ?lang=es para rótulos en español.
    const wikimediaEs = L.tileLayer(
        'https://maps.wikimedia.org/osm-intl/{z}/{x}/{y}.png?lang=es',
        {
            ...baseOptions,
            attribution: '© OpenStreetMap contributors · © Wikimedia'
        }
    );

    // ===== CARTO Positron (estilo CARTO) =====
    // Nota: no permite forzar idioma por URL; rotula en inglés/local.
    const cartoPositron = L.tileLayer(
        'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
        {
            ...baseOptions,
            subdomains: 'abcd',
            attribution: '© OpenStreetMap contributors · © CARTO'
        }
    );

    // ===== Gestión de base activa =====
    let currentBase = null;
    function useBase(layer) {
        if (!layer || currentBase === layer) return;
        if (currentBase) map.removeLayer(currentBase);
        layer.addTo(map);
        currentBase = layer;
    }

    // Base por defecto: español
    useBase(wikimediaEs);

    // ===== Controles =====
    L.control.scale({ imperial: false }).addTo(map);

    // Control de capas para alternar ES <-> CARTO
    L.control
        .layers(
            {
                'Wikimedia (Español)': wikimediaEs,
                'CARTO Positron': cartoPositron
            },
            {},
            { position: 'topleft', collapsed: true }
        )
        .addTo(map);

    const ResetView = L.Control.extend({
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
    map.addControl(new ResetView());

    // ===== Prefetch suave (solo raster) =====
    const PREFETCH_PAD_PX = 256;
    function prefetchTiles(padPx = PREFETCH_PAD_PX) {
        try {
            const b = map.getPixelBounds();
            const padded = L.bounds(
                b.min.subtract([padPx, padPx]),
                b.max.add([padPx, padPx])
            );
            map.eachLayer((layer) => {
                if (!(layer instanceof L.TileLayer)) return;
                if (!map.hasLayer(layer)) return;
                if (
                    typeof layer._update !== 'function' ||
                    typeof layer._getTiledPixelBounds !== 'function'
                )
                    return;
                const orig = layer._getTiledPixelBounds;
                layer._getTiledPixelBounds = () => padded;
                try {
                    layer._update();
                } finally {
                    layer._getTiledPixelBounds = orig;
                }
            });
        } catch { }
    }
    map.on('moveend zoomend', () => prefetchTiles());

    // ===== Captura de coordenadas =====
    // Clic derecho (desktop)
    map.on('contextmenu', (e) => {
        map.fire('app:coords', { latlng: e.latlng, source: 'contextmenu' });
    });
    // Doble-tap / doble-clic
    map.on('dblclick', (e) => {
        map.fire('app:coords', { latlng: e.latlng, source: 'doubletap' });
    });

    // Evitar menú del navegador sobre el mapa en clic derecho (opcional)
    map.getContainer().addEventListener('contextmenu', (e) => e.preventDefault());

    window.__APP_MAP__ = map;
}

export { map };
