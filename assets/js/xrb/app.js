// X-ray binary explorer: state, camera, clocks, UI and the render loop.
import * as P from './physics.js';
import { Renderer } from './renderer.js';
import { drawLightCurve, drawPsd, COLORS } from './charts.js';
import { COPY } from './copy.js';

const $ = (id) => document.getElementById(id);
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// ------------------------------------------------------------------ physics setup
const B = P.makeBinary({ M1: 10, M2: 1, R2: 1, Tstar: 5800 });
const RG_KM = P.rgCm(10) / 1e5;           // lengths on screen use the binary's 10 Msun hole
const RSUN_KM = P.RSUN / 1e5;
const ORBIT_WALL_S = 24;                    // one orbit on screen
const orbitSpeedup = B.P / ORBIT_WALL_S;

// speed: model seconds per wall second for the picture. psd: simulated seconds of data the power
// spectrum takes in per wall second, which is faster than the picture for all but the high-frequency mode.
const MODES = {
  quiet: { idx: 0, M: P.QUIET.M, a: P.QUIET.a, rin: P.rIsco(P.QUIET.a), speed: 1, psd: 16, win: 12, fRange: [1 / 64, 32] },
  typec: { idx: 1, M: P.TYPEC.M, a: P.TYPEC.a, rin: P.TYPEC.rT, speed: 1, psd: 16, win: 12, fRange: [1 / 64, 32] },
  rpm: { idx: 2, M: P.RPM.M, a: P.RPM.a, rin: P.rIsco(P.RPM.a), speed: 1 / P.RPM.slow, psd: 1, win: 0.03, fRange: [1, 2048] },
  heart: { idx: 3, M: P.HEART.M, a: P.HEART.a, rin: P.rIsco(P.HEART.a), speed: 6, psd: 60, win: 160, fRange: [1 / 256, 4] },
};

const SCALES = {
  binary: { logD: Math.log10(5.3e5), el: 22, name: 'Whole binary' },
  disc: { logD: Math.log10(1.45e5), el: 32, name: 'Accretion disc' },
  inner: { logD: Math.log10(70), el: 14, name: 'Inner disc' },
  horizon: { logD: Math.log10(34), el: 9, name: 'Black hole' },
  edge: { logD: Math.log10(32), el: 1.4, name: 'Black hole, edge-on' },
  rpmview: { logD: Math.log10(36), el: 16, name: 'Inner disc' },
  behind: { logD: Math.log10(44), el: 1.2, name: 'Black hole, star behind' },
};
const LOGD_MIN = Math.log10(11), LOGD_MAX = Math.log10(1.5e6);

// ------------------------------------------------------------------ state
const S = {
  mode: 'quiet',
  incl: 84,
  heat: 1,
  jet: false,
  labels: true,
  playing: !reduceMotion,
  orbitPhase: 0.75,        // star seen side-on from Earth, so the teardrop shows; it crosses in front of the hole 6 s in
  tModel: 0,
  cam: { az: 0.9, el: 22 * Math.PI / 180, logD: SCALES.binary.logD },
  goal: { az: 0.9, el: 22 * Math.PI / 180, logD: SCALES.binary.logD },
  tween: null,
  view: null,              // the direction lock: 'earth', 'edge', 'behind' or null (free camera); it opens on a free camera
  collapse: 0, collapseGoal: 0,
  lc: null, lcPending: null,
  qpo: null, welch: null, segDone: 0, segClock: 0,
  exposureT: 0,
  visible: true,
  lastScale: '',
  lastCaptionKey: '',
  userExposure: 1,
};

// ------------------------------------------------------------------ DOM
const stage = $('xrb-stage');
const canvas = $('xrb-canvas');
const lcCanvas = $('xrb-lc');
const psdCanvas = $('xrb-psd');
const VIEW = { w: canvas.clientWidth || 800, h: canvas.clientHeight || 500 };
new ResizeObserver(() => { VIEW.w = canvas.clientWidth; VIEW.h = canvas.clientHeight; if (R) { R.cssW = VIEW.w; R.cssH = VIEW.h; } }).observe(canvas);
for (const c of [lcCanvas, psdCanvas]) new ResizeObserver(() => { c._w = c.clientWidth; c._h = c.clientHeight; S.yr = null; }).observe(c);
let R = null;
try {
  R = new Renderer(canvas);
} catch (err) {
  console.warn(err);
  $('xrb-fallback').hidden = false;
  canvas.hidden = true;
}

// ------------------------------------------------------------------ light curves
function startBinaryLC() {
  S.lcPending = { gen: P.binaryLightCurvesGen(B, S.incl, S.heat, 160), progress: 0 };
}
function stepBinaryLC(budgetMs) {
  if (!S.lcPending) return;
  const t0 = performance.now();
  while (performance.now() - t0 < budgetMs) {
    const r = S.lcPending.gen.next();
    if (r.done) { S.lc = r.value; S.lcPending = null; return; }
  }
}
function startQpo() {
  const m = S.mode;
  if (m === 'typec') S.qpo = P.lcTypeC(S.incl);
  else if (m === 'rpm') S.qpo = P.lcRpm(S.incl);
  else if (m === 'heart') S.qpo = P.lcHeartbeat();
  else S.qpo = P.lcQuiet();
  S.welch = new P.WelchAccumulator(S.qpo.seg, S.qpo.dt);
  S.segDone = 0; S.segClock = 0;
}
let qpoTimer = 0;
function scheduleQpo() { clearTimeout(qpoTimer); qpoTimer = setTimeout(startQpo, 160); }
let lcTimer = 0;
function scheduleBinaryLC() { clearTimeout(lcTimer); lcTimer = setTimeout(startBinaryLC, 90); }

// ------------------------------------------------------------------ camera
function camera() {
  const D = Math.pow(10, S.cam.logD);
  const phi = 2 * Math.PI * S.orbitPhase;
  const aRg = B.aRg;
  const com = [B.m2 * aRg * Math.cos(phi), B.m2 * aRg * Math.sin(phi), 0];
  const s = 1 - smooth(3.2, 5.0, S.cam.logD);          // 1 near the hole, 0 at binary scale
  const target = [com[0] * (1 - s), com[1] * (1 - s), 0];
  const ce = Math.cos(S.cam.el), se = Math.sin(S.cam.el);
  const dir = [ce * Math.cos(S.cam.az), ce * Math.sin(S.cam.az), se];
  const pos = [target[0] + D * dir[0], target[1] + D * dir[1], target[2] + D * dir[2]];
  const F = [-dir[0], -dir[1], -dir[2]];
  let Rv = [F[1] * 1 - F[2] * 0, F[2] * 0 - F[0] * 1, 0];   // cross(F, z)
  const rl = Math.hypot(Rv[0], Rv[1], Rv[2]) || 1;
  Rv = Rv.map((v) => v / rl);
  const U = [Rv[1] * F[2] - Rv[2] * F[1], Rv[2] * F[0] - Rv[0] * F[2], Rv[0] * F[1] - Rv[1] * F[0]];
  const aspect = VIEW.w / Math.max(VIEW.h, 1);
  // Portrait screens widen the view. At binary scale by a lot, so the whole star stays in frame; close to
  // the hole only a little, so the shadow and the lensed disc fill a phone screen and the disc's sides crop.
  const kWide = 1.6 - 0.75 * s;
  const tanFov = S.fovDeg ? Math.tan(S.fovDeg * Math.PI / 360) : Math.tan(21 * Math.PI / 180) * Math.max(1, kWide / aspect);
  return { D, pos, F, R: Rv, U, target, tanFov, aspect };
}

function project(cam, p) {
  const d = [p[0] - cam.pos[0], p[1] - cam.pos[1], p[2] - cam.pos[2]];
  const z = d[0] * cam.F[0] + d[1] * cam.F[1] + d[2] * cam.F[2];
  if (z <= 0) return null;
  const x = (d[0] * cam.R[0] + d[1] * cam.R[1] + d[2] * cam.R[2]) / z / (cam.tanFov * cam.aspect);
  const y = (d[0] * cam.U[0] + d[1] * cam.U[1] + d[2] * cam.U[2]) / z / cam.tanFov;
  return [(x * 0.5 + 0.5) * VIEW.w, (0.5 - y * 0.5) * VIEW.h];
}

