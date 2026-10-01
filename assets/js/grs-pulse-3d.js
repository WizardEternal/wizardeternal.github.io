/*
  Take its pulse: the 3D view. three.js r169 (assets/vendor) through the import map
  in play/grs-pulse/index.html. The main script (grs-pulse.js) owns the data, the
  clock and the interpolation between the five fitted phases. It calls
  update(state) and render(dt) once per frame. Every quantity that moves arrives
  in `state`, from the paper's Tables 2 and 3 or from the Swift count rate.
*/
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

// Colour scale for the fitted inner disc temperature, 1.2 to 2.0 keV. The same
// stops are drawn as the legend bar in grs-pulse.css (.tbar), so the two agree.
const T_STOPS = [
  [0.3, '#4a1006'], [0.8, '#c8380f'], [1.2, '#ff3d12'], [1.376, '#ff7a1a'],
  [1.56, '#ffb347'], [1.68, '#ffe2b0'], [1.824, '#a9c4ff'], [2.0, '#6f8fff'], [2.6, '#5a78ff']
];
const GLSL_T = `
vec3 tcol(float T){
  ${T_STOPS.map((s, i) => `const vec3 c${i} = vec3(${new THREE.Color(s[1]).toArray().map(v => v.toFixed(4)).join(',')});`).join('\n  ')}
  ${T_STOPS.slice(1).map((s, i) => `if (T < ${s[0].toFixed(3)}) return mix(c${i}, c${i + 1}, clamp((T - ${T_STOPS[i][0].toFixed(3)}) / ${(s[0] - T_STOPS[i][0]).toFixed(3)}, 0.0, 1.0));`).join('\n  ')}
  return c${T_STOPS.length - 1};
}`;

const NOISE = `
float hash(vec2 p){ p = fract(p*vec2(123.34, 456.21)); p += dot(p, p+45.32); return fract(p.x*p.y); }
float vnoise(vec2 p){ vec2 i=floor(p), f=fract(p); vec2 u=f*f*(3.0-2.0*f);
  return mix(mix(hash(i),hash(i+vec2(1,0)),u.x), mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),u.x), u.y); }
float fbm(vec2 p){ float a=0.5, s=0.0; for(int i=0;i<4;i++){ s+=a*vnoise(p); p*=2.03; a*=0.5; } return s; }
float hash3(vec3 p){ p = fract(p*0.3183099 + .1); p *= 17.0; return fract(p.x*p.y*p.z*(p.x+p.y+p.z)); }
float noise3(vec3 x){ vec3 i=floor(x), f=fract(x); f=f*f*(3.0-2.0*f);
  return mix(mix(mix(hash3(i+vec3(0,0,0)),hash3(i+vec3(1,0,0)),f.x), mix(hash3(i+vec3(0,1,0)),hash3(i+vec3(1,1,0)),f.x),f.y),
             mix(mix(hash3(i+vec3(0,0,1)),hash3(i+vec3(1,0,1)),f.x), mix(hash3(i+vec3(0,1,1)),hash3(i+vec3(1,1,1)),f.x),f.y), f.z); }
`;

export const R_EDGE = 1.9;      // drawn inner edge of the disc. Fixed: the toy never moves it.
const R_OUT = 10.5;

// apparent inner radius (km) -> radius of the bright zone in scene units
export function zoneRadius(Rkm) { return R_EDGE + 0.55 + (Rkm / 38) * 3.9; }

