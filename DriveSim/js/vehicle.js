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
        
        // Constants – 200 km/h top speed
        this.maxSpeed = 55.56; // 200 km/h in m/s
        this.acceleration = 18; // m/s^2 (slightly stronger for higher top speed)
        this.friction = 0.985;
        this.braking = 35;
        this.turnSpeed = 1.6;
        
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
        
        // Camera setup – distance scales with height so car stays centered
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
        // Always keep the car as the exact look-at target.
        // Distance scales with height so the vehicle stays centered at any zoom.
        const range = Math.max(15, this.cameraHeight * 2.2 + 10);
        const pitch = Cesium.Math.toRadians(-Math.min(60, 15 + this.cameraHeight * 0.5));

        // lookAt keeps the target (car) locked in the center of the view
        this.viewer.camera.lookAt(
            this.position,
            new Cesium.HeadingPitchRange(this.heading, pitch, range)
        );

        // Immediately unlock the transform so the next frame can move freely
        this.viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
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
