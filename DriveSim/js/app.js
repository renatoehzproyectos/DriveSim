document.addEventListener('DOMContentLoaded', async () => {
    // 1. Create Viewer with NO base imagery first (prevents ion / blue fallback)
    const viewer = new Cesium.Viewer('cesiumContainer', {
        baseLayer: false,
        terrainProvider: new Cesium.EllipsoidTerrainProvider(),
        geocoder: false,
        homeButton: false,
        sceneModePicker: false,
        baseLayerPicker: false,
        navigationHelpButton: false,
        animation: false,
        timeline: false,
        fullscreenButton: false,
        vrButton: false,
        infoBox: false,
        selectionIndicator: false
    });

    // Hide Cesium credit / ion logo
    if (viewer.creditContainer) {
        viewer.creditContainer.style.display = 'none';
    }

    // Performance & look defaults (high quality far detail)
    viewer.scene.fog.enabled = false;
    viewer.scene.highDynamicRange = false;
    viewer.scene.globe.enableLighting = false;
    viewer.scene.skyAtmosphere.show = true;
    viewer.scene.globe.baseColor = Cesium.Color.fromCssColorString('#1a2f1a');
    // Lower SSE = higher quality tiles farther away (default ~2, lower is sharper)
    viewer.scene.globe.maximumScreenSpaceError = 1.5;

    // 2. Load real satellite imagery (Esri World Imagery)
    let imageryLayer = null;
    try {
        const esriProvider = await Cesium.ArcGisMapServerImageryProvider.fromUrl(
            'https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer'
        );
        viewer.imageryLayers.removeAll();
        imageryLayer = viewer.imageryLayers.addImageryProvider(esriProvider);
    } catch (err) {
        console.warn('ArcGIS provider failed, using UrlTemplate fallback', err);
        const fallback = new Cesium.UrlTemplateImageryProvider({
            url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
            maximumLevel: 19,
            credit: '© Esri, Maxar, Earthstar Geographics'
        });
        viewer.imageryLayers.removeAll();
        imageryLayer = viewer.imageryLayers.addImageryProvider(fallback);
    }

    // 3. Instantiate Components
    const vehicle = new Vehicle(viewer);
    const controls = new Controls();
    const navigation = new Navigation(viewer, vehicle);

    // 4. Sliders – CAM / MAP quality / FAR render distance
    const camSlider = document.getElementById('cam-height-slider');
    const camValueLabel = document.getElementById('cam-height-value');
    if (camSlider) {
        camSlider.value = vehicle.cameraHeight;
        camValueLabel.textContent = `${vehicle.cameraHeight} m`;
        camSlider.addEventListener('input', () => {
            const h = parseFloat(camSlider.value);
            vehicle.cameraHeight = h;
            camValueLabel.textContent = `${h} m`;
            vehicle.updateCamera();
        });
    }

    // MAP quality: controls maximum imagery level (higher = sharper close-up satellite)
    const mapSlider = document.getElementById('map-quality-slider');
    const mapValueLabel = document.getElementById('map-quality-value');
    if (mapSlider && imageryLayer) {
        const applyMapQuality = (level) => {
            // Clamp imagery maximumLevel; higher = more detail when zoomed in
            const provider = imageryLayer.imageryProvider;
            if (provider && provider.maximumLevel !== undefined) {
                provider._maximumLevel = level;
            }
            // Force refresh of tiles
            viewer.scene.globe._surface._tilesToRender.length = 0;
            const labels = { 1: 'LO', 10: 'MED', 15: 'HI', 18: 'MAX', 19: 'MAX' };
            mapValueLabel.textContent = labels[level] || (level >= 17 ? 'MAX' : level >= 12 ? 'HI' : level >= 7 ? 'MED' : 'LO');
        };
        mapSlider.addEventListener('input', () => {
            applyMapQuality(parseInt(mapSlider.value, 10));
        });
        applyMapQuality(parseInt(mapSlider.value, 10));
    }

    // FAR quality: lower maximumScreenSpaceError = higher quality at distance
    // Slider 1 (LO) → SSE 8, Slider 16 (HI) → SSE 0.5
    const farSlider = document.getElementById('render-dist-slider');
    const farValueLabel = document.getElementById('render-dist-value');
    if (farSlider) {
        const applyFarQuality = (val) => {
            // Map 1→8 (low far detail) … 16→0.5 (high far detail)
            const sse = 8.5 - (val * 0.5);
            viewer.scene.globe.maximumScreenSpaceError = Math.max(0.5, sse);
            // Also raise tile cache a bit when demanding high far quality
            viewer.scene.globe.tileCacheSize = val >= 10 ? 200 : 100;
            farValueLabel.textContent = val >= 13 ? 'MAX' : val >= 9 ? 'HI' : val >= 5 ? 'MED' : 'LO';
        };
        farSlider.addEventListener('input', () => {
            applyFarQuality(parseInt(farSlider.value, 10));
        });
        applyFarQuality(parseInt(farSlider.value, 10));
    }

    // 5. Main Simulator Loop
    let lastTime = performance.now();

    function simLoop(now) {
        let dt = (now - lastTime) / 1000;
        if (dt > 0.1) dt = 0.1;
        lastTime = now;

        const input = controls.getInput();
        vehicle.update(dt, input);
        navigation.update();

        requestAnimationFrame(simLoop);
    }

    requestAnimationFrame(simLoop);
});
