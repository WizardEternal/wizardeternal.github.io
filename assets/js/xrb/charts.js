// Small 2D canvas charts for the light curve and the power spectrum.

const FONT = '500 11px Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif';
const INK = 'rgba(226, 220, 208, 0.86)';
const MUTED = 'rgba(226, 220, 208, 0.48)';
const GRID = 'rgba(255, 255, 255, 0.06)';

// Band colours from the instrument palette (play.css, via xrb.css), read once.
// Second argument = fallback.
const TOK_CS = getComputedStyle(document.querySelector('.toy-xrb') || document.body);
const tok = (name, fallback) => TOK_CS.getPropertyValue(name).trim() || fallback;
export const COLORS = { optical: tok('--xrb-optical', '#eba862'), xray: tok('--xrb-xray', '#72d4ff'), marker: 'rgba(214, 120, 84, 0.9)' };

function setup(canvas) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = canvas._w || canvas.clientWidth, h = canvas._h || canvas.clientHeight;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return { ctx, w, h };
}

const niceTicks = (lo, hi, n = 4) => {
  const span = hi - lo;
  const step0 = span / n;
  const mag = Math.pow(10, Math.floor(Math.log10(step0)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= step0) || mag * 10;
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(+v.toFixed(10));
  return out;
};

const fmt = (v) => {
  const a = Math.abs(v);
  if (a === 0) return '0';
  if (a >= 1000) return (v / 1000).toFixed(a >= 1e4 ? 0 : 1) + 'k';
  if (a >= 10) return v.toFixed(0);
  if (a >= 1) return v.toFixed(a % 1 === 0 ? 0 : 1);
  if (a >= 0.1) return v.toFixed(2).replace(/0$/, '');
  return v.toPrecision(1);
};

// series: [{ t: Float64Array|Array, y: Float64Array|Array, color, width }]
export function drawLightCurve(canvas, { series, xRange, yRange, xLabel, cursor, legend, notes }) {
  const { ctx, w, h } = setup(canvas);
  const L = 34, R = 10, T = 10, B = 26;
  const pw = w - L - R, ph = h - T - B;
  const [x0, x1] = xRange, [y0, y1] = yRange;
  const X = (x) => L + (x - x0) / (x1 - x0) * pw;
  const Y = (y) => T + (1 - (y - y0) / (y1 - y0)) * ph;
  ctx.font = FONT;
  ctx.lineWidth = 1;
  ctx.strokeStyle = GRID;
  ctx.fillStyle = MUTED;
  ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  for (const v of niceTicks(x0, x1, Math.max(3, Math.floor(pw / 90)))) {
    ctx.beginPath(); ctx.moveTo(X(v), T); ctx.lineTo(X(v), T + ph); ctx.stroke();
    ctx.fillText(fmt(v), X(v), T + ph + 5);
  }
  ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
  for (const v of niceTicks(y0, y1, 3)) {
    ctx.beginPath(); ctx.moveTo(L, Y(v)); ctx.lineTo(L + pw, Y(v)); ctx.stroke();
    ctx.fillText(fmt(v), L - 5, Y(v));
  }
  if (xLabel) { ctx.textAlign = 'right'; ctx.textBaseline = 'bottom'; ctx.fillStyle = MUTED; ctx.fillText(xLabel, L + pw, h - 1); }
  ctx.save();
  ctx.beginPath(); ctx.rect(L, T - 2, pw, ph + 4); ctx.clip();
  if (notes) {
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    for (const n of notes) {
      ctx.fillStyle = 'rgba(226, 220, 208, 0.06)';
      ctx.fillRect(X(n.x0), T, X(n.x1) - X(n.x0), ph);
      ctx.fillStyle = MUTED;
      ctx.fillText(n.label, (X(n.x0) + X(n.x1)) / 2, T + 3);
    }
  }
  for (const s of series) {
    ctx.strokeStyle = s.color; ctx.lineWidth = s.width || 1.4; ctx.lineJoin = 'round';
    ctx.globalAlpha = s.alpha || 1;
    ctx.beginPath();
    const n = s.t.length;
    const stride = Math.max(1, Math.floor(n / (pw * 1.5)));
    let started = false;
    for (let i = 0; i < n; i += stride) {
      const px = X(s.t[i]), py = Y(s.y[i]);
      if (!started) { ctx.moveTo(px, py); started = true; } else ctx.lineTo(px, py);
    }
    ctx.stroke();
    ctx.globalAlpha = 1;
  }
  if (cursor !== undefined && cursor !== null) {
    ctx.strokeStyle = 'rgba(255,255,255,0.55)'; ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(X(cursor), T); ctx.lineTo(X(cursor), T + ph); ctx.stroke();
    ctx.setLineDash([]);
  }
  ctx.restore();
  if (legend) {
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    let lx = L + 8;
    for (const g of legend) {
      ctx.fillStyle = g.color; ctx.fillRect(lx, T + 8, 12, 2.5);
      ctx.fillStyle = INK; ctx.fillText(g.label, lx + 17, T + 9);
      lx += 26 + ctx.measureText(g.label).width;
    }
  }
}

// spec: { f: [], p: [] } in nu*P(nu); markers: [{ f, label }]
export function drawPsd(canvas, { spec, fRange, markers, note, color }) {
  const { ctx, w, h } = setup(canvas);
  const L = 40, R = 10, T = 10, B = 26;
  const pw = w - L - R, ph = h - T - B;
  ctx.font = FONT;
  const lf0 = Math.log10(fRange[0]), lf1 = Math.log10(fRange[1]);
  const X = (f) => L + (Math.log10(f) - lf0) / (lf1 - lf0) * pw;
  let pmin = Infinity, pmax = -Infinity;
  if (spec) for (const v of spec.p) if (v > 0) { pmin = Math.min(pmin, v); pmax = Math.max(pmax, v); }
  if (!isFinite(pmin)) { pmin = 1e-4; pmax = 1e-1; }
  let lp1 = Math.ceil(Math.log10(pmax) + 0.15), lp0 = Math.min(Math.floor(Math.log10(pmin)), lp1 - 2);
  lp0 = Math.max(lp0, lp1 - 4);
  const Y = (p) => T + (1 - (Math.log10(Math.max(p, 1e-12)) - lp0) / (lp1 - lp0)) * ph;
  ctx.strokeStyle = GRID; ctx.fillStyle = MUTED; ctx.lineWidth = 1;
  ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  for (let e = Math.ceil(lf0); e <= Math.floor(lf1); e++) {
    ctx.beginPath(); ctx.moveTo(X(10 ** e), T); ctx.lineTo(X(10 ** e), T + ph); ctx.stroke();
    ctx.fillText(fmt(10 ** e), X(10 ** e), T + ph + 5);
  }
  ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
  for (let e = lp0; e <= lp1; e++) {
    ctx.beginPath(); ctx.moveTo(L, Y(10 ** e)); ctx.lineTo(L + pw, Y(10 ** e)); ctx.stroke();
    ctx.fillText(fmt(10 ** e), L - 5, Y(10 ** e));
  }
  ctx.textAlign = 'right'; ctx.textBaseline = 'bottom';
  ctx.fillText('frequency (Hz)', L + pw, h - 1);
  ctx.textAlign = 'left'; ctx.fillText('ν·P(ν), rms² (log)', 4, h - 1);
  ctx.save();
  ctx.beginPath(); ctx.rect(L, T, pw, ph); ctx.clip();
  if (markers) {
    ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    markers.forEach((m, i) => {
      const x = X(m.f);
      ctx.strokeStyle = 'rgba(214, 120, 84, 0.55)'; ctx.setLineDash([2, 3]);
      ctx.beginPath(); ctx.moveTo(x, T); ctx.lineTo(x, T + ph); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = 'rgba(236, 160, 128, 0.9)';
      const tw = ctx.measureText(m.label).width;
      const tx = x + 4 + tw > L + pw ? x - 4 - tw : x + 4;
      ctx.fillText(m.label, tx, T + 3 + (i % 3) * 13);
    });
  }
  if (spec) {
    ctx.strokeStyle = color || COLORS.xray; ctx.lineWidth = 1.6; ctx.lineJoin = 'round';
    ctx.beginPath();
    spec.f.forEach((f, i) => { const x = X(f), y = Y(spec.p[i]); if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); });
    ctx.stroke();
  }
  ctx.restore();
  if (note) { ctx.fillStyle = INK; ctx.textAlign = 'right'; ctx.textBaseline = 'top'; ctx.fillText(note, L + pw - 4, T + ph - 16); }
}
