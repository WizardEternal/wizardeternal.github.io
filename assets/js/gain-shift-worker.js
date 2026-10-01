// Worker for /play/gain-shift/: simulates the spectrum, fits it, runs the three checks,
// builds the fit-statistic terrain and the posterior samples. Heavy work stays off the main thread.
import { GS_DATA } from "./gain-shift-data.js";
import { createCore, mulberry32, gaussPair, cholesky, normCdf, poissonInv, drawPrior, LO, HI, EXPOSURES } from "./gain-shift-core.js";

const core = createCore(GS_DATA);
const NCH = core.NCH, NP = 5;
const S_CLOUD = 1400;      // posterior samples drawn for the cloud
const R_PPC = 400;         // posterior-predictive replicates
const S_IS = 400;          // importance samples
const K_NULL = 100;        // clean spectra used to calibrate the reweighting test (empirical null)
const N_BANDS = 20;        // the stand-in "network" sees the spectrum squeezed into 20 bands
const G_GRID = Array.from({ length: 21 }, (_, j) => 0.95 + 0.005 * j);   // gain prior U[0.95, 1.05]

// fixed random numbers, so pictures move smoothly instead of re-sampling on every update
function fixedNormals(seed, n) {
  const r = mulberry32(seed), out = new Float64Array(n);
  for (let i = 0; i < n; i += 2) { const [a, b] = gaussPair(r); out[i] = a; if (i + 1 < n) out[i + 1] = b; }
  return out;
}
const Zc = fixedNormals(11, S_CLOUD * NP);
const Uc = (() => { const r = mulberry32(12), u = new Float64Array(S_CLOUD); for (let i = 0; i < S_CLOUD; i++) u[i] = r(); return u; })();
const Zp = fixedNormals(13, R_PPC * NP);
const Zi = fixedNormals(14, S_IS * NP);
const bandOf = Int32Array.from({ length: NCH }, (_, c) => Math.floor(c * N_BANDS / NCH));

const clampTh = (t) => t.map((v, i) => Math.min(HI[i], Math.max(LO[i], v)));
const inBox = (t) => t.every((v, i) => v >= LO[i] && v <= HI[i]);
const sum = (a) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i]; return s; };
const yieldNow = () => new Promise((r) => setTimeout(r, 0));

function uniformsFor(seed) {
  const r = mulberry32(seed * 7919 + 17), u = new Float64Array(NCH);
  for (let c = 0; c < NCH; c++) u[c] = r();
  return u;
}
function drawCounts(u, mu) {
  const n = new Float64Array(NCH);
  for (let c = 0; c < NCH; c++) n[c] = poissonInv(u[c], mu[c]);
  return n;
}
function cholOrDiag(cov) {
  let L = cholesky(cov, NP);
  if (L) return L;
  L = new Float64Array(NP * NP);
  for (let i = 0; i < NP; i++) L[i * NP + i] = Math.sqrt(Math.max(cov[i * NP + i], 1e-12));
  return L;
}
function sampleAt(th, L, Z, s, out) {
  for (let i = 0; i < NP; i++) {
    let v = th[i];
    for (let k = 0; k <= i; k++) v += L[i * NP + k] * Z[s * NP + k];
    out[i] = v;
  }
  return out;
}

// ---------------- caches ----------------
const cache = { baseKey: null, base: null, noiseKey: null, noise: null, lastFit: null, nullESS: new Map() };
let latest = null, running = false, catalogToken = 0;

