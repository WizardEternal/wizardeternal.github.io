// /play/gain-shift/ main thread: controls, worker traffic, the 2D panels.
// The heavy lifting is in gain-shift-worker.js; the 3D views are in gain-shift-3d.js.
import { GS_DATA } from "./gain-shift-data.js";
import { createCore, drawPrior, mulberry32, EXPOSURES } from "./gain-shift-core.js";

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const core = createCore(GS_DATA);
const DEFAULT_SRC = [0.25, 2.0, Math.log(2.5e-3), 1.0, Math.log(0.12)];
const PAPER = { medium: 0.018, bright: 0.019 };   // arXiv:2606.17098 §7.1, network at 3%
const CAT_N = 1000;   // sources per catalogue: enough that the weighted mean sits well clear of zero on every run
const state = { src: DEFAULT_SRC.slice(), level: "bright", gain: 0, line: 0, marg: false, seed: 162, noise: true };

// ---------------- formatting ----------------
const fmt = (x, d = 3) => (Number.isFinite(x) ? x.toFixed(d) : "…");
const sgn = (x, d = 3) => (Number.isFinite(x) ? (x >= 0 ? "+" : "−") + Math.abs(x).toFixed(d) : "…");
const minus = (s) => String(s).replace(/-/g, "−");
const pfmt = (p) => (p < 0.001 ? "p < 0.001" : "p = " + (p < 0.01 ? p.toFixed(3) : p.toFixed(2)));

// ---------------- worker ----------------
let worker = null, reqId = 0, lastFast = null, lastChecks = null, lastMarg = null, lastLand = null;
function startWorker() {
  worker = new Worker(new URL("./gain-shift-worker.js", import.meta.url), { type: "module" });
  worker.onmessage = onWorker;
  worker.onerror = (e) => { console.error("gain-shift worker:", e.message || e); };
}
function request() {
  reqId++;
  worker.postMessage({ type: "update", id: reqId, state: { ...state, src: state.src.slice() } });
  $("#checks").classList.add("is-busy");
}

// ---------------- 3D views (optional) ----------------
let views = null;
async function loadViews() {
  try {
    if (location.hash === "#no3d") throw new Error("3D switched off with #no3d");
    const mod = await import("./gain-shift-3d.js");
    views = mod.createViews({ landStage: $("#land-stage"), cloudStage: $("#cloud-stage"), reduceMotion });
    if (lastLand) views.surface(lastLand);
    if (lastFast) views.update(lastFast, lastMarg && state.marg ? lastMarg : null);
    for (const el of $$(".gs-hint")) {
      const hide = () => el.classList.add("is-gone");
      el.parentElement.addEventListener("pointerdown", hide, { once: true });
      setTimeout(hide, 9000);
    }
  } catch (err) {
    console.warn("3D views unavailable, drawing the flat fallback:", err && err.message);
    views = null;
    $("#land-fallback").hidden = false; $("#cloud-fallback").hidden = false;
    for (const el of $$(".gs-hint")) el.hidden = true;
    fallbackActive = true;
    if (lastFast) drawFallback();
  }
}
let fallbackActive = false;

// ---------------- canvas helpers ----------------
function fitCanvas(cv) {
  const r = cv.getBoundingClientRect(), dpr = Math.min(window.devicePixelRatio || 1, 2.5);
  const w = Math.max(1, Math.round(r.width * dpr)), h = Math.max(1, Math.round(r.height * dpr));
  if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
  const ctx = cv.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, W: r.width, H: r.height };
}
// Instrument palette (play.css, site.css), read once; it doesn't change with the theme.
// Second argument = fallback if the stylesheet is missing.
const TOK_EL = document.querySelector(".toy-gain") || document.body;
const TOK_CS = getComputedStyle(TOK_EL);
const tok = (name, fallback) => TOK_CS.getPropertyValue(name).trim() || fallback;
const alpha = (hex, a) => {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
};
const COL = {
  text: tok("--inst-text", "#ebe6dc"), muted: tok("--inst-muted", "#93a0a0"), faint: tok("--inst-faint", "#5f6c6d"),
  line: tok("--inst-line", "rgba(214,228,226,.085)"), lineS: tok("--inst-line-strong", "rgba(214,228,226,.16)"),
  fit: tok("--gs-fit", "#f2b36d"), now: tok("--gs-now", "#5fc8b9"), fail: tok("--gs-fail", "#ff6f5e"), marg: tok("--gs-marg", "#f6c177"),
  rose: tok("--inst-rose", "#ec8a70"), silver: tok("--inst-silver", "#b9c4c3"), peach: tok("--inst-peach", "#ffd9a8"),
  mint: tok("--inst-mint", "#9ff0e4"), ghost: tok("--inst-ghost", "#7f8a89"),
};
COL.truth = alpha(COL.text, 0.55);
const E_MIN = 0.5, E_MAX = 8;
const lx = (E, x0, x1) => x0 + (x1 - x0) * (Math.log(E) - Math.log(E_MIN)) / (Math.log(E_MAX) - Math.log(E_MIN));

