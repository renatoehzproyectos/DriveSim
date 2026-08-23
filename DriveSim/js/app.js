document.addEventListener('DOMContentLoaded', () => {
    // 1. Initialize Cesium without API key – Esri World Imagery (satellite)
    // Cesium 1.107+ removed imageryProvider option – use baseLayer instead
    // Note: Esri tiles use {z}/{y}/{x} order (not the usual {z}/{x}/{y})
    const satelliteProvider = new Cesium.UrlTemplateImageryProvider({
        url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
        credit: 'Tiles © Esri — Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community',
        maximumLevel: 19
    });

    const viewer = new Cesium.Viewer('cesiumContainer', {
        baseLayer: new Cesium.ImageryLayer(satelliteProvider),
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
    // Natural earth-tone fallback while satellite tiles load (avoids pure blue)
    viewer.scene.globe.baseColor = Cesium.Color.fromCssColorString('#2d4a3e');

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