function baseSetup(src, level) {
  const expo = EXPOSURES[level];
  const { H } = core.fisherAt(src, 1, expo);
  // conditional 2D covariance of (Gamma, lnK) with the other three held fixed
  const a = H[1 * NP + 1], b = H[1 * NP + 2], d = H[2 * NP + 2], det = a * d - b * b;
  const sG = Math.sqrt(d / det), sK = Math.sqrt(a / det);
  // marginal Laplace widths (noise-free fit at the truth) set the cloud axes
  const f0 = core.fit(core.expected(src, 1, 0, expo), expo, 1, src);
  const sd = [0, 1, 2, 3, 4].map((i) => Math.sqrt(Math.max(f0.cov[i * NP + i], 1e-12)));
  // landscape axes: 3.5 marginal sigma either side of the truth, kept inside the prior
  const span = (i, hw) => {
    let lo = src[i] - hw, hi = src[i] + hw;
    if (lo < LO[i]) { hi = Math.min(HI[i], hi + LO[i] - lo); lo = LO[i]; }
    if (hi > HI[i]) { lo = Math.max(LO[i], lo - (hi - HI[i])); hi = HI[i]; }
    return [lo, hi];
  };
  const [g0, g1] = span(1, 3.5 * sd[1]), [k0, k1] = span(2, 3.5 * sd[2]);
  const land = { g0, g1, k0, k1 };
  const cl = [1, 2, 0].map((i) => {
    const hw = Math.min(3.2 * sd[i], (HI[i] - LO[i]) * 0.5);
    let lo = src[i] - hw, hi = src[i] + hw;
    if (lo < LO[i]) { hi += LO[i] - lo; lo = LO[i]; }
    if (hi > HI[i]) { lo -= hi - HI[i]; hi = HI[i]; }
    return [Math.max(lo, LO[i]), Math.min(hi, HI[i])];
  });
  const counts = sum(core.expected(src, 1, 0, expo));
  return { expo, land, cloudBox: cl, sdTruth: sd, counts, cond: [sG, sK] };
}

// Profile of the fit statistic over (Gamma, ln K_pl): at every grid point NH, kT and the
// blackbody norm are refitted. Computed on a coarse grid, then upsampled (Catmull-Rom).
const NPROF = 15, UP = 4;   // 15 x 15 refits, drawn as a 57 x 57 surface
async function landscape(n, fit, Cref, land, expo, isStale) {
  const prof = new Float64Array(NPROF * NPROF);
  const fixed = [false, true, true, false, false];
  const gAt = (i) => land.g0 + (land.g1 - land.g0) * i / (NPROF - 1);
  const kAt = (j) => land.k0 + (land.k1 - land.k0) * j / (NPROF - 1);
  // start each column from the best fit, then walk outward in K from the middle row
  let colStart = fit.th.slice();
  const i0 = Math.round((fit.th[1] - land.g0) / (land.g1 - land.g0) * (NPROF - 1));
  const orderI = [];
  for (let d = 0; d < NPROF; d++) { const a = i0 + d, b = i0 - d - 1; if (a >= 0 && a < NPROF) orderI.push(a); if (b >= 0 && b < NPROF) orderI.push(b); }
  const seeds = new Array(NPROF);
  for (const i of orderI) {
    const nb = seeds[i - 1] || seeds[i + 1] || colStart;
    let start = nb.slice(); start[1] = gAt(i);
    const jm = Math.min(NPROF - 1, Math.max(0, Math.round((start[2] - land.k0) / (land.k1 - land.k0) * (NPROF - 1))));
    let up = null, dn = null;
    for (let d = 0; d < NPROF; d++) {
      for (const [j, from] of [[jm + d, up], [jm - d - 1, dn]]) {
        if (j < 0 || j >= NPROF) continue;
        const t0 = (from || start).slice(); t0[1] = gAt(i); t0[2] = kAt(j);
        const f = core.fit(n, expo, 1, t0, { fixed, noCov: true, maxIt: 30, tol: 2e-3 });
        prof[i * NPROF + j] = f.C;
        if (j >= jm) up = f.th; else dn = f.th;
        if (j === jm) seeds[i] = f.th;
      }
    }
    await yieldNow(); if (isStale()) return null;
  }
  // upsample to the mesh resolution
  const N = UP * (NPROF - 1) + 1, out = new Float32Array(N * N);
  const P = (i, j) => prof[Math.min(NPROF - 1, Math.max(0, i)) * NPROF + Math.min(NPROF - 1, Math.max(0, j))];
  const cr = (p0, p1, p2, p3, t) => 0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t + (-p0 + 3 * p1 - 3 * p2 + p3) * t * t * t);
  for (let I = 0; I < N; I++) for (let J = 0; J < N; J++) {
    const fi = I / UP, fj = J / UP, i = Math.floor(fi), j = Math.floor(fj), ti = fi - i, tj = fj - j;
    const row = (ii) => cr(P(ii, j - 1), P(ii, j), P(ii, j + 1), P(ii, j + 2), tj);
    let C = cr(row(i - 1), row(i), row(i + 1), row(i + 2), ti);
    C = Math.max(C, fit.C);   // the interpolant must not dip below the global best fit
    const dC = C - Cref;
    out[I * N + J] = Math.sign(dC) * Math.sqrt(Math.abs(dC));
  }
  return { heights: out, N };
}

