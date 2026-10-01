/*
  Spot the binary (/play/fake-a-period/). Damped-random-walk quasars, a live
  Lomb-Scargle search, a two-band period-match rule, and a 3-round game.
  Plain ES module, no build step.

  Numbers from Akbari (2026, ApJ, doi:10.3847/1538-4357/ae9d7c) and the paper's
  calibration script (scripts/validate_significance.py):
    - periods 100-3000 d, 750 log-spaced frequencies, at least 3 cycles in the baseline
    - masked 175-195 d and 355-380 d (yearly alias and its harmonic)
    - period match |P1 - P2| / mean < 5%
    - DRW log10 tau = 2.7 (about 500 d), log10 sigma = -0.9 (0.126 mag)
    - BAT-like cadence: 157 monthly points; errors 0.08 (X-ray), 0.035 (ASAS-SN-like)
  Simplified here: a 1-in-100 global max-power line from 1,000 noise simulations
  (the paper: p < 1e-3, 25-bin statistic, 2,000 to 100,000 simulations).
*/

const $ = (id) => document.getElementById(id);
const mqReduce = window.matchMedia('(prefers-reduced-motion: reduce)');
let reduced = mqReduce.matches;

/* ------------------------------------------------------------------ random */
function mulberry32(a) {
  a >>>= 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function gaussFrom(u) {
  let spare = null;
  return function () {
    if (spare !== null) { const s = spare; spare = null; return s; }
    let a = u();
    while (a < 1e-300) a = u();
    const b = u();
    const r = Math.sqrt(-2 * Math.log(a));
    spare = r * Math.sin(2 * Math.PI * b);
    return r * Math.cos(2 * Math.PI * b);
  };
}
function hashStr(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h >>> 0;
}
const rand = mulberry32((Math.random() * 4294967296) >>> 0);
const newSeed = () => (rand() * 4294967296) >>> 0;

/* --------------------------------------------------------------- constants */
const P_MIN = 100, P_MAX = 3000, N_FREQ = 750, MIN_CYCLES = 3;
const MASKS = [[175, 195], [355, 380]];
const ALPHA = 0.01, N_CAL = 1000, MATCH = 0.05;
const TD0 = 53340, TD1 = 60000;          // display span, Dec 2004 to Feb 2023 (MJD)
const MJD_J2000 = 51544.5;
const toYear = (m) => 2000 + (m - MJD_J2000) / 365.25;
const TAU_MIN = 20, TAU_MAX = 2000;
const DEF = { tau: 500, sigma: 0.126, xerr: 0.08 };
const ERR_OPT = 0.035;
const N_TILES = 8;
const LETTERS = 'ABCDEFGH';
const relDiff = (a, b) => Math.abs(a - b) / ((a + b) / 2);
const fmtInt = (x) => Math.round(x).toLocaleString('en-US');
const fmtP = (P) => `${fmtInt(P)} days`;
function pctStr(x) {
  if (x === 0) return '0%';
  if (x >= 0.995) return '100%';
  if (x < 0.001) return 'under 0.1%';
  if (x < 0.1) return `${(x * 100).toFixed(1)}%`;
  return `${Math.round(x * 100)}%`;
}

/* ---------------------------------------------------------------- cadences */
function opticalCadence() {
  // ASAS-SN-like, as in validate_significance.py: 500 uniform draws over 4000 d,
  // keep the ones in the first 280 days of each 365.25-day season.
  const r = mulberry32(20120301);
  const t = [];
  for (let i = 0; i < 500; i++) t.push(56000 + 4000 * r());
  t.sort((a, b) => a - b);
  return Float64Array.from(t.filter((x) => ((x - 56000) % 365.25) < 280));
}
function xrayCadence() {
  // Swift-BAT-like: 157 monthly bins starting December 2004.
  const t = new Float64Array(157);
  for (let i = 0; i < 157; i++) t[i] = TD0 + 30.4375 * (i + 0.5);
  return t;
}

/* ------------------------------------------------------------------- bands */
function isMasked(P) { return MASKS.some(([a, b]) => P >= a && P <= b); }

function makeBand(id, t) {
  const N = t.length;
  const T = t[N - 1] - t[0];
  const pmax = Math.min(P_MAX, T / MIN_CYCLES);
  const lo = Math.log(P_MIN), hi = Math.log(P_MAX);
  const per = [];
  for (let k = 0; k < N_FREQ; k++) {
    const P = Math.exp(lo + (hi - lo) * k / (N_FREQ - 1));
    if (P > pmax) break;
    if (!isMasked(P)) per.push(P);
  }
  const nf = per.length;
  const cos = new Float64Array(nf * N), sin = new Float64Array(nf * N);
  const C = new Float64Array(nf), S = new Float64Array(nf), CC = new Float64Array(nf),
    SS = new Float64Array(nf), CS = new Float64Array(nf), D = new Float64Array(nf);
  const t0 = t[0];
  for (let f = 0; f < nf; f++) {
    const w = 2 * Math.PI / per[f];
    let c1 = 0, s1 = 0, cc = 0, ss = 0, cs = 0;
    const base = f * N;
    for (let i = 0; i < N; i++) {
      const ph = w * (t[i] - t0);
      const c = Math.cos(ph), s = Math.sin(ph);
      cos[base + i] = c; sin[base + i] = s;
      c1 += c; s1 += s; cc += c * c; ss += s * s; cs += c * s;
    }
    C[f] = c1 / N; S[f] = s1 / N;
    CC[f] = cc / N - C[f] * C[f]; SS[f] = ss / N - S[f] * S[f]; CS[f] = cs / N - C[f] * S[f];
    D[f] = CC[f] * SS[f] - CS[f] * CS[f];
  }
  const dt = new Float64Array(N);
  for (let i = 1; i < N; i++) dt[i] = t[i] - t[i - 1];

  // merged grid (daily + cadence) for the continuous curve that drives the 3D glow
  const days = TD1 - TD0 + 1;
  const mt = new Float64Array(days + N), midx = new Int32Array(N);
  let i = 0, j = 0, m = 0;
  while (i < days || j < N) {
    const td = TD0 + i;
    if (j < N && (i >= days || t[j] <= td)) { mt[m] = t[j]; midx[j] = m; j++; } else { mt[m] = td; i++; }
    m++;
  }
  const mdt = new Float64Array(mt.length);
  for (let k = 1; k < mt.length; k++) mdt[k] = mt[k] - mt[k - 1];
  return { id, t, N, T, pmax, per: Float64Array.from(per), nf, cos, sin, C, S, CC, SS, CS, D, dt, t0, yc: new Float64Array(N), mt, midx, mdt, kern: new Map() };
}

/* ----------------------------------------------------------- Lomb-Scargle */
// Generalized (floating-mean) Lomb-Scargle with equal weights; same normalization
// as astropy's LombScargle(t, y, dy).power() for constant dy.
function lsFull(b, y, out) {
  const N = b.N, yc = b.yc;
  let mean = 0;
  for (let i = 0; i < N; i++) mean += y[i];
  mean /= N;
  let YY = 0;
  for (let i = 0; i < N; i++) { const d = y[i] - mean; yc[i] = d; YY += d * d; }
  YY /= N;
  let best = 0, bestP = -1;
  if (!(YY > 0)) { if (out) out.fill(0); return { k: 0, m: 0 }; }
  const { cos, sin, CC, SS, CS, D, nf } = b;
  for (let f = 0; f < nf; f++) {
    const base = f * N;
    let sc = 0, ss = 0;
    for (let i = 0; i < N; i++) { const d = yc[i]; sc += d * cos[base + i]; ss += d * sin[base + i]; }
    const YC = sc / N, YS = ss / N;
    const p = (SS[f] * YC * YC + CC[f] * YS * YS - 2 * CS[f] * YC * YS) / (YY * D[f]);
    if (out) out[f] = p;
    if (p > bestP) { bestP = p; best = f; }
  }
  return { k: best, m: bestP };
}

function sineFit(b, y, f) {
  const N = b.N;
  let mean = 0;
  for (let i = 0; i < N; i++) mean += y[i];
  mean /= N;
  let sc = 0, ss = 0;
  const base = f * N;
  for (let i = 0; i < N; i++) { const d = y[i] - mean; sc += d * b.cos[base + i]; ss += d * b.sin[base + i]; }
  const YC = sc / N, YS = ss / N;
  const a = (YC * b.SS[f] - YS * b.CS[f]) / b.D[f];
  const c = (YS * b.CC[f] - YC * b.CS[f]) / b.D[f];
  const w = 2 * Math.PI / b.per[f], C = b.C[f], S = b.S[f], t0 = b.t0;
  return (tt) => mean + a * (Math.cos(w * (tt - t0)) - C) + c * (Math.sin(w * (tt - t0)) - S);
}

/* ------------------------------------------------------------------- DRW */
// Exact Ornstein-Uhlenbeck update (Kelly et al. 2009), MacLeod convention C(dt) = sigma^2 exp(-|dt|/tau).
function kernelFor(b, tau) {
  const key = tau.toFixed(4);
  if (b.kern.has(key)) return b.kern.get(key);
  const M = b.mt.length;
  const a = new Float64Array(M), q = new Float64Array(M);
  for (let k = 1; k < M; k++) { const e = Math.exp(-b.mdt[k] / tau); a[k] = e; q[k] = Math.sqrt(Math.max(0, 1 - e * e)); }
  if (b.kern.size > 6) b.kern.clear();
  const kern = { a, q };
  b.kern.set(key, kern);
  return kern;
}
function signalAt(sig, phi, tt) {
  if (!sig || sig.shape === 'none' || !(sig.amp > 0)) return 0;
  const th = 2 * Math.PI * tt / sig.per + phi;
  if (sig.shape === 'sine') return sig.amp * Math.sin(th);
  let x = th / (2 * Math.PI);            // sawtooth, scipy width=0: instant rise, linear decline
  x -= Math.floor(x);
  return sig.amp * (1 - 2 * x);
}
const injOf = (q) => (q && q.sig && q.sig.shape !== 'none' && q.sig.amp > 0 ? q.sig.per : 0);

/* ------------------------------------------------------------- calibration */
const bands = {};
const cal = new Map();
let calQueue = [], calJob = null, calPumping = false;
const errOf = (bid, p) => (bid === 'xray' ? p.xerr : ERR_OPT);
function calKey(bid, mode, p) {
  return mode === 'white' ? `${bid}|white` : `${bid}|red|${p.tau.toFixed(3)}|${p.sigma.toFixed(4)}|${errOf(bid, p).toFixed(3)}`;
}
function thrOf(bid, mode, p) { const c = cal.get(calKey(bid, mode, p)); return c ? c.thr : null; }
function isReady(mode, p) { return thrOf('opt', mode, p) !== null && thrOf('xray', mode, p) !== null; }
function noiseFrac(bid, m, mode, p) {
  const c = cal.get(calKey(bid, mode, p));
  if (!c) return null;
  const arr = c.maxima;
  let lo = 0, hi = arr.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid] < m) lo = mid + 1; else hi = mid; }
  return (arr.length - lo) / arr.length;
}
// Only two parameter sets can ever be needed: the game's (DEF) and free play's current knobs.
// Work queued for knob positions the visitor has already dragged past is dropped, so a slider
// drag doesn't leave a minute of stale simulations ahead of the one that matters.
function calNeeded(w) {
  return w.key === calKey(w.bid, w.mode, DEF) || w.key === calKey(w.bid, w.mode, L.p);
}
function calWant(list) {
  // list of [mode, params], in priority order
  calQueue = calQueue.filter(calNeeded);
  if (calJob && !calNeeded(calJob)) calJob = null;
  const keys = new Set(calQueue.map((w) => w.key));
  if (calJob) keys.add(calJob.key);
  const front = [];
  for (const [mode, p] of list) {
    for (const bid of ['opt', 'xray']) {
      const key = calKey(bid, mode, p);
      if (cal.has(key) || keys.has(key)) continue;
      keys.add(key);
      front.push({ key, bid, mode, p: { ...p } });
    }
  }
  calQueue = front.concat(calQueue);
  if (!calPumping && (calJob || calQueue.length)) { calPumping = true; setTimeout(calPump, 0); }
  updateCalibUI();
}
function startJob(w) {
  const b = bands[w.bid];
  const r = mulberry32(hashStr(w.key));
  const job = { ...w, b, err: errOf(w.bid, w.p), g: gaussFrom(r), j: 0, maxima: new Float64Array(N_CAL), y: new Float64Array(b.N) };
  if (w.mode === 'red') {
    job.a = new Float64Array(b.N); job.q = new Float64Array(b.N);
    for (let i = 1; i < b.N; i++) { const e = Math.exp(-b.dt[i] / w.p.tau); job.a[i] = e; job.q[i] = Math.sqrt(1 - e * e); }
  }
  return job;
}
function calStep(job) {
  const { b, g, y } = job;
  if (job.mode === 'white') {
    for (let i = 0; i < b.N; i++) y[i] = g();
  } else {
    const s = job.p.sigma;
    let v = s * g();
    y[0] = v + job.err * g();
    for (let i = 1; i < b.N; i++) { v = v * job.a[i] + s * job.q[i] * g(); y[i] = v + job.err * g(); }
  }
  job.maxima[job.j++] = lsFull(b, y, null).m;
}
function calPump() {
  const t0 = performance.now();
  while (performance.now() - t0 < 12) {
    if (!calJob) {
      if (!calQueue.length) break;
      calJob = startJob(calQueue.shift());
    }
    calStep(calJob);
    if (calJob.j >= N_CAL) {
      const mx = calJob.maxima.sort();
      cal.set(calJob.key, { maxima: mx, thr: mx[Math.ceil((1 - ALPHA) * N_CAL) - 1] });
      calJob = null;
      onCalibrated();
    }
  }
  updateCalibUI();
  if (calJob || calQueue.length) setTimeout(calPump, 0);
  else calPumping = false;
}
function updateCalibUI() {
  const box = $('calib');
  if (!box) return;
  const p = V.q ? V.q.p : DEF;
  const need = ['opt', 'xray'].filter((b) => thrOf(b, V.mode, p) === null);
  if (!need.length) { box.classList.remove('is-on'); return; }
  let done = 2 - need.length;
  if (calJob && calJob.mode === V.mode) done += calJob.j / N_CAL;
  $('calib-text').textContent = `Setting the ${V.mode === 'white' ? 'textbook' : 'red-noise'} line: ${fmtInt(N_CAL)} noise-only curves per band`;
  $('calib-bar').style.width = `${Math.round((done / 2) * 100)}%`;
  box.classList.add('is-on');
}
function onCalibrated() {
  renderTiles();
  refreshGameUI();
  if (L.pendingNew && isReady(L.mode, L.p)) { L.pendingNew = false; labNew(); }
  if (L.pendingBatch && isReady(L.mode, L.p)) { L.pendingBatch = false; startBatch(); }
  recolorJar();
  dirtyPG = true;
  updateCaption();
}

