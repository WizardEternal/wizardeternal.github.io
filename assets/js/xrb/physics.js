// Physics for the X-ray binary explorer.
// Binary scale: Roche potential, Eggleton (1983) lobe radius, Kepler's third law,
// circularisation radius, ballistic L1 stream, geometric light curves.
// Inner scale: Kerr ISCO (Bardeen, Press & Teukolsky 1972), epicyclic / RPM
// frequencies, IDF09 precession, and a port of the one-zone heartbeat limit cycle.
// The QPO parameters and models follow my qpo-visualizer package
// (modules/type_c.py, modules/rpm.py, modules/heartbeat.py, kerr/frequencies.py).

// ---------------------------------------------------------------- constants (CGS)
export const G = 6.6743e-8;
export const C = 2.99792458e10;
export const MSUN = 1.98892e33;
export const RSUN = 6.957e10;
const SIGMA_SB = 5.670374419e-5;
const KAPPA_ES = 0.34;
const K_B = 1.380649e-16;
const M_H = 1.6735575e-24;
const MU_MEAN = 0.615;

export const rgCm = (M) => G * M * MSUN / (C * C);
export const tgS = (M) => rgCm(M) / C;

// ---------------------------------------------------------------- seeded RNG
export function makeRng(seed = 1) {
  let s = seed >>> 0;
  const next = () => {
    s |= 0; s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  let spare = null;
  const normal = () => {
    if (spare !== null) { const v = spare; spare = null; return v; }
    let u = 0, v = 0;
    while (u < 1e-12) u = next();
    v = next();
    const m = Math.sqrt(-2 * Math.log(u));
    spare = m * Math.sin(2 * Math.PI * v);
    return m * Math.cos(2 * Math.PI * v);
  };
  return { uniform: next, normal };
}

// ================================================================ Kerr
export function rIsco(a) {
  const z1 = 1 + Math.cbrt(1 - a * a) * (Math.cbrt(1 + a) + Math.cbrt(1 - a));
  const z2 = Math.sqrt(3 * a * a + z1 * z1);
  return 3 + z2 - Math.sqrt((3 - z1) * (3 + z1 + 2 * z2));
}
export const rHorizon = (a) => 1 + Math.sqrt(1 - a * a);

const omegaPhi = (r, a) => 1 / (Math.pow(r, 1.5) + a);
const omegaR2 = (r, a) => { const o = omegaPhi(r, a); return o * o * (1 - 6 / r + 8 * a / Math.pow(r, 1.5) - 3 * a * a / (r * r)); };
const omegaTh2 = (r, a) => { const o = omegaPhi(r, a); return o * o * (1 - 4 * a / Math.pow(r, 1.5) + 3 * a * a / (r * r)); };
const toHz = (w, M) => w / (2 * Math.PI * tgS(M));

// Stella & Vietri RPM triplet (nu_U, nu_L, nu_C) in Hz.
export function nuRpm(r0, a, M) {
  const nphi = toHz(omegaPhi(r0, a), M);
  const nr = toHz(Math.sqrt(Math.max(omegaR2(r0, a), 0)), M);
  const nth = toHz(Math.sqrt(Math.max(omegaTh2(r0, a), 0)), M);
  return { nuU: nphi, nuL: nphi - nr, nuC: nphi - nth, nuPhi: nphi, nuR: nr, nuTh: nth };
}

// Lubow, Ogilvie & Pringle bending-wave radius, as in kerr/frequencies.py.
export const rBendingWave = (a, hOverR) => 3.0 * Math.pow(hOverR, -0.8) * Math.pow(a, 0.4);

// IDF09 eq. 2, as in kerr/frequencies.py.
export function nuPrecIdf09(ri, ro, a, zeta, M) {
  const ratio = ri / ro, p = 0.5 + zeta, q = 2.5 - zeta;
  const pre = (5 - 2 * zeta) / (Math.PI * (1 + 2 * zeta));
  const w = pre * a * (1 - Math.pow(ratio, p)) / (Math.pow(ro, q) * Math.pow(ri, p) * (1 - Math.pow(ratio, q)));
  return toHz(w, M);
}

// ================================================================ mode parameter sets
// Values copied from the dataclass defaults in qpo-visualizer.
export const TYPEC = { M: 10.0, a: 0.5, incl: 84, rT: 20.0, HR: 0.3, zeta: 0, tiltDeg: 20 };
TYPEC.rIn = rBendingWave(TYPEC.a, TYPEC.HR);
TYPEC.nu = nuPrecIdf09(TYPEC.rIn, TYPEC.rT, TYPEC.a, TYPEC.zeta, TYPEC.M);

export const RPM = { M: 5.31, a: 0.290, r0: 5.677, dr: 0.20, dz: 0.25, incl: 84, slow: 500 };
Object.assign(RPM, nuRpm(RPM.r0, RPM.a, RPM.M));

export const HEART = {
  M: 12.0, a: 0.98, incl: 84, alpha: 0.05, mdotEdd: 0.4, rZone: 6.0, epsZone: 0.8,
  drain: 0.55, rise: 1.2, decay: 5.5, lumFactor: 4.0, secDelay: 5.0, secAmp: 0.45,
  drainJit: 0.18, ampJit: 0.25, secJit: 0.50, decayJit: 0.20,
};

export const QUIET = { M: 10.0, a: 0.5 };

// ================================================================ heartbeat (port of modules/heartbeat.py)
export function evolveHeartbeat(cfg, duration, n, seed = 17) {
  const mdotEddCgs = 1.26e38 * cfg.M / (0.1 * C * C);
  const mdotIn = cfg.mdotEdd * mdotEddCgs;
  const Rg = rgCm(cfg.M);
  const rCm = cfg.rZone * Rg;
  const omega = Math.sqrt(G * cfg.M * MSUN / Math.pow(rCm, 3));
  const area = 2 * Math.PI * rCm * (cfg.epsZone * rCm);
  const C1 = mdotIn * MU_MEAN * M_H * omega / (3 * Math.PI * cfg.alpha * K_B);
  const C2 = 32 * SIGMA_SB * MU_MEAN * M_H / (27 * cfg.alpha * K_B * omega * KAPPA_ES);
  const Tss = Math.pow(C1 * C1 / C2, 0.2);
  const Sss = C1 / Tss;
  const Scrit = 0.7 * Sss;
  const nuGas = cfg.alpha * K_B * Tss / (MU_MEAN * M_H * omega);
  const Lq = (S) => 8 * SIGMA_SB * Math.pow(Tss, 4) / (3 * KAPPA_ES * Math.max(S, 1));

  const t = new Float64Array(n), Sig = new Float64Array(n), L = new Float64Array(n), env = new Float64Array(n);
  const dt = duration / (n - 1);
  let S = 0.3 * Sss;
  let active = false, t0 = -1e9;
  const rng = makeRng(seed);
  const tauR = Math.max(cfg.rise, 1e-3), tauDb = Math.max(cfg.decay, 1e-3);
  let cDrain = cfg.drain, cAmp = cfg.lumFactor, cTauD = tauDb, cSec = cfg.secAmp, envNorm = 1;
  const clip = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
  const draw = () => {
    cDrain = clip(cfg.drain * (1 + cfg.drainJit * rng.normal()), 0.2, 0.9);
    cAmp = clip(cfg.lumFactor * (1 + cfg.ampJit * rng.normal()), 1.5, 8.0);
    cTauD = clip(tauDb * (1 + cfg.decayJit * rng.normal()), 1.0, 30.0);
    cSec = clip(cfg.secAmp * (1 + cfg.secJit * rng.normal()), 0.0, 1.0);
    const tp = -tauR * Math.log(tauR / (tauR + cTauD));
    envNorm = 1 / Math.max((1 - Math.exp(-tp / tauR)) * Math.exp(-tp / cTauD), 1e-12);
  };
  draw();
  const peaks = [];
  for (let k = 0; k < n; k++) {
    const tk = k * dt;
    S = Math.max(S + dt * (mdotIn - 3 * Math.PI * nuGas * S) / area, 1);
    if (!active && S > Scrit) {
      active = true; t0 = tk; draw();
      S = Math.max(S * (1 - cDrain), 1);
      peaks.push(tk);
    }
    const lq = Lq(S);
    let e = 0, lum = lq;
    if (active) {
      const d = tk - t0;
      const e1 = envNorm * (1 - Math.exp(-d / tauR)) * Math.exp(-d / cTauD);
      const d2 = d - cfg.secDelay;
      const e2 = d2 < 0 ? 0 : envNorm * (1 - Math.exp(-d2 / tauR)) * Math.exp(-d2 / cTauD);
      e = e1 + cSec * e2;
      lum = lq * (1 + (cAmp - 1) * e);
      if (d > 5 * cTauD + cfg.secDelay) active = false;
    }
    t[k] = tk; Sig[k] = S / Scrit; L[k] = lum; env[k] = e;
  }
  return { t, fill: Sig, L, env, dt, peaks };
}

// ================================================================ noise, FFT, PSD
export function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        const ncr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = ncr;
      }
    }
  }
}

