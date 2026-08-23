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
        
        // Constants – 200 km/h top speed, linear acceleration, low drag
        this.maxSpeed = 55.56; // 200 km/h in m/s
        this.acceleration = 14; // m/s^2 – steady linear pull
        this.friction = 0.998;  // very low drag so speed climbs and holds easily
        this.braking = 40;
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
        // 0 = locked on car, 1 = tilted toward horizon
        this.cameraAimBias = 0;
        // FOV boost while accelerating
        this.fovBoostEnabled = false;
        this.baseFov = Cesium.Math.toRadians(60);
        this.maxFovBoost = Cesium.Math.toRadians(18); // up to ~78° when full throttle
        this.currentFov = this.baseFov;
        this._accelerating = false;
    }

    update(dt, input) {
        // Linear acceleration – gas adds speed, brake removes it
        this._accelerating = !!input.gas && this.velocity >= 0;
        if (input.gas) {
            this.velocity += this.acceleration * dt;
        }
        if (input.brake) {
            this.velocity -= this.braking * dt;
        }

        // Light coasting friction only when not on gas (keeps accel linear)
        if (!input.gas) {
            this.velocity *= this.friction;
        }

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
        // Distance scales with height so the vehicle stays framed at any zoom.
        const range = Math.max(15, this.cameraHeight * 2.2 + 10);
        const basePitchDeg = -Math.min(60, 15 + this.cameraHeight * 0.5);
        // AIM bias: 0 = look straight at car, 1 = lift pitch toward horizon + look ahead
        const bias = Cesium.Math.clamp(this.cameraAimBias, 0, 1);
        const pitch = Cesium.Math.toRadians(basePitchDeg + bias * 28); // raise pitch toward horizon

        // Look-at point: blend car position with a point ahead along heading
        // so horizon bias centers the view further down the road
        let target = this.position;
        if (bias > 0.001) {
            const metersPerDegreeLat = 111111;
            const metersPerDegreeLon = 111111 * Math.cos(Cesium.Math.toRadians(this.lat));
            const lookAhead = bias * (range * 0.55 + 12); // meters forward
            const dLat = (Math.cos(this.heading) * lookAhead) / metersPerDegreeLat;
            const dLon = (Math.sin(this.heading) * lookAhead) / metersPerDegreeLon;
            target = Cesium.Cartesian3.fromDegrees(
                this.lon + dLon,
                this.lat + dLat,
                this.height + bias * this.cameraHeight * 0.35
            );
        }

        this.viewer.camera.lookAt(
            target,
            new Cesium.HeadingPitchRange(this.heading, pitch, range)
        );
        this.viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);

        // Dynamic FOV: widen while accelerating when FOV+ is on
        const wantBoost = this.fovBoostEnabled && this._accelerating && this.velocity > 1;
        const targetFov = wantBoost
            ? this.baseFov + this.maxFovBoost * Math.min(1, this.velocity / this.maxSpeed)
            : this.baseFov;
        // Smooth lerp so it doesn't snap
        this.currentFov += (targetFov - this.currentFov) * 0.08;
        this.viewer.camera.frustum.fov = this.currentFov;
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
