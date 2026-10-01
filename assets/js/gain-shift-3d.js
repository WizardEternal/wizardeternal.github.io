// /play/gain-shift/ 3D views: the fit landscape and the posterior cloud.
// Both are driven by the worker results that gain-shift.js passes to update().
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";

const BG = 0x070a0c;
// Series colours shared with the 2D panels and the keys, from play.css, read once.
const TOK_CS = getComputedStyle(document.querySelector(".toy-gain") || document.body);
const tok = (name, fallback) => TOK_CS.getPropertyValue(name).trim() || fallback;
const C = {
  fit: tok("--gs-fit", "#f2b36d"), now: tok("--gs-now", "#5fc8b9"), marg: tok("--gs-marg", "#f6c177"),
  silver: tok("--inst-silver", "#b9c4c3"), peach: tok("--inst-peach", "#ffd9a8"),
  mint: tok("--inst-mint", "#9ff0e4"), ghost: tok("--inst-ghost", "#7f8a89"),
};
const LABEL = "#a8b3b2", TITLE = "#c9d1cf";

// ---------------- shared scaffolding ----------------
function makeBase(stage, { fov = 38, pos, target, reduceMotion, bloom = 0.6 }) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: "high-performance" });
  if (!renderer.getContext()) throw new Error("no WebGL context");
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
  renderer.setClearColor(BG, 1);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.domElement.setAttribute("aria-hidden", "true");
  stage.prepend(renderer.domElement);
  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(BG, 9, 19);
  const camera = new THREE.PerspectiveCamera(fov, 1, 0.05, 60);
  camera.position.copy(pos);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.copy(target);
  controls.enableDamping = !reduceMotion; controls.dampingFactor = 0.075;
  controls.enablePan = false; controls.minDistance = 3.2; controls.maxDistance = 15;
  controls.maxPolarAngle = Math.PI * 0.47; controls.rotateSpeed = 0.7; controls.zoomSpeed = 0.6;
  controls.update();
  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  const bloomPass = new UnrealBloomPass(new THREE.Vector2(256, 256), bloom, 0.55, 0.78);
  composer.addPass(bloomPass);
  composer.addPass(new OutputPass());
  const v = { stage, renderer, scene, camera, controls, composer, bloomPass, dirty: true, visible: true, reduceMotion, touched: false };
  const baseOffset = pos.clone().sub(target);
  const resize = () => {
    const r = stage.getBoundingClientRect();
    const w = Math.max(2, Math.round(r.width)), h = Math.max(2, Math.round(r.height));
    renderer.setSize(w, h, false);
    renderer.domElement.style.width = "100%"; renderer.domElement.style.height = "100%";
    composer.setSize(w, h);
    camera.aspect = w / h; camera.updateProjectionMatrix();
    // narrow panels: step the camera back so the axis titles stay in frame
    if (!v.touched) { camera.position.copy(controls.target).addScaledVector(baseOffset, Math.max(1, 1.32 / camera.aspect)); controls.update(); }
    v.pxH = h * renderer.getPixelRatio(); v.cssW = w; v.cssH = h;
    v.dirty = true;
  };
  new ResizeObserver(resize).observe(stage);
  resize();
  new IntersectionObserver((es) => { for (const e of es) { v.visible = e.isIntersecting; if (v.visible) v.dirty = true; } }, { rootMargin: "80px" }).observe(stage);
  controls.addEventListener("start", () => { controls.autoRotate = false; v.touched = true; });
  controls.addEventListener("change", () => { v.dirty = true; });
  // keyboard orbit for the focused stage
  stage.addEventListener("keydown", (e) => {
    const k = e.key; if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "+", "-", "="].includes(k)) return;
    e.preventDefault(); controls.autoRotate = false; v.touched = true;
    const off = camera.position.clone().sub(controls.target), sph = new THREE.Spherical().setFromVector3(off);
    if (k === "ArrowLeft") sph.theta -= 0.12; if (k === "ArrowRight") sph.theta += 0.12;
    if (k === "ArrowUp") sph.phi = Math.max(0.15, sph.phi - 0.08); if (k === "ArrowDown") sph.phi = Math.min(controls.maxPolarAngle, sph.phi + 0.08);
    if (k === "+" || k === "=") sph.radius = Math.max(controls.minDistance, sph.radius * 0.9);
    if (k === "-") sph.radius = Math.min(controls.maxDistance, sph.radius * 1.1);
    camera.position.copy(controls.target).add(new THREE.Vector3().setFromSpherical(sph));
    controls.update(); v.dirty = true;
  });
  v.render = () => { layoutLabels(v); composer.render(); };
  return v;
}

// Labels are sized in CSS pixels (sizeAttenuation off), drawn on a dark rounded backing.