/* ---------------------------------------------------------------- quasars */
function buildQuasar(seed, phi, p, sig) {
  const q = { seed, phi, p: { ...p }, sig: sig ? { ...sig } : null, bands: {} };
  for (const bid of ['opt', 'xray']) {
    const b = bands[bid];
    const g = gaussFrom(mulberry32((seed ^ hashStr(bid)) >>> 0));
    const kern = kernelFor(b, p.tau);
    const M = b.mt.length;
    const noise = new Float64Array(M);
    let v = p.sigma * g();
    noise[0] = v;
    for (let k = 1; k < M; k++) { v = v * kern.a[k] + p.sigma * kern.q[k] * g(); noise[k] = v; }
    const err = errOf(bid, p);
    const eps = new Float64Array(b.N);
    for (let j = 0; j < b.N; j++) eps[j] = err * g();
    q.bands[bid] = { err, noise, eps, cont: new Float64Array(M), obs: new Float64Array(b.N), power: new Float64Array(b.nf) };
  }
  applySignal(q);
  return q;
}
function applySignal(q) {
  for (const bid of ['opt', 'xray']) {
    const b = bands[bid], d = q.bands[bid];
    for (let k = 0; k < b.mt.length; k++) d.cont[k] = d.noise[k] + signalAt(q.sig, q.phi, b.mt[k]);
    for (let j = 0; j < b.N; j++) d.obs[j] = d.cont[b.midx[j]] + d.eps[j];
    const r = lsFull(b, d.obs, d.power);
    d.k = r.k; d.m = r.m; d.P = b.per[r.k];
    d.fit = sineFit(b, d.obs, r.k);
    let lo = Infinity, hi = -Infinity, s2 = 0;
    for (let k = 0; k < d.cont.length; k++) { const x = d.cont[k]; if (x < lo) lo = x; if (x > hi) hi = x; s2 += x * x; }
    for (let j = 0; j < b.N; j++) { const x = d.obs[j]; if (x - d.err < lo) lo = x - d.err; if (x + d.err > hi) hi = x + d.err; }
    const pad = 0.1 * (hi - lo || 1);
    d.ylo = lo - pad; d.yhi = hi + pad;
    d.rms = Math.sqrt(s2 / d.cont.length) || q.p.sigma;
  }
  q.inj = injOf(q);
}
function judgeQ(q, two, mode) {
  const tO = thrOf('opt', mode, q.p), tX = thrOf('xray', mode, q.p);
  if (tO === null || tX === null) return null;
  const o = q.bands.opt, x = q.bands.xray, inj = q.inj;
  const oDet = o.m > tO, xDet = x.m > tX;
  const match = oDet && xDet && relDiff(o.P, x.P) < MATCH;
  const oOK = !!inj && oDet && Math.abs(o.P - inj) / inj < MATCH;
  const xOK = !!inj && xDet && Math.abs(x.P - inj) / inj < MATCH;
  const counted = two ? match : oDet;
  let state;
  if (counted) state = inj ? ((two ? oOK && xOK : oOK) ? 'ok' : 'fake') : 'fake';
  else state = (oDet || (two && xDet)) ? 'fool' : 'none';
  return { oDet, xDet, match, oOK, xOK, counted, state };
}

/* ------------------------------------------------------------- the view */
// V is what the close-up (3D, light curve, periodogram, caption) is showing.
const V = { q: null, two: false, mode: 'white', reveal: false, owner: 'game', name: 'Quasar A' };
const PB = { t: 56000, t0: 56000, t1: TD1, speed: 400, playing: !reduced };
let dirtyLC = true, dirtyPG = true, dirtyTiles = true, dirtyJar = true, jarAnimUntil = 0;
let colors = {};
let sceneApi = null, sceneVisible = true;