function drawSpectrum(F) {
  const { ctx, W, H } = fitCanvas($("#spec"));
  ctx.clearRect(0, 0, W, H);
  const m = { l: 52, r: 14, t: 14, b: 26 };
  const x0 = m.l, x1 = W - m.r, y0 = H - m.b, y1 = m.t;
  const nch = F.n.length;
  const dens = (v, c) => v / (F.chanHi[c] - F.chanLo[c]);
  let ymax = 0, ymin = Infinity;
  for (let c = 0; c < nch; c++) {
    ymax = Math.max(ymax, dens(F.n[c] + Math.sqrt(F.n[c] + 1), c), dens(F.muTrue[c], c));
    const lo = dens(Math.max(F.muFit[c], 0.3), c); if (lo > 0) ymin = Math.min(ymin, lo);
  }
  const ly0 = Math.log10(Math.max(ymin * 0.5, 1e-3)), ly1 = Math.log10(ymax * 1.6);
  const Y = (v) => y0 - (y0 - y1) * (Math.log10(Math.max(v, 10 ** ly0)) - ly0) / (ly1 - ly0);
  // grid
  ctx.font = "11px Inter, ui-sans-serif, system-ui, sans-serif"; ctx.textBaseline = "middle";
  ctx.strokeStyle = COL.line; ctx.lineWidth = 1; ctx.fillStyle = COL.faint;
  for (let p = Math.ceil(ly0); p <= Math.floor(ly1); p++) {
    const y = Y(10 ** p); ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x1, y); ctx.stroke();
    ctx.textAlign = "right"; ctx.fillText(p === 0 ? "1" : "10" + sup(p), x0 - 7, y);
  }
  for (const e of [0.5, 1, 2, 5, 8]) {
    const x = lx(e, x0, x1); ctx.beginPath(); ctx.moveTo(x, y1); ctx.lineTo(x, y0); ctx.stroke();
  }
  ctx.save(); ctx.translate(13, (y0 + y1) / 2); ctx.rotate(-Math.PI / 2); ctx.textAlign = "center"; ctx.fillStyle = COL.muted;
  ctx.fillText("counts per keV", 0, 0); ctx.restore();
  // truth, no gain error (dashed)
  ctx.setLineDash([4, 4]); ctx.strokeStyle = COL.truth; ctx.lineWidth = 1.1; stepPath(ctx, F, F.muTrue, x0, x1, Y); ctx.stroke(); ctx.setLineDash([]);
  // fitted model (glowing step line)
  ctx.save(); ctx.shadowColor = alpha(COL.fit, 0.55); ctx.shadowBlur = 10;
  ctx.strokeStyle = COL.fit; ctx.lineWidth = 1.8; stepPath(ctx, F, F.muFit, x0, x1, Y); ctx.stroke(); ctx.restore();
  // data points
  for (let c = 0; c < nch; c++) {
    const E = Math.sqrt(F.chanLo[c] * F.chanHi[c]); if (E < E_MIN || E > E_MAX) continue;
    const x = lx(E, x0, x1), n = F.n[c];
    if (n <= 0) { ctx.strokeStyle = COL.faint; ctx.beginPath(); ctx.moveTo(x, y0 - 9); ctx.lineTo(x, y0 - 2); ctx.stroke(); continue; }
    const s = Math.sqrt(n);
    ctx.strokeStyle = alpha(COL.text, 0.45); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x, Y(dens(n + s, c))); ctx.lineTo(x, Y(dens(Math.max(n - s, 1e-9), c))); ctx.stroke();
    ctx.fillStyle = COL.text; ctx.beginPath(); ctx.arc(x, Y(dens(n, c)), 1.9, 0, 7); ctx.fill();
  }
  // legend
  ctx.textAlign = "right"; ctx.textBaseline = "top"; ctx.font = "11px Inter, ui-sans-serif, system-ui, sans-serif";
  const lg = [["fit", COL.fit, false], ["true spectrum, no gain error", COL.truth, true]];
  let ly = y1 + 2;
  for (const [t, c, d] of lg) {
    ctx.fillStyle = COL.muted; ctx.fillText(t, x1 - 28, ly);
    ctx.strokeStyle = c; ctx.lineWidth = 1.6; if (d) ctx.setLineDash([4, 3]);
    ctx.beginPath(); ctx.moveTo(x1 - 22, ly + 6); ctx.lineTo(x1, ly + 6); ctx.stroke(); ctx.setLineDash([]);
    ly += 16;
  }
}
function stepPath(ctx, F, mu, x0, x1, Y) {
  ctx.beginPath();
  let started = false;
  for (let c = 0; c < mu.length; c++) {
    const a = Math.max(F.chanLo[c], E_MIN), b = Math.min(F.chanHi[c], E_MAX); if (b <= a) continue;
    const y = Y(mu[c] / (F.chanHi[c] - F.chanLo[c]));
    if (!started) { ctx.moveTo(lx(a, x0, x1), y); started = true; } else ctx.lineTo(lx(a, x0, x1), y);
    ctx.lineTo(lx(b, x0, x1), y);
  }
}
const SUP = { "-": "⁻", 0: "⁰", 1: "¹", 2: "²", 3: "³", 4: "⁴", 5: "⁵", 6: "⁶", 7: "⁷", 8: "⁸", 9: "⁹" };
const sup = (p) => String(p).split("").map((ch) => SUP[ch] || ch).join("");

function drawResid(F) {
  const { ctx, W, H } = fitCanvas($("#resid"));
  ctx.clearRect(0, 0, W, H);
  const m = { l: 52, r: 14, t: 8, b: 24 };
  const x0 = m.l, x1 = W - m.r, y0 = H - m.b, y1 = m.t;
  const R = 4, Y = (v) => (y0 + y1) / 2 - (y0 - y1) / 2 * Math.max(-R, Math.min(R, v)) / R;
  ctx.fillStyle = alpha(COL.now, 0.06); ctx.fillRect(x0, Y(2), x1 - x0, Y(-2) - Y(2));
  ctx.strokeStyle = COL.lineS; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(x0, Y(0)); ctx.lineTo(x1, Y(0)); ctx.stroke();
  ctx.font = "11px Inter, ui-sans-serif, system-ui, sans-serif"; ctx.fillStyle = COL.faint; ctx.textAlign = "right"; ctx.textBaseline = "middle";
  for (const v of [-4, -2, 0, 2, 4]) ctx.fillText(minus(v), x0 - 7, Y(v));
  ctx.save(); ctx.translate(13, (y0 + y1) / 2); ctx.rotate(-Math.PI / 2); ctx.textAlign = "center"; ctx.fillStyle = COL.muted;
  ctx.fillText("resid. σ", 0, 0); ctx.restore();
  for (let c = 0; c < F.n.length; c++) {
    const a = Math.max(F.chanLo[c], E_MIN), b = Math.min(F.chanHi[c], E_MAX); if (b <= a) continue;
    const m0 = Math.max(F.muFit[c], 1e-6), r = (F.n[c] - m0) / Math.sqrt(m0);
    const xa = lx(a, x0, x1) + 0.6, xb = lx(b, x0, x1) - 0.6;
    const big = Math.abs(r) > 3;
    ctx.fillStyle = big ? alpha(COL.fail, 0.9) : (r >= 0 ? alpha(COL.now, 0.55) : alpha(COL.muted, 0.45));
    ctx.fillRect(xa, Math.min(Y(0), Y(r)), Math.max(xb - xa, 1), Math.abs(Y(r) - Y(0)));
  }
  // noise-free residual: what the gain (or line) leaves behind with no Poisson scatter at all
  ctx.save(); ctx.shadowColor = alpha(COL.fit, 0.6); ctx.shadowBlur = 6;
  ctx.strokeStyle = COL.fit; ctx.lineWidth = 1.4; ctx.beginPath();
  let st = false;
  for (let c = 0; c < F.n.length; c++) {
    const E = Math.sqrt(F.chanLo[c] * F.chanHi[c]); if (E < E_MIN || E > E_MAX) continue;
    const m0 = Math.max(F.muFit[c], 1e-6), r = (F.muData[c] - m0) / Math.sqrt(m0);
    const x = lx(E, x0, x1), y = Y(r); if (!st) { ctx.moveTo(x, y); st = true; } else ctx.lineTo(x, y);
  }
  ctx.stroke(); ctx.restore();
  ctx.fillStyle = COL.faint; ctx.textAlign = "center"; ctx.textBaseline = "top";
  for (const e of [0.5, 1, 2, 5]) ctx.fillText(String(e), lx(e, x0, x1), y0 + 6);
  ctx.textAlign = "right"; ctx.fillStyle = COL.muted; ctx.fillText("8 keV", x1, y0 + 6);
  ctx.textAlign = "left"; ctx.textBaseline = "top"; ctx.fillStyle = COL.fit; ctx.font = "10.5px Inter, ui-sans-serif, system-ui, sans-serif";
  ctx.fillText("line: true spectrum minus fit, no noise", x0 + 6, y1 + 1);
}

