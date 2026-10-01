// Compute core for /play/gain-shift/. No DOM, so it runs in a worker and in node.
// Forward model: tbabs * (powerlaw + bbodyrad) [+ gauss at 6.4 keV], folded through the
// EPIC-pn response in gain-shift-data.js. A gain g evaluates the source on the input energy
// grid scaled by g, the same way the paper's simulator does it (3 per cent means g = 1.03).
// Fits are maximum likelihood on the Poisson (Cash) statistic, Levenberg-Marquardt with
// analytic derivatives. Parameters: [NH (1e22 cm^-2), Gamma, ln K_pl, kT_bb (keV), ln K_bb].

export const PARAM_NAMES = ["NH", "Gamma", "lnKpl", "kT", "lnKbb"];
export const LO = [0.15, 1.0, Math.log(1e-4), 0.3, Math.log(1e-2)];
export const HI = [0.35, 3.0, Math.log(1e-2), 3.0, 0.0];
export const LINE_E = 6.4, LINE_SIGMA = 0.05;
export const EXPOSURES = { medium: 353.4, bright: 3534.0 };   // s, configs/sim_modelA_prod.yaml
const NP = 5;

// ---------- small numerics ----------
export function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function gaussPair(rng) {
  let u = 0, v = 0;
  while (u <= 1e-300) u = rng();
  v = rng();
  const r = Math.sqrt(-2 * Math.log(u));
  return [r * Math.cos(2 * Math.PI * v), r * Math.sin(2 * Math.PI * v)];
}
function erf(x) {
  // erf via the Numerical Recipes erfc Chebyshev fit
  const s = x < 0 ? -1 : 1; x = Math.abs(x);
  if (x > 6) return s;
  const t = 1 / (1 + 0.5 * x);
  const y = t * Math.exp(-x * x - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418 +
    t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 +
    t * (-0.82215223 + t * 0.17087277)))))))));
  return s * (1 - y);   // Numerical Recipes erfcc, fractional error < 1.2e-7
}
export function normCdf(z) { return 0.5 * (1 + erf(z / Math.SQRT2)); }
export function normQuantile(p) {
  // Acklam's rational approximation
  const a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02, 1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
  const b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02, 6.680131188771972e+01, -1.328068155288572e+01];
  const c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00, -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
  const d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00, 3.754408661907416e+00];
  const pl = 0.02425;
  if (p <= 0) return -Infinity; if (p >= 1) return Infinity;
  let q, r;
  if (p < pl) { q = Math.sqrt(-2 * Math.log(p)); return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  if (p > 1 - pl) { q = Math.sqrt(-2 * Math.log(1 - p)); return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  q = p - 0.5; r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}
export function lgamma(x) {
  const g = 7, c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  if (x < 0.5) return Math.log(Math.PI / Math.abs(Math.sin(Math.PI * x))) - lgamma(1 - x);
  x -= 1; let a = c[0]; const t = x + g + 0.5;
  for (let i = 1; i < g + 2; i++) a += c[i] / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}
function lnPois(k, mu) { return k * Math.log(mu) - mu - lgamma(k + 1); }
// regularized lower incomplete gamma P(a, x) (Numerical Recipes gser / gcf)
function gammaP(a, x) {
  if (x <= 0) return 0;
  const gln = lgamma(a);
  if (x < a + 1) {
    let ap = a, sum = 1 / a, del = sum;
    for (let n = 0; n < 500; n++) { ap += 1; del *= x / ap; sum += del; if (Math.abs(del) < Math.abs(sum) * 1e-14) break; }
    return sum * Math.exp(-x + a * Math.log(x) - gln);
  }
  let b = x + 1 - a, c = 1 / 1e-300, d = 1 / b, h = d;
  for (let i = 1; i < 500; i++) {
    const an = -i * (i - a); b += 2;
    d = an * d + b; if (Math.abs(d) < 1e-300) d = 1e-300;
    c = b + an / c; if (Math.abs(c) < 1e-300) c = 1e-300;
    d = 1 / d; const del = d * c; h *= del; if (Math.abs(del - 1) < 1e-14) break;
  }
  return 1 - Math.exp(-x + a * Math.log(x) - gln) * h;
}
// Poisson inverse CDF: smallest k with P(X <= k) >= u. Used with a fixed uniform per channel,
// so the same "photons" can be replayed through two different expected spectra (paired draws).
export function poissonInv(u, mu) {
  if (!(mu > 0)) return 0;
  if (mu < 30) {
    let k = 0, p = Math.exp(-mu), cdf = p;
    while (cdf < u && k < 1000) { k++; p *= mu / k; cdf += p; }
    return k;
  }
  let k = Math.max(0, Math.round(mu + Math.sqrt(mu) * normQuantile(Math.min(Math.max(u, 1e-12), 1 - 1e-12))));
  let cdf = 1 - gammaP(k + 1, mu);            // P(X <= k)
  let guard = 0;
  while (cdf < u && guard++ < 200) { k++; cdf += Math.exp(lnPois(k, mu)); }
  while (k > 0 && cdf - Math.exp(lnPois(k, mu)) >= u && guard++ < 400) { cdf -= Math.exp(lnPois(k, mu)); k--; }
  return k;
}

// Symmetric positive-definite helpers (small n)
export function cholesky(A, n) {
  const L = new Float64Array(n * n);
  for (let i = 0; i < n; i++) for (let j = 0; j <= i; j++) {
    let s = A[i * n + j];
    for (let k = 0; k < j; k++) s -= L[i * n + k] * L[j * n + k];
    if (i === j) { if (s <= 0) return null; L[i * n + i] = Math.sqrt(s); }
    else L[i * n + j] = s / L[j * n + j];
  }
  return L;
}
export function invSPD(A, n) {
  const L = cholesky(A, n); if (!L) return null;
  const inv = new Float64Array(n * n), col = new Float64Array(n), y = new Float64Array(n);
  for (let c = 0; c < n; c++) {
    col.fill(0); col[c] = 1;
    for (let i = 0; i < n; i++) { let s = col[i]; for (let k = 0; k < i; k++) s -= L[i * n + k] * y[k]; y[i] = s / L[i * n + i]; }
    for (let i = n - 1; i >= 0; i--) { let s = y[i]; for (let k = i + 1; k < n; k++) s -= L[k * n + i] * inv[k * n + c]; inv[i * n + c] = s / L[i * n + i]; }
  }
  return inv;
}
function solveSym(A, b, n) {
  // Gaussian elimination with partial pivoting (A may be only semi-definite after freezing)
  const M = new Float64Array(n * (n + 1));
  for (let i = 0; i < n; i++) { for (let j = 0; j < n; j++) M[i * (n + 1) + j] = A[i * n + j]; M[i * (n + 1) + n] = b[i]; }
  for (let c = 0; c < n; c++) {
    let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(M[r * (n + 1) + c]) > Math.abs(M[p * (n + 1) + c])) p = r;
    if (Math.abs(M[p * (n + 1) + c]) < 1e-300) return null;
    if (p !== c) for (let j = 0; j <= n; j++) { const t = M[c * (n + 1) + j]; M[c * (n + 1) + j] = M[p * (n + 1) + j]; M[p * (n + 1) + j] = t; }
    for (let r = c + 1; r < n; r++) { const f = M[r * (n + 1) + c] / M[c * (n + 1) + c]; if (f) for (let j = c; j <= n; j++) M[r * (n + 1) + j] -= f * M[c * (n + 1) + j]; }
  }
  const x = new Float64Array(n);
  for (let i = n - 1; i >= 0; i--) { let s = M[i * (n + 1) + n]; for (let j = i + 1; j < n; j++) s -= M[i * (n + 1) + j] * x[j]; x[i] = s / M[i * (n + 1) + i]; }
  return x;
}

