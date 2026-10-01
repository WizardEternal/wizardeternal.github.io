/*
  Take its pulse: main script. Loads assets/data/grs-pulse.json (the Swift XRT light
  curve of OBSID 00030333057, the one in Fig. 3 of Akbari et al. 2026, and the fit values from its
  Tables 2 and 3), plays the curve like a heart monitor, works out where in the
  five-phase cycle we are, blends the five fitted values smoothly for that point,
  and hands them to the 3D view (grs-pulse-3d.js) and the small charts.
*/
const $ = id => document.getElementById(id);
const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
// Instrument palette (play.css, site.css), read once; it doesn't change with the theme.
// Second argument = fallback.
const TOK_CS = getComputedStyle(document.querySelector('.pulse') || document.body);
const tok = (name, fallback) => TOK_CS.getPropertyValue(name).trim() || fallback;
const rgba = (hex, a) => {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
};
const PH = [tok('--ph1', '#ff5b4f'), tok('--ph2', '#39b865'), tok('--ph3', '#5d7dff'), tok('--ph4', '#33dde4'), tok('--ph5', '#a7adb1')];
const INK = tok('--inst-text', '#ebe6dc'), MUTED = tok('--inst-muted', '#93a0a0'), PANEL = tok('--inst-bg', '#0c1114');
const PH_NAME = ['the start of the climb', 'the middle of the climb', 'the top of the climb', 'just past the peak', 'the drop back down'];
const DPR_CAP = 2;

const ui = {
  toy: $('toy'), sceneBox: $('scene'), host: $('scene-host'), fallback: $('scene-fallback'), fallbackText: $('scene-fallback-text'),
  modeSwitch: $('mode-switch'), nudge: $('mode-nudge'), toast: $('flip-toast'),
  pill: $('phase-pill'), pillDot: $('phase-dot'), pillText: $('phase-text'), hint: $('scene-hint'), tbarMark: $('tbar-mark'),
  caption: $('caption'), play: $('btn-play'), scrub: $('scrub'), scrubNow: $('scrub-now'), scrubEnd: $('scrub-end'),
  ecg: $('cv-ecg'), mini: $('cv-mini'), cvT: $('cv-t'), cvR: $('cv-r'), cvK: $('cv-k'),
  nowT: $('now-t'), nowR: $('now-r'), nowK: $('now-k'), noteT: $('note-t'), noteR: $('note-r'), noteK: $('note-k'),
  roT: $('ro-t'), corSub: $('tag-corona-sub'), tagCor: $('tag-corona')
};

