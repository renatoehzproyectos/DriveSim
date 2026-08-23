class Navigation {
    constructor(viewer, vehicle) {
        this.viewer = viewer;
        this.vehicle = vehicle;
        
        this.map = null;
        this.carMarker = null;
        this.routePolylineCesium = null;
        this.routePolylineLeaflet = null;
        this.destinationMarker = null;

        // Device GPS / "you are here" clone
        this.gpsWatchId = null;
        this.gpsActive = false;
        this.gpsLon = null;
        this.gpsLat = null;
        this.gpsAccuracy = null; // meters
        this.gpsHeading = null;
        this.deviceMarkerLeaflet = null;
        this.deviceEntityCesium = null;

        // Smooth tween state for the device clone (avoids teleport jumps)
        this.deviceDisplayLon = null;
        this.deviceDisplayLat = null;
        this.deviceDisplayHeading = 0;
        this.deviceTargetLon = null;
        this.deviceTargetLat = null;
        this.deviceTargetHeading = 0;
        this.deviceTweenSpeed = 2.8; // higher = snappier, still smooth
        
        this.initMinimap();
        this.initSearchUI();
        this.initGpsUI();
    }

    initMinimap() {
        const start = this.vehicle.getLonLat();
        
        // Initialize Leaflet Map
        this.map = L.map('minimap', {
            zoomControl: false,
            attributionControl: false,
            scrollWheelZoom: false,
            doubleClickZoom: false,
            boxZoom: false,
            dragging: false // Mobile driving focus
        }).setView([start.lat, start.lon], 16);

        // Satellite tiles to match the main Cesium view
        L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
            maxZoom: 19,
            attribution: '© Esri'
        }).addTo(this.map);

        // Add vehicle marker in center
        const carIcon = L.divIcon({
            className: 'custom-car-icon',
            html: '<div style="width: 20px; height: 20px; background: #00ff66; border-radius: 50%; box-shadow: 0 0 10px #00ff66;"></div>',
            iconSize: [20, 20]
        });
        
        this.carMarker = L.marker([start.lat, start.lon], { icon: carIcon }).addTo(this.map);
        
        // Clicking on the minimap sets destination (route)
        this.map.on('click', (e) => {
            this.setDestination(e.latlng.lng, e.latlng.lat);
        });
    }

    initSearchUI() {
        const input = document.getElementById('dest-input');
        const routeBtn = document.getElementById('route-btn');
        const teleportBtn = document.getElementById('teleport-btn');

        const handleQuery = async (mode) => {
            const query = input.value.trim();
            if (!query) return;

            // Show loading state
            const originalRouteText = routeBtn.textContent;
            const originalTeleportText = teleportBtn.textContent;
            routeBtn.disabled = true;
            teleportBtn.disabled = true;
            if (mode === 'route') routeBtn.textContent = '...';
            else teleportBtn.textContent = '...';

            try {
                const coords = await this.resolveQuery(query);
                if (!coords) {
                    alert('Location not found. Try a city, address, or "lat, lon"');
                    return;
                }

                if (mode === 'route') {
                    await this.setDestination(coords.lon, coords.lat);
                } else {
                    this.clearRoute();
                    this.vehicle.teleport(coords.lon, coords.lat);
                    // Update minimap immediately
                    this.map.setView([coords.lat, coords.lon], 16);
                }
            } catch (err) {
                console.error(err);
                alert('Error looking up location');
            } finally {
                routeBtn.disabled = false;
                teleportBtn.disabled = false;
                routeBtn.textContent = originalRouteText;
                teleportBtn.textContent = originalTeleportText;
            }
        };

        routeBtn.addEventListener('click', () => handleQuery('route'));
        teleportBtn.addEventListener('click', () => handleQuery('teleport'));

        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                handleQuery('route');
            }
        });
    }

    /**
     * Resolve free-text query to {lon, lat}.
     * Supports:
     *  - "lat, lon" or "lon, lat" numeric pairs
     *  - Place names / addresses via Nominatim (OpenStreetMap)
     */
    async resolveQuery(query) {
        // Try numeric lat,lon or lon,lat
        const numMatch = query.match(/^\s*(-?\d+\.?\d*)\s*[, ]\s*(-?\d+\.?\d*)\s*$/);
        if (numMatch) {
            const a = parseFloat(numMatch[1]);
            const b = parseFloat(numMatch[2]);
            // Heuristic: if |a| > 90 then a is lon
            if (Math.abs(a) > 90) {
                return { lon: a, lat: b };
            }
            return { lon: b, lat: a };
        }

        // Geocode with Nominatim
        const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&limit=1`;
        const response = await fetch(url, {
            headers: {
                'Accept': 'application/json',
                'User-Agent': 'NeonOrbitDriveSim/1.0 (educational driving simulator)'
            }
        });
        if (!response.ok) throw new Error('Geocoder failed');
        const data = await response.json();
        if (!data || data.length === 0) return null;
        return {
            lon: parseFloat(data[0].lon),
            lat: parseFloat(data[0].lat)
        };
    }

    update() {
        const pos = this.vehicle.getLonLat();
        const headingDeg = Cesium.Math.toDegrees(this.vehicle.heading);
        
        // Center leaflet on car
        this.map.panTo([pos.lat, pos.lon], { animate: false });
        
        // Rotate minimap so vehicle direction points "up" (HUD style)
        // heading 0 = North → rotate by -heading
        const minimapEl = document.getElementById('minimap');
        minimapEl.style.transform = `rotate(${-headingDeg}deg)`;
        
        this.carMarker.setLatLng([pos.lat, pos.lon]);

        // Smoothly tween the device GPS clone toward its latest target
        this.tweenDeviceClone();
    }

    async setDestination(lon, lat) {
        const start = this.vehicle.getLonLat();
        
        // Clear previous routes
        this.clearRoute();
        
        // OSRM Routing Request
        const url = `https://router.project-osrm.org/route/v1/driving/${start.lon},${start.lat};${lon},${lat}?geometries=geojson&overview=full&steps=true`;
        
        try {
            const response = await fetch(url);
            const data = await response.json();
            
            if (data.code === 'Ok') {
                const route = data.routes[0];
                this.drawRoute(route.geometry);
                this.showInstructions(route.legs[0].steps);
            } else {
                console.warn('OSRM returned', data.code);
                // Still place a destination marker even if no route
                this.placeDestMarker(lon, lat);
            }
        } catch (error) {
            console.error("OSRM Route Error: ", error);
            this.placeDestMarker(lon, lat);
        }
    }

    placeDestMarker(lon, lat) {
        this.destinationMarker = L.marker([lat, lon], {
            icon: L.divIcon({
                className: 'dest-icon',
                html: '<div style="width: 15px; height: 15px; background: #ff00cc; border-radius: 50%; box-shadow: 0 0 10px #ff00cc;"></div>'
            })
        }).addTo(this.map);
    }

    drawRoute(geometry) {
        const coordinates = geometry.coordinates; // [[lon, lat], ...]
        
        // 1. Draw 2D Route in Leaflet
        const leafletCoords = coordinates.map(c => [c[1], c[0]]);
        this.routePolylineLeaflet = L.polyline(leafletCoords, {
            color: '#00f3ff',
            weight: 5,
            opacity: 0.8
        }).addTo(this.map);
        
        // Add destination marker
        const dest = coordinates[coordinates.length - 1];
        this.placeDestMarker(dest[0], dest[1]);

        // 2. Draw 3D Route in Cesium
        const cesiumPoints = coordinates.map(c => Cesium.Cartesian3.fromDegrees(c[0], c[1], 1.0));
        
        this.routePolylineCesium = this.viewer.entities.add({
            polyline: {
                positions: cesiumPoints,
                width: 8,
                material: new Cesium.PolylineGlowMaterialProperty({
                    glowPower: 0.2,
                    color: Cesium.Color.fromCssColorString('#00f3ff')
                })
            }
        });
    }

    showInstructions(steps) {
        const navInstructions = document.getElementById('nav-instructions');
        const navText = document.getElementById('nav-text');
        
        if (steps && steps.length > 0) {
            navInstructions.classList.remove('hidden');
            const step = steps[0];
            navText.innerText = `${step.maneuver.instruction} (${Math.round(step.distance)}m)`;
        } else {
            navInstructions.classList.add('hidden');
        }
    }

    clearRoute() {
        if (this.routePolylineLeaflet) {
            this.map.removeLayer(this.routePolylineLeaflet);
            this.routePolylineLeaflet = null;
        }
        if (this.destinationMarker) {
            this.map.removeLayer(this.destinationMarker);
            this.destinationMarker = null;
        }
        if (this.routePolylineCesium) {
            this.viewer.entities.remove(this.routePolylineCesium);
            this.routePolylineCesium = null;
        }
        document.getElementById('nav-instructions').classList.add('hidden');
    }

    // ─── Device Geolocation (ultra-high accuracy) ───────────────────────────

    initGpsUI() {
        const toggleBtn = document.getElementById('gps-toggle-btn');
        const teleportBtn = document.getElementById('gps-teleport-btn');
        const statusEl = document.getElementById('gps-status');
        const accuracyEl = document.getElementById('gps-accuracy');

        if (!toggleBtn || !teleportBtn) return;

        if (!navigator.geolocation) {
            toggleBtn.textContent = 'NO GPS';
            toggleBtn.disabled = true;
            return;
        }

        toggleBtn.addEventListener('click', () => {
            if (this.gpsActive) {
                this.stopGps();
            } else {
                this.startGps();
            }
        });

        teleportBtn.addEventListener('click', () => {
            this.teleportToDevice();
        });
    }

    startGps() {
        const toggleBtn = document.getElementById('gps-toggle-btn');
        const teleportBtn = document.getElementById('gps-teleport-btn');
        const statusEl = document.getElementById('gps-status');
        const accuracyEl = document.getElementById('gps-accuracy');

        // Ultra precision options
        const options = {
            enableHighAccuracy: true,   // force GPS chip / best sensors
            maximumAge: 0,              // never use cached position
            timeout: 15000              // wait up to 15s for a fix
        };

        toggleBtn.textContent = 'LOCATING…';
        toggleBtn.classList.add('active');
        statusEl.classList.remove('hidden');
        accuracyEl.textContent = 'acquiring…';

        // Continuous watch for live tracking
        this.gpsWatchId = navigator.geolocation.watchPosition(
            (pos) => this.onGpsSuccess(pos),
            (err) => this.onGpsError(err),
            options
        );
        this.gpsActive = true;
    }

    stopGps() {
        if (this.gpsWatchId !== null) {
            navigator.geolocation.clearWatch(this.gpsWatchId);
            this.gpsWatchId = null;
        }
        this.gpsActive = false;
        this.gpsLon = null;
        this.gpsLat = null;
        this.gpsAccuracy = null;

        // Reset tween state
        this.deviceDisplayLon = null;
        this.deviceDisplayLat = null;
        this.deviceDisplayHeading = 0;
        this.deviceTargetLon = null;
        this.deviceTargetLat = null;
        this.deviceTargetHeading = 0;

        // Remove visual clone
        if (this.deviceMarkerLeaflet) {
            this.map.removeLayer(this.deviceMarkerLeaflet);
            this.deviceMarkerLeaflet = null;
        }
        if (this.deviceEntityCesium) {
            this.viewer.entities.remove(this.deviceEntityCesium);
            this.deviceEntityCesium = null;
        }

        const toggleBtn = document.getElementById('gps-toggle-btn');
        const teleportBtn = document.getElementById('gps-teleport-btn');
        const statusEl = document.getElementById('gps-status');

        toggleBtn.textContent = 'GPS ON';
        toggleBtn.classList.remove('active');
        teleportBtn.disabled = true;
        statusEl.classList.add('hidden');
    }

    onGpsSuccess(pos) {
        const { latitude, longitude, accuracy, heading } = pos.coords;
        this.gpsLat = latitude;
        this.gpsLon = longitude;
        this.gpsAccuracy = accuracy;
        this.gpsHeading = (heading != null && !isNaN(heading)) ? heading : null;

        // Update UI
        const toggleBtn = document.getElementById('gps-toggle-btn');
        const teleportBtn = document.getElementById('gps-teleport-btn');
        const accuracyEl = document.getElementById('gps-accuracy');

        toggleBtn.textContent = 'GPS LIVE';
        toggleBtn.classList.add('active');
        teleportBtn.disabled = false;

        // Accuracy display – celebrate when it's excellent
        let label;
        if (accuracy <= 5) label = `±${accuracy.toFixed(1)} m  ULTRA`;
        else if (accuracy <= 15) label = `±${accuracy.toFixed(0)} m  EXCELLENT`;
        else if (accuracy <= 40) label = `±${accuracy.toFixed(0)} m  GOOD`;
        else label = `±${accuracy.toFixed(0)} m`;
        accuracyEl.textContent = label;

        this.updateDeviceClone();
    }

    onGpsError(err) {
        console.warn('GPS error', err);
        const accuracyEl = document.getElementById('gps-accuracy');
        const messages = {
            1: 'Permission denied – allow location',
            2: 'Position unavailable',
            3: 'Timeout – try outdoors'
        };
        if (accuracyEl) {
            accuracyEl.textContent = messages[err.code] || err.message || 'GPS error';
        }
        // Keep trying; watchPosition will fire again when possible
    }

    /**
     * Called on every GPS fix. Sets the *target* position; the actual visual
     * is smoothly interpolated in tweenDeviceClone() each frame.
     */
    updateDeviceClone() {
        if (this.gpsLon == null || this.gpsLat == null) return;

        this.deviceTargetLon = this.gpsLon;
        this.deviceTargetLat = this.gpsLat;
        this.deviceTargetHeading = (this.gpsHeading != null && !isNaN(this.gpsHeading))
            ? this.gpsHeading
            : this.deviceTargetHeading;

        // First fix: snap display to target so we don't start from (0,0)
        if (this.deviceDisplayLon == null) {
            this.deviceDisplayLon = this.deviceTargetLon;
            this.deviceDisplayLat = this.deviceTargetLat;
            this.deviceDisplayHeading = this.deviceTargetHeading;
            this.applyDeviceVisual(this.deviceDisplayLon, this.deviceDisplayLat, this.deviceDisplayHeading);
        }
    }

    /**
     * Frame-by-frame exponential lerp of the device clone toward its target.
     * Called from the main sim loop so movement is buttery smooth.
     */
    tweenDeviceClone() {
        if (this.deviceTargetLon == null || this.deviceDisplayLon == null) return;

        // Approximate frame dt (~16 ms at 60 fps). Exponential ease feels natural.
        const alpha = 1 - Math.exp(-this.deviceTweenSpeed * (1 / 60));

        this.deviceDisplayLon += (this.deviceTargetLon - this.deviceDisplayLon) * alpha;
        this.deviceDisplayLat += (this.deviceTargetLat - this.deviceDisplayLat) * alpha;

        // Shortest-path heading lerp (degrees)
        let dH = this.deviceTargetHeading - this.deviceDisplayHeading;
        while (dH > 180) dH -= 360;
        while (dH < -180) dH += 360;
        this.deviceDisplayHeading += dH * alpha;

        this.applyDeviceVisual(this.deviceDisplayLon, this.deviceDisplayLat, this.deviceDisplayHeading);
    }

    /** Push the current displayed lon/lat/heading into Leaflet + Cesium */
    applyDeviceVisual(lon, lat, headingDeg) {
        // ── Leaflet marker (distinct pink/gold pulse so it's clearly "you") ──
        if (!this.deviceMarkerLeaflet) {
            const youIcon = L.divIcon({
                className: 'device-gps-icon',
                html: `<div style="
                    width: 22px; height: 22px;
                    background: radial-gradient(circle, #ffcc00 30%, #ff00cc 100%);
                    border: 2px solid #fff;
                    border-radius: 50%;
                    box-shadow: 0 0 14px #ff00cc, 0 0 6px #ffcc00;
                "></div>`,
                iconSize: [22, 22],
                iconAnchor: [11, 11]
            });
            this.deviceMarkerLeaflet = L.marker([lat, lon], {
                icon: youIcon,
                zIndexOffset: 1000
            }).addTo(this.map);
        } else {
            this.deviceMarkerLeaflet.setLatLng([lat, lon]);
        }

        // ── Cesium entity – visual clone of the car at your real position ──
        const position = Cesium.Cartesian3.fromDegrees(lon, lat, 0.5);
        const headingRad = Cesium.Math.toRadians(headingDeg);

        if (!this.deviceEntityCesium) {
            this.deviceEntityCesium = this.viewer.entities.add({
                position: position,
                orientation: Cesium.Transforms.headingPitchRollQuaternion(
                    position,
                    new Cesium.HeadingPitchRoll(headingRad - Math.PI / 2, 0, 0)
                ),
                model: {
                    uri: 'https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Models/master/2.0/CesiumMilkTruck/glTF/CesiumMilkTruck.gltf',
                    minimumPixelSize: 48,
                    maximumScale: 20000,
                    color: Cesium.Color.fromCssColorString('#ff00cc').withAlpha(0.85),
                    colorBlendMode: Cesium.ColorBlendMode.HIGHLIGHT,
                    colorBlendAmount: 0.6
                },
                // Soft glow point so it's easy to spot from distance
                point: {
                    pixelSize: 14,
                    color: Cesium.Color.fromCssColorString('#ffcc00'),
                    outlineColor: Cesium.Color.fromCssColorString('#ff00cc'),
                    outlineWidth: 3,
                    heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
                    disableDepthTestDistance: Number.POSITIVE_INFINITY
                },
                label: {
                    text: 'YOU',
                    font: 'bold 14px sans-serif',
                    fillColor: Cesium.Color.WHITE,
                    outlineColor: Cesium.Color.fromCssColorString('#ff00cc'),
                    outlineWidth: 3,
                    style: Cesium.LabelStyle.FILL_AND_OUTLINE,
                    verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
                    pixelOffset: new Cesium.Cartesian2(0, -28),
                    disableDepthTestDistance: Number.POSITIVE_INFINITY,
                    heightReference: Cesium.HeightReference.CLAMP_TO_GROUND
                }
            });
        } else {
            this.deviceEntityCesium.position = position;
            this.deviceEntityCesium.orientation = Cesium.Transforms.headingPitchRollQuaternion(
                position,
                new Cesium.HeadingPitchRoll(headingRad - Math.PI / 2, 0, 0)
            );
        }
    }

    /** Teleport the driven car right next to the device GPS position */
    teleportToDevice() {
        if (this.gpsLon == null || this.gpsLat == null) return;

        // Small offset (~8 m north) so the clone and driven car don't occupy the exact same spot
        const offsetMeters = 8;
        const metersPerDegreeLat = 111111;
        const dLat = offsetMeters / metersPerDegreeLat;

        this.clearRoute();
        this.vehicle.teleport(this.gpsLon, this.gpsLat + dLat);

        // Snap minimap
        this.map.setView([this.gpsLat, this.gpsLon], 17);
    }
}