// Timmer & Koenig style red noise, as in viz/noise.py (random phases, power-law amplitudes).
export function redNoise(n, dt, slope, rms, seed) {
  const rng = makeRng(seed);
  const re = new Float64Array(n), im = new Float64Array(n);
  for (let k = 1; k <= n / 2; k++) {
    const f = k / (n * dt);
    const amp = Math.pow(f, -slope / 2);
    const ph = 2 * Math.PI * rng.uniform();
    re[k] = amp * Math.cos(ph); im[k] = amp * Math.sin(ph);
    if (k < n / 2) { re[n - k] = re[k]; im[n - k] = -im[k]; } else { im[k] = 0; }
  }
  // inverse FFT via conjugation
  for (let k = 0; k < n; k++) im[k] = -im[k];
  fft(re, im);
  const out = new Float64Array(n);
  let m = 0, v = 0;
  for (let k = 0; k < n; k++) { out[k] = re[k] / n; m += out[k]; }
  m /= n;
  for (let k = 0; k < n; k++) { out[k] -= m; v += out[k] * out[k]; }
  const s = Math.sqrt(v / n) || 1;
  for (let k = 0; k < n; k++) out[k] *= rms / s;
  return out;
}

// Band-limited noise: Gaussian noise whose power spectrum is a sum of Lorentzians (Timmer & Koenig 1995
// with random amplitudes as well as phases). comps: [{ rms, hw, nu0 = 0 }], hw the half width at half
// maximum in Hz; each Lorentzian is normalised so that it holds rms^2 between 0 and infinity.
export function lorentzPsd(f, comps) {
  let p = 0;
  for (const c of comps) {
    const nu0 = c.nu0 || 0;
    const norm = 0.5 + Math.atan(nu0 / c.hw) / Math.PI;
    p += c.rms * c.rms * (c.hw / Math.PI) / ((f - nu0) ** 2 + c.hw * c.hw) / norm;
  }
  return p;
}
export function lorentzNoise(n, dt, comps, seed) {
  const rng = makeRng(seed);
  const re = new Float64Array(n), im = new Float64Array(n);
  const df = 1 / (n * dt);
  let want = 0;
  for (let k = 1; k <= n / 2; k++) {
    const P = lorentzPsd(k * df, comps);
    want += P * df;
    const a = Math.sqrt(P / 2);
    re[k] = a * rng.normal(); im[k] = a * rng.normal();
    if (k < n / 2) { re[n - k] = re[k]; im[n - k] = -im[k]; } else { im[k] = 0; }
  }
  for (let k = 0; k < n; k++) im[k] = -im[k];
  fft(re, im);
  const out = new Float64Array(n);
  let m = 0, v = 0;
  for (let k = 0; k < n; k++) { out[k] = re[k]; m += out[k]; }
  m /= n;
  for (let k = 0; k < n; k++) { out[k] -= m; v += out[k] * out[k]; }
  const s = Math.sqrt(v / n) || 1;
  const target = Math.sqrt(want);   // the variance the spectrum holds between 1/T and the Nyquist frequency
  for (let k = 0; k < n; k++) out[k] *= target / s;
  return out;
}