const DEG = Math.PI / 180;
const wrapPi = (a) => ((a + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
// One flight at a time. A new one starts from wherever the camera is, so a click mid-flight turns it smoothly.
function flyTo(logD, dir) {
  const from = { ...S.cam };
  const to = { logD, el: dir.el, az: from.az + wrapPi(dir.az - from.az) };
  const dist = Math.abs(to.logD - from.logD);
  const dur = reduceMotion ? 0.35 : clamp(1.2 + dist * 0.75, 1.2, 4.6);
  S.tween = { from, to, t: 0, dur };
}
function earthDir() { return { az: 0, el: (90 - S.incl) * DEG }; }
const starAz = () => 2 * Math.PI * S.orbitPhase + Math.PI;

// ------------------------------------------------------------------ views
// Every camera control goes through here, so each one sets its whole state from whatever came before and
// replaces a flight still under way. A view (Earth, edge-on, star behind) sets the direction and a zoom sets
// the distance: the zoom buttons keep the current view, and any view or zoom leaves the telescope view.
const visited = {};
const VIEW_BTNS = [['xrb-earthview', 'earth'], ['xrb-edgeview', 'edge'], ['xrb-behindview', 'behind']];
const aimLogD = () => (S.tween ? S.tween.to.logD : S.goal.logD);   // where the camera is going, not where it is mid-flight
const aimAz = () => (S.tween ? S.tween.to.az : S.goal.az);
const earthKey = (ld) => (ld > 4.9 ? 'binary' : ld > 3.2 ? 'disc' : ld > 1.6 ? 'inner' : 'horizon');
function viewDir(scaleKey) {
  if (S.view === 'earth') return earthDir();
  if (S.view === 'behind') return { az: starAz(), el: SCALES.behind.el * DEG };
  if (S.view === 'edge') return { az: aimAz(), el: SCALES.edge.el * DEG };
  return { az: aimAz(), el: SCALES[scaleKey].el * DEG };
}
function syncViewButtons() {
  const tel = S.collapseGoal > 0.5;
  for (const [id, v] of VIEW_BTNS) $(id).setAttribute('aria-pressed', String(!tel && S.view === v));
  $('xrb-telescope').setAttribute('aria-pressed', String(tel));
}
function setView(v) {
  S.view = v;
  if (v === 'edge' || v === 'behind') visited[v] = true;
  syncViewButtons();
}
function setTelescope(on) {
  S.collapseGoal = on ? 1 : 0;
  if (on) S.view = 'earth';                // a telescope sees the system from Earth
  syncViewButtons();
}
function goTo(scaleKey) { flyTo(SCALES[scaleKey].logD, viewDir(scaleKey)); }
function zoomTo(scaleKey) { setTelescope(false); goTo(scaleKey); }
function showView(v) {
  if (v === 'telescope') {
    if (S.collapseGoal > 0.5) { setTelescope(false); return; }
    setTelescope(true);
    flyTo(aimLogD(), earthDir());          // same zoom, turned to face from Earth
    return;
  }
  const key = v === 'earth' ? earthKey(aimLogD()) : v;
  setTelescope(false);
  setView(v);
  goTo(key);
}
function pickMode(m) {
  if (m !== S.mode) setMode(m);            // the active mode again keeps its power spectrum
  const ld = aimLogD();
  const key = m === 'rpm' ? 'rpmview' : ld > 3 || ld < 1.7 ? 'inner' : null;
  if (!key) return;
  if (S.view === 'edge' || S.view === 'behind') setView(null);   // each mode flies to its own shot of the inner disc
  goTo(key);
}
// The visitor takes the camera: a flight under way keeps its distance but stops turning, and a view lock ends.
// The telescope view is Earth's and does not turn.
function takeCamera() {
  if (S.collapseGoal > 0.5) return false;
  if (S.tween) { S.goal.az = S.cam.az; S.goal.el = S.cam.el; S.goal.logD = S.tween.to.logD; S.tween = null; }
  if (S.view) setView(null);
  return true;
}

// ------------------------------------------------------------------ input
let drag = null;
const pointers = new Map();
canvas.addEventListener('pointerdown', (e) => {
  canvas.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, [e.clientX, e.clientY]);
  if (pointers.size === 1) drag = { x: e.clientX, y: e.clientY, moved: false };
  S.touched = true;
});
canvas.addEventListener('pointermove', (e) => {
  if (!pointers.has(e.pointerId)) return;
  const prev = pointers.get(e.pointerId);
  pointers.set(e.pointerId, [e.clientX, e.clientY]);
  if (pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
    if (S.pinch) zoomBy(-Math.log10(d / S.pinch) * 1.4);
    S.pinch = d;
    return;
  }
  if (!drag) return;
  // a click that wobbles a pixel or two is still a click, and keeps the view
  if (!drag.moved && Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < 4) return;
  drag.moved = true;
  if (!takeCamera()) return;
  const dx = e.clientX - prev[0], dy = e.clientY - prev[1];
  S.goal.az -= dx * 0.0065;
  S.goal.el = clamp(S.goal.el + dy * 0.0065, -1.53, 1.53);
});
const endPointer = (e) => { pointers.delete(e.pointerId); if (pointers.size < 2) S.pinch = null; if (!pointers.size) drag = null; };
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);
// Wheel and pinch change only the distance: a flight under way still finishes turning to its view.
function zoomBy(dl) {
  if (S.tween) { S.goal.az = S.tween.to.az; S.goal.el = S.tween.to.el; S.goal.logD = S.cam.logD; S.tween = null; }
  S.goal.logD = clamp(S.goal.logD + dl, LOGD_MIN, LOGD_MAX);
}
// The wheel zooms only after the picture has been clicked (or with Ctrl / Cmd held), so a visitor
// scrolling down the page does not get stuck zooming. Moving the pointer off the picture disarms it.
let wheelArmed = false, hintTimer = 0;
const wheelHint = $('xrb-wheelhint');
if (/Mac|iPhone|iPad/.test(navigator.platform || '')) $('xrb-wheelkey').textContent = '⌘';
const hideHint = () => { clearTimeout(hintTimer); wheelHint.classList.remove('is-on'); };
canvas.addEventListener('pointerdown', () => { wheelArmed = true; hideHint(); });
canvas.addEventListener('focus', () => { wheelArmed = true; });
canvas.addEventListener('blur', () => { wheelArmed = false; });
stage.addEventListener('pointerleave', () => { wheelArmed = false; });
canvas.addEventListener('wheel', (e) => {
  if (!(wheelArmed || e.ctrlKey || e.metaKey)) {
    wheelHint.classList.add('is-on');
    clearTimeout(hintTimer);
    hintTimer = setTimeout(hideHint, 1600);
    return;                                  // let the page scroll
  }
  e.preventDefault();
  hideHint();
  const k = e.deltaMode === 1 ? 0.05 : 0.0016;
  zoomBy(clamp(e.deltaY * k, -0.35, 0.35));
  S.touched = true;
}, { passive: false });
canvas.addEventListener('keydown', (e) => {
  const k = e.key;
  let used = true;
  const turn = (daz, del) => { if (takeCamera()) { S.goal.az += daz; S.goal.el = clamp(S.goal.el + del, -1.53, 1.53); } };
  if (k === 'ArrowLeft') turn(0.12, 0);
  else if (k === 'ArrowRight') turn(-0.12, 0);
  else if (k === 'ArrowUp') turn(0, 0.1);
  else if (k === 'ArrowDown') turn(0, -0.1);
  else if (k === '+' || k === '=') zoomBy(-0.2);
  else if (k === '-' || k === '_') zoomBy(0.2);
  else if (k === ' ') togglePlay();
  else used = false;
  if (used) e.preventDefault();
});

// ------------------------------------------------------------------ controls
function pressGroup(sel, key, attr) {
  document.querySelectorAll(sel).forEach((b) => b.setAttribute('aria-pressed', String(b.dataset[attr] === key)));
}
document.querySelectorAll('[data-scale]').forEach((b) => b.addEventListener('click', () => zoomTo(b.dataset.scale)));
document.querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', () => pickMode(b.dataset.mode)));
function setMode(m) {
  S.mode = m;
  pressGroup('[data-mode]', m, 'mode');
  S.tModel = 0;
  S.jet = m === 'typec';
  $('xrb-jet').setAttribute('aria-pressed', String(S.jet));
  startQpo();
}
const incl = $('xrb-incl');
incl.addEventListener('input', () => {
  S.incl = +incl.value;
  $('xrb-incl-out').textContent = S.incl + '°';
  scheduleBinaryLC();
  if (S.mode === 'typec' || S.mode === 'rpm') scheduleQpo();
  if (S.view === 'earth') { const e = earthDir(); S.goal.el = e.el; if (S.tween) S.tween.to.el = e.el; }
});
$('xrb-earthview').addEventListener('click', () => showView('earth'));
$('xrb-edgeview').addEventListener('click', () => showView('edge'));
$('xrb-behindview').addEventListener('click', () => showView('behind'));
$('xrb-telescope').addEventListener('click', () => showView('telescope'));
$('xrb-earth').addEventListener('click', () => showView('earth'));
$('xrb-bh').addEventListener('click', () => zoomTo('horizon'));
$('xrb-prompt').addEventListener('click', () => { if (S.promptAction) S.promptAction(); });
const bright = $('xrb-bright');
bright.addEventListener('input', () => {
  S.userExposure = Math.pow(2, +bright.value);
  $('xrb-bright-out').textContent = S.userExposure.toFixed(2).replace(/0$/, '') + '×';
});
const toggle = (id, key, after) => $(id).addEventListener('click', () => {
  S[key] = !S[key];
  $(id).setAttribute('aria-pressed', String(S[key]));
  if (after) after();
});
toggle('xrb-jet', 'jet');
toggle('xrb-labels-btn', 'labels');
$('xrb-heat').addEventListener('click', () => {
  S.heat = S.heat > 0.5 ? 0 : 1;
  $('xrb-heat').setAttribute('aria-pressed', String(S.heat > 0.5));
  scheduleBinaryLC();
});
function togglePlay() {
  S.playing = !S.playing;
  $('xrb-play').textContent = S.playing ? 'Pause' : 'Play';   // the label says what a press does, so no aria-pressed
}
$('xrb-play').addEventListener('click', togglePlay);
$('xrb-play').textContent = S.playing ? 'Pause' : 'Play';
$('xrb-psd-reset').addEventListener('click', () => { if (S.welch) { S.welch.reset(); S.segDone = 0; S.segClock = 0; } });

// ------------------------------------------------------------------ disc rotation phases (display clock)
const PHASE_C = 2 * Math.PI * 3;           // each texture layer lives three orbits, then fades
const phaseState = new Float64Array(512);
function updatePhases(dtWall, D, spin) {
  if (!R) return;
  const rref = Math.max(D / 4, 4);
  const pref = Math.pow(rref, 1.5) + spin;
  const data = R.phaseData;
  for (let k = 0; k < 512; k++) {
    const r = Math.pow(10, k / 511 * 6.4);
    const Pvis = 7 * (Math.pow(r, 1.5) + spin) / pref;
    phaseState[k] = (((phaseState[k] + 2 * Math.PI * dtWall / Pvis) % PHASE_C) + PHASE_C) % PHASE_C;
    const u0 = phaseState[k] / PHASE_C;
    const u1 = (u0 + 0.5) % 1;
    data[k * 4] = u0 * PHASE_C; data[k * 4 + 1] = 1 - Math.abs(2 * u0 - 1);
    data[k * 4 + 2] = u1 * PHASE_C; data[k * 4 + 3] = 1 - Math.abs(2 * u1 - 1);
  }
}


// ------------------------------------------------------------------ per-frame uniforms
const streamU = new Float32Array(48 * 4);
let sbox = [Infinity, -Infinity, Infinity, -Infinity];
B.stream.points.forEach((p, i) => {
  streamU[i * 4] = p[0]; streamU[i * 4 + 1] = p[1]; streamU[i * 4 + 2] = p[2];
  sbox = [Math.min(sbox[0], p[0]), Math.max(sbox[1], p[0]), Math.min(sbox[2], p[1]), Math.max(sbox[3], p[1])];
});
let gMean = 0; for (const s of B.starSamples) gMean += s.g; gMean /= B.starSamples.length;
const streamG = new Float32Array(24);
for (let g = 0; g < 6; g++) {
  const pts = B.stream.points.slice(g * 8, Math.min(g * 8 + 9, 48));
  const c = [0, 0]; pts.forEach((p) => { c[0] += p[0] / pts.length; c[1] += p[1] / pts.length; });
  let rad = 0; pts.forEach((p) => { rad = Math.max(rad, Math.hypot(p[0] - c[0], p[1] - c[1])); });
  streamG.set([c[0], c[1], 0, rad + 0.045], g * 4);
}

function flowRotation(phase, tilt) {
  const cb = Math.cos(tilt), sb = Math.sin(tilt), cp = Math.cos(phase), sp = Math.sin(phase);
  // R = Rz(phase) Rx(tilt), column-major for GLSL
  const m = [
    cp, sp, 0,
    -sp * cb, cp * cb, sb,
    sp * sb, -cp * sb, cb,
  ];
  return new Float32Array(m);
}

