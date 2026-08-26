/**
 * DriveSim Settings
 * - Renderer: auto | cesium | leaflet  (Leaflet = Plan B fallback)
 * - Terrain (Cesium only): flat | worldterrain | google3d
 * - Cesium ion access token, persisted to localStorage
 * - Camera FOV, follow delay, SSE
 */
const Settings = (() => {
    const KEYS = {
        renderer: 'ds:renderer',
        terrain: 'ds:terrain',
        ionToken: 'ds:ionToken',
        heightSampleMs: 'ds:heightSampleMs',
        fovDeg: 'ds:fovDeg',
        followDelayMs: 'ds:followDelayMs',
        sseValue: 'ds:sseValue',
        dynamicSse: 'ds:dynamicSse',
        mapQuality: 'ds:mapQuality',
        // --- New CesiumJS performance-booster features ---
        nativeDynamicSse: 'ds:nativeDynamicSse',
        nativeDynamicSseFactor: 'ds:nativeDynamicSseFactor',
        foveated: 'ds:foveated',
        foveatedDelay: 'ds:foveatedDelay',
        requestCulling: 'ds:requestCulling',
        requestCullingMultiplier: 'ds:requestCullingMultiplier',
        progressiveResolution: 'ds:progressiveResolution',
        progressiveResolutionFraction: 'ds:progressiveResolutionFraction',
        preloadFlightDest: 'ds:preloadFlightDest',
        adaptivePerformance: 'ds:adaptivePerformance'
    };

    function get() {
        return {
            renderer: localStorage.getItem(KEYS.renderer) || 'auto',
            terrain: localStorage.getItem(KEYS.terrain) || 'flat',
            ionToken: localStorage.getItem(KEYS.ionToken) || '',
            heightSampleMs: parseInt(localStorage.getItem(KEYS.heightSampleMs), 10) || 200,
            fovDeg: parseFloat(localStorage.getItem(KEYS.fovDeg)) || 60,
            followDelayMs: parseInt(localStorage.getItem(KEYS.followDelayMs), 10) || 0,
            sseValue: parseFloat(localStorage.getItem(KEYS.sseValue)) || 2,
            dynamicSse: localStorage.getItem(KEYS.dynamicSse) === '1',
            mapQuality: parseInt(localStorage.getItem(KEYS.mapQuality), 10) || 12,
            // --- New CesiumJS performance-booster features (default OFF, opt-in) ---
            nativeDynamicSse: localStorage.getItem(KEYS.nativeDynamicSse) === '1',
            nativeDynamicSseFactor: parseFloat(localStorage.getItem(KEYS.nativeDynamicSseFactor)) || 24.0,
            foveated: localStorage.getItem(KEYS.foveated) === '1',
            foveatedDelay: parseFloat(localStorage.getItem(KEYS.foveatedDelay)) || 0.15,
            requestCulling: localStorage.getItem(KEYS.requestCulling) === '1',
            requestCullingMultiplier: parseFloat(localStorage.getItem(KEYS.requestCullingMultiplier)) || 75,
            progressiveResolution: localStorage.getItem(KEYS.progressiveResolution) === '1',
            progressiveResolutionFraction: parseFloat(localStorage.getItem(KEYS.progressiveResolutionFraction)) || 0.30,
            preloadFlightDest: localStorage.getItem(KEYS.preloadFlightDest) === '1',
            adaptivePerformance: localStorage.getItem(KEYS.adaptivePerformance) === '1'
        };
    }

    function set(partial) {
        if (partial.renderer !== undefined) localStorage.setItem(KEYS.renderer, partial.renderer);
        if (partial.terrain !== undefined) localStorage.setItem(KEYS.terrain, partial.terrain);
        if (partial.ionToken !== undefined) localStorage.setItem(KEYS.ionToken, partial.ionToken);
        if (partial.heightSampleMs !== undefined) localStorage.setItem(KEYS.heightSampleMs, String(partial.heightSampleMs));
        if (partial.fovDeg !== undefined) localStorage.setItem(KEYS.fovDeg, String(partial.fovDeg));
        if (partial.followDelayMs !== undefined) localStorage.setItem(KEYS.followDelayMs, String(partial.followDelayMs));
        if (partial.sseValue !== undefined) localStorage.setItem(KEYS.sseValue, String(partial.sseValue));
        if (partial.dynamicSse !== undefined) localStorage.setItem(KEYS.dynamicSse, partial.dynamicSse ? '1' : '0');
        if (partial.mapQuality !== undefined) localStorage.setItem(KEYS.mapQuality, String(partial.mapQuality));
        if (partial.nativeDynamicSse !== undefined) localStorage.setItem(KEYS.nativeDynamicSse, partial.nativeDynamicSse ? '1' : '0');
        if (partial.nativeDynamicSseFactor !== undefined) localStorage.setItem(KEYS.nativeDynamicSseFactor, String(partial.nativeDynamicSseFactor));
        if (partial.foveated !== undefined) localStorage.setItem(KEYS.foveated, partial.foveated ? '1' : '0');
        if (partial.foveatedDelay !== undefined) localStorage.setItem(KEYS.foveatedDelay, String(partial.foveatedDelay));
        if (partial.requestCulling !== undefined) localStorage.setItem(KEYS.requestCulling, partial.requestCulling ? '1' : '0');
        if (partial.requestCullingMultiplier !== undefined) localStorage.setItem(KEYS.requestCullingMultiplier, String(partial.requestCullingMultiplier));
        if (partial.progressiveResolution !== undefined) localStorage.setItem(KEYS.progressiveResolution, partial.progressiveResolution ? '1' : '0');
        if (partial.progressiveResolutionFraction !== undefined) localStorage.setItem(KEYS.progressiveResolutionFraction, String(partial.progressiveResolutionFraction));
        if (partial.preloadFlightDest !== undefined) localStorage.setItem(KEYS.preloadFlightDest, partial.preloadFlightDest ? '1' : '0');
        if (partial.adaptivePerformance !== undefined) localStorage.setItem(KEYS.adaptivePerformance, partial.adaptivePerformance ? '1' : '0');
    }

    /** Rough heuristic for "bad device" that should not run Cesium 3D globe rendering */
    function deviceSupportsCesium() {
        try {
            const canvas = document.createElement('canvas');
            const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
            if (!gl) return false;

            // Low-memory / low-core devices tend to choke on the 3D globe
            if (navigator.deviceMemory && navigator.deviceMemory < 2) return false;
            if (navigator.hardwareConcurrency && navigator.hardwareConcurrency < 2) return false;

            return true;
        } catch (e) {
            return false;
        }
    }

    /** Resolves 'auto' into an actual renderer choice */
    function resolveRenderer() {
        const mode = get().renderer;
        if (mode === 'cesium' || mode === 'leaflet') return mode;
        return deviceSupportsCesium() ? 'cesium' : 'leaflet';
    }

    function applyIonToken() {
        const token = get().ionToken;
        if (token && window.Cesium) {
            Cesium.Ion.defaultAccessToken = token;
        }
    }

    /**
     * Wires up the gear button + panel UI.
     * Optional callbacks: onTerrainChange, onHeightSampleChange, onVehicleModeChange,
     * onFovChange, onFollowDelayChange, onSseChange
     */
    function initUI({
        onTerrainChange,
        onHeightSampleChange,
        onVehicleModeChange,
        onFovChange,
        onFollowDelayChange,
        onSseChange,
        onMapQualityChange,
        onStreamingChange,
        onAdaptivePerformanceChange
    } = {}) {
        const state = get();

        const btn = document.getElementById('settings-btn');
        const panel = document.getElementById('settings-panel');
        const closeBtn = document.getElementById('settings-close-btn');
        const reloadNote = document.getElementById('settings-reload-note');
        const terrainSection = document.getElementById('terrain-section');
        const vehicleSection = document.getElementById('vehicle-section');
        const isCesium = resolveRenderer() === 'cesium';

        document.querySelectorAll('input[name="renderer-mode"]').forEach(el => {
            el.checked = el.value === state.renderer;
            el.addEventListener('change', () => {
                set({ renderer: el.value });
                reloadNote.classList.remove('hidden');
            });
        });

        document.querySelectorAll('input[name="terrain-mode"]').forEach(el => {
            el.checked = el.value === state.terrain;
            el.addEventListener('change', () => {
                set({ terrain: el.value });
                if (typeof onTerrainChange === 'function') onTerrainChange(el.value);
            });
        });

        // Terrain only matters when Cesium is actually rendering
        if (!isCesium) {
            terrainSection.classList.add('disabled');
        }

        // Airplane mode is a Cesium-only feature — hide it entirely for Plan B (Leaflet)
        if (!isCesium) {
            vehicleSection.classList.add('hidden');
        } else {
            document.querySelectorAll('input[name="vehicle-mode"]').forEach(el => {
                el.checked = el.value === 'car';
                el.addEventListener('change', () => {
                    if (typeof onVehicleModeChange === 'function') onVehicleModeChange(el.value);
                });
            });
        }

        const heightSlider = document.getElementById('height-sample-slider');
        const heightValueLabel = document.getElementById('height-sample-value');
        if (heightSlider) {
            heightSlider.value = state.heightSampleMs;
            heightValueLabel.textContent = `${state.heightSampleMs} ms`;
            heightSlider.addEventListener('input', () => {
                const ms = parseInt(heightSlider.value, 10);
                heightValueLabel.textContent = `${ms} ms`;
                set({ heightSampleMs: ms });
                if (typeof onHeightSampleChange === 'function') onHeightSampleChange(ms);
            });
        }

        // FOV slider
        const fovSlider = document.getElementById('fov-slider');
        const fovValueLabel = document.getElementById('fov-value');
        if (fovSlider) {
            fovSlider.value = state.fovDeg;
            fovValueLabel.textContent = `${Math.round(state.fovDeg)}°`;
            fovSlider.addEventListener('input', () => {
                const deg = parseFloat(fovSlider.value);
                fovValueLabel.textContent = `${Math.round(deg)}°`;
                set({ fovDeg: deg });
                if (typeof onFovChange === 'function') onFovChange(deg);
            });
        }

        // Follow delay slider
        const followSlider = document.getElementById('follow-delay-slider');
        const followValueLabel = document.getElementById('follow-delay-value');
        if (followSlider) {
            followSlider.value = state.followDelayMs;
            followValueLabel.textContent = `${state.followDelayMs} ms`;
            followSlider.addEventListener('input', () => {
                const ms = parseInt(followSlider.value, 10);
                followValueLabel.textContent = `${ms} ms`;
                set({ followDelayMs: ms });
                if (typeof onFollowDelayChange === 'function') onFollowDelayChange(ms);
            });
        }

        // SSE slider + dynamic toggle (wired primarily in app.js via onSseChange)
        const sseSlider = document.getElementById('sse-slider');
        const sseValueLabel = document.getElementById('sse-value');
        const dynamicSseEl = document.getElementById('cull-dynamic-sse');
        if (sseSlider) {
            sseSlider.value = state.sseValue;
            sseValueLabel.textContent = state.sseValue.toFixed(1);
            sseSlider.addEventListener('input', () => {
                const v = parseFloat(sseSlider.value);
                sseValueLabel.textContent = v.toFixed(1);
                set({ sseValue: v });
                if (typeof onSseChange === 'function') onSseChange();
            });
        }
        if (dynamicSseEl) {
            dynamicSseEl.checked = state.dynamicSse;
            dynamicSseEl.addEventListener('change', () => {
                set({ dynamicSse: dynamicSseEl.checked });
                if (typeof onSseChange === 'function') onSseChange();
            });
        }

        // MAP quality (resolution scale)
        const mapSlider = document.getElementById('map-quality-slider');
        const mapValueLabel = document.getElementById('map-quality-value');
        if (mapSlider) {
            const levelLabel = (level) =>
                level >= 17 ? 'ULTRA' : level >= 14 ? 'MAX' : level >= 10 ? 'HI' : level >= 5 ? 'MED' : 'LO';
            mapSlider.value = state.mapQuality;
            if (mapValueLabel) mapValueLabel.textContent = levelLabel(state.mapQuality);
            mapSlider.addEventListener('input', () => {
                const level = parseInt(mapSlider.value, 10);
                if (mapValueLabel) mapValueLabel.textContent = levelLabel(level);
                set({ mapQuality: level });
                if (typeof onMapQualityChange === 'function') onMapQualityChange(level);
            });
        }

        // --- New CesiumJS performance-booster features ---
        const fireStreamingChange = () => {
            if (typeof onStreamingChange === 'function') onStreamingChange();
        };

        const nativeDynamicSseEl = document.getElementById('native-dynamic-sse');
        const nativeDynamicSseFactorSlider = document.getElementById('native-dynamic-sse-factor-slider');
        const nativeDynamicSseFactorLabel = document.getElementById('native-dynamic-sse-factor-value');
        if (nativeDynamicSseEl) {
            nativeDynamicSseEl.checked = state.nativeDynamicSse;
            nativeDynamicSseEl.addEventListener('change', () => {
                set({ nativeDynamicSse: nativeDynamicSseEl.checked });
                fireStreamingChange();
            });
        }
        if (nativeDynamicSseFactorSlider) {
            nativeDynamicSseFactorSlider.value = state.nativeDynamicSseFactor;
            if (nativeDynamicSseFactorLabel) nativeDynamicSseFactorLabel.textContent = state.nativeDynamicSseFactor.toFixed(0);
            nativeDynamicSseFactorSlider.addEventListener('input', () => {
                const v = parseFloat(nativeDynamicSseFactorSlider.value);
                if (nativeDynamicSseFactorLabel) nativeDynamicSseFactorLabel.textContent = v.toFixed(0);
                set({ nativeDynamicSseFactor: v });
                fireStreamingChange();
            });
        }

        const foveatedEl = document.getElementById('foveated-loading');
        const foveatedDelaySlider = document.getElementById('foveated-delay-slider');
        const foveatedDelayLabel = document.getElementById('foveated-delay-value');
        if (foveatedEl) {
            foveatedEl.checked = state.foveated;
            foveatedEl.addEventListener('change', () => {
                set({ foveated: foveatedEl.checked });
                fireStreamingChange();
            });
        }
        if (foveatedDelaySlider) {
            foveatedDelaySlider.value = state.foveatedDelay;
            if (foveatedDelayLabel) foveatedDelayLabel.textContent = `${state.foveatedDelay.toFixed(2)}s`;
            foveatedDelaySlider.addEventListener('input', () => {
                const v = parseFloat(foveatedDelaySlider.value);
                if (foveatedDelayLabel) foveatedDelayLabel.textContent = `${v.toFixed(2)}s`;
                set({ foveatedDelay: v });
                fireStreamingChange();
            });
        }

        const requestCullingEl = document.getElementById('request-culling');
        const requestCullingSlider = document.getElementById('request-culling-slider');
        const requestCullingLabel = document.getElementById('request-culling-value');
        if (requestCullingEl) {
            requestCullingEl.checked = state.requestCulling;
            requestCullingEl.addEventListener('change', () => {
                set({ requestCulling: requestCullingEl.checked });
                fireStreamingChange();
            });
        }
        if (requestCullingSlider) {
            requestCullingSlider.value = state.requestCullingMultiplier;
            if (requestCullingLabel) requestCullingLabel.textContent = String(state.requestCullingMultiplier);
            requestCullingSlider.addEventListener('input', () => {
                const v = parseFloat(requestCullingSlider.value);
                if (requestCullingLabel) requestCullingLabel.textContent = String(v);
                set({ requestCullingMultiplier: v });
                fireStreamingChange();
            });
        }

        const progressiveResEl = document.getElementById('progressive-resolution');
        const progressiveResSlider = document.getElementById('progressive-resolution-slider');
        const progressiveResLabel = document.getElementById('progressive-resolution-value');
        if (progressiveResEl) {
            progressiveResEl.checked = state.progressiveResolution;
            progressiveResEl.addEventListener('change', () => {
                set({ progressiveResolution: progressiveResEl.checked });
                fireStreamingChange();
            });
        }
        if (progressiveResSlider) {
            progressiveResSlider.value = state.progressiveResolutionFraction;
            if (progressiveResLabel) progressiveResLabel.textContent = state.progressiveResolutionFraction.toFixed(2);
            progressiveResSlider.addEventListener('input', () => {
                const v = parseFloat(progressiveResSlider.value);
                if (progressiveResLabel) progressiveResLabel.textContent = v.toFixed(2);
                set({ progressiveResolutionFraction: v });
                fireStreamingChange();
            });
        }

        const preloadFlightEl = document.getElementById('preload-flight-dest');
        if (preloadFlightEl) {
            preloadFlightEl.checked = state.preloadFlightDest;
            preloadFlightEl.addEventListener('change', () => {
                set({ preloadFlightDest: preloadFlightEl.checked });
                fireStreamingChange();
            });
        }

        const adaptivePerfEl = document.getElementById('adaptive-performance');
        if (adaptivePerfEl) {
            adaptivePerfEl.checked = state.adaptivePerformance;
            adaptivePerfEl.addEventListener('change', () => {
                set({ adaptivePerformance: adaptivePerfEl.checked });
                if (typeof onAdaptivePerformanceChange === 'function') onAdaptivePerformanceChange(adaptivePerfEl.checked);
            });
        }

        // These streaming/adaptive features are Cesium-only; hide the section for Leaflet (Plan B)
        const streamingSection = document.getElementById('streaming-section');
        if (streamingSection && !isCesium) {
            streamingSection.classList.add('disabled');
        }

        const tokenInput = document.getElementById('ion-token-input');
        const tokenStatus = document.getElementById('ion-token-status');
        const tokenSaveBtn = document.getElementById('ion-token-save-btn');
        tokenInput.value = state.ionToken;

        const saveToken = () => {
            set({ ionToken: tokenInput.value.trim() });
            applyIonToken();
            tokenStatus.textContent = 'Saved ✓ (reload to fully apply)';
            setTimeout(() => { tokenStatus.textContent = ''; }, 3000);
        };
        tokenSaveBtn.addEventListener('click', saveToken);
        tokenInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') saveToken();
        });

        const open = () => panel.classList.remove('hidden');
        const close = () => panel.classList.add('hidden');
        btn.addEventListener('click', open);
        closeBtn.addEventListener('click', close);
        panel.addEventListener('click', (e) => {
            if (e.target === panel) close();
        });
    }

    return { get, set, deviceSupportsCesium, resolveRenderer, applyIonToken, initUI };
})();