// A phase that advances at nu (Hz) and random-walks, so the oscillation it drives loses coherence:
// phase diffusion D = pi nu / Q (rad^2 / s) gives a Lorentzian of full width nu / Q, quality factor Q.
export function diffusingPhase(n, dt, nu, Q, seed) {
  const rng = makeRng(seed);
  const D = Math.PI * nu / Q;
  const s = Math.sqrt(2 * D * dt), w = 2 * Math.PI * nu * dt;
  const ph = new Float64Array(n);
  for (let k = 1; k < n; k++) ph[k] = ph[k - 1] + w + s * rng.normal();
  return ph;
}
// Linear interpolation into a sampled series, wrapping at the end.
export function sampleWrap(arr, dt, t) {
  const n = arr.length;
  const x = ((t / dt) % n + n) % n;
  const i = Math.floor(x), f = x - i;
  return arr[i] * (1 - f) + arr[(i + 1) % n] * f;
}

const stdOf = (arr) => {
  let m = 0; for (let i = 0; i < arr.length; i++) m += arr[i]; m /= arr.length;
  let v = 0; for (let i = 0; i < arr.length; i++) v += (arr[i] - m) ** 2;
  return Math.sqrt(v / arr.length);
};

// Accumulating Welch periodogram (Hann window), fractional-rms normalised, returned as nu*P(nu).
export class WelchAccumulator {
  constructor(seg, dt) {
    this.seg = seg; this.dt = dt; this.count = 0;
    this.sum = new Float64Array(seg / 2);
    this.win = new Float64Array(seg);
    let w2 = 0;
    for (let i = 0; i < seg; i++) { this.win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / seg); w2 += this.win[i] ** 2; }
    this.w2 = w2;
    this.re = new Float64Array(seg); this.im = new Float64Array(seg);
  }
  add(x, offset) {
    const { seg, re, im, win } = this;
    let m = 0; for (let i = 0; i < seg; i++) m += x[offset + i]; m /= seg;
    for (let i = 0; i < seg; i++) { re[i] = (x[offset + i] - m) * win[i]; im[i] = 0; }
    fft(re, im);
    // one-sided PSD in (rms/mean)^2 / Hz
    const norm = 2 * this.dt / (this.w2 * m * m);
    for (let k = 1; k < seg / 2; k++) this.sum[k] += (re[k] * re[k] + im[k] * im[k]) * norm;
    this.count++;
  }
  reset() { this.count = 0; this.sum.fill(0); }
  // log-binned nu*P(nu)
  spectrum(nbins = 64) {
    const { seg, dt, count } = this;
    if (!count) return null;
    const df = 1 / (seg * dt), fmin = df, fmax = 0.5 / dt;
    const lf0 = Math.log(fmin), lf1 = Math.log(fmax);
    const acc = new Float64Array(nbins), cnt = new Float64Array(nbins);
    for (let k = 1; k < seg / 2; k++) {
      const f = k * df;
      const b = Math.min(nbins - 1, Math.floor((Math.log(f) - lf0) / (lf1 - lf0) * nbins));
      acc[b] += f * this.sum[k] / count; cnt[b]++;
    }
    const f = [], p = [];
    for (let b = 0; b < nbins; b++) if (cnt[b]) { f.push(Math.exp(lf0 + (b + 0.5) / nbins * (lf1 - lf0))); p.push(acc[b] / cnt[b]); }
    return { f, p, fmin, fmax };
  }
}

