/*
  Spot the binary: the 3D quasar. three.js r169 from assets/vendor (import map in
  the page head). The main module calls frame(state, dt) once per animation frame
  with the brightness values it is plotting, so the glow and the light curves
  come from the same numbers. frame() returns where the labelled parts are on
  screen (CSS px), so the page can put name tags next to them.

  state = { disc, corona, xrayOn, binary: { on, angle }, reduced }
    disc   : glow multiplier from the optical curve at the playhead
    corona : glow multiplier from the X-ray curve at the playhead
    angle  : orbital phase 2*pi*t/P + phi of the injected binary signal
*/
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

const R_IN = 1.9;          // inner edge of the disc with one black hole
const R_CAV = 7.0;         // cavity radius with a binary (about 2x the separation)
const R_OUT = 12.5;
const SEP = 3.6;           // binary separation (scene units, not to scale)
const Q_RATIO = 0.4;       // secondary / primary mass

const GLSL_NOISE = /* glsl */`
  float hash13(vec3 p){ p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
  float vnoise(vec3 x){
    vec3 i = floor(x); vec3 f = fract(x); f = f * f * (3.0 - 2.0 * f);
    return mix(mix(mix(hash13(i), hash13(i + vec3(1,0,0)), f.x), mix(hash13(i + vec3(0,1,0)), hash13(i + vec3(1,1,0)), f.x), f.y),
               mix(mix(hash13(i + vec3(0,0,1)), hash13(i + vec3(1,0,1)), f.x), mix(hash13(i + vec3(0,1,1)), hash13(i + vec3(1,1,1)), f.x), f.y), f.z);
  }
  float fbm(vec3 p){ float a = 0.5, s = 0.0; for (int i = 0; i < 4; i++) { s += a * vnoise(p); p = p * 2.03 + vec3(1.7, 9.2, 3.1); a *= 0.5; } return s; }
  vec3 bb(float T){
    vec3 c1 = vec3(1.0, 0.26, 0.05), c2 = vec3(1.0, 0.55, 0.18), c3 = vec3(1.0, 0.86, 0.62), c4 = vec3(1.0, 0.88, 0.68);
    float x = clamp(T, 0.0, 1.2);
    vec3 c = mix(c1, c2, smoothstep(0.14, 0.32, x));
    c = mix(c, c3, smoothstep(0.32, 0.62, x));
    return mix(c, c4, smoothstep(0.72, 1.05, x));
  }
`;