export function createScene(host, tags, opts = {}) {
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    if (!renderer.getContext()) throw new Error('no context');
  } catch (e) {
    return null;
  }
  const reduced = !!opts.reducedMotion;
  const dprCap = 2;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, dprCap));
  // Pure black, like the other toys' stages. Anything lighter shows as a grey band
  // in the gap between the shadow and the disc's inner edge.
  renderer.setClearColor(0x000000, 1);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.85;
  const canvas = renderer.domElement;
  canvas.setAttribute('tabindex', '0');
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', 'A black hole with a thick accretion disc and a glowing corona above the inner disc. The disc colour and the corona follow the fitted values for the current heartbeat phase. Drag, or use the arrow keys, to turn the view.');
  host.appendChild(canvas);

  const scene = new THREE.Scene();
  scene.fog = null;
  const camera = new THREE.PerspectiveCamera(36, 1, 0.1, 200);
  camera.position.set(15.5, 8.2, 19.5);

  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.06;
  controls.enablePan = false;
  controls.minDistance = 11;
  controls.maxDistance = 42;
  controls.minPolarAngle = 0.22;
  controls.maxPolarAngle = 1.52;
  controls.rotateSpeed = 0.7;
  controls.zoomSpeed = 0.7;
  controls.autoRotate = !reduced;
  controls.autoRotateSpeed = 0.28;
  controls.target.set(0, 0.35, 0);
  controls.keys = { LEFT: 'ArrowLeft', UP: 'ArrowUp', RIGHT: 'ArrowRight', BOTTOM: 'ArrowDown' };
  controls.listenToKeyEvents(canvas);
  let userMoved = false;
  controls.addEventListener('start', () => { controls.autoRotate = false; userMoved = true; opts.onInteract && opts.onInteract(); });

  // ------------------------------------------------------------------ disc
  // Thick, flared disc from a lathe profile: top surface, rounded outer rim, bottom surface, inner rim.
  const prof = [];
  const hAt = r => 0.1 + 0.05 * (r - R_EDGE);
  const NR = 60;
  for (let i = 0; i <= NR; i++) { const r = R_EDGE + (R_OUT - R_EDGE) * Math.pow(i / NR, 1.35); prof.push(new THREE.Vector2(r, hAt(r))); }
  for (let i = 1; i < 10; i++) { const a = Math.PI / 2 - Math.PI * i / 10; prof.push(new THREE.Vector2(R_OUT + Math.cos(a) * 0.12, Math.sin(a) * hAt(R_OUT))); }
  for (let i = NR; i >= 0; i--) { const r = R_EDGE + (R_OUT - R_EDGE) * Math.pow(i / NR, 1.35); prof.push(new THREE.Vector2(r, -hAt(r))); }
  for (let i = 1; i < 8; i++) { const a = -Math.PI / 2 + Math.PI * i / 8; prof.push(new THREE.Vector2(R_EDGE - Math.cos(a) * 0.1, Math.sin(a) * hAt(R_EDGE))); }
  prof.push(prof[0].clone());
  const discGeo = new THREE.LatheGeometry(prof, 240);

  const discU = {
    uTime: { value: 0 }, uT: { value: 1.69 }, uZone: { value: zoneRadius(22.4) },
    uRate: { value: 0.5 }, uCor: { value: 0.1 }, uCorCol: { value: new THREE.Color('#b9c6ff') },
    uEdge: { value: R_EDGE }, uOut: { value: R_OUT }
  };
  const discMat = new THREE.ShaderMaterial({
    uniforms: discU,
    vertexShader: `
      varying vec3 vPos; varying vec3 vN; varying vec3 vW;
      void main(){ vPos = position; vN = normalize(normalMatrix*normal);
        vec4 w = modelMatrix*vec4(position,1.0); vW = w.xyz;
        gl_Position = projectionMatrix*viewMatrix*w; }`,
    fragmentShader: `
      uniform float uTime, uT, uZone, uRate, uCor, uEdge, uOut; uniform vec3 uCorCol;
      varying vec3 vPos; varying vec3 vN; varying vec3 vW;
      ${NOISE}
      ${GLSL_T}
      void main(){
        float r = length(vPos.xz);
        float th = atan(vPos.z, vPos.x);
        // Keplerian shear: inner rings turn faster
        float om = 1.6 * pow(r / uEdge, -1.5);
        float ang = th + uTime * om;
        vec2 q = vec2(r * 1.6, ang * 2.2);
        float n = fbm(vec2(q.x*1.3, q.y) + vec2(0.0, uTime*0.05));
        float streak = fbm(vec2(r*4.5, ang*6.0));
        // local temperature falls outward like r^-3/4, scaled by the fitted inner temperature
        float Tl = uT * pow(max(r, uEdge) / uEdge, -0.75) * (0.93 + 0.14*n);
        // bright zone: its outer edge sits at uZone (apparent emitting area, a fit number)
        float zone = 1.0 - smoothstep(uZone - 0.9, uZone + 0.35, r);
        float Tshow = mix(Tl * 0.9, uT * (0.96 + 0.08*n), zone);
        vec3 col = tcol(Tshow);
        float I = mix(0.18 + 0.42 * pow(uEdge / r, 1.0), 0.66, zone) * (0.6 + 0.7*n) * (0.65 + 0.55*streak);
        I *= 0.8 + 0.35 * uRate;
        // rim at the zone edge, so its size reads at a glance
        float ring = exp(-pow((r - uZone) / 0.12, 2.0));
        col += tcol(uT) * ring * 0.45;
        // top of the inner disc is lit by the corona when it is on
        float top = clamp(vN.y*0.5+0.5, 0.0, 1.0);
        col += uCorCol * uCor * top * 0.35 * exp(-(r - uEdge) / 2.0);
        // the outer rim and the underside stay dimmer
        float side = 1.0 - abs(normalize(vN).y);
        I *= mix(1.0, 0.45, side);
        float edgeA = 1.0 - smoothstep(uOut - 6.0, uOut - 0.3, r);
        gl_FragColor = vec4(col * I, edgeA * edgeA);
      }`
  });
  discMat.transparent = true;
  const disc = new THREE.Mesh(discGeo, discMat);
  disc.renderOrder = 0;
  scene.add(disc);

  // ------------------------------------------------------------ black hole
  // Drawn in the transparent list AFTER the corona, so its silhouette is pure black
  // wherever nothing solid (the near side of the disc) sits in front of it.
  const bhMat = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 1, depthWrite: true });
  const bh = new THREE.Mesh(new THREE.SphereGeometry(1.0, 64, 48), bhMat);
  bh.renderOrder = 10;
  scene.add(bh);
  // thin photon ring hugging the shadow, a camera-facing sprite; nothing is drawn inside the shadow
  const ringMat = new THREE.ShaderMaterial({
    uniforms: { uT: { value: 1.6 }, uGlow: { value: 1 } },
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    vertexShader: `varying vec2 vUv; void main(){ vUv = uv*2.0-1.0; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
    fragmentShader: `uniform float uT, uGlow; varying vec2 vUv; ${GLSL_T}
      void main(){ float r = length(vUv);
        float outside = smoothstep(0.356, 0.362, r);
        float ring = exp(-pow((r-0.366)/0.008,2.0))*1.1 + exp(-pow((r-0.38)/0.03,2.0))*0.18;
        vec3 c = mix(tcol(uT), vec3(1.0,0.93,0.85), 0.5);
        gl_FragColor = vec4(c*ring*outside*uGlow, 1.0); }`
  });
  const ring = new THREE.Mesh(new THREE.PlaneGeometry(5.6, 5.6), ringMat);
  ring.renderOrder = 11;
  scene.add(ring);

  // ---------------------------------------------------------------- corona
  // A soft cloud of overlapping glowing puffs above the inner disc. Colour follows kT_e,
  // brightness follows the Comptonisation normalisation (both from Table 3). With Swift
  // alone it is a faint grey haze, because 1-10 keV does not pin it down.
  const corU = {
    uTime: { value: 0 }, uOn: { value: 0 }, uI: { value: 0.6 }, uCol: { value: new THREE.Color('#8a74ff') },
    uFlash: { value: 0 }, uVH: { value: 800 }, uWorld: { value: 2.2 }
  };
  const corona = new THREE.Group();
  corona.position.set(0, 2.0, 0);
  scene.add(corona);
  const NPUFF = 70;
  const cPos = new Float32Array(NPUFF * 3), cSeed = new Float32Array(NPUFF);
  for (let i = 0; i < NPUFF; i++) {
    const th = Math.random() * Math.PI * 2, w = Math.pow(Math.random(), 0.8);
    cPos[i * 3] = Math.cos(th) * w * 2.1;
    cPos[i * 3 + 1] = (Math.random() - 0.5) * 0.9 * (1 - 0.5 * w);
    cPos[i * 3 + 2] = Math.sin(th) * w * 2.1;
    cSeed[i] = Math.random() * 50;
  }
  const cGeo = new THREE.BufferGeometry();
  cGeo.setAttribute('position', new THREE.BufferAttribute(cPos, 3));
  cGeo.setAttribute('seed', new THREE.BufferAttribute(cSeed, 1));
  const corMat = new THREE.ShaderMaterial({
    uniforms: corU, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    vertexShader: `
      attribute float seed; uniform float uTime, uVH, uWorld; varying float vSeed;
      void main(){ vSeed = seed;
        vec3 p = position + 0.18*vec3(sin(uTime*0.21+seed), 0.4*sin(uTime*0.17+seed*1.3), cos(uTime*0.19+seed*0.7));
        vec4 mv = modelViewMatrix*vec4(p,1.0);
        gl_PointSize = projectionMatrix[1][1] * uWorld * uVH * 0.5 / -mv.z;
        gl_Position = projectionMatrix*mv; }`,
    fragmentShader: `
      uniform float uTime, uOn, uI, uFlash; uniform vec3 uCol; varying float vSeed;
      ${NOISE}
      void main(){
        vec2 d = gl_PointCoord - 0.5; float r2 = dot(d,d)*4.0;
        if (r2 > 1.0) discard;
        float a = exp(-r2*3.2) * (1.0 - smoothstep(0.7, 1.0, r2));
        float n = noise3(vec3(gl_PointCoord*2.2 + vSeed, uTime*0.25 + vSeed));
        a *= 0.45 + 0.75*n;
        vec3 on = uCol * uI * 0.085;
        vec3 off = vec3(0.5,0.54,0.6) * 0.022;
        vec3 c = mix(off, on, uOn) + uCol * uFlash * 0.12;
        gl_FragColor = vec4(c * a, 1.0);
      }`
  });
  const cloud = new THREE.Points(cGeo, corMat);
  cloud.renderOrder = 2;
  corona.add(cloud);

  // hot electrons: a few hundred sparks inside the cloud that move faster when kT_e is higher
  const NP = 360;
  const pPos = new Float32Array(NP * 3), pSeed = new Float32Array(NP);
  for (let i = 0; i < NP; i++) {
    const th = Math.random() * Math.PI * 2, w = Math.sqrt(Math.random());
    pPos[i * 3] = Math.cos(th) * w * 2.0;
    pPos[i * 3 + 1] = (Math.random() - 0.5) * 0.8;
    pPos[i * 3 + 2] = Math.sin(th) * w * 2.0;
    pSeed[i] = Math.random() * 100;
  }
  const pGeo = new THREE.BufferGeometry();
  pGeo.setAttribute('position', new THREE.BufferAttribute(pPos, 3));
  pGeo.setAttribute('seed', new THREE.BufferAttribute(pSeed, 1));
  const pU = { uTime: { value: 0 }, uSpeed: { value: 1 }, uOn: { value: 0 }, uCol: corU.uCol, uPx: { value: renderer.getPixelRatio() } };
  const pMat = new THREE.ShaderMaterial({
    uniforms: pU, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    vertexShader: `
      attribute float seed; uniform float uTime, uSpeed, uPx; varying float vA;
      void main(){ float t = uTime*uSpeed + seed;
        vec3 p = position + 0.12*vec3(sin(t*3.1+seed), 0.5*sin(t*2.3+seed*1.7), cos(t*2.7+seed*0.3));
        vec4 mv = modelViewMatrix*vec4(p,1.0);
        vA = 0.5 + 0.5*sin(t*5.0 + seed*3.0);
        gl_PointSize = (1.2 + 1.4*vA) * uPx * (16.0 / -mv.z);
        gl_Position = projectionMatrix*mv; }`,
    fragmentShader: `uniform float uOn; uniform vec3 uCol; varying float vA;
      void main(){ vec2 d = gl_PointCoord-0.5; float a = exp(-dot(d,d)*18.0);
        gl_FragColor = vec4(mix(vec3(1.0), uCol, 0.5) * a * vA * uOn * 0.55, 1.0); }`
  });
  const sparks = new THREE.Points(pGeo, pMat);
  sparks.renderOrder = 3;
  corona.add(sparks);

  // expanding shell of hard X-rays, fired when AstroSat is switched on
  const waveMat = new THREE.ShaderMaterial({
    uniforms: { uA: { value: 0 }, uCol: { value: new THREE.Color('#a9c0ff') } },
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    vertexShader: `varying vec3 vN; varying vec3 vV; void main(){ vec4 mv = modelViewMatrix*vec4(position,1.0); vN = normalize(normalMatrix*normal); vV = normalize(-mv.xyz); gl_Position = projectionMatrix*mv; }`,
    fragmentShader: `uniform float uA; uniform vec3 uCol; varying vec3 vN; varying vec3 vV;
      void main(){ float f = 1.0 - abs(dot(normalize(vN), normalize(vV))); gl_FragColor = vec4(uCol * pow(f, 2.5) * uA, 1.0); }`
  });
  const wave = new THREE.Mesh(new THREE.SphereGeometry(1, 64, 32), waveMat);
  wave.visible = false;
  wave.renderOrder = 4;
  scene.add(wave);
  let waveT = -1;

  // ------------------------------------------------------------ post chain
  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new THREE.Vector2(512, 512), 0.4, 0.28, 0.6);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());

  // ------------------------------------------------------------- the tags
  const tagDefs = [
    { el: tags.bh, pos: () => new THREE.Vector3(0, -1.05, 0), side: 'above', off: 30 },
    { el: tags.disc, pos: () => side3(-8.4, 0.5), side: 'below', off: 30 },
    { el: tags.glow, pos: () => side3(discU.uZone.value * 0.98, 0.2), side: 'below', off: 58 },
    { el: tags.corona, pos: () => new THREE.Vector3(0, 2.0 + 0.55, 0), side: 'below', off: 40 }
  ].filter(d => d.el);
  for (const d of tagDefs) d.el.dataset.anchor = d.side;
  // a point on the disc plane to the left (negative) or right of the view, so tags stay put while the camera turns
  const _r = new THREE.Vector3();
  function side3(dist, y) {
    _r.set(camera.matrixWorld.elements[0], 0, camera.matrixWorld.elements[2]).normalize();
    return new THREE.Vector3(_r.x * dist, y, _r.z * dist);
  }
  let W = 1, H = 1;
  const v3 = new THREE.Vector3();
  function placeTags() {
    for (const d of tagDefs) {
      v3.copy(d.pos()).project(camera);
      if (v3.z > 1) { d.el.style.opacity = '0'; continue; }
      d.el.style.opacity = '';
      const x = (v3.x * 0.5 + 0.5) * W, y = (-v3.y * 0.5 + 0.5) * H;
      const h = d.el.offsetHeight || 24, w = d.el.offsetWidth || 80;
      const cx = Math.max(w / 2 + 6, Math.min(W - w / 2 - 6, x));
      const cy = d.side === 'below' ? y - d.off - h / 2 : y + d.off + h / 2;
      d.el.style.transform = `translate(${(cx - w / 2).toFixed(1)}px, ${(cy - h / 2).toFixed(1)}px)`;
      const line = d.el.querySelector('i');
      if (line) { line.style.height = d.off + 'px'; line.style.left = (x - (cx - w / 2)).toFixed(1) + 'px'; }
    }
  }

  function resize() {
    const r = host.getBoundingClientRect();
    W = Math.max(1, Math.round(r.width)); H = Math.max(1, Math.round(r.height));
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, dprCap));
    renderer.setSize(W, H, false);
    composer.setPixelRatio(renderer.getPixelRatio());
    composer.setSize(W, H);
    pU.uPx.value = renderer.getPixelRatio();
    corU.uVH.value = H * renderer.getPixelRatio();
    camera.aspect = W / H;
    // pull the camera back on narrow screens so the disc fits
    camera.fov = W / H < 0.9 ? 50 : 36;
    camera.updateProjectionMatrix();
  }
  const ro = new ResizeObserver(resize);
  ro.observe(host);
  resize();

  // ---------------------------------------------------------------- state
  const corColLo = new THREE.Color('#7a5cff'), corColHi = new THREE.Color('#8fd2ff');
  let time = 0, flash = 0;
  function update(s) {
    discU.uT.value = s.T;
    discU.uZone.value = zoneRadius(s.R);
    discU.uRate.value = s.rate;
    ringMat.uniforms.uT.value = s.T;
    // corona: colour from kTe (6 to 14 keV), strength from the Comptonisation normalisation
    const k = Math.max(0, Math.min(1, (s.kTe - 6) / 8));
    corU.uCol.value.copy(corColLo).lerp(corColHi, k);
    discU.uCorCol.value.copy(corU.uCol.value);
    corU.uOn.value = s.m;
    corU.uI.value = 0.35 + 1.0 * Math.max(0, (s.norm - 0.2) / 0.3);
    discU.uCor.value = s.m * corU.uI.value;
    pU.uOn.value = s.m;
    pU.uSpeed.value = reduced ? 0.15 : 0.35 + 0.09 * s.kTe;
    const sc = 1 + 0.14 * s.m * Math.max(0, (s.norm - 0.25) / 0.25);
    corona.scale.set(sc, sc, sc);
    bloom.strength = 0.28 + 0.2 * s.rate;
  }
  function fireWave() {
    if (reduced) { flash = 0.6; return; }
    waveT = 0; wave.visible = true; flash = 1;
  }
  function render(dt) {
    time += reduced ? dt * 0.25 : dt;
    discU.uTime.value = time;
    corU.uTime.value = time;
    pU.uTime.value = time;
    if (waveT >= 0) {
      waveT += dt;
      const p = waveT / 1.6;
      const s = 1.5 + p * 16;
      wave.scale.set(s, s * 0.55, s);
      wave.position.y = 2.0;
      waveMat.uniforms.uA.value = Math.max(0, 1 - p) * 0.45;
      if (p >= 1) { waveT = -1; wave.visible = false; }
    }
    flash = Math.max(0, flash - dt * 0.9);
    corU.uFlash.value = flash;
    ring.quaternion.copy(camera.quaternion);
    controls.update();
    composer.render();
    placeTags();
  }
  function dispose() { ro.disconnect(); controls.dispose(); renderer.dispose(); }
  return { update, render, resize, fireWave, dispose, get userMoved() { return userMoved; } };
}