function sampleAt(arr, dt, t) {
  const n = arr.length;
  const x = ((t / dt) % n + n) % n;
  const i = Math.floor(x), f = x - i;
  return arr[i] * (1 - f) + arr[(i + 1) % n] * f;
}

function modeUniforms() {
  const m = MODES[S.mode];
  const u = {
    uMode: m.idx, uSpin: m.a, uRcap: 1.99,   // the bending is Schwarzschild, so rays are captured at its horizon, r = 2
    uDisc: [m.rin, S.debugRout || B.rOut * B.aRg, B.hBase, B.hBulge],
    uRinT: m.rin, uTK: P.discTempK(m.M),
    uFlow: [P.TYPEC.rIn, P.TYPEC.rT, 0.3, 0.0], uFlowRot: flowRotation(0, 0),
    uBlob: new Float32Array(24), uBlobV: [0, 0, 0], uHB: [0, 0, 0, 0],
  };
  if (S.mode === 'quiet') u.uTK = P.discTempK(10);
  if (S.debugRin) { u.uDisc[0] = S.debugRin; u.uRinT = S.debugRin; }
  if (S.mode === 'typec') {
    // the same random-walking precession phase that makes the light curve, so picture and curve agree
    const ph = S.qpo && S.qpo.phase ? sampleAt(S.qpo.phase, S.qpo.dt, S.tModel) : 2 * Math.PI * P.TYPEC.nu * S.tModel;
    u.uFlowRot = flowRotation(ph, P.TYPEC.tiltDeg * Math.PI / 180);
    u.uFlow = [P.TYPEC.rIn, P.TYPEC.rT, P.TYPEC.HR, 0.3];
    u.uRinT = P.TYPEC.rT;
  } else if (S.mode === 'rpm') {
    const phs = S.qpo && S.qpo.phases;
    const st = P.rpmState(S.tModel, phs);
    const blob = new Float32Array(24);
    const lag = 0.5 / (2 * Math.PI * P.RPM.nuU) / 5;
    for (let j = 0; j < 6; j++) {
      const sj = j === 0 ? st : P.rpmState(S.tModel - j * lag, phs);
      blob[j * 4] = sj.pos[0]; blob[j * 4 + 1] = sj.pos[1]; blob[j * 4 + 2] = sj.pos[2];
      blob[j * 4 + 3] = j === 0 ? 1 : 0.55 * (1 - j / 6) ** 2;
    }
    u.uBlob = blob; u.uBlobV = st.vel;
  } else if (S.mode === 'heart' && S.qpo && S.qpo.hb) {
    const hb = S.qpo.hb;
    const L = sampleAt(hb.L, hb.dt, S.tModel) / S.qpo.mean;
    const fill = sampleAt(hb.fill, hb.dt, S.tModel);
    const env = sampleAt(hb.env, hb.dt, S.tModel);
    const tt = ((S.tModel % (hb.dt * hb.L.length)) + hb.dt * hb.L.length) % (hb.dt * hb.L.length);
    let last = -1e9; for (const p of hb.peaks) { if (p <= tt) last = p; else break; }
    const tau = tt - last;
    const ringR = tau < 2.5 ? 16 - (16 - Math.max(m.rin, 3) * 1.1) * (tau / 2.5) : 0;
    const ringA = tau < 2.5 ? 1.6 * (1 - tau / 2.5) : 0;
    u.uHB = [Math.max(0, 2.0 * env), fill, ringR, ringA];
    // spin 0.98 puts the inner edge at 1.6 GM/c^2, inside the photon sphere of the non-spinning bending used
    // here; drawn there it would fill the shadow, so the disc is drawn from 3 GM/c^2 out (said in the notes)
    u.uDisc = [Math.max(m.rin, 3.0), u.uDisc[1], u.uDisc[2], u.uDisc[3]];
    S.hbNow = { L, fill, env };
  }
  return u;
}