function textSprite(text, { px = 12, color = LABEL, weight = 500, anchor = "center", priority = 1 } = {}) {
  const R = 4, H = 64, c = document.createElement("canvas"), ctx = c.getContext("2d");
  const font = `${weight} ${Math.round(H * 0.56)}px Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif`;
  ctx.font = font;
  const w = Math.ceil(ctx.measureText(text).width) + 26;
  c.width = w; c.height = H;
  ctx.fillStyle = "rgba(6,9,11,.62)";
  ctx.beginPath(); ctx.roundRect(2, 6, w - 4, H - 12, 14); ctx.fill();
  ctx.font = font; ctx.fillStyle = color; ctx.textBaseline = "middle"; ctx.textAlign = "center";
  ctx.fillText(text, w / 2, H / 2 + 2);
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace; tex.minFilter = THREE.LinearFilter;
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, depthTest: false, toneMapped: false, fog: false, sizeAttenuation: false });
  const s = new THREE.Sprite(mat);
  s.userData = { px: px * 1.45, aspect: w / H, priority };
  if (anchor === "left") s.center.set(0, 0.5); else if (anchor === "right") s.center.set(1, 0.5);
  s.renderOrder = 10;

  return s;
}
// set every label's scale for the current viewport, then hide labels that overlap a
// higher-priority one (titles first, then ticks in order)
function layoutLabels(v) {
  const hpx = v.cssH || 400, k = 2 * Math.tan(THREE.MathUtils.degToRad(v.camera.fov) / 2) / hpx;
  const placed = [], list = [];
  v.scene.traverse((o) => { if (o.isSprite && o.userData.px) list.push(o); });
  list.sort((a, b) => b.userData.priority - a.userData.priority);
  const p = new THREE.Vector3();
  for (const sp of list) {
    const h = sp.userData.px * k; sp.scale.set(h * sp.userData.aspect, h, 1);
    sp.getWorldPosition(p); p.project(v.camera);
    const W = sp.userData.px * sp.userData.aspect, Hh = sp.userData.px;
    const cx = (p.x + 1) / 2 * v.cssW - sp.center.x * W + W / 2, cy = (1 - p.y) / 2 * hpx;
    const box = [cx - W / 2 + 4, cy - Hh / 2 + 4, cx + W / 2 - 4, cy + Hh / 2 - 4];
    const hit = sp.userData.priority < 5 && placed.some((q) => box[0] < q[2] && box[2] > q[0] && box[1] < q[3] && box[3] > q[1]);
    sp.visible = !hit && p.z < 1;
    if (sp.visible) placed.push(box);
  }
}
function disposeGroup(g) {
  for (const o of g.children.slice()) {
    g.remove(o);
    if (o.material) { if (o.material.map) o.material.map.dispose(); o.material.dispose(); }
    if (o.geometry) o.geometry.dispose();
  }
}
function niceTicks(a, b, n = 4) {
  const span = b - a, raw = span / n, p = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * p).find((s) => span / s <= n + 0.5) || 10 * p;
  const out = [];
  for (let v = Math.ceil(a / step) * step; v <= b + 1e-9; v += step) out.push(+v.toFixed(10));
  const dec = Math.max(0, -Math.floor(Math.log10(step) + 1e-9) + (step / p === 2.5 ? 1 : 0));
  return { ticks: out, dec };
}
function glowTexture() {
  const c = document.createElement("canvas"); c.width = c.height = 128;
  const g = c.getContext("2d"), grd = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grd.addColorStop(0, "rgba(255,255,255,1)"); grd.addColorStop(0.25, "rgba(255,255,255,.45)"); grd.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grd; g.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}
const easeTo = (cur, tgt, dt, tau) => cur + (tgt - cur) * (1 - Math.exp(-dt / tau));
const minus = (s) => String(s).replace(/-/g, "−");