function cloudFromFit(fit, out) {
  const L = cholOrDiag(fit.cov), t = new Float64Array(NP);
  for (let s = 0; s < S_CLOUD; s++) {
    sampleAt(fit.th, L, Zc, s, t);
    const ok = inBox(t);
    out[s * 3] = ok ? t[1] : NaN; out[s * 3 + 1] = ok ? t[2] : NaN; out[s * 3 + 2] = ok ? t[0] : NaN;
  }
  return out;
}

// Terrain range: covers the truth, the zero-gain fit and the current fit with room to spare.
// Kept per noise setting so the axes stay still while the gain slider moves, and only
// widened when the fit would otherwise leave the map (a strong line, say).
function terrainRange(base, pts, prev) {
  const sG = base.sdTruth[1], sK = base.sdTruth[2];
  const inside = (r) => r && pts.every(([g, k]) => g > r.g0 + 1.2 * sG && g < r.g1 - 1.2 * sG && k > r.k0 + 1.2 * sK && k < r.k1 - 1.2 * sK);
  if (inside(prev)) return prev;
  const axis = (vals, sd, lo, hi) => {
    const a = Math.min(...vals), b = Math.max(...vals), c = (a + b) / 2, hw = Math.max(3.5 * sd, (b - a) / 2 + 2.5 * sd);
    let l = c - hw, h = c + hw;
    if (l < lo) { h = Math.min(hi, h + lo - l); l = lo; }
    if (h > hi) { l = Math.max(lo, l - (h - hi)); h = hi; }
    return [l, h];
  };
  const [g0, g1] = axis(pts.map((p) => p[0]), sG, LO[1], HI[1]);
  const [k0, k1] = axis(pts.map((p) => p[1]), sK, LO[2], HI[2]);
  return { g0, g1, k0, k1 };
}
// Cloud box: the base box, widened to hold the central 96% of the cloud and the truth.
function cloudBoxFor(base, arrays, truth) {
  const tIdx = [1, 2, 0];
  return [0, 1, 2].map((d) => {
    let [lo, hi] = base.cloudBox[d];
    for (const arr of arrays) {
      const v = []; for (let s = 0; s < arr.length / 3; s++) { const x = arr[3 * s + d]; if (Number.isFinite(x)) v.push(x); }
      if (v.length < 20) continue;
      v.sort((a, b) => a - b);
      lo = Math.min(lo, v[Math.floor(0.02 * v.length)]); hi = Math.max(hi, v[Math.floor(0.98 * v.length)]);
    }
    const t = truth[tIdx[d]]; lo = Math.min(lo, t); hi = Math.max(hi, t);
    const pad = 0.06 * (hi - lo), P = tIdx[d];
    return [Math.max(LO[P], lo - pad), Math.min(HI[P], hi + pad)];
  });
}