// ------------------------------------------------------------------ HUD: labels, black-hole marker, Earth marker
const labelEls = {};
// key, text, group, priority (lower is placed first; any label is dropped if it has no clear spot)
const LABELS = [
  ['star', 'Companion star', 'binary', 1], ['disc', 'Accretion disc', 'binary', 2],
  ['spot', 'Bright spot: the stream hits the disc', 'binary', 3], ['stream', 'Gas stream', 'binary', 4], ['l1', 'L1 point', 'binary', 5],
  ['circ', 'Circularisation radius', 'disc', 6],
  ['shadow', 'Shadow: light that came this close fell in', 'inner', 1],
  ['lensTop', 'Far side of the disc, bent over the top', 'inner', 2], ['lensBot', 'Underside of the far disc, bent below', 'edge', 3],
  ['ring', 'Photon ring', 'ring', 3],
  ['approach', 'Coming toward you: brighter, bluer', 'inner', 5], ['recede', 'Moving away: dimmer, redder', 'inner', 5],
  ['flow', 'Hot inner flow, tilted 20° and wobbling', 'typec', 6], ['blob', 'Hot blob: flashes brightest here', 'rpm', 2],
  ['flare', 'Inner disc: fills up, then flares', 'heart', 2], ['jet', 'Jet', 'jet', 4],
  ['farstar', 'Companion star', 'far', 1],
];
const SVGNS = 'http://www.w3.org/2000/svg';
const leaderSvg = document.createElementNS(SVGNS, 'svg');
leaderSvg.setAttribute('class', 'xrb-leaders');
$('xrb-labels').appendChild(leaderSvg);
function makeLeader() {
  const g = document.createElementNS(SVGNS, 'g');
  const line = document.createElementNS(SVGNS, 'line');
  const dot = document.createElementNS(SVGNS, 'circle');
  dot.setAttribute('r', '2.4');
  g.append(line, dot);
  leaderSvg.appendChild(g);
  return { g, line, dot };
}
for (const [k, text] of LABELS) {
  const el = document.createElement('span');
  el.className = 'xrb-label' + (k === 'recede' || k === 'approach' ? ' xrb-label-soft' : '');
  el.textContent = text;
  $('xrb-labels').appendChild(el);
  labelEls[k] = el;
  el._lead = makeLeader();
}
const bhLead = makeLeader();
bhLead.dot.setAttribute('r', '0');
function labelPoints(cam) {
  const phi = 2 * Math.PI * S.orbitPhase, a = B.aRg;
  const rotp = (x, y, z = 0) => [a * (x * Math.cos(phi) - y * Math.sin(phi)), a * (x * Math.sin(phi) + y * Math.cos(phi)), a * z];
  const sp = B.stream.points;
  const fh = Math.hypot(cam.F[0], cam.F[1]) || 1;
  const u = [-cam.F[0] / fh, -cam.F[1] / fh];             // horizontal direction toward the camera
  const rApp = [u[1], -u[0]];                               // gas here moves toward the camera
  const shadowR = 5.2 * Math.hypot(cam.D, 5.2) / cam.D;
  const rLab = Math.max(16, MODES[S.mode].rin * 1.35);   // on the disc, outside a truncated inner edge
  const pts = {
    star: rotp(1, 0, 0.23), l1: rotp(B.xL1, 0, 0.0), stream: rotp(sp[20][0], sp[20][1], 0.02),
    spot: rotp(sp[47][0], sp[47][1], 0.03), disc: rotp(-B.rOut * 0.75, -B.rOut * 0.45, 0.02),
    circ: rotp(B.rCirc * Math.cos(2.2), B.rCirc * Math.sin(2.2), 0),
    lensTop: cam.U.map((v) => v * shadowR * 1.55), lensBot: cam.U.map((v) => -v * shadowR * 1.25),
    shadow: cam.R.map((v, i) => v * shadowR * 0.62 + cam.U[i] * shadowR * 0.35),
    approach: [rApp[0] * rLab, rApp[1] * rLab, 0], recede: [-rApp[0] * rLab, -rApp[1] * rLab, 0],
    flare: [u[0] * 6 - rApp[0] * 5, u[1] * 6 - rApp[1] * 5, 0.5],
    jet: [0, 0, 26],
  };
  // photon ring: apparent radius sqrt(27) GM/c^2 in impact parameter, put the anchor at its upper right
  const ringR = 5.196 * cam.D / Math.sqrt(Math.max(cam.D * cam.D - 27, 1));
  pts.ring = cam.R.map((v, i) => (v * Math.cos(0.75) + cam.U[i] * Math.sin(0.75)) * ringR);
  const m = S.uNow;
  if (m && S.mode === 'typec') {
    const f = m.uFlowRot;  // column-major body->world
    const rt = P.TYPEC.rT;
    // anchor on the flow's outer hoop where it reaches furthest toward the upper right of the screen; that
    // point drifts slowly as the flow precesses, where a point fixed to the flow would race around
    const dsc = cam.U.map((v, i) => v * Math.cos(0.6) + cam.R[i] * Math.sin(0.6));
    const e1 = [f[0], f[1], f[2]], e2 = [f[3], f[4], f[5]];
    const th = Math.atan2(e2[0] * dsc[0] + e2[1] * dsc[1] + e2[2] * dsc[2], e1[0] * dsc[0] + e1[1] * dsc[1] + e1[2] * dsc[2]);
    pts.flow = e1.map((v, i) => rt * (Math.cos(th) * v + Math.sin(th) * e2[i]));
    pts.flowAlts = [];
    if (cam.D < 45) {
      // this close the hoop sweeps right across the picture, so the label marks the glowing fog itself,
      // at a fixed spot 10 GM/c^2 up and to the left of the hole, and stays still
      pts.flow = cam.R.map((v, i) => (-0.72 * v + 0.69 * cam.U[i]) * 10);
      pts.flowAlts = null;
    } else {
      for (let j = 1; j < 24; j++) { const dth = 2 * Math.PI * j / 24; pts.flowAlts.push(e1.map((v, i) => rt * (Math.cos(th + dth) * v + Math.sin(th + dth) * e2[i]))); }
    }
  }
  // the blob laps the hole once a second on screen, too fast for a label to follow, so the label marks
  // the point of its orbit where it flashes brightest, on the side moving toward the camera
  if (S.mode === 'rpm') pts.blob = [rApp[0] * P.RPM.r0, rApp[1] * P.RPM.r0, 0];
  pts.farstar = rotp(1, 0, 0.26);
  return pts;
}
// Greedy label placement, highest priority first. Each label tries positions around its anchor and
// takes the best one that breaks none of the hard rules: inside the picture, clear of the HUD, of every
// label and leader already placed, of other labels' anchor dots and of the black-hole shadow, with its own
// leader crossing nothing. Among those it prefers short leaders, dark background and last frame's spot.
// A label with no legal spot is dropped (and stays off for a moment, so it doesn't flicker).
const CANDS = [];
const MOVING = new Set(['flow', 'farstar']);   // anchors that move on their own: placed after the rest, long leaders allowed
for (const d of [8, 24, 44, 70, 100, 140, 190]) for (const a of [-35, 35, -145, 145, 0, 180, -90, 90, -62, 62, -118, 118, -15, 15, -165, 165]) CANDS.push([a * Math.PI / 180, d]);
let hudRects = [], hudT = 0;
function relRect(el, pad = 4) {
  if (!el || el.hidden || el.offsetParent === null) return null;
  const s = stage.getBoundingClientRect(), r = el.getBoundingClientRect();
  if (!r.width) return null;
  return [r.left - s.left - pad, r.top - s.top - pad, r.right - s.left + pad, r.bottom - s.top + pad];
}
function overlap(a, b) {
  const w = Math.min(a[2], b[2]) - Math.max(a[0], b[0]), h = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
  return w > 0 && h > 0 ? w * h : 0;
}
// does the segment p -> q pass through box b? (Liang-Barsky clipping)
function segBox(px, py, qx, qy, b) {
  let t0 = 0, t1 = 1;
  const dx = qx - px, dy = qy - py;
  const edges = [[-dx, px - b[0]], [dx, b[2] - px], [-dy, py - b[1]], [dy, b[3] - py]];
  for (const [pp, qq] of edges) {
    if (pp === 0) { if (qq < 0) return false; continue; }
    const t = qq / pp;
    if (pp < 0) { if (t > t1) return false; if (t > t0) t0 = t; } else { if (t < t0) return false; if (t < t1) t1 = t; }
  }
  return t1 - t0 > 1e-3;
}
function segSeg(a, b) {
  const d = (b[2] - b[0]) * (a[3] - a[1]) - (b[3] - b[1]) * (a[2] - a[0]);
  if (Math.abs(d) < 1e-9) return false;
  const u = ((b[0] - a[0]) * (a[3] - a[1]) - (b[1] - a[1]) * (a[2] - a[0])) / d;
  const t = ((b[0] - a[0]) * (b[3] - b[1]) - (b[1] - a[1]) * (b[2] - b[0])) / d;
  return t > 0.001 && t < 0.999 && u > 0.001 && u < 0.999;
}
// does the segment a (x1, y1, x2, y2) pass through circle c (x, y, r)?
function segCircle(a, c) {
  if (!c) return false;
  const dx = a[2] - a[0], dy = a[3] - a[1], l2 = dx * dx + dy * dy || 1;
  const t = clamp(((c[0] - a[0]) * dx + (c[1] - a[1]) * dy) / l2, 0, 1);
  return Math.hypot(a[0] + t * dx - c[0], a[1] + t * dy - c[1]) < c[2];
}
function circleBox(c, b) {
  if (!c) return false;
  const nx = Math.min(Math.max(c[0], b[0]), b[2]), ny = Math.min(Math.max(c[1], b[1]), b[3]);
  return Math.hypot(nx - c[0], ny - c[1]) < c[2];
}
// summed-area table of the picture's brightness, so the mean under any box is four lookups
let lumaSat = null, lumaT = 0;
function lumaUpdate() {
  const L = R && R.luma;
  if (!L || L.t === lumaT) return;
  lumaT = L.t;
  const W = L.W, H = L.H, sat = new Float32Array((W + 1) * (H + 1));
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) sat[(y + 1) * (W + 1) + x + 1] = L.v[y * W + x] + sat[y * (W + 1) + x + 1] + sat[(y + 1) * (W + 1) + x] - sat[y * (W + 1) + x];
  lumaSat = { W, H, sat };
}
function lumaMean(b) {
  if (!lumaSat) return 0;
  const { W, H, sat } = lumaSat;
  const x0 = clamp(Math.floor(b[0] / VIEW.w * W), 0, W), x1 = clamp(Math.ceil(b[2] / VIEW.w * W), 0, W);
  const y0 = clamp(Math.floor(b[1] / VIEW.h * H), 0, H), y1 = clamp(Math.ceil(b[3] / VIEW.h * H), 0, H);
  if (x1 <= x0 || y1 <= y0) return 0;
  const tot = sat[y1 * (W + 1) + x1] - sat[y0 * (W + 1) + x1] - sat[y1 * (W + 1) + x0] + sat[y0 * (W + 1) + x0];
  return tot / ((x1 - x0) * (y1 - y0));
}
function hideItem(it) {
  if (it.el.style.opacity !== '0') it.el.style.opacity = '0';
  if (it.lead.g.style.opacity !== '0') it.lead.g.style.opacity = '0';
  it.el._box = null; it.el._anchor = null;
}
let remPx = 0;
const REM = () => remPx || (remPx = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16);
function layoutLabels(items, keepOut, er) {
  const now = performance.now();
  if (now - hudT > 400) {
    hudT = now;
    hudRects = ['.xrb-scale', '.xrb-clock', '#xrb-prompt', '#xrb-gauge', '#xrb-wheelhint.is-on'].map((q) => relRect(stage.querySelector(q))).filter(Boolean);
  }
  lumaUpdate();
  const boxes = er ? [...hudRects, er] : hudRects.slice();
  const leaders = [];
  // other labels' anchor dots are off limits, except those of moving anchors, which would chase the rest around
  const dots = items.filter((it) => !MOVING.has(it.k)).map((it) => [it.ax - 5, it.ay - 5, it.ax + 5, it.ay + 5, it]);
  items.sort((a, b) => a.pri - b.pri);
  const maxPri = VIEW.w < 560 ? 3 : 9;   // phones get the few labels that matter most
  const W = VIEW.w, H = VIEW.h;
  S.labelsShown = [];
  for (const it of items) {
    const el = it.el;
    if (it.pri > maxPri || (el._dropT && now - el._dropT < 600)) { hideItem(it); continue; }
    if (!el._w || el._wT !== el.textContent.length) { el._w = el.offsetWidth; el._h = el.offsetHeight; el._wT = el.textContent.length; }
    const w = el._w, h = el._h;
    const dbg = S.dbgLab ? (S.dbgLab[it.k] = { edge: 0, box: 0, dot: 0, keep: 0, lead: 0, w, h, ax: Math.round(it.ax), ay: Math.round(it.ay), ko: keepOut && keepOut.map(Math.round) }) : null;
    let best = null, bestScore = Infinity, bestIdx = -1, bestLead = null;
    // Last frame's spot gets a large bonus while it is still legal, so labels don't hop about. For a moving
    // anchor that spot is the same place on screen (candidate -1), so its leader swings and the text stays put.
    const prev = MOVING.has(it.k) && el._box && el._boxW === w ? el._box : null;
    // a label can offer other anchor points (the flow's hoop): they are tried in order, at a cost
    const anchors = it.alts && it.alts.length ? it.alts : [[it.ax, it.ay]];
    let bestA = 0;
    // pass 0 tries only last frame's spot and keeps it if it is still legal (cheap, and steady);
    // pass 1, the full search, runs only when it isn't
    const sticky = prev ? -1 : el._cand >= 0 ? el._cand : null;
    for (let pass = sticky === null ? 1 : 0; pass < 2 && !best; pass++) {
    const nC = pass === 0 ? 1 : CANDS.length + (prev ? 1 : 0);
    for (let ai = 0; ai < anchors.length; ai++) {
    const ax = anchors[ai][0], ay = anchors[ai][1];
    // the anchor costs its distance from last frame's anchor (continuity), or from the preferred one
    const aRef = el._anchor || anchors[0];
    const aPen = anchors.length > 1 ? 0.35 * Math.hypot(ax - aRef[0], ay - aRef[1]) : 0;
    for (let ci = 0; ci < nC; ci++) {
      const c = pass === 0 ? sticky : ci - (prev ? 1 : 0);
      let x0, y0;
      if (c < 0) { x0 = prev[0]; y0 = prev[1]; }
      else {
        const [ang, d0] = CANDS[c];
        const d = d0 + it.gap;
        const cx = Math.cos(ang), cy = Math.sin(ang);
        const px = ax + cx * d, py = ay + cy * d;
        // a label that would stick out of the picture slides back in along the edge, as long as it then
        // doesn't cover its own anchor
        x0 = clamp(cx > 0.3 ? px : cx < -0.3 ? px - w : px - w / 2, 6, W - 6 - w);
        y0 = clamp(cy > 0.3 ? py : cy < -0.3 ? py - h : py - h / 2, 6, H - 6 - h);
      }
      const box = [x0, y0, x0 + w, y0 + h];
      if (w > W - 12 || h > H - 12 || overlap([x0 - 3, y0 - 3, box[2] + 3, box[3] + 3], [ax - 4, ay - 4, ax + 4, ay + 4]) > 0) { if (dbg) dbg.edge++; continue; }
      const padded = [box[0] - 5, box[1] - 4, box[2] + 5, box[3] + 4];
      let bad = false;
      for (const r of boxes) if (overlap(padded, r) > 0) { bad = true; break; }
      if (bad) { if (dbg) dbg.box++; continue; }
      for (const dd of dots) if (dd[4] !== it && overlap(padded, dd) > 0) { bad = true; break; }
      if (bad || (it.k !== 'bh' && circleBox(keepOut, padded))) { if (dbg) dbg[bad ? 'dot' : 'keep']++; continue; }
      // leader from the anchor to the nearest point of the box
      const nx = Math.min(Math.max(ax, box[0]), box[2]), ny = Math.min(Math.max(ay, box[1] + 2), box[3] - 2);
      const L = Math.hypot(nx - ax, ny - ay);
      const seg = [ax, ay, nx, ny];
      // a leader from outside the shadow doesn't cut across it
      if (L > 6 && keepOut && it.k !== 'bh' && Math.hypot(ax - keepOut[0], ay - keepOut[1]) > keepOut[2] && segCircle(seg, keepOut)) bad = true;
      if (L > 6 && !bad) {
        for (const r of boxes) if (segBox(seg[0], seg[1], seg[2], seg[3], r)) { bad = true; break; }
        if (!bad) for (const l of leaders) if (segSeg(seg, l)) { bad = true; break; }
      }
      if (!bad) for (const l of leaders) if (segBox(l[0], l[1], l[2], l[3], padded)) { bad = true; break; }
      if (bad) { if (dbg) dbg.lead++; continue; }
      if (c < 0 && (L > (MOVING.has(it.k) ? 320 : 150) || x0 < 6 || y0 < 6 || box[2] > W - 6 || box[3] > H - 6)) continue;
      // keeping the text still matters more than which hoop point the leader goes to, so the old spot
      // pays no anchor cost
      const score = L * 0.55 + (c < 0 ? -60 : aPen) + (!prev && c === el._cand ? -60 : 0) + lumaMean(padded) * 90;
      if (score < bestScore) { bestScore = score; best = box; bestIdx = c; bestLead = seg; bestA = ai; }
    }
    }
    }
    if (!best) { el._dropT = now; el._cand = -1; el._box = null; hideItem(it); continue; }
    el._dropT = 0;
    if (bestIdx >= 0) el._cand = bestIdx;
    el._box = best; el._boxW = w;
    it.ax = anchors[bestA][0]; it.ay = anchors[bestA][1]; el._anchor = [it.ax, it.ay];
    boxes.push([best[0] - 3, best[1] - 2, best[2] + 3, best[3] + 2]);
    const Lb = Math.hypot(bestLead[2] - bestLead[0], bestLead[3] - bestLead[1]);
    if (Lb > 6) leaders.push(bestLead);
    S.labelsShown.push({ k: it.k, box: best.map(Math.round), lead: bestLead.map(Math.round) });
    const tx = best[0] - (it.k === 'bh' ? it.ax : 0), ty = best[1] - (it.k === 'bh' ? it.ay : 0);
    // write to the page only what changed
    const tf = `translate(${tx.toFixed(1)}px, ${ty.toFixed(1)}px)`, op = it.k === 'bh' ? '1' : String(+it.o.toFixed(2));
    if (el._tf !== tf) { el._tf = tf; el.style.transform = tf; }
    if (el.style.opacity !== op) el.style.opacity = op;
    const r0 = it.k === 'bh' ? 14 : 2.5;
    const g = it.lead;
    const gop = String(+it.o.toFixed(2));
    if (g.g.style.opacity !== gop) g.g.style.opacity = gop;
    let key = it.ax.toFixed(1) + ',' + it.ay.toFixed(1);
    let geo = null;
    if (Lb > r0 + 4) {
      const ux = (bestLead[2] - it.ax) / Lb, uy = (bestLead[3] - it.ay) / Lb;
      geo = [(it.ax + ux * r0).toFixed(1), (it.ay + uy * r0).toFixed(1), (bestLead[2] - ux * 2).toFixed(1), (bestLead[3] - uy * 2).toFixed(1)];
      key += ',' + geo.join(',');
    }
    if (g._key !== key) {
      g._key = key;
      g.dot.setAttribute('cx', it.ax.toFixed(1)); g.dot.setAttribute('cy', it.ay.toFixed(1));
      if (geo) {
        g.line.setAttribute('x1', geo[0]); g.line.setAttribute('y1', geo[1]); g.line.setAttribute('x2', geo[2]); g.line.setAttribute('y2', geo[3]);
        g.line.style.display = '';
      } else g.line.style.display = 'none';
    }
  }
}
function updateLabels(cam) {
  const pts = labelPoints(cam);
  const ld = S.cam.logD;
  const on = S.labels && S.collapse < 0.05;
  const vis = {
    binary: smooth(4.35, 4.85, ld), disc: smooth(4.5, 4.9, ld) * (1 - smooth(5.3, 5.45, ld)),
    inner: 1 - smooth(1.75, 2.1, ld),
    edge: (1 - smooth(1.75, 2.1, ld)) * (1 - smooth(0.07, 0.14, Math.abs(S.cam.el))),
    ring: 1 - smooth(1.62, 1.8, ld),
    typec: S.mode === 'typec' ? 1 - smooth(2.2, 2.6, ld) : 0,
    rpm: S.mode === 'rpm' ? 1 - smooth(2.2, 2.6, ld) : 0,
    heart: S.mode === 'heart' ? 1 - smooth(2.2, 2.6, ld) : 0,
    jet: S.jet ? 1 - smooth(2.4, 3.0, ld) : 0,
    far: 1 - smooth(2.3, 2.8, ld),
  };
  // what to place this frame: the black-hole note first, then labels by priority
  const items = [];
  const bh = $('xrb-bh');
  const bvis = smooth(3.4, 3.9, ld) * (S.collapse < 0.05 ? 1 : 0);
  const bs = bvis > 0.01 ? project(cam, [0, 0, 0]) : null;
  if (bs) {
    bh.style.transform = `translate(${bs[0].toFixed(1)}px, ${bs[1].toFixed(1)}px)`;
    bh.style.opacity = String(bvis);
    bh.hidden = false;
    const upp = 2 * cam.D * cam.tanFov / Math.max(VIEW.h, 1);
    const horizonRg = 2 * P.rHorizon(MODES[S.mode].a);
    const frac = upp / horizonRg;
    const key = Math.round(Math.log10(frac) * 10);
    const note = $('xrb-bh-note');
    if (key !== S.bhKey) {
      S.bhKey = key;
      note.innerHTML = `<strong>Black hole</strong> ${Math.round(horizonRg * RG_KM)} km across, 1/${fmtInt(+frac.toPrecision(2))} of a pixel at this zoom. Click to zoom in.`;
      note._w = 0;
    }
    items.push({ k: 'bh', el: note, lead: bhLead, ax: bs[0], ay: bs[1], o: bvis, pri: 0, gap: 16 });
  } else { bh.style.opacity = '0'; bh.hidden = bvis <= 0.01; bhLead.g.style.opacity = '0'; }
  for (const [k, , group, pri] of LABELS) {
    const el = labelEls[k];
    const o = on ? vis[group] : 0;
    const p = pts[k];
    const skip = S.mode === 'typec' && (k === 'lensTop' || k === 'lensBot');   // the truncated disc's arch is far out there
    let s = o > 0.3 && p && !skip ? project(cam, p) : null;   // half-faded labels read as glitches, so skip them
    if (k === 'farstar' && s) {
      // the companion is ~12 degrees across from here, so pin the label inside the visible part of it
      const dist = Math.hypot(p[0] - cam.pos[0], p[1] - cam.pos[1], p[2] - cam.pos[2]);
      const rpx = RSTAR_RG / dist / cam.tanFov * VIEW.h / 2;
      const cx = clamp(s[0], 60, VIEW.w - 60), cy = clamp(s[1], 60, VIEW.h - 60);
      s = Math.hypot(cx - s[0], cy - s[1]) < rpx * 0.8 ? [cx, cy] : null;
      const t = S.view === 'behind' ? 'Companion star, behind the hole' : `Companion star, ${(B.aRg * RG_KM / 1e6).toFixed(1)} million km away`;
      if (el.textContent !== t) el.textContent = t;
    }
    const onScreen = (q) => q && q[0] > 8 && q[0] < VIEW.w - 8 && q[1] > 8 && q[1] < VIEW.h - 8;
    let alts = null;
    if (k === 'flow' && s && pts.flowAlts) {
      // the flow's hoop: any on-screen point of it will do as an anchor, the preferred one first
      alts = [s, ...pts.flowAlts.map((q) => project(cam, q))].filter(onScreen);
      if (alts.length) s = alts[0];
    }
    if (!onScreen(s)) { hideItem({ el, lead: el._lead }); continue; }
    items.push({ k, el, lead: el._lead, ax: s[0], ay: s[1], o, pri, gap: 7, alts });
  }
  // keep label boxes off the shadow (and the thin ring around it), the thing most worth seeing up close
  let keepOut = null;
  if (ld < 2.3) {
    const c0 = project(cam, [0, 0, 0]);
    const ringR = 5.196 * cam.D / Math.sqrt(Math.max(cam.D * cam.D - 27, 1));
    const e1 = project(cam, cam.R.map((v) => v * ringR * 1.08));
    if (c0 && e1) keepOut = [c0[0], c0[1], Math.hypot(e1[0] - c0[0], e1[1] - c0[1])];
  }
  // Earth marker: direction to the observer, pinned to the stage edge if off screen
  const e = $('xrb-earth');
  const i = S.incl * Math.PI / 180;
  const n = [Math.sin(i), 0, Math.cos(i)];
  const dx = n[0] * cam.R[0] + n[1] * cam.R[1] + n[2] * cam.R[2];
  const dy = n[0] * cam.U[0] + n[1] * cam.U[1] + n[2] * cam.U[2];
  const dz = n[0] * cam.F[0] + n[1] * cam.F[1] + n[2] * cam.F[2];
  const w = VIEW.w, h = VIEW.h;
  let sx, sy;
  if (dz > 0.02) { sx = dx / dz / (cam.tanFov * cam.aspect); sy = dy / dz / cam.tanFov; }
  else { const l = Math.hypot(dx, dy) || 1; sx = dx / l * 4; sy = dy / l * 4; }
  const facing = dz < -0.985;
  const mm = Math.max(Math.abs(sx), Math.abs(sy));
  if (mm > 0.84) { sx = sx / mm * 0.84; sy = sy / mm * 0.84; }
  const ex = (sx * 0.5 + 0.5) * w, ey = (0.5 - sy * 0.5) * h;
  const etf = `translate(${ex.toFixed(1)}px, ${ey.toFixed(1)}px)`;
  if (e._tf !== etf) { e._tf = etf; e.style.transform = etf; }
  // "You are looking from Earth" only in the Earth view. Another view that happens to look from close to
  // Earth's direction (edge-on at a high inclination) has Earth behind the camera, so the marker hides.
  const here = facing && S.view === 'earth' && S.collapseGoal < 0.5;
  if (e._here !== here) { e._here = here; e.classList.toggle('is-here', here); }
  const et = here ? 'You are looking from Earth' : 'To Earth';
  if (e.textContent !== et) { e.textContent = et; e._w = 0; }
  const eo = S.collapse > 0.05 || (facing && !here) ? '0' : '1';
  if (e.style.opacity !== eo) { e.style.opacity = eo; e.style.pointerEvents = eo === '1' ? '' : 'none'; }
  // its box for the label layout, worked out here instead of read back from the page (which would force a
  // layout every frame): the CSS offsets it by -1.6rem, -0.7rem, or pins it top centre when facing
  if (!e._w) { e._w = e.offsetWidth; e._h = e.offsetHeight; }
  const rem = REM();
  const ex0 = here ? w / 2 - e._w / 2 : ex - 1.6 * rem, ey0 = here ? rem : ey - 0.7 * rem;
  const earthRect = eo === '1' ? [ex0 - 3, ey0 - 3, ex0 + e._w + 3, ey0 + e._h + 3] : null;
  layoutLabels(items, keepOut, earthRect);
}

