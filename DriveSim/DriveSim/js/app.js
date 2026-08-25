document.addEventListener('DOMContentLoaded', async () => {
    // 0. Apply saved Cesium ion token before anything touches ion-backed assets
    Settings.applyIonToken();

    // Decide renderer: explicit user choice, or auto device-capability detection
    const renderer = Settings.resolveRenderer();

    if (renderer === 'leaflet') {
        const controls = new Controls();
        initLeafletFallback(controls);
        Settings.initUI({});
        return;
    }

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
    viewer.scene.globe.depthTestAgainstTerrain = true; // needed for accurate sampleHeight() ground-clamping
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

    // 2b. Terrain mode: flat | worldterrain | google3d (switchable live from Settings)
    async function applyTerrain(mode) {
        if (viewer._googleTileset) {
            viewer.scene.primitives.remove(viewer._googleTileset);
            viewer._googleTileset = null;
        }
        viewer.scene.globe.show = true;
        if (imageryLayer) imageryLayer.show = true;

        try {
            if (mode === 'worldterrain') {
                viewer.terrainProvider = await Cesium.createWorldTerrainAsync({
                    requestWaterMask: true,
                    requestVertexNormals: true
                });
            } else if (mode === 'google3d') {
                const tileset = await Cesium.createGooglePhotorealistic3DTileset();
                viewer.scene.primitives.add(tileset);
                viewer._googleTileset = tileset;
                viewer.scene.globe.show = false;
                if (imageryLayer) imageryLayer.show = false;
                viewer.terrainProvider = new Cesium.EllipsoidTerrainProvider();
            } else {
                viewer.terrainProvider = new Cesium.EllipsoidTerrainProvider();
            }
        } catch (err) {
            console.warn(`Terrain mode "${mode}" failed (check your Cesium ion token in Settings)`, err);
            viewer.terrainProvider = new Cesium.EllipsoidTerrainProvider();
            viewer.scene.globe.show = true;
            if (imageryLayer) imageryLayer.show = true;
            alert('Could not load this terrain. Check your Cesium ion access token in Settings (⚙).');
        }
    }
    await applyTerrain(Settings.get().terrain);

    // 3. Instantiate Components
    const vehicle = new Vehicle(viewer);
    vehicle.heightSampleIntervalMs = Settings.get().heightSampleMs;
    Settings.initUI({
        onTerrainChange: applyTerrain,
        onHeightSampleChange: (ms) => { vehicle.heightSampleIntervalMs = ms; }
    });
    const controls = new Controls();
    const navigation = new Navigation(viewer, vehicle);

    // 4. Sliders – CAM / AIM / MAP / FAR + FOV boost toggle
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

    // AIM: 0 = center on car, 100 = center toward horizon
    const aimSlider = document.getElementById('cam-aim-slider');
    const aimValueLabel = document.getElementById('cam-aim-value');
    if (aimSlider) {
        aimSlider.value = Math.round(vehicle.cameraAimBias * 100);
        aimValueLabel.textContent = vehicle.cameraAimBias < 0.15 ? 'CAR'
            : vehicle.cameraAimBias > 0.85 ? 'HORIZON' : `${Math.round(vehicle.cameraAimBias * 100)}%`;
        aimSlider.addEventListener('input', () => {
            const v = parseInt(aimSlider.value, 10) / 100;
            vehicle.cameraAimBias = v;
            aimValueLabel.textContent = v < 0.15 ? 'CAR' : v > 0.85 ? 'HORIZON' : `${Math.round(v * 100)}%`;
            vehicle.updateCamera();
        });
    }

    // FOV+ toggle: widen FOV while accelerating
    const fovBtn = document.getElementById('fov-boost-btn');
    if (fovBtn) {
        const syncFovBtn = () => {
            fovBtn.classList.toggle('active', vehicle.fovBoostEnabled);
            fovBtn.textContent = vehicle.fovBoostEnabled ? 'FOV+ ON' : 'FOV+';
        };
        syncFovBtn();
        fovBtn.addEventListener('click', () => {
            vehicle.fovBoostEnabled = !vehicle.fovBoostEnabled;
            syncFovBtn();
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