// ------------------------------------------------------------------ helpers
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, u) => a + (b - a) * u;
const smooth = u => u * u * (3 - 2 * u);
// Five fitted values sit at the phase centres x = 0.5 ... 4.5 on a cyclic axis [0, 5).
// Between two centres we blend with a smoothstep weight. This is the toy's interpolation,
// the paper gives only the five values.
function interp5(vals, x) {
  const s = x - 0.5;
  const k0 = ((Math.floor(s) % 5) + 5) % 5;
  const w = smooth(s - Math.floor(s));
  return lerp(vals[k0], vals[(k0 + 1) % 5], w);
}
function fmt(v, d) { return v.toFixed(d); }
function decimals(v) { const s = String(v); return s.includes('.') ? s.split('.')[1].length : 0; }
function valHTML(e) {
  const d = Math.max(decimals(e[0]), decimals(e[1]), decimals(e[2]));
  if (Math.abs(e[1] - e[2]) < 1e-9) return `${fmt(e[0], d)} ± ${fmt(e[1], d)}`;
  return `${fmt(e[0], d)}<sup>+${fmt(e[2], d)}</sup><sub>−${fmt(e[1], d)}</sub>`;
}
function setupCanvas(cv, cache) {
  const r = cv.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, DPR_CAP);
  const w = Math.max(1, r.width), h = Math.max(1, r.height);
  cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  Object.assign(cache, { ctx, w, h });
  return cache;
}
function hexA(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16 & 255},${n >> 8 & 255},${n & 255},${a})`;
}

// -------------------------------------------------------------------- state
let D, N, cr, ph, runStart, runLen;
const st = { t: 0, playing: false, speed: 8, mode: 'soft', m: 0, everFlipped: false, softBeats: 0, lastPhase: 0, captionKey: '', dragging: false };
let scene3d = null;
const cv = { ecg: {}, mini: {}, T: {}, R: {}, K: {} };

function cycAt(t) {
  const i = clamp(Math.floor(t), 0, N - 1);
  const u = clamp((i - runStart[i] + (t - i)) / runLen[i], 0, 0.9999);
  return ph[i] - 1 + u;
}
function rateAt(t) {
  const i = clamp(Math.floor(t), 0, N - 2);
  return lerp(cr[i], cr[i + 1], clamp(t - i, 0, 1));
}

// ---------------------------------------------------------- per-frame values
function values(x) {
  const X = D.xrt, J = D.joint;
  const k = i => i[0];
  const Ts = interp5(X.Tin.map(k), x), Tb = J.Tin[0];
  const Rs = interp5(X.Rin.map(k), x), Rb = interp5(J.Rin.map(k), x);
  return {
    Tsoft: Ts, Tbroad: Tb,
    T: lerp(Ts, Tb, st.m), R: lerp(Rs, Rb, st.m),
    kTe: interp5(J.kTe.map(k), x), norm: interp5(J.norm.map(k), x)
  };
}

// ------------------------------------------------------------------- the ECG
function drawECG() {
  const { ctx, w, h } = cv.ecg;
  if (!ctx) return;
  ctx.clearRect(0, 0, w, h);
  const span = w < 560 ? 60 : 110;           // seconds on screen
  const headF = 0.8;
  // window starts at 0 and only scrolls once the playhead reaches 80% of the width,
  // so the first view already shows the whole heartbeat pattern (ghosted ahead of the playhead)
  const tL = clamp(st.t - span * headF, 0, Math.max(0, N - 1 - span));
  const X = tt => (tt - tL) / span * w;
  const padT = 10, padB = 16;
  const lo = 30, hi = 220;
  const Y = c => padT + (1 - (c - lo) / (hi - lo)) * (h - padT - padB);

  // grid
  ctx.lineWidth = 1;
  ctx.font = '500 10px Inter, system-ui, sans-serif';
  ctx.textBaseline = 'middle';
  for (const c of [50, 100, 150, 200]) {
    const y = Math.round(Y(c)) + 0.5;
    ctx.strokeStyle = 'rgba(214,228,226,0.07)';
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
    ctx.fillStyle = rgba(MUTED, 0.75);
    ctx.fillText(String(c), 6, y - 7);
  }
  for (let s = Math.ceil(tL / 10) * 10; s < tL + span; s += 10) {
    const x = Math.round(X(s)) + 0.5;
    ctx.strokeStyle = s % 50 === 0 ? 'rgba(214,228,226,0.09)' : 'rgba(214,228,226,0.04)';
    ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, h - padB); ctx.stroke();
  }
  // 10 s scale bar, drawn like the HUD scale bar on the other toys: an open
  // bracket with the length written to its right
  const sb = 10 / span * w;
  ctx.font = '500 11.5px Inter, system-ui, sans-serif';
  const sbw = ctx.measureText('10 s').width;
  const x1 = w - 14 - sbw - 8, x0 = x1 - sb, yb = padT + 2;
  ctx.strokeStyle = rgba(INK, 0.75); ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.moveTo(x0, yb); ctx.lineTo(x0, yb + 6); ctx.lineTo(x1, yb + 6); ctx.lineTo(x1, yb); ctx.stroke();
  ctx.fillStyle = INK;
  ctx.fillText('10 s', x1 + 8, yb + 4);
  ctx.font = '500 10px Inter, system-ui, sans-serif';

  // ghost of the whole window, including what hasn't played yet
  const g0 = Math.max(0, Math.floor(tL)), g1 = Math.min(N - 1, Math.ceil(tL + span));
  ctx.lineWidth = 1.2; ctx.lineJoin = 'round';
  for (let i = g0; i < g1; i++) {
    if (i + 1 <= st.t) continue;
    ctx.strokeStyle = hexA(PH[ph[i] - 1], 0.22);
    ctx.beginPath(); ctx.moveTo(X(i), Y(cr[i])); ctx.lineTo(X(i + 1), Y(cr[i + 1])); ctx.stroke();
    ctx.fillStyle = hexA(PH[ph[i] - 1], 0.22);
    ctx.fillRect(X(i), h - 8, X(i + 1) - X(i) + 0.5, 5);
  }
  // the trace, oldest first so the fresh part sits on top
  const i0 = Math.max(0, Math.floor(tL)), i1 = Math.floor(st.t);
  const age = tt => clamp((st.t - tt) / (span * headF), 0, 1) * 0.6;
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  for (let pass = 0; pass < 2; pass++) {
    for (let i = i0; i <= i1 && i < N - 1; i++) {
      const tEnd = Math.min(i + 1, st.t);
      if (tEnd <= i) continue;
      const a = 1 - 0.8 * Math.pow(age(i), 1.3);
      const col = PH[ph[i] - 1];
      ctx.strokeStyle = hexA(col, pass === 0 ? 0.16 * a : a);
      ctx.lineWidth = pass === 0 ? 6 : 1.8;
      ctx.beginPath();
      ctx.moveTo(X(i), Y(cr[i]));
      ctx.lineTo(X(tEnd), Y(rateAt(tEnd)));
      ctx.stroke();
    }
  }
  // phase ribbon
  for (let i = i0; i <= i1 && i < N; i++) {
    const a = 1 - 0.7 * age(i);
    ctx.fillStyle = hexA(PH[ph[i] - 1], 0.85 * a);
    const x0 = X(i), x1 = X(Math.min(i + 1, st.t));
    if (x1 > x0) ctx.fillRect(x0, h - 8, x1 - x0 + 0.5, 5);
  }
  const hx = X(st.t);
  // head
  const rate = rateAt(st.t), hy = Y(rate), col = PH[ph[Math.floor(clamp(st.t, 0, N - 1))] - 1];
  ctx.strokeStyle = rgba(INK, 0.18); ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(Math.round(hx) + 0.5, padT); ctx.lineTo(Math.round(hx) + 0.5, h - padB); ctx.stroke();
  const rg = ctx.createRadialGradient(hx, hy, 0, hx, hy, 16);
  rg.addColorStop(0, hexA(col, 0.9)); rg.addColorStop(1, hexA(col, 0));
  ctx.fillStyle = rg; ctx.beginPath(); ctx.arc(hx, hy, 16, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(hx, hy, 3, 0, Math.PI * 2); ctx.fill();
  ctx.font = '600 12px Inter, system-ui, sans-serif'; ctx.fillStyle = INK;
  const label = `${cr[clamp(Math.floor(st.t), 0, N - 1)]} counts/s`;
  const lw = ctx.measureText(label).width;
  const ly = clamp(hy - 18, padT + 30, h - padB - 6);
  ctx.fillText(label, clamp(hx - lw - 12, 30, w - lw - 4), ly);
}

function drawMini() {
  const { ctx, w, h } = cv.mini;
  if (!ctx) return;
  ctx.clearRect(0, 0, w, h);
  const Y = c => 3 + (1 - (c - 30) / 190) * (h - 6);
  ctx.lineWidth = 1;
  for (let i = 0; i < N - 1; i++) {
    ctx.strokeStyle = hexA(PH[ph[i] - 1], 0.7);
    ctx.beginPath(); ctx.moveTo(i / (N - 1) * w, Y(cr[i])); ctx.lineTo((i + 1) / (N - 1) * w, Y(cr[i + 1])); ctx.stroke();
  }
}

// ------------------------------------------------------------------- charts
const CH = {
  T: { lo: 1.1, hi: 2.0, ticks: [1.2, 1.6, 2.0], d: 2 },
  R: { lo: 12, hi: 42, ticks: [15, 25, 35], d: 0 },
  K: { lo: 0, hi: 24, ticks: [0, 10, 20], d: 0 }
};
function drawChart(key, x, soft, broad, extra) {
  const c = cv[key]; const { ctx, w, h } = c; if (!ctx) return;
  const spec = CH[key];
  ctx.clearRect(0, 0, w, h);
  const pl = 30, pr = 8, pt = 7, pb = 17;
  const pw = w - pl - pr, phh = h - pt - pb;
  const X = xx => pl + xx / 5 * pw;
  const Y = v => pt + (1 - (v - spec.lo) / (spec.hi - spec.lo)) * phh;
  const cur = Math.floor(x);
  // phase slots
  for (let k = 0; k < 5; k++) {
    ctx.fillStyle = hexA(PH[k], k === cur ? 0.1 : 0.035);
    ctx.fillRect(X(k) + 1, pt, pw / 5 - 2, phh);
    ctx.fillStyle = hexA(PH[k], k === cur ? 1 : 0.7);
    ctx.font = `${k === cur ? 700 : 600} 10px Inter, system-ui, sans-serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
    ctx.fillText(String(k + 1), X(k + 0.5), h - 4);
  }
  ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
  ctx.font = '500 9.5px Inter, system-ui, sans-serif';
  for (const v of spec.ticks) {
    const y = Math.round(Y(v)) + 0.5;
    ctx.strokeStyle = 'rgba(214,228,226,0.07)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(pl, y); ctx.lineTo(w - pr, y); ctx.stroke();
    ctx.fillStyle = rgba(MUTED, 0.8);
    ctx.fillText(v.toFixed(spec.d === 2 ? 1 : 0), pl - 5, y);
  }
  const m = st.m;
  const alphaMain = soft ? 1 : m;
  const val = k => soft ? lerp(soft[k][0], broad[k][0], m) : broad[k][0];
  const elo = k => soft ? lerp(soft[k][1], broad[k][1], m) : broad[k][1];
  const ehi = k => soft ? lerp(soft[k][2], broad[k][2], m) : broad[k][2];
  // the tied band
  if (extra && extra.band && m > 0.01) {
    ctx.fillStyle = `rgba(159,182,255,${0.22 * m})`;
    const b = extra.band;
    ctx.fillRect(pl, Y(b[0] + b[2]), pw, Math.max(1.5, Y(b[0] - b[1]) - Y(b[0] + b[2])));
  }
  // hollow markers: each AstroSat phase fitted on its own
  if (extra && extra.free && m > 0.01) {
    for (let k = 0; k < 5; k++) {
      const e = extra.free[k], xx = X(k + 0.5) + 7;
      ctx.strokeStyle = `rgba(200,210,230,${0.55 * m})`; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(xx, Y(e[0] - e[1])); ctx.lineTo(xx, Y(e[0] + e[2])); ctx.stroke();
      ctx.fillStyle = PANEL;
      ctx.beginPath(); ctx.arc(xx, Y(e[0]), 2.8, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    }
  }
  ctx.globalAlpha = alphaMain;
  // interpolation curve through the five values (cyclic)
  ctx.setLineDash([3, 3]); ctx.strokeStyle = rgba(INK, 0.35); ctx.lineWidth = 1;
  ctx.beginPath();
  const vals = [0, 1, 2, 3, 4].map(val);
  for (let s = 0; s <= 100; s++) {
    const xx = s / 20, v = interp5(vals, xx);
    s ? ctx.lineTo(X(xx), Y(v)) : ctx.moveTo(X(xx), Y(v));
  }
  ctx.stroke(); ctx.setLineDash([]);
  // points with 90% error bars
  for (let k = 0; k < 5; k++) {
    const xx = X(k + 0.5), v = val(k);
    const top = Math.max(pt, Y(v + ehi(k))), bot = Math.min(pt + phh, Y(v - elo(k)));
    ctx.strokeStyle = hexA(PH[k], 0.9); ctx.lineWidth = 1.4;
    ctx.beginPath(); ctx.moveTo(xx, top); ctx.lineTo(xx, bot);
    ctx.moveTo(xx - 3, top); ctx.lineTo(xx + 3, top); ctx.moveTo(xx - 3, bot); ctx.lineTo(xx + 3, bot); ctx.stroke();
    ctx.fillStyle = PH[k];
    ctx.beginPath(); ctx.arc(xx, Y(v), k === cur ? 4.2 : 3.2, 0, Math.PI * 2); ctx.fill();
    if (k === cur) { ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.2; ctx.beginPath(); ctx.arc(xx, Y(v), 6.5, 0, Math.PI * 2); ctx.stroke(); }
  }
  // cursor: where the scene is right now
  const cx = X(x), cvv = interp5(vals, x);
  ctx.strokeStyle = 'rgba(255,255,255,0.28)'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(Math.round(cx) + 0.5, pt); ctx.lineTo(Math.round(cx) + 0.5, pt + phh); ctx.stroke();
  const gl = ctx.createRadialGradient(cx, Y(cvv), 0, cx, Y(cvv), 9);
  gl.addColorStop(0, 'rgba(255,255,255,0.95)'); gl.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = gl; ctx.beginPath(); ctx.arc(cx, Y(cvv), 9, 0, Math.PI * 2); ctx.fill();
  ctx.globalAlpha = 1;
  if (!soft && m < 0.99) {
    ctx.fillStyle = `rgba(8,12,14,${0.75 * (1 - m)})`; ctx.fillRect(pl, pt, pw, phh);
    ctx.fillStyle = `rgba(200,208,207,${1 - m})`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.font = '600 11.5px Inter, system-ui, sans-serif';
    ctx.fillText("Swift's 1–10 keV can't pin this down", pl + pw / 2, pt + phh / 2);
  }
}