function niceLen(x) {
  const e = Math.pow(10, Math.floor(Math.log10(x)));
  const m = x / e;
  return (m >= 5 ? 5 : m >= 2 ? 2 : 1) * e;
}
const fmtInt = (v) => v >= 1000 ? Math.round(v).toLocaleString('en-US') : String(+v.toPrecision(3));
function updateScaleBar(cam) {
  const upp = 2 * cam.D * cam.tanFov / Math.max(VIEW.h, 1); // R_g per CSS px at target
  const km = 110 * upp * RG_KM;
  let label, px;
  if (km > 0.5 * RSUN_KM) {
    const L = niceLen(km / RSUN_KM); px = L * RSUN_KM / (upp * RG_KM);
    label = `${fmtInt(L)} R☉ = ${fmtInt(L * RSUN_KM)} km`;
  } else {
    const L = niceLen(km); px = L / (upp * RG_KM);
    label = `${fmtInt(L)} km = ${fmtInt(L / RG_KM)} GM/c²`;
  }
  const pxs = px.toFixed(0) + 'px';
  if (S.barPx !== pxs) { S.barPx = pxs; $('xrb-bar').style.width = pxs; }
  if (S.barLabel !== label) { S.barLabel = label; $('xrb-bar-label').innerHTML = label; }
  const ld = S.cam.logD;
  const key = ld > 5.4 ? 'binary' : ld > 3.6 ? 'disc' : ld > 1.7 ? 'inner' : 'horizon';
  if (key !== S.lastScale) {
    S.lastScale = key;
    $('xrb-scale-name').textContent = SCALES[key].name;
    pressGroup('[data-scale]', key, 'scale');
  }
  return key;
}

