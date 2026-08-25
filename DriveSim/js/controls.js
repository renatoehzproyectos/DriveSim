class Controls {
    constructor() {
        this.mode = 'car'; // 'car' | 'airplane'

        this.input = {
            gas: false,
            brake: false,
            steering: 0 // -1 to 1
        };

        this.airplaneInput = {
            steer: 0,    // -1 (left) to 1 (right)
            pitch: 0,    // -1 (dive) to 1 (climb)
            throttle: 0.4 // 0 to 1, sticky (from vertical slider)
        };

        this.wheelState = {
            isRotating: false,
            startAngle: 0,
            currentRotation: 0,
            maxRotation: 450, // 1.25 turns
            touchId: null    // which finger is on the wheel
        };

        this.joystickState = {
            active: false,
            pointerId: null,
            radius: 48 // px, matches CSS joystick base/knob sizing
        };

        this.gasTouchId = null;
        this.brakeTouchId = null;

        this.initMobileControls();
        this.initKeyboardControls();
        this.initJoystick();
        this.initThrottleSlider();
    }

    /** Switch which control layer (car pedals/wheel vs airplane joystick/throttle) is active/visible. */
    setMode(mode) {
        if (mode !== 'car' && mode !== 'airplane') return;
        this.mode = mode;

        const carLayer = document.getElementById('controls-layer');
        const planeLayer = document.getElementById('airplane-controls-layer');
        if (carLayer) carLayer.classList.toggle('hidden', mode !== 'car');
        if (planeLayer) planeLayer.classList.toggle('hidden', mode !== 'airplane');

        // Reset transient state so nothing "sticks" from the previous mode
        this.input.gas = false;
        this.input.brake = false;
        this.input.steering = 0;
        this.airplaneInput.steer = 0;
        this.airplaneInput.pitch = 0;
        this._resetJoystickKnob();
    }

    initMobileControls() {
        const gasBtn = document.getElementById('gas-pedal');
        const brakeBtn = document.getElementById('brake-pedal');
        const wheel = document.getElementById('steering-wheel');
        const steeringContainer = document.getElementById('steering-container');
        
        // --- GAS (track touch identity so other fingers don't interfere) ---
        gasBtn.addEventListener('touchstart', (e) => {
            e.preventDefault();
            e.stopPropagation();
            const t = e.changedTouches[0];
            this.gasTouchId = t.identifier;
            this.input.gas = true;
        }, { passive: false });
        
        gasBtn.addEventListener('touchend', (e) => {
            e.preventDefault();
            e.stopPropagation();
            for (const t of e.changedTouches) {
                if (t.identifier === this.gasTouchId) {
                    this.gasTouchId = null;
                    this.input.gas = false;
                }
            }
        }, { passive: false });
        
        gasBtn.addEventListener('touchcancel', (e) => {
            this.gasTouchId = null;
            this.input.gas = false;
        });

        // --- BRAKE ---
        brakeBtn.addEventListener('touchstart', (e) => {
            e.preventDefault();
            e.stopPropagation();
            const t = e.changedTouches[0];
            this.brakeTouchId = t.identifier;
            this.input.brake = true;
        }, { passive: false });
        
        brakeBtn.addEventListener('touchend', (e) => {
            e.preventDefault();
            e.stopPropagation();
            for (const t of e.changedTouches) {
                if (t.identifier === this.brakeTouchId) {
                    this.brakeTouchId = null;
                    this.input.brake = false;
                }
            }
        }, { passive: false });
        
        brakeBtn.addEventListener('touchcancel', (e) => {
            this.brakeTouchId = null;
            this.input.brake = false;
        });
        
        // --- STEERING WHEEL (dedicated touch id) ---
        const getWheelTouch = (touches) => {
            if (this.wheelState.touchId === null) return null;
            for (let i = 0; i < touches.length; i++) {
                if (touches[i].identifier === this.wheelState.touchId) {
                    return touches[i];
                }
            }
            return null;
        };

        const handleWheelMove = (e) => {
            if (!this.wheelState.isRotating) return;
            const touch = getWheelTouch(e.touches);
            if (!touch) return;
            e.preventDefault();
            
            const rect = wheel.getBoundingClientRect();
            const centerX = rect.left + rect.width / 2;
            const centerY = rect.top + rect.height / 2;
            
            const angle = Math.atan2(touch.clientY - centerY, touch.clientX - centerX);
            let diff = angle - this.wheelState.startAngle;
            
            while (diff > Math.PI) diff -= Math.PI * 2;
            while (diff < -Math.PI) diff += Math.PI * 2;
            
            this.wheelState.currentRotation += Cesium.Math.toDegrees(diff);
            this.wheelState.currentRotation = Cesium.Math.clamp(
                this.wheelState.currentRotation, 
                -this.wheelState.maxRotation, 
                this.wheelState.maxRotation
            );
            
            this.wheelState.startAngle = angle;
            wheel.style.transform = `rotate(${this.wheelState.currentRotation}deg)`;
            this.input.steering = this.wheelState.currentRotation / this.wheelState.maxRotation;
        };

        const startWheel = (e) => {
            e.preventDefault();
            e.stopPropagation();
            // Prefer a new touch that isn't already on gas/brake
            let touch = null;
            for (const t of e.changedTouches) {
                if (t.identifier !== this.gasTouchId && t.identifier !== this.brakeTouchId) {
                    touch = t;
                    break;
                }
            }
            if (!touch) touch = e.changedTouches[0];
            
            const rect = wheel.getBoundingClientRect();
            const centerX = rect.left + rect.width / 2;
            const centerY = rect.top + rect.height / 2;
            
            this.wheelState.isRotating = true;
            this.wheelState.touchId = touch.identifier;
            this.wheelState.startAngle = Math.atan2(touch.clientY - centerY, touch.clientX - centerX);
        };

        const endWheel = (e) => {
            for (const t of e.changedTouches) {
                if (t.identifier === this.wheelState.touchId) {
                    this.wheelState.isRotating = false;
                    this.wheelState.touchId = null;
                    this.autoCenter();
                    break;
                }
            }
        };

        // Bind to both the wheel and its larger container for easier grab
        wheel.addEventListener('touchstart', startWheel, { passive: false });
        if (steeringContainer) {
            steeringContainer.addEventListener('touchstart', startWheel, { passive: false });
        }
        
        window.addEventListener('touchmove', handleWheelMove, { passive: false });
        window.addEventListener('touchend', endWheel, { passive: false });
        window.addEventListener('touchcancel', endWheel, { passive: false });
    }

    autoCenter() {
        if (this.wheelState.isRotating) return;
        
        if (Math.abs(this.wheelState.currentRotation) > 1) {
            this.wheelState.currentRotation *= 0.85;
            document.getElementById('steering-wheel').style.transform = `rotate(${this.wheelState.currentRotation}deg)`;
            this.input.steering = this.wheelState.currentRotation / this.wheelState.maxRotation;
            requestAnimationFrame(() => this.autoCenter());
        } else {
            this.wheelState.currentRotation = 0;
            this.input.steering = 0;
            document.getElementById('steering-wheel').style.transform = `rotate(0deg)`;
        }
    }

    initKeyboardControls() {
        window.addEventListener('keydown', (e) => {
            switch(e.key.toLowerCase()) {
                case 'w': this.input.gas = true; break;
                case 's': this.input.brake = true; break;
                case 'a': this.input.steering = -1; break;
                case 'd': this.input.steering = 1; break;
            }
            // Airplane keyboard fallback (desktop testing): arrow keys drive the
            // joystick axes directly; Up/Down on the throttle slider nudge it too.
            switch (e.key) {
                case 'ArrowLeft': this.airplaneInput.steer = -1; break;
                case 'ArrowRight': this.airplaneInput.steer = 1; break;
                case 'ArrowUp': this.airplaneInput.pitch = 1; break;
                case 'ArrowDown': this.airplaneInput.pitch = -1; break;
            }
        });
        
        window.addEventListener('keyup', (e) => {
            switch(e.key.toLowerCase()) {
                case 'w': this.input.gas = false; break;
                case 's': this.input.brake = false; break;
                case 'a': if (this.input.steering < 0) this.input.steering = 0; break;
                case 'd': if (this.input.steering > 0) this.input.steering = 0; break;
            }
            switch (e.key) {
                case 'ArrowLeft': if (this.airplaneInput.steer < 0) this.airplaneInput.steer = 0; break;
                case 'ArrowRight': if (this.airplaneInput.steer > 0) this.airplaneInput.steer = 0; break;
                case 'ArrowUp': if (this.airplaneInput.pitch > 0) this.airplaneInput.pitch = 0; break;
                case 'ArrowDown': if (this.airplaneInput.pitch < 0) this.airplaneInput.pitch = 0; break;
            }
        });
    }

    /** Two-axis joystick: X = steer (turn), Y = pitch (climb/dive). Self-centers on release. */
    initJoystick() {
        const base = document.getElementById('joystick-base');
        const knob = document.getElementById('joystick-knob');
        if (!base || !knob) return;

        const applyFromEvent = (clientX, clientY) => {
            const rect = base.getBoundingClientRect();
            const centerX = rect.left + rect.width / 2;
            const centerY = rect.top + rect.height / 2;
            let dx = clientX - centerX;
            let dy = clientY - centerY;

            const r = this.joystickState.radius;
            const dist = Math.sqrt(dx * dx + dy * dy);
            if (dist > r) {
                dx = (dx / dist) * r;
                dy = (dy / dist) * r;
            }

            knob.style.transform = `translate(${dx}px, ${dy}px)`;
            this.airplaneInput.steer = Cesium.Math.clamp(dx / r, -1, 1);
            this.airplaneInput.pitch = Cesium.Math.clamp(-dy / r, -1, 1); // up = climb (positive)
        };

        const start = (e) => {
            e.preventDefault();
            const t = e.touches ? e.touches[0] : e;
            this.joystickState.active = true;
            this.joystickState.pointerId = e.pointerId !== undefined ? e.pointerId : (e.touches ? t.identifier : 'mouse');
            applyFromEvent(t.clientX, t.clientY);
        };
        const move = (e) => {
            if (!this.joystickState.active) return;
            e.preventDefault();
            const t = e.touches ? [...e.touches].find(x => x.identifier === this.joystickState.pointerId) || e.touches[0] : e;
            applyFromEvent(t.clientX, t.clientY);
        };
        const end = () => {
            if (!this.joystickState.active) return;
            this.joystickState.active = false;
            this.joystickState.pointerId = null;
            this._resetJoystickKnob();
        };

        base.addEventListener('touchstart', start, { passive: false });
        window.addEventListener('touchmove', move, { passive: false });
        window.addEventListener('touchend', end, { passive: false });
        window.addEventListener('touchcancel', end, { passive: false });

        // Mouse support for desktop testing
        base.addEventListener('mousedown', start);
        window.addEventListener('mousemove', move);
        window.addEventListener('mouseup', end);
    }

    _resetJoystickKnob() {
        const knob = document.getElementById('joystick-knob');
        if (knob) knob.style.transform = 'translate(0px, 0px)';
        this.airplaneInput.steer = 0;
        this.airplaneInput.pitch = 0;
    }

    /** Vertical throttle slider — sticky, stays wherever it's left (like a real throttle). */
    initThrottleSlider() {
        const slider = document.getElementById('throttle-slider');
        const valueLabel = document.getElementById('throttle-value');
        if (!slider) return;

        this.airplaneInput.throttle = parseInt(slider.value, 10) / 100;
        slider.addEventListener('input', () => {
            const pct = parseInt(slider.value, 10);
            this.airplaneInput.throttle = pct / 100;
            if (valueLabel) valueLabel.textContent = `${pct}%`;
        });
    }

    getInput() {
        return this.input;
    }

    getAirplaneInput() {
        return this.airplaneInput;
    }
}
