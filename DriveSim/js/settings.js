/**
 * DriveSim Settings
 * - Renderer: auto | cesium | leaflet  (Leaflet = Plan B fallback)
 * - Terrain (Cesium only): flat | worldterrain | google3d
 * - Cesium ion access token, persisted to localStorage
 */
const Settings = (() => {
    const KEYS = {
        renderer: 'ds:renderer',
        terrain: 'ds:terrain',
        ionToken: 'ds:ionToken'
    };

    function get() {
        return {
            renderer: localStorage.getItem(KEYS.renderer) || 'auto',
            terrain: localStorage.getItem(KEYS.terrain) || 'flat',
            ionToken: localStorage.getItem(KEYS.ionToken) || ''
        };
    }

    function set(partial) {
        if (partial.renderer !== undefined) localStorage.setItem(KEYS.renderer, partial.renderer);
        if (partial.terrain !== undefined) localStorage.setItem(KEYS.terrain, partial.terrain);
        if (partial.ionToken !== undefined) localStorage.setItem(KEYS.ionToken, partial.ionToken);
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

    /** Wires up the gear button + panel UI. Optional onTerrainChange callback(mode). */
    function initUI({ onTerrainChange } = {}) {
        const state = get();

        const btn = document.getElementById('settings-btn');
        const panel = document.getElementById('settings-panel');
        const closeBtn = document.getElementById('settings-close-btn');
        const reloadNote = document.getElementById('settings-reload-note');
        const terrainSection = document.getElementById('terrain-section');

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
        if (resolveRenderer() !== 'cesium') {
            terrainSection.classList.add('disabled');
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