function clockText(inner) {
  if (!S.playing) return 'Paused';
  if (!inner) return VIEW.w < 480 ? `${(B.P / 3600).toFixed(1)} h orbit in ${ORBIT_WALL_S} s` : `${(B.P / 3600).toFixed(1)} h orbit shown in ${ORBIT_WALL_S} s`;
  if (S.mode === 'rpm') return `Slowed ${P.RPM.slow}×`;
  if (S.mode === 'heart') return `Sped up ${MODES.heart.speed}×`;
  return 'Real time';
}

// ------------------------------------------------------------------ charts
function drawCharts(inner) {
  if (!inner) {
    $('xrb-lc-title').textContent = `Light curve seen from Earth, inclination ${S.incl}°`;
    $('xrb-psd-title').textContent = 'Where the optical light comes from';
    $('xrb-psd-reset').hidden = true;
    const lc = S.lc;
    if (!lc) return;
    const n = lc.opt.length;
    const t = new Float64Array(2 * n + 1), yo = new Float64Array(2 * n + 1), yx = new Float64Array(2 * n + 1);
    for (let k = 0; k <= 2 * n; k++) { t[k] = k / n; yo[k] = lc.opt[k % n]; yx[k] = lc.xr[k % n]; }
    const notes = [];
    // mark the X-ray eclipse if there is one
    if (lc.xr[0] < 0.2) {
      let a = 0, b = 0;
      while (a < n / 2 && lc.xr[(n - a - 1) % n] < 0.5) a++;
      while (b < n / 2 && lc.xr[b] < 0.5) b++;
      const w0 = -a / n, w1 = b / n;
      if (w1 - w0 < 0.5) for (const c of [0, 1, 2]) notes.push({ x0: c + w0, x1: c + w1, label: c === 1 ? 'eclipse' : '' });
    }
    const ph = S.orbitPhase;
    drawLightCurve(lcCanvas, {
      series: [{ t, y: yo, color: COLORS.optical, width: 1.8 }, { t, y: yx, color: COLORS.xray, width: 1.6 }],
      xRange: [0, 2], yRange: [0, 1.08], xLabel: 'orbital phase', cursor: ph < 1 ? ph + (ph < 0.5 ? 1 : 0) : ph,
      legend: [{ color: COLORS.optical, label: 'optical' }, { color: COLORS.xray, label: 'X-rays' }], notes,
    });
    const pr = lc.parts;
    let m = 0; for (let k = 0; k < n; k++) m = Math.max(m, pr.star[k] + pr.disc[k] + pr.spot[k]);
    const ys = new Float64Array(2 * n + 1), yd = new Float64Array(2 * n + 1), yp = new Float64Array(2 * n + 1);
    for (let k = 0; k <= 2 * n; k++) { ys[k] = pr.star[k % n] / m; yd[k] = pr.disc[k % n] / m; yp[k] = pr.spot[k % n] / m; }
    drawLightCurve(psdCanvas, {
      series: [{ t, y: yd, color: '#e2745a', width: 1.6 }, { t, y: ys, color: '#f6cf7a', width: 1.6 }, { t, y: yp, color: '#f4f1ea', width: 1.4 }],
      xRange: [0, 2], yRange: [0, Math.max(0.2, Math.min(1.05, Math.max(...yd, ...ys) * 1.15))], xLabel: 'orbital phase', cursor: ph + (ph < 0.5 ? 1 : 0),
      legend: [{ color: '#e2745a', label: 'disc' }, { color: '#f6cf7a', label: 'star' }, { color: '#f4f1ea', label: 'bright spot' }],
    });
    return;
  }
  const q = S.qpo;
  if (!q) return;
  const m = MODES[S.mode];
  const names = { quiet: 'plain disc', typec: 'Type-C QPO model', rpm: 'high-frequency QPO model', heart: 'heartbeat model' };
  $('xrb-lc-title').textContent = `X-ray light curve, ${names[S.mode]}`;
  $('xrb-psd-title').textContent = 'Power spectrum, building up';
  $('xrb-psd-reset').hidden = false;
  const W = m.win, n = Math.round(W / q.dt);
  const t = new Float64Array(n), y = new Float64Array(n);
  let lo = Infinity, hi = -Infinity;
  const total = q.x.length;
  const iEnd = Math.floor(S.tModel / q.dt);
  for (let k = 0; k < n; k++) {
    const idx = iEnd - n + 1 + k;
    const v = q.x[((idx % total) + total) % total];
    t[k] = (idx) * q.dt; y[k] = v;
    if (v < lo) lo = v; if (v > hi) hi = v;
  }
  const unit = S.mode === 'rpm' ? 1000 : 1;
  for (let k = 0; k < n; k++) t[k] *= unit;
  const pad = (hi - lo) * 0.1 + 0.02;
  S.yr = S.yr ? [S.yr[0] + (lo - pad - S.yr[0]) * 0.1, S.yr[1] + (hi + pad - S.yr[1]) * 0.1] : [lo - pad, hi + pad];
  drawLightCurve(lcCanvas, {
    series: [{ t, y, color: COLORS.xray, width: S.mode === 'rpm' ? 1.1 : 1.4 }],
    xRange: [t[0], t[n - 1]], yRange: S.yr, xLabel: S.mode === 'rpm' ? 'time (ms)' : 'time (s)',
  });
  const spec = S.welch && S.welch.count ? S.welch.spectrum(S.mode === 'rpm' ? 90 : 70) : null;
  const mk = {
    quiet: [],
    typec: [{ f: P.TYPEC.nu, label: `ν_prec ${P.TYPEC.nu.toFixed(2)} Hz` }, { f: 2 * P.TYPEC.nu, label: '2ν' }],
    rpm: [{ f: P.RPM.nuC, label: `ν_C ${P.RPM.nuC.toFixed(1)}` }, { f: P.RPM.nuL, label: `ν_L ${Math.round(P.RPM.nuL)}` }, { f: P.RPM.nuU, label: `ν_U ${Math.round(P.RPM.nuU)} Hz` }],
    heart: [{ f: 1 / q.period, label: `1/${Math.round(q.period)} s` }, { f: 2 / q.period, label: '2×' }, { f: 3 / q.period, label: '3×' }],
  }[S.mode];
  const expo = S.segDone * q.seg * q.dt;
  const segTotal = Math.floor(q.x.length / q.seg);
  const note = S.segDone ? `${fmtInt(Math.round(expo))} s of simulated data, ${S.segDone} segment${S.segDone > 1 ? 's' : ''}${S.segDone >= segTotal ? ' (all of it)' : ''}` : 'collecting the first segment';
  drawPsd(psdCanvas, { spec, fRange: m.fRange, markers: mk, note });
}

// ------------------------------------------------------------------ caption, live narration, next-step prompt
function updateCaption(scale) {
  const inner = scale === 'inner' || scale === 'horizon';
  const key = inner ? `${scale}:${S.mode}` : `${scale}`;
  if (key === S.lastCaptionKey) return;
  S.lastCaptionKey = key;
  const c = inner ? COPY.modes[S.mode] : COPY.scales[scale];
  const extra = inner && scale === 'horizon' ? COPY.scales.horizon : '';
  $('xrb-caption-body').innerHTML = `<h3>${c.title}</h3>${c.body}${extra ? `<p class="xrb-caption-extra">${extra}</p>` : ''}`;
  canvas.setAttribute('aria-label', c.alt);
}

