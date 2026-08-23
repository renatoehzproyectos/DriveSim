class Navigation {
    constructor(viewer, vehicle) {
        this.viewer = viewer;
        this.vehicle = vehicle;
        
        this.map = null;
        this.carMarker = null;
        this.routePolylineCesium = null;
        this.routePolylineLeaflet = null;
        this.destinationMarker = null;
        
        this.initMinimap();
        this.initSearchUI();
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

        // Add OpenStreetMap dark style tiles for a "neon/cyber" look
        L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png', {
            maxZoom: 19
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
}