// ---------------- checks ----------------
const LIGHTS = ["ppc", "ess", "ev"];
const stateOf = (p) => (p < 0.01 ? "fail" : p < 0.05 ? "warn" : "pass");
function setLight(key, st) {
  const li = $(`.gs-light[data-light="${key}"]`); li.dataset.state = st;
  const mini = $(`.mini-light[data-light="${key}"]`); if (mini) mini.dataset.state = st;
}
function applyChecks(C) {
  lastChecks = C;
  if (lastFast && !lastFast.noise) {
    for (const k of LIGHTS) setLight(k, "off");
    const msg = "needs photon noise";
    $("#v-ppc").textContent = msg; $("#v-ess").textContent = msg; $("#v-ev").textContent = msg;
    $("#checks-foot").textContent = "With photon noise off there's no scatter to judge a fit against, so all three checks sit this one out. Turn noise back on.";
    $("#checks").classList.remove("is-busy");
    writeCaption();
    return;
  }
  setLight("ppc", stateOf(C.ppc.p));
  $("#v-ppc").textContent = pfmt(C.ppc.p);
  setLight("ev", stateOf(C.ev.p));
  $("#v-ev").textContent = `${minus(sgn(C.ev.nats, 1))} nats against a clean spectrum, ${pfmt(C.ev.p)}`;
  if (C.ess.ready) {
    setLight("ess", stateOf(C.ess.p));
    $("#v-ess").textContent = `${Math.round(C.ess.frac * 100)}% of draws effective (clean: ${Math.round(C.ess.nullMedian * 100)}%), ${pfmt(C.ess.p)}`;
  } else {
    setLight("ess", "wait");
    $("#v-ess").textContent = `${Math.round(C.ess.frac * 100)}% of draws effective, calibrating on clean spectra`;
  }
  $("#checks").classList.remove("is-busy");
  writeCaption();
}
// ---------------- live caption and the how-to steps ----------------
// Each step's prompt names whatever is currently in the way of finishing it, so the list can't
// sit on a step the visitor has seemingly done (gain at 3% with the line still on, say).
const STEPS = {
  1: (st) => (!st.noise && st.line > 0 ? "turn photon noise back on and put the iron line back to none, then drag the gain error to 3%."
    : !st.noise ? "turn photon noise back on, then drag the gain error to 3%."
      : st.line > 0 ? "put the iron line back to none, then drag the gain error to 3%."
        : "drag the gain error to 3% (the slider at the top)."),
  2: "set the iron line to strong.",
  3: (st) => (st.line > 0 ? "put the iron line back to none." : "switch on “Marginalise over gain”."),
  4: (st) => (st.gain < 2.5 ? "set the gain error back to 3%, then press “Fit 1,000 sources” at the bottom of the bench."
    : "press “Fit 1,000 sources” at the bottom of the bench."),
};
const done = new Set();
// results are only read together when they come from the same worker request
const checksNow = () => (lastFast && lastChecks && lastChecks.id === lastFast.id ? lastChecks : null);
const margNow = () => (lastFast && lastMarg && lastMarg.id === lastFast.id ? lastMarg : null);
function markSteps() {
  const F = lastFast, C = checksNow();
  if (F && C && F.noise && state.gain >= 2.5 && state.line === 0) done.add(1);
  if (C && state.line >= 3e-4 && done.has(1)) done.add(2);
  if (state.marg && margNow() && state.line === 0 && done.has(2)) done.add(3);
  if (cat && !cat.running && cat.items.length >= cat.N && cat.gain >= 2.5) done.add(4);
  let cur = 0; for (let k = 1; k <= 4; k++) if (!done.has(k)) { cur = k; break; }
  for (const li of $$("#howto li")) {
    const k = Number(li.dataset.step);
    li.classList.toggle("is-done", done.has(k));
    li.classList.toggle("is-current", k === cur);
    if (k === cur) li.setAttribute("aria-current", "step"); else li.removeAttribute("aria-current");
  }
  const cueFor = {
    1: [...(!state.noise ? ['[data-noise="1"]'] : []), ...(state.line > 0 ? ['[data-line="0"]'] : []), ...(state.noise && state.line === 0 ? ["#gain"] : [])],
    2: ['[data-line="3e-4"]'], 3: state.line > 0 ? ['[data-line="0"]'] : ["#marg"],
    4: state.gain < 2.5 ? ["#gain"] : ["#btn-cat"],
  };
  $$(".gs-cue").forEach((el) => el.classList.remove("gs-cue"));
  if (cur) for (const sel of cueFor[cur]) { const el = $(sel); if (el) el.classList.add("gs-cue"); }
  const txt = cur ? (typeof STEPS[cur] === "function" ? STEPS[cur](state) : STEPS[cur]) : "";
  $("#next").innerHTML = cur ? `<span class="gs-step">Step ${cur}</span> Next, ${txt}`
    : `<span class="gs-step">Done</span> Try a new source, or the ~1,000 photon setting, where the scatter is about three times bigger and the lean is the same.`;
}
function writeCaption() {
  // checks and the marginalised fit only count when they belong to the fit on screen; results from an
  // earlier request (the line was off then, say) must not be described as this fit's verdict
  const F = lastFast, C = checksNow(), M = margNow(); if (!F) return;
  const g = state.gain.toFixed(1), G = F.fit.th[1], G0 = F.fit0.th[1], T = F.truth[1], sd = F.fit.sd[1];
  const drift = G - G0;
  let states = null, fails = 0;
  if (C) { states = [stateOf(C.ppc.p), C.ess.ready ? stateOf(C.ess.p) : "wait", stateOf(C.ev.p)]; fails = states.filter((x) => x === "fail").length; }
  const allPass = states && states.every((x) => x === "pass");
  const waiting = states && states.includes("wait");
  const checks = !C ? "the checks are still running" : allPass ? "all three checks pass"
    : fails ? `${fails} of 3 checks ${fails === 1 ? "goes" : "go"} red`
    : waiting ? (states.filter((x) => x === "pass").length === 2 ? "the replay and evidence tests pass (the reweighting test is still calibrating)" : "the checks are still running")
    : "no check goes red, though one is amber";
  let t;
  if (!F.noise) {
    t = `Photon noise is off, so the data are the exact expected counts. The fit lands at Γ = <b>${fmt(G, 3)}</b>${state.gain > 0 ? `, moved <b class="v-fit">${minus(sgn(drift, 3))}</b> by the gain,` : ""} and it is only ${Math.max(F.fit.C - F.fitClean.C, 0).toFixed(2)} worse in the Cash statistic than with no gain error. There's nothing for the checks to judge without noise, so turn it back on.`;
  } else if (state.line > 0) {
    const name = state.line >= 3e-4 ? "strong" : state.line >= 8e-5 ? "medium" : "weak";
    t = fails ? `With the ${name} iron line in the data, ${checks}. No setting of the model can make a pile of counts at 6.4 keV, so the whole fit gets worse (the terrain turns red) and the checks see it. The line still drags Γ to <b class="v-fit">${fmt(G, 3)}</b> against ${fmt(T, 3)} true.`
      : (!C || waiting) ? `The ${name} iron line moves Γ to <b class="v-fit">${fmt(G, 3)}</b> against ${fmt(T, 3)} true, and ${checks}.`
      : `The ${name} iron line gets past the checks here (${checks}), and moves Γ to <b class="v-fit">${fmt(G, 3)}</b> against ${fmt(T, 3)} true. Weak lines slip through at these counts.`;
  } else if (state.gain === 0) {
    t = `No gain error. The fit lands at Γ = <b>${fmt(G, 3)} ± ${fmt(sd, 3)}</b> against ${fmt(T, 3)} true, which is just photon scatter, and ${checks}.`;
  } else {
    const worse = F.fit.C - F.fit0.C, frac = Math.abs(drift) / sd;
    t = `At a ${g}% gain error ${checks} and the residuals stay flat, but the photon index has moved from ${fmt(G0, 3)} to <b class="v-fit">${fmt(G, 3)}</b> (${minus(sgn(drift, 3))}). `;
    t += `That's ${frac < 0.095 ? "under a tenth" : "about " + Math.round(frac * 100) + "%"} of the ${fmt(sd, 3)} error bar, ${worse >= 0 ? `and the fit is only ${worse.toFixed(2)} worse in the Cash statistic` : `and with these photons the fit statistic even improves by ${(-worse).toFixed(2)}, which noise can do`}, so nothing looks wrong.`;
    if (state.gain > 5) t += " This gain is also outside the marginalisation prior.";
  }
  if (state.marg && M && state.line === 0 && F.noise) t += ` Marginalised over the gain: Γ = ${fmt(M.gammaMean, 3)} ± ${fmt(M.gammaSd, 3)}, the error bar ×${(M.gammaSd / M.fixedSd).toFixed(3)}, so the push is still there.`;
  if (cat && !cat.running && cat.items.length && state.line === 0 && F.noise) {
    const S = catStats();
    t += ` <span class="gs-climax">Across the ${S.n.toLocaleString("en-US")}-source catalogue at ${cat.gain.toFixed(1)}%, the weighted mean shift is ${minus(sgn(S.wmean))} ± ${S.wse.toFixed(3)} and ${S.pos} of ${S.n.toLocaleString("en-US")} lean the same way, so averaging over sources doesn't remove it.</span>`;
  }
  $("#caption").innerHTML = t;
  const foot = $("#checks-foot");
  if (C && F.noise) foot.textContent = allPass ? "All three pass." : fails ? `${fails} red.` : "";
  const lift = F.lift || 0;
  $("#land-note").textContent = lift > 9 ? `the whole fit is worse by ΔC = ${Math.round(lift).toLocaleString("en-US")}, so the terrain turns red; contours are 1σ steps above this fit's own best point`
    : "height is √ΔC above the best fit, so each contour is about 1σ";
  drawInset();
  markSteps();
}