// ---------------- the fit landscape ----------------
function makeLandscape(stage, reduceMotion) {
  const v = makeBase(stage, { pos: new THREE.Vector3(3.9, 5.9, 6.0), target: new THREE.Vector3(0, 0.05, 0.3), reduceMotion, bloom: 0.62 });
  const { scene } = v;
  const W = 4.2, Dp = 4.2, HT = 1.75, HSC = 3.2, HCAP = 40;
  // height on screen saturates so the canyon walls stay in view; colour and contours use the true sqrt(delta C)
  const yOfH = (h) => (h >= 0 ? HT * (1 - Math.exp(-h / HSC)) : h * HT / HSC);
  let N = 0, geo = null, mesh = null, wire = null, yCur = null, hCur = null, hTgt = null, L = null;
  const mat = new THREE.ShaderMaterial({
    uniforms: { uCap: { value: 9.0 }, uLight: { value: new THREE.Vector3(0.45, 0.8, 0.35).normalize() }, uBall: { value: new THREE.Vector3(0, -9, 0) }, uLift: { value: 0 }, uFogC: { value: new THREE.Color(BG) } },
    vertexShader: `
      attribute float aH; varying vec3 vN; varying float vH; varying vec3 vW;
      void main(){ vN = normalize(mat3(modelMatrix)*normal); vH = aH; vec4 wp = modelMatrix*vec4(position,1.0); vW = wp.xyz; gl_Position = projectionMatrix*viewMatrix*wp; }`,
    fragmentShader: `
      uniform float uCap; uniform vec3 uLight; uniform vec3 uBall; uniform vec3 uFogC; uniform float uLift;
      varying vec3 vN; varying float vH; varying vec3 vW;
      vec3 ramp(float t){
        vec3 a=vec3(0.010,0.050,0.070), b=vec3(0.030,0.230,0.250), c=vec3(0.300,0.260,0.170), d=vec3(0.620,0.300,0.120);
        if(t<0.35) return mix(a,b,t/0.35); if(t<0.7) return mix(b,c,(t-0.35)/0.35); return mix(c,d,(t-0.7)/0.3);
      }
      void main(){
        float h = max(vH, 0.0);
        vec3 n = normalize(vN); if(!gl_FrontFacing) n = -n;
        float diff = max(dot(n, uLight), 0.0);
        vec3 col = ramp(clamp(h/uCap,0.0,1.0))*(0.32+0.95*diff);
        float f = abs(fract(vH+0.5)-0.5), fw = max(fwidth(vH), 1e-4);
        float line = 1.0 - smoothstep(0.0, fw*1.5, f);
        float on = step(0.5, vH)*(1.0 - smoothstep(9.5, 11.0, vH));
        vec3 lc = mix(vec3(0.35,1.0,0.88), vec3(1.0,0.70,0.40), clamp(vH/8.0,0.0,1.0));
        col += lc*line*on*(0.35 + 0.8*step(vH, 3.5));
        col += vec3(0.10,0.55,0.50)*0.35*exp(-h*h*1.6);
        col = mix(col, vec3(0.62,0.10,0.06)*(0.35+0.9*diff), clamp((uLift-3.0)/14.0, 0.0, 0.6));
        float db = distance(vW.xz, uBall.xz);
        col += vec3(1.0,0.55,0.20)*0.55*exp(-db*db/0.035);
        float fogf = smoothstep(9.0, 19.0, length(vW - cameraPosition));
        gl_FragColor = vec4(mix(col, uFogC, fogf), 1.0);
      }`,
    side: THREE.DoubleSide,
  });

  // floor and frame
  const floorY = -0.3;
  const grid = new THREE.GridHelper(W, 12, 0x2a3b3d, 0x162224); grid.position.y = floorY; scene.add(grid);
  const frame = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(W, 0.001, Dp)), new THREE.LineBasicMaterial({ color: 0x3c5254, transparent: true, opacity: 0.8 }));
  frame.position.y = floorY; scene.add(frame);

  // ball, truth pin, zero-gain ring, trail
  const ballR = 0.075;
  const ball = new THREE.Mesh(new THREE.SphereGeometry(ballR, 40, 20), new THREE.MeshStandardMaterial({ color: 0xffc58a, emissive: 0xff8a2a, emissiveIntensity: 1.35, roughness: 0.3, metalness: 0.05 }));
  const tex = glowTexture();
  const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, color: 0xffa050, transparent: true, opacity: 0.55, depthWrite: false, blending: THREE.AdditiveBlending, fog: false }));
  halo.scale.set(0.55, 0.55, 1); ball.add(halo);
  scene.add(ball);
  scene.add(new THREE.AmbientLight(0x5a7a88, 0.9));
  const sun = new THREE.DirectionalLight(0xffffff, 1.6); sun.position.set(3, 6, 2); scene.add(sun);
  const pinMat = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85, fog: false });
  const pinGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, 1, 0)]);
  const pin = new THREE.Line(pinGeo, pinMat); scene.add(pin);
  const pinTop = new THREE.Mesh(new THREE.OctahedronGeometry(0.045), new THREE.MeshBasicMaterial({ color: 0xffffff, fog: false }));
  scene.add(pinTop);
  const truthLabel = textSprite("truth", { px: 12, color: "#ffffff", weight: 600, anchor: "left", priority: 9 }); scene.add(truthLabel);
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.1, 0.011, 8, 48), new THREE.MeshBasicMaterial({ color: C.silver, transparent: true, opacity: 0.85, fog: false }));
  ring.rotation.x = Math.PI / 2; scene.add(ring);
  // the path the best fit has taken as the gain moved (reset when the noise or line changes)
  const HIST = 120; let hist = [], histKey = null;
  const pathGeo = new THREE.BufferGeometry(); pathGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(HIST * 3), 3));
  const path = new THREE.Line(pathGeo, new THREE.LineBasicMaterial({ color: C.peach, transparent: true, opacity: 0.75, fog: false }));
  scene.add(path);
  const TRN = 28;
  const trailGeo = new THREE.BufferGeometry(); trailGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(TRN * 3), 3));
  const trail = new THREE.Line(trailGeo, new THREE.LineDashedMaterial({ color: C.fit, dashSize: 0.06, gapSize: 0.045, transparent: true, opacity: 0.9, fog: false }));
  scene.add(trail);
  const axes = new THREE.Group(); scene.add(axes);

  let ballX = 0, ballZ = 0, ballTX = 0, ballTZ = 0, ringX = 0, ringZ = 0, truthX = 0, truthZ = 0, first = true;

  function build(n) {
    N = n;
    if (mesh) { scene.remove(mesh); geo.dispose(); scene.remove(wire); wire.geometry.dispose(); }
    geo = new THREE.BufferGeometry();
    const pos = new Float32Array(N * N * 3);
    for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
      const k = (i * N + j) * 3;
      pos[k] = -W / 2 + W * i / (N - 1); pos[k + 1] = 0; pos[k + 2] = Dp / 2 - Dp * j / (N - 1);
    }
    const idx = [];
    for (let i = 0; i < N - 1; i++) for (let j = 0; j < N - 1; j++) {
      const a = i * N + j, b = (i + 1) * N + j, c = (i + 1) * N + j + 1, d = i * N + j + 1;
      idx.push(a, b, d, b, c, d);
    }
    geo.setIndex(idx);
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geo.setAttribute("aH", new THREE.BufferAttribute(new Float32Array(N * N), 1));
    geo.computeVertexNormals();
    mesh = new THREE.Mesh(geo, mat); scene.add(mesh);
    // sparse wire lattice riding on the surface
    const step = 4, segs = [];
    for (let i = 0; i < N; i += step) for (let j = 0; j < N - 1; j++) segs.push(i * N + j, i * N + j + 1);
    for (let j = 0; j < N; j += step) for (let i = 0; i < N - 1; i++) segs.push(i * N + j, (i + 1) * N + j);
    const wg = new THREE.BufferGeometry(); wg.setAttribute("position", geo.getAttribute("position")); wg.setIndex(segs);
    wire = new THREE.LineSegments(wg, new THREE.LineBasicMaterial({ color: 0x8fe3d6, transparent: true, opacity: 0.1, depthWrite: false }));
    wire.position.y = 0.004; scene.add(wire);
    yCur = new Float32Array(N * N); hCur = new Float32Array(N * N); hTgt = new Float32Array(N * N);
  }
  const xOf = (g) => -W / 2 + W * (g - L.g0) / (L.g1 - L.g0);
  const zOf = (k) => Dp / 2 - Dp * (k - L.k0) / (L.k1 - L.k0);
  function heightAt(x, z) {
    const fi = Math.min(Math.max((x + W / 2) / W * (N - 1), 0), N - 1.0001), fj = Math.min(Math.max((Dp / 2 - z) / Dp * (N - 1), 0), N - 1.0001);
    const i = Math.floor(fi), j = Math.floor(fj), a = fi - i, b = fj - j;
    const y00 = yCur[i * N + j], y10 = yCur[(i + 1) * N + j], y01 = yCur[i * N + j + 1], y11 = yCur[(i + 1) * N + j + 1];
    return (y00 * (1 - a) + y10 * a) * (1 - b) + (y01 * (1 - a) + y11 * a) * b;
  }
  const clampX = (x) => Math.min(Math.max(x, -W / 2), W / 2), clampZ = (z) => Math.min(Math.max(z, -Dp / 2), Dp / 2);
  let axesKey = "";
  function buildAxes() {
    const key = [L.g0, L.g1, L.k0, L.k1].map((x) => x.toFixed(5)).join();
    if (key === axesKey) return; axesKey = key;
    disposeGroup(axes);
    const lineMat = new THREE.LineBasicMaterial({ color: 0x5f7779, transparent: true, opacity: 0.9, fog: false });
    const add = (pts) => axes.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), lineMat));
    const zF = Dp / 2 + 0.12, xL = -W / 2 - 0.12;
    const gT = niceTicks(L.g0, L.g1, 3);
    for (const g of gT.ticks) {
      const x = xOf(g); add([new THREE.Vector3(x, floorY, Dp / 2), new THREE.Vector3(x, floorY, zF)]);
      const s = textSprite(g.toFixed(gT.dec), { px: 12 }); s.position.set(x, floorY - 0.02, zF + 0.2); axes.add(s);
    }
    const t1 = textSprite("photon index Γ", { px: 13, color: TITLE, weight: 600, priority: 8 }); t1.position.set(0, floorY - 0.05, zF + 0.52); axes.add(t1);
    const k0 = Math.exp(L.k0) * 1e3, k1 = Math.exp(L.k1) * 1e3, kT = niceTicks(k0, k1, 3);
    for (const kv of kT.ticks) {
      const z = zOf(Math.log(kv / 1e3)); add([new THREE.Vector3(-W / 2, floorY, z), new THREE.Vector3(xL, floorY, z)]);
      const s = textSprite(kv.toFixed(kT.dec), { px: 12, anchor: "right" }); s.position.set(xL - 0.06, floorY - 0.02, z); axes.add(s);
    }
    const t2 = textSprite("PL norm, 10⁻³ ph keV⁻¹ cm⁻² s⁻¹", { px: 13, color: TITLE, weight: 600, anchor: "right", priority: 8 });
    t2.position.set(xL - 0.06, floorY - 0.05, -Dp / 2 - 0.34); axes.add(t2);
    // vertical scale at the back left corner: sqrt(delta C), about one sigma per step
    const vx = -W / 2, vz = -Dp / 2;
    add([new THREE.Vector3(vx, floorY, vz), new THREE.Vector3(vx, HT, vz)]);
    for (const h of [0, 1, 2, 3, 5, 10]) {
      const y = yOfH(h); add([new THREE.Vector3(vx, y, vz), new THREE.Vector3(vx - 0.08, y, vz)]);
      const s = textSprite(h === 0 ? "0" : `${h}σ`, { px: 12, anchor: "right" }); s.position.set(vx - 0.12, y, vz); axes.add(s);
    }
    const t3 = textSprite("√ΔC", { px: 13, color: TITLE, weight: 600, anchor: "right", priority: 8 }); t3.position.set(vx - 0.12, HT + 0.2, vz); axes.add(t3);
  }

  let lastF = null;
  function place(F) {
    ballTX = xOf(F.fit.th[1]); ballTZ = zOf(F.fit.th[2]);
    ringX = clampX(xOf(F.fit0.th[1])); ringZ = clampZ(zOf(F.fit0.th[2]));
    truthX = xOf(F.truth[1]); truthZ = zOf(F.truth[2]);
  }
  function update(F) {
    lastF = F;
    if (F.trailKey !== histKey) { hist = []; histKey = F.trailKey; }
    const last = hist[hist.length - 1];
    if (!last || last[0] !== F.fit.th[1] || last[1] !== F.fit.th[2]) { hist.push([F.fit.th[1], F.fit.th[2]]); if (hist.length > HIST) hist.shift(); }
    mat.uniforms.uLift.value = Math.sqrt(Math.max(F.lift || 0, 0));
    if (!L || !geo) return;
    const r = F.land;
    if (r.g0 !== L.g0 || r.g1 !== L.g1 || r.k0 !== L.k0 || r.k1 !== L.k1) return;   // wait for the matching surface
    place(F);
    v.dirty = true; v.animating = true;
  }
  function setSurface(S) {
    if (S.N !== N) build(S.N);
    const changedAxes = !L || S.g0 !== L.g0 || S.g1 !== L.g1 || S.k0 !== L.k0 || S.k1 !== L.k1;
    L = { g0: S.g0, g1: S.g1, k0: S.k0, k1: S.k1 }; buildAxes();
    for (let k = 0; k < N * N; k++) hTgt[k] = Math.max(-1, Math.min(HCAP, S.heights[k]));
    if (lastF) place(lastF);
    if (first || reduceMotion || changedAxes) {
      hCur.set(hTgt); for (let k = 0; k < N * N; k++) yCur[k] = yOfH(hCur[k]);
      ballX = clampX(ballTX); ballZ = clampZ(ballTZ); first = false;
    }
    v.dirty = true; v.animating = true;
  }
  const pos = () => geo.getAttribute("position");
  function step(dt) {
    if (!geo || !v.animating) return false;
    let moving = false;
    const p = pos().array, ah = geo.getAttribute("aH");
    const tau = 0.16;
    for (let k = 0; k < N * N; k++) {
      const h = reduceMotion ? hTgt[k] : easeTo(hCur[k], hTgt[k], dt, tau);
      if (Math.abs(h - hTgt[k]) > 1e-3) moving = true;
      hCur[k] = h; ah.array[k] = h; yCur[k] = yOfH(h); p[k * 3 + 1] = yCur[k];
    }
    pos().needsUpdate = true; ah.needsUpdate = true; geo.computeVertexNormals();
    const tx = clampX(ballTX), tz = clampZ(ballTZ);
    const nx = reduceMotion ? tx : easeTo(ballX, tx, dt, 0.22), nz = reduceMotion ? tz : easeTo(ballZ, tz, dt, 0.22);
    const dx = nx - ballX, dz = nz - ballZ, dist = Math.hypot(dx, dz);
    if (dist > 1e-6) { const axis = new THREE.Vector3(dz, 0, -dx).normalize(); ball.rotateOnWorldAxis(axis, dist / ballR); }
    if (Math.hypot(tx - nx, tz - nz) > 1e-4) moving = true;
    ballX = nx; ballZ = nz;
    const by = heightAt(ballX, ballZ) + ballR;
    ball.position.set(ballX, by, ballZ);
    mat.uniforms.uBall.value.set(ballX, by, ballZ);
    const ty = heightAt(truthX, truthZ);
    pin.position.set(truthX, ty, truthZ); pin.scale.y = 1.05;
    pinTop.position.set(truthX, ty + 1.05, truthZ);
    truthLabel.position.set(truthX + 0.07, ty + 1.12, truthZ);
    ring.position.set(ringX, heightAt(ringX, ringZ) + 0.012, ringZ);
    const tp = trailGeo.getAttribute("position").array;
    for (let s = 0; s < TRN; s++) {
      const f = s / (TRN - 1), x = ringX + (ballX - ringX) * f, z = ringZ + (ballZ - ringZ) * f;
      tp[s * 3] = x; tp[s * 3 + 1] = heightAt(x, z) + 0.02; tp[s * 3 + 2] = z;
    }
    trailGeo.getAttribute("position").needsUpdate = true; trail.computeLineDistances();
    trail.visible = Math.hypot(ballX - ringX, ballZ - ringZ) > 0.02;
    const pp = pathGeo.getAttribute("position").array;
    const n = hist.length;
    for (let s = 0; s < n; s++) {
      const x = clampX(xOf(hist[s][0])), z = clampZ(zOf(hist[s][1]));
      pp[s * 3] = x; pp[s * 3 + 1] = heightAt(x, z) + 0.03; pp[s * 3 + 2] = z;
    }
    pathGeo.setDrawRange(0, n); pathGeo.getAttribute("position").needsUpdate = true;
    path.visible = n > 1;
    if (!moving) v.animating = false;
    return true;
  }
  v.update = update; v.setSurface = setSurface; v.step = step;
  return v;
}

