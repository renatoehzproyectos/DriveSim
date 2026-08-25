class Controls {
    constructor() {
        this.input = {
            gas: false,
            brake: false,
            steering: 0 // -1 to 1
        };
        
        this.wheelState = {
            isRotating: false,
            startAngle: 0,
            currentRotation: 0,
            maxRotation: 450, // 1.25 turns
            touchId: null    // which finger is on the wheel
        };
        
        this.gasTouchId = null;
        this.brakeTouchId = null;
        
        this.initMobileControls();
        this.initKeyboardControls();
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
        });
        
        window.addEventListener('keyup', (e) => {
            switch(e.key.toLowerCase()) {
                case 'w': this.input.gas = false; break;
                case 's': this.input.brake = false; break;
                case 'a': if (this.input.steering < 0) this.input.steering = 0; break;
                case 'd': if (this.input.steering > 0) this.input.steering = 0; break;
            }
        });
    }

    getInput() {
        return this.input;
    }
}
