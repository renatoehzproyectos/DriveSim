document.addEventListener('DOMContentLoaded', () => {
    // 1. Initialize Cesium without API key (using free CartoDB Dark imagery)
    // Fixed: removed {r} retina suffix – Cesium UrlTemplateImageryProvider does not substitute it
    const viewer = new Cesium.Viewer('cesiumContainer', {
        imageryProvider: new Cesium.UrlTemplateImageryProvider({
            url: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png',
            credit: '© OpenStreetMap contributors, © CartoDB',
            maximumLevel: 19
        }),
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

    // 2. Instantiate Components
    const vehicle = new Vehicle(viewer);
    const controls = new Controls();
    const navigation = new Navigation(viewer, vehicle);

    // 3. Main Simulator Loop
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