// ---------------- the posterior cloud ----------------
function makeCloud(stage, reduceMotion) {
  const v = makeBase(stage, { pos: new THREE.Vector3(5.0, 2.7, 5.6), target: new THREE.Vector3(0, -0.1, 0), reduceMotion, bloom: 0.7 });
  const { scene, controls } = v;
  controls.autoRotate = !reduceMotion; controls.autoRotateSpeed = 0.45;
  const BX = 3.2, BY = 2.3, BZ = 3.2;
  const box = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(BX, BY, BZ)), new THREE.LineBasicMaterial({ color: 0x3a4f51, transparent: true, opacity: 0.75, fog: false }));
  scene.add(box);
  const grid = new THREE.GridHelper(BX, 8, 0x243335, 0x152022); grid.position.y = -BY / 2; grid.scale.z = BZ / BX; scene.add(grid);

  const pointMat = (color, opacity, size) => new THREE.ShaderMaterial({
    uniforms: { uColor: { value: new THREE.Color(color) }, uOpacity: { value: opacity }, uSize: { value: size }, uScale: { value: 400 } },
    vertexShader: `
      attribute float aAlpha; uniform float uSize; uniform float uScale; varying float vA;
      void main(){ vec4 mv = modelViewMatrix*vec4(position,1.0); gl_Position = projectionMatrix*mv; gl_PointSize = uSize*uScale/max(-mv.z,0.1); vA = aAlpha; }`,
    fragmentShader: `
      uniform vec3 uColor; uniform float uOpacity; varying float vA;
      void main(){ vec2 p = gl_PointCoord-0.5; float r2 = dot(p,p)*4.0; if(r2>1.0 || vA < 0.01) discard; float a = exp(-r2*3.2); gl_FragColor = vec4(uColor, a*uOpacity*vA); }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  function makeSet(color, opacity, size) {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(3), 3));
    g.setAttribute("aAlpha", new THREE.BufferAttribute(new Float32Array(1), 1));
    const pts = new THREE.Points(g, pointMat(color, opacity, size)); pts.frustumCulled = false;
    scene.add(pts);
    return { pts, g, cur: null, tgt: null, alpha: null, n: 0, opacity, targetOpacity: opacity };
  }
  const ghost = makeSet(C.ghost, 0.3, 0.05), now = makeSet(C.now, 0.85, 0.06), marg = makeSet(C.marg, 0.85, 0.06);
  marg.pts.visible = false;

  const truth = new THREE.Mesh(new THREE.SphereGeometry(0.05, 24, 12), new THREE.MeshBasicMaterial({ color: 0xffffff, fog: false }));
  scene.add(truth);
  const truthLabel = textSprite("truth", { px: 12, color: "#ffffff", weight: 600, anchor: "left", priority: 9 }); scene.add(truthLabel);
  const crossMat = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.22, fog: false });
  const cross = new THREE.LineSegments(new THREE.BufferGeometry(), crossMat); scene.add(cross);
  const meanDot = new THREE.Mesh(new THREE.SphereGeometry(0.04, 20, 10), new THREE.MeshBasicMaterial({ color: C.mint, fog: false }));
  scene.add(meanDot);
  const biasGeo = new THREE.BufferGeometry(); biasGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(6), 3));
  const bias = new THREE.Line(biasGeo, new THREE.LineBasicMaterial({ color: 0xffc27a, fog: false })); scene.add(bias);
  const axes = new THREE.Group(); scene.add(axes);

  let B = null, boxKey = "", truthP = new THREE.Vector3(), meanT = new THREE.Vector3(), meanC = new THREE.Vector3(), firstMean = true;
  const map = (g, lnk, nh, out) => {
    out[0] = (g - B[0][0]) / (B[0][1] - B[0][0]) * BX - BX / 2;
    out[2] = BZ / 2 - (lnk - B[1][0]) / (B[1][1] - B[1][0]) * BZ;
    out[1] = (nh - B[2][0]) / (B[2][1] - B[2][0]) * BY - BY / 2;
    return out;
  };
  function buildAxes() {
    const key = B.flat().map((x) => x.toFixed(5)).join();
    if (key === boxKey) return; boxKey = key;
    disposeGroup(axes);
    const lineMat = new THREE.LineBasicMaterial({ color: 0x5f7779, fog: false });
    const tick = (a, b) => axes.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([a, b]), lineMat));
    const o = [0, 0, 0];
    const gT = niceTicks(B[0][0], B[0][1], 4);
    for (const g of gT.ticks) {
      map(g, B[1][0], B[2][0], o);
      tick(new THREE.Vector3(o[0], -BY / 2, BZ / 2), new THREE.Vector3(o[0], -BY / 2, BZ / 2 + 0.08));
      const s = textSprite(g.toFixed(gT.dec), { px: 12 }); s.position.set(o[0], -BY / 2 - 0.05, BZ / 2 + 0.24); axes.add(s);
    }
    const t1 = textSprite("photon index Γ", { px: 13, color: TITLE, weight: 600, priority: 8 }); t1.position.set(0, -BY / 2 - 0.1, BZ / 2 + 0.55); axes.add(t1);
    const k0 = Math.exp(B[1][0]) * 1e3, k1 = Math.exp(B[1][1]) * 1e3, kT = niceTicks(k0, k1, 3);
    for (const kv of kT.ticks) {
      map(B[0][1], Math.log(kv / 1e3), B[2][0], o);
      tick(new THREE.Vector3(BX / 2, -BY / 2, o[2]), new THREE.Vector3(BX / 2 + 0.08, -BY / 2, o[2]));
      const s = textSprite(kv.toFixed(kT.dec), { px: 12, anchor: "left" }); s.position.set(BX / 2 + 0.12, -BY / 2 - 0.03, o[2]); axes.add(s);
    }
    const t2 = textSprite("PL norm, 10⁻³", { px: 13, color: TITLE, weight: 600, anchor: "left", priority: 8 }); t2.position.set(BX / 2 + 0.12, -BY / 2 - 0.05, -BZ / 2 - 0.3); axes.add(t2);
    const nT = niceTicks(B[2][0], B[2][1], 4);
    for (const nh of nT.ticks) {
      map(B[0][0], B[1][0], nh, o);
      tick(new THREE.Vector3(-BX / 2, o[1], BZ / 2), new THREE.Vector3(-BX / 2 - 0.08, o[1], BZ / 2));
      const s = textSprite(nh.toFixed(nT.dec), { px: 12, anchor: "right" }); s.position.set(-BX / 2 - 0.12, o[1], BZ / 2); axes.add(s);
    }
    const t3 = textSprite("NH, 10²² cm⁻²", { px: 13, color: TITLE, weight: 600, anchor: "left", priority: 8 }); t3.position.set(-BX / 2 + 0.05, BY / 2 + 0.2, BZ / 2); axes.add(t3);
  }
  function setTargets(set, arr) {
    const n = arr.length / 3;
    if (set.n !== n) {
      set.n = n; set.cur = new Float32Array(n * 3); set.tgt = new Float32Array(n * 3); set.alpha = new Float32Array(n);
      set.g.setAttribute("position", new THREE.BufferAttribute(set.cur, 3));
      set.g.setAttribute("aAlpha", new THREE.BufferAttribute(set.alpha, 1));
      set.fresh = true;
    }
    const o = [0, 0, 0];
    for (let s = 0; s < n; s++) {
      const g = arr[3 * s], k = arr[3 * s + 1], nh = arr[3 * s + 2];
      const ok = Number.isFinite(g) && g >= B[0][0] && g <= B[0][1] && k >= B[1][0] && k <= B[1][1] && nh >= B[2][0] && nh <= B[2][1];
      if (Number.isFinite(g)) { map(g, k, nh, o); set.tgt[3 * s] = o[0]; set.tgt[3 * s + 1] = o[1]; set.tgt[3 * s + 2] = o[2]; }
      set.alpha[s] = ok ? 1 : 0;
    }
    if (set.fresh || reduceMotion) { set.cur.set(set.tgt); set.fresh = false; }
    set.g.getAttribute("aAlpha").needsUpdate = true;
    set.g.getAttribute("position").needsUpdate = true;
  }
  function meanOf(arr) {
    let g = 0, k = 0, nh = 0, n = 0;
    for (let s = 0; s < arr.length / 3; s++) { if (!Number.isFinite(arr[3 * s])) continue; g += arr[3 * s]; k += arr[3 * s + 1]; nh += arr[3 * s + 2]; n++; }
    return n ? [g / n, k / n, nh / n] : null;
  }
  function update(F, M) {
    B = F.cloudBox; buildAxes();
    setTargets(ghost, F.ghost);
    setTargets(now, F.cloud);
    const o = [0, 0, 0];
    map(F.truth[1], F.truth[2], F.truth[0], o); truthP.set(o[0], o[1], o[2]);
    truth.position.copy(truthP); truthLabel.position.set(o[0] + 0.07, o[1] + 0.1, o[2]);
    cross.geometry.dispose();
    cross.geometry = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(-BX / 2, o[1], o[2]), new THREE.Vector3(BX / 2, o[1], o[2]),
      new THREE.Vector3(o[0], -BY / 2, o[2]), new THREE.Vector3(o[0], BY / 2, o[2]),
      new THREE.Vector3(o[0], o[1], -BZ / 2), new THREE.Vector3(o[0], o[1], BZ / 2)]);
    const useM = M && M.cloud;
    marg.pts.visible = !!useM;
    if (useM) setTargets(marg, M.cloud);
    now.targetOpacity = useM ? 0.18 : 0.85;
    const mm = meanOf(useM ? M.cloud : F.cloud);
    if (mm) { map(mm[0], mm[1], mm[2], o); meanT.set(o[0], o[1], o[2]); if (firstMean || reduceMotion) { meanC.copy(meanT); firstMean = false; } }
    meanDot.material.color.set(useM ? 0xffd9a0 : C.mint);
    v.dirty = true; v.animating = true;
  }
  function stepSet(set, dt) {
    if (!set.cur) return false;
    let moving = false;
    const a = set.cur, t = set.tgt, f = 1 - Math.exp(-dt / 0.2);
    for (let i = 0; i < a.length; i++) { const d = t[i] - a[i]; if (d > 1e-4 || d < -1e-4) { a[i] += d * f; moving = true; } else a[i] = t[i]; }
    if (moving) set.g.getAttribute("position").needsUpdate = true;
    const u = set.pts.material.uniforms.uOpacity;
    if (Math.abs(u.value - set.targetOpacity) > 1e-3) { u.value = reduceMotion ? set.targetOpacity : easeTo(u.value, set.targetOpacity, dt, 0.2); moving = true; }
    return moving;
  }
  function step(dt) {
    for (const s of [ghost, now, marg]) s.pts.material.uniforms.uScale.value = (v.pxH || 400) * 0.9;
    if (!v.animating) return false;
    let moving = stepSet(ghost, dt) | stepSet(now, dt) | stepSet(marg, dt);
    const nm = reduceMotion ? meanT.clone() : meanC.clone().lerp(meanT, 1 - Math.exp(-dt / 0.2));
    if (nm.distanceTo(meanT) > 1e-4) moving = true;
    meanC.copy(nm); meanDot.position.copy(meanC);
    const bp = biasGeo.getAttribute("position").array;
    bp[0] = truthP.x; bp[1] = truthP.y; bp[2] = truthP.z; bp[3] = meanC.x; bp[4] = meanC.y; bp[5] = meanC.z;
    biasGeo.getAttribute("position").needsUpdate = true;
    if (!moving) v.animating = false;
    return true;
  }
  v.update = update; v.step = step;
  return v;
}

// ---------------- entry ----------------
export function createViews({ landStage, cloudStage, reduceMotion }) {
  const land = makeLandscape(landStage, reduceMotion);
  const cloud = makeCloud(cloudStage, reduceMotion);
  const all = [land, cloud];
  let last = performance.now();
  function frame(t) {
    requestAnimationFrame(frame);
    const dt = Math.min(0.05, (t - last) / 1000); last = t;
    for (const v of all) {
      if (!v.visible) continue;
      const anim = v.step(dt);
      const moved = v.controls.update();
      if (anim || moved || v.dirty || v.controls.autoRotate) { v.render(); v.dirty = false; }
    }
  }
  requestAnimationFrame(frame);
  return {
    update(F, M) { land.update(F); cloud.update(F, M); },
    surface(S) { land.setSurface(S); },
  };
}
