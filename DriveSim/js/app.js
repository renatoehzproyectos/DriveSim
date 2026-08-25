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
                // Default 3D Tiles optimisations (Skip LOD + SSE)
                tileset.skipLevelOfDetail = true;
                tileset.immediatelyLoadDesiredLevelOfDetail = true;
                tileset.loadSiblings = false;
                tileset.skipScreenSpaceErrorFactor = 16;
                tileset.skipLevels = 1;
                tileset.maximumScreenSpaceError = 16;
                if (tileset.backFaceCulling !== undefined) tileset.backFaceCulling = true;
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
        if (typeof window.__driveSimApplyCulling === 'function') {
            window.__driveSimApplyCulling();
        }
    }
    await applyTerrain(Settings.get().terrain);

    // 3. Instantiate Components
    const vehicle = new Vehicle(viewer);
    const saved = Settings.get();
    vehicle.heightSampleIntervalMs = saved.heightSampleMs;
    vehicle.baseFov = Cesium.Math.toRadians(saved.fovDeg);
    vehicle.currentFov = vehicle.baseFov;
    vehicle.followDelayMs = saved.followDelayMs;
    vehicle.fovBoostEnabled = true; // FOV+ always on

    const controls = new Controls();
    const navigation = new Navigation(viewer, vehicle);

    const applyMapQuality = (level) => {
        // Mobile max scale 1.25, desktop up to 1.75
        const maxScale = isMobile ? 1.25 : 1.75;
        const scale = 0.6 + (level / 19) * (maxScale - 0.6);
        viewer.resolutionScale = scale;
        const mapValueLabel = document.getElementById('map-quality-value');
        if (mapValueLabel) {
            mapValueLabel.textContent =
                level >= 17 ? 'ULTRA' : level >= 14 ? 'MAX' : level >= 10 ? 'HI' : level >= 5 ? 'MED' : 'LO';
        }
    };
    // Apply saved MAP quality at startup
    applyMapQuality(saved.mapQuality || 12);

    Settings.initUI({
        onTerrainChange: applyTerrain,
        onHeightSampleChange: (ms) => { vehicle.heightSampleIntervalMs = ms; },
        onVehicleModeChange: (mode) => {
            vehicle.setMode(mode);
            controls.setMode(mode);
        },
        onFovChange: (deg) => {
            vehicle.baseFov = Cesium.Math.toRadians(deg);
            vehicle.updateCamera();
        },
        onFollowDelayChange: (ms) => {
            vehicle.followDelayMs = ms;
        },
        onSseChange: () => {
            if (typeof window.__driveSimApplyCulling === 'function') {
                window.__driveSimApplyCulling();
            }
        },
        onMapQualityChange: applyMapQuality
    });

    // ZOOM: independent camera distance (CAM / AIM removed; MAP lives in Settings)
    const zoomSlider = document.getElementById('cam-zoom-slider');
    const zoomValueLabel = document.getElementById('cam-zoom-value');
    if (zoomSlider) {
        zoomSlider.value = vehicle.cameraDistance;
        zoomValueLabel.textContent = `${vehicle.cameraDistance} m`;
        zoomSlider.addEventListener('input', () => {
            const d = parseFloat(zoomSlider.value);
            vehicle.cameraDistance = d;
            zoomValueLabel.textContent = `${d} m`;
            vehicle.updateCamera();
        });
    }

    // ORBIT always enabled: drag on the Cesium canvas to orbit around the vehicle
    (function initOrbitControls() {
        const canvas = viewer.scene.canvas;
        let dragging = false;
        let lastX = 0;
        let lastY = 0;
        let pointerId = null;

        const isUiTarget = (el) => {
            if (!el || !el.closest) return false;
            return !!(el.closest('#ui-layer') || el.closest('#controls-layer') ||
                el.closest('#airplane-controls-layer') || el.closest('#settings-panel') ||
                el.closest('#settings-btn') || el.closest('#minimap-container') ||
                el.closest('#left-controls'));
        };

        const onDown = (e) => {
            if (isUiTarget(e.target)) return;
            if (e.pointerType === 'mouse' && e.button !== 0) return;
            dragging = true;
            pointerId = e.pointerId;
            lastX = e.clientX;
            lastY = e.clientY;
            try { canvas.setPointerCapture(e.pointerId); } catch (_) {}
            e.preventDefault();
        };
        const onMove = (e) => {
            if (!dragging || (pointerId !== null && e.pointerId !== pointerId)) return;
            const dx = e.clientX - lastX;
            const dy = e.clientY - lastY;
            lastX = e.clientX;
            lastY = e.clientY;
            const sens = 0.006;
            vehicle.applyOrbitDelta(-dx * sens, -dy * sens);
            e.preventDefault();
        };
        const onUp = (e) => {
            if (!dragging) return;
            if (pointerId !== null && e.pointerId !== pointerId) return;
            dragging = false;
            pointerId = null;
            try { canvas.releasePointerCapture(e.pointerId); } catch (_) {}
        };

        canvas.addEventListener('pointerdown', onDown, { passive: false });
        window.addEventListener('pointermove', onMove, { passive: false });
        window.addEventListener('pointerup', onUp, { passive: false });
        window.addEventListener('pointercancel', onUp, { passive: false });

        // Mouse wheel zoom on canvas
        canvas.addEventListener('wheel', (e) => {
            if (isUiTarget(e.target)) return;
            e.preventDefault();
            const factor = e.deltaY > 0 ? 1.08 : 0.92;
            vehicle.cameraDistance = Cesium.Math.clamp(
                vehicle.cameraDistance * factor, 8, 200
            );
            if (zoomSlider) {
                zoomSlider.value = Math.round(vehicle.cameraDistance);
                zoomValueLabel.textContent = `${Math.round(vehicle.cameraDistance)} m`;
            }
            vehicle.updateCamera();
        }, { passive: false });

        // Double-click / double-tap to reset orbit
        let lastTap = 0;
        canvas.addEventListener('pointerup', (e) => {
            if (isUiTarget(e.target)) return;
            const t = performance.now();
            if (t - lastTap < 320) {
                vehicle.resetOrbit();
                lastTap = 0;
            } else {
                lastTap = t;
            }
        });

        // Disable Cesium's default camera controller so our lookAt + orbit owns the view
        const ctrl = viewer.scene.screenSpaceCameraController;
        ctrl.enableRotate = false;
        ctrl.enableTranslate = false;
        ctrl.enableZoom = false;
        ctrl.enableTilt = false;
        ctrl.enableLook = false;
    })();

    // ---- Culling configuration (Cesium) ----
    // Terrain occlusion option removed; depthTestAgainstTerrain stays on for ground clamping.
    function applyCullingOptions() {
        const scene = viewer.scene;
        const globe = scene.globe;
        const horizon = document.getElementById('cull-horizon')?.checked !== false;
        const frustum = document.getElementById('cull-frustum')?.checked !== false;
        const sse = document.getElementById('cull-sse')?.checked !== false;
        const skipLod = document.getElementById('cull-skip-lod')?.checked !== false;
        const backface = document.getElementById('cull-backface')?.checked !== false;
        const dynamicSse = document.getElementById('cull-dynamic-sse')?.checked === true;
        const sseSlider = document.getElementById('sse-slider');
        const baseSse = sseSlider ? parseFloat(sseSlider.value) : (Settings.get().sseValue || 2);

        // Keep depth test for accurate sampleHeight ground-clamping
        if (typeof globe.depthTestAgainstTerrain !== 'undefined') {
            globe.depthTestAgainstTerrain = true;
        }
        scene.skyAtmosphere.show = horizon;
        if (scene.fog) {
            scene.fog.enabled = false;
        }

        const frustumObj = scene.camera.frustum;
        if (frustumObj && frustumObj.near !== undefined) {
            if (frustum) {
                frustumObj.near = 0.5;
                frustumObj.far = 50000000;
            } else {
                frustumObj.near = 0.1;
                frustumObj.far = 1e10;
            }
        }

        // Effective SSE: base from slider, optionally inflated by speed when Dynamic SSE is on
        let effectiveSse = baseSse;
        if (dynamicSse && vehicle) {
            const speed01 = Math.min(1, Math.abs(vehicle.velocity) / Math.max(1, vehicle.maxSpeed));
            effectiveSse = baseSse + speed01 * baseSse * 1.5; // up to 2.5× at top speed
        }

        if (sse) {
            globe.maximumScreenSpaceError = effectiveSse;
        } else {
            globe.maximumScreenSpaceError = 0.01;
        }

        const applyToTileset = (tileset) => {
            if (!tileset) return;
            tileset.skipLevelOfDetail = skipLod;
            tileset.immediatelyLoadDesiredLevelOfDetail = skipLod;
            tileset.loadSiblings = !skipLod;
            tileset.skipScreenSpaceErrorFactor = skipLod ? 16 : 0;
            tileset.skipLevels = skipLod ? 1 : 0;
            if (!sse) {
                tileset.maximumScreenSpaceError = 0.01;
            } else {
                // Tilesets typically want a higher numeric SSE than the globe
                tileset.maximumScreenSpaceError = Math.max(4, effectiveSse * 8);
            }
            if (tileset.backFaceCulling !== undefined) {
                tileset.backFaceCulling = backface;
            }
        };
        if (viewer._googleTileset) applyToTileset(viewer._googleTileset);
        const prims = scene.primitives;
        for (let i = 0; i < prims.length; i++) {
            const p = prims.get(i);
            if (p && p.maximumScreenSpaceError !== undefined) applyToTileset(p);
        }

        if (vehicle.carEntity && vehicle.carEntity.model) {
            vehicle.carEntity.model.backFaceCulling = backface;
        }
    }

    // Wire culling checkboxes + SSE slider
    ['cull-horizon', 'cull-frustum', 'cull-sse', 'cull-skip-lod', 'cull-backface', 'cull-dynamic-sse']
        .forEach(id => {
            const el = document.getElementById(id);
            if (el) el.addEventListener('change', applyCullingOptions);
        });
    const sseSliderEl = document.getElementById('sse-slider');
    if (sseSliderEl) {
        sseSliderEl.addEventListener('input', applyCullingOptions);
    }
    applyCullingOptions();

    window.__driveSimApplyCulling = applyCullingOptions;
    if (vehicle.carEntity && vehicle.carEntity.model) {
        vehicle.carEntity.model.backFaceCulling = true;
    }

    // Re-apply dynamic SSE periodically while moving
    setInterval(() => {
        if (document.getElementById('cull-dynamic-sse')?.checked) {
            applyCullingOptions();
        }
    }, 500);

    // 5. Main Simulator Loop
    let lastTime = performance.now();

    function simLoop(now) {
        let dt = (now - lastTime) / 1000;
        if (dt > 0.1) dt = 0.1;
        lastTime = now;

        const input = vehicle.mode === 'airplane' ? controls.getAirplaneInput() : controls.getInput();
        vehicle.update(dt, input);
        navigation.update();

        requestAnimationFrame(simLoop);
    }

    requestAnimationFrame(simLoop);
});