// ================================================================ QPO light curves
// Each returns { dt, x (Float64Array of flux, mean ~ 1), seg (Welch segment length) }.
const N_LC = 65536;

// Type-C: the precessing flow shows more and then less of itself (geometry/torus.py), a sinusoid at nu
// plus a weaker one at 2 nu. Changes from the Python, to look like real data:
// the precession phase random-walks, which gives the peak a quality factor Q = TYPEC.Q instead of a
// spike, and the continuum is band-limited noise (a flat top that breaks to 1/f^2) instead of a power law.
// The QPO rms is TYPEC.rmsQ at i = 84 deg and scales with sin(i), so a face-on view loses the QPO.
TYPEC.Q = 8; TYPEC.rmsQ = 0.11; TYPEC.harm = 0.45;
TYPEC.noise = [{ rms: 0.20, hw: 0.07 }, { rms: 0.08, hw: 2.0 }];
export function lcTypeC(inclDeg, seed = 18) {
  const dt = 1 / 64, n = 2 * N_LC, nu = TYPEC.nu;
  const phase = diffusingPhase(n, dt, nu, TYPEC.Q, seed + 101);
  const amp = Math.SQRT2 * TYPEC.rmsQ * Math.sin(inclDeg * Math.PI / 180) / Math.sin(84 * Math.PI / 180);
  const noise = lorentzNoise(n, dt, TYPEC.noise, seed);
  const x = new Float64Array(n);
  for (let k = 0; k < n; k++) x[k] = 1 + amp * (Math.sin(phase[k]) + TYPEC.harm * Math.cos(2 * phase[k])) + noise[k];
  return { dt, x, seg: 4096, phase };
}

// RPM: Doppler factor of the blob on the closed-form perturbed orbit (analytic_rpm_doppler_lc),
// delta^4 at 6% rms for i = 84 deg (scaled with inclination), 22% rms red noise, slope 1.2.
// With phases = { dt, U, L, C } (sampled orbital, periastron and nodal phases) the three motions
// random-walk as in lcRpm; without it they run like clockwork.
export function rpmState(t, phases) {
  const { r0, dr, dz, nuU, nuL, nuC, M } = RPM;
  const wphi = 2 * Math.PI * nuU, wr = 2 * Math.PI * (nuU - nuL), wth = 2 * Math.PI * (nuU - nuC);
  let pU = wphi * t, pR = wr * t, pT = wth * t;
  if (phases) {
    pU = sampleWrap(phases.U, phases.dt, t);
    pR = pU - sampleWrap(phases.L, phases.dt, t);
    pT = pU - sampleWrap(phases.C, phases.dt, t);
  }
  const r = r0 + dr * r0 * Math.cos(pR);
  const th = 0.5 * Math.PI + dz * Math.cos(pT);
  const ph = pU;
  const tg = tgS(M);
  const vr = -dr * r0 * wr * Math.sin(pR) * tg;
  const vth = r * (-dz * wth * Math.sin(pT)) * tg;
  const vph = r * Math.sin(th) * wphi * tg;
  const st = Math.sin(th), ct = Math.cos(th), sp = Math.sin(ph), cp = Math.cos(ph);
  const pos = [r * st * cp, r * st * sp, r * ct];
  const vel = [vr * st * cp + vth * ct * cp - vph * sp, vr * st * sp + vth * ct * sp + vph * cp, vr * ct - vth * st];
  return { pos, vel, r, th, ph };
}
function rpmDoppler(t, inclDeg, phases) {
  const { vel } = rpmState(t, phases);
  const i = inclDeg * Math.PI / 180;
  const bl = vel[0] * Math.sin(i) + vel[2] * Math.cos(i);
  const b2 = vel[0] ** 2 + vel[1] ** 2 + vel[2] ** 2;
  return 1 / ((1 / Math.sqrt(Math.max(1 - b2, 1e-12))) * (1 - bl));
}
// High-frequency QPOs: the blob's Doppler boost delta^4 on the perturbed orbit (analytic_rpm_doppler_lc).
// Changes from the Python, to look like real data: the orbital, periastron and nodal phases each
// random-walk, so the three peaks have quality factors RPM.Q (instead of spikes); the blob is RPM.rmsBlob
// of the flux at i = 84 deg (scaled with inclination); the continuum is band-limited noise.
// Counting (Poisson) noise is left out, which is what makes these weak peaks show within a minute.
RPM.Q = { U: 10, L: 8, C: 6 }; RPM.rmsBlob = 0.035;
RPM.noise = [{ rms: 0.12, hw: 4 }, { rms: 0.05, hw: 40 }];
export function lcRpm(inclDeg, seed = 43) {
  const dt = 1 / 4096, n = 4 * N_LC;   // 64 s, so 64 one-second segments can be averaged
  const phases = {
    dt,
    U: diffusingPhase(n, dt, RPM.nuU, RPM.Q.U, seed + 1),
    L: diffusingPhase(n, dt, RPM.nuL, RPM.Q.L, seed + 2),
    C: diffusingPhase(n, dt, RPM.nuC, RPM.Q.C, seed + 3),
  };
  const shape = (inc) => { const q = new Float64Array(n); for (let k = 0; k < n; k++) q[k] = rpmDoppler(k * dt, inc, phases) ** 4; return q; };
  const ref = stdOf(shape(84));
  const q = shape(inclDeg);
  let m = 0; for (let k = 0; k < n; k++) m += q[k]; m /= n;
  const noise = lorentzNoise(n, dt, RPM.noise, seed);
  const x = new Float64Array(n);
  for (let k = 0; k < n; k++) x[k] = 1 + (q[k] - m) / ref * RPM.rmsBlob + noise[k];
  return { dt, x, seg: 4096, phases };
}

