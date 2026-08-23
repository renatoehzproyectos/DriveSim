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

    // Max graphics defaults
    viewer.scene.fog.enabled = false;
    viewer.scene.highDynamicRange = false;
    viewer.scene.globe.enableLighting = false;
    viewer.scene.skyAtmosphere.show = true;
    viewer.scene.globe.baseColor = Cesium.Color.fromCssColorString('#1a2f1a');
    // Ultra-low SSE = sharp tiles even far away (default ~2)
    viewer.scene.globe.maximumScreenSpaceError = 0.5;
    viewer.scene.globe.tileCacheSize = 500;
    viewer.resolutionScale = Math.min(window.devicePixelRatio || 1.5, 2.0);
    viewer.scene.globe.preloadSiblings = true;
    viewer.scene.globe.preloadAncestors = true;
    // Request as many concurrent tiles as the browser allows
    if (Cesium.RequestScheduler) {
        Cesium.RequestScheduler.maximumRequestsPerServer = 18;
    }

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

    // MAP quality: resolution scale + anisotropy (sharper satellite close-up)
    const mapSlider = document.getElementById('map-quality-slider');
    const mapValueLabel = document.getElementById('map-quality-value');
    if (mapSlider) {
        const applyMapQuality = (level) => {
            // level 1..19 → resolutionScale 0.5 .. 2.0
            const scale = 0.4 + (level / 19) * 1.6;
            viewer.resolutionScale = Math.min(scale, window.devicePixelRatio > 1 ? 2.5 : 2.0);
            if (imageryLayer) {
                imageryLayer.minificationFilter = Cesium.TextureMinificationFilter.LINEAR_MIPMAP_LINEAR;
                imageryLayer.magnificationFilter = Cesium.TextureMagnificationFilter.LINEAR;
            }
            mapValueLabel.textContent = level >= 17 ? 'ULTRA' : level >= 14 ? 'MAX' : level >= 10 ? 'HI' : level >= 5 ? 'MED' : 'LO';
        };
        mapSlider.addEventListener('input', () => {
            applyMapQuality(parseInt(mapSlider.value, 10));
        });
        // Default to max
        mapSlider.value = 19;
        applyMapQuality(19);
    }

    // FAR quality: lower maximumScreenSpaceError = higher quality at distance
    // Slider 1 (LO) → SSE 6, Slider 16 (ULTRA) → SSE 0.25
    const farSlider = document.getElementById('render-dist-slider');
    const farValueLabel = document.getElementById('render-dist-value');
    if (farSlider) {
        const applyFarQuality = (val) => {
            // Map 1→6 … 16→0.25
            const t = (val - 1) / 15;
            const sse = 6 - t * 5.75;
            viewer.scene.globe.maximumScreenSpaceError = Math.max(0.25, sse);
            viewer.scene.globe.tileCacheSize = 100 + Math.round(t * 500);
            if (Cesium.RequestScheduler) {
                Cesium.RequestScheduler.maximumRequestsPerServer = 6 + Math.round(t * 18);
            }
            farValueLabel.textContent = val >= 14 ? 'ULTRA' : val >= 11 ? 'MAX' : val >= 7 ? 'HI' : val >= 4 ? 'MED' : 'LO';
        };
        farSlider.addEventListener('input', () => {
            applyFarQuality(parseInt(farSlider.value, 10));
        });
        // Default to max quality
        farSlider.value = 16;
        applyFarQuality(16);
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