// ---------------- zoomed inset on the terrain ----------------
let insetHist = [], insetKey = null;
function drawInset() {
  const F = lastFast; const cv = $("#inset"); if (!F || !cv) return;
  if (F.trailKey !== insetKey) { insetHist = []; insetKey = F.trailKey; }
  const last = insetHist[insetHist.length - 1];
  if (!last || last[0] !== F.fit.th[1] || last[1] !== F.fit.th[2]) { insetHist.push([F.fit.th[1], F.fit.th[2]]); if (insetHist.length > 120) insetHist.shift(); }
  const { ctx, W, H } = fitCanvas(cv);
  ctx.clearRect(0, 0, W, H);
  const T = F.truth, sdG = F.sdTruth[1], sdK = F.sdTruth[2];
  const p0 = [F.fit0.th[1], F.fit0.th[2]], p1 = [F.fit.th[1], F.fit.th[2]];
  const cg = (p0[0] + p1[0]) / 2, ck = (p0[1] + p1[1]) / 2;
  let hw = 0.03;
  for (const [gg, kk] of [p0, p1, ...insetHist]) hw = Math.max(hw, Math.abs(gg - cg) * 1.4, Math.abs(kk - ck) * 1.4 * sdG / sdK);
  const hk = hw * sdK / sdG, m = 8;
  const X = (gg) => W / 2 + (gg - cg) / hw * (W / 2 - m), Y = (kk) => H / 2 - (kk - ck) / hk * (H / 2 - m);
  ctx.fillStyle = "rgba(6,9,11,.8)"; ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = "rgba(214,228,226,.12)"; ctx.lineWidth = 1;
  for (let i = -2; i <= 2; i++) { const x = W / 2 + i * (W / 2 - m) / 2; ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }
  const tx = X(T[1]), ty = Y(T[2]);
  ctx.fillStyle = "#fff";
  if (tx > 3 && tx < W - 3 && ty > 3 && ty < H - 3) { ctx.fillRect(tx - 1, ty - 6, 2, 12); ctx.fillRect(tx - 6, ty - 1, 12, 2); }
  else {
    const ang = Math.atan2(ty - H / 2, tx - W / 2), ex = W / 2 + Math.cos(ang) * (W / 2 - 12), ey = H / 2 + Math.sin(ang) * (H / 2 - 12);
    ctx.beginPath(); ctx.moveTo(ex + Math.cos(ang) * 7, ey + Math.sin(ang) * 7); ctx.lineTo(ex + Math.cos(ang + 2.5) * 7, ey + Math.sin(ang + 2.5) * 7); ctx.lineTo(ex + Math.cos(ang - 2.5) * 7, ey + Math.sin(ang - 2.5) * 7); ctx.fill();
    ctx.font = "10px Inter, ui-sans-serif, system-ui, sans-serif"; ctx.textAlign = ex > W / 2 ? "right" : "left"; ctx.textBaseline = "middle";
    ctx.fillText("truth", ex + (ex > W / 2 ? -10 : 10), ey);
  }
  ctx.strokeStyle = alpha(COL.peach, 0.85); ctx.lineWidth = 1.5; ctx.beginPath();
  insetHist.forEach(([gg, kk], i) => (i ? ctx.lineTo(X(gg), Y(kk)) : ctx.moveTo(X(gg), Y(kk)))); ctx.stroke();
  ctx.strokeStyle = COL.silver; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(X(p0[0]), Y(p0[1]), 5, 0, 7); ctx.stroke();
  ctx.fillStyle = COL.fit; ctx.shadowColor = COL.fit; ctx.shadowBlur = 8; ctx.beginPath(); ctx.arc(X(p1[0]), Y(p1[1]), 4.5, 0, 7); ctx.fill(); ctx.shadowBlur = 0;
  const zoom = (F.land.g1 - F.land.g0) / (2 * hw);
  ctx.font = "600 11px Inter, ui-sans-serif, system-ui, sans-serif"; ctx.fillStyle = COL.text; ctx.textBaseline = "top"; ctx.textAlign = "left";
  ctx.fillText(`close-up ×${Math.max(1, zoom).toFixed(0)}`, 6, 5);
  ctx.font = "10.5px Inter, ui-sans-serif, system-ui, sans-serif"; ctx.fillStyle = COL.muted; ctx.textBaseline = "bottom";
  ctx.fillText(`grid lines ${(hw / 2).toFixed(3)} apart in Γ`, 6, H - 4);
}

