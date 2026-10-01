/*
  "The chirp": state, controls, the 2D panels (strain diagram, light curve),
  sound, and the frame loop. The 3D orbit view lives in inspiral-3d.js and
  plugs in through window.Chirp.registerView(); if it never loads, everything
  here still works.
*/
(function () {
  'use strict';
  var P = window.SMBHB;
  if (!P) return;
  var YR = P.YR, DAY = P.DAY;
  function $(id) { return document.getElementById(id); }

  // ---------------------------------------------------------------- config
  var INSPIRAL_SECONDS = 16;       // display seconds from 10 Myr before merger to merger
  var MERGER_HOLD = 3.6;           // display seconds of merger + ringdown before restarting
  var TAU_START = 1e7 * YR;        // every system starts 10 Myr before ISCO
  var R0 = 3.6, REND = 1.2;        // on-screen orbit radius at the start and at ISCO (3D units)
  var W0 = 0.36, WEXP = 2.2;       // on-screen orbital frequency (rev/s) at start, growth exponent
  var OMEGA_END = W0 * Math.pow(REND / R0, -WEXP);
  var AUDIO_LO = 60, AUDIO_HI = 1000;
  var PRESETS = {
    pta: { m1: 5e8, m2: 2e8, d: 500 },      // smbhb-inspiral PTA reference system
    gap: { m1: 4e7, m2: 2e7, d: 500 },
    lisa: { m1: 2e6, m2: 1e6, d: 5000 }     // smbhb-inspiral LISA reference system
  };

  var mqReduce = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : { matches: false };
  var reduced = !!mqReduce.matches;

  var S = {
    m1: 5e8, m2: 2e8, d: 500, preset: 'pta',
    sys: null, track: null,
    p: 0, stage: 'inspiral', mergeAge: 0,
    playing: false, clock: 0, ang: 0, resync: true,
    f: 0, tau: 0, u: 0, band: 'pta',
    ghosts: [], lcRange: 0.4
  };

  // ---------------------------------------------------------------- formatting
  var SUP = { '-': '⁻', '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴', '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹' };
  function sup(n) { return String(n).split('').map(function (c) { return SUP[c] || c; }).join(''); }
  function sci(x, digits) {
    if (digits == null) digits = 1;
    var e = Math.floor(Math.log10(x));
    var m = +(x / Math.pow(10, e)).toFixed(digits);
    if (m >= 10) { m /= 10; e += 1; }
    return m.toFixed(digits) + ' × 10' + sup(e);
  }
  function sig(x, n) {
    if (n == null) n = 2;
    if (!isFinite(x) || x === 0) return '0';
    var e = Math.floor(Math.log10(Math.abs(x)));
    var dec = Math.max(0, n - 1 - e);
    var r = Number(x.toPrecision(n));
    return r.toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec });
  }
  function fmtTime(sec, n) {
    var yr = sec / YR;
    if (yr >= 1e6) return sig(yr / 1e6, n) + ' million years';
    if (yr >= 2) return sig(yr, n) + ' years';
    var d = sec / DAY;
    if (d >= 2) return sig(d, n) + ' days';
    var h = sec / 3600;
    if (h >= 2) return sig(h, n) + ' hours';
    var m = sec / 60;
    if (m >= 2) return sig(m, n) + ' minutes';
    return sig(sec, n) + ' seconds';
  }
  function fmtFreq(f) {
    if (f < 1e-6) return sig(f * 1e9) + ' nHz';
    if (f < 1e-3) return sig(f * 1e6) + ' μHz';
    if (f < 1) return sig(f * 1e3) + ' mHz';
    return sig(f) + ' Hz';
  }
  function fmtSep(a) {
    var pc = a / P.PC;
    if (pc >= 0.01) return sig(pc) + ' pc';
    return sig(a / P.AU) + ' AU';
  }
  function fmtV(v) { return (v < 0.1 ? sig(v) : v.toFixed(2)) + ' c'; }
  function fmtMass(m) { return sci(m) + ' M☉'; }
  function fmtDist(d) { return d >= 1000 ? sig(d / 1000) + ' Gpc' : sig(d) + ' Mpc'; }
  function massWords(m) { return sci(m) + ' solar masses'; }

  // ---------------------------------------------------------------- physics state
  function buildSystem() {
    S.sys = P.buildInspiral(S.m1, S.m2, { tauStart: TAU_START, pn: 1 });
    S.track = makeTrack(S.sys, S.d);
  }

  function makeTrack(sys, d) {
    var n = 320, pts = [];
    var l0 = Math.log(sys.fStart), l1 = Math.log(sys.fIsco);
    for (var i = 0; i < n; i++) {
      var f = Math.exp(l0 + (l1 - l0) * i / (n - 1));
      pts.push({ f: f, hc: P.hcAnalytic(f, sys.mc, d), v: P.vOverC(sys.M, f) });
    }
    return { pts: pts, M: sys.M, d: d, m1: sys.m1, m2: sys.m2 };
  }

  function updateState() {
    var sys = S.sys;
    if (S.stage === 'merger') {
      S.f = sys.fIsco; S.tau = 0; S.u = 1;
    } else {
      S.tau = Math.exp(sys.lnTauStart + S.p * (sys.lnTauEnd - sys.lnTauStart));
      S.f = sys.fAtTau(S.tau);
      S.u = Math.min(1, Math.max(0, Math.log(S.f / sys.fStart) / Math.log(sys.fIsco / sys.fStart)));
    }
  }

  function visual() {
    var r = R0 * Math.pow(REND / R0, S.u);
    var omega = W0 * Math.pow(r / R0, -WEXP);
    return { r: r, omega: omega, amp: Math.pow(omega / OMEGA_END, 0.9) };
  }

  // ---------------------------------------------------------------- DOM refs
  var el = {
    instrument: $('instrument'), stage: $('orbit-stage'), fallback: $('orbit-fallback'), fallbackText: $('orbit-fallback-text'),
    pill: $('band-pill'), bandText: $('band-text'), hint: $('drag-hint'),
    clock: $('clock-value'), sf: $('stat-f'), sp: $('stat-p'), sa: $('stat-a'), sv: $('stat-v'),
    scrub: $('scrub'), ticks: $('ticks'),
    play: $('btn-play'), restart: $('btn-restart'), sound: $('btn-sound'),
    m1: $('m1'), m2: $('m2'), dist: $('dist'), m1o: $('m1-out'), m2o: $('m2-out'), disto: $('dist-out'),
    soundNote: $('sound-note'), verdict: $('verdict'),
    strain: $('strain'), light: $('lightcurve'), lcStatus: $('lc-status'), lcNote: $('lc-note'),
    announcer: $('announcer')
  };
  var presetButtons = Array.prototype.slice.call(document.querySelectorAll('[data-preset]'));

  var SANS = (getComputedStyle(document.body).getPropertyValue('--sans') || 'system-ui, sans-serif').trim();
  var SERIF = (getComputedStyle(document.body).getPropertyValue('--serif') || 'Georgia, serif').trim();
  // Band colours from the instrument palette (play.css, site.css), read once; they don't
  // change with the theme. Second argument = fallback.
  var TOK_CS = getComputedStyle(document.body);
  function tok(name, fallback) { return (TOK_CS.getPropertyValue(name) || '').trim() || fallback; }
  function rgbOf(hex, fallback) {
    var m = /^#?([0-9a-f]{6})$/i.exec(hex);
    if (!m) return fallback;
    var n = parseInt(m[1], 16);
    return (n >> 16) + ',' + ((n >> 8) & 255) + ',' + (n & 255);
  }
  var PTA_RGB = rgbOf(tok('--inst-amber', '#eba862'), '235,168,98');
  var LISA_RGB = rgbOf(tok('--inst-teal', '#5fc8b9'), '95,200,185');
  function pta(a) { return 'rgba(' + PTA_RGB + ',' + a + ')'; }
  function lisa(a) { return 'rgba(' + LISA_RGB + ',' + a + ')'; }

  // ---------------------------------------------------------------- canvas helper
  function fitCanvas(cv) {
    var r = cv.getBoundingClientRect();
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var w = Math.max(1, Math.round(r.width * dpr)), h = Math.max(1, Math.round(r.height * dpr));
    if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; return { w: w, h: h, dpr: dpr, changed: true }; }
    return { w: w, h: h, dpr: dpr, changed: false };
  }

  // ---------------------------------------------------------------- strain diagram
  var XMIN = -10, XMAX = 0, YMIN = -22, YMAX = -10;
  var INFERNO = [[0, [86, 26, 118]], [0.25, [150, 44, 128]], [0.5, [224, 78, 100]], [0.75, [253, 160, 98]], [1, [252, 246, 186]]];
  function inferno(t) {
    t = Math.max(0, Math.min(1, t));
    for (var i = 0; i < INFERNO.length - 1; i++) {
      var a = INFERNO[i], b = INFERNO[i + 1];
      if (t <= b[0]) {
        var w = (t - a[0]) / (b[0] - a[0]);
        return [a[1][0] + w * (b[1][0] - a[1][0]), a[1][1] + w * (b[1][1] - a[1][1]), a[1][2] + w * (b[1][2] - a[1][2])];
      }
    }
    return INFERNO[INFERNO.length - 1][1];
  }
  function vcolor(v, alpha) {
    var c = inferno(Math.pow(v / 0.4082, 0.8));
    return 'rgba(' + (c[0] | 0) + ',' + (c[1] | 0) + ',' + (c[2] | 0) + ',' + alpha + ')';
  }

  var Strain = {
    cv: el.strain, ctx: el.strain.getContext('2d'), off: document.createElement('canvas'),
    w: 0, h: 0, dpr: 1, plot: null, pts: [],
    sx: function (lf) { var p = this.plot; return p.x0 + (lf - XMIN) / (XMAX - XMIN) * (p.x1 - p.x0); },
    sy: function (lh) { var p = this.plot; return p.y1 - (lh - YMIN) / (YMAX - YMIN) * (p.y1 - p.y0); },

    layout: function () {
      var fit = fitCanvas(this.cv);
      this.w = fit.w; this.h = fit.h; this.dpr = fit.dpr;
      var d = fit.dpr, narrow = fit.w / d < 420;
      this.plot = { x0: (narrow ? 44 : 54) * d, x1: fit.w - 14 * d, y0: 30 * d, y1: fit.h - 38 * d };
      this.off.width = fit.w; this.off.height = fit.h;
      this.narrow = narrow;
    },

    build: function () {
      if (!this.plot) this.layout();
      var g = this.off.getContext('2d'), d = this.dpr, p = this.plot, self = this;
      var sx = function (v) { return self.sx(v); }, sy = function (v) { return self.sy(v); };
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.clearRect(0, 0, this.w, this.h);

      // bands
      g.fillStyle = pta(0.085);
      g.fillRect(sx(-9), p.y0, sx(-7) - sx(-9), p.y1 - p.y0);
      g.fillStyle = lisa(0.08);
      g.fillRect(sx(-4), p.y0, sx(-1) - sx(-4), p.y1 - p.y0);
      // hatch the gap
      g.save();
      g.beginPath(); g.rect(sx(-7), p.y0, sx(-4) - sx(-7), p.y1 - p.y0); g.clip();
      g.strokeStyle = 'rgba(255,255,255,0.045)'; g.lineWidth = 1 * d;
      for (var hx = sx(-7) - (p.y1 - p.y0); hx < sx(-4); hx += 9 * d) {
        g.beginPath(); g.moveTo(hx, p.y1); g.lineTo(hx + (p.y1 - p.y0), p.y0); g.stroke();
      }
      g.restore();

      // grid
      g.lineWidth = 1 * d;
      for (var x = XMIN; x <= XMAX; x++) {
        g.strokeStyle = x % 3 === 0 ? 'rgba(255,255,255,0.075)' : 'rgba(255,255,255,0.035)';
        g.beginPath(); g.moveTo(Math.round(sx(x)) + 0.5, p.y0); g.lineTo(Math.round(sx(x)) + 0.5, p.y1); g.stroke();
      }
      for (var y = YMIN; y <= YMAX; y += 2) {
        g.strokeStyle = 'rgba(255,255,255,0.045)';
        g.beginPath(); g.moveTo(p.x0, Math.round(sy(y)) + 0.5); g.lineTo(p.x1, Math.round(sy(y)) + 0.5); g.stroke();
      }
      g.strokeStyle = 'rgba(255,255,255,0.16)';
      g.beginPath(); g.moveTo(p.x0, p.y1 + 0.5); g.lineTo(p.x1, p.y1 + 0.5); g.stroke();

      // axis labels
      g.font = '500 ' + (10.5 * d) + 'px ' + SANS;
      g.fillStyle = 'rgba(200,210,208,0.62)';
      g.textAlign = 'center'; g.textBaseline = 'top';
      var xl = { '-9': '1 nHz', '-6': '1 μHz', '-3': '1 mHz', '0': '1 Hz' };
      Object.keys(xl).forEach(function (k) {
        var xx = sx(+k);
        if (+k === 0) { g.textAlign = 'right'; xx = p.x1; }
        g.fillText(xl[k], xx, p.y1 + 7 * d);
        g.textAlign = 'center';
      });
      g.textAlign = 'right'; g.textBaseline = 'middle';
      for (var yy = YMIN; yy <= YMAX; yy += 2) {
        if (this.narrow && (yy - YMIN) % 4 !== 0) continue;
        g.fillText('10' + sup(yy), p.x0 - 7 * d, sy(yy));
      }
      g.fillStyle = 'rgba(200,210,208,0.4)';
      g.textAlign = 'center'; g.textBaseline = 'top';
      g.fillText('gravitational-wave frequency', (p.x0 + p.x1) / 2, p.y1 + 21 * d);

      // band labels
      g.font = '700 ' + (9.5 * d) + 'px ' + SANS;
      g.textBaseline = 'bottom';
      var lab = function (text, x0, x1, col) {
        g.fillStyle = col; g.textAlign = 'center';
        g.fillText(text.toUpperCase(), (sx(x0) + sx(x1)) / 2, p.y0 - 8 * d);
      };
      lab(this.narrow ? 'PTA' : 'Pulsar timing', -9, -7, pta(0.95));
      lab('the gap', -7, -4, 'rgba(200,208,206,0.55)');
      lab('LISA', -4, -1, lisa(0.95));

      // sensitivity curves
      g.lineJoin = 'round'; g.lineCap = 'round';
      var curve = function (fn, f0, f1, col, n) {
        g.beginPath();
        var first = true;
        for (var i = 0; i < n; i++) {
          var lf = Math.log10(f0) + (Math.log10(f1) - Math.log10(f0)) * i / (n - 1);
          var hv = fn(Math.pow(10, lf));
          if (!isFinite(hv)) continue;
          var X = sx(lf), Y = sy(Math.log10(hv));
          if (first) { g.moveTo(X, Y); first = false; } else g.lineTo(X, Y);
        }
        g.strokeStyle = col.replace('A', '0.22'); g.lineWidth = 6 * d; g.stroke();
        g.strokeStyle = col.replace('A', '1'); g.lineWidth = 1.8 * d; g.stroke();
      };
      g.save();
      g.beginPath(); g.rect(p.x0, p.y0, p.x1 - p.x0, p.y1 - p.y0); g.clip();
      curve(P.nanogravHc, 1e-9, 1e-7, 'rgba(235,168,98,A)', 200);
      curve(P.lisaHc, 1e-5, 1, 'rgba(95,200,185,A)', 400);
      g.restore();
      g.font = '600 ' + (10 * d) + 'px ' + SANS;
      g.textBaseline = 'top'; g.textAlign = 'center';
      g.fillStyle = pta(0.95);
      g.fillText('NANOGrav 15-yr', sx(-8.15), sy(Math.log10(4e-15)) + 8 * d);
      g.fillStyle = lisa(0.95);
      g.fillText('LISA', sx(Math.log10(3e-3)), sy(Math.log10(9.5e-22)) + 8 * d);

      // ghosts of earlier systems
      g.save();
      g.beginPath(); g.rect(p.x0, p.y0, p.x1 - p.x0, p.y1 - p.y0); g.clip();
      S.ghosts.forEach(function (gh, k) {
        if (sameTrack(gh, S.track)) return;
        g.beginPath();
        gh.pts.forEach(function (pt, i) {
          var X = sx(Math.log10(pt.f)), Y = sy(Math.log10(pt.hc));
          if (i === 0) g.moveTo(X, Y); else g.lineTo(X, Y);
        });
        g.strokeStyle = 'rgba(220,226,224,' + (0.34 - 0.07 * k) + ')'; g.lineWidth = 1.6 * d; g.stroke();
        var last = gh.pts[gh.pts.length - 1];
        var LX = sx(Math.log10(last.f)), LY = sy(Math.log10(last.hc));
        g.fillStyle = 'rgba(220,226,224,' + (0.5 - 0.1 * k) + ')';
        g.beginPath(); g.arc(LX, LY, 2.4 * d, 0, 6.2832); g.fill();
        g.font = '500 ' + (9.5 * d) + 'px ' + SANS; g.textAlign = 'left'; g.textBaseline = 'middle';
        g.fillText(sci(gh.M, 0).replace('1 × ', '') , LX + 6 * d, LY);
      });
      g.restore();

      // the full track of this system, faint and dashed
      var tr = S.track.pts;
      this.pts = tr.map(function (pt) { return { x: sx(Math.log10(pt.f)), y: sy(Math.log10(pt.hc)), c: vcolor(pt.v, 1), f: pt.f }; });
      g.save();
      g.setLineDash([3 * d, 4 * d]);
      g.strokeStyle = 'rgba(255,255,255,0.22)'; g.lineWidth = 1.3 * d;
      g.beginPath();
      this.pts.forEach(function (q, i) { if (i === 0) g.moveTo(q.x, q.y); else g.lineTo(q.x, q.y); });
      g.stroke();
      g.restore();
      // merger mark
      var e = this.pts[this.pts.length - 1];
      g.strokeStyle = 'rgba(255,255,255,0.35)'; g.lineWidth = 1 * d;
      g.beginPath(); g.moveTo(e.x, e.y - 9 * d); g.lineTo(e.x, e.y - 16 * d); g.stroke();
      g.font = '600 ' + (9.5 * d) + 'px ' + SANS; g.fillStyle = 'rgba(235,230,220,0.7)';
      g.textAlign = 'center'; g.textBaseline = 'bottom';
      g.fillText('merger', e.x, e.y - 18 * d);
    },

    draw: function () {
      var g = this.ctx, d = this.dpr;
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.clearRect(0, 0, this.w, this.h);
      g.drawImage(this.off, 0, 0);
      var pts = this.pts;
      if (!pts.length) return;
      // traveled part, coloured by v/c
      var lf = Math.log(S.f), l0 = Math.log(S.sys.fStart), l1 = Math.log(S.sys.fIsco);
      var fi = (lf - l0) / (l1 - l0) * (pts.length - 1);
      var k = Math.max(0, Math.min(pts.length - 1, Math.floor(fi)));
      var w = Math.min(1, Math.max(0, fi - k));
      var cur = k < pts.length - 1 ? { x: pts[k].x + w * (pts[k + 1].x - pts[k].x), y: pts[k].y + w * (pts[k + 1].y - pts[k].y) } : pts[k];
      g.lineCap = 'round'; g.lineWidth = 2.6 * d;
      for (var i = 0; i < k; i++) {
        g.strokeStyle = pts[i + 1].c;
        g.beginPath(); g.moveTo(pts[i].x, pts[i].y); g.lineTo(pts[i + 1].x, pts[i + 1].y); g.stroke();
      }
      if (k < pts.length - 1) {
        g.strokeStyle = pts[k + 1].c;
        g.beginPath(); g.moveTo(pts[k].x, pts[k].y); g.lineTo(cur.x, cur.y); g.stroke();
      }
      // the dot
      var band = P.bandOf(S.f);
      var col = band === 'pta' ? PTA_RGB : band === 'lisa' ? LISA_RGB : '235,232,225';
      var R = 18 * d;
      var grd = g.createRadialGradient(cur.x, cur.y, 0, cur.x, cur.y, R);
      grd.addColorStop(0, 'rgba(' + col + ',0.75)'); grd.addColorStop(0.35, 'rgba(' + col + ',0.22)'); grd.addColorStop(1, 'rgba(' + col + ',0)');
      g.fillStyle = grd; g.beginPath(); g.arc(cur.x, cur.y, R, 0, 6.2832); g.fill();
      g.fillStyle = '#fffdf6'; g.beginPath(); g.arc(cur.x, cur.y, 3.6 * d, 0, 6.2832); g.fill();
      if (S.stage === 'merger') {
        var a = S.mergeAge;
        for (var j = 0; j < 2; j++) {
          var t = (a - j * 0.35);
          if (t < 0 || t > 1.4) continue;
          var rr = (6 + 46 * t) * d;
          g.strokeStyle = 'rgba(255,250,240,' + (0.7 * (1 - t / 1.4)) + ')';
          g.lineWidth = 1.5 * d;
          g.beginPath(); g.arc(cur.x, cur.y, rr, 0, 6.2832); g.stroke();
        }
      }
    }
  };

  // ---------------------------------------------------------------- light curve
  var LC = { cv: el.light, ctx: el.light.getContext('2d'), w: 0, h: 0, dpr: 1, t: null, noise: null };
  (function makeNoise() {
    // fixed seed so the flicker doesn't change when you move a slider
    var s = 20260924 >>> 0;
    function rnd() { s = (s + 0x6D2B79F5) >>> 0; var t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }
    function gauss() { var u = 0, v = 0; while (u === 0) u = rnd(); while (v === 0) v = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
    var times = [], vals = [];
    var tauD = 250, sigma = 0.09, x = 0, tPrev = 0, tt = 0;
    while (tt < 3652) {
      if ((tt % 365.25) < 240) {
        var dt = tt - tPrev, e = Math.exp(-dt / tauD);
        x = x * e + sigma * Math.sqrt(1 - e * e) * gauss();
        times.push(tt); vals.push(x + 0.012 * gauss());
        tPrev = tt;
      }
      tt += 3 + 2 * rnd();
    }
    LC.t = times; LC.noise = vals;
  })();

  function lcState() {
    var Pd = (2 / S.f) / DAY;
    var M = S.sys.M, heavy = Math.max(S.m1, S.m2);
    var beta2 = P.vOverC(M, S.f) * heavy / M;       // speed of the lighter hole
    var A = Math.min(0.3, 2.5 * beta2 * 0.87);        // Doppler-like, size made up
    return { Pd: Pd, A: A };
  }

  LC.draw = function () {
    var fit = fitCanvas(this.cv);
    this.w = fit.w; this.h = fit.h; this.dpr = fit.dpr;
    var g = this.ctx, d = fit.dpr, W = fit.w, H = fit.h;
    var st = lcState();
    var target = Math.max(0.32, st.A + 0.3);
    S.lcRange += (target - S.lcRange) * 0.15;
    var half = S.lcRange;
    var x0 = 16 * d, x1 = W - 16 * d, y0 = 10 * d, y1 = H - 24 * d;
    var X = function (t) { return x0 + t / 3652 * (x1 - x0); };
    var Y = function (v) { return (y0 + y1) / 2 - v / half * (y1 - y0) / 2; };
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, W, H);
    // year ticks
    g.font = '500 ' + (9.5 * d) + 'px ' + SANS; g.textAlign = 'center'; g.textBaseline = 'top';
    for (var yr = 0; yr <= 10; yr++) {
      var xx = Math.round(X(yr * 365.25)) + 0.5;
      g.strokeStyle = 'rgba(255,255,255,0.04)'; g.lineWidth = 1 * d;
      g.beginPath(); g.moveTo(xx, y0); g.lineTo(xx, y1); g.stroke();
      if (yr % 2 === 0) {
        g.fillStyle = 'rgba(200,210,208,0.5)';
        g.fillText(yr === 0 ? 'year 0' : String(yr), xx, y1 + 7 * d);
      }
    }
    g.strokeStyle = 'rgba(255,255,255,0.08)';
    g.beginPath(); g.moveTo(x0, Math.round(Y(0)) + 0.5); g.lineTo(x1, Math.round(Y(0)) + 0.5); g.stroke();
    var ph = 0.7, Pd = st.Pd, A = st.A;
    // hidden signal, drawn faintly when it is slow enough to see
    if (Pd > 150) {
      g.setLineDash([4 * d, 4 * d]);
      g.strokeStyle = lisa(0.75); g.lineWidth = 1.4 * d;
      g.beginPath();
      for (var px = x0; px <= x1; px += 2 * d) {
        var t = (px - x0) / (x1 - x0) * 3652;
        var yv = Y(A * Math.sin(2 * Math.PI * t / Pd + ph));
        if (px === x0) g.moveTo(px, yv); else g.lineTo(px, yv);
      }
      g.stroke(); g.setLineDash([]);
    }
    // what the telescope gets
    g.fillStyle = 'rgba(236,230,218,0.78)';
    var r = 1.45 * d;
    for (var i = 0; i < this.t.length; i++) {
      var ti = this.t[i];
      var v = this.noise[i] + A * Math.sin(2 * Math.PI * ti / Pd + ph);
      var yy2 = Y(v);
      if (yy2 < y0 - 2 * d || yy2 > y1 + 2 * d) continue;
      g.beginPath(); g.arc(X(ti), yy2, r, 0, 6.2832); g.fill();
    }
  };

  var lcLastState = '';
  function updateLcText() {
    var st = lcState(), Pd = st.Pd;
    var state = Pd > 1200 ? 'slow' : Pd >= 100 ? 'window' : 'fast';
    var per = fmtTime(Pd * DAY);
    var note;
    if (state === 'slow') note = 'Orbital period ' + per + '. Ten years hold ' + (3652 / Pd < 1 ? 'less than one cycle' : sig(3652 / Pd) + ' cycles') + ', and a period search wants at least 3.';
    else if (state === 'window') note = 'Orbital period ' + per + '. That is inside the 100 to 1,200 day window a 10-year survey can use, if the flickering doesn\'t drown it.';
    else note = 'Orbital period ' + per + '. That is shorter than the roughly 100 days the survey cadence allows, so the signal just turns into extra scatter.';
    if (S.stage === 'merger') { note = 'Merged. The light curve goes quiet on the orbital period, and the flickering carries on.'; state = 'fast'; }
    el.lcNote.textContent = note;
    var key = state + S.stage;
    if (key !== lcLastState) {
      el.lcStatus.dataset.state = state;
      el.lcStatus.textContent = state === 'slow' ? 'too slow' : state === 'window' ? 'catchable' : (S.stage === 'merger' ? 'merged' : 'too fast');
      lcLastState = key;
    }
  }

  // ---------------------------------------------------------------- sound
  var Sound = {
    ctx: null, on: false,
    init: function () {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return false;
      try {
        var c = this.ctx = new AC();
        this.master = c.createGain(); this.master.gain.value = 0;
        this.comp = c.createDynamicsCompressor();
        this.comp.threshold.value = -18; this.comp.ratio.value = 4;
        this.lp = c.createBiquadFilter(); this.lp.type = 'lowpass'; this.lp.frequency.value = 2400; this.lp.Q.value = 0.4;
        this.osc = c.createOscillator(); this.osc.type = 'sine';
        this.osc2 = c.createOscillator(); this.osc2.type = 'triangle';
        this.g2 = c.createGain(); this.g2.gain.value = 0.16;
        this.trem = c.createGain(); this.trem.gain.value = 0.62;
        this.lfo = c.createOscillator(); this.lfo.type = 'sine'; this.lfo.frequency.value = 1;
        this.lfoDepth = c.createGain(); this.lfoDepth.gain.value = 0.36;
        this.lfo.connect(this.lfoDepth); this.lfoDepth.connect(this.trem.gain);
        this.osc.connect(this.trem); this.osc2.connect(this.g2); this.g2.connect(this.trem);
        this.trem.connect(this.lp); this.lp.connect(this.master); this.master.connect(this.comp); this.comp.connect(c.destination);
        this.osc.frequency.value = AUDIO_LO; this.osc2.frequency.value = AUDIO_LO * 2;
        this.osc.start(); this.osc2.start(); this.lfo.start();
        return true;
      } catch (e) { this.ctx = null; return false; }
    },
    update: function (fa, vol, lfoHz) {
      if (!this.ctx || !this.on) return;
      var t = this.ctx.currentTime;
      this.osc.frequency.setTargetAtTime(fa, t, 0.035);
      this.osc2.frequency.setTargetAtTime(fa * 2, t, 0.035);
      this.lfo.frequency.setTargetAtTime(lfoHz, t, 0.05);
      this.master.gain.setTargetAtTime(vol * 0.2, t, 0.06);
    },
    silence: function (tc) {
      if (!this.ctx) return;
      this.master.gain.setTargetAtTime(0, this.ctx.currentTime, tc || 0.08);
    },
    burst: function (fa) {
      if (!this.ctx || !this.on) return;
      var c = this.ctx, t = c.currentTime;
      try {
        var len = Math.floor(c.sampleRate * 0.9), buf = c.createBuffer(1, len, c.sampleRate), ch = buf.getChannelData(0);
        for (var i = 0; i < len; i++) ch[i] = (Math.random() * 2 - 1) * Math.exp(-i / (c.sampleRate * 0.18));
        var src = c.createBufferSource(); src.buffer = buf;
        var bp = c.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = fa * 1.4; bp.Q.value = 1.1;
        var ng = c.createGain(); ng.gain.value = 0.22;
        src.connect(bp); bp.connect(ng); ng.connect(this.comp); src.start(t);
        var ring = c.createOscillator(); ring.type = 'sine'; ring.frequency.setValueAtTime(fa * 1.3, t);
        ring.frequency.exponentialRampToValueAtTime(fa * 1.15, t + 1.2);
        var rg = c.createGain(); rg.gain.setValueAtTime(0.0001, t);
        rg.gain.exponentialRampToValueAtTime(0.2, t + 0.012);
        rg.gain.exponentialRampToValueAtTime(0.0001, t + 1.3);
        ring.connect(rg); rg.connect(this.comp); ring.start(t); ring.stop(t + 1.4);
      } catch (e) { /* sound is optional */ }
      this.silence(0.05);
    }
  };

  function setSound(on) {
    if (on && !Sound.ctx && !Sound.init()) {
      el.soundNote.textContent = 'This browser has no Web Audio, so there is no sound. Everything else works.';
      return;
    }
    Sound.on = on;
    if (on && Sound.ctx && Sound.ctx.state === 'suspended') Sound.ctx.resume();
    if (!on) Sound.silence();
    el.sound.setAttribute('aria-pressed', on ? 'true' : 'false');
    el.sound.querySelector('.btn-text').textContent = on ? 'Mute' : 'Listen';
    updateSoundNote();
  }
  function updateSoundNote() {
    var s = S.sys;
    el.soundNote.textContent = (Sound.on ? '' : 'Sound is off. ') +
      'Pitch follows the real gravitational-wave frequency, ' + fmtFreq(s.fStart) + ' to ' + fmtFreq(s.fIsco) +
      ', squeezed into 60 to 1000 Hz. The pulsing is the waves on screen, two per orbit.';
  }
  function audioFrame(vis) {
    if (!Sound.on || !Sound.ctx) return;
    if (!S.playing || S.stage !== 'inspiral' || !pageVisible || !inView) { Sound.silence(); return; }
    var fa = AUDIO_LO * Math.pow(AUDIO_HI / AUDIO_LO, S.u);
    var vol = 0.28 + 0.72 * Math.pow(S.u, 1.4);
    Sound.update(fa, vol, 2 * vis.omega);
  }

  // ---------------------------------------------------------------- verdict
  function heard(track, band) {
    var lo = P.BANDS[band][0], hi = P.BANDS[band][1], visited = false, loud = false;
    track.pts.forEach(function (pt) {
      if (pt.f < lo || pt.f > hi) return;
      visited = true;
      var s = band === 'pta' ? P.nanogravHc(pt.f) : P.lisaHc(pt.f);
      if (pt.hc > s) loud = true;
    });
    return { visited: visited, loud: loud };
  }
  function renderVerdict() {
    var s = S.sys, fS = s.fStart, fI = s.fIsco, mb = P.bandOf(fI), bs = P.bandOf(fS);
    var PTA = '<span class="v-pta">pulsar-timing band</span>', GAP = '<span class="v-gap">the gap</span>', LISA = '<span class="v-lisa">LISA band</span>';
    var s1;
    if (mb === 'gap') s1 = 'Merges at <strong>' + fmtFreq(fI) + '</strong>, in ' + GAP + ' between the detectors, where nothing is listening.';
    else if (mb === 'lisa') s1 = 'Merges at <strong>' + fmtFreq(fI) + '</strong>, inside the ' + LISA + '.';
    else if (mb === 'pta') s1 = 'Merges at <strong>' + fmtFreq(fI) + '</strong>, inside the ' + PTA + '.';
    else s1 = 'Merges at <strong>' + fmtFreq(fI) + '</strong>, above the LISA band.';
    var s2 = '';
    if ((bs === 'pta' || bs === 'below') && fI > 1e-7) {
      s2 = ' It leaves the ' + PTA + ' ' + fmtTime(s.tauAtF(1e-7)) + ' before the end';
      s2 += fI > 1e-4 ? ' and only reaches LISA ' + fmtTime(s.tauAtF(1e-4)) + ' before merging.' : ' and never reaches LISA.';
    } else if (bs === 'gap' && fI > 1e-4) {
      s2 = ' It spends most of the last 10 million years in ' + GAP + ' and enters the ' + LISA + ' ' + fmtTime(s.tauAtF(1e-4)) + ' before merging.';
    } else if (bs === 'lisa') {
      s2 = ' It sits in the ' + LISA + ' for the whole 10 million years shown.';
    } else if (bs === 'gap') {
      s2 = ' It never enters either band.';
    }
    var hp = heard(S.track, 'pta'), hl = heard(S.track, 'lisa'), s3 = '';
    if (hp.visited && !hp.loud && hl.visited && !hl.loud) s3 = ' At ' + fmtDist(S.d) + ' it stays under both curves.';
    else if (hp.visited && !hp.loud) s3 = ' At ' + fmtDist(S.d) + ' it stays under the NANOGrav curve.';
    else if (hl.visited && !hl.loud) s3 = ' At ' + fmtDist(S.d) + ' it stays under the LISA curve.';
    el.verdict.innerHTML = s1 + s2 + s3;
  }

  // ---------------------------------------------------------------- timeline ticks
  function buildTicks() {
    var s = S.sys, span = s.lnTauStart - s.lnTauEnd;
    var narrow = el.ticks.getBoundingClientRect().width < 520;
    var list = [
      [1e6 * YR, '1 Myr'], [1e5 * YR, '100 kyr'], [1e4 * YR, '10 kyr'], [1e3 * YR, '1,000 yr'],
      [100 * YR, '100 yr'], [10 * YR, '10 yr'], [YR, '1 yr'], [30 * DAY, '1 month'], [DAY, '1 day'], [3600, '1 hour']
    ];
    var html = '<span style="left:0%">10 Myr</span>';
    var lastPos = 0, minGap = narrow ? 15 : 7.5;
    list.forEach(function (it) {
      if (it[0] <= s.tauEnd * 2) return;
      var pos = (s.lnTauStart - Math.log(it[0])) / span * 100;
      if (pos - lastPos < minGap || pos > 100 - minGap) return;
      html += '<span style="left:' + pos.toFixed(2) + '%">' + it[1] + '</span>';
      lastPos = pos;
    });
    html += '<span class="is-end" style="left:100%">merger</span>';
    el.ticks.innerHTML = html;
  }

  // ---------------------------------------------------------------- HUD
  var bandNames = { below: 'Below the PTA band', pta: 'PTA band', gap: 'In the gap', lisa: 'LISA band', above: 'Above LISA', merged: 'Merged' };
  var lastHud = 0;
  function updateHud(force) {
    var now = performance.now();
    if (!force && now - lastHud < 70) return;
    lastHud = now;
    var M = S.sys.M;
    var band = S.stage === 'merger' ? 'merged' : P.bandOf(S.f);
    if (el.pill.dataset.band !== band) { el.pill.dataset.band = band; el.bandText.textContent = bandNames[band]; }
    if (S.stage === 'merger') {
      el.clock.textContent = 'Merged';
    } else {
      el.clock.textContent = fmtTime(S.tau);
    }
    el.sf.textContent = fmtFreq(S.f);
    el.sp.textContent = fmtTime(2 / S.f);
    el.sa.textContent = fmtSep(P.separation(M, S.f));
    el.sv.textContent = fmtV(P.vOverC(M, S.f));
    if (!scrubbing) {
      var v = Math.round(S.p * 1000);
      if (+el.scrub.value !== v) el.scrub.value = v;
    }
    el.scrub.style.setProperty('--p', S.stage === 'merger' ? 1 : S.p);
    el.scrub.setAttribute('aria-valuetext', S.stage === 'merger' ? 'merged' : fmtTime(S.tau) + ' before merger');
    updateLcText();
    if (band !== S.band) {
      if (S.playing) el.announcer.textContent = band === 'merged' ? 'Merged.' : 'Now: ' + bandNames[band] + '.';
      S.band = band;
    }
  }

  // ---------------------------------------------------------------- 3D view hookup
  var view = null;
  function showFallback(msg) {
    if (view) return;
    el.fallback.hidden = false;
    el.fallbackText.textContent = msg;
    el.hint.classList.add('is-gone');
  }
  el.fallback.hidden = false;
  window.ChirpViewFailed = function (why) {
    showFallback(why === 'webgl'
      ? 'This browser can\'t draw WebGL, so the 3D view is off. The plot, the clock and the sound all still work.'
      : 'The 3D view didn\'t load (its library comes from a CDN). The plot, the clock and the sound all still work.');
  };
  setTimeout(function () { if (!view) window.ChirpViewFailed('load'); }, 12000);

  window.Chirp = {
    stage: el.stage,
    constants: { R0: R0, REND: REND, OMEGA_END: OMEGA_END },
    isReduced: function () { return reduced; },
    registerView: function (v) {
      view = v;
      el.fallback.hidden = true;
      S.resync = true;
      wake();
    },
    wake: function () { wake(); },
    hintSeen: function () { el.hint.classList.add('is-gone'); }
  };

  // read-only state for the interaction harness (scripts/qa/inspiral_interactions.py)
  window.__chirpDebug = function () {
    return {
      playing: S.playing, stage: S.stage, p: S.p, preset: S.preset, m1: S.m1, m2: S.m2, d: S.d,
      soundOn: Sound.on, scrubbing: scrubbing, autoplayed: autoplayed, ghosts: S.ghosts.length,
      fIsco: S.sys.fIsco, f: S.f, band: S.band, view: !!view, presets: PRESETS
    };
  };

  function snapshot(vis) {
    return {
      stage: S.stage, mergeAge: S.mergeAge, playing: S.playing, reduced: reduced,
      r: vis.r, ang: S.ang, omega: vis.omega, amp: vis.amp, u: S.u,
      mu1: S.m1 / S.sys.M, mu2: S.m2 / S.sys.M,
      beta: P.vOverC(S.sys.M, S.f), resync: S.resync, clock: S.clock
    };
  }

  // ---------------------------------------------------------------- loop
  var raf = 0, last = 0, dirty = true, pageVisible = !document.hidden, inView = true, scrubbing = false;
  function wake() { dirty = true; if (!raf && pageVisible && inView) raf = requestAnimationFrame(tick); }

  function advance(dt) {
    var vis = visual();
    if (S.stage === 'inspiral') {
      S.ang += 2 * Math.PI * vis.omega * dt;
      S.p += dt / INSPIRAL_SECONDS;
      if (S.p >= 1) {
        S.p = 1; S.stage = 'merger'; S.mergeAge = 0;
        Sound.burst(AUDIO_HI);
        el.announcer.textContent = 'Merged.';
      }
    } else {
      S.mergeAge += dt;
      if (S.mergeAge >= MERGER_HOLD) {
        S.stage = 'inspiral'; S.p = 0; S.ang = 0; S.resync = true;
      }
    }
    S.clock += dt;
  }

  var lcTimer = 0;
  function tick(now) {
    raf = 0;
    if (!pageVisible || !inView) { last = 0; Sound.silence(); return; }
    var dt = last ? Math.min(0.05, (now - last) / 1000) : 0;
    last = now;
    var adv = 0;
    if (S.playing) { adv = dt * (reduced ? 0.4 : 1); advance(adv); }
    updateState();
    var vis = visual();
    var busy = false;
    if (view) {
      try { view.frame(snapshot(vis), adv, dt); busy = view.busy(); }
      catch (e) { view = null; showFallback('The 3D view hit an error and switched off. The plot, the clock and the sound all still work.'); }
    }
    S.resync = false;
    Strain.draw();
    lcTimer += dt;
    if (dirty || !S.playing || lcTimer > 0.033) { LC.draw(); lcTimer = 0; }
    updateHud(dirty || !S.playing);
    audioFrame(vis);
    dirty = false;
    if (S.playing || busy) raf = requestAnimationFrame(tick);
    else last = 0;
  }

  // ---------------------------------------------------------------- actions
  function setPlaying(on) {
    S.playing = on;
    el.play.classList.toggle('is-on', on);
    el.play.setAttribute('aria-pressed', on ? 'true' : 'false');
    el.play.querySelector('.btn-text').textContent = on ? 'Pause' : 'Play';
    if (!on) Sound.silence();
    wake();
  }
  function restart() {
    S.stage = 'inspiral'; S.p = 0; S.ang = 0; S.mergeAge = 0; S.resync = true;
    setPlaying(true);
  }

  // one place that writes every mass/distance readout, slider fill, aria text and preset highlight
  // from S, so a slider move and a preset click can't leave different parts out of date
  function syncReadouts() {
    [el.m1, el.m2, el.dist].forEach(function (inp) {
      inp.style.setProperty('--p', (inp.value - inp.min) / (inp.max - inp.min));
    });
    el.m1o.textContent = fmtMass(S.m1); el.m2o.textContent = fmtMass(S.m2); el.disto.textContent = fmtDist(S.d);
    el.m1.setAttribute('aria-valuetext', massWords(S.m1));
    el.m2.setAttribute('aria-valuetext', massWords(S.m2));
    el.dist.setAttribute('aria-valuetext', fmtDist(S.d).replace('Mpc', 'megaparsecs').replace('Gpc', 'gigaparsecs'));
    presetButtons.forEach(function (b) { b.setAttribute('aria-pressed', b.dataset.preset === S.preset ? 'true' : 'false'); });
  }
  function syncSliders() {
    el.m1.value = Math.log10(S.m1).toFixed(3); el.m2.value = Math.log10(S.m2).toFixed(3); el.dist.value = Math.log10(S.d).toFixed(3);
    syncReadouts();
  }

  function sameTrack(a, b) {
    return !!a && !!b && Math.abs(a.m1 - b.m1) / b.m1 < 1e-3 && Math.abs(a.m2 - b.m2) / b.m2 < 1e-3 && Math.abs(a.d - b.d) / b.d < 1e-3;
  }
  function pushGhost(track) {
    if (!track || sameTrack(track, S.track)) return;
    S.ghosts = S.ghosts.filter(function (g) { return !sameTrack(g, track); });
    S.ghosts.unshift(track);
    if (S.ghosts.length > 3) S.ghosts.length = 3;
  }

  function rebuild() {
    buildSystem();
    if (S.stage === 'merger') { S.stage = 'inspiral'; S.p = Math.min(S.p, 0.999); }
    S.resync = true;
    Strain.build();
    buildTicks();
    renderVerdict();
    updateSoundNote();
    updateState();
    updateHud(true);
    el.strain.setAttribute('aria-label', 'Characteristic strain against frequency. ' + el.verdict.textContent);
    wake();
  }

  function applyPreset(name) {
    var pr = PRESETS[name];
    if (!pr) return;
    var prev = S.track;
    S.m1 = pr.m1; S.m2 = pr.m2; S.d = pr.d; S.preset = name;
    buildSystem();
    pushGhost(prev);
    syncSliders();
    S.stage = 'inspiral'; S.p = 0; S.ang = 0;
    rebuild();
    setPlaying(true);
  }

  // ---------------------------------------------------------------- events
  // once the visitor has touched play, restart, sound, a preset or the timeline, the page never
  // starts or stops playback on its own again, or the scroll-in autoplay undoes a Pause
  function userTook() { autoplayed = true; }
  el.play.addEventListener('click', function () {
    userTook();
    if (!S.playing && S.stage === 'inspiral' && S.p >= 0.999) { S.p = 0; S.resync = true; }
    setPlaying(!S.playing);
  });
  el.restart.addEventListener('click', function () { userTook(); restart(); });
  el.sound.addEventListener('click', function () {
    userTook();
    var on = !Sound.on;
    setSound(on);
    if (on && !S.playing) setPlaying(true);
  });
  presetButtons.forEach(function (b) { b.addEventListener('click', function () { userTook(); applyPreset(b.dataset.preset); }); });

  var dragStartTrack = null;
  function sliderInput(key, inp) {
    return function () {
      if (!dragStartTrack) dragStartTrack = S.track;
      var v = Math.pow(10, +inp.value);
      S[key] = v; S.preset = null;
      syncReadouts();
      rebuild();
    };
  }
  function sliderChange() {
    if (dragStartTrack) { pushGhost(dragStartTrack); dragStartTrack = null; Strain.build(); wake(); }
  }
  el.m1.addEventListener('input', sliderInput('m1', el.m1));
  el.m2.addEventListener('input', sliderInput('m2', el.m2));
  el.dist.addEventListener('input', sliderInput('d', el.dist));
  [el.m1, el.m2, el.dist].forEach(function (inp) { inp.addEventListener('change', sliderChange); });

  el.scrub.addEventListener('pointerdown', function () { scrubbing = true; userTook(); });
  // any way a drag can end releases the thumb, or the slider stops following playback for good
  function endScrub() { if (scrubbing) { scrubbing = false; updateHud(true); } }
  window.addEventListener('pointerup', endScrub);
  window.addEventListener('pointercancel', endScrub);
  el.scrub.addEventListener('change', endScrub);
  el.scrub.addEventListener('blur', endScrub);
  el.scrub.addEventListener('input', function () {
    userTook();
    S.p = Math.min(0.999, +el.scrub.value / 1000);
    if (S.stage === 'merger') S.stage = 'inspiral';
    if (!S.playing) S.resync = true;
    el.scrub.style.setProperty('--p', S.p);
    wake();
  });

  document.addEventListener('visibilitychange', function () {
    pageVisible = !document.hidden;
    if (!pageVisible) Sound.silence(); else wake();
  });

  if (mqReduce.addEventListener) mqReduce.addEventListener('change', function (e) { reduced = e.matches; wake(); });

  var autoplayed = false;
  if ('IntersectionObserver' in window) {
    // pause everything when the whole instrument is off screen
    new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        inView = en.isIntersecting;
        if (inView) wake(); else Sound.silence();
      });
    }).observe(el.instrument);
    // start on its own (motion allowed) once most of the 3D view is on screen
    new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (!autoplayed && !reduced && en.intersectionRatio >= 0.55) { autoplayed = true; setPlaying(true); }
      });
    }, { threshold: [0.55] }).observe($('orbit-panel'));
  } else if (!reduced) { autoplayed = true; S.playing = true; }

  var resizeT = 0;
  function onResize() {
    clearTimeout(resizeT);
    resizeT = setTimeout(function () { Strain.layout(); Strain.build(); buildTicks(); LC.draw(); wake(); }, 60);
  }
  if ('ResizeObserver' in window) new ResizeObserver(onResize).observe(el.instrument);
  else window.addEventListener('resize', onResize);

  // ---------------------------------------------------------------- start
  // a link can open on a given pair and moment, e.g. #pair=lisa&at=0.8 (starts paused)
  var hPair = /(?:^|[#&])pair=(pta|gap|lisa)\b/.exec(location.hash);
  var hAt = /(?:^|[#&])at=(0?\.\d+|1(?:\.0*)?|0)\b/.exec(location.hash);
  if (hPair) { var pr0 = PRESETS[hPair[1]]; S.m1 = pr0.m1; S.m2 = pr0.m2; S.d = pr0.d; S.preset = hPair[1]; }
  syncSliders();
  buildSystem();
  Strain.layout();
  rebuild();
  if (hAt) {
    autoplayed = true;
    S.p = Math.min(0.999, +hAt[1]); S.resync = true; updateState(); updateHud(true);
  } else if (reduced) {
    // no autoplay: show a still from partway through so the page isn't empty
    S.p = 0.55; S.resync = true; updateState(); updateHud(true);
  }
  wake();
})();