// ------------------------------------------------------- text that changes
function captionFor(p, mode) {
  const X = D.xrt, J = D.joint, k = p - 1;
  const T = X.Tin[k][0].toFixed(2), R = X.Rin[k][0].toFixed(1);
  const Rb = J.Rin[k][0].toFixed(1), K = J.kTe[k][0].toFixed(1);
  const head = `<span class="c-ph" style="color:${PH[k]}">Phase ${p}</span>, ${PH_NAME[k]}.`;
  if (mode === 'soft') {
    return head + ' ' + [
      `<span class="c-soft">Swift alone</span> puts the inner disc at ${T} keV, with an apparent radius of ${R} km.`,
      `In the <span class="c-soft">Swift fit</span> the disc cools to ${T} keV and its apparent radius spreads to ${R} km.`,
      `This is the coolest and widest the <span class="c-soft">Swift fits</span> get, ${T} keV and ${R} km.`,
      `The <span class="c-soft">Swift fit</span> jumps to ${T} keV and pulls the apparent radius in to ${R} km, so the disc looks like it heated up by a quarter in one step.`,
      `Still hot in the <span class="c-soft">Swift fit</span> at ${T} keV, with the smallest apparent radius, ${R} km.`
    ][k];
  }
  const e = J.kTe[4];
  return head + ' ' + [
    `<span class="c-hard">With AstroSat</span> the disc sits at ${J.Tin[0].toFixed(3)} keV, same as in every phase, and the corona is at its coolest, ${K} keV.`,
    `Same disc temperature. The corona's electrons are up to ${K} keV and the disc's apparent radius has grown to ${Rb} km.`,
    `The corona keeps warming, ${K} keV now, and the apparent radius is ${Rb} km. The disc temperature hasn't moved.`,
    `The apparent radius tops out at ${Rb} km and the corona is at ${K} keV. Still one disc temperature.`,
    `The apparent radius falls back to ${Rb} km while the corona reaches ${K} keV, though its error bar runs from ${(e[0] - e[1]).toFixed(1)} to ${(e[0] + e[2]).toFixed(1)} keV.`
  ][k];
}
function updateText(p) {
  const key = p + st.mode;
  if (key === st.captionKey) return;
  st.captionKey = key;
  ui.caption.innerHTML = captionFor(p, st.mode);
  ui.pillText.textContent = `Phase ${p} · ${p <= 3 ? 'rising' : 'falling'}`;
  ui.pillDot.style.background = PH[p - 1];
  ui.pillDot.style.color = PH[p - 1];
  const k = p - 1, X = D.xrt, J = D.joint;
  const broad = st.mode === 'broad';
  ui.nowT.innerHTML = broad ? `${valHTML(J.Tin)}, every phase` : `phase ${p}: ${valHTML(X.Tin[k])}`;
  ui.nowR.innerHTML = `phase ${p}: ${valHTML(broad ? J.Rin[k] : X.Rin[k])}`;
  ui.nowK.innerHTML = broad ? `phase ${p}: ${valHTML(J.kTe[k])}` : 'not measured';
  ui.roT.classList.toggle('is-locked', broad);
}
function updateNotes() {
  const J = D.joint;
  if (st.mode === 'broad') {
    ui.noteT.innerHTML = `<b>One temperature for all five phases</b> (Table 3). It costs Δχ² = +${J.dchi2_tieT} for ${J.ddof_tieT} extra constraints. Hollow dots: each AstroSat phase fitted alone (Table 2).`;
    ui.noteR.innerHTML = `Tied-temperature fit (Table 3). Holding this fixed too costs Δχ² = +${J.dchi2_tieTnorm}, which is <b>rejected</b>.`;
    ui.noteK.innerHTML = `Tied-temperature fit (Table 3). The error bars get wide after the peak.`;
    ui.corSub.textContent = 'glow = fitted strength, colour = electron temperature';
    ui.tagCor.classList.remove('is-dim');
  } else {
    ui.noteT.innerHTML = `Swift XRT fits, one per phase (Table 2). Watch the dots jump between phases 3 and 4.`;
    ui.noteR.innerHTML = `Swift XRT fits (Table 2). A fit quantity, set by distance, viewing angle and a colour correction.`;
    ui.noteK.innerHTML = `The paper says the 1–10 keV band leaves the corona unconstrained.`;
    ui.corSub.textContent = 'hot gas, not pinned down by 1–10 keV';
    ui.tagCor.classList.add('is-dim');
  }
}

