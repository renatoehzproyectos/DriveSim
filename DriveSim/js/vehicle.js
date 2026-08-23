class Vehicle {
    constructor(viewer) {
        this.viewer = viewer;
        
        // Geodetic State (San Francisco Start)
        this.lon = -122.4194;
        this.lat = 37.7749;
        this.height = 0;
        
        this.position = Cesium.Cartesian3.fromDegrees(this.lon, this.lat, this.height);
        // Heading convention: 0 = North, positive clockwise (matches Cesium HPR)
        // East = PI/2, South = PI, West = 3*PI/2
        this.heading = 0;
        this.velocity = 0; // m/s
        this.steering = 0; // -1 to 1
        
        // Constants
        this.maxSpeed = 40; // ~144 km/h
        this.acceleration = 15; // m/s^2
        this.friction = 0.98;
        this.braking = 30;
        this.turnSpeed = 1.5;
        
        // Entity
        this.entity = viewer.entities.add({
            position: new Cesium.CallbackProperty(() => this.position, false),
            orientation: new Cesium.CallbackProperty(() => {
                return Cesium.Transforms.headingPitchRollQuaternion(
                    this.position,
                    new Cesium.HeadingPitchRoll(this.heading - Math.PI / 2, 0, 0)
                );
            }, false),
            model: {
                uri: 'https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Models/master/2.0/CesiumMilkTruck/glTF/CesiumMilkTruck.gltf',
                minimumPixelSize: 64,
                maximumScale: 20000
            }
        });
        
        // Camera setup
        this.cameraDistance = 25;
        this.cameraHeight = 8;
    }

    update(dt, input) {
        // Apply Physics
        if (input.gas) {
            this.velocity += this.acceleration * dt;
        }
        if (input.brake) {
            this.velocity -= this.braking * dt;
        }
        
        // Friction & Limits
        this.velocity *= this.friction;
        if (Math.abs(this.velocity) < 0.1) this.velocity = 0;
        this.velocity = Cesium.Math.clamp(this.velocity, -10, this.maxSpeed);
        
        // Steering (only when moving)
        if (Math.abs(this.velocity) > 0.1) {
            this.heading += input.steering * this.turnSpeed * dt * (this.velocity > 0 ? 1 : -1);
            // Normalize heading to [0, 2PI)
            this.heading = ((this.heading % (Math.PI * 2)) + (Math.PI * 2)) % (Math.PI * 2);
        }
        
        // Calculate Displacement in meters
        const moveStep = this.velocity * dt;
        
        // Earth radius approximation (WGS-84)
        const metersPerDegreeLat = 111111;
        const metersPerDegreeLon = 111111 * Math.cos(Cesium.Math.toRadians(this.lat));
        
        // Heading 0 = North → dLat = cos, dLon = sin
        const dLat = (Math.cos(this.heading) * moveStep) / metersPerDegreeLat;
        const dLon = (Math.sin(this.heading) * moveStep) / metersPerDegreeLon;
        
        // Update Lon/Lat
        this.lat += dLat;
        this.lon += dLon;
        
        // Resolve new Cartesian position
        this.position = Cesium.Cartesian3.fromDegrees(this.lon, this.lat, this.height);
        
        // Update Camera
        this.updateCamera();
        
        // Speedometer UI
        document.getElementById('speed-value').innerText = Math.round(this.velocity * 3.6);
    }

    updateCamera() {
        // Place camera behind the vehicle; height is controlled by the top-left slider.
        // Always keep the car as the visual center (look-at the vehicle).
        const backHeading = this.heading + Math.PI;
        
        const metersPerDegreeLat = 111111;
        const metersPerDegreeLon = 111111 * Math.cos(Cesium.Math.toRadians(this.lat));
        
        const camLat = this.lat + (Math.cos(backHeading) * this.cameraDistance) / metersPerDegreeLat;
        const camLon = this.lon + (Math.sin(backHeading) * this.cameraDistance) / metersPerDegreeLon;
        
        const cameraPos = Cesium.Cartesian3.fromDegrees(camLon, camLat, this.height + this.cameraHeight);
        
        // Dynamic pitch so the car stays centered in the frame regardless of camera height
        // Higher camera → steeper look-down angle
        const pitchDeg = -Math.min(45, 8 + this.cameraHeight * 0.6);
        
        this.viewer.camera.setView({
            destination: cameraPos,
            orientation: {
                heading: this.heading,
                pitch: Cesium.Math.toRadians(pitchDeg),
                roll: 0
            }
        });
    }
    
    getLonLat() {
        return { lon: this.lon, lat: this.lat };
    }

    /** Instantly move vehicle to new coordinates and reset speed */
    teleport(lon, lat) {
        this.lon = lon;
        this.lat = lat;
        this.velocity = 0;
        this.position = Cesium.Cartesian3.fromDegrees(this.lon, this.lat, this.height);
        this.updateCamera();
    }
}