// Heartbeat: the one-zone limit cycle, luminosity / mean, plus band-limited noise (flat to about
// HEART.noise[0].hw Hz, then 1/f^2).
HEART.noise = [{ rms: 0.08, hw: 0.4 }];
export function lcHeartbeat(seed = 4) {
  const n = N_LC, dt = 0.125;
  const hb = evolveHeartbeat(HEART, dt * (n - 1), n, 17);
  let m = 0; for (let k = 0; k < n; k++) m += hb.L[k]; m /= n;
  const noise = lorentzNoise(n, dt, HEART.noise, seed);
  const x = new Float64Array(n);
  for (let k = 0; k < n; k++) x[k] = hb.L[k] / m + noise[k];
  let lmax = 0; for (let k = 0; k < n; k++) lmax = Math.max(lmax, hb.L[k] / m);
  const per = hb.peaks.length > 2 ? (hb.peaks[hb.peaks.length - 1] - hb.peaks[1]) / (hb.peaks.length - 2) : 42;
  return { dt, x, seg: 2048, hb, mean: m, lmax, period: per };
}

// Plain disc: broadband red noise only, no QPO. A soft-state disc flickers weakly, a few percent rms,
// with a power spectrum close to 1/f.
QUIET.rms = 0.05; QUIET.slope = 1.0;
export function lcQuiet(seed = 7) {
  const dt = 1 / 64, n = 2 * N_LC;
  const noise = redNoise(n, dt, QUIET.slope, QUIET.rms, seed);
  const x = new Float64Array(n);
  for (let k = 0; k < n; k++) x[k] = 1 + noise[k];
  return { dt, x, seg: 4096 };
}

// ================================================================ binary geometry
export function eggleton(q) {
  const q23 = Math.cbrt(q * q), q13 = Math.cbrt(q);
  return 0.49 * q23 / (0.6 * q23 + Math.log(1 + q13));
}

// Binary in the corotating frame, lengths in units of the separation a.
// Black hole at the origin, companion at (1, 0, 0), orbit and disc rotate about +z.
export function makeBinary({ M1 = 10, M2 = 1, R2 = 1, Tstar = 5800 } = {}) {
  const q = M2 / M1, m1 = 1 / (1 + q), m2 = q / (1 + q), xc = m2;
  const fL = eggleton(q);
  const aRsun = R2 / fL;
  const aCm = aRsun * RSUN;
  const P = 2 * Math.PI * Math.sqrt(aCm ** 3 / (G * (M1 + M2) * MSUN));
  const aRg = aCm / rgCm(M1);
  const phi = (x, y, z) => {
    const r1 = Math.hypot(x, y, z), r2 = Math.hypot(x - 1, y, z);
    return -m1 / r1 - m2 / r2 - 0.5 * ((x - xc) ** 2 + y * y);
  };
  const grad = (x, y, z) => {
    const r1 = Math.hypot(x, y, z), r2 = Math.hypot(x - 1, y, z);
    const a1 = m1 / r1 ** 3, a2 = m2 / r2 ** 3;
    return [a1 * x + a2 * (x - 1) - (x - xc), a1 * y + a2 * y - y, a1 * z + a2 * z];
  };
  // L1 by bisection of dPhi/dx on (0, 1)
  let lo = 0.05, hi = 0.999;
  const dfx = (x) => m1 / (x * x) - m2 / ((1 - x) ** 2) - (x - xc);
  for (let k = 0; k < 80; k++) { const mid = 0.5 * (lo + hi); if (dfx(mid) > 0) lo = mid; else hi = mid; }
  const xL1 = 0.5 * (lo + hi);
  const phiL1 = phi(xL1, 0, 0);
  const phiS = phiL1 - 0.0001 * Math.abs(phiL1);   // fills the lobe to within 0.01% of the L1 potential, so the nose is pointed
  const bound = (1 - xL1) * 1.01;
  // circularisation radius (textbook form, q = M2/M1)
  const b1 = 0.500 - 0.227 * Math.log10(q);
  const rCirc = (1 + q) * b1 ** 4;
  const rLbh = eggleton(1 / q);
  const rOut = 0.7 * rLbh;

  const B = { M1, M2, q, m1, m2, xc, fL, aRsun, aCm, aRg, P, xL1, phiL1, phiS, bound, rCirc, rLbh, rOut, phi, grad, Tstar };
  B.hBase = 0.04; B.hBulge = 0.11;
  B.stream = integrateStream(B);
  B.phiImp = Math.atan2(B.stream.impact[1], B.stream.impact[0]);
  // equivalent-volume radius of the rendered star, as a check against Eggleton
  B.starSamples = sampleStar(B, 1600);
  let vol = 0; for (const s of B.starSamples) vol += s.r ** 3 / 3 * s.dOmega;
  B.rVolEq = Math.cbrt(vol * 3 / (4 * Math.PI));
  return B;
}

