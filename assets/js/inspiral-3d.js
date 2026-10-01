/*
  3D orbit view for "the chirp". The two holes orbit above a sheet that stands in
  for curved space: each hole pulls a dip into it, and the sheet carries the
  gravitational waves outward with the right retardation, so the crests pack
  tighter as the orbit speeds up. The main script (inspiral.js) owns the physics
  and the clock and calls frame() once per animation frame.
*/
import * as THREE from '/assets/vendor/three/0.169.0/build/three.module.min.js';

const app = window.Chirp;
// Shared instrument colours (play.css), read once; they don't change with the theme.
const TOK_CS = getComputedStyle(document.body);
const tok = (name, fallback) => TOK_CS.getPropertyValue(name).trim() || fallback;

function init() {
  const stage = app.stage;
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  } catch (e) {
    window.ChirpViewFailed && window.ChirpViewFailed('webgl');
    return;
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setClearColor(0x080c0e, 1);
  const canvas = renderer.domElement;
  canvas.setAttribute('tabindex', '0');
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', 'Two black holes orbiting above a curved grid that ripples with gravitational waves. Drag or use the arrow keys to turn the view.');
  stage.appendChild(canvas);

  const { R0, REND, OMEGA_END } = app.constants;
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(34, 1, 0.1, 200);
  const BG = new THREE.Color(0x080c0e);

  // ------------------------------------------------------------ the sheet
  const HN = 512;                       // history samples
  const HSPAN = 4.2;                    // seconds of history the texture covers
  const WAVE_C = 5.4;                   // wave speed on screen, units per second
  const histData = new Uint16Array(HN * 4);
  const histTex = new THREE.DataTexture(histData, HN, 1, THREE.RGBAFormat, THREE.HalfFloatType);
  histTex.minFilter = THREE.LinearFilter; histTex.magFilter = THREE.LinearFilter;
  histTex.wrapS = THREE.ClampToEdgeWrapping; histTex.wrapT = THREE.ClampToEdgeWrapping;
  histTex.needsUpdate = true;

  const SHEET = 38;
  const sheetGeo = new THREE.PlaneGeometry(SHEET, SHEET, 320, 320);
  sheetGeo.rotateX(-Math.PI / 2);
  const sheetUniforms = {
    uHist: { value: histTex },
    uSpan: { value: HSPAN },
    uC: { value: WAVE_C },
    uBH1: { value: new THREE.Vector3(1, 0, 0.5) },
    uBH2: { value: new THREE.Vector3(-1, 0, 0.5) },
    uWell: { value: 1.55 },
    uEps: { value: 0.5 },
    uWaveAmp: { value: 0.5 },
    uRin: { value: R0 },
    uBase: { value: -1.15 },
    uFlash: { value: 0 },
    uGlow: { value: 1 },
    uCam: { value: new THREE.Vector3() },
    uBg: { value: new THREE.Vector3(8 / 255, 12 / 255, 14 / 255) }   // display values, the shader writes raw colour
  };
  const sheetMat = new THREE.ShaderMaterial({
    uniforms: sheetUniforms,
    vertexShader: /* glsl */`
      uniform sampler2D uHist;
      uniform float uSpan, uC, uWell, uEps, uWaveAmp, uRin, uBase;
      uniform vec3 uBH1, uBH2;
      varying vec2 vXZ;
      varying float vWave, vWell, vR, vLoud;
      varying vec3 vN, vW;
      float well(vec2 p) {
        vec2 a = p - uBH1.xy, b = p - uBH2.xy;
        return -uWell * (uBH1.z * uEps / sqrt(dot(a, a) + uEps * uEps) + uBH2.z * uEps / sqrt(dot(b, b) + uEps * uEps));
      }
      // history texel: rg = unit phase (cos, sin of twice the orbital angle),
      // b = crest height on screen, a = strain loudness (drives brightness)
      vec4 hist(float r) {
        float u = (r / uC) / uSpan;
        if (u >= 1.0) return vec4(0.0);
        vec4 h = texture2D(uHist, vec2(u * ${((HN - 1) / HN).toFixed(6)} + ${(0.5 / HN).toFixed(6)}, 0.5));
        float tail = 1.0 - smoothstep(0.82, 1.0, u);
        return vec4(h.rg, h.b * tail, h.a * tail);
      }
      float pattern(vec2 p, vec4 h) {
        float r2 = max(dot(p, p), 1e-4);
        return ((p.x * p.x - p.y * p.y) * h.r + 2.0 * p.x * p.y * h.g) / r2;
      }
      float fallOff(float r) { return smoothstep(uRin * 0.75, uRin * 1.7, r) * 2.4 / (1.0 + 0.42 * r); }
      float wave(vec2 p) {
        float r = length(p);
        vec4 h = hist(r);
        return uWaveAmp * h.b * pattern(p, h) * fallOff(r);
      }
      float height(vec2 p) { return well(p) + wave(p); }
      void main() {
        vec2 p = position.xz;
        float wv = wave(p);
        vec4 hh = hist(length(p));
        vLoud = hh.a * pattern(p, hh) * fallOff(length(p)) * 0.6;
        float wl = well(p);
        float e = 0.07;
        float hx = height(p + vec2(e, 0.0)) - height(p - vec2(e, 0.0));
        float hz = height(p + vec2(0.0, e)) - height(p - vec2(0.0, e));
        vN = normalize(vec3(-hx / (2.0 * e), 1.0, -hz / (2.0 * e)));
        vec3 pos = vec3(p.x, uBase + wl + wv, p.y);
        vXZ = p; vWave = wv; vWell = wl; vR = length(p);
        vec4 wp = modelMatrix * vec4(pos, 1.0);
        vW = wp.xyz;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }`,
    fragmentShader: /* glsl */`
      uniform float uFlash, uWaveAmp, uGlow;
      uniform vec3 uCam, uBg, uBH1, uBH2;
      varying vec2 vXZ;
      varying float vWave, vWell, vR, vLoud;
      varying vec3 vN, vW;
      float grid(vec2 p, float step, float width) {
        vec2 q = p / step;
        vec2 g = abs(fract(q - 0.5) - 0.5) / fwidth(q);
        return 1.0 - min(min(g.x, g.y) / width, 1.0);
      }
      void main() {
        float dens = length(fwidth(vXZ / 0.5));
        float minor = grid(vXZ, 0.5, 0.9) * (1.0 - smoothstep(0.3, 0.75, dens));
        float major = grid(vXZ, 2.5, 1.2);
        float lines = max(minor * 0.34, major * 0.8);
        lines *= mix(1.0, 0.35, smoothstep(2.5, 12.0, vR));
        vec3 L = normalize(vec3(-0.35, 1.0, 0.45));
        vec3 V = normalize(uCam - vW);
        vec3 N = normalize(vN);
        float diff = clamp(dot(N, L), 0.0, 1.0);
        float spec = pow(clamp(dot(reflect(-L, N), V), 0.0, 1.0), 28.0);
        float fres = pow(1.0 - clamp(dot(N, V), 0.0, 1.0), 5.0);
        float crest = clamp(vLoud * 2.0, -1.0, 1.0);
        float depth = clamp(-vWell / 1.6, 0.0, 1.0);
        vec3 surf = vec3(0.026, 0.040, 0.046) * (0.5 + 0.8 * diff) + vec3(0.03, 0.05, 0.055) * fres;
        surf += vec3(0.30, 0.46, 0.48) * spec * 0.22 * (0.4 + abs(crest));
        vec3 lineCol = mix(vec3(0.24, 0.38, 0.39), vec3(0.58, 0.98, 0.9), clamp(crest, 0.0, 1.0));
        lineCol = mix(lineCol, vec3(0.13, 0.2, 0.22), clamp(-crest, 0.0, 1.0) * 0.65);
        lineCol = mix(lineCol, vec3(0.98, 0.74, 0.5), depth * 0.6);
        vec3 col = surf + lineCol * lines * (0.75 + 0.55 * diff);
        // light from the two glowing holes pooling on the sheet below them
        vec2 a = vXZ - uBH1.xy, b = vXZ - uBH2.xy;
        float pool = uBH1.z * exp(-dot(a, a) / 2.2) + uBH2.z * exp(-dot(b, b) / 2.2);
        col += vec3(1.0, 0.72, 0.46) * pool * uGlow * (0.07 + 0.5 * lines);
        col += vec3(0.5, 0.9, 0.85) * uFlash * (0.2 + lines) * exp(-vR * 0.12);
        float fog = max(smoothstep(6.5, 15.0, vR), smoothstep(15.0, 28.0, length(uCam - vW)));
        col = mix(col, uBg, fog);
        gl_FragColor = vec4(col, 1.0);
      }`,
    extensions: {}
  });
  const sheet = new THREE.Mesh(sheetGeo, sheetMat);
  scene.add(sheet);

  // ------------------------------------------------------------ black holes
  function radialTexture(fn, size) {
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const g = c.getContext('2d');
    const img = g.createImageData(size, size);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const dx = (x + 0.5) / size * 2 - 1, dy = (y + 0.5) / size * 2 - 1;
        const r = Math.sqrt(dx * dx + dy * dy);
        const a = Math.max(0, Math.min(1, fn(r)));
        const i = (y * size + x) * 4;
        img.data[i] = img.data[i + 1] = img.data[i + 2] = 255;
        img.data[i + 3] = Math.round(a * 255);
      }
    }
    g.putImageData(img, 0, 0);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }
  const RING = 0.215;   // photon-ring radius as a fraction of the halo sprite's half size
  const haloTex = radialTexture(function (r) {
    if (r > 1) return 0;
    const ring = Math.exp(-Math.pow((r - RING * 1.07) / 0.014, 2));
    const glow = r < RING ? 0 : 0.55 * Math.exp(-(r - RING) / 0.075) + 0.16 * Math.exp(-(r - RING) / 0.3);
    return (ring + glow) * (1 - Math.pow(r, 6));
  }, 256);
  const softTex = radialTexture(function (r) { return r > 1 ? 0 : Math.pow(1 - r, 2.2); }, 128);

  const sphereGeo = new THREE.SphereGeometry(1, 48, 32);
  const blackMat = new THREE.MeshBasicMaterial({ color: 0x000000 });
  const diskGeo = new THREE.RingGeometry(1.35, 4.2, 96, 1);
  diskGeo.rotateX(-Math.PI / 2);

  function makeDiskMat() {
    return new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uTint: { value: new THREE.Color(1, 0.8, 0.6) }, uBoost: { value: 1 } },
      vertexShader: `varying vec2 vP; void main(){ vP = position.xz; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
      fragmentShader: `
        uniform float uTime, uBoost; uniform vec3 uTint; varying vec2 vP;
        void main(){
          float r = length(vP);
          float t = clamp((r - 1.35) / (4.2 - 1.35), 0.0, 1.0);
          float a = atan(vP.y, vP.x);
          float streak = 0.72 + 0.28 * sin(a * 5.0 + log(r) * 9.0 - uTime * 2.4);
          float inner = smoothstep(0.0, 0.06, t);
          float I = inner * pow(1.0 - t, 2.4) * streak * uBoost;
          vec3 hot = mix(vec3(1.0, 0.95, 0.86), uTint, smoothstep(0.0, 0.5, t));
          gl_FragColor = vec4(hot * I * 0.85, 1.0);
        }`,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide
    });
  }

  function makeHole() {
    const grp = new THREE.Group();
    const ball = new THREE.Mesh(sphereGeo, blackMat);
    ball.renderOrder = 1;
    const disk = new THREE.Mesh(diskGeo, makeDiskMat());
    disk.renderOrder = 2;
    const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: haloTex, color: tok('--inst-peach', '#ffd9a8'), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
    halo.renderOrder = 3;
    const bloom = new THREE.Sprite(new THREE.SpriteMaterial({ map: softTex, color: 0xffb070, transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending, opacity: 0.25 }));
    bloom.renderOrder = 4;
    grp.add(ball, disk, halo, bloom);
    scene.add(grp);
    // trail
    const TN = 90;
    const tpos = new Float32Array(TN * 3), tcol = new Float32Array(TN * 3);
    const tgeo = new THREE.BufferGeometry();
    tgeo.setAttribute('position', new THREE.BufferAttribute(tpos, 3));
    tgeo.setAttribute('color', new THREE.BufferAttribute(tcol, 3));
    const trail = new THREE.Line(tgeo, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
    trail.frustumCulled = false;
    scene.add(trail);
    return { grp, ball, disk, halo, bloom, trail, tpos, tcol, TN, rb: 0.2 };
  }
  const holes = [makeHole(), makeHole()];

  // last stable orbit, faint dashed ring
  const iscoPts = [];
  for (let i = 0; i <= 128; i++) { const a = i / 128 * Math.PI * 2; iscoPts.push(new THREE.Vector3(Math.cos(a) * REND, 0, Math.sin(a) * REND)); }
  const iscoGeo = new THREE.BufferGeometry().setFromPoints(iscoPts);
  const iscoRing = new THREE.Line(iscoGeo, new THREE.LineDashedMaterial({ color: tok('--inst-teal', '#5fc8b9'), dashSize: 0.12, gapSize: 0.1, transparent: true, opacity: 0.28, depthWrite: false }));
  iscoRing.computeLineDistances();
  scene.add(iscoRing);

  // merger flash
  const flash = new THREE.Sprite(new THREE.SpriteMaterial({ map: softTex, color: 0xf4fffc, transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending, opacity: 0 }));
  flash.renderOrder = 10;
  scene.add(flash);

  // ------------------------------------------------------------ history of the orbital phase
  // entries: [t, 2*phase, amp]; texture row k holds the state k*dt ago
  let hist = [];
  let lastT = 0;
  function resyncHistory(snap) {
    hist = [];
    const n = Math.ceil(HSPAN * 60) + 4;
    for (let j = n; j >= 0; j--) {
      const t = snap.clock - j / 60;
      hist.push([t, 2 * (snap.ang - 2 * Math.PI * snap.omega * j / 60), snap.stage === 'merger' ? 0 : snap.amp, snap.omega]);
    }
    lastT = snap.clock;
  }
  const RING_OMEGA = 1.4 * OMEGA_END;
  const OMEGA_REF = 1.25;   // rev/s on screen above which crest height is held
  let ringPhase = 0;
  function pushHistory(snap, adv) {
    if (snap.stage === 'merger') {
      ringPhase += 2 * Math.PI * RING_OMEGA * adv;
      const a = Math.exp(-snap.mergeAge / 0.3) * 1.15;
      const lastPh = hist.length ? hist[hist.length - 1][1] : 0;
      hist.push([snap.clock, lastPh + 2 * 2 * Math.PI * RING_OMEGA * adv, a, RING_OMEGA]);
    } else {
      hist.push([snap.clock, 2 * snap.ang, snap.amp, snap.omega]);
    }
    const cut = snap.clock - HSPAN - 0.3;
    let k = 0;
    while (k < hist.length - 2 && hist[k + 1][0] < cut) k++;
    if (k) hist.splice(0, k);
    lastT = snap.clock;
  }
  function uploadHistory(now) {
    const toH = THREE.DataUtils.toHalfFloat;
    let j = hist.length - 1;
    for (let k = 0; k < HN; k++) {
      const t = now - k * HSPAN / (HN - 1);
      while (j > 0 && hist[j][0] > t) j--;
      let ph, amp, om;
      if (!hist.length || t < hist[0][0]) { ph = 0; amp = 0; om = 1; }
      else if (j >= hist.length - 1) { const e = hist[hist.length - 1]; ph = e[1]; amp = e[2]; om = e[3]; }
      else {
        const a = hist[j], b = hist[j + 1];
        const w = b[0] > a[0] ? (t - a[0]) / (b[0] - a[0]) : 0;
        ph = a[1] + w * (b[1] - a[1]);
        amp = a[2] + w * (b[2] - a[2]);
        om = a[3] + w * (b[3] - a[3]);
      }
      // crest height stops growing once the waves get short, so slopes stay drawable;
      // the growing strain shows up as brightness instead
      const hgt = amp * Math.min(1, OMEGA_REF / Math.max(om, 1e-3));
      histData[k * 4] = toH(Math.cos(ph));
      histData[k * 4 + 1] = toH(Math.sin(ph));
      histData[k * 4 + 2] = toH(hgt);
      histData[k * 4 + 3] = toH(amp);
    }
    histTex.needsUpdate = true;
  }

  // ------------------------------------------------------------ camera, drag to turn
  const target = new THREE.Vector3(0, -0.55, 0);
  let az = -0.62, elv = 0.46, dist = 14, vAz = 0, vEl = 0, dragging = false, lastX = 0, lastY = 0, idle = 0;
  let baseDist = 14;
  canvas.addEventListener('pointerdown', function (e) {
    dragging = true; lastX = e.clientX; lastY = e.clientY; vAz = vEl = 0; idle = 0;
    canvas.setPointerCapture && canvas.setPointerCapture(e.pointerId);
    app.hintSeen(); app.wake();
  });
  canvas.addEventListener('pointermove', function (e) {
    if (!dragging) return;
    const dx = e.clientX - lastX, dy = e.clientY - lastY;
    lastX = e.clientX; lastY = e.clientY;
    vAz = -dx * 0.0065; vEl = e.pointerType === 'touch' ? 0 : dy * 0.005;
    az += vAz; elv = Math.max(0.1, Math.min(1.3, elv + vEl));
    app.wake();
  });
  function endDrag() { dragging = false; idle = 0; app.wake(); }
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);
  canvas.addEventListener('keydown', function (e) {
    let used = true;
    if (e.key === 'ArrowLeft') vAz = 0.035;
    else if (e.key === 'ArrowRight') vAz = -0.035;
    else if (e.key === 'ArrowUp') vEl = -0.03;
    else if (e.key === 'ArrowDown') vEl = 0.03;
    else used = false;
    if (used) { e.preventDefault(); idle = 0; app.hintSeen(); app.wake(); }
  });

  function resize() {
    const r = stage.getBoundingClientRect();
    const w = Math.max(1, r.width), h = Math.max(1, r.height);
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    // keep the start orbit inside the frame on narrow screens
    baseDist = 13.2 / Math.min(1, Math.max(0.62, camera.aspect * 0.98)) * (camera.aspect < 1 ? 0.95 : 1);
    camera.updateProjectionMatrix();
  }
  resize();
  // portrait panels: look down a little more so the sheet fills the frame
  if (camera.aspect < 1) elv = 0.6;
  dist = baseDist;
  if ('ResizeObserver' in window) new ResizeObserver(function () { resize(); app.wake(); }).observe(stage);

  // ------------------------------------------------------------ per-frame update
  const tmp = new THREE.Vector3(), camDir = new THREE.Vector3();
  const warm = new THREE.Color(1.0, 0.84, 0.64), blue = new THREE.Color(0.66, 0.8, 1.0), red = new THREE.Color(1.0, 0.5, 0.33);
  const trailPts = [[], []];
  let prevStage = 'inspiral';
  let flashAge = 99;

  function placeCamera(dt) {
    if (!dragging) {
      const k = Math.pow(0.9, dt * 60);
      az += vAz; elv = Math.max(0.1, Math.min(1.3, elv + vEl));
      vAz *= k; vEl *= k;
      if (Math.abs(vAz) < 1e-5) vAz = 0;
      if (Math.abs(vEl) < 1e-5) vEl = 0;
    }
    dist += (baseDist - dist) * Math.min(1, dt * 4 || 1);
    camera.position.set(
      target.x + dist * Math.cos(elv) * Math.sin(az),
      target.y + dist * Math.sin(elv),
      target.z + dist * Math.cos(elv) * Math.cos(az)
    );
    camera.lookAt(target);
  }

  function frame(snap, adv, dt) {
    if (snap.resync) { resyncHistory(snap); ringPhase = 0; trailPts[0].length = trailPts[1].length = 0; }
    else if (adv > 0) pushHistory(snap, adv);
    if (snap.resync || adv > 0) uploadHistory(snap.clock);

    idle += dt;
    if (snap.playing && !snap.reduced && !dragging && idle > 2.5) az += 0.028 * dt;
    placeCamera(dt);
    sheetUniforms.uCam.value.copy(camera.position);

    const merged = snap.stage === 'merger';
    if (merged && prevStage !== 'merger') flashAge = 0;
    prevStage = snap.stage;
    if (adv > 0) flashAge += adv;

    // positions in the orbital plane (x, z)
    const r = snap.r, a = snap.ang;
    const mu = [snap.mu1, snap.mu2];
    const pos = merged
      ? [[0, 0], [0, 0]]
      : [[r * mu[1] * Math.cos(a), r * mu[1] * Math.sin(a)], [-r * mu[0] * Math.cos(a), -r * mu[0] * Math.sin(a)]];
    sheetUniforms.uBH1.value.set(pos[0][0], pos[0][1], merged ? 1 : mu[0]);
    sheetUniforms.uBH2.value.set(pos[1][0], pos[1][1], merged ? 0 : mu[1]);
    sheetUniforms.uRin.value = merged ? REND : r;
    sheetUniforms.uFlash.value = merged ? Math.max(0, 1 - flashAge / 0.9) * (snap.reduced ? 0.3 : 1) : 0;
    sheetUniforms.uGlow.value = merged ? 1 + 3 * Math.max(0, 1 - flashAge / 0.8) : 0.8 + 0.7 * snap.u;

    const rbSum = REND / 3;                     // at ISCO the separation is 3x the summed horizon radii
    for (let i = 0; i < 2; i++) {
      const h = holes[i];
      let rb = Math.max(0.045, rbSum * mu[i]);
      if (merged) rb = i === 0 ? rbSum : 0;
      const visible = rb > 0;
      h.grp.visible = visible;
      h.trail.visible = visible && !merged;
      if (!visible) continue;
      const x = pos[i][0], z = pos[i][1];
      h.grp.position.set(x, 0, z);
      // ringdown wobble of the remnant
      let sx = 1, sz = 1;
      if (merged) {
        const wob = 0.16 * Math.exp(-snap.mergeAge / 0.35) * Math.sin(2 * Math.PI * RING_OMEGA * snap.mergeAge);
        sx = 1 + wob; sz = 1 - wob;
      }
      h.ball.scale.set(rb * sx, rb, rb * sz);
      h.disk.scale.setScalar(rb);
      h.halo.scale.setScalar(Math.max(0.5, rb * 4.65 * 2));
      h.bloom.scale.setScalar(Math.max(0.9, rb * 14));

      // Doppler: line-of-sight speed toward the camera
      let D = 1;
      if (!merged) {
        const sgn = i === 0 ? 1 : -1;
        const vdir = tmp.set(-Math.sin(a) * sgn, 0, Math.cos(a) * sgn);
        camDir.set(camera.position.x - x, camera.position.y, camera.position.z - z).normalize();
        const beta = snap.beta * mu[1 - i];
        const bl = beta * vdir.dot(camDir);
        const gamma = 1 / Math.sqrt(1 - beta * beta);
        D = 1 / (gamma * (1 - bl));
      }
      const boost = Math.pow(D, 3);
      const col = warm.clone();
      if (D > 1) col.lerp(blue, Math.min(1, (D - 1) * 3));
      else col.lerp(red, Math.min(1, (1 - D) * 3));
      const flashBoost = merged ? 1 + 2.5 * Math.max(0, 1 - flashAge / 0.8) : 1;
      h.halo.material.color.copy(col).multiplyScalar(Math.min(2.2, 0.95 * boost * flashBoost));
      h.bloom.material.color.copy(col);
      h.bloom.material.opacity = Math.min(0.7, 0.2 * boost * flashBoost);
      h.disk.material.uniforms.uTint.value.copy(col);
      h.disk.material.uniforms.uBoost.value = Math.min(2.5, boost * flashBoost);
      h.disk.material.uniforms.uTime.value = snap.clock * (1 + 2 * snap.u);

      // trail: the last ~2 radians of the orbit, fading to black (additive)
      const tp = trailPts[i];
      if (adv > 0 && !merged) { tp.push([x, z, a]); if (tp.length > 400) tp.shift(); }
      let n = 0;
      for (let k = tp.length - 1; k >= 0 && n < h.TN; k--) {
        const age = a - tp[k][2];
        if (age > 2.2) break;
        const f = 1 - age / 2.2;
        h.tpos[n * 3] = tp[k][0]; h.tpos[n * 3 + 1] = 0; h.tpos[n * 3 + 2] = tp[k][1];
        const c = 0.55 * f * f;
        h.tcol[n * 3] = c; h.tcol[n * 3 + 1] = c * 0.82; h.tcol[n * 3 + 2] = c * 0.62;
        n++;
      }
      h.trail.geometry.setDrawRange(0, n);
      h.trail.geometry.attributes.position.needsUpdate = true;
      h.trail.geometry.attributes.color.needsUpdate = true;
    }

    iscoRing.material.opacity = merged ? 0.08 : 0.16 + 0.2 * snap.u;
    const fa = merged ? flashAge : 99;
    if (fa < 1.2) {
      const s = snap.reduced ? 3 : 2 + 16 * Math.pow(fa / 1.2, 0.6);
      flash.scale.setScalar(s);
      flash.material.opacity = (snap.reduced ? 0.35 : 0.9) * Math.pow(1 - fa / 1.2, 2);
    } else flash.material.opacity = 0;

    renderer.render(scene, camera);
  }

  function busy() {
    return dragging || vAz !== 0 || vEl !== 0 || Math.abs(dist - baseDist) > 1e-3;
  }

  app.registerView({ frame: frame, busy: busy });
}

if (app) {
  try { init(); } catch (e) {
    console.error(e);
    window.ChirpViewFailed && window.ChirpViewFailed('webgl');
  }
}
