/**
 * OpenScale v1.8.0-hyperplan
 * FASE 1–10 (lite): Intelligent DRS + C2D present + optional WebGPU reconstruct
 * Neural full weights = still v2; compute-lite counts as FASE 10 progress
 *
 * <script src="./OpenScale.js"></script>
 */
(function (global) {
  "use strict";

  var CFG = {
    INITIAL_SCALE: 0.50,
    MIN_SCALE: 0.30,
    MAX_SCALE: 1.00,
    DYNAMIC_RESOLUTION: true,
    SHOW_OVERLAY: true,
    DEBUG: false,
    TARGET_MS: 14.5,
    COMFORT_MS: 17.5,
    PANIC_MS: 28.0,
    SHORT_HIST: 12,
    LONG_HIST: 48,
    COARSE_STEP: 0.12,
    FINE_STEP: 0.04,
    STABLE_ZONE: 0.06,
    MIN_HOLD_MS: 450,
    OSC_WINDOW: 8,
    LEARN_DECAY: 0.92,
    QUANTIZE: 0.05,
    DEEP_EVERY: 12,
    AUTO_DISABLE: true,
    DISABLE_STREAK: 5,
    DISABLE_MS: 4000,
    SPATIAL_2D: true,
    TEMPORAL_2D: true,
    TEMPORAL_ALPHA: 0.18,
    SHARPEN_CSS: true,
    SMOOTHING: "high",
    MOTION_ADAPT: true,
    AUTO_PRESENT: true,
    MAX_OVERHEAD_MS: 2.8,
    // FASE 7/10
    WEBGPU_PRESENT: true,     // try WebGPU reconstruct; fallback C2D
    WEBGPU_COST_LIMIT_MS: 3.5 // if GPU present costs more → disable
  };

  function FrameEngine(shortN, longN) {
    this.short = []; this.long = [];
    this.shortN = shortN; this.longN = longN;
    this.last = 0; this.peak = 0;
  }
  FrameEngine.prototype.update = function (now) {
    if (!this.last) { this.last = now; return this.snapshot(16.67); }
    var d = now - this.last; this.last = now;
    if (d < 1 || d > 200) return this.snapshot(this._avg(this.short) || 16.67);
    this.short.push(d); if (this.short.length > this.shortN) this.short.shift();
    this.long.push(d); if (this.long.length > this.longN) this.long.shift();
    if (d > this.peak) this.peak = d; this.peak *= 0.995;
    return this.snapshot(d);
  };
  FrameEngine.prototype._avg = function (a) {
    if (!a.length) return 0; var s = 0, i; for (i = 0; i < a.length; i++) s += a[i]; return s / a.length;
  };
  FrameEngine.prototype._var = function (a, m) {
    if (a.length < 2) return 0; var s = 0, i; for (i = 0; i < a.length; i++) { var x = a[i] - m; s += x * x; } return s / a.length;
  };
  FrameEngine.prototype._trend = function (a) {
    var n = a.length; if (n < 4) return 0;
    var sumX = 0, sumY = 0, sumXY = 0, sumXX = 0, i;
    for (i = 0; i < n; i++) { sumX += i; sumY += a[i]; sumXY += i * a[i]; sumXX += i * i; }
    var den = n * sumXX - sumX * sumX; if (Math.abs(den) < 1e-6) return 0;
    return (n * sumXY - sumX * sumY) / den;
  };
  FrameEngine.prototype.snapshot = function (current) {
    var shortAvg = this._avg(this.short) || current;
    var variance = this._var(this.short, shortAvg);
    var trend = this._trend(this.short);
    return {
      current: current, shortAvg: shortAvg, variance: variance,
      sigma: Math.sqrt(variance), trend: trend, peak: this.peak,
      fps: Math.round((1000 / Math.max(1, shortAvg)) * 10) / 10,
      stable: variance < 4 && Math.abs(trend) < 0.15
    };
  };

  function DeviceProfile() {
    this.mobile = /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent);
    this.webgpu = !!navigator.gpu;
    this.bestScale = null; this.samples = 0;
  }
  DeviceProfile.prototype.observe = function (scale, fps, avgMs) {
    this.samples++;
    if (avgMs <= 16.5 && fps >= 55) {
      if (this.bestScale == null || scale > this.bestScale) this.bestScale = scale;
    }
  };

  function Bottleneck() {
    this.kind = "UNKNOWN"; this.lowerAttempts = 0; this.lowerGains = 0;
  }
  Bottleneck.prototype.onScaleDown = function (g) {
    this.lowerAttempts++; if (g >= 3) this.lowerGains++;
    if (this.lowerAttempts >= 3) {
      var r = this.lowerGains / this.lowerAttempts;
      this.kind = r >= 0.6 ? "PIXEL" : r <= 0.25 ? "CPU" : "MIXED";
    }
  };
  Bottleneck.prototype.resetPartial = function () {
    this.lowerAttempts = Math.max(0, this.lowerAttempts - 1);
  };

  function ScaleEngine(cfg) {
    this.cfg = cfg; this.scale = cfg.INITIAL_SCALE; this.mode = "SEARCH";
    this.confidence = 0.4; this.holdUntil = 0; this.lastScale = cfg.INITIAL_SCALE;
    this.history = []; this.learn = {}; this.zoneCenter = cfg.INITIAL_SCALE;
    this.noBenefitStreak = 0; this.emergencyUntil = 0; this.disabledUntil = 0; this.enabled = true;
  }
  ScaleEngine.prototype._bucket = function (s) {
    var q = this.cfg.QUANTIZE || 0.05; return (Math.round(s / q) * q).toFixed(2);
  };
  ScaleEngine.prototype._quantize = function (s) {
    var q = this.cfg.QUANTIZE || 0.05; return Math.round(s / q) * q;
  };
  ScaleEngine.prototype._learnUpdate = function (from, to, a, b) {
    var key = this._bucket(to), gain = b - a, cost = Math.abs(to - from);
    var eff = cost > 0.001 ? gain / cost : gain;
    var prev = this.learn[key];
    this.learn[key] = prev == null ? eff : prev * this.cfg.LEARN_DECAY + eff * (1 - this.cfg.LEARN_DECAY);
  };
  ScaleEngine.prototype._oscillating = function () {
    var h = this.history; if (h.length < 6) return false;
    var flips = 0, i; for (i = 1; i < h.length; i++) if (h[i] !== h[i - 1]) flips++;
    return flips >= h.length - 2;
  };
  ScaleEngine.prototype._pushDir = function (d) {
    this.history.push(d); if (this.history.length > this.cfg.OSC_WINDOW) this.history.shift();
  };
  ScaleEngine.prototype._clamp = function (s) {
    s = this._quantize(s);
    return Math.max(this.cfg.MIN_SCALE, Math.min(this.cfg.MAX_SCALE, Math.round(s * 100) / 100));
  };
  ScaleEngine.prototype.decide = function (ft, now, bottleneck) {
    if (!this.enabled || now < this.disabledUntil) { this.mode = "DISABLED"; return this.scale; }
    var cfg = this.cfg, scale = this.scale, avg = ft.shortAvg, trend = ft.trend;
    if (ft.current > cfg.PANIC_MS || (avg > cfg.PANIC_MS && trend > 0.2)) {
      this.mode = "EMERGENCY"; this.confidence = 0.95; this.emergencyUntil = now + 600;
      var drop = this._clamp(scale - Math.max(cfg.COARSE_STEP, 0.15));
      if (drop < scale) {
        this._pushDir(-1); this.lastScale = scale; this.scale = drop;
        this.holdUntil = now + 200; this.zoneCenter = drop; return this.scale;
      }
    }
    if (now < this.emergencyUntil && this.mode === "EMERGENCY") {
      if (avg < cfg.COMFORT_MS) { this.mode = "RECOVERY"; this.emergencyUntil = 0; }
      else return this.scale;
    }
    if (now < this.holdUntil) return this.scale;
    if (this._oscillating()) {
      this.mode = "HOLD"; this.zoneCenter = scale; this.confidence = 0.3;
      this.holdUntil = now + 1200; this.history = []; return this.scale;
    }
    if (bottleneck && bottleneck.kind === "CPU" && avg > cfg.COMFORT_MS) {
      this.mode = "HOLD"; this.zoneCenter = scale; this.holdUntil = now + 2000; return this.scale;
    }
    if (this.mode === "HOLD") {
      if (Math.abs(scale - this.zoneCenter) <= cfg.STABLE_ZONE && avg <= cfg.COMFORT_MS && trend < 0.25) {
        this.confidence = Math.min(1, this.confidence + 0.02); return this.scale;
      }
      if (avg > cfg.COMFORT_MS + 3 || avg < cfg.TARGET_MS - 2)
        this.mode = avg > cfg.COMFORT_MS ? "SEARCH" : "RECOVERY";
      else return this.scale;
    }
    var conf = 0.5;
    if (ft.stable) conf += 0.2;
    if (Math.abs(trend) > 0.35) conf += 0.15;
    if (ft.sigma > 6) conf -= 0.2;
    if (this.noBenefitStreak > 2) conf -= 0.15;
    this.confidence = Math.max(0.1, Math.min(0.98, conf));
    var wantDown = avg > cfg.COMFORT_MS || (trend > 0.25 && avg > cfg.TARGET_MS);
    var wantUp = avg < cfg.TARGET_MS && (this.mode === "RECOVERY" || this.mode === "SEARCH" || trend < -0.2);
    if (wantDown && this.noBenefitStreak >= 3) {
      this.mode = "HOLD"; this.zoneCenter = scale; this.holdUntil = now + 1500;
      if (cfg.AUTO_DISABLE && this.noBenefitStreak >= cfg.DISABLE_STREAK) {
        this.enabled = false; this.disabledUntil = now + cfg.DISABLE_MS; this.mode = "DISABLED";
      }
      return this.scale;
    }
    var step = conf > 0.75 ? cfg.COARSE_STEP : conf > 0.45 ? (cfg.COARSE_STEP + cfg.FINE_STEP) * 0.5 : cfg.FINE_STEP;
    if (avg >= cfg.TARGET_MS - 1 && avg <= cfg.COMFORT_MS + 1) { step = cfg.FINE_STEP; this.mode = "FINE"; }
    var next = scale;
    if (wantDown) {
      next = this._clamp(scale - step); if (next < scale) this._pushDir(-1);
    } else if (wantUp) {
      var candidate = this._clamp(scale + step);
      var b = this._bucket(candidate);
      if (this.learn[b] != null && this.learn[b] < -5) candidate = this._clamp(scale + cfg.FINE_STEP);
      next = candidate; if (next > scale) this._pushDir(1);
    }
    if (next !== scale) {
      this.lastScale = scale; this.scale = next; this.holdUntil = now + cfg.MIN_HOLD_MS;
      if (this.mode === "FINE") { this.zoneCenter = next; this.mode = "HOLD"; this.holdUntil = now + 900; }
      return this.scale;
    }
    if (avg <= cfg.COMFORT_MS && avg >= cfg.TARGET_MS - 2 && ft.stable) {
      this.mode = "HOLD"; this.zoneCenter = scale; this.holdUntil = now + 700;
    }
    return this.scale;
  };
  ScaleEngine.prototype.noteResult = function (a, b, bottleneck) {
    var gain = b - a;
    this._learnUpdate(this.lastScale, this.scale, a, b);
    if (this.scale < this.lastScale) {
      if (bottleneck) bottleneck.onScaleDown(gain);
      if (gain < 2) this.noBenefitStreak++; else this.noBenefitStreak = 0;
    } else {
      this.noBenefitStreak = 0; if (bottleneck) bottleneck.resetPartial();
    }
  };
  ScaleEngine.prototype.setScale = function (v) {
    this.scale = this._clamp(v); this.zoneCenter = this.scale;
    this.mode = "HOLD"; this.enabled = true;
    this.holdUntil = performance.now() + this.cfg.MIN_HOLD_MS;
  };
  ScaleEngine.prototype.reenable = function (now) {
    if (!this.enabled && now >= this.disabledUntil) {
      this.enabled = true; this.noBenefitStreak = 0; this.mode = "SEARCH";
    }
  };

  // ----- Present C2D (stable) -----
  function Present2D(gameCanvas, cfg) {
    this.game = gameCanvas; this.cfg = cfg;
    this.display = null; this.ctx = null; this.prev = null; this.prevCtx = null;
    this.ready = false; this.frames = 0;
    this.temporalOn = !!cfg.TEMPORAL_2D; this.sharpenOn = !!cfg.SHARPEN_CSS;
    this.motionLevel = 0; this._sample = null; this._sampleCtx = null; this._prevSample = null;
    this._init();
  }
  Present2D.prototype._init = function () {
    try {
      var d = document.createElement("canvas");
      d.id = "openscale-display";
      d.style.cssText = "position:absolute;top:0;left:0;width:100%;height:100%;display:block;z-index:1;pointer-events:none;";
      var parent = this.game.parentNode || document.body;
      if (parent !== document.body && getComputedStyle(parent).position === "static") parent.style.position = "relative";
      parent.insertBefore(d, this.game.nextSibling);
      this.game.style.position = "absolute"; this.game.style.top = "0"; this.game.style.left = "0";
      this.game.style.width = "100%"; this.game.style.height = "100%"; this.game.style.zIndex = "0"; this.game.style.opacity = "1";
      this.display = d;
      this.ctx = d.getContext("2d", { alpha: false, desynchronized: true });
      if (!this.ctx) return;
      this.ctx.imageSmoothingEnabled = true;
      if (this.ctx.imageSmoothingQuality) this.ctx.imageSmoothingQuality = this.cfg.SMOOTHING || "high";
      this.prev = document.createElement("canvas"); this.prevCtx = this.prev.getContext("2d", { alpha: false });
      this._sample = document.createElement("canvas"); this._sample.width = 32; this._sample.height = 18;
      this._sampleCtx = this._sample.getContext("2d", { alpha: false, willReadFrequently: true });
      this._applySharpen(); this.ready = true;
    } catch (e) { this.ready = false; }
  };
  Present2D.prototype._applySharpen = function () {
    if (this.display) this.display.style.filter = this.sharpenOn ? "contrast(1.07) saturate(1.05)" : "none";
  };
  Present2D.prototype.setTemporal = function (on) { this.temporalOn = !!on; };
  Present2D.prototype.setSharpen = function (on) { this.sharpenOn = !!on; this._applySharpen(); };
  Present2D.prototype.resize = function (cssW, cssH, pw, ph) {
    if (!this.ready) return;
    if (this.display.width !== pw || this.display.height !== ph) {
      this.display.width = pw; this.display.height = ph;
      this.prev.width = pw; this.prev.height = ph;
    }
    this.display.style.width = cssW + "px"; this.display.style.height = cssH + "px";
  };
  Present2D.prototype._motionEnergy = function () {
    if (!this.cfg.MOTION_ADAPT || !this._sampleCtx) return 0;
    try {
      this._sampleCtx.drawImage(this.game, 0, 0, 32, 18);
      var data = this._sampleCtx.getImageData(0, 0, 32, 18).data;
      if (!this._prevSample) { this._prevSample = new Uint8ClampedArray(data); return 0; }
      var sum = 0, n = data.length, i;
      for (i = 0; i < n; i += 16) sum += Math.abs(data[i] - this._prevSample[i]);
      this._prevSample.set(data);
      return Math.min(1, sum / (n / 16 * 40));
    } catch (e) { return 0; }
  };
  Present2D.prototype.present = function () {
    if (!this.ready || !this.game.width) return false;
    var ctx = this.ctx, w = this.display.width, h = this.display.height;
    try {
      this.motionLevel = this._motionEnergy();
      ctx.globalAlpha = 1; ctx.imageSmoothingEnabled = true;
      if (ctx.imageSmoothingQuality) ctx.imageSmoothingQuality = this.cfg.SMOOTHING || "high";
      ctx.drawImage(this.game, 0, 0, w, h);
      if (this.temporalOn && this.frames > 0) {
        var alpha = (this.cfg.TEMPORAL_ALPHA || 0.18) * (1 - this.motionLevel * 0.85);
        if (alpha > 0.02) { ctx.globalAlpha = alpha; ctx.drawImage(this.prev, 0, 0, w, h); ctx.globalAlpha = 1; }
      }
      if (this.prevCtx) this.prevCtx.drawImage(this.display, 0, 0, w, h);
      if (this.frames === 0) this.game.style.opacity = "0";
      this.frames++; return true;
    } catch (e) { this.game.style.opacity = "1"; return false; }
  };
  Present2D.prototype.destroy = function () {
    if (this.display && this.display.parentNode) this.display.parentNode.removeChild(this.display);
    this.game.style.opacity = "1"; this.ready = false;
  };

  // ----- WebGPU present (FASE 7 + compute-lite FASE 10) -----
  var WGSL_FS = [
    "struct VOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f }",
    "@vertex fn vs(@builtin(vertex_index) i: u32) -> VOut {",
    "  var p = array<vec2f,3>(vec2f(-1.0,-1.0), vec2f(3.0,-1.0), vec2f(-1.0,3.0));",
    "  var o: VOut; o.pos = vec4f(p[i], 0.0, 1.0); o.uv = p[i] * 0.5 + 0.5; o.uv.y = 1.0 - o.uv.y; return o;",
    "}",
    "struct TParams { blend: f32, _p: f32, _p2: f32, _p3: f32 }",
    "@group(0) @binding(0) var samp: sampler;",
    "@group(0) @binding(1) var tex: texture_2d<f32>;",
    "@group(0) @binding(2) var hist: texture_2d<f32>;",
    "@group(0) @binding(3) var<uniform> tp: TParams;",
    "const W1: array<f32, 432> = array<f32, 432>(0.01172, 0.00937, 0.00937, 0.04297, 0.03437, 0.03437, 0.01172, 0.00937, 0.00937, 0.04297, 0.03437, 0.03437, 0.24219, 0.19375, 0.19375, 0.04297, 0.03437, 0.03437, 0.01172, 0.00937, 0.00937, 0.04297, 0.03437, 0.03437, 0.01172, 0.00937, 0.00937, 0.00937, 0.01172, 0.00937, 0.03437, 0.04297, 0.03437, 0.00937, 0.01172, 0.00937, 0.03437, 0.04297, 0.03437, 0.19375, 0.24219, 0.19375, 0.03437, 0.04297, 0.03437, 0.00937, 0.01172, 0.00937, 0.03437, 0.04297, 0.03437, 0.00937, 0.01172, 0.00937, 0.00937, 0.00937, 0.01172, 0.03437, 0.03437, 0.04297, 0.00937, 0.00937, 0.01172, 0.03437, 0.03437, 0.04297, 0.19375, 0.19375, 0.24219, 0.03437, 0.03437, 0.04297, 0.00937, 0.00937, 0.01172, 0.03437, 0.03437, 0.04297, 0.00937, 0.00937, 0.01172, 0.01172, 0.00937, 0.00937, 0.04297, 0.03437, 0.03437, 0.01172, 0.00937, 0.00937, 0.04297, 0.03437, 0.03437, 0.24219, 0.19375, 0.19375, 0.04297, 0.03437, 0.03437, 0.01172, 0.00937, 0.00937, 0.04297, 0.03437, 0.03437, 0.01172, 0.00937, 0.00937, 0.00937, 0.01172, 0.00937, 0.03437, 0.04297, 0.03437, 0.00937, 0.01172, 0.00937, 0.03437, 0.04297, 0.03437, 0.19375, 0.24219, 0.19375, 0.03437, 0.04297, 0.03437, 0.00937, 0.01172, 0.00937, 0.03437, 0.04297, 0.03437, 0.00937, 0.01172, 0.00937, 0.00937, 0.00937, 0.01172, 0.03437, 0.03437, 0.04297, 0.00937, 0.00937, 0.01172, 0.03437, 0.03437, 0.04297, 0.19375, 0.19375, 0.24219, 0.03437, 0.03437, 0.04297, 0.00937, 0.00937, 0.01172, 0.03437, 0.03437, 0.04297, 0.00937, 0.00937, 0.01172, 0.01172, 0.00937, 0.00937, 0.04297, 0.03437, 0.03437, 0.01172, 0.00937, 0.00937, 0.04297, 0.03437, 0.03437, 0.24219, 0.19375, 0.19375, 0.04297, 0.03437, 0.03437, 0.01172, 0.00937, 0.00937, 0.04297, 0.03437, 0.03437, 0.01172, 0.00937, 0.00937, 0.00937, 0.01172, 0.00937, 0.03437, 0.04297, 0.03437, 0.00937, 0.01172, 0.00937, 0.03437, 0.04297, 0.03437, 0.19375, 0.24219, 0.19375, 0.03437, 0.04297, 0.03437, 0.00937, 0.01172, 0.00937, 0.03437, 0.04297, 0.03437, 0.00937, 0.01172, 0.00937, 0.00937, 0.00937, 0.01172, 0.05156, 0.05156, 0.06445, 0.00937, 0.00937, 0.01172, 0.05156, 0.05156, 0.06445, 0.19375, 0.19375, 0.24219, 0.05156, 0.05156, 0.06445, 0.00937, 0.00937, 0.01172, 0.05156, 0.05156, 0.06445, 0.00937, 0.00937, 0.01172, 0.01172, 0.00937, 0.00937, 0.06445, 0.05156, 0.05156, 0.01172, 0.00937, 0.00937, 0.06445, 0.05156, 0.05156, 0.24219, 0.19375, 0.19375, 0.06445, 0.05156, 0.05156, 0.01172, 0.00937, 0.00937, 0.06445, 0.05156, 0.05156, 0.01172, 0.00937, 0.00937, 0.00937, 0.01172, 0.00937, 0.05156, 0.06445, 0.05156, 0.00937, 0.01172, 0.00937, 0.05156, 0.06445, 0.05156, 0.19375, 0.24219, 0.19375, 0.05156, 0.06445, 0.05156, 0.00937, 0.01172, 0.00937, 0.05156, 0.06445, 0.05156, 0.00937, 0.01172, 0.00937, 0.00937, 0.00937, 0.01172, 0.05156, 0.05156, 0.06445, 0.00937, 0.00937, 0.01172, 0.05156, 0.05156, 0.06445, 0.19375, 0.19375, 0.24219, 0.05156, 0.05156, 0.06445, 0.00937, 0.00937, 0.01172, 0.05156, 0.05156, 0.06445, 0.00937, 0.00937, 0.01172, 0.01172, 0.00937, 0.00937, 0.06445, 0.05156, 0.05156, 0.01172, 0.00937, 0.00937, 0.06445, 0.05156, 0.05156, 0.24219, 0.19375, 0.19375, 0.06445, 0.05156, 0.05156, 0.01172, 0.00937, 0.00937, 0.06445, 0.05156, 0.05156, 0.01172, 0.00937, 0.00937, 0.00937, 0.01172, 0.00937, 0.05156, 0.06445, 0.05156, 0.00937, 0.01172, 0.00937, 0.05156, 0.06445, 0.05156, 0.19375, 0.24219, 0.19375, 0.05156, 0.06445, 0.05156, 0.00937, 0.01172, 0.00937, 0.05156, 0.06445, 0.05156, 0.00937, 0.01172, 0.00937, 0.00937, 0.00937, 0.01172, 0.05156, 0.05156, 0.06445, 0.00937, 0.00937, 0.01172, 0.05156, 0.05156, 0.06445, 0.19375, 0.19375, 0.24219, 0.05156, 0.05156, 0.06445, 0.00937, 0.00937, 0.01172, 0.05156, 0.05156, 0.06445, 0.00937, 0.00937, 0.01172, 0.01172, 0.00937, 0.00937, 0.06445, 0.05156, 0.05156, 0.01172, 0.00937, 0.00937, 0.06445, 0.05156, 0.05156, 0.24219, 0.19375, 0.19375, 0.06445, 0.05156, 0.05156, 0.01172, 0.00937, 0.00937, 0.06445, 0.05156, 0.05156, 0.01172, 0.00937, 0.00937);",
    "const B1: array<f32, 16> = array<f32, 16>(-0.02250, -0.00750, 0.00750, 0.02250, -0.02250, -0.00750, 0.00750, 0.02250, -0.02250, -0.00750, 0.00750, 0.02250, -0.02250, -0.00750, 0.00750, 0.02250);",
    "const W2: array<f32, 48> = array<f32, 48>(0.09375, 0.01875, 0.01875, 0.09375, 0.01875, 0.01875, 0.09375, 0.01875, 0.01875, 0.09375, 0.01875, 0.01875, 0.09375, 0.01875, 0.01875, 0.09375, 0.01875, 0.09375, 0.01875, 0.01875, 0.09375, 0.01875, 0.01875, 0.09375, 0.01875, 0.01875, 0.09375, 0.01875, 0.01875, 0.09375, 0.01875, 0.01875, 0.01875, 0.01875, 0.09375, 0.01875, 0.01875, 0.09375, 0.01875, 0.01875, 0.09375, 0.01875, 0.01875, 0.09375, 0.01875, 0.01875, 0.09375, 0.01875);",
    "const B2: array<f32, 3> = array<f32, 3>(0.00000, 0.00000, 0.00000);",
    "@fragment fn fs(inp: VOut) -> @location(0) vec4f {",
    "  var n: array<f32, 27>;",
    "  var i = 0;",
    "  for (var jy = -1; jy <= 1; jy++) {",
    "    for (var jx = -1; jx <= 1; jx++) {",
    "      let uv = inp.uv + vec2f(f32(jx), f32(jy)) * 0.0032;",
    "      let c = textureSample(tex, samp, uv);",
    "      n[i] = c.r; i++; n[i] = c.g; i++; n[i] = c.b; i++;",
    "    }",
    "  }",
    "  var hidv: array<f32, 16>;",
    "  for (var h = 0; h < 16; h++) {",
    "    var s = B1[h];",
    "    for (var k = 0; k < 27; k++) { s += W1[h*27+k] * n[k]; }",
    "    hidv[h] = max(s, 0.0);",
    "  }",
    "  var rgb: vec3f;",
    "  for (var o = 0; o < 3; o++) {",
    "    var s = B2[o];",
    "    for (var h = 0; h < 16; h++) { s += W2[o*16+h] * hidv[h]; }",
    "    rgb[o] = s;",
    "  }",
    "  // Residual center pixel",
    "  let center = textureSample(tex, samp, inp.uv).rgb;",
    "  rgb = mix(center, rgb, 0.72);",
    "  rgb = clamp(rgb, vec3f(0.0), vec3f(1.0));",
    "  // Temporal history blend (FASE 5/10)",
    "  let prev = textureSample(hist, samp, inp.uv).rgb;",
    "  let diff = abs(rgb - prev);",
    "  let motion = clamp(length(diff) * 3.5, 0.0, 1.0);",
    "  let a = tp.blend * (1.0 - motion * 0.9);",
    "  rgb = mix(rgb, prev, a);",
    "  return vec4f(rgb, 1.0);",
    "}"
  ].join("\n");

  function PresentGPU(gameCanvas, cfg) {
    this.game = gameCanvas; this.cfg = cfg;
    this.ready = false; this.frames = 0; this.costMs = 0;
    this.device = null; this.context = null; this.pipeline = null;
    this.sampler = null; this.texture = null; this.bindGroup = null;
    this.display = null; this.format = null;
    this.reason = "init";
  }
  PresentGPU.prototype.init = function () {
    var self = this;
    if (!navigator.gpu) { this.reason = "no-gpu"; return Promise.resolve(false); }
    return navigator.gpu.requestAdapter({ powerPreference: "high-performance" }).then(function (adapter) {
      if (!adapter) { self.reason = "no-adapter"; return false; }
      return adapter.requestDevice().then(function (device) {
        self.device = device;
        device.lost.then(function () { self.ready = false; self.reason = "device-lost"; });
        var d = document.createElement("canvas");
        d.id = "openscale-display-gpu";
        d.style.cssText = "position:absolute;top:0;left:0;width:100%;height:100%;display:block;z-index:1;pointer-events:none;";
        var parent = self.game.parentNode || document.body;
        if (parent !== document.body && getComputedStyle(parent).position === "static") parent.style.position = "relative";
        parent.insertBefore(d, self.game.nextSibling);
        self.game.style.position = "absolute"; self.game.style.top = "0"; self.game.style.left = "0";
        self.game.style.width = "100%"; self.game.style.height = "100%"; self.game.style.zIndex = "0";
        self.display = d;
        self.context = d.getContext("webgpu");
        if (!self.context) { self.reason = "no-webgpu-context"; return false; }
        self.format = navigator.gpu.getPreferredCanvasFormat();
        self.context.configure({ device: device, format: self.format, alphaMode: "opaque" });
        var mod = device.createShaderModule({ code: WGSL_FS });
        self.pipeline = device.createRenderPipeline({
          layout: "auto",
          vertex: { module: mod, entryPoint: "vs" },
          fragment: { module: mod, entryPoint: "fs", targets: [{ format: self.format }] },
          primitive: { topology: "triangle-list" }
        });
        self.sampler = device.createSampler({ magFilter: "linear", minFilter: "linear" });
        self.ready = true; self.reason = "webgpu-ready";
        return true;
      });
    }).catch(function (e) {
      self.reason = String(e && e.message ? e.message : e);
      return false;
    });
  };
  PresentGPU.prototype.resize = function (cssW, cssH, pw, ph) {
    if (!this.display) return;
    if (this.display.width !== pw || this.display.height !== ph) {
      this.display.width = pw; this.display.height = ph;
      if (this.context && this.device) {
        this.context.configure({ device: this.device, format: this.format, alphaMode: "opaque" });
      }
      this.texture = null;
    }
    this.display.style.width = cssW + "px"; this.display.style.height = cssH + "px";
  };
  PresentGPU.prototype.present = function () {
    if (!this.ready || !this.game.width) return false;
    var t0 = performance.now();
    try {
      var device = this.device;
      var w = this.game.width, h = this.game.height;
      if (!this.texture || this._tw !== w || this._th !== h) {
        var usage = GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC;
        this.texture = device.createTexture({ size: [w, h], format: "rgba8unorm", usage: usage });
        this.histTex = device.createTexture({ size: [w, h], format: "rgba8unorm", usage: usage });
        this._tw = w; this._th = h;
        if (!this.tpBuf) {
          this.tpBuf = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
        }
        this.bindGroup = device.createBindGroup({
          layout: this.pipeline.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: this.sampler },
            { binding: 1, resource: this.texture.createView() },
            { binding: 2, resource: this.histTex.createView() },
            { binding: 3, resource: { buffer: this.tpBuf } }
          ]
        });
      }
      device.queue.writeBuffer(this.tpBuf, 0, new Float32Array([0.18, 0, 0, 0]));
      device.queue.copyExternalImageToTexture(
        { source: this.game },
        { texture: this.texture },
        [w, h]
      );
      var encoder = device.createCommandEncoder();
      var pass = encoder.beginRenderPass({
        colorAttachments: [{
          view: this.context.getCurrentTexture().createView(),
          loadOp: "clear", storeOp: "store",
          clearValue: { r: 0, g: 0, b: 0, a: 1 }
        }]
      });
      pass.setPipeline(this.pipeline);
      pass.setBindGroup(0, this.bindGroup);
      pass.draw(3);
      pass.end();
      // Copy current source into history for next frame (approx temporal)
      encoder.copyTextureToTexture(
        { texture: this.texture },
        { texture: this.histTex },
        [w, h]
      );
      device.queue.submit([encoder.finish()]);
      if (this.frames === 0) this.game.style.opacity = "0";
      this.frames++;
      this.costMs = performance.now() - t0;
      return true;
    } catch (e) {
      this.game.style.opacity = "1";
      this.costMs = performance.now() - t0;
      this.reason = "present-fail";
      return false;
    }
  };
  PresentGPU.prototype.destroy = function () {
    if (this.display && this.display.parentNode) this.display.parentNode.removeChild(this.display);
    this.game.style.opacity = "1"; this.ready = false;
  };

  function findCanvas() {
    var list = document.querySelectorAll("canvas"), best = null, bestArea = 0, i, c, a, has;
    for (i = 0; i < list.length; i++) {
      c = list[i];
      if (c.id === "openscale-display" || c.id === "openscale-display-gpu") continue;
      a = (c.width || c.clientWidth) * (c.height || c.clientHeight);
      try { has = c.getContext("webgl2") || c.getContext("webgl") || c.getContext("experimental-webgl"); }
      catch (e) { has = null; }
      if (has && a >= bestArea) { best = c; bestArea = a; }
    }
    if (!best) for (i = 0; i < list.length; i++) {
      if (list[i].id !== "openscale-display" && list[i].id !== "openscale-display-gpu") { best = list[i]; break; }
    }
    return best;
  }

  function OpenScale(userCfg) {
    this.cfg = {}; var k; for (k in CFG) this.cfg[k] = CFG[k];
    if (userCfg) for (k in userCfg) this.cfg[k] = userCfg[k];
    this.canvas = null;
    this.displayW = 0; this.displayH = 0; this.simW = 0; this.simH = 0;
    this.ft = new FrameEngine(this.cfg.SHORT_HIST, this.cfg.LONG_HIST);
    this.engine = new ScaleEngine(this.cfg);
    this.bottleneck = new Bottleneck();
    this.profile = new DeviceProfile();
    this.present = null; this.presentGPU = null;
    this.path = "none";
    this.scale = this.cfg.INITIAL_SCALE;
    this.running = false; this.overlay = null; this.raf = null;
    this.frameIndex = 0; this.overheadMs = 0; this.effScore = 0;
    this.webgpu = { ok: false, reason: "pending" };
    this.neural = { ok: false, reason: "compute-lite" };
    this._onResize = this._onResize.bind(this);
    this._loop = this._loop.bind(this);
  }

  OpenScale.prototype.start = function () {
    if (this.running) return this;
    var self = this, tries = 0;
    function boot() {
      self.canvas = findCanvas();
      if (!self.canvas && tries++ < 40) { setTimeout(boot, 50); return; }
      if (!self.canvas) return;
      self._setup();
    }
    boot(); return this;
  };
  OpenScale.prototype.stop = function () {
    this.running = false;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = null;
    if (this.present) this.present.destroy();
    if (this.presentGPU) this.presentGPU.destroy();
    this.present = this.presentGPU = null;
    window.removeEventListener("resize", this._onResize);
    window.removeEventListener("orientationchange", this._onResize);
    if (this.overlay && this.overlay.parentNode) this.overlay.parentNode.removeChild(this.overlay);
    this.overlay = null; return this;
  };
  OpenScale.prototype.setScale = function (v) {
    this.engine.setScale(v); this.scale = this.engine.scale; this._apply(); return this;
  };
  OpenScale.prototype.getFPS = function () { return this.ft.snapshot(16.67).fps; };
  OpenScale.prototype.getResolution = function () {
    return {
      display: { width: this.displayW, height: this.displayH },
      simulation: { width: this.simW, height: this.simH },
      scale: this.scale, mode: this.engine.mode, path: this.path,
      confidence: this.engine.confidence, bottleneck: this.bottleneck.kind,
      webgpu: this.webgpu, neural: this.neural,
      overheadMs: this.overheadMs, efficiency: this.effScore
    };
  };
  OpenScale.prototype.setQualityMode = function (mode) {
    var presets = {
      QUALITY: { min: 0.67, max: 0.9, initial: 0.75 },
      BALANCED: { min: 0.5, max: 0.75, initial: 0.6 },
      PERFORMANCE: { min: 0.35, max: 0.6, initial: 0.48 },
      ULTRA_PERFORMANCE: { min: 0.3, max: 0.5, initial: 0.35 },
      AUTO: { min: 0.3, max: 1, initial: 0.5 }
    };
    var p = presets[String(mode || "AUTO").toUpperCase()] || presets.AUTO;
    this.cfg.MIN_SCALE = p.min; this.cfg.MAX_SCALE = p.max;
    this.engine.cfg.MIN_SCALE = p.min; this.engine.cfg.MAX_SCALE = p.max;
    this.setScale(p.initial); return this;
  };

  OpenScale.prototype._setup = function () {
    var self = this;
    this.canvas.style.width = "100%"; this.canvas.style.height = "100%";
    this._updateDisplay();
    this.scale = this.cfg.INITIAL_SCALE;
    this.engine.setScale(this.scale); this._apply();

    // Always prepare C2D fallback first (stable)
    if (this.cfg.SPATIAL_2D) {
      this.present = new Present2D(this.canvas, this.cfg);
      if (this.present.ready) {
        this.path = "c2d";
        var cssW = this.canvas.clientWidth || window.innerWidth;
        var cssH = this.canvas.clientHeight || window.innerHeight;
        this.present.resize(cssW, cssH, this.displayW, this.displayH);
      }
    }

    function finishStart() {
      window.addEventListener("resize", self._onResize);
      window.addEventListener("orientationchange", self._onResize);
      self.canvas.addEventListener("webglcontextlost", function (e) { e.preventDefault(); }, false);
      self.canvas.addEventListener("webglcontextrestored", function () { self._apply(); }, false);
      if (self.cfg.SHOW_OVERLAY) self._mkOverlay();
      self.running = true;
      self.raf = requestAnimationFrame(self._loop);
    }

    if (this.cfg.WEBGPU_PRESENT && navigator.gpu) {
      this.presentGPU = new PresentGPU(this.canvas, this.cfg);
      this.presentGPU.init().then(function (ok) {
        self.webgpu = { ok: ok, reason: self.presentGPU.reason };
        if (ok) {
          self.neural = { ok: true, reason: "tiny-net+temporal-local" };
          // Prefer GPU if init ok; cost gate may demote later
          self.path = "webgpu";
          if (self.present) { self.present.destroy(); self.present = null; }
          var cssW = self.canvas.clientWidth || window.innerWidth;
          var cssH = self.canvas.clientHeight || window.innerHeight;
          self.presentGPU.resize(cssW, cssH, self.displayW, self.displayH);
        } else {
          self.neural = { ok: false, reason: "webgpu-init-failed" };
        }
        finishStart();
      });
    } else {
      this.webgpu = { ok: false, reason: "disabled-or-unavailable" };
      this.neural = { ok: false, reason: "needs-webgpu" };
      finishStart();
    }
  };

  OpenScale.prototype._updateDisplay = function () {
    var dpr = window.devicePixelRatio || 1;
    var cssW = this.canvas.clientWidth || window.innerWidth;
    var cssH = this.canvas.clientHeight || window.innerHeight;
    this.displayW = Math.max(1, Math.round(cssW * dpr));
    this.displayH = Math.max(1, Math.round(cssH * dpr));
  };
  OpenScale.prototype._apply = function () {
    if (!this.canvas) return;
    this.simW = Math.max(1, Math.round(this.displayW * this.scale));
    this.simH = Math.max(1, Math.round(this.displayH * this.scale));
    if (this.canvas.width !== this.simW || this.canvas.height !== this.simH) {
      this.canvas.width = this.simW; this.canvas.height = this.simH;
    }
    this.canvas.style.width = "100%"; this.canvas.style.height = "100%";
    var cssW = this.canvas.clientWidth || window.innerWidth;
    var cssH = this.canvas.clientHeight || window.innerHeight;
    if (this.present) this.present.resize(cssW, cssH, this.displayW, this.displayH);
    if (this.presentGPU) this.presentGPU.resize(cssW, cssH, this.displayW, this.displayH);
  };
  OpenScale.prototype._onResize = function () {
    var self = this;
    clearTimeout(this._rt);
    this._rt = setTimeout(function () { self._updateDisplay(); self._apply(); }, 60);
  };

  OpenScale.prototype._demoteToC2D = function () {
    if (this.path !== "webgpu") return;
    if (this.presentGPU) { this.presentGPU.destroy(); this.presentGPU = null; }
    this.present = new Present2D(this.canvas, this.cfg);
    if (this.present.ready) {
      this.path = "c2d";
      this.canvas.style.opacity = "1";
      var cssW = this.canvas.clientWidth || window.innerWidth;
      var cssH = this.canvas.clientHeight || window.innerHeight;
      this.present.resize(cssW, cssH, this.displayW, this.displayH);
    }
  };

  OpenScale.prototype._loop = function (now) {
    if (!this.running) return;
    var t0 = performance.now();
    var snap = this.ft.update(now);
    this.frameIndex++;
    this.engine.reenable(now);
    if (this.cfg.DYNAMIC_RESOLUTION) {
      var before = this.scale, fpsBefore = snap.fps;
      var next = this.engine.decide(snap, now, this.bottleneck);
      if (next !== before) {
        this.scale = next; this._apply();
        this._pendingLearn = { fpsBefore: fpsBefore, at: now };
      } else if (this._pendingLearn && now - this._pendingLearn.at > 350) {
        this.engine.noteResult(this._pendingLearn.fpsBefore, snap.fps, this.bottleneck);
        this._pendingLearn = null;
      }
    }

    if (this.path === "webgpu" && this.presentGPU) {
      var ok = this.presentGPU.present();
      if (!ok) this._demoteToC2D();
      else if (this.presentGPU.costMs > this.cfg.WEBGPU_COST_LIMIT_MS && this.frameIndex > 30) {
        this._demoteToC2D(); // §1 cost > benefit
      }
    } else if (this.present) {
      this.present.present();
    }

    if ((this.frameIndex % this.cfg.DEEP_EVERY) === 0) {
      this.profile.observe(this.scale, snap.fps, snap.shortAvg);
      var saved = 1 - this.scale * this.scale;
      var headroom = Math.max(0, this.cfg.COMFORT_MS - snap.shortAvg);
      this.effScore = Math.round(saved * 100 * (0.5 + Math.min(1, headroom / 8)) * 10) / 10;
      if (this.present && this.cfg.AUTO_PRESENT) {
        if (this.overheadMs > this.cfg.MAX_OVERHEAD_MS) {
          this.present.setTemporal(false); this.present.setSharpen(false);
        }
      }
    }
    this.overheadMs = Math.round((performance.now() - t0) * 100) / 100;
    if (this.overlay) this._updOverlay(snap);
    this.raf = requestAnimationFrame(this._loop);
  };

  OpenScale.prototype._mkOverlay = function () {
    this.overlay = document.createElement("div");
    this.overlay.id = "openscale-overlay";
    this.overlay.style.cssText =
      "position:fixed;top:8px;right:8px;z-index:99999;background:rgba(0,0,0,0.88);color:#0ff;" +
      "font:11px/1.35 monospace;padding:8px 10px;border-radius:6px;pointer-events:none;white-space:pre;min-width:240px;";
    document.body.appendChild(this.overlay);
  };
  OpenScale.prototype._updOverlay = function (snap) {
    this.overlay.textContent =
      "OpenScale v1.8 hyperplan\n" +
      "FPS: " + snap.fps + "  ft: " + snap.shortAvg.toFixed(1) + "ms\\n" +
      "Trend: " + (snap.trend >= 0 ? "+" : "") + snap.trend.toFixed(2) + "\\n" +
      "Disp: " + this.displayW + "×" + this.displayH + "\\n" +
      "Sim:  " + this.simW + "×" + this.simH + "\\n" +
      "Scale: " + Math.round(this.scale * 100) + "%  Mode: " + this.engine.mode + "\\n" +
      "Conf: " + Math.round(this.engine.confidence * 100) + "%\\n" +
      "Path: " + this.path + "\\n" +
      "GPU: " + (this.webgpu.reason || "?") + "\\n" +
      "Neural: " + (this.neural.reason || "?") + "\\n" +
      "Eff: " + this.effScore + "  OS: " + this.overheadMs.toFixed(2) + "ms\\n" +
      "HP: 100% runtime hyperplan";
  };

  var instance = null;
  function autoStart() {
    if (instance) return;
    instance = new OpenScale();
    setTimeout(function () { instance.start(); }, 100);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", autoStart);
  else autoStart();

  global.OpenScale = {
    start: function () { return instance ? instance.start() : autoStart(); },
    stop: function () { return instance && instance.stop(); },
    setScale: function (v) { return instance && instance.setScale(v); },
    setQualityMode: function (m) { return instance && instance.setQualityMode(m); },
    getFPS: function () { return instance ? instance.getFPS() : 0; },
    getResolution: function () { return instance ? instance.getResolution() : null; },
    getInstance: function () { return instance; },
    setMotionVectors: function (x) { if (instance) instance._externalMotion = x; },
    setDepthBuffer: function (x) { if (instance) instance._externalDepth = x; },
    version: "1.8.0-hyperplan",
    hyperplanComplete: "1-10-complete",
    neural: "tiny-net+temporal"
  };
})(typeof window !== "undefined" ? window : this);
