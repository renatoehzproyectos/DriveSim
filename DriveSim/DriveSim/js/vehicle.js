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

        // Mode: 'car' (ground-clamped) or 'airplane' (free flight, Cesium only)
        this.mode = 'car';

        // ---- Car entity (existing glTF model) ----
        this.carEntity = viewer.entities.add({
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
        // Kept for backwards compatibility with anything referencing `vehicle.entity`
        this.entity = this.carEntity;

        // ---- Airplane entities (simple, hand-built "arcade" plane) ----
        // Fuselage + wings + tail fin, all sharing the plane's orientation
        // (heading/pitch/roll). Deliberately low-poly / cross-shaped for a
        // light, arcade look instead of a real glTF asset.
        const planeOrientation = new Cesium.CallbackProperty(() => {
            return Cesium.Transforms.headingPitchRollQuaternion(
                this.position,
                new Cesium.HeadingPitchRoll(this.heading - Math.PI / 2, this.planePitch, this.planeRoll)
            );
        }, false);
        const planePosition = new Cesium.CallbackProperty(() => this.position, false);
        // Small extra offset so the fin visually sits above the fuselage
        const finPosition = new Cesium.CallbackProperty(() => {
            return Cesium.Cartesian3.fromDegrees(this.lon, this.lat, this.height + 0.9);
        }, false);

        this.fuselageEntity = viewer.entities.add({
            position: planePosition,
            orientation: planeOrientation,
            box: {
                dimensions: new Cesium.Cartesian3(8.0, 1.1, 1.1),
                material: Cesium.Color.fromCssColorString('#e8f6ff'),
                outline: true,
                outlineColor: Cesium.Color.fromCssColorString('#00f3ff')
            }
        });
        this.wingsEntity = viewer.entities.add({
            position: planePosition,
            orientation: planeOrientation,
            box: {
                dimensions: new Cesium.Cartesian3(1.6, 11.0, 0.25),
                material: Cesium.Color.fromCssColorString('#00f3ff').withAlpha(0.9),
                outline: true,
                outlineColor: Cesium.Color.WHITE
            }
        });
        this.tailWingEntity = viewer.entities.add({
            position: planePosition,
            orientation: planeOrientation,
            box: {
                dimensions: new Cesium.Cartesian3(1.0, 4.0, 0.2),
                material: Cesium.Color.fromCssColorString('#ff00cc').withAlpha(0.9),
                outline: true,
                outlineColor: Cesium.Color.WHITE
            }
        });
        this.finEntity = viewer.entities.add({
            position: finPosition,
            orientation: planeOrientation,
            box: {
                dimensions: new Cesium.Cartesian3(1.6, 0.2, 1.8),
                material: Cesium.Color.fromCssColorString('#00ff66'),
                outline: true,
                outlineColor: Cesium.Color.WHITE
            }
        });
        this.airplaneEntities = [this.fuselageEntity, this.wingsEntity, this.tailWingEntity, this.finEntity];

        // All entities that "belong" to us, excluded from ground-height sampling
        // so the vehicle never samples its own roof/wings as terrain.
        this._selfEntities = [this.carEntity, ...this.airplaneEntities];

        this._syncEntityVisibility();

        // Camera setup – distance scales with height so vehicle stays centered
        this.cameraDistance = 25;
        this.cameraHeight = 8;
        // 0 = locked on vehicle, 1 = tilted toward horizon
        this.cameraAimBias = 0;
        // FOV boost while accelerating
        this.fovBoostEnabled = false;
        this.baseFov = Cesium.Math.toRadians(60);
        this.maxFovBoost = Cesium.Math.toRadians(18); // up to ~78° when full throttle
        this.currentFov = this.baseFov;
        this._accelerating = false;

        // Ground-clamping: periodically re-sample terrain/3D-tiles height,
        // then smoothly TWEEN toward it every frame instead of snapping.
        // This is also what fixes the "balloon drift" bug: sampleHeight()
        // used to pick up the vehicle's own model, ratcheting the height up
        // forever while idle. We now exclude our own entities from the sample.
        this.heightSampleIntervalMs = 200;
        this._heightSampleAccumMs = 0;
        this._heightSampling = false;
        this.groundHeight = 0;       // smoothed estimate, tweened each frame
        this.groundHeightTarget = 0; // raw last-sampled value
        this._groundSampleValid = false;

        // Arcade airplane flight state
        this.planeSpeed = 0;
        this.planeMinSpeed = 20;      // m/s, stall-proof arcade floor once airborne
        this.planeMaxSpeed = 100;     // m/s (~360 km/h)
        this.planeTurnSpeed = 1.0;    // rad/s at full steer
        this.planeClimbRate = 14;     // m/s at full-up pitch
        this.planeDiveRate = 22;      // m/s at full-down pitch
        this.planeMinClearance = 4;   // m above ground floor
        this.planePitch = 0;          // visual only
        this.planeRoll = 0;           // visual only
    }

    _syncEntityVisibility() {
        this.carEntity.show = this.mode === 'car';
        this.airplaneEntities.forEach(e => { e.show = this.mode === 'airplane'; });
    }

    /** Switch between 'car' and 'airplane'. No-op if already in that mode. */
    setMode(mode) {
        if (mode !== 'car' && mode !== 'airplane') return;
        if (this.mode === mode) return;
        this.mode = mode;
        this._syncEntityVisibility();

        if (mode === 'airplane') {
            // "Take off" – lift above current ground so it doesn't spawn clipped in
            this.planeSpeed = Math.max(this.planeMinSpeed, this.velocity);
            this.height = this.groundHeight + 40;
            this.planePitch = 0;
            this.planeRoll = 0;
        } else {
            // Landing is intentionally simple: drop back to ground clamp next frame
            this.velocity = Math.min(this.velocity, this.maxSpeed);
        }
        this.sampleGroundHeight();
    }

    update(dt, input) {
        // Ground-clamping: re-sample terrain height every heightSampleIntervalMs
        this._heightSampleAccumMs += dt * 1000;
        if (this._heightSampleAccumMs >= this.heightSampleIntervalMs) {
            this._heightSampleAccumMs = 0;
            this.sampleGroundHeight();
        }
        // Smoothly tween the ground estimate toward the last sample every frame
        // (framerate-independent exponential smoothing) so height never snaps/pops.
        const groundLerp = 1 - Math.exp(-dt * 6);
        this.groundHeight += (this.groundHeightTarget - this.groundHeight) * groundLerp;

        if (this.mode === 'airplane') {
            this._updateAirplane(dt, input);
        } else {
            this._updateCar(dt, input);
        }

        // Resolve new Cartesian position
        this.position = Cesium.Cartesian3.fromDegrees(this.lon, this.lat, this.height);

        // Update Camera
        this.updateCamera();

        // Speedometer UI
        document.getElementById('speed-value').innerText = Math.round(this.velocity * 3.6);
    }

    _updateCar(dt, input) {
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
            this.heading = ((this.heading % (Math.PI * 2)) + (Math.PI * 2)) % (Math.PI * 2);
        }

        this._moveAlongHeading(this.velocity * dt);

        // Car always sits on the (tweened) ground estimate – no snapping, no drift.
        this.height = this.groundHeight;
    }

    _updateAirplane(dt, input) {
        // input = { steer: -1..1, pitch: -1..1, throttle: 0..1 } from the joystick + vertical slider.
        // Throttle sets a target speed; actual speed eases toward it (arcade, no stall).
        const targetSpeed = this.planeMinSpeed + input.throttle * (this.planeMaxSpeed - this.planeMinSpeed);
        this.planeSpeed += (targetSpeed - this.planeSpeed) * Math.min(1, dt * 1.5);
        this.planeSpeed = Cesium.Math.clamp(this.planeSpeed, this.planeMinSpeed, this.planeMaxSpeed);
        this.velocity = this.planeSpeed;

        // Pitch axis directly drives climb/dive rate
        const climb = input.pitch >= 0
            ? input.pitch * this.planeClimbRate
            : input.pitch * this.planeDiveRate;
        this.height += climb * dt;

        // Never fly below ground
        const floor = this.groundHeight + this.planeMinClearance;
        if (this.height < floor) this.height = floor;

        // Turning (steer axis)
        this.heading += input.steer * this.planeTurnSpeed * dt;
        this.heading = ((this.heading % (Math.PI * 2)) + (Math.PI * 2)) % (Math.PI * 2);

        // Visual-only bank (roll) and pitch, smoothly eased toward targets
        const targetRoll = -input.steer * Cesium.Math.toRadians(35);
        const targetPitch = input.pitch * Cesium.Math.toRadians(14);
        const easeFactor = Math.min(1, dt * 4);
        this.planeRoll += (targetRoll - this.planeRoll) * easeFactor;
        this.planePitch += (targetPitch - this.planePitch) * easeFactor;

        this._moveAlongHeading(this.planeSpeed * dt);
    }

    _moveAlongHeading(moveStep) {
        // Earth radius approximation (WGS-84)
        const metersPerDegreeLat = 111111;
        const metersPerDegreeLon = 111111 * Math.cos(Cesium.Math.toRadians(this.lat));

        // Heading 0 = North → dLat = cos, dLon = sin
        const dLat = (Math.cos(this.heading) * moveStep) / metersPerDegreeLat;
        const dLon = (Math.sin(this.heading) * moveStep) / metersPerDegreeLon;

        this.lat += dLat;
        this.lon += dLon;
    }

    updateCamera() {
        // Distance scales with height so the vehicle stays framed at any zoom.
        const range = Math.max(15, this.cameraHeight * 2.2 + 10);
        const basePitchDeg = -Math.min(60, 15 + this.cameraHeight * 0.5);
        // AIM bias: 0 = look straight at vehicle, 1 = lift pitch toward horizon + look ahead
        const bias = Cesium.Math.clamp(this.cameraAimBias, 0, 1);
        const pitch = Cesium.Math.toRadians(basePitchDeg + bias * 28); // raise pitch toward horizon

        // Look-at point: blend vehicle position with a point ahead along heading
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

    /**
     * Samples the ground (terrain or 3D tiles) height under the vehicle.
     * Excludes our own entities so the vehicle never mistakes its own
     * model/wings for terrain (that ratcheting bug caused the "balloon" drift).
     * Result is stored as a target and smoothly tweened in update().
     */
    sampleGroundHeight() {
        if (this._heightSampling) return;
        const scene = this.viewer.scene;
        if (!scene || typeof scene.sampleHeight !== 'function' || !scene.sampleHeightSupported) return;

        this._heightSampling = true;
        try {
            const carto = Cesium.Cartographic.fromDegrees(this.lon, this.lat);
            const h = scene.sampleHeight(carto, this._selfEntities);
            if (typeof h === 'number' && isFinite(h)) {
                this.groundHeightTarget = h;
                if (!this._groundSampleValid) {
                    // First sample: snap immediately instead of tweening from 0
                    this.groundHeight = h;
                    this._groundSampleValid = true;
                }
            }
        } catch (e) {
            // Sampling can fail transiently while tiles are still loading — ignore.
        } finally {
            this._heightSampling = false;
        }
    }

    /** Instantly move vehicle to new coordinates and reset speed */
    teleport(lon, lat) {
        this.lon = lon;
        this.lat = lat;
        this.velocity = 0;
        this.planeSpeed = this.planeMinSpeed;
        this.position = Cesium.Cartesian3.fromDegrees(this.lon, this.lat, this.height);
        this.updateCamera();
        this.sampleGroundHeight();
        // Snap the smoothed ground estimate too, otherwise teleporting across
        // very different terrain would tween in from the old height.
        this.groundHeight = this.groundHeightTarget;
        if (this.mode === 'car') this.height = this.groundHeight;
    }
}
