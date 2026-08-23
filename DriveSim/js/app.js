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
        selectionIndicator: false,
        // Keep render loop stable on mobile
        requestRenderMode: false,
        useBrowserRecommendedResolution: true
    });

    // Hide Cesium credit / ion logo
    if (viewer.creditContainer) {
        viewer.creditContainer.style.display = 'none';
    }

    // Stable high-quality defaults (safe for phones)
    viewer.scene.fog.enabled = false;
    viewer.scene.highDynamicRange = false;
    viewer.scene.globe.enableLighting = false;
    viewer.scene.skyAtmosphere.show = true;
    viewer.scene.globe.baseColor = Cesium.Color.fromCssColorString('#2d4a3e');
    viewer.scene.globe.maximumScreenSpaceError = 1.5;
    viewer.scene.globe.tileCacheSize = 120;
    // Never exceed device pixel ratio on mobile – higher values cause black screens
    const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
    viewer.resolutionScale = isMobile ? 1.0 : Math.min(window.devicePixelRatio || 1, 1.5);
    viewer.scene.globe.preloadSiblings = true;
    if (Cesium.RequestScheduler) {
        Cesium.RequestScheduler.maximumRequestsPerServer = isMobile ? 8 : 12;
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

    // 4. Sliders – CAM / MAP / FAR
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

    // MAP: resolution scale (capped so phones don't go black)
    const mapSlider = document.getElementById('map-quality-slider');
    const mapValueLabel = document.getElementById('map-quality-value');
    if (mapSlider) {
        const applyMapQuality = (level) => {
            // Mobile max scale 1.25, desktop up to 1.75
            const maxScale = isMobile ? 1.25 : 1.75;
            const scale = 0.6 + (level / 19) * (maxScale - 0.6);
            viewer.resolutionScale = scale;
            mapValueLabel.textContent =
                level >= 17 ? 'ULTRA' : level >= 14 ? 'MAX' : level >= 10 ? 'HI' : level >= 5 ? 'MED' : 'LO';
        };
        mapSlider.addEventListener('input', () => {
            applyMapQuality(parseInt(mapSlider.value, 10));
        });
        // Start at HI (not ULTRA) so first load is stable
        mapSlider.value = 12;
        applyMapQuality(12);
    }

    // FAR: screen-space error – lower = sharper far tiles, but floor at 0.8 on mobile
    const farSlider = document.getElementById('render-dist-slider');
    const farValueLabel = document.getElementById('render-dist-value');
    if (farSlider) {
        const applyFarQuality = (val) => {
            const t = (val - 1) / 15;
            const minSSE = isMobile ? 0.8 : 0.5;
            const sse = 5 - t * (5 - minSSE);
            viewer.scene.globe.maximumScreenSpaceError = Math.max(minSSE, sse);
            viewer.scene.globe.tileCacheSize = isMobile
                ? 80 + Math.round(t * 80)
                : 100 + Math.round(t * 200);
            if (Cesium.RequestScheduler) {
                Cesium.RequestScheduler.maximumRequestsPerServer = isMobile
                    ? 6 + Math.round(t * 4)
                    : 8 + Math.round(t * 8);
            }
            farValueLabel.textContent =
                val >= 14 ? 'ULTRA' : val >= 11 ? 'MAX' : val >= 7 ? 'HI' : val >= 4 ? 'MED' : 'LO';
        };
        farSlider.addEventListener('input', () => {
            applyFarQuality(parseInt(farSlider.value, 10));
        });
        // Start at HI for stable first paint
        farSlider.value = 10;
        applyFarQuality(10);
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