// ---------------- the three checks ----------------
function replayTest(n, fit, expo) {
  // posterior-predictive check: chi-square and KS-on-cumulative discrepancies vs replicates
  const L = cholOrDiag(fit.cov), t = new Float64Array(NP), mu = new Float64Array(NCH);
  const rng = mulberry32(4242);
  const Nobs = sum(n);
  let geChi = 0, geKs = 0;
  for (let r = 0; r < R_PPC; r++) {
    sampleAt(fit.th, L, Zp, r, t);
    for (let i = 0; i < NP; i++) t[i] = Math.min(HI[i], Math.max(LO[i], t[i]));
    core.expected(t, 1, 0, expo, mu);
    const Mt = sum(mu);
    let chiO = 0, chiR = 0, cO = 0, cR = 0, cM = 0, ksO = 0, ksR = 0, Ny = 0;
    const y = new Float64Array(NCH);
    for (let c = 0; c < NCH; c++) { y[c] = poissonInv(rng(), mu[c]); Ny += y[c]; }
    for (let c = 0; c < NCH; c++) {
      const m = Math.max(mu[c], 1e-9);
      chiO += (n[c] - m) ** 2 / m; chiR += (y[c] - m) ** 2 / m;
      cO += n[c]; cR += y[c]; cM += mu[c];
      ksO = Math.max(ksO, Math.abs(cO / Math.max(Nobs, 1) - cM / Mt));
      ksR = Math.max(ksR, Math.abs(cR / Math.max(Ny, 1) - cM / Mt));
    }
    if (chiR >= chiO) geChi++;
    if (ksR >= ksO) geKs++;
  }
  const pChi = (1 + geChi) / (R_PPC + 1), pKs = (1 + geKs) / (R_PPC + 1);
  return { p: Math.min(1, 2 * Math.min(pChi, pKs)), pChi, pKs };
}

function evidenceTest(n, fit) {
  // Laplace stand-in for the count-controlled evidence: best-fit Cash statistic against its
  // expectation for a clean spectrum with these expected counts (5 fitted parameters)
  let e = 0, v = 0;
  for (let c = 0; c < NCH; c++) { const [m1, m2] = core.cashMoments(fit.mu[c]); e += m1; v += m2; }
  const Cexp = e - NP, z = (fit.C - Cexp) / Math.sqrt(v);
  return { z, p: 1 - normCdf(z), nats: -(fit.C - Cexp) / 2 };
}

function essOnce(n, expo, warm) {
  const bf = core.fit(n, expo, 1, warm, { group: bandOf, nBands: N_BANDS, maxIt: 60 });
  const L = cholOrDiag(bf.cov), t = new Float64Array(NP), mu = new Float64Array(NCH);
  const logw = new Float64Array(S_IS);
  let mx = -Infinity;
  for (let s = 0; s < S_IS; s++) {
    sampleAt(bf.th, L, Zi, s, t);
    if (!inBox(t)) { logw[s] = -Infinity; continue; }
    core.expected(t, 1, 0, expo, mu);
    let z2 = 0; for (let i = 0; i < NP; i++) z2 += Zi[s * NP + i] ** 2;
    logw[s] = -core.cstat(n, mu) / 2 + z2 / 2;
    if (logw[s] > mx) mx = logw[s];
  }
  let s1 = 0, s2 = 0;
  for (let s = 0; s < S_IS; s++) { const w = Math.exp(logw[s] - mx); s1 += w; s2 += w * w; }
  return s2 > 0 ? (s1 * s1 / s2) / S_IS : 0;
}

async function nullESS(key, src, expo, isStale) {
  if (cache.nullESS.has(key)) return cache.nullESS.get(key);
  const mu = core.expected(src, 1, 0, expo);
  // keep partial progress, so a new request during calibration resumes instead of restarting
  if (!cache.nullPartial || cache.nullPartial.key !== key) cache.nullPartial = { key, vals: [] };
  const vals = cache.nullPartial.vals;
  for (let k = vals.length; k < K_NULL; k++) {
    const n = drawCounts(uniformsFor(900001 + k), mu);
    vals.push(Math.log(Math.max(essOnce(n, expo, src), 1e-6)));
    if (k % 3 === 2) { await yieldNow(); if (isStale()) return null; postMessage({ type: "nullProgress", k: k + 1, of: K_NULL }); }
  }
  vals.sort((a, b) => a - b);
  const res = { vals, median: vals[vals.length >> 1] };
  cache.nullESS.set(key, res);
  return res;
}