function spanFor(two) { return two ? [TD0, TD1] : [56000, TD1]; }
function show(q, opts) {
  Object.assign(V, opts, { q });
  const [a, b] = spanFor(V.two);
  PB.t0 = a; PB.t1 = b; PB.speed = (b - a) / (V.two ? 14 : 10);
  if (PB.t < a || PB.t > b) PB.t = a;
  if (reduced && !PB.playing) PB.t = a + 0.62 * (b - a);
  $('toy').classList.toggle('is-two', V.two);
  $('scene-name').textContent = V.name;
  $('pg-note').textContent = `dashed: ${V.mode === 'white' ? 'textbook' : 'red-noise'} false-alarm line, 1 in 100 noise-only curves goes above it`;
  $('st-xray').textContent = V.two ? '' : 'not measured';
  // the highlighted tile always says which quasar the close-up shows (none for a free-play one)
  for (let k = 0; k < G.deck.length; k++) { const el = $(`tile-${k}`); if (el) el.classList.toggle('is-focus', V.owner === 'game' && k === G.focus); }
  dirtyLC = dirtyPG = true;
  updateMarkbar();
  updateCaption();
  updateCalibUI();
}

/* ------------------------------------------------------------------ game */
const ROUNDS = [
  { name: 'Round 1 of 3 · one band', two: false, mode: 'white',
    prompt: '<strong>Round 1: one band.</strong> These are the optical light curves of 8 quasars, and 1 to 3 of them hide a real binary. Tap a quasar to look closer, mark the ones you think are real, then press Check.' },
  { name: 'Round 2 of 3 · two bands', two: true, mode: 'white',
    prompt: '<strong>Round 2: two bands.</strong> Each quasar now has an X-ray light curve too. A real binary puts the same period in both bands, so look for two peaks in the same place.' },
  { name: 'Round 3 of 3 · the paper\'s rules', two: true, mode: 'red',
    prompt: '<strong>Round 3: the paper\'s rules.</strong> Two bands again, but the dashed line now comes from simulated red noise, so a peak has to beat what flicker can do on its own.' },
];
const G = { r: 0, deck: [], checked: false, focus: 0, results: [], done: false };

function pickPeriod() {
  for (;;) {
    const P = 150 + 600 * rand();
    if (!(P > 165 && P < 205) && !(P > 340 && P < 395)) return Math.round(P);
  }
}
function deal() {
  const nReal = 1 + Math.floor(rand() * 3);
  const order = [...Array(N_TILES).keys()].sort(() => rand() - 0.5);
  const realSet = new Set(order.slice(0, nReal));
  G.deck = [];
  for (let i = 0; i < N_TILES; i++) {
    const real = realSet.has(i);
    const sig = real ? { shape: 'sine', amp: +(0.10 + 0.10 * rand()).toFixed(3), per: pickPeriod() } : null;
    G.deck.push({ id: LETTERS[i], real, picked: false, q: buildQuasar(newSeed(), rand() * 2 * Math.PI, DEF, sig) });
  }
  G.checked = false;
  G.done = false;
  $('final').hidden = true;
  $('tiles').hidden = false;
  buildTileDom();
  focusTile(0);
  refreshGameUI();
}
function round() { return ROUNDS[G.r]; }
function focusTile(i) {
  G.focus = i;
  const it = G.deck[i];
  show(it.q, { two: round().two, mode: round().mode, reveal: G.checked, owner: 'game', name: `Quasar ${it.id}` });
}
function togglePick(i) {
  if (G.checked) return;
  const it = G.deck[i];
  it.picked = !it.picked;
  syncTile(i);
  updateMarkbar();
  refreshGameUI();
}

function buildTileDom() {
  const box = $('tiles');
  box.innerHTML = '';
  G.deck.forEach((it, i) => {
    const el = document.createElement('div');
    el.className = 'fap-tile';
    el.id = `tile-${i}`;
    el.setAttribute('role', 'listitem');
    el.innerHTML = `<button type="button" class="fap-tile-look" aria-label="Look at quasar ${it.id}">
        <span class="fap-tile-top"><span class="fap-tile-id">${it.id}</span><span class="fap-tile-truth"></span></span>
        <canvas aria-hidden="true"></canvas><span class="fap-tile-facts"></span></button>
      <button type="button" class="fap-tile-pick" aria-pressed="false" aria-label="Mark quasar ${it.id} as a binary">Mark as binary</button>`;
    el.querySelector('.fap-tile-look').addEventListener('click', () => {
      focusTile(i);
      // on stacked layouts the close-up is below the tiles, so bring it into view
      if (window.matchMedia('(max-width: 979px)').matches) $('scene').scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'start' });
    });
    el.querySelector('.fap-tile-pick').addEventListener('click', () => { togglePick(i); focusTile(i); });
    box.appendChild(el);
  });
  dirtyTiles = true;
}
function tileFacts(it) {
  const r = round(), q = it.q, o = q.bands.opt, x = q.bands.xray;
  const j = judgeQ(q, r.two, r.mode);
  if (!j) return 'setting the line…';
  const ov = (d) => (d ? 'over' : 'under');
  if (!r.two) return `Peak <b>${fmtInt(o.P)} d</b>, ${ov(j.oDet)} the line`;
  const both = j.oDet && j.xDet ? 'both over the line' : j.oDet ? 'only optical over the line' : j.xDet ? 'only X-ray over the line' : 'neither over the line';
  return `Peaks <b>${fmtInt(o.P)}</b> and <b>${fmtInt(x.P)} d</b>, <b>${pctStr(relDiff(o.P, x.P))}</b> apart · ${both}`;
}
function syncTile(i) {
  const it = G.deck[i];
  const el = $(`tile-${i}`);
  if (!el) return;
  const pick = el.querySelector('.fap-tile-pick');
  pick.setAttribute('aria-pressed', String(it.picked));
  pick.textContent = it.picked ? 'Marked as binary' : 'Mark as binary';
  pick.disabled = G.checked;
  el.classList.toggle('is-picked', it.picked && !G.checked);
  el.classList.remove('r-hit', 'r-fake', 'r-miss');
  const truth = el.querySelector('.fap-tile-truth');
  truth.textContent = '';
  if (G.checked) {
    if (it.real && it.picked) el.classList.add('r-hit');
    else if (!it.real && it.picked) el.classList.add('r-fake');
    else if (it.real) el.classList.add('r-miss');
    truth.textContent = it.real ? `${it.picked ? 'found' : 'missed'} · binary ${it.q.sig.per} d` : (it.picked ? 'fake · only flicker' : 'only flicker');
  }
  el.querySelector('.fap-tile-facts').innerHTML = tileFacts(it);
}
function renderTiles() {
  G.deck.forEach((_, i) => { syncTile(i); drawTile(i); });
}

function check() {
  if (G.checked) { nextRound(); return; }
  const r = round();
  G.checked = true;
  let hits = 0, real = 0, fakes = 0, ruleCount = 0, ruleReal = 0, ruleFakes = 0;
  for (const it of G.deck) {
    if (it.real) real++;
    if (it.real && it.picked) hits++;
    if (!it.real && it.picked) fakes++;
    const j = judgeQ(it.q, r.two, r.mode);
    if (j && j.counted) { ruleCount++; if (it.real) ruleReal++; else ruleFakes++; }
  }
  G.results[G.r] = { name: r.name, hits, real, fakes, ruleCount, ruleReal, ruleFakes };
  if (V.owner === 'game') V.reveal = true;
  renderTiles();
  refreshGameUI();
  updateCaption();
  $('announcer').textContent = $('prompt').textContent;
}
function nextRound() {
  if (G.r >= ROUNDS.length - 1) { showFinal(); return; }
  G.r++;
  deal();
}
function totals() {
  let found = 0, real = 0, fakes = 0;
  for (const x of G.results) if (x) { found += x.hits; real += x.real; fakes += x.fakes; }
  return { found, real, fakes };
}
function refreshGameUI() {
  if (!G.deck.length) return;
  updateMarkbar();   // the Mark button follows every game state change (Check, next round, game over)
  const r = round(), tot = totals();
  $('sc-found').textContent = `${tot.found} of ${tot.real}`;
  $('sc-fake').textContent = String(tot.fakes);
  const btn = $('btn-check');
  if (G.done) {
    $('round-name').textContent = 'Game over';
    btn.textContent = 'Play again';
    btn.disabled = false;
    return;
  }
  $('round-name').textContent = r.name;
  const rdy = isReady(r.mode, DEF);
  if (!G.checked) {
    $('prompt').innerHTML = rdy ? r.prompt : 'Setting the false-alarm line first. It takes a second.';
    const n = G.deck.filter((d) => d.picked).length;
    btn.textContent = n ? `Check my ${n} pick${n === 1 ? '' : 's'}` : 'Check my picks';
    btn.disabled = !rdy;
    $('deck-sub').textContent = 'tap one to look closer';
  } else {
    const x = G.results[G.r];
    const you = `You found <strong class="p-good">${x.hits} of ${x.real}</strong> binar${x.real === 1 ? 'y' : 'ies'} and fell for <strong class="${x.fakes ? 'p-bad' : 'p-good'}">${x.fakes}</strong> fake${x.fakes === 1 ? '' : 's'}.`;
    const ruleTxt = r.two
      ? ` The rule on its own (${r.mode === 'white' ? 'both bands over the textbook line' : 'both bands over the red-noise line'}, peaks within 5%) counted ${x.ruleCount}: ${x.ruleReal} real and ${x.ruleFakes} fake.`
      : ` The textbook rule on its own (tallest peak over the line) counted ${x.ruleCount} of the 8: ${x.ruleReal} real and ${x.ruleFakes} fake.`;
    $('prompt').innerHTML = you + ruleTxt;
    btn.textContent = G.r < ROUNDS.length - 1 ? 'Next round' : 'See how you did';
    btn.disabled = false;
    $('deck-sub').textContent = 'tap one to see what it really was';
  }
}
function showFinal() {
  G.done = true;
  const tot = totals();
  const rows = G.results.map((x) => `<tr><th scope="row">${x.name.replace(/^Round \d of 3 · /, '')}</th><td>${x.hits} of ${x.real}</td><td>${x.fakes}</td><td>${x.ruleFakes} of ${8 - x.real}</td><td>${x.ruleReal} of ${x.real}</td></tr>`).join('');
  $('final').innerHTML = `<h3>You found ${tot.found} of ${tot.real} binaries and fell for ${tot.fakes} fake${tot.fakes === 1 ? '' : 's'}.</h3>
    <table><thead><tr><th scope="col">Round</th><th scope="col">You found</th><th scope="col">You fell for</th><th scope="col">Rule fell for</th><th scope="col">Rule found</th></tr></thead><tbody>${rows}</tbody></table>
    <p>With one band and the textbook line, noise fools the rule almost every time. Asking for the same period in two bands throws most of those out, and the red-noise line throws out nearly all the rest, but it also loses the weaker real binaries.</p>
    <p>The real search did round 3 on 1,369 active galaxies. Nothing survived, and noise alone predicted about 0.015 fakes, so zero is what it should find if binaries this strong are rare. The limit that comes out is that at most about 3% of the Swift-BAT galaxies can have a shared period between 100 and 900 days with a hard X-ray modulation of 30% or more. <a href="/research/cross-band-periodicity/">More on the paper</a>.</p>
    <div class="fap-actions"><button type="button" class="btn btn-primary" id="btn-again">Play again</button><button type="button" class="btn" id="btn-open-lab">Free play: run 100 at once</button></div>`;
  $('tiles').hidden = true;
  $('final').hidden = false;
  $('prompt').innerHTML = '<strong>That\'s the game.</strong> Your score and the rule\'s are below.';
  $('deck-h').textContent = 'How you did';
  $('deck-sub').textContent = '';
  $('btn-again').addEventListener('click', () => { if (gameStepAllowed()) restartGame(); });
  $('btn-open-lab').addEventListener('click', () => { const lab = $('lab'); lab.open = true; lab.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'start' }); });
  refreshGameUI();
}
let stepLockUntil = 0;
function gameStepAllowed() {
  const now = performance.now();
  if (now < stepLockUntil) return false;
  stepLockUntil = now + 400;
  return true;
}
function restartGame() {
  G.r = 0; G.results = []; G.done = false;
  $('deck-h').textContent = 'This round\'s quasars';
  deal();
}