// Rim half-height (as H/R) versus corotating azimuth; bulge where the stream hits, trailing downstream.
export function rimH(B, phiCo) {
  let d = phiCo - B.phiImp;
  d = Math.atan2(Math.sin(d), Math.cos(d));
  const w = d > 0 ? 0.7 : 0.35;
  return B.hBase + B.hBulge * Math.exp(-((d / w) ** 2));
}

// Ballistic stream from L1 in the corotating frame (units: a, 1/Omega, G*Mtot = 1).
function integrateStream(B) {
  const { m1, m2, xc, xL1, rOut } = B;
  const acc = (x, y, vx, vy) => {
    const r1 = Math.hypot(x, y), r2 = Math.hypot(x - 1, y);
    const gx = m1 * x / r1 ** 3 + m2 * (x - 1) / r2 ** 3 - (x - xc);
    const gy = m1 * y / r1 ** 3 + m2 * y / r2 ** 3 - y;
    return [-gx + 2 * vy, -gy - 2 * vx];
  };
  let s = [xL1 - 2e-3, 0, -0.015, 0];
  const pts = [[s[0], s[1]]];
  const dt = 2e-4;
  let impactVel = [0, 0];
  for (let k = 0; k < 200000; k++) {
    const f = (st) => { const a = acc(st[0], st[1], st[2], st[3]); return [st[2], st[3], a[0], a[1]]; };
    const k1 = f(s);
    const k2 = f(s.map((v, i) => v + 0.5 * dt * k1[i]));
    const k3 = f(s.map((v, i) => v + 0.5 * dt * k2[i]));
    const k4 = f(s.map((v, i) => v + dt * k3[i]));
    s = s.map((v, i) => v + dt / 6 * (k1[i] + 2 * k2[i] + 2 * k3[i] + k4[i]));
    if (k % 20 === 0) pts.push([s[0], s[1]]);
    if (Math.hypot(s[0], s[1]) < rOut) { impactVel = [s[2], s[3]]; pts.push([s[0], s[1]]); break; }
  }
  // resample by arclength into 48 points
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  const L = cum[cum.length - 1], N = 48, out = [];
  let j = 0;
  for (let i = 0; i < N; i++) {
    const target = L * i / (N - 1);
    while (j < cum.length - 2 && cum[j + 1] < target) j++;
    const u = (target - cum[j]) / Math.max(cum[j + 1] - cum[j], 1e-12);
    out.push([pts[j][0] + u * (pts[j + 1][0] - pts[j][0]), pts[j][1] + u * (pts[j + 1][1] - pts[j][1]), target / L]);
  }
  return { points: out, length: L, impact: out[N - 1], impactVel };
}

function sampleStar(B, N) {
  const out = [];
  const ga = Math.PI * (3 - Math.sqrt(5));
  const dOmega = 4 * Math.PI / N;
  for (let k = 0; k < N; k++) {
    const z = 1 - 2 * (k + 0.5) / N, rr = Math.sqrt(1 - z * z), th = ga * k;
    const u = [rr * Math.cos(th), rr * Math.sin(th), z];
    // march outward from the star centre to the first point where Phi > PhiS
    let r0 = 0.02, r1 = B.bound;
    let prev = 0.02;
    for (let s = 1; s <= 64; s++) {
      const r = B.bound * s / 64;
      const x = 1 + u[0] * r, y = u[1] * r, zz = u[2] * r;
      if (B.phi(x, y, zz) > B.phiS || x < B.xL1) { r0 = prev; r1 = r; break; }
      prev = r;
    }
    for (let it = 0; it < 30; it++) {
      const m = 0.5 * (r0 + r1);
      const x = 1 + u[0] * m, y = u[1] * m, zz = u[2] * m;
      if (B.phi(x, y, zz) > B.phiS || x < B.xL1) r1 = m; else r0 = m;
    }
    const r = 0.5 * (r0 + r1);
    const p = [1 + u[0] * r, u[1] * r, u[2] * r];
    const g = B.grad(p[0], p[1], p[2]);
    const gm = Math.hypot(g[0], g[1], g[2]);
    const n = [g[0] / gm, g[1] / gm, g[2] / gm];
    const cosnu = Math.max(n[0] * u[0] + n[1] * u[1] + n[2] * u[2], 0.05);
    out.push({ p, n, g: gm, r, dOmega, dA: r * r * dOmega / cosnu });
  }
  return out;
}

// ---------------------------------------------------------------- light curves at binary scale
const bV = (T) => 1 / Math.expm1(26160 / T); // Planck B_lambda shape at 550 nm (hc/(lambda k) = 26160 K)