function glowTexture(inner, mid, outer) {
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const g = c.getContext('2d');
  const gr = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  gr.addColorStop(0, inner); gr.addColorStop(0.2, mid); gr.addColorStop(0.5, outer); gr.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = gr; g.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export function createQuasarScene(host, opts = {}) {
  let reduced = !!opts.reduced;
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  if (!renderer.getContext()) throw new Error('no WebGL context');
  const small = () => host.clientWidth < 600;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, small() ? 1.5 : 1.75));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.85;
  renderer.setClearColor(0x05070a, 1);
  host.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(32, 2, 0.1, 500);
  camera.position.set(0, 13, 34);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.06;
  controls.enablePan = false;
  controls.enableZoom = false;
  controls.rotateSpeed = 0.65;
  controls.minPolarAngle = 0.15;
  controls.maxPolarAngle = 1.42;
  controls.autoRotate = !reduced;
  controls.autoRotateSpeed = 0.4;
  let resumeTimer = 0;
  controls.addEventListener('start', () => { controls.autoRotate = false; clearTimeout(resumeTimer); });
  controls.addEventListener('end', () => { clearTimeout(resumeTimer); resumeTimer = setTimeout(() => { controls.autoRotate = !reduced; }, 4000); });

  /* backdrop: a dim gradient, no stars */
  scene.add(new THREE.Mesh(
    new THREE.SphereGeometry(200, 32, 16),
    new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false,
      vertexShader: 'varying vec3 vD; void main(){ vD = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: 'varying vec3 vD; void main(){ float t = smoothstep(-0.5, 0.8, vD.y); gl_FragColor = vec4(mix(vec3(0.012,0.013,0.017), vec3(0.04,0.047,0.063), t), 1.0); }',
    }),
  ));

  /* main black hole with its photon ring */
  const primary = new THREE.Group();
  scene.add(primary);
  // Black holes are drawn after the additive disc and gas (renderOrder 10) so nothing glows on top of the shadow.
  const bhMat = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 1, depthWrite: true });
  const bh = new THREE.Mesh(new THREE.SphereGeometry(1.2, 48, 32), bhMat);
  bh.renderOrder = 10;
  primary.add(bh);
  const ringMat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    uniforms: { uLevel: { value: 1 } },
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv - 0.5; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: /* glsl */`
      uniform float uLevel; varying vec2 vUv;
      void main(){
        float r = length(vUv) * 8.0;
        float ring = (exp(-pow((r - 1.27) / 0.04, 2.0)) * 0.9 + exp(-pow((r - 1.36) / 0.18, 2.0)) * 0.12) * smoothstep(1.2, 1.24, r);
        gl_FragColor = vec4(vec3(1.0, 0.72, 0.42) * ring * uLevel, 1.0);
      }`,
  });
  const ring = new THREE.Mesh(new THREE.PlaneGeometry(8, 8), ringMat);
  ring.renderOrder = 11;
  primary.add(ring);

  /* accretion disc: stacked flared layers with a Keplerian swirl, T ~ r^-3/4
     colours and Doppler beaming toward the camera */
  const discUniforms = {
    uTime: { value: 0 }, uLevel: { value: 1 }, uRin: { value: R_IN }, uRout: { value: R_OUT },
    uSecAng: { value: 0 }, uSecOn: { value: 0 }, uCam: { value: new THREE.Vector3() },
  };
  const discGeo = new THREE.RingGeometry(1.6, R_OUT, 224, 40);
  discGeo.rotateX(-Math.PI / 2);
  const discVS = /* glsl */`
    uniform float uLayer; varying vec3 vWorld; varying float vR; varying vec2 vXZ;
    void main(){
      vec3 p = position; float r = length(p.xz);
      p.y += uLayer * (0.05 * r + 0.05);
      vR = r; vXZ = p.xz;
      vec4 wp = modelMatrix * vec4(p, 1.0); vWorld = wp.xyz;
      gl_Position = projectionMatrix * viewMatrix * wp;
    }`;
  const rin = R_IN.toFixed(2);
  const discFS = /* glsl */`
    uniform float uTime, uLevel, uLayer, uRin, uRout, uSecAng, uSecOn; uniform vec3 uCam;
    varying vec3 vWorld; varying float vR; varying vec2 vXZ;
    ${GLSL_NOISE}
    void main(){
      float r = vR;
      float ang = atan(-vXZ.y, vXZ.x);
      float om = 0.5 * pow(r / ${rin}, -1.5);
      float a = ang - uTime * om + 1.7 * log(r);
      float n = fbm(vec3(cos(a) * 2.3, sin(a) * 2.3, log(r) * 3.4 + uLayer * 0.7));
      float T = pow(r / ${rin}, -0.75);
      float edgeIn = smoothstep(uRin, uRin * 1.2, r);
      float edgeOut = 1.0 - smoothstep(uRout * 0.72, uRout, r);
      vec3 vdir = normalize(vec3(vXZ.y, 0.0, -vXZ.x));
      vec3 toCam = normalize(uCam - vWorld);
      float cosv = dot(vdir, toCam);
      float beta = 0.38 * pow(r / ${rin}, -0.5);
      float dop = clamp(1.0 + beta * cosv, 0.3, 1.9);
      dop = dop * dop * dop;
      float lay = exp(-uLayer * uLayer * 3.0);
      float I = pow(T, 1.45) * (0.35 + 1.0 * n) * edgeIn * edgeOut * lay * dop;
      float d = atan(sin(ang - uSecAng), cos(ang - uSecAng));
      float spot = uSecOn * exp(-d * d / 0.22) * exp(-pow((r - uRin * 1.12) / 0.9, 2.0)) * lay * 0.9;
      float E = (I + spot) * uLevel;
      E = E / (1.0 + 0.45 * E);
      gl_FragColor = vec4(bb(T * (1.0 + 0.15 * cosv)) * E * 0.2, 1.0);
    }`;
  for (const Lr of [-1, -0.5, 0, 0.5, 1]) {
    const m = new THREE.ShaderMaterial({
      uniforms: { ...discUniforms, uLayer: { value: Lr } }, vertexShader: discVS, fragmentShader: discFS,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    });
    scene.add(new THREE.Mesh(discGeo, m));
  }

  /* gas clumps orbiting in the disc, for parallax when you turn the view */
  const NP = small() ? 1400 : 2400;
  const pr = new Float32Array(NP), pa = new Float32Array(NP), ph = new Float32Array(NP), ps = new Float32Array(NP), pz = new Float32Array(NP);
  for (let i = 0; i < NP; i++) {
    const r = R_IN * 1.05 + (R_OUT * 0.95 - R_IN * 1.05) * Math.pow(Math.random(), 1.35);
    pr[i] = r; pa[i] = Math.random() * Math.PI * 2;
    ph[i] = (Math.random() + Math.random() + Math.random() - 1.5) * 0.07 * r;
    ps[i] = 0.6 + Math.random() * 1.4; pz[i] = Math.random();
  }
  const pgeo = new THREE.BufferGeometry();
  pgeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(NP * 3), 3));
  pgeo.setAttribute('aR', new THREE.BufferAttribute(pr, 1));
  pgeo.setAttribute('aAng', new THREE.BufferAttribute(pa, 1));
  pgeo.setAttribute('aH', new THREE.BufferAttribute(ph, 1));
  pgeo.setAttribute('aSize', new THREE.BufferAttribute(ps, 1));
  pgeo.setAttribute('aSeed', new THREE.BufferAttribute(pz, 1));
  const pMat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    uniforms: { uTime: discUniforms.uTime, uLevel: discUniforms.uLevel, uRin: discUniforms.uRin, uPix: { value: 1 } },
    vertexShader: /* glsl */`
      attribute float aR, aAng, aH, aSize, aSeed; uniform float uTime, uPix, uRin; varying float vT, vA;
      void main(){
        float ang = aAng + uTime * 0.5 * pow(aR / ${rin}, -1.5);
        vec4 mv = modelViewMatrix * vec4(aR * cos(ang), aH, -aR * sin(ang), 1.0);
        gl_Position = projectionMatrix * mv;
        gl_PointSize = aSize * uPix * (26.0 / -mv.z);
        vT = pow(aR / ${rin}, -0.75);
        vA = smoothstep(uRin, uRin * 1.25, aR) * (0.55 + 0.45 * sin(aSeed * 6.2832 + uTime * 1.3));
      }`,
    fragmentShader: /* glsl */`
      uniform float uLevel; varying float vT, vA;
      ${GLSL_NOISE}
      void main(){ float d = length(gl_PointCoord - 0.5); float a = smoothstep(0.5, 0.0, d); gl_FragColor = vec4(bb(vT) * a * a * vA * uLevel * 0.18, 1.0); }`,
  });
  const points = new THREE.Points(pgeo, pMat);
  points.frustumCulled = false;
  scene.add(points);

  /* the X-ray hot spot: a compact blue-violet corona just above the black hole */
  // drawn with normal blending in a saturated violet so it stays visible on top of the white-hot disc
  const corTex = glowTexture('rgba(250,246,255,1)', 'rgba(150,115,255,.97)', 'rgba(105,70,255,.55)');
  const corona = new THREE.Sprite(new THREE.SpriteMaterial({ map: corTex, color: 0xffffff, depthWrite: false, transparent: true }));
  corona.position.set(0, 2.3, 0);
  corona.renderOrder = 12;
  primary.add(corona);
  const corHalo = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture('rgba(170,140,255,.9)', 'rgba(130,100,255,.5)', 'rgba(100,70,255,.15)'), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
  corHalo.position.copy(corona.position);
  corHalo.renderOrder = 12;
  primary.add(corHalo);
  const corCore = new THREE.Mesh(new THREE.SphereGeometry(0.22, 24, 16), new THREE.MeshBasicMaterial({ color: 0xc9bcff }));
  corCore.position.copy(corona.position);
  corCore.renderOrder = 12;
  primary.add(corCore);

  /* small discs around each black hole when there is a binary */
  const miniMat = (hot, rIn, rOut, tint) => new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    uniforms: { uTime: discUniforms.uTime, uLevel: { value: 0 }, uHot: { value: hot }, uRi: { value: rIn }, uRo: { value: rOut }, uTint: { value: new THREE.Color(tint) } },
    vertexShader: 'varying vec2 vP; void main(){ vP = position.xz; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
    fragmentShader: /* glsl */`
      uniform float uTime, uLevel, uHot, uRi, uRo; uniform vec3 uTint; varying vec2 vP;
      ${GLSL_NOISE}
      void main(){
        float r = length(vP); float ang = atan(-vP.y, vP.x);
        float a = ang - uTime * 2.2 * pow(r / uRi, -1.5) + 2.0 * log(r);
        float n = fbm(vec3(cos(a) * 2.0, sin(a) * 2.0, r * 3.0));
        float T = pow(r / uRi, -0.75) * uHot;
        float e = smoothstep(uRi, uRi * 1.15, r) * (1.0 - smoothstep(uRo * 0.7, uRo, r));
        gl_FragColor = vec4(uTint * e * (0.4 + 1.0 * n) * pow(T, 1.3) * uLevel * 0.42, 1.0);
      }`,
  });
  const pMini = new THREE.Mesh(new THREE.RingGeometry(1.25, 2.1, 96, 8).rotateX(-Math.PI / 2), miniMat(1.0, 1.25, 2.1, 0xffc995));
  primary.add(pMini);

  const secondary = new THREE.Group();
  scene.add(secondary);
  const bh2 = new THREE.Mesh(new THREE.SphereGeometry(0.62, 32, 20), bhMat);
  const ring2 = new THREE.Mesh(new THREE.PlaneGeometry(5, 5), new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    uniforms: { uLevel: { value: 0 } },
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv - 0.5; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: 'uniform float uLevel; varying vec2 vUv; void main(){ float r = length(vUv) * 5.0; float g = (exp(-pow((r - 0.67) / 0.035, 2.0)) * 1.0 + exp(-pow((r - 0.75) / 0.15, 2.0)) * 0.12) * smoothstep(0.62, 0.65, r); gl_FragColor = vec4(vec3(0.62, 0.9, 1.0) * g * uLevel, 1.0); }',
  }));
  const sMini = new THREE.Mesh(new THREE.RingGeometry(0.72, 1.45, 72, 6).rotateX(-Math.PI / 2), miniMat(1.2, 0.72, 1.45, 0xbfeaff));
  bh2.renderOrder = 10;
  ring2.renderOrder = 11;
  secondary.add(bh2, ring2, sMini);

  /* the secondary's path, drawn as a faint circle */
  const a2 = SEP / (1 + Q_RATIO), a1 = SEP * Q_RATIO / (1 + Q_RATIO);
  const orbitPts = [];
  for (let k = 0; k <= 128; k++) { const t = k / 128 * Math.PI * 2; orbitPts.push(new THREE.Vector3(a2 * Math.cos(t), 0, -a2 * Math.sin(t))); }
  const skyCol = getComputedStyle(host).getPropertyValue('--inst-sky').trim() || '#9fe0ff';   /* shared palette, play.css */
  const orbitMat = new THREE.LineDashedMaterial({ color: skyCol, dashSize: 0.35, gapSize: 0.25, transparent: true, opacity: 0 });
  const orbit = new THREE.Line(new THREE.BufferGeometry().setFromPoints(orbitPts), orbitMat);
  orbit.computeLineDistances();
  scene.add(orbit);

  /* post-processing */
  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new THREE.Vector2(512, 256), 0.42, 0.45, 0.4);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());

  let W = 1, H = 1;
  function resize() {
    W = Math.max(1, host.clientWidth); H = Math.max(1, host.clientHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, small() ? 1.5 : 1.75));
    renderer.setSize(W, H, false);
    composer.setPixelRatio(renderer.getPixelRatio());
    composer.setSize(W, H);
    bloom.setSize(W, H);
    camera.aspect = W / H;
    const tf = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
    const dist = Math.max(14.5 / (tf * camera.aspect), 9.5 / tf);
    const dir = camera.position.clone().sub(controls.target).normalize();
    camera.position.copy(controls.target).addScaledVector(dir, dist);
    camera.updateProjectionMatrix();
    pMat.uniforms.uPix.value = renderer.getPixelRatio() * (H / 420);
  }
  const ro = new ResizeObserver(resize);
  ro.observe(host);
  resize();
  renderer.domElement.addEventListener('webglcontextlost', (e) => e.preventDefault());

  let time = 0, bmix = 0, disc = 1, cor = 1, xrayMix = 0;
  const v3 = new THREE.Vector3(), right = new THREE.Vector3();
  const toScreen = (p) => { v3.copy(p).project(camera); return v3.z < 1 ? [(v3.x * 0.5 + 0.5) * W, (-v3.y * 0.5 + 0.5) * H] : null; };

  function frame(st, dt) {
    dt = Math.min(0.05, dt || 0.016);
    if (!reduced) time += dt;
    const k = reduced ? 1 : 1 - Math.exp(-dt / 0.05);
    disc += (st.disc - disc) * k;
    cor += (st.corona - cor) * k;
    xrayMix += ((st.xrayOn ? 1 : 0) - xrayMix) * (reduced ? 1 : 1 - Math.exp(-dt / 0.3));
    bmix += ((st.binary.on ? 1 : 0) - bmix) * (reduced ? 1 : 1 - Math.exp(-dt / 0.4));
    const eb = bmix * bmix * (3 - 2 * bmix);

    discUniforms.uTime.value = time;
    discUniforms.uLevel.value = disc;
    discUniforms.uRin.value = R_IN + (R_CAV - R_IN) * eb;
    discUniforms.uSecAng.value = st.binary.angle;
    discUniforms.uSecOn.value = eb;
    discUniforms.uCam.value.copy(camera.position);

    const th = st.binary.angle;
    primary.position.set(-a1 * eb * Math.cos(th), 0, a1 * eb * Math.sin(th));
    const pScale = 1 - 0.3 * eb;
    bh.scale.setScalar(pScale); ring.scale.setScalar(pScale);
    secondary.position.set(a2 * Math.cos(th), 0, -a2 * Math.sin(th));
    secondary.scale.setScalar(Math.max(0.001, eb));
    secondary.visible = eb > 0.01;
    pMini.material.uniforms.uLevel.value = disc * eb;
    sMini.material.uniforms.uLevel.value = disc * eb;
    ring2.material.uniforms.uLevel.value = eb;
    ring2.quaternion.copy(camera.quaternion);
    orbitMat.opacity = 0.55 * eb;
    orbit.visible = eb > 0.01;

    // X-ray hot spot: only lit when the X-ray band is in play, and it follows that curve
    const cl = Math.pow(Math.max(0.2, cor), 1.15);
    corona.scale.setScalar((1.1 + 2.3 * cl) * (0.35 + 0.65 * xrayMix));
    corona.material.opacity = Math.min(1, 0.97 * xrayMix);
    corHalo.scale.setScalar((1.8 + 2.6 * cl) * xrayMix);
    corHalo.material.opacity = Math.min(1, 0.45 * xrayMix * Math.min(1.5, cl));
    corCore.visible = xrayMix > 0.05;
    corCore.scale.setScalar(0.6 + 0.6 * cl);

    ring.quaternion.copy(camera.quaternion);
    ringMat.uniforms.uLevel.value = 0.5 + 0.5 * disc;

    controls.update(dt);
    composer.render(dt);

    // where to put the name tags
    primary.updateMatrixWorld();
    const out = {};
    const pc = toScreen(primary.getWorldPosition(new THREE.Vector3()));
    if (pc) out.bh = [pc[0] - 110, pc[1] + 26];
    right.setFromMatrixColumn(camera.matrixWorld, 0); right.y = 0; right.normalize();
    const de = toScreen(right.clone().multiplyScalar(R_OUT * 0.72));
    if (de) out.disc = [de[0] - 60, de[1] + 16];
    if (st.xrayOn) { const c = toScreen(corona.getWorldPosition(new THREE.Vector3())); if (c) out.cor = [c[0] - 150, c[1] - 44]; }
    if (st.binary.on && eb > 0.3) { const s = toScreen(secondary.getWorldPosition(new THREE.Vector3())); if (s) out.sec = [s[0] + 14, s[1] - 34]; }
    out.w = W; out.h = H;
    return out;
  }

  return {
    frame,
    setReduced(r) { reduced = r; controls.autoRotate = !r; },
    dispose() { ro.disconnect(); controls.dispose(); renderer.dispose(); },
  };
}