const pct = (x) => (x * 100 < 10 ? (x * 100).toFixed(1) : Math.round(x * 100)) + '%';
// Peak over continuum: the mean power within half a peak width of f0, over a power law fitted (in log-log)
// to the bins between f0/2 and 2 f0 that are clear of this peak and of the other QPO frequencies.
function peakRatio(f0, fwhm, others = []) {
  const w = S.welch;
  if (!w || !w.count) return null;
  const df = 1 / (w.seg * w.dt);
  const clear = (f) => Math.abs(f - f0) > 1.5 * fwhm && others.every((o) => Math.abs(f - o.f) > 1.5 * o.fwhm);
  let n = 0, sx = 0, sy = 0, sxx = 0, sxy = 0, pk = 0, np = 0;
  for (let k = 1; k < w.sum.length; k++) {
    const f = k * df, p = w.sum[k] / w.count;
    if (p <= 0) continue;
    if (Math.abs(f - f0) <= Math.max(fwhm / 2, df)) { pk += p; np++; }
    if (f < f0 / 2 || f > 2 * f0 || !clear(f)) continue;
    const x = Math.log(f), y = Math.log(p);
    n++; sx += x; sy += y; sxx += x * x; sxy += x * y;
  }
  if (n < 4 || !np) return null;
  const b = (n * sxy - sx * sy) / Math.max(n * sxx - sx * sx, 1e-12), a = (sy - b * sx) / n;
  // a log-space fit sits below the mean of chi-squared scatter by exp(-0.577/M) for M averaged segments
  const cont = Math.exp(a + b * Math.log(f0) + 0.5772 / Math.max(w.count, 1));
  return pk / np / cont;
}
const RE_RG = Math.sqrt(4 * B.aRg);              // Einstein radius at the companion's distance, R_g
const RSTAR_RG = B.rVolEq * B.aRg;
function narrate(scale) {
  const i = S.incl;
  let t = '';
  if (S.collapse > 0.5) {
    t = 'Telescope view. The whole system has shrunk to the one point of light a telescope gets, and its brightness follows the light curve below.';
  } else if (scale === 'binary' || scale === 'disc') {
    const lc = S.lc;
    if (!lc) { t = 'Working out the light curve for this inclination.'; }
    else {
      const n = lc.xr.length;
      let ecl = 0, dip = 0, rimAll = 0, xm = 0, omin = 1;
      for (let k = 0; k < n; k++) {
        if (lc.xStar[k]) ecl++; else if (lc.xRim[k] < 0.5) dip++;
        if (lc.xRim[k] < 0.5) rimAll++;
        xm += lc.xr[k] / n; omin = Math.min(omin, lc.opt[k]);
      }
      const e = ecl / n, d = dip / n, amp = pct(1 - omin);
      if (rimAll === n) t = `From ${i}° the disc rim hides the X-ray source all the time, so only ${pct(xm)} of the X-rays, from a faint corona above the disc, get through. The optical light swings by ${amp}.`;
      else if (e > 0) t = `From ${i}° the star hides the X-ray source for ${pct(e)} of every orbit (${Math.round(e * B.P / 60)} minutes)` + (d > 0 ? `, and the thick rim where the stream lands dims it for another ${pct(d)} just before.` : '.') + ` The optical light swings by ${amp}.`;
      else if (d > 0) t = `From ${i}° the star misses the X-ray source, but the thick rim where the stream lands dims it for ${pct(d)} of each orbit. The optical light swings by ${amp}.`;
      else t = `From ${i}° nothing gets between us and the X-ray source, so the X-ray line stays flat. The optical light swings by ${amp} as the stretched, heated star turns.`;
      if (scale === 'disc') t += ` The disc is ${fmtInt(Math.round(2 * B.rOut * B.aRg * RG_KM / 1000) * 1000)} km across and the black hole's horizon is ${Math.round(2 * P.rHorizon(MODES[S.mode].a) * RG_KM)} km.`;
    }
  } else {
    const m = MODES[S.mode];
    const segs = S.segDone, expo = S.qpo ? segs * S.qpo.seg * S.qpo.dt : 0;
    const tg = P.tgS(m.M);
    if (S.view === 'behind' && S.cam.logD < 2.0) {
      const Dc = Math.pow(10, S.cam.logD);
      const thE = Math.sqrt(4 * B.aRg / (Dc * (B.aRg + Dc))) * 180 / Math.PI;     // Einstein radius seen from the camera
      const thS = Math.asin(RSTAR_RG / (B.aRg + Dc)) * 180 / Math.PI;           // the star's angular radius
      t = `The companion is ${(B.aRg * RG_KM / 1e6).toFixed(1)} million km behind the hole. Seen from far away its radius is ${Math.round(RSTAR_RG / RE_RG)} times the hole's Einstein radius out there (${fmtInt(Math.round(RE_RG * RG_KM / 100) * 100)} km), so the bending would brighten it by only about ${(200 / (RSTAR_RG / RE_RG) ** 2).toFixed(2)}%. From here, ${Math.round(Dc)} GM/c² from the hole, it's the other way round: the star is ${Math.round(thS)}° in radius and the Einstein ring is ${Math.round(thE)}°, bigger than the star, so its light is spread into a ring. The star is drawn far brighter than it would look here, since in visible light the inner disc outshines its heated face about 3,000 times per unit area.`;
    } else if (S.mode === 'quiet') {
      const P0 = 2 * Math.PI * (Math.pow(m.rin, 1.5) + m.a) * tg * 1000;
      t = `The disc's inner edge is at ${m.rin.toFixed(1)} GM/c², ${Math.round(m.rin * RG_KM)} km from the centre, where the gas goes around once every ${P0.toFixed(1)} ms. ` + (segs ? `The power spectrum has ${fmtInt(Math.round(expo))} s of simulated data in it and no peak, only flicker.` : 'The first 64 s segment of simulated data is still coming in.');
    } else if (S.mode === 'typec') {
      const nu = P.TYPEC.nu, fw = nu / P.TYPEC.Q;
      const r = peakRatio(nu, fw, [{ f: 2 * nu, fwhm: 2 * fw }]);
      t = `The flow wobbles once every ${(1 / nu).toFixed(1)} s on average (${nu.toFixed(2)} Hz). ` + (segs ? `After ${fmtInt(Math.round(expo))} s of simulated data the peak at ${nu.toFixed(2)} Hz is ${r ? r.toFixed(r < 10 ? 1 : 0) : '?'} times the broadband noise under it.` : 'The first 64 s segment of simulated data is still coming in.') + (i < 25 ? ' Seen this close to face-on the wobble hardly changes what we see, so the peak stays weak.' : '');
    } else if (S.mode === 'rpm') {
      const R_ = P.RPM, fU = R_.nuU / R_.Q.U, fL = R_.nuL / R_.Q.L, fC = R_.nuC / R_.Q.C;
      const rU = peakRatio(R_.nuU, fU, [{ f: R_.nuL, fwhm: fL }]), rL = peakRatio(R_.nuL, fL, [{ f: R_.nuU, fwhm: fU }]), rC = peakRatio(R_.nuC, fC);
      const f = (x) => (x ? (x >= 10 ? String(Math.round(x)) : x.toFixed(1)) : '?');
      t = `The blob goes around ${Math.round(R_.nuU)} times a second, shown here once every ${(R_.slow / R_.nuU).toFixed(1)} s. ` + (segs ? `With ${Math.round(expo)} s of data the ${Math.round(R_.nuU)} Hz peak is ${f(rU)} times the noise under it. At ${Math.round(R_.nuL)} Hz and ${R_.nuC.toFixed(1)} Hz the ratio is ${f(rL)} and ${f(rC)}` + ((rL || 0) < 1.6 && (rC || 0) < 1.6 ? ', so those two stay buried.' : '.') : 'The first 1 s segment is still coming in.');
    } else if (S.mode === 'heart' && S.qpo && S.hbNow) {
      const hb = S.qpo.hb, T = hb.dt * hb.L.length;
      const tt = ((S.tModel % T) + T) % T;
      let last = null; for (const p of hb.peaks) { if (p <= tt) last = p; else break; }
      const flaring = S.hbNow.env > 0.15;
      t = `The inner disc is at ${Math.round(S.hbNow.fill * 100)}% of the critical surface density and ${flaring ? 'flaring' : 'filling up'}.` + (last !== null ? ` The last flare was ${Math.round(tt - last)} s ago in model time.` : '') + ` In this model it flares every ${Math.round(S.qpo.period)} s on average, and GRS 1915+105 takes 50 to 100 s.`;
    }
  }
  const el = $('xrb-live');
  if (el.textContent !== t) el.textContent = t;
}

// The suggestion is about where the camera is going, so it doesn't change mid-flight, and each suggestion
// does exactly what the matching button does.
function updatePrompt() {
  let text = '', act = null;
  const ld = aimLogD(), aimEl = S.tween ? S.tween.to.el : S.goal.el;
  if (S.collapseGoal > 0.5) { text = 'Back to the 3D view'; act = () => showView('telescope'); }
  else if (ld > 3.6) { text = 'Zoom in to the black hole'; act = () => zoomTo('horizon'); }
  else if (ld > 2.3) { text = 'Keep going: zoom to the black hole'; act = () => zoomTo('horizon'); }
  else if (!visited.edge && Math.abs(aimEl) > 0.12) { text = 'Turn it edge-on to see the far side bent over and under'; act = () => showView('edge'); }
  else if (!visited.behind) { text = 'Put the companion star behind the hole'; act = () => showView('behind'); }
  else if (S.mode === 'quiet') { text = 'Now try a QPO mode, starting with Type-C'; act = () => pickMode('typec'); }
  else { text = 'Back out to the whole binary'; act = () => zoomTo('binary'); }
  S.promptAction = act;
  const el = $('xrb-prompt');
  if (el.textContent !== text) el.textContent = text;
}