function discH(B, r, phiCo) {
  // H/R of the flared disc in units of a; matches the shader profile at the rim
  const rRg = r * B.aRg;
  const lg = Math.log10(Math.max(rRg, 1));
  const t = Math.min(1, Math.max(0, (lg - 2.5) / (4.9 - 2.5)));
  const s = t * t * (3 - 2 * t);
  let h = 0.008 + (B.hBase - 0.008) * s;
  const xr = (r / B.rOut - 0.86) / 0.06;   // raised lip just inside the edge, as in the shader
  h += (rimH(B, phiCo) - B.hBase) * Math.exp(-xr * xr);
  // rounded lip over the last 10% of the radius, as in the shader
  const e = Math.min(1, Math.max(0, (r - 0.9 * B.rOut) / (0.1 * B.rOut)));
  return h * r * Math.sqrt(Math.max(1 - e * e, 0));
}

function starBlocks(B, p, n) {
  // does the ray p + t n (t > 0) pass through the companion?
  const cx = 1 - p[0], cy = -p[1], cz = -p[2];
  const tc = cx * n[0] + cy * n[1] + cz * n[2];
  if (tc < 0) return false;
  const d2 = cx * cx + cy * cy + cz * cz - tc * tc;
  const R = B.bound;
  if (d2 > R * R) return false;
  const half = Math.sqrt(R * R - d2);
  const t0 = Math.max(tc - half, 0), t1 = tc + half;
  for (let s = 0; s <= 28; s++) {
    const t = t0 + (t1 - t0) * s / 28;
    const x = p[0] + t * n[0], y = p[1] + t * n[1], z = p[2] + t * n[2];
    if (x > B.xL1 && B.phi(x, y, z) < B.phiS) return true;
  }
  return false;
}

function discBlocks(B, p, n) {
  // does the ray p + t n cross the disc volume?
  const hmax = (B.hBase + B.hBulge) * B.rOut;
  if (Math.abs(n[2]) < 1e-6) return false;
  let ta = (-hmax - p[2]) / n[2], tb = (hmax - p[2]) / n[2];
  if (ta > tb) [ta, tb] = [tb, ta];
  ta = Math.max(ta, 1e-4);
  if (tb <= ta) return false;
  for (let s = 0; s <= 10; s++) {
    const t = ta + (tb - ta) * s / 10;
    const x = p[0] + t * n[0], y = p[1] + t * n[1], z = p[2] + t * n[2];
    const r = Math.hypot(x, y);
    if (r < B.rOut && Math.abs(z) < discH(B, r, Math.atan2(y, x))) return true;
  }
  return false;
}

