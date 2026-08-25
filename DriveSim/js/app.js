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
    vehicle.heightSampleIntervalMs = Settings.get().heightSampleMs;
    Settings.initUI({
        onTerrainChange: applyTerrain,
        onHeightSampleChange: (ms) => { vehicle.heightSampleIntervalMs = ms; },
        onVehicleModeChange: (mode) => {
            vehicle.setMode(mode);
            controls.setMode(mode);
        }
    });
    const controls = new Controls();
    const navigation = new Navigation(viewer, vehicle);

    // 4. Sliders – CAM / ZOOM / AIM / MAP + FOV boost toggle
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


    // ZOOM: independent camera distance
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

    // ORBIT: drag on the Cesium canvas to orbit around the vehicle
    (function initOrbitControls() {
        const canvas = viewer.scene.canvas;
        const resetBtn = document.getElementById('orbit-reset-btn');
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
            // Only primary button / single touch
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
            // Sensitivity: ~0.35° per pixel
            const sens = 0.006;
            vehicle.applyOrbitDelta(-dx * sens, -dy * sens);
            if (resetBtn) {
                resetBtn.classList.add('active');
                resetBtn.textContent = 'ORBIT ON';
            }
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

        // Mouse wheel / pinch-like zoom on canvas
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

        if (resetBtn) {
            resetBtn.addEventListener('click', () => {
                vehicle.resetOrbit();
                resetBtn.classList.remove('active');
                resetBtn.textContent = 'ORBIT';
            });
        }

        // Disable Cesium's default camera controller so our lookAt + orbit owns the view
        const ctrl = viewer.scene.screenSpaceCameraController;
        ctrl.enableRotate = false;
        ctrl.enableTranslate = false;
        ctrl.enableZoom = false;
        ctrl.enableTilt = false;
        ctrl.enableLook = false;
    })();

    // ---- Culling configuration (Cesium) ----
    function applyCullingOptions() {
        const scene = viewer.scene;
        const globe = scene.globe;
        const horizon = document.getElementById('cull-horizon')?.checked !== false;
        const frustum = document.getElementById('cull-frustum')?.checked !== false;
        const sse = document.getElementById('cull-sse')?.checked !== false;
        const skipLod = document.getElementById('cull-skip-lod')?.checked !== false;
        const terrainOcc = document.getElementById('cull-terrain-occ')?.checked !== false;
        const backface = document.getElementById('cull-backface')?.checked !== false;

        // Horizon Culling: discard geometry behind Earth curvature
        // Cesium enables this by default on the globe; we also gate via show/atmosphere
        if (typeof globe.depthTestAgainstTerrain !== 'undefined') {
            // Terrain Occlusion uses the same depth test path
            globe.depthTestAgainstTerrain = terrainOcc;
        }
        // Horizon: when disabled, raise far plane / disable atmosphere fade tricks
        // Cesium's globe always does horizon culling of tiles; we approximate by
        // toggling fog/atmosphere which are horizon-aware.
        scene.skyAtmosphere.show = horizon;
        if (scene.fog) {
            // Keep fog off by default for neon look; horizon still culls tiles
            scene.fog.enabled = false;
        }

        // Frustum Culling: automatic in Cesium; when "off" we widen near/far
        // so almost everything is inside the frustum (debug-ish).
        const frustumObj = scene.camera.frustum;
        if (frustumObj && frustumObj.near !== undefined) {
            if (frustum) {
                frustumObj.near = 0.5;
                frustumObj.far = 50000000;
            } else {
                frustumObj.near = 0.1;
                frustumObj.far = 1e10; // essentially disable by making frustum huge
            }
        }

        // Screen Space Error / LOD
        if (sse) {
            // Balanced default (was previously driven by the FAR slider)
            if (globe.maximumScreenSpaceError < 0.1 || globe.maximumScreenSpaceError === 0.01) {
                globe.maximumScreenSpaceError = isMobile ? 1.2 : 1.5;
            }
        } else {
            // Force ultra-high detail (no SSE culling) — heavy
            globe.maximumScreenSpaceError = 0.01;
        }

        // Skip LOD + SSE + backface on Google 3D Tiles (and any future tilesets)
        const applyToTileset = (tileset) => {
            if (!tileset) return;
            tileset.skipLevelOfDetail = skipLod;
            tileset.immediatelyLoadDesiredLevelOfDetail = skipLod;
            tileset.loadSiblings = !skipLod;
            tileset.skipScreenSpaceErrorFactor = skipLod ? 16 : 0;
            tileset.skipLevels = skipLod ? 1 : 0;
            // SSE for tiles
            if (!sse) {
                tileset.maximumScreenSpaceError = 0.01;
            } else if (tileset.maximumScreenSpaceError < 0.5) {
                tileset.maximumScreenSpaceError = 16;
            }
            // Back-face culling on tileset
            if (tileset.backFaceCulling !== undefined) {
                tileset.backFaceCulling = backface;
            }
        };
        if (viewer._googleTileset) applyToTileset(viewer._googleTileset);
        // Also walk primitives for any 3D Tilesets
        const prims = scene.primitives;
        for (let i = 0; i < prims.length; i++) {
            const p = prims.get(i);
            if (p && p.maximumScreenSpaceError !== undefined) applyToTileset(p);
        }

        // Back-face culling on vehicle models (glTF)
        const setModelBackface = (entity) => {
            if (entity && entity.model) {
                entity.model.backFaceCulling = backface;
            }
        };
        setModelBackface(vehicle.carEntity);
        // Airplane uses boxes (no glTF backface), but keep API consistent
    }

    // Wire culling checkboxes
    ['cull-horizon', 'cull-frustum', 'cull-sse', 'cull-skip-lod', 'cull-terrain-occ', 'cull-backface']
        .forEach(id => {
            const el = document.getElementById(id);
            if (el) el.addEventListener('change', applyCullingOptions);
        });
    // Apply once at startup with defaults (all on)
    applyCullingOptions();

    // Expose so applyTerrain can refresh tileset culling after load
    window.__driveSimApplyCulling = applyCullingOptions;
    if (vehicle.carEntity && vehicle.carEntity.model) {
        vehicle.carEntity.model.backFaceCulling = true;
    }

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