// ------------------------------------------------------------------ loop
let lastT = performance.now();
let raf = 0;
let fpsAcc = [];
function frame(now) {
  raf = 0;
  const dt = Math.max(0, Math.min(0.1, (now - lastT) / 1000));
  const frameMs = Math.max(0, now - lastT);
  lastT = now;

  // camera easing
  if (S.tween) {
    const tw = S.tween;
    tw.t += dt / tw.dur;
    const u = tw.t >= 1 ? 1 : (tw.t < 0.5 ? 4 * tw.t ** 3 : 1 - Math.pow(-2 * tw.t + 2, 3) / 2);
    for (const k of ['logD', 'el', 'az']) S.cam[k] = tw.from[k] + (tw.to[k] - tw.from[k]) * u;
    Object.assign(S.goal, S.cam);
    if (tw.t >= 1) S.tween = null;
    if (S.view === 'behind' && tw.t < 1) tw.to.az += 2 * Math.PI * dt / ORBIT_WALL_S * (S.playing ? 1 : 0);
  } else {
    // the two locks that move: Earth's direction follows the inclination, the star-behind view follows the orbit
    if (S.view === 'earth') { const e = earthDir(); S.goal.el = e.el; S.goal.az = S.cam.az + wrapPi(e.az - S.cam.az); }
    if (S.view === 'behind') S.goal.az = S.cam.az + wrapPi(starAz() - S.cam.az);
    const k = 1 - Math.exp(-dt * (reduceMotion ? 20 : 7));
    S.cam.az += (S.goal.az - S.cam.az) * k;
    S.cam.el += (S.goal.el - S.cam.el) * k;
    S.cam.logD += (S.goal.logD - S.cam.logD) * (1 - Math.exp(-dt * 5));
  }
  S.collapse += (S.collapseGoal - S.collapse) * (1 - Math.exp(-dt * 2.2));

  const m = MODES[S.mode];
  if (S.playing) {
    S.orbitPhase = (S.orbitPhase + dt / ORBIT_WALL_S) % 1;
    S.tModel += dt * m.speed;
  }
  // the power spectrum takes in m.psd seconds of simulated data per wall second
  if (S.qpo && S.welch && S.playing) {
    const segTotal = Math.floor(S.qpo.x.length / S.qpo.seg);
    S.segClock += dt * m.psd / (S.qpo.seg * S.qpo.dt);
    while (S.segClock >= 1 && S.segDone < segTotal) {
      S.welch.add(S.qpo.x, S.segDone * S.qpo.seg);
      S.segDone++; S.segClock -= 1;
    }
  }
  stepBinaryLC(6);

  const cam = camera();
  const scale = updateScaleBar(cam);
  const inner = S.cam.logD < 3.3;
  const tl0 = performance.now();
  updateLabels(cam);
  S.dbgLabMs = (S.dbgLabMs || 0) * 0.9 + (performance.now() - tl0) * 0.1;
  updateCaption(scale);
  if (!S.narrT || now - S.narrT > 250) { S.narrT = now; narrate(scale); updatePrompt(); }
  const ct = clockText(inner);
  if (S.clockT !== ct) { S.clockT = ct; $('xrb-clock').textContent = ct; }
  const gauge = $('xrb-gauge');
  const showGauge = inner && S.mode === 'heart' && S.hbNow && S.collapse < 0.1;
  gauge.hidden = !showGauge;
  if (showGauge) $('xrb-gauge-fill').style.height = (clamp(S.hbNow.fill, 0, 1.05) / 1.05 * 100).toFixed(1) + '%';
  $('xrb-tnote').hidden = S.collapse < 0.6;

  if (R) {
    updatePhases(S.playing && !S.noPhase ? dt : 0, cam.D, m.a);
    const phi = 2 * Math.PI * S.orbitPhase;
    const D = cam.D;
    // colour reference: the disc temperature at a radius comparable to the view
    const rRef = clamp(2 * D * cam.tanFov / 0.3839, m.rin * 6, B.rOut * B.aRg);
    const Tref = P.discTemp(m.M, rRef, m.rin);
    const Tmap = 3000 * Math.sqrt(Math.max(Tref / 6300, 1));
    // exposure: hold the brightest part of the disc near a fixed display level, so a hotter inner disc
    // (the heartbeat's spin 0.98) does not burn out to white
    const rPk = 1.36 * Math.max(m.rin, S.mode === 'heart' ? 3 : 0);
    const lumPk = Math.pow(Math.max(P.discTemp(m.M, rPk, m.rin), 1) / Tref, 0.7);
    // Close to the hole the exposure drops (by S.innerExpo) so the Doppler-boosted side sits just under the
    // tone curve's shoulder and the far side of the flow is visibly dimmer, instead of both washing out.
    const near = 1 - smooth(2.2, 3.2, S.cam.logD);
    const expo = 0.55 * S.userExposure * clamp(3.2 / lumPk, 0.35, 1) * (1 - near * (1 - (S.innerExpo || 0.4)));
    const pos = cam.pos.map((v) => v);
    const u = {
      uCamPos: pos, uCamR: cam.R, uCamU: cam.U, uCamF: cam.F, uTanFov: cam.tanFov,
      uExposure: expo, uTime: now / 1000, uTref: Tref, uTmap: Tmap, uLumScale: Math.pow(1e6 / Tref, 0.8),
      uFade: S.cam.logD < 2.6 ? Math.max(0.7 * D, 14) * Math.pow(10, Math.max(0, S.cam.logD - 2.3) * 12) : 1e12,
      uShowCirc: S.labels ? smooth(4.4, 4.9, S.cam.logD) * (1 - smooth(5.3, 5.45, S.cam.logD)) : 0, uRcirc: B.rCirc * B.aRg, uPixAng: 2 * cam.tanFov / Math.max(canvas.height * R.scale, 1),
      uA: B.aRg, uOrb: phi,
      uRoche: [B.m1, B.m2, B.xc, B.phiS], uRoche2: [B.xL1, B.bound, gMean, S.heat],
      uTstar: B.Tstar, uPhiImp: B.phiImp,
      uStream: streamU, uStreamBox: sbox, uStreamG: streamG,
      uRgr: 360, uJet: S.jet ? 1 : 0, uJetPhase: (now / 1000) * 0.35,
      uMaxSteps: R.scale < 0.5 ? 300 : 440, uDebug: S.debugMode || 0,
      // the companion keeps its own brightness at binary scale; close to the hole it is dimmed a lot
      // (it would be thousands of times fainter than the inner disc), except in the star-behind preset
      uStarGain: 0.025 + 0.975 * smooth(3.0, 4.4, S.cam.logD) + (S.view === 'behind' ? 0.22 * (1 - smooth(2.6, 3.4, S.cam.logD)) : 0),
      uFarGlow: smooth(2.7, 3.5, S.cam.logD),
      uBeam: S.beam || 4,
      uRingW: 0.8 * cam.D * 2 * cam.tanFov / Math.max(canvas.height * R.scale, 1),
      ...modeUniforms(),
    };
    S.uNow = u;
    // point source colour and brightness for the telescope view
    let pf = 1, pc = [1, 0.86, 0.7];
    if (inner && S.qpo) { pf = sampleAt(S.qpo.x, S.qpo.dt, S.tModel); pc = [0.62, 0.84, 1.0]; }
    else if (S.lc) { const n = S.lc.opt.length; pf = S.lc.opt[Math.floor(S.orbitPhase * n) % n]; }
    R.render(u, { threshold: 2.4, bloom: 0.2, collapse: S.collapse, pointFlux: 2.2 * pf, pointColor: pc, time: now / 1000, luma: S.labels && S.collapse < 0.05 });
    if (!R.fixed) R.adapt(frameMs);
    S.dbgMs = S.dbgMs ? S.dbgMs * 0.9 + frameMs * 0.1 : frameMs;
  }
  const tc0 = performance.now();
  if (!S.noCharts) drawCharts(inner);
  S.dbgChart = (S.dbgChart || 0) * 0.9 + (performance.now() - tc0) * 0.1;
  S.dbgJs = (S.dbgJs || 0) * 0.9 + (performance.now() - now) * 0.1;
  schedule();
}
function schedule() {
  if (!raf && S.visible && !document.hidden) raf = requestAnimationFrame(frame);
}

// pause when off screen or hidden
new IntersectionObserver((entries) => {
  S.visible = entries[0].isIntersecting;
  if (S.visible) { lastT = performance.now(); schedule(); }
}, { threshold: 0.02 }).observe(stage);
document.addEventListener('visibilitychange', () => { if (!document.hidden) { lastT = performance.now(); schedule(); } });

// ------------------------------------------------------------------ boot
$('xrb-incl-out').textContent = S.incl + '°';
$('xrb-fact-period').textContent = (B.P / 3600).toFixed(1);
$('xrb-fact-a').textContent = B.aRsun.toFixed(1);
$('xrb-fact-rcirc').textContent = B.rCirc.toFixed(2);
$('xrb-fact-nuprec').textContent = P.TYPEC.nu.toFixed(2);
setMode('quiet');
// Optional deep link: #view=inner&mode=typec&incl=84&az=0.5&el=10&d=70&phase=0.1&t=3&earth=1
const H = new URLSearchParams(location.hash.slice(1));
if (H.has('incl')) { S.incl = clamp(+H.get('incl'), 0, 90); incl.value = S.incl; }
if (H.has('mode') && MODES[H.get('mode')]) setMode(H.get('mode'));
if (H.has('view') && SCALES[H.get('view')]) {
  const sc = SCALES[H.get('view')];
  S.cam.logD = S.goal.logD = sc.logD; S.cam.el = S.goal.el = sc.el * Math.PI / 180;
}
if (H.has('d')) S.cam.logD = S.goal.logD = clamp(Math.log10(+H.get('d')), LOGD_MIN, LOGD_MAX);
if (H.has('az')) S.cam.az = S.goal.az = +H.get('az');
if (H.has('el')) S.cam.el = S.goal.el = +H.get('el') * Math.PI / 180;
if (H.has('view') || H.has('az') || H.has('el')) S.view = null;   // a deep link that sets the direction frees the camera
if (H.get('earth') === '1') S.view = 'earth';
if (H.has('phase')) S.orbitPhase = +H.get('phase');
if (H.has('fov')) S.fovDeg = +H.get('fov');
if (H.has('beam')) S.beam = +H.get('beam');
if (H.has('ix')) S.innerExpo = +H.get('ix');
if (H.has('dbg')) S.debugMode = +H.get('dbg');
if (H.has('rout')) S.debugRout = +H.get('rout');
if (H.has('rin')) S.debugRin = +H.get('rin');
if (H.has('t')) S.tModel = +H.get('t');
if (H.has('jet')) S.jet = H.get('jet') === '1';
if (H.get('labels') === '0') S.labels = false;
if (H.get('nocharts') === '1') S.noCharts = true;
if (H.get('nophase') === '1') S.noPhase = true;
if (H.get('paused') === '1' && S.playing) togglePlay();
if (H.get('telescope') === '1') { S.collapse = S.collapseGoal = 1; S.view = 'earth'; }
if (H.get('solo') === '1') Object.assign($('instrument').style, { position: 'fixed', inset: '0', width: '100%', zIndex: '50', borderRadius: '0', overflow: 'auto' });
if (H.has('scale') && R) { R.scale = clamp(+H.get('scale'), 0.3, 1); R.fixed = true; R.scaleSet = true; }
$('xrb-incl-out').textContent = S.incl + '°';
// the page opens on a free camera, 22 degrees above the disc plane, with no view button active; a deep link
// with earth=1 or telescope=1 sets the Earth view, and it points from Earth here
if (S.view === 'earth') { const e = earthDir(); S.cam.az = S.goal.az = e.az; S.cam.el = S.goal.el = e.el; }
// the buttons whose state a deep link may have changed
syncViewButtons();
$('xrb-jet').setAttribute('aria-pressed', String(S.jet));
$('xrb-labels-btn').setAttribute('aria-pressed', String(S.labels));
startBinaryLC();
stepBinaryLC(1e9);
if (H.get('debug') === '1') setTimeout(() => { const W = document.documentElement.clientWidth; console.log('xrb width', W, document.documentElement.scrollWidth); document.querySelectorAll('body *').forEach((el) => { const r = el.getBoundingClientRect(); if (r.right > W + 1 && getComputedStyle(el).position !== 'absolute') console.log('xrb wide', el.tagName, el.id, el.className, Math.round(r.right)); }); }, 1500);
if (H.get('debug') === '1') setInterval(() => { const d = R.phaseData; let nan = 0, mx = -1e9, mn = 1e9; for (const v of d) { if (!isFinite(v)) nan++; else { mx = Math.max(mx, v); mn = Math.min(mn, v); } } console.log('xrb ph', nan, mn, mx); }, 700);
if (H.get('debug') === '1') setInterval(() => console.log('xrb u', JSON.stringify({f: S.uNow && Array.from(S.uNow.uFlow), l: S.uNow && S.uNow.uLumScale, t: S.uNow && S.uNow.uTref, e: S.uNow && S.uNow.uExposure, fade: S.uNow && S.uNow.uFade, j: S.uNow && S.uNow.uJet})), 700);
if (H.get('debug') === '1') setInterval(() => console.log('xrb fps', (1000 / Math.max(1, S.dbgMs || 16)).toFixed(1), 'js', (S.dbgJs || 0).toFixed(1), 'chart', (S.dbgChart || 0).toFixed(1), 'scale', R && R.scale.toFixed(2), 'logD', S.cam.logD.toFixed(2)), 1500);
if (!R) drawCharts(false);
window.addEventListener('resize', () => { S.yr = null; });
schedule();
window.__xrb = { S, B, P, R };