// ---------------- readouts ----------------
function applyFast(F) {
  lastFast = F;
  const drift = F.fit.th[1] - F.fit0.th[1];
  $("#r-fit").textContent = `${fmt(F.fit.th[1], 3)} ± ${fmt(F.fit.sd[1], 3)}`;
  $("#r-true").textContent = fmt(F.truth[1], 3);
  $("#r-drift").textContent = state.gain === 0 ? "0" : minus(sgn(drift, 3));
  $("#spec-sub").textContent = `XMM-Newton EPIC-pn channels, ${Math.round(F.counts).toLocaleString("en-US")} counts in ${F.expo >= 1000 ? (F.expo / 1000).toFixed(1) + " ks" : Math.round(F.expo) + " s"}`;
  drawSpectrum(F); drawResid(F);
  if (views) views.update(F, state.marg && lastMarg ? lastMarg : null);
  else if (fallbackActive) drawFallback();
  writeCaption();
  scheduleAnnounce();
}
function applyMarg(M) {
  lastMarg = M;
  if (!state.marg) return;
  $("#gpost").hidden = false;
  $(".k-marg-item").hidden = false;
  drawGainPosterior(M);
  const ratio = M.gammaSd / M.fixedSd;
  $("#gpost-note").textContent = `90% range ${Math.round(M.widthRatio * 100)}% of the prior's. σ(Γ) ×${ratio.toFixed(3)}, Γ ${fmt(M.gammaMean, 3)}`;
  const mr = $("#r-marg");
  if (mr) { mr.hidden = false; $("#r-marg-v").textContent = `${fmt(M.gammaMean, 3)} ± ${fmt(M.gammaSd, 3)}`; $("#r-marg-x").textContent = `σ(Γ) ×${ratio.toFixed(3)}`; }
  if (views && lastFast) views.update(lastFast, M);
  else if (fallbackActive) drawFallback();
  writeCaption();
}
function drawGainPosterior(M) {
  const cv = $("#gpost-canvas"); const { ctx, W, H } = fitCanvas(cv);
  ctx.clearRect(0, 0, W, H);
  const mx = Math.max(...M.w, 1 / M.w.length * 1.6);
  const X = (g) => 4 + (W - 8) * (g - 0.95) / 0.1, Y = (w) => H - 12 - (H - 16) * w / mx;
  ctx.strokeStyle = alpha(COL.text, 0.35); ctx.setLineDash([3, 3]); ctx.beginPath();
  ctx.moveTo(X(0.95), Y(1 / M.w.length)); ctx.lineTo(X(1.05), Y(1 / M.w.length)); ctx.stroke(); ctx.setLineDash([]);
  ctx.fillStyle = alpha(COL.marg, 0.28); ctx.strokeStyle = COL.marg; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.moveTo(X(M.grid[0]), Y(0));
  M.grid.forEach((g, j) => ctx.lineTo(X(g), Y(M.w[j])));
  ctx.lineTo(X(M.grid[M.grid.length - 1]), Y(0)); ctx.closePath(); ctx.fill();
  ctx.beginPath(); M.grid.forEach((g, j) => (j ? ctx.lineTo(X(g), Y(M.w[j])) : ctx.moveTo(X(g), Y(M.w[j])))); ctx.stroke();
  const gt = 1 + state.gain / 100;
  ctx.fillStyle = "#fff";
  if (gt <= 1.05) { ctx.fillRect(X(gt) - 0.75, 2, 1.5, H - 14); }
  else { ctx.beginPath(); ctx.moveTo(W - 2, H / 2 - 5); ctx.lineTo(W - 2, H / 2 + 5); ctx.lineTo(W - 9, H / 2); ctx.fill(); }
  ctx.font = "9.5px Inter, ui-sans-serif, system-ui, sans-serif"; ctx.fillStyle = COL.faint; ctx.textBaseline = "bottom";
  ctx.textAlign = "left"; ctx.fillText("0.95", 2, H); ctx.textAlign = "right"; ctx.fillText("1.05", W - 2, H);
  ctx.textAlign = "center"; ctx.fillText(gt <= 1.05 ? "true gain" : "true gain: off the prior", W / 2, H);
}