/* -------------------------------------------------------------- markbar */
function updateMarkbar() {
  const btn = $('btn-mark'), note = $('mark-note');
  if (V.owner !== 'game' || !G.deck.length || G.done) {
    btn.hidden = true;
    note.textContent = V.owner === 'lab' ? 'Free play quasar. Tap a tile above to go back to the game.' : '';
    return;
  }
  const it = G.deck[G.focus];
  btn.hidden = false;
  btn.disabled = G.checked;
  btn.setAttribute('aria-pressed', String(it.picked));
  btn.textContent = it.picked ? `Quasar ${it.id} is marked as a binary` : `Mark quasar ${it.id} as a binary`;
  const n = G.deck.filter((d) => d.picked).length;
  note.textContent = G.checked ? '' : `${n} of 8 marked`;
}

/* -------------------------------------------------------------- caption */
function updateCaption() {
  const el = $('caption');
  const q = V.q;
  if (!q) return;
  const j = judgeQ(q, V.two, V.mode);
  if (!j) { el.textContent = 'Setting the false-alarm line for this quasar.'; return; }
  const o = q.bands.opt, x = q.bands.xray, inj = q.inj;
  const lineName = V.mode === 'white' ? 'textbook line' : 'red-noise line';
  let txt = '';
  if (V.owner === 'game') {
    const name = V.name;
    if (!V.reveal) {
      if (!V.two) {
        const over = G.deck.filter((d) => { const jj = judgeQ(d.q, false, V.mode); return jj && jj.oDet; }).length;
        txt = `${name}: the tallest peak is at ${fmtP(o.P)}, ${j.oDet ? 'above' : 'under'} the ${lineName}. ${over} of the 8 quasars in this round go over that line, and at most 3 of them are real.`;
      } else {
        const d = relDiff(o.P, x.P);
        txt = `${name}: optical peak at ${fmtP(o.P)}, X-ray peak at ${fmtP(x.P)}, ${pctStr(d)} apart. `;
        txt += d < MATCH
          ? 'That is what a real binary does, and noise also does it by luck now and then (the paper measured 3.7% for its real light curves).'
          : 'A real binary would put both peaks at the same period, within about 5%.';
        if (V.mode === 'red') {
          txt += ` Against the red-noise line the optical peak is ${j.oDet ? 'over' : 'under'} and the X-ray peak is ${j.xDet ? 'over' : 'under'}.`;
        }
      }
    } else if (inj) {
      txt = `${name} had a real binary: a ${fmtInt(inj)}-day sine, ${q.sig.amp.toFixed(2)} mag high. `;
      txt += V.two ? `The optical peak landed at ${fmtP(o.P)} and the X-ray peak at ${fmtP(x.P)}. ` : `Its tallest peak landed at ${fmtP(o.P)}. `;
      txt += 'In the 3D view the second black hole now goes round once per period, sped up.';
      if (V.two && V.mode === 'red' && !j.counted) txt += ' The red-noise rule missed it, because it is too weak to beat the line. That is why the paper\'s limit only holds for strong signals.';
    } else {
      const fr = noiseFrac('opt', o.m, 'red', q.p);
      txt = `${name} was only flicker, with no binary in it. Its ${fmtP(o.P)} peak comes from slow random wandering`;
      txt += fr === null ? '.' : `, and a peak that tall turns up in ${pctStr(fr)} of red-noise curves with no binary at all.`;
    }
  } else {
    // free play
    if (!inj) {
      if (!V.two) txt = j.oDet ? `Tallest peak at ${fmtP(o.P)}, above the ${lineName}, so the rule counts it as a period. There isn't one. This quasar is pure noise.` : `Tallest peak at ${fmtP(o.P)}, under the ${lineName}. Nothing found, which is correct.`;
      else if (j.match) txt = `Both bands went over the ${lineName} and they agree: ${fmtP(o.P)} and ${fmtP(x.P)}, ${pctStr(relDiff(o.P, x.P))} apart. That counts as a candidate, and it's still pure noise.`;
      else if (j.oDet && j.xDet) txt = `Both bands went over the ${lineName}, at ${fmtP(o.P)} (optical) and ${fmtP(x.P)} (X-ray). That's ${pctStr(relDiff(o.P, x.P))} apart, so it doesn't count.`;
      else if (j.oDet || j.xDet) txt = `Only the ${j.oDet ? 'optical' : 'X-ray'} band went over the ${lineName} (${fmtP(j.oDet ? o.P : x.P)}). One band isn't enough, so this doesn't count.`;
      else txt = `Neither band went over the ${lineName}. Nothing found, which is correct.`;
    } else {
      const inD = `${fmtInt(inj)}-day`;
      if (!V.two) txt = j.oOK ? `Found ${fmtP(o.P)}. You put in ${fmtP(inj)}. Recovered.` : j.oDet ? `Found ${fmtP(o.P)}, but you put in ${fmtP(inj)}. The rule still counts it, so this one is a fake.` : `Nothing over the line. Your ${inD} signal got lost in the flicker.`;
      else if (j.oOK && j.xOK) txt = `Optical found ${fmtP(o.P)} and X-ray found ${fmtP(x.P)}. You put in ${fmtP(inj)}. Recovered in both bands.`;
      else if (j.match) txt = `Both bands agree on about ${fmtP(o.P)}, but you put in ${fmtP(inj)}. A fake candidate that happens to pass.`;
      else if (j.oOK || j.xOK) txt = `${j.oOK ? 'Optical' : 'X-ray'} found your ${inD} signal and ${j.oOK ? 'X-ray' : 'optical'} didn't. It needs both, so this one is missed.`;
      else txt = `Neither band found your ${inD} signal.`;
    }
  }
  el.textContent = txt;
  $('cv-pg').setAttribute('aria-label', `Periodogram of ${V.name}. Optical tallest peak at ${fmtP(o.P)}, ${j.oDet ? 'above' : 'below'} the ${lineName}.` + (V.two ? ` X-ray tallest peak at ${fmtP(x.P)}, ${j.xDet ? 'above' : 'below'} the line.` : ''));
  $('cv-lc').setAttribute('aria-label', `Light curve of ${V.name}: ${bands.opt.N} optical points${V.two ? ' and 157 X-ray points' : ''}.`);
}

