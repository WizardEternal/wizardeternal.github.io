// WebGL2 plumbing: programs, HDR targets, bloom chain, adaptive resolution.
import { VERT, SCENE, DOWN, UP, COMPOSITE } from './shaders.js';

function compile(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(s);
    gl.deleteShader(s);
    throw new Error('Shader compile failed: ' + log);
  }
  return s;
}

function program(gl, fs) {
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, VERT));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
  gl.bindAttribLocation(p, 0, 'aPos');
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('Link failed: ' + gl.getProgramInfoLog(p));
  const loc = {};
  const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < n; i++) {
    const info = gl.getActiveUniform(p, i);
    const name = info.name.replace(/\[0\]$/, '');
    loc[name] = gl.getUniformLocation(p, info.name);
  }
  return { p, loc };
}

// Tileable smooth noise: a sum of random plane waves with integer wave vectors, so it
// wraps exactly on the unit square and has no lattice artefacts. Computed once on the CPU.
function makeNoise(size = 256) {
  const data = new Uint8Array(size * size * 4);
  let seed = 12345;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  const waves = [];
  const bands = [[2, 4, 10, 1.0], [4, 8, 14, 0.55], [8, 16, 18, 0.3], [16, 28, 22, 0.16]];
  for (const [kmin, kmax, n, amp] of bands) {
    for (let i = 0; i < n; i++) {
      const k = kmin + rnd() * (kmax - kmin), th = rnd() * Math.PI * 2;
      waves.push([Math.round(k * Math.cos(th)), Math.round(k * Math.sin(th)), rnd() * Math.PI * 2, amp / Math.sqrt(n)]);
    }
  }
  const vals = new Float32Array(size * size);
  let lo = Infinity, hi = -Infinity;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let v = 0;
    for (const [kx, ky, ph, a] of waves) v += a * Math.cos(2 * Math.PI * (kx * x + ky * y) / size + ph);
    vals[y * size + x] = v; lo = Math.min(lo, v); hi = Math.max(hi, v);
  }
  for (let i = 0; i < size * size; i++) {
    const t = (vals[i] - lo) / (hi - lo);
    const val = Math.round(Math.max(0, Math.min(1, (t - 0.12) / 0.76)) * 255);
    data[i * 4] = val; data[i * 4 + 1] = val; data[i * 4 + 2] = val; data[i * 4 + 3] = 255;
  }
  return data;
}

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, depth: false, stencil: false, powerPreference: 'high-performance', preserveDrawingBuffer: false });
    if (!gl) throw new Error('WebGL2 is not available');
    this.gl = gl;
    this.hdr = !!gl.getExtension('EXT_color_buffer_float') || !!gl.getExtension('EXT_color_buffer_half_float');
    this.scene = program(gl, SCENE);
    this.down = program(gl, DOWN);
    this.up = program(gl, UP);
    this.comp = program(gl, COMPOSITE);

    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    // disc rotation phases
    this.phaseData = new Float32Array(512 * 4);
    this.phaseTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.phaseTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, 512, 1, 0, gl.RGBA, gl.FLOAT, this.phaseData);
    this.setNearest();

    this.noiseTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.noiseTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 256, 256, 0, gl.RGBA, gl.UNSIGNED_BYTE, makeNoise(256));
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);

    this.targets = null;
    this.scale = 0.75;         // render scale relative to device pixels
    this.maxDpr = 1.5;
    this.frameTimes = [];
    this.lastSizeKey = '';
  }

  setNearest() {
    const gl = this.gl;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  makeTarget(w, h) {
    const gl = this.gl;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    if (this.hdr) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
    else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    return { tex, fb, w, h };
  }

  resize() {
    const gl = this.gl;
    const dpr = Math.min(window.devicePixelRatio || 1, this.maxDpr);
    const cw = Math.max(2, Math.round((this.cssW || this.canvas.clientWidth) * dpr));
    const ch = Math.max(2, Math.round((this.cssH || this.canvas.clientHeight) * dpr));
    if (this.canvas.width !== cw || this.canvas.height !== ch) { this.canvas.width = cw; this.canvas.height = ch; }
    if (!this.scaleSet && !this.fixed) { this.scaleSet = true; this.scale = Math.min(0.85, Math.max(0.4, Math.sqrt(9e5 / (cw * ch)))); }
    const sw = Math.max(2, Math.round(cw * this.scale)), sh = Math.max(2, Math.round(ch * this.scale));
    const key = `${cw}x${ch}@${sw}x${sh}`;
    if (key === this.lastSizeKey) return;
    this.lastSizeKey = key;
    if (this.targets) {
      for (const t of [this.targets.scene, ...this.targets.mips]) { gl.deleteTexture(t.tex); gl.deleteFramebuffer(t.fb); }
    }
    const scene = this.makeTarget(sw, sh);
    const mips = [];
    let w = Math.max(2, sw >> 1), h = Math.max(2, sh >> 1);
    for (let i = 0; i < 6; i++) { mips.push(this.makeTarget(w, h)); w = Math.max(2, w >> 1); h = Math.max(2, h >> 1); }
    this.targets = { scene, mips };
  }

  // Feed measured frame time; adjust render scale in steps to hold ~50-60 fps.
  adapt(ms) {
    this.frameTimes.push(ms);
    if (this.frameTimes.length < 24) return;
    const sorted = this.frameTimes.slice().sort((a, b) => a - b);
    const med = sorted[sorted.length >> 1];
    this.frameTimes.length = 0;
    let s = this.scale;
    if (med > 24) s *= 0.85;
    else if (med > 19) s *= 0.93;
    else if (med < 17.4 && s < 0.9) s *= 1.04;
    s = Math.min(1, Math.max(0.35, s));
    if (Math.abs(s - this.scale) > 0.01) { this.scale = s; this.resize(); }
  }

  setUniforms(prog, u) {
    const gl = this.gl;
    for (const [name, val] of Object.entries(u)) {
      const l = prog.loc[name];
      if (l === undefined || l === null) continue;
      if (typeof val === 'number') {
        if (name === 'uMode' || name === 'uMaxSteps' || name === 'uDebug') gl.uniform1i(l, val); else gl.uniform1f(l, val);
      } else if (val.length === 2) gl.uniform2fv(l, val);
      else if (val.length === 3) gl.uniform3fv(l, val);
      else if (val.length === 9 && name === 'uFlowRot') gl.uniformMatrix3fv(l, false, val);
      else if (val.length === 4) gl.uniform4fv(l, val);
      else gl.uniform4fv(l, val);
    }
  }

  render(sceneU, post) {
    const gl = this.gl;
    this.resize();
    const { scene, mips } = this.targets;
    gl.bindVertexArray(this.vao);
    gl.disable(gl.BLEND);

    // phase texture
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.phaseTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 512, 1, gl.RGBA, gl.FLOAT, this.phaseData);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.noiseTex);

    gl.bindFramebuffer(gl.FRAMEBUFFER, scene.fb);
    gl.viewport(0, 0, scene.w, scene.h);
    gl.useProgram(this.scene.p);
    gl.uniform1i(this.scene.loc.uPhaseTex, 0);
    gl.uniform1i(this.scene.loc.uNoise, 1);
    this.setUniforms(this.scene, { ...sceneU, uRes: [scene.w, scene.h] });
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    // bloom: downsample chain
    gl.useProgram(this.down.p);
    gl.uniform1i(this.down.loc.uSrc, 0);
    let src = scene;
    for (let i = 0; i < mips.length; i++) {
      const dst = mips[i];
      gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fb);
      gl.viewport(0, 0, dst.w, dst.h);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, src.tex);
      gl.uniform2f(this.down.loc.uTexel, 1 / src.w, 1 / src.h);
      gl.uniform1f(this.down.loc.uThreshold, i === 0 ? post.threshold : 0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      src = dst;
    }
    // upsample with additive blending
    gl.useProgram(this.up.p);
    gl.uniform1i(this.up.loc.uSrc, 0);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    for (let i = mips.length - 1; i > 0; i--) {
      const s = mips[i], d = mips[i - 1];
      gl.bindFramebuffer(gl.FRAMEBUFFER, d.fb);
      gl.viewport(0, 0, d.w, d.h);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, s.tex);
      gl.uniform2f(this.up.loc.uTexel, 1 / s.w, 1 / s.h);
      gl.uniform1f(this.up.loc.uRadius, 1.0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    gl.disable(gl.BLEND);

    // composite to screen
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.useProgram(this.comp.p);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, scene.tex);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, mips[0].tex);
    gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, mips[2].tex);
    gl.uniform1i(this.comp.loc.uScene, 0);
    gl.uniform1i(this.comp.loc.uBloom, 1);
    gl.uniform1i(this.comp.loc.uBloomWide, 2);
    this.setUniforms(this.comp, {
      uBloomStrength: post.bloom, uRes: [this.canvas.width, this.canvas.height],
      uCollapse: post.collapse, uPointFlux: post.pointFlux, uPointColor: post.pointColor, uTime: post.time,
    });
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    if (post.luma) this.lumaPass(post);
  }

  // A coarse copy of the final picture's brightness (64 x 40 cells) for the labels, which use it to stay
  // off bright parts. Every 8th frame the composite is drawn again into a tiny target and copied into a pixel
  // buffer; the CPU picks the pixels up 7 frames later, long after the GPU has finished, so the read never
  // stalls a frame. (A fence here made Chrome log a performance warning on every read.)
  lumaPass(post) {
    const gl = this.gl;
    const LW = 64, LH = 40;
    if (!this.lumaT) {
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, LW, LH, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      const fb = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      const pbo = gl.createBuffer();
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pbo);
      gl.bufferData(gl.PIXEL_PACK_BUFFER, LW * LH * 4, gl.STREAM_READ);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      this.lumaT = { tex, fb, pbo, W: LW, H: LH, pending: false, wrote: 0, buf: new Uint8Array(LW * LH * 4), n: 0 };
      this.luma = null;
    }
    const L = this.lumaT;
    L.n++;
    if (L.pending && L.n - L.wrote >= 7) {
      // read the buffer written 7 frames ago
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, L.pbo);
      gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, L.buf);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
      L.pending = false;
      const out = new Float32Array(LW * LH);
      for (let y = 0; y < LH; y++) for (let x = 0; x < LW; x++) {
        const i = ((LH - 1 - y) * LW + x) * 4;
        out[y * LW + x] = (0.2126 * L.buf[i] + 0.7152 * L.buf[i + 1] + 0.0722 * L.buf[i + 2]) / 255;
      }
      this.luma = { W: LW, H: LH, v: out, t: performance.now() };
      return;
    }
    if (L.pending || L.n % 8) return;
    gl.bindFramebuffer(gl.FRAMEBUFFER, L.fb);
    gl.viewport(0, 0, LW, LH);
    gl.drawArrays(gl.TRIANGLES, 0, 3);          // the composite program is still bound, with its uniforms
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, L.pbo);
    gl.readPixels(0, 0, LW, LH, gl.RGBA, gl.UNSIGNED_BYTE, 0);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    L.pending = true; L.wrote = L.n;
  }
}
