document.addEventListener('DOMContentLoaded', () => {
    // 1. Initialize Cesium without API key (using free CartoDB Dark imagery)
    // Cesium 1.107+ removed imageryProvider option – use baseLayer instead
    const cartoProvider = new Cesium.UrlTemplateImageryProvider({
        url: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png',
        subdomains: 'abcd',
        credit: '© OpenStreetMap contributors, © CartoDB',
        maximumLevel: 19
    });

    const viewer = new Cesium.Viewer('cesiumContainer', {
        baseLayer: new Cesium.ImageryLayer(cartoProvider),
        terrainProvider: new Cesium.EllipsoidTerrainProvider(), // Explicitly flat
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

    // Remove Cesium logo and credit widget to maximize mobile viewport space safely
    if (viewer.creditContainer) {
        viewer.creditContainer.style.display = 'none';
    }

    // Adjust camera performance and settings
    viewer.scene.fog.enabled = false;
    viewer.scene.highDynamicRange = false;
    viewer.scene.globe.enableLighting = false;
    viewer.scene.skyAtmosphere.show = true;
    // Ensure globe shows imagery (avoid pure blue fallback)
    viewer.scene.globe.baseColor = Cesium.Color.fromCssColorString('#1a1a2e');

    // 2. Instantiate Components
    const vehicle = new Vehicle(viewer);
    const controls = new Controls();
    const navigation = new Navigation(viewer, vehicle);

    // 3. Camera height slider (top-left) – keeps camera focused on the car
    const camSlider = document.getElementById('cam-height-slider');
    const camValueLabel = document.getElementById('cam-height-value');
    if (camSlider) {
        camSlider.value = vehicle.cameraHeight;
        camValueLabel.textContent = `${vehicle.cameraHeight} m`;
        camSlider.addEventListener('input', () => {
            const h = parseFloat(camSlider.value);
            vehicle.cameraHeight = h;
            camValueLabel.textContent = `${h} m`;
            // Force immediate camera refresh so the change is visible while stopped
            vehicle.updateCamera();
        });
    }

    // 4. Main Simulator Loop
    let lastTime = performance.now();

    function simLoop(now) {
        let dt = (now - lastTime) / 1000;
        
        // Cap dt to prevent massive jumps on stutter
        if (dt > 0.1) dt = 0.1; 
        lastTime = now;

        // Get Input State
        const input = controls.getInput();

        // Update Vehicle Physics & Camera
        vehicle.update(dt, input);

        // Update Minimap Position & Rotation
        navigation.update();

        requestAnimationFrame(simLoop);
    }

    // Start Simulation Loop
    requestAnimationFrame(simLoop);
});