// ---------------- flat fallback when WebGL is missing ----------------
function drawFallback() {
  const F = lastFast; if (!F) return;
  if (lastLand) { // landscape as a heat map
    const { ctx, W, H } = fitCanvas($("#land-2d"));
    ctx.clearRect(0, 0, W, H);
    const L = lastLand, N = L.N, m = 34;
    const cw = (W - 2 * m) / N, ch = (H - 2 * m) / N;
    for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
      const raw = L.heights[i * N + j], h = Math.max(0, Math.min(6, raw));
      const t = h / 6, line = raw > 0.5 && raw < 6 && Math.abs(raw - Math.round(raw)) < 0.06;
      ctx.fillStyle = line ? alpha(COL.mint, 0.8) : `hsl(${178 - 150 * t}, ${45 + 20 * t}%, ${8 + 34 * t}%)`;
      ctx.fillRect(m + i * cw, H - m - (j + 1) * ch, cw + 0.5, ch + 0.5);
    }
    const P = (g, k) => [m + (g - L.g0) / (L.g1 - L.g0) * (W - 2 * m), H - m - (k - L.k0) / (L.k1 - L.k0) * (H - 2 * m)];
    const [tx, ty] = P(F.truth[1], F.truth[2]); ctx.fillStyle = "#fff"; ctx.fillRect(tx - 1, ty - 7, 2, 14); ctx.fillRect(tx - 7, ty - 1, 14, 2);
    const [bx, by] = P(F.fit.th[1], F.fit.th[2]); ctx.fillStyle = COL.fit; ctx.beginPath(); ctx.arc(bx, by, 5, 0, 7); ctx.fill();
    ctx.fillStyle = COL.muted; ctx.font = "11px Inter, sans-serif"; ctx.textAlign = "center"; ctx.fillText("photon index Γ", W / 2, H - 10);
    ctx.save(); ctx.translate(12, H / 2); ctx.rotate(-Math.PI / 2); ctx.fillText("power-law norm", 0, 0); ctx.restore();
    ctx.textAlign = "left"; ctx.fillText("3D view needs WebGL, so this is the flat version", m, 18);
  }
  { // cloud projected on Γ and NH
    const { ctx, W, H } = fitCanvas($("#cloud-2d"));
    ctx.clearRect(0, 0, W, H);
    const [bG, , bN] = F.cloudBox, m = 34;
    const P = (g, nh) => [m + (g - bG[0]) / (bG[1] - bG[0]) * (W - 2 * m), H - m - (nh - bN[0]) / (bN[1] - bN[0]) * (H - 2 * m)];
    const draw = (arr, col, r) => { ctx.fillStyle = col; for (let s = 0; s < arr.length / 3; s++) { const g = arr[3 * s], nh = arr[3 * s + 2]; if (!Number.isFinite(g)) continue; const [x, y] = P(g, nh); ctx.fillRect(x - r / 2, y - r / 2, r, r); } };
    draw(F.ghost, alpha(COL.ghost, 0.35), 2);
    draw(state.marg && lastMarg ? lastMarg.cloud : F.cloud, state.marg && lastMarg ? alpha(COL.marg, 0.5) : alpha(COL.now, 0.5), 2);
    const [tx, ty] = P(F.truth[1], F.truth[0]); ctx.fillStyle = "#fff"; ctx.fillRect(tx - 1, ty - 7, 2, 14); ctx.fillRect(tx - 7, ty - 1, 14, 2);
    ctx.fillStyle = COL.muted; ctx.font = "11px Inter, sans-serif"; ctx.textAlign = "center"; ctx.fillText("photon index Γ", W / 2, H - 10);
    ctx.save(); ctx.translate(12, H / 2); ctx.rotate(-Math.PI / 2); ctx.fillText("absorbing column NH", 0, 0); ctx.restore();
  }
}