// ---------------- gain marginalisation ----------------
function marginalise(n, expo, warm) {
  const fits = [], logZ = [];
  let start = warm;
  // sweep up from the middle and down, warm-starting each gain from its neighbour
  const order = [10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0];
  const res = new Array(G_GRID.length);
  for (const j of order) {
    if (j === 9) start = res[10].th;
    const f = core.fit(n, expo, G_GRID[j], start, { maxIt: 60 });
    res[j] = f; start = f.th;
  }
  for (let j = 0; j < G_GRID.length; j++) {
    const f = res[j];
    const L = cholOrDiag(f.cov);
    let logdet = 0; for (let i = 0; i < NP; i++) logdet += Math.log(L[i * NP + i]);
    logZ.push(-f.C / 2 + logdet);   // Laplace: ln L_max + 0.5 ln det(cov)
    fits.push(f);
  }
  const mx = Math.max(...logZ);
  const w = logZ.map((v) => Math.exp(v - mx)), W = w.reduce((a, b) => a + b, 0);
  for (let j = 0; j < w.length; j++) w[j] /= W;
  let mG = 0, m2 = 0;
  for (let j = 0; j < w.length; j++) {
    const g = fits[j].th[1], sG = fits[j].cov[1 * NP + 1];
    mG += w[j] * g; m2 += w[j] * (sG + g * g);
  }
  const sdG = Math.sqrt(Math.max(m2 - mG * mG, 0));
  // gain posterior 90 per cent width: piecewise-linear density through the grid weights on
  // [0.95, 1.05], so a flat posterior gives exactly the prior's 90 per cent width of 0.09
  const seg = []; let tot = 0;
  for (let j = 0; j < w.length - 1; j++) { const a = 0.5 * (w[j] + w[j + 1]) * 0.005; seg.push(a); tot += a; }
  const q = (p) => {
    let acc = 0;
    for (let j = 0; j < seg.length; j++) {
      const a = seg[j] / tot;
      if (acc + a >= p) {
        // solve within the trapezoid for the fraction f of the segment
        const d0 = w[j], d1 = w[j + 1], need = (p - acc) * tot / 0.005;
        let f;
        if (Math.abs(d1 - d0) < 1e-12 * Math.max(d0, 1e-300)) f = need / Math.max(d0, 1e-300);
        else f = (-d0 + Math.sqrt(Math.max(d0 * d0 + 2 * (d1 - d0) * need, 0))) / (d1 - d0);
        return G_GRID[j] + 0.005 * Math.min(Math.max(f, 0), 1);
      }
      acc += a;
    }
    return G_GRID[G_GRID.length - 1];
  };
  const cdf = []; let acc = 0; for (const x of w) { acc += x; cdf.push(acc); }
  const width90 = q(0.95) - q(0.05);
  let gMean = 0; for (let j = 0; j < w.length; j++) gMean += w[j] * G_GRID[j];
  // cloud: each sample picks a gain from the posterior using its own fixed uniform
  const cloud = new Float32Array(S_CLOUD * 3), t = new Float64Array(NP);
  const Ls = fits.map((f) => cholOrDiag(f.cov));
  for (let s = 0; s < S_CLOUD; s++) {
    let j = 0; while (j < cdf.length - 1 && cdf[j] < Uc[s]) j++;
    sampleAt(fits[j].th, Ls[j], Zc, s, t);
    const ok = inBox(t);
    cloud[s * 3] = ok ? t[1] : NaN; cloud[s * 3 + 1] = ok ? t[2] : NaN; cloud[s * 3 + 2] = ok ? t[0] : NaN;
  }
  return { w, grid: G_GRID, gammaMean: mG, gammaSd: sdG, width90, widthRatio: width90 / 0.09, gMean, cloud };
}

