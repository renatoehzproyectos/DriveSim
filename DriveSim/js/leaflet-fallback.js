/**
 * Plan B renderer: a simplified fullscreen Leaflet driving mode
 * used automatically (or by force) on devices that can't handle
 * the Cesium 3D globe.
 */
function initLeafletFallback(controls) {
    document.getElementById('cesiumContainer').classList.add('hidden');
    document.getElementById('minimap-container').classList.add('hidden');
    document.getElementById('left-controls').classList.add('hidden');
    document.getElementById('search-container').classList.add('hidden');
    document.getElementById('nav-instructions').classList.add('hidden');
    document.getElementById('side-btns-left').classList.add('hidden');
    document.getElementById('side-btns-right').classList.add('hidden');

    const mapEl = document.getElementById('leafletMainContainer');
    mapEl.classList.remove('hidden');

    let lon = -122.4194;
    let lat = 37.7749;
    let heading = 0; // 0 = North, clockwise
    let velocity = 0;

    const maxSpeed = 55.56;
    const acceleration = 14;
    const friction = 0.998;
    const braking = 40;
    const turnSpeed = 1.6;

    const map = L.map(mapEl, {
        zoomControl: false,
        attributionControl: true,
        dragging: true,
        scrollWheelZoom: true
    }).setView([lat, lon], 18);

    L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
        maxZoom: 19,
        attribution: '© Esri, Maxar, Earthstar Geographics · Plan B (Leaflet)'
    }).addTo(map);

    const carIcon = L.divIcon({
        className: 'leaflet-car-icon',
        html: '<div class="leaflet-car-arrow"></div>',
        iconSize: [26, 26],
        iconAnchor: [13, 13]
    });
    const carMarker = L.marker([lat, lon], { icon: carIcon }).addTo(map);

    let lastTime = performance.now();

    function updateSpeedUI() {
        const el = document.getElementById('speed-value');
        if (el) el.innerText = Math.round(velocity * 3.6);
    }

    function loop(now) {
        let dt = (now - lastTime) / 1000;
        if (dt > 0.1) dt = 0.1;
        lastTime = now;

        const input = controls.getInput();

        if (input.gas) velocity += acceleration * dt;
        if (input.brake) velocity -= braking * dt;
        if (!input.gas) velocity *= friction;
        if (Math.abs(velocity) < 0.1) velocity = 0;
        velocity = Math.max(-10, Math.min(maxSpeed, velocity));

        if (Math.abs(velocity) > 0.1) {
            heading += input.steering * turnSpeed * dt * (velocity > 0 ? 1 : -1);
            heading = ((heading % (Math.PI * 2)) + (Math.PI * 2)) % (Math.PI * 2);
        }

        const moveStep = velocity * dt;
        const metersPerDegreeLat = 111111;
        const metersPerDegreeLon = 111111 * Math.cos(lat * Math.PI / 180);
        lat += (Math.cos(heading) * moveStep) / metersPerDegreeLat;
        lon += (Math.sin(heading) * moveStep) / metersPerDegreeLon;

        carMarker.setLatLng([lat, lon]);
        const headingDeg = heading * 180 / Math.PI;
        const arrow = carMarker.getElement()?.querySelector('.leaflet-car-arrow');
        if (arrow) arrow.style.transform = `rotate(${headingDeg}deg)`;

        map.setView([lat, lon], map.getZoom(), { animate: false });

        updateSpeedUI();
        requestAnimationFrame(loop);
    }

    requestAnimationFrame(loop);
}
