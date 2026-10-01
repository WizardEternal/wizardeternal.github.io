/*
  Inspiral physics for the "chirp" toy, ported from smbhb-inspiral
  (https://github.com/WizardEternal/smbhb-inspiral): constants.py, physics.py,
  waveform.py and sensitivity.py. Plain functions, no DOM, so node can run it too.

  Units: masses in solar masses, frequencies in Hz (gravitational-wave frequency,
  twice the orbital one), times in seconds, distances in Mpc unless named otherwise.
*/
(function (root) {
  'use strict';

  // constants.py (astropy 7.2.0, CODATA 2018 / IAU 2015)
  const G = 6.6743e-11;
  const C = 299792458.0;
  const MSUN = 1.988409870698051e30;
  const PC = 3.085677581491367e16;
  const MPC = 3.085677581491367e22;
  const AU = 1.495978707e11;
  const YR = 31557600.0;
  const DAY = 86400.0;

  function chirpMass(m1, m2) {
    return Math.pow(m1 * m2, 0.6) / Math.pow(m1 + m2, 0.2);
  }

  function symmetricMassRatio(m1, m2) {
    const m = m1 + m2;
    return (m1 * m2) / (m * m);
  }

  // Schwarzschild ISCO, GW frequency: c^3 / (6^(3/2) pi G M)
  function fIsco(mTotal) {
    return Math.pow(C, 3) / (Math.pow(6, 1.5) * Math.PI * G * mTotal * MSUN);
  }

  // Peters (1964) df/dt, times the 1PN factor 1 - (743/336 + 11/4 eta) x
  // (Blanchet 2014, spin-zero limit) when pn >= 1. Same as physics.peters_rhs.
  function fdot(f, mcKg, eta, mTotKg, pn) {
    const gmc = G * mcKg / Math.pow(C, 3);
    let df = (96 / 5) * Math.pow(Math.PI, 8 / 3) * Math.pow(gmc, 5 / 3) * Math.pow(f, 11 / 3);
    if (pn >= 1) {
      const x = Math.pow(Math.PI * G * mTotKg * f / Math.pow(C, 3), 2 / 3);
      df *= 1 - (743 / 336 + (11 / 4) * eta) * x;
    }
    return df;
  }

  // physics.analytic_t_merge_circular: 0PN time to coalescence from f0 [s]
  function analyticTMerge(m1, m2, f0) {
    const m1k = m1 * MSUN, m2k = m2 * MSUN, mt = m1k + m2k;
    const forb = f0 / 2;
    const a0 = Math.pow(G * mt / (4 * Math.PI * Math.PI * forb * forb), 1 / 3);
    return (5 / 256) * Math.pow(C, 5) * Math.pow(a0, 4) / (Math.pow(G, 3) * m1k * m2k * mt);
  }

  // 0PN frequency at a given time before coalescence (inverse of the above)
  function f0pnAtTau(m1, m2, tau) {
    const gmc = G * chirpMass(m1, m2) * MSUN / Math.pow(C, 3);
    return Math.pow(5 / (256 * tau), 3 / 8) * Math.pow(gmc, -5 / 8) / Math.PI;
  }

  /*
    Time left until ISCO as a function of frequency, tau(f) = integral_f^fisco df'/fdot.
    Integrated on a log-f grid. Between nodes the integrand f/fdot is treated as a
    power law, which is exact for 0PN and close for 1PN.
  */
  function tauTable(m1, m2, fLo, pn, n) {
    n = n || 4000;
    const mcKg = chirpMass(m1, m2) * MSUN;
    const eta = symmetricMassRatio(m1, m2);
    const mtKg = (m1 + m2) * MSUN;
    const fHi = fIsco(m1 + m2);
    const lnLo = Math.log(fLo), lnHi = Math.log(fHi);
    const du = (lnHi - lnLo) / (n - 1);
    const lnF = new Float64Array(n);
    const g = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      lnF[i] = lnLo + i * du;
      const f = Math.exp(lnF[i]);
      g[i] = f / fdot(f, mcKg, eta, mtKg, pn);
    }
    const tau = new Float64Array(n);
    tau[n - 1] = 0;
    for (let i = n - 2; i >= 0; i--) {
      const a = g[i], b = g[i + 1];
      const s = Math.log(a / b) / du;            // g ~ exp(-s u) on the segment
      const seg = Math.abs(s) < 1e-9 ? 0.5 * (a + b) * du : (a - b) / s;
      tau[i] = tau[i + 1] + seg;
    }
    return { lnF: lnF, tau: tau, fIsco: fHi };
  }

  // Time left to ISCO starting from f0 (for cross-checks against physics.integrate_inspiral)
  function timeToIsco(m1, m2, f0, pn) {
    return tauTable(m1, m2, f0, pn, 6000).tau[0];
  }

  /*
    One inspiral, set up for the animation: starts tauStart seconds before ISCO and
    ends one ISCO orbit before it. Returns helpers that map time-left to frequency.
  */
  function buildInspiral(m1, m2, opts) {
    opts = opts || {};
    const pn = opts.pn == null ? 1 : opts.pn;
    const tauStart = opts.tauStart || 1e7 * YR;
    const M = m1 + m2;
    const fI = fIsco(M);
    const fLo = Math.min(0.5 * f0pnAtTau(m1, m2, tauStart), 0.5 * fI);
    const T = tauTable(m1, m2, fLo, pn, 4000);
    const n = T.tau.length;
    const lnTau = new Float64Array(n - 1);
    for (let i = 0; i < n - 1; i++) lnTau[i] = Math.log(T.tau[i]);

    // f at a given time left (tau decreases with index)
    function fAtTau(tau) {
      const lt = Math.log(tau);
      if (lt >= lnTau[0]) return Math.exp(T.lnF[0]);
      if (lt <= lnTau[n - 2]) {
        // last segment: tau goes linearly to zero at fisco
        const t1 = T.tau[n - 2];
        const w = 1 - tau / t1;
        return Math.exp(T.lnF[n - 2] + w * (T.lnF[n - 1] - T.lnF[n - 2]));
      }
      let lo = 0, hi = n - 2;
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (lnTau[mid] > lt) lo = mid; else hi = mid;
      }
      const w = (lt - lnTau[lo]) / (lnTau[hi] - lnTau[lo]);
      return Math.exp(T.lnF[lo] + w * (T.lnF[hi] - T.lnF[lo]));
    }

    // time left at a given f (f inside the table)
    function tauAtF(f) {
      const lf = Math.log(f);
      if (lf <= T.lnF[0]) return T.tau[0];
      if (lf >= T.lnF[n - 1]) return 0;
      const du = T.lnF[1] - T.lnF[0];
      const i = Math.min(n - 2, Math.floor((lf - T.lnF[0]) / du));
      const w = (lf - T.lnF[i]) / du;
      if (T.tau[i + 1] <= 0) return T.tau[i] * (1 - w);
      return Math.exp(Math.log(T.tau[i]) + w * (Math.log(T.tau[i + 1]) - Math.log(T.tau[i])));
    }

    const fStart = fAtTau(tauStart);
    const tauEnd = 2 / fI; // one orbital period at ISCO
    return {
      m1: m1, m2: m2, M: M,
      mc: chirpMass(m1, m2),
      eta: symmetricMassRatio(m1, m2),
      fIsco: fI, fStart: fStart,
      tauStart: tauStart, tauEnd: tauEnd,
      lnTauStart: Math.log(tauStart), lnTauEnd: Math.log(tauEnd),
      fAtTau: fAtTau, tauAtF: tauAtF,
      pn: pn
    };
  }

  // Kepler III: a^3 = G M / (pi^2 f_gw^2)  [m]
  function separation(mTotal, f) {
    return Math.pow(G * mTotal * MSUN / (Math.PI * Math.PI * f * f), 1 / 3);
  }

  // relative orbital speed v/c = (pi G M f / c^3)^(1/3)
  function vOverC(mTotal, f) {
    return Math.pow(Math.PI * G * mTotal * MSUN * f / Math.pow(C, 3), 1 / 3);
  }

  // waveform.characteristic_strain_analytic (SPA, sky/inclination averaged)
  function hcAnalytic(f, mcMsun, dMpc) {
    const gmc = G * mcMsun * MSUN;
    return (1 / (dMpc * MPC)) * Math.sqrt(2 / 3) * Math.pow(gmc, 5 / 6) /
      Math.pow(C, 1.5) / Math.pow(Math.PI, 2 / 3) * Math.pow(f, -1 / 6);
  }

  // waveform._amplitude_prefactor: (4/D)(G Mc/c^2)^(5/3)(pi f/c)^(2/3)
  function strainAmplitude(f, mcMsun, dMpc) {
    const gm = G * mcMsun * MSUN / (C * C);
    return (4 / (dMpc * MPC)) * Math.pow(gm, 5 / 3) * Math.pow(Math.PI * f / C, 2 / 3);
  }

  // sensitivity.lisa_sensitivity_hc: Robson, Cornish & Liu (2019) Eqs. 1-3, no Galactic foreground
  const LISA_L = 2.5e9;
  const LISA_FSTAR = C / (2 * Math.PI * LISA_L);
  function lisaHc(f) {
    const pOms = Math.pow(1.5e-11, 2) * (1 + Math.pow(2e-3 / f, 4));
    const pAcc = Math.pow(3e-15, 2) * (1 + Math.pow(0.4e-3 / f, 2)) * (1 + Math.pow(f / 8e-3, 4));
    const pAccDisp = pAcc / Math.pow(2 * Math.PI * f, 4);
    const r = f / LISA_FSTAR;
    const cosr = Math.cos(r);
    const sn = (10 / (3 * LISA_L * LISA_L)) * (pOms + 2 * (1 + cosr * cosr) * pAccDisp) * (1 + 0.6 * r * r);
    return Math.sqrt(f * sn);
  }

  // data/nanograv_15yr_sensitivity.csv: hand digitization of Agazie et al. (2023) Fig. 1
  const NANOGRAV = [
    [1.0e-9, 3.0e-13], [2.0e-9, 5.0e-14], [3.0e-9, 2.0e-14], [5.0e-9, 8.0e-15],
    [8.0e-9, 5.0e-15], [1.0e-8, 4.0e-15], [2.0e-8, 6.0e-15], [3.0e-8, 1.0e-14],
    [5.0e-8, 5.0e-14], [8.0e-8, 3.0e-13], [1.0e-7, 1.0e-12]
  ];
  // sensitivity.nanograv_15yr_sensitivity_hc_interp: log-log, Infinity outside the data
  function nanogravHc(f) {
    const lf = Math.log10(f);
    const n = NANOGRAV.length;
    if (lf < Math.log10(NANOGRAV[0][0]) || lf > Math.log10(NANOGRAV[n - 1][0])) return Infinity;
    for (let i = 0; i < n - 1; i++) {
      const a = Math.log10(NANOGRAV[i][0]), b = Math.log10(NANOGRAV[i + 1][0]);
      if (lf <= b) {
        const w = (lf - a) / (b - a);
        const ya = Math.log10(NANOGRAV[i][1]), yb = Math.log10(NANOGRAV[i + 1][1]);
        return Math.pow(10, ya + w * (yb - ya));
      }
    }
    return NANOGRAV[n - 1][1];
  }

  // Bands as the repo's README draws them
  const BANDS = {
    pta: [1e-9, 1e-7],
    gap: [1e-7, 1e-4],
    lisa: [1e-4, 1e-1]
  };
  function bandOf(f) {
    if (f < BANDS.pta[0]) return 'below';
    if (f <= BANDS.pta[1]) return 'pta';
    if (f < BANDS.lisa[0]) return 'gap';
    if (f <= BANDS.lisa[1]) return 'lisa';
    return 'above';
  }

  const api = {
    G: G, C: C, MSUN: MSUN, PC: PC, MPC: MPC, AU: AU, YR: YR, DAY: DAY,
    chirpMass: chirpMass, symmetricMassRatio: symmetricMassRatio, fIsco: fIsco,
    fdot: fdot, analyticTMerge: analyticTMerge, f0pnAtTau: f0pnAtTau,
    tauTable: tauTable, timeToIsco: timeToIsco, buildInspiral: buildInspiral,
    separation: separation, vOverC: vOverC, hcAnalytic: hcAnalytic,
    strainAmplitude: strainAmplitude, lisaHc: lisaHc, nanogravHc: nanogravHc,
    NANOGRAV: NANOGRAV, BANDS: BANDS, bandOf: bandOf
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SMBHB = api;
})(typeof window !== 'undefined' ? window : this);