// Optical (V band) and X-ray light curves versus orbital phase for observer inclination i.
// heat in [0, 1] scales X-ray heating of the companion.
export function* binaryLightCurvesGen(B, inclDeg, heat = 1, nPhase = 160) {
  const i = inclDeg * Math.PI / 180, si = Math.sin(i), ci = Math.cos(i);
  const TsGrav = B.Tstar;
  let gMean = 0; for (const s of B.starSamples) gMean += s.g; gMean /= B.starSamples.length;
  const rimShadow = B.hBase;
  const Tirr0 = 9000 * heat;
  const star = B.starSamples.map((s) => {
    const T4g = (TsGrav * Math.pow(s.g / gMean, 0.08)) ** 4;
    const d = Math.hypot(...s.p);
    const cosI = -(s.n[0] * s.p[0] + s.n[1] * s.p[1] + s.n[2] * s.p[2]) / d;
    const elev = Math.abs(s.p[2]) / Math.hypot(s.p[0], s.p[1]);
    const lt = Math.min(1, Math.max(0, (elev - rimShadow * 0.3) / (rimShadow * 1.7)));
    const lit = lt * lt * (3 - 2 * lt);   // same soft rim shadow as the shader
    const dN = 1 - B.xL1;
    const T4i = cosI > 0 ? Tirr0 ** 4 * cosI * (dN / d) ** 2 * lit : 0;
    return { ...s, B: bV(Math.pow(T4g + T4i, 0.25)) };
  });
  // disc surface elements (top and bottom faces) and rim
  const disc = [];
  const nr = 34, nph = 48, rIn = 0.004;
  for (let a = 0; a < nr; a++) {
    const r0 = rIn * Math.pow(B.rOut / rIn, a / nr), r1 = rIn * Math.pow(B.rOut / rIn, (a + 1) / nr), r = Math.sqrt(r0 * r1);
    const T = discTemp(B.M1, r * B.aRg, 4.233);
    const area = Math.PI * (r1 * r1 - r0 * r0) / nph;
    for (let b = 0; b < nph; b++) {
      const ph = 2 * Math.PI * (b + 0.5) / nph;
      const H = discH(B, r, ph);
      disc.push({ p: [r * Math.cos(ph), r * Math.sin(ph), H], n: [0, 0, 1], B: bV(T), dA: area });
      disc.push({ p: [r * Math.cos(ph), r * Math.sin(ph), -H], n: [0, 0, -1], B: bV(T), dA: area });
    }
  }
  const Trim = discTemp(B.M1, B.rOut * B.aRg, 4.233);
  for (let b = 0; b < 96; b++) {
    const ph = 2 * Math.PI * (b + 0.5) / 96;
    const H = rimH(B, ph) * B.rOut;
    for (const zf of [-0.5, 0.5]) disc.push({ p: [B.rOut * Math.cos(ph) * 0.999, B.rOut * Math.sin(ph) * 0.999, zf * H], n: [Math.cos(ph), Math.sin(ph), 0], B: bV(Trim), dA: 2 * Math.PI * B.rOut / 96 * H });
  }
  // bright spot: hot patch on the rim facing outward and back up the stream
  const imp = B.stream.impact, iv = B.stream.impactVel;
  const ivm = Math.hypot(iv[0], iv[1]) || 1;
  const rad = [imp[0] / Math.hypot(imp[0], imp[1]), imp[1] / Math.hypot(imp[0], imp[1])];
  let sn = [rad[0] - 0.8 * iv[0] / ivm, rad[1] - 0.8 * iv[1] / ivm, 0];
  const snm = Math.hypot(sn[0], sn[1]); sn = [sn[0] / snm, sn[1] / snm, 0];
  const spot = { p: [imp[0] * 1.001, imp[1] * 1.001, 0], n: sn, B: bV(16000), dA: 0.0015 };

  const opt = new Float64Array(nPhase), xr = new Float64Array(nPhase), xStar = new Uint8Array(nPhase), xRim = new Float64Array(nPhase);
  const parts = { star: new Float64Array(nPhase), disc: new Float64Array(nPhase), spot: new Float64Array(nPhase) };
  const corona = [];
  for (let k = 0; k < 24; k++) { const ph = 2 * Math.PI * k / 24; corona.push([0.03 * Math.cos(ph), 0.03 * Math.sin(ph), 0.004 * ((k % 2) ? 1 : -1)]); }
  const ld = (mu) => 1 - 0.6 * (1 - mu);
  for (let k = 0; k < nPhase; k++) {
    const phase = k / nPhase, ph = 2 * Math.PI * phase;
    const n = [si * Math.cos(ph), -si * Math.sin(ph), ci];
    let fs = 0, fd = 0, fsp = 0;
    for (const s of star) {
      const mu = s.n[0] * n[0] + s.n[1] * n[1] + s.n[2] * n[2];
      if (mu <= 0) continue;
      if (discBlocks(B, s.p, n)) continue;
      fs += s.B * ld(mu) * mu * s.dA;
    }
    for (const d of disc) {
      const mu = d.n[0] * n[0] + d.n[1] * n[1] + d.n[2] * n[2];
      if (mu <= 0) continue;
      if (starBlocks(B, d.p, n)) continue;
      fd += d.B * ld(mu) * mu * d.dA;
    }
    {
      const mu = spot.n[0] * n[0] + spot.n[1] * n[1] + spot.n[2] * n[2];
      if (mu > 0 && !starBlocks(B, spot.p, n)) fsp = spot.B * mu * spot.dA;
    }
    parts.star[k] = fs; parts.disc[k] = fd; parts.spot[k] = fsp;
    opt[k] = fs + fd + fsp;
    // X-rays: central point (88%) plus a small flattened corona (12%)
    const cot = ci / Math.max(si, 1e-6);
    const phiObs = Math.atan2(n[1], n[0]);
    const rimOk = Math.min(1, Math.max(0, (cot - rimH(B, phiObs)) / 0.012 + 0.5));
    let xv = 0;
    xStar[k] = starBlocks(B, [0, 0, 0], n) ? 1 : 0;
    xRim[k] = rimOk;
    xv += 0.88 * (xStar[k] ? 0 : rimOk);
    let cv = 0;
    for (const c of corona) cv += starBlocks(B, c, n) ? 0 : Math.min(1, rimOk + 0.25);
    xv += 0.12 * cv / corona.length;
    xr[k] = xv;
    if (k % 8 === 7) yield k / nPhase;
  }
  // optical normalised to its orbital maximum; X-rays as the fraction of the unobscured source
  let m = 0; for (const v of opt) m = Math.max(m, v);
  if (m > 0) for (let k = 0; k < nPhase; k++) opt[k] /= m;
  return { opt, xr, xStar, xRim, parts, incl: inclDeg, heat };
}

export function binaryLightCurves(B, inclDeg, heat = 1, nPhase = 160) {
  const g = binaryLightCurvesGen(B, inclDeg, heat, nPhase);
  for (;;) { const r = g.next(); if (r.done) return r.value; }
}

// Shakura-Sunyaev temperature with a zero-torque inner edge, at 0.1 Eddington (eta = 0.1).
// r in R_g of the black hole. Returns kelvin.
export function discTemp(M, r, rin) {
  const K = discTempK(M);
  if (r <= rin) return 0;
  return Math.pow(K * Math.pow(r, -3) * (1 - Math.sqrt(rin / r)), 0.25);
}
export function discTempK(M) {
  const mdot = 0.1 * 1.26e38 * M / (0.1 * C * C);
  const Rg = rgCm(M);
  return 3 * G * M * MSUN * mdot / (8 * Math.PI * SIGMA_SB * Rg ** 3);
}