/* ------------------------------------------------------------ free play */
const L = { two: false, mode: 'white', p: { ...DEF }, sig: { shape: 'none', amp: 0.2, per: 400 }, jar: [], batch: null, q: null, pendingNew: false, pendingBatch: false };
const labSig = () => (L.sig.shape === 'none' ? null : { ...L.sig });
function record(q) { return { q: { p: q.p, inj: q.inj, bands: { opt: { m: q.bands.opt.m, P: q.bands.opt.P }, xray: { m: q.bands.xray.m, P: q.bands.xray.P } } }, state: null, from: null, t0: 0, born: performance.now() }; }
function labShow() { if (L.q) show(L.q, { two: L.two, mode: L.mode, reveal: true, owner: 'lab', name: 'Free play quasar' }); }
function labNew() {
  if (!isReady(L.mode, L.p)) { L.pendingNew = true; calWant([[L.mode, L.p]]); return; }
  L.q = buildQuasar(newSeed(), rand() * 2 * Math.PI, L.p, labSig());
  commit(L.q);
  labShow();
}
function commit(q) {
  const r = record(q);
  const j = judgeQ(r.q, L.two, L.mode);
  if (j) r.state = j.state;
  L.jar.push(r);
  jarAnimUntil = performance.now() + 400;
  dirtyJar = true;
  updateTally();
}
function startBatch() {
  // a second press stops a running batch, or cancels one still waiting for its false-alarm line
  if (L.batch || L.pendingBatch) { L.batch = null; L.pendingBatch = false; syncLabButtons(); return; }
  if (!isReady(L.mode, L.p)) { L.pendingBatch = true; calWant([[L.mode, L.p]]); if (L.q) labShow(); syncLabButtons(); return; }
  L.batch = { left: 100 };
  if (L.q) labShow();
  if (reduced) while (L.batch && L.batch.left > 0) stepBatch();
  syncLabButtons();
}
function stepBatch() {
  if (!L.batch) return;
  const per = reduced ? 100 : 2;
  for (let i = 0; i < per && L.batch.left > 0; i++) {
    L.q = buildQuasar(newSeed(), rand() * 2 * Math.PI, L.p, labSig());
    commit(L.q);
    L.batch.left--;
  }
  // follow the batch in the close-up only while the visitor is looking at free play;
  // a tile clicked meanwhile keeps the close-up
  if (V.owner === 'lab') labShow();
  if (L.batch.left <= 0) { L.batch = null; syncLabButtons(); }
}
function syncLabButtons() { $('btn-batch').textContent = L.batch || L.pendingBatch ? 'Stop' : 'Run 100'; }
function emptyJar() { L.jar = []; dirtyJar = true; updateTally(); }
function setMeter(id, k, n) { $(id).style.width = n ? `${(100 * k / n).toFixed(1)}%` : '0'; }
function updateTally() {
  const n = L.jar.length;
  let o = 0, x = 0, both = 0, counted = 0, oOK = 0, xOK = 0, ok = 0, fake = 0, bothOver = 0, matchOfBoth = 0;
  for (const r of L.jar) {
    const j = judgeQ(r.q, L.two, L.mode);
    if (!j) continue;
    o += j.oDet; x += j.xDet; both += j.oDet && j.xDet; counted += j.counted;
    oOK += j.oOK; xOK += j.xOK; ok += j.state === 'ok'; fake += j.state === 'fake';
    if (j.oDet && j.xDet) { bothOver++; if (j.match) matchOfBoth++; }
  }
  const inj = L.sig.shape === 'none' ? 0 : L.sig.per;
  const f = (k) => `${fmtInt(k)} · ${n ? pctStr(k / n) : '0%'}`;
  $('row-xray').hidden = !L.two;
  $('lg-fool').hidden = !L.two;
  $('lg-ok').hidden = !inj;
  if (!inj) {
    $('big-num').textContent = fmtInt(counted);
    $('big-label').textContent = L.two ? 'counted: both bands over the line, same period within 5%' : 'counted as having a period';
    $('row-opt-label').textContent = 'Optical went over the line';
    $('row-xray-label').textContent = 'X-ray went over the line';
    $('row-both-label').textContent = L.two ? 'Both went over the line' : 'Counted as a period';
    $('row-opt-val').textContent = f(o); $('row-xray-val').textContent = f(x); $('row-both-val').textContent = f(L.two ? both : counted);
    setMeter('m-opt', o, n); setMeter('m-xray', x, n); setMeter('m-both', L.two ? both : counted, n);
    $('lg-fake').lastChild.textContent = 'counted, and it\'s fake';
  } else {
    $('big-num').textContent = fmtInt(ok);
    $('big-label').textContent = L.two ? `found your ${fmtInt(inj)}-day signal in both bands` : `found your ${fmtInt(inj)}-day signal`;
    $('row-opt-label').textContent = 'Optical found it';
    $('row-xray-label').textContent = 'X-ray found it';
    $('row-both-label').textContent = 'Counted, wrong period';
    $('row-opt-val').textContent = f(oOK); $('row-xray-val').textContent = f(xOK); $('row-both-val').textContent = f(fake);
    setMeter('m-opt', oOK, n); setMeter('m-xray', xOK, n); setMeter('m-both', fake, n);
    $('lg-fake').lastChild.textContent = 'counted, wrong period';
  }
  $('big-den').textContent = `of ${fmtInt(n)} quasar${n === 1 ? '' : 's'}`;
  let note = '';
  if (n && !inj) {
    note = L.two && bothOver >= 5
      ? `Of the ${fmtInt(bothOver)} quasars where both bands went over the line, the two tallest peaks landed within 5% of each other in ${fmtInt(matchOfBoth)} (${pctStr(matchOfBoth / bothOver)}). The paper measured this chance rate at 3.7% for its real light curves, by shuffling periods between sources.`
      : 'None of these quasars has a period in it, so every red dot is a fake.';
  } else if (n && inj) {
    note = `Every quasar in this jar has a ${fmtInt(inj)}-day ${L.sig.shape === 'saw' ? 'sawtooth' : 'sine'}, ${L.sig.amp.toFixed(2)} mag high, in both bands.`;
  }
  $('tally-note').textContent = note;
  $('cv-jar').setAttribute('aria-label', `${fmtInt(n)} quasars in the jar, ${fmtInt(inj ? ok : counted)} counted${inj ? ' with the right period' : ''}.`);
}
let jarCap = 300;
function recolorJar() {
  const now = performance.now();
  const start = Math.max(0, L.jar.length - jarCap);
  let i = 0;
  for (let k = 0; k < L.jar.length; k++) {
    const r = L.jar[k];
    const j = judgeQ(r.q, L.two, L.mode);
    if (!j || r.state === j.state) continue;
    r.from = r.state || 'none';
    r.state = j.state;
    r.t0 = now + (k >= start ? (i++) * (reduced ? 0 : 5) : 0);
  }
  jarAnimUntil = now + i * 5 + 400;
  dirtyJar = true;
  updateTally();
}
function labKnobsChanged(rebuildNoise) {
  L.batch = null; L.pendingBatch = false; syncLabButtons();
  emptyJar();
  calWant([[L.mode, L.p]]);
  if (L.q) {
    if (rebuildNoise) L.q = buildQuasar(L.q.seed, L.q.phi, L.p, labSig());
    else { L.q.sig = labSig(); applySignal(L.q); }
    labShow();
  }
}

/* ---------------------------------------------------------------- colours */
function readColors() {
  const cs = getComputedStyle($('toy'));
  const v = (n) => cs.getPropertyValue(n).trim();
  colors = {
    ink: v('--fap-ink'), grid: v('--fap-grid'), axis: v('--fap-axis'), rule: v('--fap-rule'), panel: v('--fap-panel'),
    opt: v('--fap-opt'), xray: v('--fap-xray'), none: v('--fap-none'), fool: v('--fap-fool'), fake: v('--fap-fake'), ok: v('--fap-ok'),
    mask: v('--fap-mask'), thr: v('--fap-thr'), amber: v('--inst-amber') || '#eba862', sky: v('--inst-sky') || '#9fe0ff',
  };
  colors.rgb = {};
  for (const k of ['none', 'fool', 'fake', 'ok']) colors.rgb[k] = hexRgb(colors[k]);
  dirtyLC = dirtyPG = dirtyJar = dirtyTiles = true;
}
function hexRgb(h) {
  const m = /^#?([0-9a-f]{6})$/i.exec(h) || /^#?([0-9a-f]{3})$/i.exec(h);
  if (!m) return [128, 128, 128];
  let s = m[1];
  if (s.length === 3) s = s.split('').map((c) => c + c).join('');
  return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)];
}
function alpha(hex, a) { const [r, g, b] = hexRgb(hex); return `rgba(${r},${g},${b},${a})`; }

/* ---------------------------------------------------------------- canvas */
function fitCanvas(cv) {
  const r = cv.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
  const w = Math.max(1, Math.round(r.width * dpr)), h = Math.max(1, Math.round(r.height * dpr));
  if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, r.width, r.height);
  return { ctx, w: r.width, h: r.height };
}
const FONT = '600 11px Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif';
const FONT_S = '600 10px Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif';
const FONT_B = '700 11px Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif';
const easeOutBack = (x) => { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2); };
function lowerBound(arr, v) {
  let lo = 0, hi = arr.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid] < v) lo = mid + 1; else hi = mid; }
  return lo;
}
const visibleBands = () => (V.two ? ['opt', 'xray'] : ['opt']);