// ---------------- main update ----------------
async function run(req) {
  const { id, state } = req;
  const isStale = () => latest && latest.id !== id;
  const src = state.src, level = state.level, g = 1 + state.gain / 100, line = state.line;
  const baseKey = src.map((v) => v.toFixed(6)).join(",") + "|" + level;
  if (cache.baseKey !== baseKey) { cache.baseKey = baseKey; cache.base = baseSetup(src, level); cache.noiseKey = null; cache.lastFit = null; }
  const base = cache.base, expo = base.expo;
  const noisy = !!state.noise;
  const noiseKey = baseKey + "|" + (noisy ? state.seed : "asimov") + "|" + line;
  // with noise off the "data" are the expected counts themselves, so the fit can land on the truth
  const realise = (u, mu) => (noisy ? drawCounts(u, mu) : Float64Array.from(mu));
  if (cache.noiseKey !== noiseKey) {
    const u = uniformsFor(state.seed);
    const nClean = realise(u, core.expected(src, 1, 0, expo));
    const fitClean = core.fit(nClean, expo, 1, src);
    const n0 = line > 0 ? realise(u, core.expected(src, 1, line, expo)) : nClean;
    const fit0 = line > 0 ? core.fit(n0, expo, 1, fitClean.th) : fitClean;
    cache.noiseKey = noiseKey; cache.noise = { u, fitClean, n0, fit0 }; cache.lastFit = null;
  }
  const nz = cache.noise;
  const muData = core.expected(src, g, line, expo);
  const n = state.gain === 0 ? nz.n0 : realise(nz.u, muData);
  let fit = core.fit(n, expo, 1, cache.lastFit ? cache.lastFit.th : nz.fit0.th);
  // guard against a poor local minimum: also try from the zero-gain fit and keep the better one
  if (cache.lastFit) { const alt = core.fit(n, expo, 1, nz.fit0.th); if (alt.C < fit.C - 1e-6) fit = alt; }
  cache.lastFit = fit;
  const rKey = noiseKey;
  const range = terrainRange(base, [[src[1], src[2]], [nz.fit0.th[1], nz.fit0.th[2]], [fit.th[1], fit.th[2]]], cache.rangeKey === rKey ? cache.range : null);
  if (cache.rangeKey !== rKey || cache.range !== range) { cache.rangeKey = rKey; cache.range = range; }
  const cloud = cloudFromFit(fit, new Float32Array(S_CLOUD * 3));
  const ghost = cloudFromFit(nz.fit0, new Float32Array(S_CLOUD * 3));
  const muTrue = core.expected(src, 1, 0, expo);
  const sd = [0, 1, 2, 3, 4].map((i) => Math.sqrt(Math.max(fit.cov[i * NP + i], 0)));
  postMessage({
    type: "fast", id, gain: state.gain,
    chanLo: Array.from(core.chanLo), chanHi: Array.from(core.chanHi),
    n: Array.from(n), muFit: Array.from(fit.mu), muTrue: Array.from(muTrue), muData: Array.from(muData),
    fit: { th: fit.th, sd, C: fit.C }, fit0: { th: nz.fit0.th, C: nz.fit0.C }, fitClean: { C: nz.fitClean.C }, truth: src, noise: noisy,
    counts: sum(n), expo, level,
    land: { ...range, cond: base.cond }, lift: fit.C - nz.fitClean.C, trailKey: noiseKey, sdTruth: base.sdTruth,
    cloudBox: cloudBoxFor(base, [cloud, ghost], src), cloud, ghost,
  }, [cloud.buffer, ghost.buffer]);

  await yieldNow(); if (isStale()) return;
  const ppc = replayTest(n, fit, expo);
  const ev = evidenceTest(n, fit);
  await yieldNow(); if (isStale()) return;
  const essNow = essOnce(n, expo, fit.th);
  const nullKey = baseKey;
  const haveNull = cache.nullESS.get(nullKey);
  const essResult = (nl) => {
    // empirical p-value: share of clean spectra whose effective sample size is this low or lower
    const x = Math.log(Math.max(essNow, 1e-6));
    let k = 0; for (const v of nl.vals) if (v <= x) k++;
    return { frac: essNow, p: (1 + k) / (nl.vals.length + 1), ready: true, nullMedian: Math.exp(nl.median) };
  };
  postMessage({ type: "checks", id, ppc, ev, ess: haveNull ? essResult(haveNull) : { frac: essNow, ready: false } });

  // the gain-marginalised refit runs before the terrain, so the switch answers quickly
  if (state.marg) {
    await yieldNow(); if (isStale()) return;
    const mg = marginalise(n, expo, fit.th);
    postMessage({ type: "marg", id, ...mg, fixedSd: sd[1], fixedGamma: fit.th[1] }, [mg.cloud.buffer]);
  }

  const lk = noiseKey + "|" + state.gain + "|" + [range.g0, range.g1, range.k0, range.k1].join(",");
  let L = cache.landKey === lk ? cache.land : null;
  if (!L) {
    // heights are measured from this fit's own minimum, so the valley shape stays readable;
    // how much worse the fit is than the clean one travels separately as "lift"
    L = await landscape(n, fit, fit.C, range, expo, isStale);
    if (!L) return;
    cache.landKey = lk; cache.land = L;
  }
  const hcopy = L.heights.slice();
  postMessage({ type: "land", id, N: L.N, heights: hcopy, ...range }, [hcopy.buffer]);

  if (!haveNull) {
    const nl = await nullESS(nullKey, src, expo, isStale);
    if (nl && !isStale()) postMessage({ type: "checks", id, ppc, ev, ess: essResult(nl) });
  }
}