// ------------------------------------------------------------------ modes
let toastTimer = 0;
function setMode(mode, fromUser = true) {
  if (mode === st.mode) return;
  st.mode = mode;
  ui.modeSwitch.dataset.mode = mode;
  for (const b of ui.modeSwitch.querySelectorAll('.mode-btn')) b.setAttribute('aria-pressed', String(b.dataset.mode === mode));
  if (mode === 'broad') {
    st.everFlipped = true;
    ui.nudge.classList.remove('is-on');
    scene3d && scene3d.fireWave();
    const J = D.joint;
    ui.toast.dataset.mode = 'broad';
    ui.toast.innerHTML = `AstroSat in. One disc temperature, ${J.Tin[0].toFixed(3)} ± ${J.Tin[1].toFixed(3)} keV, fits all five phases.<small>Δχ² = +${J.dchi2_tieT} for ${J.ddof_tieT} extra constraints (Table 3). Now the corona does the pulsing.</small>`;
  } else {
    const T = D.xrt.Tin.map(e => e[0]);
    ui.toast.dataset.mode = 'soft';
    ui.toast.innerHTML = `Swift alone. The disc temperature swings from ${Math.min(...T).toFixed(2)} to ${Math.max(...T).toFixed(2)} keV.<small>1–10 keV only (Table 2)</small>`;
  }
  ui.toast.classList.add('is-on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ui.toast.classList.remove('is-on'), 3600);
  if (reduced) st.m = mode === 'broad' ? 1 : 0;
  st.captionKey = '';
  updateNotes();
  kick();
}

// ---------------------------------------------------------------- playback
function setPlaying(on) {
  st.playing = on;
  ui.play.classList.toggle('is-on', on);
  ui.play.setAttribute('aria-pressed', String(on));
  ui.play.querySelector('.btn-text').textContent = on ? 'Pause' : 'Play';
  kick();
}

let visible = true, rafId = 0, last = 0;
function kick() { if (!rafId && visible && !document.hidden) { last = performance.now(); rafId = requestAnimationFrame(frame); } }
function frame(now) {
  rafId = 0;
  const dt = Math.min(0.05, (now - last) / 1000); last = now;
  if (st.playing && !st.dragging) {
    st.t += dt * st.speed;
    if (st.t >= N - 1) st.t = 0;
  }
  const target = st.mode === 'broad' ? 1 : 0;
  st.m = reduced ? target : st.m + (target - st.m) * Math.min(1, dt * 3.2);
  if (Math.abs(st.m - target) < 0.002) st.m = target;

  const x = cycAt(st.t);
  const p = ph[clamp(Math.floor(st.t), 0, N - 1)];
  if (p !== st.lastPhase) {
    if (st.lastPhase === 5 && p === 1 && st.playing && st.mode === 'soft') {
      st.softBeats++;
      if (st.softBeats >= 1 && !st.everFlipped) ui.nudge.classList.add('is-on');
    }
    st.lastPhase = p;
  }
  const v = values(x);
  const rate = rateAt(st.t);
  if (scene3d) {
    scene3d.update({ T: v.T, R: v.R, kTe: v.kTe, norm: v.norm, m: st.m, rate: clamp((rate - 45) / 160, 0, 1) });
    scene3d.render(dt);
  }
  ui.tbarMark.style.left = `${clamp((v.T - 1.2) / 0.8, 0, 1) * 100}%`;
  drawECG();
  const X = D.xrt, J = D.joint;
  drawChart('T', x, X.Tin, X.Tin.map(() => J.Tin), { band: J.Tin, free: D.astro.Tin });
  drawChart('R', x, X.Rin, J.Rin);
  drawChart('K', x, null, J.kTe);
  updateText(p);
  if (!st.dragging) {
    ui.scrub.value = String(Math.round(st.t / (N - 1) * 1000));
    ui.scrub.style.setProperty('--p', st.t / (N - 1));
  }
  ui.scrubNow.textContent = `now at ${Math.round(st.t)} s`;
  ui.scrub.setAttribute('aria-valuetext', `${Math.round(st.t)} seconds in, phase ${p}`);
  // keep drawing while something moves: playback, the mode blend, or the 3D view
  if (visible && !document.hidden) rafId = requestAnimationFrame(frame);
}

// read-only state for the interaction harness (scripts/qa/grs-pulse_interactions.py)
window.__grsPulseDebug = () => (D ? { ...st, N, phase: ph[clamp(Math.floor(st.t), 0, N - 1)], scene: !!scene3d } : null);

function resizeAll() {
  setupCanvas(ui.ecg, cv.ecg);
  setupCanvas(ui.mini, cv.mini);
  setupCanvas(ui.cvT, cv.T); setupCanvas(ui.cvR, cv.R); setupCanvas(ui.cvK, cv.K);
  drawMini();
}

// ------------------------------------------------------------------- start
async function start() {
  try {
    const res = await fetch('/assets/data/grs-pulse.json');
    D = await res.json();
  } catch (e) {
    ui.caption.textContent = 'The light curve did not load. Reload the page to try again.';
    return;
  }
  cr = D.lc.cr; N = cr.length;
  ph = Array.from(D.lc.ph, c => +c);
  runStart = new Int32Array(N); runLen = new Int32Array(N);
  for (let i = 0; i < N;) {
    let j = i; while (j < N && ph[j] === ph[i]) j++;
    for (let q = i; q < j; q++) { runStart[q] = i; runLen[q] = j - i; }
    i = j;
  }
  ui.scrubEnd.textContent = `${N - 1} s`;

  resizeAll();
  new ResizeObserver(() => { resizeAll(); kick(); }).observe(ui.toy);
  updateNotes();

  // controls
  // once the visitor has pressed Play/Pause or moved the timeline, the page never starts playback
  // on its own again, or the scroll-in autoplay undoes a Pause made before the toy was on screen
  let autoStarted = false;
  const userPlay = (on) => { autoStarted = true; st.dragging = false; setPlaying(on); };
  for (const b of ui.modeSwitch.querySelectorAll('.mode-btn')) b.addEventListener('click', () => setMode(b.dataset.mode));
  ui.play.addEventListener('click', () => userPlay(!st.playing));
  for (const b of document.querySelectorAll('[data-speed]')) {
    b.addEventListener('click', () => {
      st.speed = +b.dataset.speed;
      for (const o of document.querySelectorAll('[data-speed]')) o.setAttribute('aria-pressed', String(o === b));
    });
  }
  const scrubTo = () => { st.t = +ui.scrub.value / 1000 * (N - 1); ui.scrub.style.setProperty('--p', +ui.scrub.value / 1000); kick(); };
  ui.scrub.addEventListener('input', () => { autoStarted = true; if (st.playing) setPlaying(false); scrubTo(); });
  ui.scrub.addEventListener('pointerdown', () => { st.dragging = true; autoStarted = true; });
  // any way a drag can end releases the playhead, or playback stays frozen after Play
  const endDrag = () => { st.dragging = false; };
  window.addEventListener('pointerup', endDrag);
  window.addEventListener('pointercancel', endDrag);
  ui.scrub.addEventListener('change', endDrag);
  ui.scrub.addEventListener('blur', endDrag);
  ui.toy.addEventListener('keydown', e => {
    if (e.key === ' ' && !(e.target instanceof HTMLButtonElement) && !(e.target instanceof HTMLInputElement)) { e.preventDefault(); userPlay(!st.playing); }
  });

  // pause when the toy is off screen or the tab is hidden
  new IntersectionObserver(entries => {
    visible = entries[0].isIntersecting;
    if (visible) {
      if (!autoStarted && !reduced) { autoStarted = true; setPlaying(true); }
      kick();
    }
  }, { threshold: 0.12 }).observe(ui.toy);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) kick(); });

  if (location.hash === '#add-astrosat') setMode('broad');
  kick();

  // the 3D view loads last, so the trace and the charts work even if it fails
  try {
    const mod = await import('./grs-pulse-3d.js');
    scene3d = mod.createScene(ui.host, {
      bh: $('tag-bh'), disc: $('tag-disc'), glow: $('tag-glow'), corona: $('tag-corona')
    }, { reducedMotion: reduced, onInteract: () => ui.hint.classList.add('is-gone') });
    if (!scene3d) throw new Error('webgl');
    kick();
  } catch (e) {
    ui.fallback.hidden = false;
    $('scene-labels').hidden = true;
    ui.fallbackText.textContent = "The 3D view needs WebGL, and this browser didn't give it. The trace, the charts and the text below still follow the fits.";
  }
}
start();
