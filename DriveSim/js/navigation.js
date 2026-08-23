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
            dragPan: false // Mobile driving focus
        }).setView([start.lat, start.lon], 16);

        // Add OpenStreetMap dark style tiles for a "neon/cyber" look
        L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
            maxZoom: 19
        }).addTo(this.map);

        // Add vehicle marker in center
        const carIcon = L.divIcon({
            className: 'custom-car-icon',
            html: '<div style="width: 20px; height: 20px; background: #00ff66; border-radius: 50%; box-shadow: 0 0 10px #00ff66;"></div>',
            iconSize: [20, 20]
        });
        
        this.carMarker = L.marker([start.lat, start.lon], { icon: carIcon }).addTo(this.map);
        
        // Dynamic map rotation & interactions
        // Clicking on the minimap sets destination
        this.map.on('click', (e) => {
            this.setDestination(e.latlng.lng, e.latlng.lat);
        });
    }

    update() {
        const pos = this.vehicle.getLonLat();
        const headingDeg = Cesium.Math.toDegrees(this.vehicle.heading);
        
        // Center leaflet on car
        this.map.panTo([pos.lat, pos.lon], { animate: false });
        
        // Spin the minimap container to simulate head-up navigation
        const minimapEl = document.getElementById('minimap');
        minimapEl.style.transform = `rotate(${-headingDeg - 90}deg)`; // Adjust by 90 for map orientation
        
        // Adjust the center element to offset rotation visually
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
            }
        } catch (error) {
            console.error("OSRM Route Error: ", error);
        }
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
        this.destinationMarker = L.marker([dest[1], dest[0]], {
            icon: L.divIcon({
                className: 'dest-icon',
                html: '<div style="width: 15px; height: 15px; background: #ff00cc; border-radius: 50%; box-shadow: 0 0 10px #ff00cc;"></div>'
            })
        }).addTo(this.map);

        // 2. Draw 3D Route in Cesium
        const cesiumPoints = coordinates.map(c => Cesium.Cartesian3.fromDegrees(c[0], c[1], 1.0)); // slightly above flat ground
        
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
        }
        if (this.destinationMarker) {
            this.map.removeLayer(this.destinationMarker);
        }
        if (this.routePolylineCesium) {
            this.viewer.entities.remove(this.routePolylineCesium);
        }
    }
}
