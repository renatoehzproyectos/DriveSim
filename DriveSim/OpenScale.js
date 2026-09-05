/**
 * OpenScale v1.9.1 — FPS first + cheap anti-pixelation
 * Dynamic resolution + optional light C2D present (only when scale is low)
 * <script src="./OpenScale.js"></script>
 */
(function (global) {
  "use strict";

  var CFG = {
    INITIAL_SCALE: 0.55,
    MIN_SCALE: 0.35,
    MAX_SCALE: 1.0,
    DYNAMIC_RESOLUTION: true,
    SHOW_OVERLAY: true,
    TARGET_MS: 18.0,
    COMFORT_MS: 22.0,
    PANIC_MS: 40.0,
    COARSE: 0.10,
    FINE: 0.05,
    QUANT: 0.05,
    HOLD_MS: 500,
    OSC_N: 8,
    // Quality without killing FPS
    CHEAP_SHARPEN: true,          // CSS filter on output (~0 ms)
    LIGHT_PRESENT: true,          // C2D drawImage when scale < threshold
    PRESENT_BELOW: 0.72,          // only present when sim is clearly lower
    PRESENT_MAX_MS: 2.5           // auto-disable present if too costly
  };

  function avg(a) {
    if (!a.length) return 16.7;
    var s = 0, i = 0;
    for (; i < a.length; i++) s += a[i];
    return s / a.length;
  }

  function OpenScale() {
    this.cfg = CFG;
    this.canvas = null;
    this.dW = 0; this.dH = 0; this.sW = 0; this.sH = 0;
    this.scale = CFG.INITIAL_SCALE;
    this.mode = "SEARCH";
    this.hist = [];
    this.dirs = [];
    this.lastT = 0;
    this.holdUntil = 0;
    this.zone = CFG.INITIAL_SCALE;
    this.noGain = 0;
    this.enabled = true;
    this.running = false;
    this.overlay = null;
    this.raf = 0;
    this.fps = 0;
    this.ft = 16.7;
    this.trend = 0;
    this.frames = 0;
    this.display = null;
    this.dctx = null;
    this.presentOn = false;
    this.presentAllowed = !!CFG.LIGHT_PRESENT;
    this.path = "css";
    this._onResize = this._onResize.bind(this);
    this._loop = this._loop.bind(this);
  }

  function findCanvas() {
    var list = document.querySelectorAll("canvas");
    var best = null, area = 0, i, c, a, gl;
    for (i = 0; i < list.length; i++) {
      c = list[i];
      if (c.id && c.id.indexOf("openscale") === 0) continue;
      a = (c.width || c.clientWidth) * (c.height || c.clientHeight);
      try {
        gl = c.getContext("webgl2") || c.getContext("webgl") || c.getContext("experimental-webgl");
      } catch (e) { gl = null; }
      if (gl && a >= area) { best = c; area = a; }
    }
    if (!best) {
      for (i = 0; i < list.length; i++) {
        if (!list[i].id || list[i].id.indexOf("openscale") !== 0) return list[i];
      }
    }
    return best;
  }

  OpenScale.prototype.start = function () {
    if (this.running) return this;
    var self = this, n = 0;
    function boot() {
      self.canvas = findCanvas();
      if (!self.canvas && n++ < 50) { setTimeout(boot, 60); return; }
      if (!self.canvas) return;
      self._setup();
      self.running = true;
      self.raf = requestAnimationFrame(self._loop);
    }
    boot();
    return this;
  };

  OpenScale.prototype.stop = function () {
    this.running = false;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    window.removeEventListener("resize", this._onResize);
    window.removeEventListener("orientationchange", this._onResize);
    this._teardownPresent();
    if (this.overlay && this.overlay.parentNode) this.overlay.parentNode.removeChild(this.overlay);
    this.overlay = null;
    if (this.canvas) this.canvas.style.opacity = "1";
    return this;
  };

  OpenScale.prototype.setScale = function (v) {
    this.scale = this._q(v);
    this.zone = this.scale;
    this.mode = "HOLD";
    this.holdUntil = performance.now() + this.cfg.HOLD_MS;
    this._apply();
    this._syncPresent();
    return this;
  };

  OpenScale.prototype.setQualityMode = function (m) {
    var p = {
      QUALITY: [0.7, 0.95, 0.8],
      BALANCED: [0.5, 0.8, 0.6],
      PERFORMANCE: [0.4, 0.65, 0.5],
      ULTRA_PERFORMANCE: [0.35, 0.55, 0.4],
      AUTO: [0.35, 1, 0.55]
    }[String(m || "AUTO").toUpperCase()] || [0.35, 1, 0.55];
    this.cfg.MIN_SCALE = p[0];
    this.cfg.MAX_SCALE = p[1];
    this.setScale(p[2]);
    return this;
  };

  OpenScale.prototype.getFPS = function () { return this.fps; };
  OpenScale.prototype.getResolution = function () {
    return {
      display: { width: this.dW, height: this.dH },
      simulation: { width: this.sW, height: this.sH },
      scale: this.scale,
      mode: this.mode,
      path: this.path
    };
  };

  OpenScale.prototype._q = function (s) {
    var q = this.cfg.QUANT;
    s = Math.round(s / q) * q;
    return Math.max(this.cfg.MIN_SCALE, Math.min(this.cfg.MAX_SCALE, Math.round(s * 100) / 100));
  };

  OpenScale.prototype._setup = function () {
    var c = this.canvas;
    c.style.opacity = "1";
    c.style.visibility = "visible";
    if (!c.style.width) c.style.width = "100%";
    if (!c.style.height) c.style.height = "100%";
    // Free anti-pixelation: slight sharpen/contrast on the visible surface
    if (this.cfg.CHEAP_SHARPEN) {
      c.style.filter = "contrast(1.06) saturate(1.1)";
    }
    this._updateDisp();
    this.scale = this.cfg.INITIAL_SCALE;
    this._apply();
    this._syncPresent();
    window.addEventListener("resize", this._onResize, { passive: true });
    window.addEventListener("orientationchange", this._onResize, { passive: true });
    c.addEventListener("webglcontextlost", function (e) { e.preventDefault(); }, false);
    var self = this;
    c.addEventListener("webglcontextrestored", function () { self._apply(); }, false);
    if (this.cfg.SHOW_OVERLAY) this._mkOverlay();
  };

  OpenScale.prototype._updateDisp = function () {
    var dpr = window.devicePixelRatio || 1;
    var w = this.canvas.clientWidth || window.innerWidth;
    var h = this.canvas.clientHeight || window.innerHeight;
    this.dW = Math.max(1, Math.round(w * dpr));
    this.dH = Math.max(1, Math.round(h * dpr));
  };

  OpenScale.prototype._apply = function () {
    if (!this.canvas) return;
    this.sW = Math.max(1, Math.round(this.dW * this.scale));
    this.sH = Math.max(1, Math.round(this.dH * this.scale));
    if (this.canvas.width !== this.sW || this.canvas.height !== this.sH) {
      this.canvas.width = this.sW;
      this.canvas.height = this.sH;
    }
    this.canvas.style.width = "100%";
    this.canvas.style.height = "100%";
    if (this.display) {
      var cssW = this.canvas.clientWidth || window.innerWidth;
      var cssH = this.canvas.clientHeight || window.innerHeight;
      if (this.display.width !== this.dW || this.display.height !== this.dH) {
        this.display.width = this.dW;
        this.display.height = this.dH;
      }
      this.display.style.width = cssW + "px";
      this.display.style.height = cssH + "px";
    }
  };

  OpenScale.prototype._onResize = function () {
    var self = this;
    clearTimeout(this._rt);
    this._rt = setTimeout(function () {
      self._updateDisp();
      self._apply();
      self._syncPresent();
    }, 80);
  };

  // --- Light present: better upscale than CSS alone, still cheap ---
  OpenScale.prototype._syncPresent = function () {
    var want = this.presentAllowed && this.cfg.LIGHT_PRESENT && this.scale < this.cfg.PRESENT_BELOW;
    if (want && !this.presentOn) this._setupPresent();
    else if (!want && this.presentOn) this._teardownPresent();
  };

  OpenScale.prototype._setupPresent = function () {
    if (!this.canvas || this.presentOn) return;
    try {
      var d = document.createElement("canvas");
      d.id = "openscale-display";
      d.style.cssText = "position:absolute;top:0;left:0;width:100%;height:100%;display:block;z-index:1;pointer-events:none;";
      if (this.cfg.CHEAP_SHARPEN) {
        d.style.filter = "contrast(1.08) saturate(1.12)";
      }
      var parent = this.canvas.parentNode || document.body;
      if (parent !== document.body) {
        var pos = getComputedStyle(parent).position;
        if (pos === "static") parent.style.position = "relative";
      }
      parent.insertBefore(d, this.canvas.nextSibling);
      this.canvas.style.position = "absolute";
      this.canvas.style.left = "0";
      this.canvas.style.top = "0";
      this.canvas.style.zIndex = "0";
      // keep opacity 1 until first successful draw
      this.display = d;
      this.dctx = d.getContext("2d", { alpha: false, desynchronized: true });
      if (!this.dctx) {
        this._teardownPresent();
        return;
      }
      this.dctx.imageSmoothingEnabled = true;
      if (this.dctx.imageSmoothingQuality) this.dctx.imageSmoothingQuality = "high";
      this.presentOn = true;
      this.path = "c2d-light";
      this._apply();
    } catch (e) {
      this.presentAllowed = false;
      this._teardownPresent();
    }
  };

  OpenScale.prototype._teardownPresent = function () {
    if (this.display && this.display.parentNode) this.display.parentNode.removeChild(this.display);
    this.display = null;
    this.dctx = null;
    this.presentOn = false;
    this.path = "css";
    if (this.canvas) {
      this.canvas.style.opacity = "1";
      this.canvas.style.zIndex = "";
      if (this.cfg.CHEAP_SHARPEN) {
        this.canvas.style.filter = "contrast(1.06) saturate(1.1)";
      } else {
        this.canvas.style.filter = "";
      }
    }
  };

  OpenScale.prototype._present = function () {
    if (!this.presentOn || !this.dctx || !this.canvas.width) return;
    var t0 = performance.now();
    try {
      this.dctx.imageSmoothingEnabled = true;
      if (this.dctx.imageSmoothingQuality) this.dctx.imageSmoothingQuality = "high";
      this.dctx.drawImage(this.canvas, 0, 0, this.display.width, this.display.height);
      if (this.canvas.style.opacity !== "0") this.canvas.style.opacity = "0";
      var cost = performance.now() - t0;
      // FPS priority: if present is expensive, kill it
      if (cost > this.cfg.PRESENT_MAX_MS && this.frames > 45) {
        this.presentAllowed = false;
        this._teardownPresent();
      }
    } catch (e) {
      this.presentAllowed = false;
      this._teardownPresent();
    }
  };

  OpenScale.prototype._pushDir = function (d) {
    this.dirs.push(d);
    if (this.dirs.length > this.cfg.OSC_N) this.dirs.shift();
  };

  OpenScale.prototype._osc = function () {
    var h = this.dirs, i, f = 0;
    if (h.length < 6) return false;
    for (i = 1; i < h.length; i++) if (h[i] !== h[i - 1]) f++;
    return f >= h.length - 2;
  };

  OpenScale.prototype._decide = function (now) {
    if (!this.cfg.DYNAMIC_RESOLUTION || !this.enabled) return;
    if (now < this.holdUntil) return;

    var ft = this.ft, trend = this.trend, scale = this.scale, cfg = this.cfg;

    if (ft > cfg.PANIC_MS) {
      this.mode = "EMERGENCY";
      var drop = this._q(scale - Math.max(cfg.COARSE, 0.12));
      if (drop < scale) {
        this._pushDir(-1);
        this.scale = drop;
        this.zone = drop;
        this.holdUntil = now + 250;
        this._apply();
        this._syncPresent();
      }
      return;
    }

    if (this.mode === "EMERGENCY" && (ft < cfg.COMFORT_MS || trend < -0.5)) {
      this.mode = "RECOVERY";
    }

    if (this._osc()) {
      this.mode = "HOLD";
      this.zone = scale;
      this.holdUntil = now + 1400;
      this.dirs = [];
      return;
    }

    if (this.mode === "HOLD") {
      if (Math.abs(scale - this.zone) <= 0.06 && ft <= cfg.COMFORT_MS && trend < 0.3) return;
      if (ft > cfg.COMFORT_MS + 4) this.mode = "SEARCH";
      else if (ft < cfg.TARGET_MS - 2) this.mode = "RECOVERY";
      else return;
    }

    if (this.noGain >= 4 && ft > cfg.COMFORT_MS) {
      this.mode = "HOLD";
      this.zone = scale;
      this.holdUntil = now + 2500;
      return;
    }

    var wantDown = ft > cfg.COMFORT_MS || (trend > 0.4 && ft > cfg.TARGET_MS);
    var wantUp = ft < cfg.TARGET_MS && (this.mode === "RECOVERY" || this.mode === "SEARCH" || trend < -0.3);
    var step = (this.mode === "RECOVERY" || this.mode === "EMERGENCY") ? cfg.COARSE : cfg.FINE;
    if (ft > cfg.COMFORT_MS + 8) step = cfg.COARSE;

    var next = scale;
    if (wantDown) {
      next = this._q(scale - step);
      if (next < scale) this._pushDir(-1);
    } else if (wantUp) {
      next = this._q(scale + step);
      if (next > scale) this._pushDir(1);
    }

    if (next !== scale) {
      var prevScale = scale;
      this.scale = next;
      this.holdUntil = now + cfg.HOLD_MS;
      this._apply();
      this._syncPresent();
      this._pending = { prevScale: prevScale, fps: this.fps, at: now };
      if (Math.abs(next - this.zone) < cfg.FINE) {
        this.zone = next;
        this.mode = "HOLD";
        this.holdUntil = now + 900;
      } else if (next < prevScale) this.mode = "SEARCH";
      else this.mode = "RECOVERY";
    } else if (ft <= cfg.COMFORT_MS && ft >= cfg.TARGET_MS - 2 && Math.abs(trend) < 0.2) {
      this.mode = "HOLD";
      this.zone = scale;
      this.holdUntil = now + 800;
    }
  };

  OpenScale.prototype._loop = function (now) {
    if (!this.running) return;

    if (this.lastT) {
      var d = now - this.lastT;
      if (d > 1 && d < 250) {
        this.hist.push(d);
        if (this.hist.length > 20) this.hist.shift();
        this.ft = avg(this.hist);
        this.fps = Math.round((1000 / this.ft) * 10) / 10;
        if (this.hist.length >= 8) {
          var a = 0, b = 0, i;
          for (i = 0; i < 4; i++) b += this.hist[this.hist.length - 1 - i];
          for (i = 4; i < 8; i++) a += this.hist[this.hist.length - 1 - i];
          this.trend = (b / 4 - a / 4);
        }
      }
    }
    this.lastT = now;
    this.frames++;

    if (this._pending && now - this._pending.at > 400) {
      if (this.scale < this._pending.prevScale) {
        if (this.fps < this._pending.fps + 2) this.noGain++;
        else this.noGain = 0;
      } else this.noGain = 0;
      this._pending = null;
    }

    this._decide(now);

    // Present AFTER decide — samples latest game frame when possible
    if (this.presentOn) this._present();

    if (this.overlay && (this.frames % 10) === 0) this._updOverlay();

    this.raf = requestAnimationFrame(this._loop);
  };

  OpenScale.prototype._mkOverlay = function () {
    var el = document.createElement("div");
    el.id = "openscale-overlay";
    el.style.cssText = "position:fixed;top:8px;right:8px;z-index:99999;background:rgba(0,0,0,0.82);color:#0ff;font:11px/1.35 monospace;padding:8px 10px;border-radius:6px;pointer-events:none;white-space:pre;";
    document.body.appendChild(el);
    this.overlay = el;
  };

  OpenScale.prototype._updOverlay = function () {
    this.overlay.textContent =
      "OpenScale v1.9.1\n" +
      "FPS: " + this.fps + "  ft: " + this.ft.toFixed(1) + "ms\n" +
      "Trend: " + (this.trend >= 0 ? "+" : "") + this.trend.toFixed(2) + "\n" +
      "Disp: " + this.dW + "x" + this.dH + "\n" +
      "Sim:  " + this.sW + "x" + this.sH + "\n" +
      "Scale: " + Math.round(this.scale * 100) + "%  Mode: " + this.mode + "\n" +
      "Path: " + this.path + (this.cfg.CHEAP_SHARPEN ? "+sharp" : "");
  };

  var instance = null;
  function autoStart() {
    if (instance) return;
    instance = new OpenScale();
    setTimeout(function () { instance.start(); }, 120);
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
    version: "1.9.1"
  };
})(typeof window !== "undefined" ? window : this);