// ---------- the model ----------
export function createCore(D) {
  const NCH = D.chan_lo.length;
  const NB = D.in_lo.length;
  const inLo = Float64Array.from(D.in_lo), inHi = Float64Array.from(D.in_hi);
  const chanLo = Float64Array.from(D.chan_lo), chanHi = Float64Array.from(D.chan_hi);
  // flatten sparse columns
  const cStart = new Int32Array(NB), cLen = new Int32Array(NB), cOff = new Int32Array(NB);
  let tot = 0; for (let k = 0; k < NB; k++) tot += D.cols[k][2].length;
  const vals = new Float64Array(tot);
  let o = 0;
  for (let k = 0; k < NB; k++) {
    const [s, t, q] = D.cols[k];
    cStart[k] = s; cLen[k] = q.length; cOff[k] = o;
    for (let i = 0; i < q.length; i++) vals[o + i] = t * q[i] / 10000;
    o += q.length;
  }
  const tbX = Float64Array.from(D.tb_logE), tbY = Float64Array.from(D.tb_logS);
  function sigmaAt(E) {
    const x = Math.log(E);
    let lo = 0, hi = tbX.length - 1;
    if (x <= tbX[0]) { const s = (tbY[1] - tbY[0]) / (tbX[1] - tbX[0]); return Math.exp(tbY[0] + s * (x - tbX[0])); }
    if (x >= tbX[hi]) { const s = (tbY[hi] - tbY[hi - 1]) / (tbX[hi] - tbX[hi - 1]); return Math.exp(tbY[hi] + s * (x - tbX[hi])); }
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (tbX[m] > x) hi = m; else lo = m; }
    const f = (x - tbX[lo]) / (tbX[hi] - tbX[lo]);
    return Math.exp(tbY[lo] + f * (tbY[hi] - tbY[lo]));
  }

  // per-gain cache of everything that depends only on the energy grid
  const gainCache = new Map();
  function grid(g) {
    const key = g.toFixed(6);
    let G = gainCache.get(key);
    if (G) return G;
    const n2 = NB * 2;
    const E = new Float64Array(n2), lnE = new Float64Array(n2), sig = new Float64Array(n2), w = new Float64Array(n2), E2 = new Float64Array(n2);
    const lineShape = new Float64Array(NB), sigLine = sigmaAt(LINE_E);
    for (let b = 0; b < NB; b++) {
      const a = g * inLo[b], c = g * inHi[b], h = (c - a) / 2;
      for (let s = 0; s < 2; s++) {
        const i = 2 * b + s, e = a + h * (s + 0.5);
        E[i] = e; lnE[i] = Math.log(e); sig[i] = sigmaAt(e); w[i] = h; E2[i] = e * e;
      }
      const k = LINE_SIGMA * Math.SQRT2;
      lineShape[b] = 0.5 * (erf((c - LINE_E) / k) - erf((a - LINE_E) / k));
    }
    G = { g, E, lnE, sig, w, E2, lineShape, sigLine };
    if (gainCache.size > 64) gainCache.delete(gainCache.keys().next().value);
    gainCache.set(key, G);
    return G;
  }

  const ph = new Float64Array(NB);
  const dph = [0, 1, 2, 3, 4].map(() => new Float64Array(NB));
  function fold(src, out, scale) {
    out.fill(0);
    for (let k = 0; k < NB; k++) {
      const f = src[k] * scale; if (f === 0) continue;
      const s = cStart[k], off = cOff[k], L = cLen[k];
      for (let i = 0; i < L; i++) out[s + i] += f * vals[off + i];
    }
    return out;
  }
  // photon flux per input bin (photons cm^-2 s^-1), optionally with derivatives
  function flux(th, G, lineNorm, wantJ) {
    const nh = th[0], gam = th[1], K = Math.exp(th[2]), kT = th[3], B = Math.exp(th[4]) * 1.0344e-3;
    const { E, lnE, sig, w, E2 } = G;
    for (let b = 0; b < NB; b++) {
      let f = 0, d0 = 0, d1 = 0, d2 = 0, d3 = 0, d4 = 0;
      for (let s = 0; s < 2; s++) {
        const i = 2 * b + s;
        const A = Math.exp(-nh * sig[i]);
        const P = K * Math.exp(-gam * lnE[i]);
        const x = E[i] / kT, em1 = Math.expm1(x);
        const Bb = B * E2[i] / em1;
        const AP = A * P * w[i], AB = A * Bb * w[i];
        const fi = AP + AB;
        f += fi;
        if (wantJ) {
          d0 -= sig[i] * fi; d1 -= lnE[i] * AP; d2 += AP;
          d3 += AB * x * (em1 + 1) / (em1 * kT); d4 += AB;
        }
      }
      ph[b] = f;
      if (wantJ) { dph[0][b] = d0; dph[1][b] = d1; dph[2][b] = d2; dph[3][b] = d3; dph[4][b] = d4; }
    }
    if (lineNorm > 0) {
      const A = Math.exp(-nh * G.sigLine);
      for (let b = 0; b < NB; b++) if (G.lineShape[b] > 0) ph[b] += lineNorm * A * G.lineShape[b];
    }
    return ph;
  }
  // expected counts in each channel
  function expected(th, g, lineNorm, expo, out) {
    const G = grid(g);
    flux(th, G, lineNorm, false);
    return fold(ph, out || new Float64Array(NCH), expo);
  }
  const J = [0, 1, 2, 3, 4].map(() => new Float64Array(NCH));
  function expectedJ(th, G, expo, mu) {
    flux(th, G, 0, true);
    fold(ph, mu, expo);
    for (let p = 0; p < NP; p++) fold(dph[p], J[p], expo);
    return J;
  }

  function cstat(n, mu) {
    let C = 0;
    for (let c = 0; c < n.length; c++) {
      const m = Math.max(mu[c], 1e-12), k = n[c];
      C += m - k + (k > 0 ? k * Math.log(k / m) : 0);
    }
    return 2 * C;
  }

  // group: optional Int32Array channel -> band. Fits the model to band sums when given.
  function fit(n, expo, g, th0, opts = {}) {
    const G = grid(g);
    const group = opts.group || null, nb = group ? opts.nBands : NCH;
    const nObs = group ? new Float64Array(nb) : n;
    if (group) for (let c = 0; c < NCH; c++) nObs[group[c]] += n[c];
    const mu = new Float64Array(NCH), muB = group ? new Float64Array(nb) : mu;
    const JB = group ? [0, 1, 2, 3, 4].map(() => new Float64Array(nb)) : null;
    const th = Float64Array.from(th0);
    for (let p = 0; p < NP; p++) th[p] = Math.min(HI[p], Math.max(LO[p], th[p]));
    const evalAt = (t, withJ) => {
      if (withJ) expectedJ(t, G, expo, mu); else { flux(t, G, 0, false); fold(ph, mu, expo); }
      if (group) {
        muB.fill(0); for (let c = 0; c < NCH; c++) muB[group[c]] += mu[c];
        if (withJ) for (let p = 0; p < NP; p++) { JB[p].fill(0); for (let c = 0; c < NCH; c++) JB[p][group[c]] += J[p][c]; }
      }
      return cstat(nObs, muB);
    };
    let C = evalAt(th, true);
    let lam = 1e-3, it = 0, calm = 0;
    const H = new Float64Array(NP * NP), grad = new Float64Array(NP);
    const Jx = group ? JB : J;
    const maxIt = opts.maxIt || 100;
    for (; it < maxIt; it++) {
      H.fill(0); grad.fill(0);
      for (let c = 0; c < nb; c++) {
        const m = Math.max(muB[c], 1e-12), r = 1 - nObs[c] / m, wgt = 1 / m;
        for (let i = 0; i < NP; i++) {
          const ji = Jx[i][c]; grad[i] += 2 * r * ji;
          for (let j = 0; j <= i; j++) H[i * NP + j] += 2 * ji * Jx[j][c] * wgt;
        }
      }
      for (let i = 0; i < NP; i++) for (let j = 0; j < i; j++) H[j * NP + i] = H[i * NP + j];
      // freeze parameters sitting on a bound and pushed outward
      const free = [];
      for (let i = 0; i < NP; i++) {
        if (opts.fixed && opts.fixed[i]) continue;
        const atLo = th[i] <= LO[i] + 1e-12 && grad[i] > 0, atHi = th[i] >= HI[i] - 1e-12 && grad[i] < 0;
        if (!atLo && !atHi) free.push(i);
      }
      if (!free.length) break;
      let improved = false;
      for (let tries = 0; tries < 12; tries++) {
        const nf = free.length, A = new Float64Array(nf * nf), bvec = new Float64Array(nf);
        for (let a = 0; a < nf; a++) {
          bvec[a] = -grad[free[a]];
          for (let b2 = 0; b2 < nf; b2++) A[a * nf + b2] = H[free[a] * NP + free[b2]];
          A[a * nf + a] *= (1 + lam); A[a * nf + a] += 1e-12;
        }
        const d = solveSym(A, bvec, nf);
        if (!d) { lam *= 10; continue; }
        const tn = Float64Array.from(th);
        for (let a = 0; a < nf; a++) { const i = free[a]; tn[i] = Math.min(HI[i], Math.max(LO[i], th[i] + d[a])); }
        const Cn = evalAt(tn, false);
        if (Cn < C - 1e-12) {
          const dC = C - Cn;
          th.set(tn); C = evalAt(th, true); lam = Math.max(lam / 4, 1e-9); improved = true;
          calm = dC < (opts.tol || 1e-7) ? calm + 1 : 0;
          break;
        }
        lam *= 6;
      }
      if (!improved || calm >= (opts.tol ? 1 : 2)) break;
    }
    if (opts.noCov) return { th: Array.from(th), C, iters: it };
    // final Fisher information and Laplace covariance (in the full channel space unless grouped)
    evalAt(th, true);
    H.fill(0);
    for (let c = 0; c < nb; c++) {
      const m = Math.max(muB[c], 1e-12);
      for (let i = 0; i < NP; i++) for (let j = 0; j <= i; j++) H[i * NP + j] += Jx[i][c] * Jx[j][c] / m;
    }
    for (let i = 0; i < NP; i++) for (let j = 0; j < i; j++) H[j * NP + i] = H[i * NP + j];
    let cov = invSPD(H, NP);
    if (!cov) { for (let i = 0; i < NP; i++) H[i * NP + i] *= 1 + 1e-6; cov = invSPD(H, NP); }
    return { th: Array.from(th), C, cov, fisher: Float64Array.from(H), mu: Float64Array.from(mu), iters: it };
  }

  // Fisher information at a parameter point for the noise-free spectrum (used to size axes)
  function fisherAt(th, g, expo) {
    const G = grid(g), mu = new Float64Array(NCH);
    expectedJ(th, G, expo, mu);
    const H = new Float64Array(NP * NP);
    for (let c = 0; c < NCH; c++) {
      const m = Math.max(mu[c], 1e-12);
      for (let i = 0; i < NP; i++) for (let j = 0; j < NP; j++) H[i * NP + j] += J[i][c] * J[j][c] / m;
    }
    return { H, mu };
  }

  // Expected value and variance of one channel's Cash term 2(mu - k + k ln(k/mu)), k ~ Poisson(mu)
  function cashMoments(mu) {
    if (mu < 1e-6) return [2 * mu, 4 * mu];
    const sd = Math.sqrt(mu);
    const k0 = Math.max(0, Math.floor(mu - 12 * sd - 5)), k1 = Math.ceil(mu + 12 * sd + 10);
    let e = 0, e2 = 0, ps = 0;
    for (let k = k0; k <= k1; k++) {
      const p = Math.exp(lnPois(k, mu)); if (p < 1e-300) continue;
      const cc = 2 * (mu - k + (k > 0 ? k * Math.log(k / mu) : 0));
      e += p * cc; e2 += p * cc * cc; ps += p;
    }
    e /= ps; e2 /= ps;
    return [e, Math.max(e2 - e * e, 1e-12)];
  }

  return { NCH, NB, chanLo, chanHi, inLo, inHi, grid, expected, fit, fisherAt, cstat, cashMoments, flux, fold };
}

// Draw a source from the paper's production prior (configs/sim_modelA_prod.yaml)
export function drawPrior(rng) {
  return [0.15 + 0.2 * rng(), 1 + 2 * rng(), Math.log(1e-4) + (Math.log(1e-2) - Math.log(1e-4)) * rng(),
    0.3 + 2.7 * rng(), Math.log(1e-2) - Math.log(1e-2) * rng()];
}