// ---------------- catalogue ----------------
let cat = null, catSeq = 0;
function startCatalog() {
  if (cat && cat.running) {
    worker.postMessage({ type: "catalogStop" }); cat.running = false; updateCatButton();
    drawCatalog(); writeCatStats(); writeCaption();
    return;
  }
  cat = { id: ++catSeq, items: [], N: CAT_N, gain: state.gain, level: state.level, running: true };
  worker.postMessage({ type: "catalog", catId: cat.id, N: cat.N, gain: cat.gain, level: cat.level, seed: 1 + Math.floor(Math.random() * 1e6) });
  updateCatButton(); drawCatalog();
}
function updateCatButton() {
  const b = $("#btn-cat");
  if (cat && cat.running) { b.textContent = `Stop (${cat.items.length} of ${cat.N})`; b.setAttribute("aria-busy", "true"); }
  else { b.textContent = `Fit ${CAT_N.toLocaleString("en-US")} sources at ${state.gain.toFixed(1)}%`; b.removeAttribute("aria-busy"); }
}
function catStats() {
  const d = cat.items.map((x) => x.dG), a = cat.items.map((x) => x.dGasimov);
  const n = d.length, mean = d.reduce((s, x) => s + x, 0) / n;
  const sd = Math.sqrt(d.reduce((s, x) => s + (x - mean) ** 2, 0) / Math.max(n - 1, 1));
  const med = d.slice().sort((x, y) => x - y)[n >> 1];
  const pos = a.filter((x) => x > 0).length, big = d.filter((x) => Math.abs(x) > 0.1).length;
  const f0 = cat.items.filter((x) => x.flag0).length, f1 = cat.items.filter((x) => x.flag1).length;
  const cts = cat.items.map((x) => x.counts).sort((x, y) => x - y)[n >> 1];
  // precision-weighted mean: each source weighted by 1/σ² of its clean-fit Γ, so the sources whose
  // Γ is barely pinned down (the blackbody outshines the power law) count for little; the error
  // is the empirical one from the scatter of the shifts, not the fit errors
  const w = cat.items.map((x) => 1 / Math.max(x.sd0 || x.sd || 1, 0.01) ** 2), W = w.reduce((s, x) => s + x, 0);
  const wmean = d.reduce((s, x, i) => s + w[i] * x, 0) / W;
  const wse = Math.sqrt(d.reduce((s, x, i) => s + w[i] * w[i] * (x - wmean) ** 2, 0)) / W * Math.sqrt(n / Math.max(n - 1, 1));
  return { n, mean, se: sd / Math.sqrt(n), med, pos, big, f0, f1, cts, wmean, wse };
}
function drawCatalog() {
  const { ctx, W, H } = fitCanvas($("#cat"));
  ctx.clearRect(0, 0, W, H);
  const FONT = "11px Inter, ui-sans-serif, system-ui, sans-serif";
  const has = !!(cat && cat.items.length), paperOn = !!cat && Math.abs(cat.gain - 3) < 0.05;
  ctx.font = FONT; ctx.textBaseline = "top";
  // Header above the plot: the axis title and the edge note (one row if they fit, else two), then a
  // legend row (wrapping) that names each marker line by a swatch in the line's own colour and dash.
  // Lines are drawn unlabelled inside the plot, so no text ever sits on the bars or on another label.
  const lh = 16, pad = 14, TITLE = "shift in fitted Γ", NOTE = "bars at the edges collect shifts beyond ±0.12";
  const legend = [
    { label: "toy, weighted mean", col: COL.fit, ink: COL.fit, lw: 2, dash: [], glow: true },
    { label: "plain mean", col: alpha(COL.fit, 0.7), ink: alpha(COL.fit, 0.8), lw: 1, dash: [2, 3] },
    ...(paperOn ? [{ label: "paper's network (mean)", col: COL.rose, ink: COL.rose, lw: 1.4, dash: [4, 4] }] : []),
  ];
  const oneRow = ctx.measureText(TITLE).width + 16 + ctx.measureText(NOTE).width <= W - 2 * pad;
  let ty = 2;
  ctx.textAlign = "left"; ctx.fillStyle = COL.muted; ctx.fillText(TITLE, pad, ty);
  if (oneRow) { if (has) { ctx.textAlign = "right"; ctx.fillStyle = COL.faint; ctx.fillText(NOTE, W - pad, ty); } }
  else { ty += lh; if (has) { ctx.fillStyle = COL.faint; ctx.fillText(NOTE, pad, ty); } }
  ty += lh + 4;
  if (has) {
    ctx.textAlign = "left";
    let lx = pad;
    for (const it of legend) {
      const iw = 22 + ctx.measureText(it.label).width;
      if (lx > pad && lx + iw > W - pad) { lx = pad; ty += lh; }
      ctx.save(); ctx.strokeStyle = it.col; ctx.lineWidth = Math.max(it.lw, 1.5); ctx.setLineDash(it.dash);
      if (it.glow) { ctx.shadowColor = COL.fit; ctx.shadowBlur = 6; }
      ctx.beginPath(); ctx.moveTo(lx, ty + 6.5); ctx.lineTo(lx + 16, ty + 6.5); ctx.stroke(); ctx.restore();
      ctx.fillStyle = it.ink; ctx.fillText(it.label, lx + 22, ty);
      lx += iw + 14;
    }
  }
  const m = { l: 14, r: 14, t: ty + lh + 6, b: 26 };
  const x0 = m.l, x1 = W - m.r, y0 = H - m.b, y1 = m.t;
  const R = 0.12, NB = 48;
  const X = (v) => x0 + (x1 - x0) * (Math.max(-R, Math.min(R, v)) + R) / (2 * R);
  ctx.font = FONT; ctx.textAlign = "center"; ctx.textBaseline = "top";
  ctx.strokeStyle = COL.line; ctx.fillStyle = COL.faint;
  for (let v = -0.1; v <= 0.1001; v += 0.05) { const x = X(v); ctx.beginPath(); ctx.moveTo(x, y1); ctx.lineTo(x, y0); ctx.stroke(); ctx.fillText(minus(v === 0 ? "0" : (v > 0 ? "+" : "") + v.toFixed(2)), x, y0 + 6); }
  if (!has) {
    ctx.fillStyle = COL.faint; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText("nothing fitted yet", (x0 + x1) / 2, (y0 + y1) / 2); return;
  }
  const bins = new Array(NB).fill(0);
  for (const it of cat.items) { const k = Math.min(NB - 1, Math.max(0, Math.floor((it.dG + R) / (2 * R) * NB))); bins[k]++; }
  const mx = Math.max(...bins, 4);
  const bw = (x1 - x0) / NB;
  for (let k = 0; k < NB; k++) {
    if (!bins[k]) continue;
    const h = (y0 - y1 - 6) * bins[k] / mx;
    const g = ctx.createLinearGradient(0, y0 - h, 0, y0);
    g.addColorStop(0, alpha(COL.now, 0.95)); g.addColorStop(1, alpha(COL.now, 0.25));
    ctx.fillStyle = g; ctx.fillRect(x0 + k * bw + 1, y0 - h, bw - 2, h);
  }
  ctx.strokeStyle = "rgba(255,255,255,.7)"; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(X(0), y1); ctx.lineTo(X(0), y0); ctx.stroke();
  const S = catStats();
  ctx.save(); ctx.shadowColor = COL.fit; ctx.shadowBlur = 8; ctx.strokeStyle = COL.fit; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(X(S.wmean), y1); ctx.lineTo(X(S.wmean), y0); ctx.stroke(); ctx.restore();
  ctx.strokeStyle = alpha(COL.fit, 0.7); ctx.lineWidth = 1; ctx.setLineDash([2, 3]);
  ctx.beginPath(); ctx.moveTo(X(S.mean), y1); ctx.lineTo(X(S.mean), y0); ctx.stroke(); ctx.setLineDash([]);
  const paper = PAPER[cat.level];
  if (paperOn) {
    ctx.setLineDash([4, 4]); ctx.strokeStyle = COL.rose; ctx.lineWidth = 1.4;
    ctx.beginPath(); ctx.moveTo(X(paper), y1); ctx.lineTo(X(paper), y0); ctx.stroke(); ctx.setLineDash([]);
  }
}
function writeCatStats() {
  if (!cat || !cat.items.length) return;
  const S = catStats(), done = !cat.running;
  const paper = PAPER[cat.level];
  let t = `<strong>${S.n.toLocaleString("en-US")}</strong> sources at ${cat.gain.toFixed(1)}%, median ${Math.round(S.cts).toLocaleString("en-US")} counts. Mean shift in Γ, weighting each source by how tightly it pins Γ down: <span class="v-fit">${minus(sgn(S.wmean))} ± ${S.wse.toFixed(3)}</span>. Unweighted, the mean is ${minus(sgn(S.mean))} ± ${S.se.toFixed(3)} and the median ${minus(sgn(S.med))}.`;
  if (S.big) t += ` ${S.big} of them moved by more than 0.1, mostly sources where the blackbody outshines the power law so Γ is barely pinned down, and those few swing the unweighted mean.`;
  t += ` With the noise taken out, ${S.pos} of ${S.n.toLocaleString("en-US")} move the positive way. The evidence test flags ${S.f1} with the gain error and ${S.f0} without.`;
  if (Math.abs(cat.gain - 3) < 0.05) t += ` The paper's network at 3%: a mean of ${minus(sgn(paper))} at ${cat.level === "medium" ? "~1,000" : "~10,000"} counts.`;
  if (!done) t = "Fitting… " + t;
  $("#cat-stats").innerHTML = t;
}

// ---------------- announcements ----------------
let annT = null;
function scheduleAnnounce() {
  clearTimeout(annT);
  annT = setTimeout(() => {
    const F = lastFast, C = checksNow(); if (!F) return;
    const lab = (p) => (p < 0.01 ? "red" : p < 0.05 ? "amber" : "green");
    let s = `Gain error ${state.gain.toFixed(1)} percent. Fitted photon index ${fmt(F.fit.th[1], 3)} plus or minus ${fmt(F.fit.sd[1], 3)}, true ${fmt(F.truth[1], 3)}.`;
    if (C) s += ` Replay test ${lab(C.ppc.p)}, reweighting test ${C.ess.ready ? lab(C.ess.p) : "calibrating"}, evidence test ${lab(C.ev.p)}.`;
    $("#announcer").textContent = s;
  }, 1200);
}