async function pump() {
  if (running) return;
  running = true;
  while (latest && !latest.done) {
    const req = latest; req.done = true;
    try { await run(req); } catch (e) { postMessage({ type: "error", message: String(e && e.stack || e) }); }
  }
  running = false;
}

// ---------------- catalog of random sources ----------------
async function catalog(msg) {
  const token = ++catalogToken;
  const { N, gain, level, seed, catId } = msg;   // catId is echoed so the page can drop items from older runs
  const expo = EXPOSURES[level], g = 1 + gain / 100;
  const rng = mulberry32(seed * 131 + 7);
  for (let i = 0; i < N; i++) {
    if (token !== catalogToken) return;
    const src = drawPrior(rng);
    const u = new Float64Array(NCH); for (let c = 0; c < NCH; c++) u[c] = rng();
    const mu0 = core.expected(src, 1, 0, expo), mu1 = core.expected(src, g, 0, expo);
    const n0 = drawCounts(u, mu0), n1 = drawCounts(u, mu1);
    const f0 = core.fit(n0, expo, 1, src), f1 = core.fit(n1, expo, 1, f0.th);
    const fa = core.fit(mu1, expo, 1, src);
    const e0 = evidenceTest(n0, f0), e1 = evidenceTest(n1, f1);
    postMessage({
      type: "catItem", token, catId, gain, i, N, counts: sum(n0), dG: f1.th[1] - f0.th[1], dGasimov: fa.th[1] - src[1],
      sd: Math.sqrt(Math.max(f1.cov[6], 0)), sd0: Math.sqrt(Math.max(f0.cov[6], 0)), flag0: e0.p < 0.01, flag1: e1.p < 0.01,
    });
    if (i % 4 === 3) await yieldNow();
  }
  postMessage({ type: "catDone", token, catId });
}

self.onmessage = (e) => {
  const m = e.data;
  if (m.type === "update") { latest = m; pump(); }
  else if (m.type === "catalog") { catalog(m); }
  else if (m.type === "catalogStop") { catalogToken++; }
};
postMessage({ type: "ready" });
