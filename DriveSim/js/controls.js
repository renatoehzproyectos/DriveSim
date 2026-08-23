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
            maxRotation: 450 // 1.25 turns
        };
        
        this.initMobileControls();
        this.initKeyboardControls();
    }

    initMobileControls() {
        const gasBtn = document.getElementById('gas-pedal');
        const brakeBtn = document.getElementById('brake-pedal');
        const wheel = document.getElementById('steering-wheel');
        
        // Gas
        gasBtn.addEventListener('touchstart', (e) => { e.preventDefault(); this.input.gas = true; });
        gasBtn.addEventListener('touchend', () => { this.input.gas = false; });
        
        // Brake
        brakeBtn.addEventListener('touchstart', (e) => { e.preventDefault(); this.input.brake = true; });
        brakeBtn.addEventListener('touchend', () => { this.input.brake = false; });
        
        // Steering Wheel Logic
        const handleWheel = (e) => {
            if (!this.wheelState.isRotating) return;
            e.preventDefault();
            
            const touch = e.touches[0];
            const rect = wheel.getBoundingClientRect();
            const centerX = rect.left + rect.width / 2;
            const centerY = rect.top + rect.height / 2;
            
            const angle = Math.atan2(touch.clientY - centerY, touch.clientX - centerX);
            let diff = angle - this.wheelState.startAngle;
            
            // Normalize diff
            while (diff > Math.PI) diff -= Math.PI * 2;
            while (diff < -Math.PI) diff += Math.PI * 2;
            
            this.wheelState.currentRotation += Cesium.Math.toDegrees(diff);
            this.wheelState.currentRotation = Cesium.Math.clamp(
                this.wheelState.currentRotation, 
                -this.wheelState.maxRotation, 
                this.wheelState.maxRotation
            );
            
            this.wheelState.startAngle = angle;
            
            // Apply visual rotation
            wheel.style.transform = `rotate(${this.wheelState.currentRotation}deg)`;
            
            // Map to -1 to 1 steering
            this.input.steering = this.wheelState.currentRotation / this.wheelState.maxRotation;
        };

        wheel.addEventListener('touchstart', (e) => {
            const touch = e.touches[0];
            const rect = wheel.getBoundingClientRect();
            const centerX = rect.left + rect.width / 2;
            const centerY = rect.top + rect.height / 2;
            
            this.wheelState.isRotating = true;
            this.wheelState.startAngle = Math.atan2(touch.clientY - centerY, touch.clientX - centerX);
        });

        window.addEventListener('touchmove', handleWheel, { passive: false });
        window.addEventListener('touchend', () => {
            this.wheelState.isRotating = false;
            // Auto-center wheel (optional, lets make it feel like a real wheel)
            this.autoCenter();
        });
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