function drawLC() {
  const { ctx, w, h } = fitCanvas($('cv-lc'));
  const q = V.q;
  if (!q) return;
  const vb = visibleBands();
  const [xa, xb] = spanFor(V.two);
  const L0 = 6, R = 8, T = 4, B = 20, gap = 10;
  const ph = (h - T - B - gap * (vb.length - 1)) / vb.length;
  const X = (m) => L0 + (m - xa) / (xb - xa) * (w - L0 - R);
  const y0 = Math.ceil(toYear(xa)), y1 = Math.floor(toYear(xb));
  const pxPerYear = (w - L0 - R) / ((xb - xa) / 365.25);
  const step = pxPerYear >= 44 ? 1 : pxPerYear >= 22 ? 2 : 4;
  ctx.font = FONT_S; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  for (let yr = y0; yr <= y1; yr++) {
    const x = X(MJD_J2000 + (yr - 2000) * 365.25);
    ctx.strokeStyle = colors.grid; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x, T); ctx.lineTo(x, h - B); ctx.stroke();
    if (yr % step === 0) { ctx.fillStyle = colors.axis; ctx.fillText(String(yr), x, h - B + 5); }
  }
  const tNow = PB.t;
  vb.forEach((key, i) => {
    const b = bands[key], d = q.bands[key];
    const top = T + i * (ph + gap), bot = top + ph;
    const Y = (v) => bot - 4 - (v - d.ylo) / (d.yhi - d.ylo) * (ph - 8);
    const col = colors[key];
    ctx.strokeStyle = colors.rule; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(L0, bot + 0.5); ctx.lineTo(w - R, bot + 0.5); ctx.stroke();
    ctx.save(); ctx.beginPath(); ctx.rect(L0, top, w - L0 - R, ph); ctx.clip();
    ctx.strokeStyle = alpha(col, 0.35); ctx.lineWidth = 1; ctx.lineJoin = 'round';
    ctx.beginPath();
    const pxStep = Math.max(1, Math.floor(b.mt.length / ((w - L0 - R) * 1.5)));
    let started = false;
    for (let k = 0; k < b.mt.length; k += pxStep) {
      const m = b.mt[k];
      if (m < xa) continue;
      const x = X(m), y = Y(d.cont[k]);
      if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
    }
    ctx.stroke();
    if (d.fit) {
      ctx.setLineDash([5, 4]); ctx.strokeStyle = alpha(col, 0.9); ctx.lineWidth = 1.5;
      ctx.beginPath();
      const ta = b.t[0], tb = b.t[b.N - 1];
      for (let s = 0; s <= 240; s++) {
        const m = ta + (tb - ta) * s / 240;
        const x = X(m), y = Y(d.fit(m));
        if (s === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke(); ctx.setLineDash([]);
    }
    const rad = key === 'xray' ? 2.3 : 1.9;
    for (let j = 0; j < b.N; j++) {
      const x = X(b.t[j]), y = Y(d.obs[j]);
      const ey = (Y(d.obs[j] - d.err) - Y(d.obs[j] + d.err)) / 2;
      ctx.strokeStyle = alpha(col, 0.28); ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x, y - ey); ctx.lineTo(x, y + ey); ctx.stroke();
      ctx.fillStyle = col; ctx.beginPath(); ctx.arc(x, y, rad, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
    if (tNow >= xa && tNow <= xb) {
      const k = Math.min(lowerBound(b.mt, tNow), b.mt.length - 1);
      const x = X(tNow), y = Y(d.cont[k]);
      ctx.fillStyle = alpha(col, 0.22); ctx.beginPath(); ctx.arc(x, y, 8, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(x, y, 3.4, 0, Math.PI * 2); ctx.fill();
    }
    ctx.font = FONT; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    const narrow = w < 560;
    const lab = key === 'opt' ? (narrow ? `Optical · ${b.N} points` : `Optical · ${b.N} points, ASAS-SN-like`) : (narrow ? 'X-ray · 157 points' : 'X-ray · 157 monthly points, Swift-BAT-like');
    const tw = ctx.measureText(lab).width;
    ctx.fillStyle = alpha(colors.panel, 0.8); ctx.fillRect(L0 + 2, top + 2, tw + 10, 17);
    ctx.fillStyle = col; ctx.fillText(lab, L0 + 7, top + 5);
    ctx.textAlign = 'right'; ctx.fillStyle = colors.axis; ctx.font = FONT_S;
    ctx.fillText(narrow ? 'brighter ↑' : 'brighter ↑   dashed: best-fit sine', w - R - 2, top + 5);
  });
  if (tNow >= xa && tNow <= xb) {
    const x = X(tNow);
    ctx.strokeStyle = 'rgba(255,255,255,.3)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x + 0.5, T); ctx.lineTo(x + 0.5, h - B); ctx.stroke();
  }
}

function drawPG() {
  const { ctx, w, h } = fitCanvas($('cv-pg'));
  const q = V.q;
  if (!q) return;
  const vb = visibleBands();
  const pRight = Math.max(...vb.map((k) => bands[k].pmax));
  const L0 = 6, R = 8, T = 6, B = 20, gap = 12;
  const ph = (h - T - B - gap * (vb.length - 1)) / vb.length;
  const lx0 = Math.log(P_MIN), lx1 = Math.log(pRight);
  const X = (P) => L0 + (Math.log(P) - lx0) / (lx1 - lx0) * (w - L0 - R);
  ctx.font = FONT_S; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  for (const P of [100, 150, 200, 300, 500, 700, 1000, 1500]) {
    if (P > pRight) continue;
    const x = X(P);
    ctx.strokeStyle = colors.grid; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x, T); ctx.lineTo(x, h - B); ctx.stroke();
    ctx.fillStyle = colors.axis; ctx.fillText(P === 1500 ? '1500 days' : String(P), x, h - B + 5);
  }
  for (const [a, b] of MASKS) {
    const xa = X(a), xb = X(b);
    ctx.fillStyle = colors.mask; ctx.fillRect(xa, T, xb - xa, h - B - T);
  }
  const j = judgeQ(q, V.two, V.mode);
  if (V.two && j) {
    const Po = q.bands.opt.P;
    const lo = Po * (1 - MATCH / 2) / (1 + MATCH / 2), hi = Po * (1 + MATCH / 2) / (1 - MATCH / 2);
    ctx.fillStyle = relDiff(q.bands.opt.P, q.bands.xray.P) < MATCH ? alpha(colors.ok, 0.18) : 'rgba(255,255,255,.05)';
    ctx.fillRect(X(lo), T, Math.max(2, X(hi) - X(lo)), h - B - T);
  }
  if (V.reveal && q.inj) {
    const x = X(q.inj);
    ctx.strokeStyle = alpha(colors.ok, 0.8); ctx.setLineDash([2, 3]); ctx.lineWidth = 1.2;
    ctx.beginPath(); ctx.moveTo(x, T); ctx.lineTo(x, h - B); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = colors.ok;
    ctx.beginPath(); ctx.moveTo(x, h - B - 1); ctx.lineTo(x - 5, h - B + 6); ctx.lineTo(x + 5, h - B + 6); ctx.closePath(); ctx.fill();
  }
  vb.forEach((key, i) => {
    const b = bands[key], d = q.bands[key];
    const top = T + i * (ph + gap), bot = top + ph;
    const col = colors[key];
    const thr = thrOf(key, V.mode, q.p);
    const ymax = Math.max(0.05, d.m * 1.2, thr ? thr * 1.3 : 0);
    const Y = (p) => bot - p / ymax * (ph - 4);
    ctx.strokeStyle = colors.rule; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(L0, bot + 0.5); ctx.lineTo(w - R, bot + 0.5); ctx.stroke();
    const grad = ctx.createLinearGradient(0, top, 0, bot);
    grad.addColorStop(0, alpha(col, 0.32)); grad.addColorStop(1, alpha(col, 0.02));
    const segs = [];
    let cur = [];
    for (let f = 0; f < b.nf; f++) {
      if (f > 0 && b.per[f] / b.per[f - 1] > 1.01) { segs.push(cur); cur = []; }
      cur.push(f);
    }
    segs.push(cur);
    for (const s of segs) {
      if (s.length < 2) continue;
      ctx.beginPath(); ctx.moveTo(X(b.per[s[0]]), bot);
      for (const f of s) ctx.lineTo(X(b.per[f]), Y(d.power[f]));
      ctx.lineTo(X(b.per[s[s.length - 1]]), bot); ctx.closePath(); ctx.fillStyle = grad; ctx.fill();
      ctx.beginPath();
      s.forEach((f, n) => { const x = X(b.per[f]), y = Y(d.power[f]); if (n === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); });
      ctx.strokeStyle = col; ctx.lineWidth = 1.5; ctx.lineJoin = 'round'; ctx.stroke();
    }
    ctx.font = FONT; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    ctx.fillStyle = col; ctx.fillText(key === 'opt' ? 'Optical' : 'X-ray', L0 + 4, top + 2);
    if (thr === null) return;
    const y = Y(thr);
    ctx.setLineDash([6, 4]); ctx.strokeStyle = alpha(colors.thr, 0.7); ctx.lineWidth = 1.3;
    ctx.beginPath(); ctx.moveTo(L0, y); ctx.lineTo(w - R, y); ctx.stroke(); ctx.setLineDash([]);
    ctx.font = FONT_S; ctx.textAlign = 'right'; ctx.textBaseline = 'bottom';
    const tag = V.mode === 'white' ? 'textbook line' : 'red-noise line';
    const tagW = ctx.measureText(tag).width;
    ctx.fillStyle = alpha(colors.panel, 0.9); ctx.fillRect(w - R - tagW - 6, y - 15, tagW + 6, 12);
    ctx.fillStyle = colors.axis; ctx.fillText(tag, w - R - 2, y - 3);
    const x = X(d.P), yp = Y(d.m), above = d.m > thr;
    if (above) {
      ctx.fillStyle = alpha(col, 0.22); ctx.beginPath(); ctx.arc(x, yp, 9, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = col; ctx.beginPath(); ctx.arc(x, yp, 4.5, 0, Math.PI * 2); ctx.fill();
    } else {
      ctx.strokeStyle = colors.axis; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(x, yp, 4.5, 0, Math.PI * 2); ctx.stroke();
    }
    const fr = noiseFrac(key, d.m, V.mode, q.p);
    const txt = `tallest peak ${fmtInt(d.P)} d`;
    const sub = fr === null ? '' : fr <= 0 ? `${V.mode === 'white' ? 'white' : 'red'} noise this tall: under 1 in 1,000` : `${V.mode === 'white' ? 'white' : 'red'} noise this tall: ${pctStr(fr)}`;
    ctx.font = FONT_B;
    const tw1 = ctx.measureText(txt).width; ctx.font = FONT_S;
    const tw = Math.max(tw1, ctx.measureText(sub).width);
    let lx = x + 11, align = 'left';
    if (lx + tw > w - R - 4) { lx = x - 11; align = 'right'; }
    const ly = Math.max(top + 14, Math.min(yp - 8, bot - 30));
    ctx.textAlign = align; ctx.textBaseline = 'top';
    ctx.fillStyle = alpha(colors.panel, 0.85);
    ctx.fillRect(align === 'left' ? lx - 3 : lx - tw - 3, ly - 2, tw + 6, 27);
    ctx.font = FONT_B; ctx.fillStyle = above ? col : colors.axis; ctx.fillText(txt, lx, ly);
    ctx.font = FONT_S; ctx.fillStyle = colors.axis; ctx.fillText(sub, lx, ly + 13);
  });
}

function drawTile(i) {
  const it = G.deck[i];
  const el = $(`tile-${i}`);
  if (!it || !el) return;
  const cv = el.querySelector('canvas');
  const { ctx, w, h } = fitCanvas(cv);
  const r = round(), q = it.q;
  const vb = r.two ? ['opt', 'xray'] : ['opt'];
  const lcH = Math.round(h * 0.4), pgTop = lcH + 6, pgBot = h - 2;
  // light curves
  const [xa, xb] = spanFor(r.two);
  const X = (m) => (m - xa) / (xb - xa) * w;
  const bh = lcH / vb.length;
  vb.forEach((key, k) => {
    const b = bands[key], d = q.bands[key];
    const top = k * bh;
    const Y = (v) => top + bh - 1.5 - (v - d.ylo) / (d.yhi - d.ylo) * (bh - 3);
    ctx.fillStyle = colors[key];
    for (let j = 0; j < b.N; j++) ctx.fillRect(X(b.t[j]) - 0.8, Y(d.obs[j]) - 0.8, 1.6, 1.6);
  });
  // periodograms, each divided by its own false-alarm line, so the line sits at 1
  const pRight = Math.max(...vb.map((k) => bands[k].pmax));
  const lx0 = Math.log(P_MIN), lx1 = Math.log(pRight);
  const PX = (P) => (Math.log(P) - lx0) / (lx1 - lx0) * w;
  let ymax = 1.5;
  const thr = {};
  for (const key of vb) { thr[key] = thrOf(key, r.mode, q.p) || q.bands[key].m; ymax = Math.max(ymax, q.bands[key].m / thr[key] * 1.12); }
  const Y = (v) => pgBot - v / ymax * (pgBot - pgTop);
  ctx.fillStyle = 'rgba(255,255,255,.035)'; ctx.fillRect(0, pgTop, w, pgBot - pgTop);
  for (const [a, b] of MASKS) { ctx.fillStyle = colors.mask; ctx.fillRect(PX(a), pgTop, PX(b) - PX(a), pgBot - pgTop); }
  if (V.reveal && G.checked && q.inj) {
    ctx.strokeStyle = alpha(colors.ok, 0.9); ctx.lineWidth = 1.2; ctx.setLineDash([2, 2]);
    ctx.beginPath(); ctx.moveTo(PX(q.inj), pgTop); ctx.lineTo(PX(q.inj), pgBot); ctx.stroke(); ctx.setLineDash([]);
  }
  for (const key of vb) {
    const b = bands[key], d = q.bands[key];
    ctx.strokeStyle = colors[key]; ctx.lineWidth = 1.2; ctx.beginPath();
    let prev = null;
    for (let f = 0; f < b.nf; f++) {
      const x = PX(b.per[f]), y = Y(d.power[f] / thr[key]);
      if (prev !== null && b.per[f] / prev > 1.01) ctx.moveTo(x, y); else if (f === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      prev = b.per[f];
    }
    ctx.stroke();
    ctx.fillStyle = colors[key];
    ctx.beginPath(); ctx.arc(PX(d.P), Y(d.m / thr[key]), 2.6, 0, Math.PI * 2); ctx.fill();
  }
  if (thrOf('opt', r.mode, q.p) !== null) {
    ctx.setLineDash([4, 3]); ctx.strokeStyle = alpha(colors.thr, 0.6); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, Y(1)); ctx.lineTo(w, Y(1)); ctx.stroke(); ctx.setLineDash([]);
  }
}

function jarGeom(w, h) {
  const pitch = w < 330 ? 11 : 12;
  const cols = Math.max(10, Math.floor(w / pitch));
  const rows = Math.max(1, Math.floor(h / pitch));
  return { pitch: w / cols, cols, rows, cap: cols * rows };
}
function drawJar() {
  const cv = $('cv-jar');
  if (!cv.offsetParent) return false;
  const { ctx, w, h } = fitCanvas(cv);
  const g = jarGeom(w, h);
  jarCap = g.cap;
  const now = performance.now();
  const start = Math.max(0, L.jar.length - g.cap);
  const r0 = g.pitch * 0.36;
  let anim = false;
  for (let i = 0; i < g.cap; i++) {
    const k = start + i;
    const x = (i % g.cols) * g.pitch + g.pitch / 2, y = h - (Math.floor(i / g.cols) * g.pitch + g.pitch / 2);
    if (k >= L.jar.length) {
      ctx.fillStyle = 'rgba(255,255,255,.08)'; ctx.beginPath(); ctx.arc(x, y, 1.2, 0, Math.PI * 2); ctx.fill();
      continue;
    }
    const r = L.jar[k];
    let s = 1;
    const age = now - r.born;
    if (!reduced && age < 320) { s = easeOutBack(Math.max(0, age / 320)); anim = true; }
    const to = colors.rgb[r.state || 'none'];
    let rgb = to;
    if (r.from && now < r.t0 + 260) {
      const p = Math.max(0, Math.min(1, (now - r.t0) / 260));
      const fr = colors.rgb[r.from];
      rgb = [0, 1, 2].map((c) => Math.round(fr[c] + (to[c] - fr[c]) * p));
      anim = true;
    }
    ctx.fillStyle = `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
    ctx.beginPath(); ctx.arc(x, y, r0 * Math.max(0.01, s), 0, Math.PI * 2); ctx.fill();
  }
  if (L.jar.length > g.cap) {
    ctx.font = FONT_S; ctx.textAlign = 'right'; ctx.textBaseline = 'top'; ctx.fillStyle = colors.axis;
    ctx.fillText(`showing the last ${fmtInt(g.cap)}`, w - 2, 1);
  }
  return anim;
}

/* ------------------------------------------------------------- 3D scene */
function levelAt(key, tt) {
  const q = V.q;
  if (!q) return { lvl: 1, v: 0 };
  const b = bands[key], d = q.bands[key];
  const k = Math.min(lowerBound(b.mt, tt), b.mt.length - 1);
  const v = d.cont[k];
  const sd = d.rms || 0.1;
  return { lvl: Math.min(1.9, Math.max(0.45, Math.exp(0.42 * v / sd))), v };
}
function sceneState() {
  const tt = PB.t, q = V.q;
  const o = levelAt('opt', tt), x = levelAt('xray', tt);
  $('st-opt').textContent = `${o.v >= 0 ? '+' : '−'}${Math.abs(o.v).toFixed(2)} mag`;
  if (V.two) $('st-xray').textContent = `${x.v >= 0 ? '+' : '−'}${Math.abs(x.v).toFixed(2)} mag`;
  const bin = V.reveal && q && q.inj;
  return { disc: o.lvl, corona: x.lvl, xrayOn: V.two, binary: bin ? { on: true, angle: 2 * Math.PI * tt / q.inj + q.phi } : { on: false, angle: 0 }, reduced };
}
function placeTags(pos) {
  const tags = { bh: $('tag-bh'), disc: $('tag-disc'), cor: $('tag-cor'), sec: $('tag-sec') };
  for (const [k, el] of Object.entries(tags)) {
    const p = pos && pos[k];
    if (!p) { el.classList.remove('is-on'); continue; }
    el.classList.add('is-on');
    const W = pos.w || 600, H = pos.h || 400;
    const x = Math.min(Math.max(6, p[0]), W - el.offsetWidth - 6);
    const y = Math.min(Math.max(58, p[1]), H - el.offsetHeight - 64);
    el.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
  }
}
function initScene() {
  const host = $('scene-host');
  if (!window.WebGLRenderingContext) { useFallback(host); return; }
  import('./fake-a-period-scene.js')
    .then((m) => m.createQuasarScene(host, { reduced }))
    .then((api) => { sceneApi = api; })
    .catch((err) => { console.warn('3D view unavailable, using the flat version:', err && err.message); useFallback(host); });
  if ('IntersectionObserver' in window) {
    new IntersectionObserver((es) => { sceneVisible = es[0].isIntersecting; }, { rootMargin: '80px' }).observe($('scene'));
  }
}
function useFallback(host) {
  host.innerHTML = '';
  const cv = document.createElement('canvas');
  cv.className = 'fap-scene-fallback';
  host.appendChild(cv);
  const note = document.createElement('p');
  note.className = 'fap-note-flat';
  note.textContent = 'Flat version: this browser has no WebGL.';
  $('scene').appendChild(note);
  sceneApi = {
    frame(st) {
      const r = cv.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      if (cv.width !== Math.round(r.width * dpr)) { cv.width = Math.round(r.width * dpr); cv.height = Math.round(r.height * dpr); }
      const ctx = cv.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const w = r.width, h = r.height, cx = w / 2, cy = h * 0.55, R = Math.min(w * 0.4, h * 0.95);
      ctx.clearRect(0, 0, w, h);
      ctx.save(); ctx.translate(cx, cy); ctx.scale(1, 0.32);
      const g = ctx.createRadialGradient(0, 0, R * 0.12, 0, 0, R);
      const Lv = st.disc;
      g.addColorStop(0, `rgba(255,248,230,${Math.min(1, 0.55 * Lv)})`);
      g.addColorStop(0.3, `rgba(255,190,110,${Math.min(1, 0.5 * Lv)})`);
      g.addColorStop(1, 'rgba(120,30,10,0)');
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(0, 0, R, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
      ctx.fillStyle = '#000'; ctx.beginPath(); ctx.arc(cx, cy, R * 0.1, 0, Math.PI * 2); ctx.fill();
      const pos = { bh: [cx + R * 0.12, cy + 8], disc: [cx + R * 0.55, cy + R * 0.2] };
      if (st.xrayOn) {
        const cr = R * 0.08 * (0.6 + 0.5 * st.corona);
        const cg = ctx.createRadialGradient(cx, cy - R * 0.16, 0, cx, cy - R * 0.16, cr);
        cg.addColorStop(0, 'rgba(255,255,255,1)'); cg.addColorStop(1, 'rgba(140,120,255,0)');
        ctx.fillStyle = cg; ctx.beginPath(); ctx.arc(cx, cy - R * 0.16, cr, 0, Math.PI * 2); ctx.fill();
        pos.cor = [cx - R * 0.5, cy - R * 0.3];
      }
      if (st.binary.on) {
        const a = st.binary.angle, x = cx + Math.cos(a) * R * 0.3, y = cy - Math.sin(a) * R * 0.1;
        ctx.fillStyle = colors && colors.sky ? alpha(colors.sky, 0.7) : 'rgba(160,215,255,.7)'; ctx.beginPath(); ctx.arc(x, y, 9, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#000'; ctx.beginPath(); ctx.arc(x, y, 5, 0, Math.PI * 2); ctx.fill();
        pos.sec = [x + 10, y - 26];
      }
      return pos;
    },
  };
}

/* ------------------------------------------------------------- main loop */
let lastTs = 0;
function loop(ts) {
  const dt = lastTs ? Math.min(0.05, (ts - lastTs) / 1000) : 0.016;
  lastTs = ts;
  step(dt);
  requestAnimationFrame(loop);
}
function step(dt) {
  if (L.batch) stepBatch();
  if (V.q && PB.playing) {
    PB.t += dt * PB.speed;
    if (PB.t >= PB.t1) PB.t = PB.t0 + ((PB.t - PB.t0) % (PB.t1 - PB.t0));
    dirtyLC = true;
  }
  if (dirtyLC) { drawLC(); dirtyLC = false; }
  if (dirtyPG) { drawPG(); dirtyPG = false; }
  if (dirtyTiles) { renderTiles(); dirtyTiles = false; }
  if (dirtyJar || performance.now() < jarAnimUntil) dirtyJar = drawJar();
  $('scene-year').textContent = toYear(PB.t).toFixed(1);
  if (sceneApi && sceneVisible && V.q) placeTags(sceneApi.frame(sceneState(), dt));
}
function syncPlayButton() {
  $('btn-play').setAttribute('aria-pressed', String(PB.playing));
  $('play-label').textContent = PB.playing ? 'Pause' : 'Play';
}

/* ---------------------------------------------------------------- inputs */
const tauFromSlider = (v) => TAU_MIN * Math.pow(TAU_MAX / TAU_MIN, v / 1000);
const fmtTau = (t) => (t < 100 ? `${Math.round(t)} d` : `${fmtInt(Math.round(t / 10) * 10)} d`);
function setFill(el) { el.style.setProperty('--p', String((el.value - el.min) / (el.max - el.min))); }

function wire() {
  // Check / Next round / See how you did / Play again all share one button, so a double click
  // would skip straight past the answers; a click within 400 ms of the last step is ignored
  $('btn-check').addEventListener('click', () => {
    if (!gameStepAllowed()) return;
    if (G.done) restartGame(); else check();
  });
  $('btn-mark').addEventListener('click', () => togglePick(G.focus));
  $('btn-play').addEventListener('click', () => { PB.playing = !PB.playing; syncPlayButton(); });
  $('btn-new').addEventListener('click', labNew);
  $('btn-batch').addEventListener('click', startBatch);
  $('btn-empty').addEventListener('click', emptyJar);
  $('lab').addEventListener('toggle', () => { if ($('lab').open) { dirtyJar = true; if (!L.q) labNew(); } });
  for (const c of document.querySelectorAll('[data-two]')) {
    c.addEventListener('click', () => {
      L.two = c.dataset.two === '1';
      for (const o of document.querySelectorAll('[data-two]')) o.setAttribute('aria-pressed', String(o === c));
      recolorJar(); if (!L.q) labNew(); else labShow();
    });
  }
  for (const c of document.querySelectorAll('[data-line]')) {
    c.addEventListener('click', () => {
      L.mode = c.dataset.line;
      for (const o of document.querySelectorAll('[data-line]')) o.setAttribute('aria-pressed', String(o === c));
      calWant([[L.mode, L.p]]);
      recolorJar(); if (!L.q) labNew(); else labShow();
    });
  }
  for (const c of document.querySelectorAll('[data-shape]')) {
    c.addEventListener('click', () => {
      L.sig.shape = c.dataset.shape;
      for (const o of document.querySelectorAll('[data-shape]')) o.setAttribute('aria-pressed', String(o === c));
      $('k-amp').disabled = $('k-per').disabled = L.sig.shape === 'none';
      labKnobsChanged(false);
    });
  }
  const knob = (id, fn, rebuild) => {
    const el = $(id); setFill(el);
    el.addEventListener('input', () => { setFill(el); fn(+el.value); labKnobsChanged(rebuild); });
  };
  knob('k-tau', (v) => { L.p.tau = tauFromSlider(v); $('o-tau').textContent = fmtTau(L.p.tau); }, true);
  knob('k-sig', (v) => { L.p.sigma = v; $('o-sig').textContent = `${v.toFixed(2)} mag`; }, true);
  knob('k-xerr', (v) => { L.p.xerr = v; $('o-xerr').textContent = `${v.toFixed(2)} mag`; }, true);
  knob('k-amp', (v) => { L.sig.amp = v; $('o-amp').textContent = `${v.toFixed(2)} mag`; }, false);
  knob('k-per', (v) => { L.sig.per = v; $('o-per').textContent = `${v} d${isMasked(v) ? ' (skipped stripe)' : ''}`; }, false);
  const onReduce = () => {
    reduced = mqReduce.matches;
    if (reduced) { PB.playing = false; syncPlayButton(); }
    if (sceneApi && sceneApi.setReduced) sceneApi.setReduced(reduced);
  };
  if (mqReduce.addEventListener) mqReduce.addEventListener('change', onReduce); else mqReduce.addListener(onReduce);
  if ('ResizeObserver' in window) {
    const ro = new ResizeObserver(() => { dirtyLC = dirtyPG = dirtyJar = dirtyTiles = true; });
    for (const id of ['cv-lc', 'cv-pg', 'cv-jar', 'tiles']) ro.observe($(id));
  } else {
    window.addEventListener('resize', () => { dirtyLC = dirtyPG = dirtyJar = dirtyTiles = true; });
  }
}

/* ------------------------------------------------------------------ boot */
function boot() {
  bands.opt = makeBand('opt', opticalCadence());
  bands.xray = makeBand('xray', xrayCadence());
  for (const el of document.querySelectorAll('[data-fill="opt-n"]')) el.textContent = String(bands.opt.N);
  readColors();
  wire();
  syncPlayButton();
  initScene();
  calWant([['white', DEF], ['red', DEF]]);
  deal();
  updateTally();
  requestAnimationFrame(loop);
}

/* LS self-test: a noise-free sine should put the tallest peak at its period. */
function selfTest(P = 437, amp = 0.3) {
  const out = {};
  for (const key of ['opt', 'xray']) {
    const b = bands[key];
    const y = new Float64Array(b.N);
    for (let i = 0; i < b.N; i++) y[i] = amp * Math.sin(2 * Math.PI * b.t[i] / P + 0.7);
    const r = lsFull(b, y, null);
    out[key] = { injected: P, peak: +b.per[r.k].toFixed(2), relErr: +(Math.abs(b.per[r.k] - P) / P).toFixed(4) };
  }
  return out;
}
// tick(n, dt): advance the animation by hand (for testing in a hidden tab)
// (the read-only getters below are for scripts/qa/fake-a-period_interactions.py)
window.fakeAPeriod = {
  selfTest, tick: (n = 1, dt = 1 / 60) => { for (let i = 0; i < n; i++) step(dt); return PB.t; }, G, L, V, cal, bands, judge: judgeQ,
  PB, ROUNDS, DEF, isReady, calKey, calQueueKeys: () => calQueue.map((w) => w.key), calJobKey: () => (calJob ? calJob.key : null),
};

boot();
