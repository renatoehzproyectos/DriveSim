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

    // 2a. Centralized Google 3D Tiles performance configuration.
    // Applies the new opt-in streaming/LOD features from Settings, guarded so an
    // unavailable property on a given Cesium build never throws (see Settings.get()).
    function configurePhotorealisticTileset(tileset) {
        if (!tileset) return;
        const s = Settings.get();

        if ('dynamicScreenSpaceError' in tileset) {
            tileset.dynamicScreenSpaceError = !!s.nativeDynamicSse;
            if (s.nativeDynamicSse) {
                tileset.dynamicScreenSpaceErrorDensity = 2.0e-4;
                tileset.dynamicScreenSpaceErrorFactor = s.nativeDynamicSseFactor;
                tileset.dynamicScreenSpaceErrorHeightFalloff = 0.25;
            }
        }

        if ('foveatedScreenSpaceError' in tileset) {
            tileset.foveatedScreenSpaceError = !!s.foveated;
            if (s.foveated) {
                tileset.foveatedTimeDelay = s.foveatedDelay;
            }
        }

        if ('cullRequestsWhileMoving' in tileset) {
            tileset.cullRequestsWhileMoving = !!s.requestCulling;
            if (s.requestCulling && 'cullRequestsWhileMovingMultiplier' in tileset) {
                tileset.cullRequestsWhileMovingMultiplier = s.requestCullingMultiplier;
            }
        }

        if ('progressiveResolutionHeightFraction' in tileset) {
            tileset.progressiveResolutionHeightFraction = s.progressiveResolution
                ? s.progressiveResolutionFraction
                : 0;
        }

        if ('preloadFlightDestinations' in tileset) {
            tileset.preloadFlightDestinations = !!s.preloadFlightDest;
        }
    }
    window.__driveSimConfigurePhotorealisticTileset = configurePhotorealisticTileset;

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
                configurePhotorealisticTileset(tileset);
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
        onMapQualityChange: applyMapQuality,
        onStreamingChange: () => {
            if (viewer._googleTileset) configurePhotorealisticTileset(viewer._googleTileset);
        },
        onAdaptivePerformanceChange: (enabled) => {
            adaptivePerfEnabled = enabled;
            if (!enabled) {
                // Restore the user's manually-selected MAP quality when turning adaptive off
                applyMapQuality(Settings.get().mapQuality || 12);
            }
        }
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

    // ---- Request Culling While Moving: adapt multiplier by speed band (coarse, not per-frame) ----
    let lastCullBand = null;
    setInterval(() => {
        const s = Settings.get();
        if (!s.requestCulling || !viewer._googleTileset) return;
        const speed01 = Math.min(1, Math.abs(vehicle.velocity) / Math.max(1, vehicle.maxSpeed));
        const band = speed01 < 0.33 ? 60 : speed01 < 0.66 ? 75 : 90;
        if (band !== lastCullBand) {
            lastCullBand = band;
            if ('cullRequestsWhileMovingMultiplier' in viewer._googleTileset) {
                viewer._googleTileset.cullRequestsWhileMovingMultiplier = band;
            }
            // Keep the settings panel slider/value in sync, without persisting the manual choice
            const el = document.getElementById('request-culling-slider');
            const label = document.getElementById('request-culling-value');
            if (el) el.value = band;
            if (label) label.textContent = String(band);
        }
    }, 800);

    // ---- Adaptive Performance Controller: FPS-driven MAP quality tiers with hysteresis ----
    let adaptivePerfEnabled = Settings.get().adaptivePerformance;
    const QUALITY_TIERS = [
        { name: 'EMERGENCY', level: 3, lowerFps: 0, upperFps: 25 },
        { name: 'PERFORMANCE', level: 7, lowerFps: 20, upperFps: 32 },
        { name: 'BALANCED', level: 11, lowerFps: 27, upperFps: 42 },
        { name: 'HIGH', level: 15, lowerFps: 37, upperFps: 52 },
        { name: 'ULTRA', level: 19, lowerFps: 47, upperFps: 999 }
    ];
    let perfTierIndex = 2; // start at BALANCED
    let perfCooldownUntil = 0;
    let fpsSamples = [];
    function updateAdaptivePerformance(now, dt) {
        if (!adaptivePerfEnabled || dt <= 0) return;
        fpsSamples.push(1 / dt);
        if (fpsSamples.length > 60) fpsSamples.shift();
        if (now < perfCooldownUntil || fpsSamples.length < 30) return;

        const avgFps = fpsSamples.reduce((a, b) => a + b, 0) / fpsSamples.length;
        const tier = QUALITY_TIERS[perfTierIndex];
        let nextIndex = perfTierIndex;
        if (avgFps < tier.lowerFps && perfTierIndex > 0) {
            nextIndex = perfTierIndex - 1; // drop a tier
        } else if (avgFps > tier.upperFps && perfTierIndex < QUALITY_TIERS.length - 1) {
            nextIndex = perfTierIndex + 1; // raise a tier
        }
        if (nextIndex !== perfTierIndex) {
            perfTierIndex = nextIndex;
            applyMapQuality(QUALITY_TIERS[perfTierIndex].level);
            perfCooldownUntil = now + 1500; // 1.5s cooldown to avoid oscillation
            fpsSamples = [];
        }
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
        updateAdaptivePerformance(now, dt);

        requestAnimationFrame(simLoop);
    }

    requestAnimationFrame(simLoop);
});