// ---------------- worker messages ----------------
function onWorker(e) {
  const m = e.data;
  if (m.type === "fast") { if (m.id === reqId) applyFast(m); }
  else if (m.type === "checks") { if (m.id === reqId) applyChecks(m); }
  else if (m.type === "marg") { if (m.id === reqId) applyMarg(m); }
  else if (m.type === "land") { if (m.id !== reqId) return; lastLand = m; if (views) views.surface(m); else if (fallbackActive) drawFallback(); }
  else if (m.type === "nullProgress") { if (lastChecks && lastChecks.id === reqId && !lastChecks.ess.ready) $("#v-ess").textContent = `calibrating on clean spectra, ${m.k} of ${m.of}`; }
  else if (m.type === "catItem") {
    // items still in flight from a stopped or earlier run belong to no catalogue on screen
    if (!cat || !cat.running || m.catId !== cat.id || cat.items.length >= cat.N) return;
    cat.items.push(m);
    if (cat.items.length % 5 === 0 || cat.items.length === cat.N) { drawCatalog(); writeCatStats(); updateCatButton(); }
  } else if (m.type === "catDone") { if (cat && m.catId === cat.id && cat.running) { cat.running = false; drawCatalog(); writeCatStats(); updateCatButton(); writeCaption(); } }
  else if (m.type === "error") console.error("gain-shift worker:", m.message);
}

// ---------------- controls ----------------
function bind() {
  const gain = $("#gain");
  const setGainUI = () => {
    const pct = Number(gain.value) / 10;
    state.gain = pct;
    $("#gain-out").textContent = pct.toFixed(1) + "%";
    gain.setAttribute("aria-valuetext", pct.toFixed(1) + " percent gain error");
    gain.style.setProperty("--p", Number(gain.value) / 100);
    updateCatButton();
  };
  gain.addEventListener("input", () => { setGainUI(); request(); if (state.marg) { $("#gpost-note").textContent = "refitting…"; $("#r-marg-v").textContent = "refitting…"; } });
  setGainUI();
  for (const b of $$("[data-level]")) b.addEventListener("click", () => {
    state.level = b.dataset.level; $$("[data-level]").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    lastChecks = null; LIGHTS.forEach((k) => setLight(k, "wait")); request();
  });
  for (const b of $$("[data-line]")) b.addEventListener("click", () => {
    state.line = Number(b.dataset.line); $$("[data-line]").forEach((x) => x.setAttribute("aria-pressed", String(x === b))); request();
  });
  $("#marg").addEventListener("click", (ev) => {
    state.marg = !state.marg; ev.currentTarget.setAttribute("aria-checked", String(state.marg));
    if (!state.marg) { $("#gpost").hidden = true; $(".k-marg-item").hidden = true; $("#r-marg").hidden = true; lastMarg = null; if (views && lastFast) views.update(lastFast, null); if (fallbackActive) drawFallback(); }
    else { $("#gpost-note").textContent = "refitting over 21 gains…"; $("#r-marg").hidden = false; $("#r-marg-v").textContent = "refitting…"; $("#r-marg-x").textContent = ""; }
    request();
  });
  const setNoise = (on) => { state.noise = on; lastChecks = null; LIGHTS.forEach((k) => setLight(k, "wait")); $("#checks-foot").textContent = ""; $$("[data-noise]").forEach((x) => x.setAttribute("aria-pressed", String((x.dataset.noise === "1") === on))); };
  for (const b of $$("[data-noise]")) b.addEventListener("click", () => { setNoise(b.dataset.noise === "1"); request(); });
  $("#btn-noise").addEventListener("click", () => { setNoise(true); state.seed = 1000 + Math.floor(Math.random() * 1e6); request(); });
  $("#btn-source").addEventListener("click", () => {
    // draw from the paper's prior, keeping sources with a readable number of counts
    const rng = mulberry32(Math.floor(Math.random() * 2 ** 31));
    let src = null;
    for (let k = 0; k < 200; k++) {
      const s = drawPrior(rng);
      const tot = core.expected(s, 1, 0, EXPOSURES.medium).reduce((a, b) => a + b, 0);
      if (tot > 400 && tot < 2500) { src = s; break; }
    }
    state.src = src || DEFAULT_SRC.slice();
    lastChecks = null; LIGHTS.forEach((k) => setLight(k, "wait"));
    request();
  });
  $("#btn-cat").addEventListener("click", startCatalog);
  let rz = null;
  window.addEventListener("resize", () => {
    clearTimeout(rz);
    rz = setTimeout(() => { if (lastFast) { drawSpectrum(lastFast); drawResid(lastFast); if (fallbackActive) drawFallback(); } drawCatalog(); if (lastMarg && state.marg) drawGainPosterior(lastMarg); }, 80);
  });
}

// ---------------- go ----------------
// optional starting state from the address, e.g. ?gain=3&line=3e-4&noise=1&level=medium
(function fromURL() {
  const q = new URLSearchParams(location.search);
  const g = Number(q.get("gain"));
  if (Number.isFinite(g) && g > 0) { const v = Math.round(Math.min(10, g) * 10); $("#gain").value = String(v); }
  const ln = Number(q.get("line"));
  if ([2e-5, 8e-5, 3e-4].includes(ln)) { state.line = ln; $$("[data-line]").forEach((x) => x.setAttribute("aria-pressed", String(Number(x.dataset.line) === ln))); }
  if (q.get("noise") === "0") state.noise = false;
  $$("[data-noise]").forEach((x) => x.setAttribute("aria-pressed", String((x.dataset.noise === "1") === state.noise)));
  if (q.get("level") === "medium") { state.level = "medium"; $$("[data-level]").forEach((x) => x.setAttribute("aria-pressed", String(x.dataset.level === "medium"))); }
})();
// read-only state for the interaction harness (scripts/qa/gain-shift_interactions.py)
window.__gainShiftDebug = () => ({
  state: { ...state, src: state.src.slice() }, reqId,
  fastId: lastFast ? lastFast.id : null, fastGain: lastFast ? lastFast.gain : null, fastLevel: lastFast ? lastFast.level : null,
  fastNoise: lastFast ? lastFast.noise : null, fastTruth: lastFast ? Array.from(lastFast.truth) : null,
  checksId: lastChecks ? lastChecks.id : null, margId: lastMarg ? lastMarg.id : null, landId: lastLand ? lastLand.id : null,
  checks: lastChecks ? { ppc: lastChecks.ppc.p, ess: lastChecks.ess.ready ? lastChecks.ess.p : null, ev: lastChecks.ev.p } : null,
  cat: cat ? { n: cat.items.length, N: cat.N, running: cat.running, gain: cat.gain, wrongGain: cat.items.filter((x) => x.gain !== cat.gain).length } : null,
  done: [...done], views: !!views,
});
bind();
startWorker();
request();
drawCatalog();
loadViews();
