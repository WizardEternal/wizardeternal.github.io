// GLSL for the X-ray binary explorer (WebGL2).
// One ray-traced scene shader covers every scale: straight rays far from the black hole,
// and inside a sphere of radius uRgr around it the rays follow Schwarzschild null
// geodesics, integrated in Cartesian form x'' = -3 h^2 x / r^5 (h = |x cross x'|, lengths in GM/c^2),
// which reproduces the Binet equation u'' + u = 3 u^2 exactly for photon orbit shapes: photon sphere
// at r = 3, shadow edge at impact parameter sqrt(27). (The factor is -1.5 if lengths are in 2GM/c^2.)

export const VERT = /* glsl */`#version 300 es
in vec2 aPos;
out vec2 vUv;
void main() { vUv = aPos * 0.5 + 0.5; gl_Position = vec4(aPos, 0.0, 1.0); }
`;

export const SCENE = /* glsl */`#version 300 es
precision highp float;
precision highp int;
in vec2 vUv;
out vec4 fragColor;

uniform vec2 uRes;
uniform vec3 uCamPos;
uniform vec3 uCamR, uCamU, uCamF;
uniform float uTanFov;
uniform float uExposure;
uniform float uTime;
uniform float uTref;       // temperature that maps to the middle of the colour scale
uniform float uPixAng;     // angular size of one pixel (radians)
uniform float uTmap;       // set by app.js but unused (displayT scales by uTref)
uniform float uLumScale;   // (1e6 K / uTref)^0.8, converts fixed emitters to the zoom's brightness scale
uniform float uShowCirc;   // draw the circularisation radius on the disc
uniform float uRcirc;      // circularisation radius in R_g
uniform float uFade;       // close in, the disc beyond this radius is cut away so the view is not blocked

uniform float uA;          // binary separation in R_g
uniform float uOrb;        // orbital angle of the companion
uniform vec4 uRoche;       // m1, m2, xc, phiS
uniform vec4 uRoche2;      // xL1, bound, gMean, heat
uniform float uTstar;
uniform vec4 uDisc;        // rIn, rOut, hBase, hBulge
uniform float uPhiImp;
uniform float uTK;         // T^4 = uTK r^-3 (1 - sqrt(uRinT / r))
uniform float uRinT;
uniform vec4 uStream[48];  // x, y (units of a), arclength fraction, unused
uniform vec4 uStreamBox;   // xmin, xmax, ymin, ymax (units of a)
uniform vec4 uStreamG[6];  // bounding spheres of 8-segment groups: centre xyz, radius
uniform sampler2D uPhaseTex;
uniform sampler2D uNoise;

uniform float uSpin;
uniform float uRcap;
uniform float uRgr;
uniform int uMode;         // 0 plain, 1 Type-C, 2 RPM, 3 heartbeat
uniform vec4 uFlow;        // rIn, rOut, H/R, brightness
uniform mat3 uFlowRot;     // flow body frame -> world
uniform vec4 uBlob[6];     // position (R_g), amplitude
uniform vec3 uBlobV;       // blob 3-velocity (c)
uniform vec4 uHB;          // flare boost, fill, ring radius, ring amplitude
uniform float uJet;
uniform float uJetPhase;
uniform int uMaxSteps;
uniform int uDebug;
uniform float uStarGain;   // display gain for the companion (1 at binary scale, low close to the hole)
uniform float uFarGlow;    // 1 when the stream and bright spot are worth drawing, 0 close to the hole
uniform float uRingW;      // photon-ring half-width in impact parameter (R_g), about one render pixel
uniform float uBeam;       // exponent of the Doppler factor in the disc's brightness (4 = bolometric)

const float PI = 3.14159265359;
const float TAU = 6.28318530718;


// ------------------------------------------------------------ colour
vec3 blackbody(float t) {
  t = clamp(t, 800.0, 40000.0) / 100.0;
  float r = t <= 66.0 ? 1.0 : clamp(1.29293618606 * pow(t - 60.0, -0.1332047592), 0.0, 1.0);
  float g = t <= 66.0 ? clamp(0.39008157876 * log(t) - 0.63184144378, 0.0, 1.0)
                      : clamp(1.12989086089 * pow(t - 60.0, -0.0755148492), 0.0, 1.0);
  float b = t >= 66.0 ? 1.0 : (t <= 19.0 ? 0.0 : clamp(0.54320678911 * log(t - 10.0) - 1.19625408914, 0.0, 1.0));
  vec3 c = pow(vec3(r, g, b), vec3(2.2));
  return c / max(max(c.r, c.g), max(c.b, 1e-4));
}
// Colour: blackbody colour of a compressed temperature. uTref (the disc temperature at the scale in
// view) shows as deep orange; a factor 10 hotter is a factor 5.6 in colour temperature.
float displayT(float T) { return clamp(2300.0 * pow(max(T, 1.0) / uTref, 0.75), 900.0, 30000.0); }
// Brightness: compressed too. A factor 10 in T is a factor 5 in brightness, relative to uTref.
float lumT(float T) { return pow(max(T, 1.0) / uTref, 0.7); }
vec3 thermal(float T) { return blackbody(displayT(T)) * lumT(T); }

// ------------------------------------------------------------ helpers
mat2 rot(float a) { float c = cos(a), s = sin(a); return mat2(c, s, -s, c); }
float wrapPi(float a) { return a - TAU * floor((a + PI) / TAU); }
float noiseA(vec2 uv) { return texture(uNoise, uv).r; }
float noiseL(vec2 uv, float lod) { return textureLod(uNoise, uv, lod).r; }

// disc rotation phases: two cross-faded layers, per log10(r) bin
vec4 phaseAt(float r) {
  float x = clamp(log(max(r, 1.0)) / log(10.0) / 6.4, 0.0, 1.0) * 511.0;
  float i0 = floor(x);
  vec4 a = texelFetch(uPhaseTex, ivec2(int(i0), 0), 0);
  vec4 b = texelFetch(uPhaseTex, ivec2(int(min(i0 + 1.0, 511.0)), 0), 0);
  return mix(a, b, x - i0);
}

// Disc half-thickness in R_g (flares from H/R = 0.008 inside to hBase near the rim, plus the rim bulge
// where the stream lands). The last 10% of the radius is rounded off, so the edge is a lip, not a wall.
float discH(float r, float phi) {
  float lg = log(max(r, 1.0)) / log(10.0);
  float h = mix(0.008, uDisc.z, smoothstep(2.5, 4.9, lg));
  // the bulge is a raised lip just inside the edge, peaking at 0.86 rOut, strongest where the stream lands
  float xr = (r / uDisc.y - 0.86) / 0.06;
  float rim = exp(-xr * xr);
  float d = wrapPi(phi - uPhiImp - uOrb);
  float w = d > 0.0 ? 0.7 : 0.35;
  h += uDisc.w * exp(-(d / w) * (d / w)) * rim;
  if (uMode == 3) h += uHB.x * 0.012 * exp(-0.5 * pow((r - 6.0) / 4.0, 2.0)) * step(r, 30.0);
  float e = clamp((r - 0.9 * uDisc.y) / (0.1 * uDisc.y), 0.0, 1.0);
  return h * r * sqrt(max(1.0 - e * e, 0.0));
}
// Outward normal of the top (s = 1) or bottom (s = -1) surface z = s * discH.
vec3 discNormal(vec3 p, float s) {
  float r = max(length(p.xy), 1.0);
  float ep = 0.004 * r;
  float hx = discH(length(p.xy + vec2(ep, 0.0)), atan(p.y, p.x + ep)) - discH(length(p.xy - vec2(ep, 0.0)), atan(p.y, p.x - ep));
  float hy = discH(length(p.xy + vec2(0.0, ep)), atan(p.y + ep, p.x)) - discH(length(p.xy - vec2(0.0, ep)), atan(p.y - ep, p.x));
  vec2 g = vec2(hx, hy) / (2.0 * ep);
  return normalize(vec3(-g, 1.0) * vec3(1.0, 1.0, s));
}
// Streaky texture for one rotation layer, filtered by the pixel footprint so it never aliases.
// a: azimuth in the layer frame; fa: footprint along azimuth (rad); fr: footprint along ln r;
// shear: how far the layer has wound up (du per unit ln r from differential rotation).
float streaks(float a, float lr, float fa, float fr, float shear) {
  float u = a / TAU;
  float t1 = 256.0 * max(max(fa / TAU, fr * shear), fr * 2.5);
  float t2 = 256.0 * max(max(2.0 * fa / TAU, 2.0 * fr * shear), fr * 6.1);
  float n1 = textureLod(uNoise, vec2(u, lr * 2.5), clamp(log2(max(t1, 1e-4)) + 0.5, 0.0, 8.0)).r;
  float n2 = textureLod(uNoise, vec2(u * 2.0 + 0.3, lr * 6.1), clamp(log2(max(t2, 1e-4)) + 0.5, 0.0, 8.0)).r;
  return n1 * 0.6 + n2 * 0.4;
}

// ------------------------------------------------------------ Roche potential (units of a, corotating)
float roche(vec3 p) {
  float r1 = length(p), r2 = length(p - vec3(1.0, 0.0, 0.0));
  vec2 q = p.xy - vec2(uRoche.z, 0.0);
  return -uRoche.x / r1 - uRoche.y / r2 - 0.5 * dot(q, q);
}
vec3 rocheGrad(vec3 p) {
  float r1 = length(p), r2 = length(p - vec3(1.0, 0.0, 0.0));
  vec3 g = uRoche.x * p / (r1 * r1 * r1) + uRoche.y * (p - vec3(1.0, 0.0, 0.0)) / (r2 * r2 * r2);
  g.xy -= p.xy - vec2(uRoche.z, 0.0);
  return g;
}
bool insideStar(vec3 p) { return p.x > uRoche2.x && roche(p) < uRoche.w; }

// ------------------------------------------------------------ disc emission
// lamPh: photon angular momentum about z (per unit energy), for the redshift factor.
// pathL: distance the ray travelled to get here; bend: angle it was bent through (both for texture filtering).
vec3 discEmit(vec3 p, vec3 rd, vec3 nrm, float lamPh, float pathL, float bend) {
  float r = length(p.xy);
  float phi = atan(p.y, p.x);
  float rin = uRinT;
  // zero-torque inner edge: the flux goes to zero at rin. The colour uses a floored profile so the
  // last sliver does not turn deep red, and the brightness fades out smoothly instead.
  float fe = max(1.0 - sqrt(rin / r), 0.0);
  float T = pow(uTK / (r * r * r) * max(fe, 0.1), 0.25);
  float edgeIn = smoothstep(0.0, 0.1, max(1.0 - sqrt(uDisc.x / r), 0.0));   // fades in from the drawn inner edge
  float boost = 1.0;
  if (uMode == 3) {
    boost += uHB.x * exp(-0.5 * pow((r - 6.0) / 4.0, 2.0));
    boost += uHB.w * exp(-pow((r - uHB.z) / 0.9, 2.0));
  }
  // turbulent streaks that orbit at the local (display) Keplerian rate
  vec4 ph = phaseAt(r);
  float lr = log(r);
  float mu = abs(dot(nrm, rd));
  float fa = pathL * uPixAng / r;                                   // pixel footprint, radians of azimuth
  float fr = fa / max(mu, 0.035) * (1.0 + 5.0 * smoothstep(0.7, 2.8, bend)); // and in ln r (grazing, lensed)
  float n0 = streaks(phi - ph.x, lr, fa, fr, 1.5 * ph.x / TAU);
  float n1 = streaks(phi - ph.z + PI, lr + 0.37, fa, fr, 1.5 * ph.z / TAU);
  float n = clamp((n0 * ph.y + n1 * ph.w) / max(ph.y + ph.w, 0.05), 0.0, 1.0);
  float tex = 0.62 + 0.76 * smoothstep(0.1, 0.9, n);
  // two-armed tidal spiral in the outer disc, fixed in the binary frame
  float spiral = 1.0 + 0.22 * smoothstep(0.35 * uDisc.y, 0.8 * uDisc.y, r) * cos(2.0 * (phi - uOrb) - 5.0 * log(r / uDisc.y));
  tex *= spiral;
  // bright spot where the stream hits the rim
  float dphi = wrapPi(phi - uPhiImp - uOrb);
  float spot = exp(-pow(dphi / 0.07, 2.0)) * smoothstep(0.9 * uDisc.y, uDisc.y, r);
  float Tspot = mix(T, 16000.0, spot);
  T = max(T, Tspot);
  // relativistic redshift for a circular equatorial orbit (Kerr u^t and Omega)
  float g = 1.0;
  if (r < 3.0e4) {
    float rs = sqrt(r), r15 = r * rs;
    float ut = (r15 + uSpin) / (sqrt(rs) * rs * sqrt(max(r15 - 3.0 * rs + 2.0 * uSpin, 1e-4)));
    float om = 1.0 / (r15 + uSpin);
    g = 1.0 / (ut * max(1.0 - om * lamPh, 0.05));
  }
  float limb = 0.45 + 0.55 * mu;
  // soft outer edge: the last part of the lip fades toward the dark
  float edgeOut = mix(0.3, 1.0, smoothstep(uDisc.y, 0.86 * uDisc.y, r));
  float Tobs = T * g * pow(boost, 0.25);
  vec3 c = blackbody(displayT(Tobs)) * lumT(T) * pow(boost, 0.45) * pow(g, uBeam) * limb * tex * edgeIn * edgeOut;
  if (uShowCirc > 0.01) c += vec3(0.35, 0.75, 0.9) * uShowCirc * exp(-pow((r - uRcirc) / (0.004 * uRcirc), 2.0)) * lumT(T) * 0.9;
  return c;
}

// ------------------------------------------------------------ jet
float jetKnots(float z) { return 0.55 + 0.45 * pow(0.5 + 0.5 * sin(TAU * (log(z) * 2.2 - uJetPhase)), 3.0); }
float jetDoppler(float zsign, vec3 kph) {
  float beta = 0.9, gam = 2.294;
  float d = 1.0 / (gam * (1.0 - beta * zsign * kph.z));
  // a steady flat-spectrum jet brightens as D^2 (D^3 is for a single blob)
  return min(d * d, 60.0);
}
// The jet's brightness falls as z^-0.5 along its length, far slower than a real jet's, so the column
// reads at every zoom. Blue-white, whiter near the base.
vec3 jetColor(float z) { return mix(vec3(0.8, 0.86, 1.0), vec3(0.42, 0.55, 1.0), smoothstep(4.0, 20.0, z)); }
vec3 jetStraight(vec3 ro, vec3 rd, float t0, float t1) {
  if (uJet < 0.01) return vec3(0.0);
  float a2 = dot(rd.xy, rd.xy);
  if (a2 < 1e-5) return vec3(0.0);
  float tsU = -dot(ro.xy, rd.xy) / a2;
  float ts = clamp(tsU, t0, t1);
  vec3 p0 = ro + rd * ts;
  float wEdge = 0.6 + 0.05 * abs(p0.z);
  float edge = exp(-pow(abs(tsU - ts) * sqrt(a2) / wEdge, 2.0));
  vec3 p = p0;
  float z = abs(p.z);
  if (z < 8.0) return vec3(0.0);
  float d = length(p.xy);
  float w = 0.6 + 0.05 * z;
  float prof = exp(-(d / w) * (d / w)) * pow(z, -0.5) * jetKnots(z) * smoothstep(8.0, 20.0, z) * exp(-z / (0.8 * uA));
  float path = w * 1.772 / sqrt(a2);
  return jetColor(z) * uJet * 12.0 * uLumScale * edge * prof * min(path, 40.0 * w) / w * jetDoppler(sign(p.z), -rd);
}
vec3 jetVolume(vec3 p, vec3 kph) {
  float z = abs(p.z);
  if (z < 4.0) return vec3(0.0);
  float d = length(p.xy);
  float w = 0.6 + 0.05 * z;
  // starts at z = 4, above the photon sphere
  float prof = exp(-(d / w) * (d / w)) * pow(z, -0.5) * jetKnots(z) * smoothstep(4.0, 14.0, z);
  return jetColor(z) * uJet * 12.0 * uLumScale * prof / w * jetDoppler(sign(p.z), kph);
}

// ------------------------------------------------------------ volumetric inner emitters
// returns emission (rgb) per unit length and an absorption coefficient in .a
vec4 innerVolume(vec3 p, vec3 kph) {
  vec3 em = vec3(0.0);
  float kap = 0.0;
  float r = length(p);
  if (uMode == 1) {
    vec3 pb = transpose(uFlowRot) * p;
    float rb = length(pb.xy);
    if (rb > uFlow.x - 1.5 && rb < uFlow.y + 3.5) {
      float H = uFlow.z * rb;
      float tin = smoothstep(uFlow.x - 1.5, uFlow.x + 0.5, rb);
      float tout = 1.0 - smoothstep(uFlow.y - 7.0, uFlow.y + 3.0, rb);
      float rho = pow(uFlow.x / rb, 3.0) * tin * tout * exp(-0.5 * (pb.z / H) * (pb.z / H));
      if (rho > 1e-3) {
        float phb = atan(pb.y, pb.x);
        vec4 ph = phaseAt(rb);
        float lr = log(rb);
        // soft billows that vary in height too, so the fog has no vertical streaks
        float zq = pb.z / H;
        float n0 = noiseL(vec2((phb - ph.x) / TAU * 3.0 + zq * 0.11, lr * 2.6 + zq * 0.23), 1.2);
        float n1 = noiseL(vec2((phb - ph.z) / TAU * 3.0 + 0.5 - zq * 0.09, lr * 2.6 + 0.5 + zq * 0.19), 1.2);
        float n = clamp((n0 * ph.y + n1 * ph.w) / max(ph.y + ph.w, 0.05), 0.0, 1.0);
        float tex = 0.6 + 0.8 * n;
        vec3 vdir = uFlowRot * vec3(-sin(phb), cos(phb), 0.0);
        float beta = min(0.8 / sqrt(max(rb - 2.0, 0.6)), 0.6);
        float gam = 1.0 / sqrt(1.0 - beta * beta);
        float g = sqrt(max(1.0 - 2.0 / max(r, 2.2), 0.1)) / (gam * (1.0 - beta * dot(vdir, kph)));
        // Colour: the flow is hotter than any of the disc, so on the display scale it is white at its dense
        // inner edge and blue-violet further out, brightest where it is densest.
        float hot = clamp((uFlow.x / rb) * g * g, 0.0, 1.4);
        vec3 fc = mix(vec3(0.50, 0.55, 1.0), vec3(1.0, 0.95, 0.97), smoothstep(0.35, 1.0, hot));
        em += fc * rho * tex * pow(g, 3.0) * uFlow.w * uLumScale * 0.3;   // thin emitter: bolometric emissivity goes as g^3
        kap += rho * 0.003;
      }
    }
    // a thin hoop in the flow's own equator at its outer edge, so the tilt and the wobble read at a glance
    {
      float dr = length(vec2(rb - uFlow.y, pb.z));
      em += vec3(0.95, 0.9, 1.0) * exp(-dr * dr / 0.09) * 0.45 * uLumScale;
    }
  } else if (uMode == 2) {
    float acc = 0.0;
    for (int j = 0; j < 6; j++) {
      vec3 d = p - uBlob[j].xyz;
      acc += uBlob[j].w * exp(-dot(d, d) / (2.0 * 0.75 * 0.75));
    }
    if (acc > 1e-4) {
      float b2 = dot(uBlobV, uBlobV);
      float gam = 1.0 / sqrt(max(1.0 - b2, 1e-3));
      float g = sqrt(max(1.0 - 2.0 / max(r, 2.2), 0.1)) / (gam * (1.0 - dot(uBlobV, kph)));
      em += blackbody(displayT(2.5e7 * g)) * acc * pow(g, 2.5) * 16.0 * uLumScale;
      kap += acc * 0.15;
    }
  }
  if (uJet > 0.01) em += jetVolume(p, kph);
  return vec4(em, kap);
}

// ------------------------------------------------------------ straight-ray segment
// Traces ro + t rd for t in [0, tMax]. Returns true if an opaque surface was hit.
// s0: path length before ro (for texture filtering); bend: how far the ray was bent before ro.
bool traceStraight(vec3 ro, vec3 rd, float tMax, float s0, float bend, inout vec3 col, inout float trans) {
  if (uDebug == 5) return false;
  float tHit = tMax;
  int kind = 0; // 1 star, 2 disc surface
  vec3 hitN = vec3(0.0);
  vec3 hitP = vec3(0.0);

  // --- companion star (corotating frame, units of a)
  mat2 R = rot(-uOrb);
  vec3 roc = vec3(R * ro.xy, ro.z) / uA;
  vec3 rdc = vec3(R * rd.xy, rd.z);
  {
    vec3 oc = roc - vec3(1.0, 0.0, 0.0);
    float b = dot(oc, rdc);
    float c = dot(oc, oc) - uRoche2.y * uRoche2.y;
    float disc = b * b - c;
    if (disc > 0.0) {
      float sq = sqrt(disc);
      float t0 = max(-b - sq, 0.0), t1 = -b + sq;
      if (uDebug != 2 && t1 > 0.0 && t0 * uA < tHit) {
        float dt = (t1 - t0) / 40.0;
        float tp = t0;
        for (int i = 1; i <= 40; i++) {
          float t = t0 + dt * float(i);
          if (insideStar(roc + rdc * t)) {
            float lo = tp, hi = t;
            for (int k = 0; k < 7; k++) { float m = 0.5 * (lo + hi); if (insideStar(roc + rdc * m)) hi = m; else lo = m; }
            float th = hi * uA;
            if (th < tHit) { tHit = th; kind = 1; hitP = roc + rdc * hi; }
            break;
          }
          tp = t;
        }
      }
    }
  }

  // --- accretion disc (flared, with rim)
  {
    float rOut = uDisc.y;
    float hMax = (uDisc.z + uDisc.w + 0.03) * rOut;
    float ta = 0.0, tb = tHit;
    // slab
    if (abs(rd.z) > 1e-7) {
      float s0 = (-hMax - ro.z) / rd.z, s1 = (hMax - ro.z) / rd.z;
      ta = max(ta, min(s0, s1)); tb = min(tb, max(s0, s1));
    } else if (abs(ro.z) > hMax) { tb = -1.0; }
    // cylinder
    float a2 = dot(rd.xy, rd.xy);
    if (a2 > 1e-12) {
      float bb = dot(ro.xy, rd.xy) / a2;
      float cc = (dot(ro.xy, ro.xy) - rOut * rOut) / a2;
      float dd = bb * bb - cc;
      if (dd < 0.0) tb = -1.0;
      else {
        float sq = sqrt(dd);
        ta = max(ta, -bb - sq); tb = min(tb, -bb + sq);
      }
    } else if (length(ro.xy) > rOut) tb = -1.0;
    if (uDebug != 3 && tb > ta) {
      vec3 p = ro + rd * ta;
      float tp = ta;
      float fp = abs(p.z) - discH(length(p.xy), atan(p.y, p.x));
      float zp = p.z;
      float span = tb - ta;
      float t = ta;
      for (int i = 0; i < 110; i++) {
        float rc = length((ro + rd * t).xy);
        // small steps near the rounded lip, where a grazing ray could otherwise skip over it
        float stepL = max((rc > 0.55 * rOut ? 0.022 : 0.08) * max(rc, 1.0), span / 100.0);
        t = min(t + stepL, tb);
        vec3 q = ro + rd * t;
        float rq = length(q.xy);
        float f = rq < 2000.0 ? 1.0 : abs(q.z) - discH(rq, atan(q.y, q.x));
        bool cross = zp * q.z <= 0.0;
        if (f <= 0.0 || cross) {
          float u = cross ? zp / (zp - q.z) : fp / max(fp - f, 1e-9);
          if (!cross) {
            // refine the surface by bisection
            float lo = tp, hi = t;
            for (int k = 0; k < 7; k++) {
              float m = 0.5 * (lo + hi); vec3 qm = ro + rd * m;
              if (abs(qm.z) - discH(length(qm.xy), atan(qm.y, qm.x)) <= 0.0) hi = m; else lo = m;
            }
            t = hi;
          } else t = mix(tp, t, u);
          vec3 hp = ro + rd * t;
          float rh = length(hp.xy);
          if (rh >= uDisc.x && rh <= min(rOut, uFade) && t < tHit) {
            tHit = t; kind = 2; hitP = hp;
            float sgn = cross ? sign(zp) : sign(hp.z);
            hitN = rh < 2000.0 ? vec3(0.0, 0.0, sgn) : discNormal(hp, sgn);
            break;
          }
          if (rh <= min(rOut, uFade)) break;
        }
        tp = t; fp = f; zp = q.z;
        if (t >= tb) break;
      }
    }
  }

  // --- stream glow (in front of the nearest surface)
  if (uDebug != 4 && uFarGlow > 0.01) {
    vec2 bmin = uStreamBox.xz - 0.05, bmax = uStreamBox.yw + 0.05;
    // quick reject: ray must pass the stream bounding slab |z| < 0.06
    float tz0 = -1e9, tz1 = 1e9;
    if (abs(rdc.z) > 1e-6) { float s0 = (-0.06 - roc.z) / rdc.z, s1 = (0.06 - roc.z) / rdc.z; tz0 = min(s0, s1); tz1 = max(s0, s1); }
    else if (abs(roc.z) > 0.06) tz1 = -1.0;
    tz0 = max(tz0, 0.0);
    tz1 = min(tz1, tHit / uA);
    if (tz1 > tz0) {
      vec2 pa = roc.xy + rdc.xy * tz0, pb = roc.xy + rdc.xy * tz1;
      if (!(max(pa.x, pb.x) < bmin.x || min(pa.x, pb.x) > bmax.x || max(pa.y, pb.y) < bmin.y || min(pa.y, pb.y) > bmax.y)) {
        vec3 glow = vec3(0.0);
        float absorb = 0.0;
        for (int gi = 0; gi < 6; gi++) {
          vec3 gc = uStreamG[gi].xyz - roc;
          float gt = dot(gc, rdc);
          if (dot(gc, gc) - gt * gt > uStreamG[gi].w * uStreamG[gi].w) continue;
        for (int jj = 0; jj < 8; jj++) {
          int j = gi * 8 + jj;
          if (j >= 47) break;
          vec3 A = vec3(uStream[j].xy, 0.0), Bp = vec3(uStream[j + 1].xy, 0.0);
          vec3 u = Bp - A;
          vec3 w0 = roc - A;
          float a = dot(rdc, rdc), bq = dot(rdc, u), c = dot(u, u), d = dot(rdc, w0), e = dot(u, w0);
          float den = a * c - bq * bq;
          float sc = den > 1e-12 ? (bq * e - c * d) / den : 0.0;
          float tc = den > 1e-12 ? (a * e - bq * d) / den : e / c;
          tc = clamp(tc, 0.0, 1.0);
          sc = (bq * tc - d) / a;
          if (sc < 0.0 || sc * uA > tHit) continue;
          vec3 dp = w0 + rdc * sc - u * tc;
          float s = mix(uStream[j].z, uStream[j + 1].z, tc);
          float wid = mix(0.004, 0.014, s);
          float dd = dot(dp, dp) / (wid * wid);
          if (dd > 9.0) continue;
          float dens = exp(-dd);
          float knots = 0.7 + 0.3 * sin(TAU * (s * 7.0 - uTime * 0.6));
          float Ts = mix(7000.0, 12000.0, s * s);
          glow += thermal(Ts) * dens * knots * 0.7;
          absorb = max(absorb, dens * 0.7);
        }
        }
        col += trans * glow * uFarGlow;
        trans *= 1.0 - absorb * uFarGlow;
      }
    }
  }

  // --- bright spot halo
  if (uFarGlow > 0.01) {
    vec3 sp = vec3(uStream[47].xy, 0.0);
    vec3 w0 = roc - sp;
    float sc = max(-dot(w0, rdc), 0.0);
    if (sc * uA < tHit + 0.02 * uA) {
      vec3 dp = w0 + rdc * sc;
      float d2 = dot(dp, dp);
      col += trans * thermal(16000.0) * (exp(-d2 / (0.010 * 0.010)) * 0.12 + exp(-d2 / (0.0035 * 0.0035)) * 0.35) * uFarGlow;
    }
  }

  // --- jet outside the relativistic region
  col += trans * jetStraight(ro, rd, 0.0, tHit);

  if (kind == 1) {
    vec3 gv = rocheGrad(hitP);
    float gm = length(gv);
    vec3 n = gv / gm;
    float Tg = uTstar * pow(gm / uRoche2.z, 0.08);
    float d = length(hitP);
    float cosI = -dot(n, hitP) / d;
    float elev = abs(hitP.z) / length(hitP.xy);
    float lit = smoothstep(uDisc.z * 0.3, uDisc.z * 2.0, elev);   // the disc rim shades the star's equator
    float dN = 1.0 - uRoche2.x;
    float Ti = 9000.0 * uRoche2.w;
    float T4 = pow(Tg, 4.0) + (cosI > 0.0 ? pow(Ti, 4.0) * cosI * (dN / d) * (dN / d) * lit : 0.0);
    float T = pow(T4, 0.25);
    float mu = max(dot(n, -rdc), 0.0);
    // faint granulation
    vec3 sn = normalize(hitP - vec3(1.0, 0.0, 0.0));
    float gr = noiseL(vec2(atan(sn.y, sn.z) / TAU * 6.0, sn.x * 3.0), 1.5);
    // The star has its own colour scale (not the disc's zoom-dependent one), stretched so the
    // X-ray heated face (up to ~9,000 K) reads white-yellow and the gravity-darkened nose a deeper orange.
    // Near the limb we see higher, cooler layers (T ~ 0.82 T_eff at the edge), so the limb is redder as well as darker.
    float Tn = T / 5800.0;
    float Tmu = Tn * (0.82 + 0.18 * mu);
    vec3 sc = blackbody(clamp(2900.0 * pow(Tmu, 2.2), 1300.0, 12000.0)) * pow(Tn, 3.0);
    float limbD = 1.0 - 0.62 * (1.0 - mu) - 0.12 * (1.0 - mu) * (1.0 - mu);
    col += trans * sc * limbD * (0.97 + 0.06 * gr) * 3.0 * uStarGain;
    trans = 0.0;
    return true;
  }
  if (kind >= 2) {
    float lam = -cross(ro, rd).z;
    col += trans * discEmit(hitP, rd, hitN, lam, s0 + tHit, bend) * smoothstep(uFade, 0.75 * uFade, length(hitP.xy));
    trans = 0.0;
    return true;
  }
  return false;
}

// ------------------------------------------------------------ main
void main() {
  vec2 ndc = (gl_FragCoord.xy / uRes) * 2.0 - 1.0;
  ndc.x *= uRes.x / uRes.y;
  vec3 rd = normalize(uCamF + uTanFov * (ndc.x * uCamR + ndc.y * uCamU));
  vec3 ro = uCamPos;
  vec3 col = vec3(0.0);
  float trans = 1.0;

  // entry into the relativistic sphere
  float b = dot(ro, rd);
  float c = dot(ro, ro) - uRgr * uRgr;
  float disc = b * b - c;
  bool inside = c < 0.0;
  float tIn = inside ? 0.0 : (disc > 0.0 && -b - sqrt(disc) > 0.0 ? -b - sqrt(disc) : -1.0);

  if (tIn < 0.0) {
    traceStraight(ro, rd, 1e12, 0.0, 0.0, col, trans);
  } else {
    bool hit = false;
    if (tIn > 0.0) hit = traceStraight(ro, rd, tIn, 0.0, 0.0, col, trans);
    if (!hit) {
      float sPath = tIn;
      vec3 p = ro + rd * tIn;
      vec3 v = rd;
      vec3 hv = cross(p, v);
      float h2 = dot(hv, hv);
      float lamPh = -hv.z;
      int status = 0; // 0 running, 1 captured, 2 escaped, 3 disc
      float rExit = uRgr + 1.0;
      bool volOn = (uMode == 1 || uMode == 2 || uJet > 0.01);
      float rVol = uMode == 1 ? uFlow.y + 4.0 : (uMode == 2 ? 9.0 : 0.0);
      float transPS = -1.0;   // transparency when the ray first came near the photon sphere
      for (int i = 0; i < 520; i++) {
        if (i >= uMaxSteps) break;
        float r = length(p);
        if (transPS < 0.0 && r < 3.6) transPS = trans;
        float dt = r < 6.0 ? 0.035 * r : 0.075 * r;
        if (volOn && r < rVol + 2.0) dt = min(dt, uMode == 2 ? 0.22 : 0.5);
        if (uJet > 0.01) { float jw = 0.6 + 0.05 * abs(p.z); if (length(p.xy) < 3.5 * jw) dt = min(dt, 0.4 * jw); }
        dt = clamp(dt, 0.015, 60.0);
        vec3 acc = -3.0 * h2 * p / pow(r, 5.0);
        vec3 vh = v + 0.5 * dt * acc;
        vec3 pn = p + dt * vh;
        float rn = length(pn);
        vec3 accn = -3.0 * h2 * pn / pow(rn, 5.0);
        vec3 vn = vh + 0.5 * dt * accn;

        float stepLen = length(pn - p);
        if (volOn) {
          vec3 pm = 0.5 * (p + pn);
          vec3 kph = -normalize(vn + v);
          vec4 vol = innerVolume(pm, kph);
          col += trans * vol.rgb * stepLen;
          trans *= exp(-vol.a * stepLen);
        }

        // disc crossing
        float rc0 = length(p.xy), rc1 = length(pn.xy);
        bool thick = false;
        float f0 = thick ? abs(p.z) - discH(rc0, atan(p.y, p.x)) : 1.0;
        float f1 = thick ? abs(pn.z) - discH(rc1, atan(pn.y, pn.x)) : 1.0;
        bool cross = p.z * pn.z <= 0.0;
        if (cross || (f1 <= 0.0 && f0 > 0.0)) {
          float u = cross ? p.z / (p.z - pn.z) : f0 / (f0 - f1);
          vec3 hp = mix(p, pn, u);
          float rh = length(hp.xy);
          if (rh >= uDisc.x && rh <= min(uDisc.y, uFade)) {
            vec3 dir = normalize(mix(v, vn, u));
            float bendA = acos(clamp(dot(dir, rd), -1.0, 1.0));
            col += trans * discEmit(hp, dir, vec3(0.0, 0.0, sign(p.z)), lamPh, sPath + stepLen * u, bendA) * smoothstep(uFade, 0.75 * uFade, rh);
            trans = 0.0;
            status = 3;
            break;
          }
        }
        sPath += stepLen;
        if (rn < uRcap) { status = 1; break; }
        if (rn > rExit && dot(pn, vn) > 0.0) { p = pn; v = normalize(vn); status = 2; break; }
        p = pn; v = vn;
        if (trans < 0.01) { status = 3; break; }
      }
      // Photon ring: light that circled the hole one or more times piles up just outside the shadow edge,
      // at impact parameter sqrt(27) GM/c^2. The real ring is far thinner than a pixel, so it is drawn about
      // one pixel wide, with the surface brightness of the hottest part of the disc, dimmed.
      // (only for rays that got near the photon sphere, so the near side of the disc still hides the ring's bottom)
      if (transPS > 0.0) {
        float bImp = sqrt(h2);
        float x = (bImp - 5.19615) / max(uRingW, 0.004);
        float rr = max(uRinT, uDisc.x) * 1.36;
        float Tr = pow(uTK / (rr * rr * rr) * (1.0 - sqrt(uRinT / rr)), 0.25);
        // in the Type-C mode the light that circles the hole comes mostly from the hot flow
        vec3 rc = uMode == 1 ? vec3(0.9, 0.88, 1.0) * 0.9 * uLumScale : thermal(Tr * 0.8) * 0.45;
        col += transPS * rc * exp(-x * x);
      }
      if (status == 2) traceStraight(p, v, 1e12, sPath, acos(clamp(dot(normalize(v), rd), -1.0, 1.0)), col, trans);
      if (uDebug == 1) { fragColor = vec4(status == 1 ? 1.0 : 0.0, status == 2 ? 1.0 : 0.0, status == 3 ? 1.0 : 0.0, 1.0) * 0.5 + vec4(status == 0 ? 0.5 : 0.0); return; }
    }
  }
  col *= uExposure;
  if (any(isnan(col)) || any(isinf(col))) col = vec3(0.0);
  fragColor = vec4(min(col, vec3(60.0)), 1.0);
}
`;

// ------------------------------------------------------------ bloom (dual filter) and composite
export const DOWN = /* glsl */`#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D uSrc;
uniform vec2 uTexel;
uniform float uThreshold; // > 0 only on the first pass
vec3 prefilter(vec3 c) {
  float br = max(c.r, max(c.g, c.b));
  float knee = uThreshold * 0.6;
  float soft = clamp(br - uThreshold + knee, 0.0, 2.0 * knee);
  soft = soft * soft / (4.0 * knee + 1e-4);
  float w = max(soft, br - uThreshold) / max(br, 1e-4);
  return c * w;
}
void main() {
  vec2 t = uTexel;
  vec3 a = texture(uSrc, vUv + t * vec2(-2.0, 2.0)).rgb;
  vec3 b = texture(uSrc, vUv + t * vec2(0.0, 2.0)).rgb;
  vec3 c = texture(uSrc, vUv + t * vec2(2.0, 2.0)).rgb;
  vec3 d = texture(uSrc, vUv + t * vec2(-2.0, 0.0)).rgb;
  vec3 e = texture(uSrc, vUv).rgb;
  vec3 f = texture(uSrc, vUv + t * vec2(2.0, 0.0)).rgb;
  vec3 g = texture(uSrc, vUv + t * vec2(-2.0, -2.0)).rgb;
  vec3 h = texture(uSrc, vUv + t * vec2(0.0, -2.0)).rgb;
  vec3 i = texture(uSrc, vUv + t * vec2(2.0, -2.0)).rgb;
  vec3 j = texture(uSrc, vUv + t * vec2(-1.0, 1.0)).rgb;
  vec3 k = texture(uSrc, vUv + t * vec2(1.0, 1.0)).rgb;
  vec3 l = texture(uSrc, vUv + t * vec2(-1.0, -1.0)).rgb;
  vec3 m = texture(uSrc, vUv + t * vec2(1.0, -1.0)).rgb;
  vec3 o = e * 0.125 + (a + c + g + i) * 0.03125 + (b + d + f + h) * 0.0625 + (j + k + l + m) * 0.125;
  if (uThreshold > 0.0) o = prefilter(min(o, vec3(24.0)));
  fragColor = vec4(o, 1.0);
}
`;

export const UP = /* glsl */`#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D uSrc;
uniform vec2 uTexel;
uniform float uRadius;
void main() {
  vec2 t = uTexel * uRadius;
  vec3 s = texture(uSrc, vUv).rgb * 4.0;
  s += (texture(uSrc, vUv + vec2(-t.x, 0.0)).rgb + texture(uSrc, vUv + vec2(t.x, 0.0)).rgb +
        texture(uSrc, vUv + vec2(0.0, -t.y)).rgb + texture(uSrc, vUv + vec2(0.0, t.y)).rgb) * 2.0;
  s += texture(uSrc, vUv + vec2(-t.x, -t.y)).rgb + texture(uSrc, vUv + vec2(t.x, -t.y)).rgb +
       texture(uSrc, vUv + vec2(-t.x, t.y)).rgb + texture(uSrc, vUv + vec2(t.x, t.y)).rgb;
  fragColor = vec4(s / 16.0, 1.0);
}
`;

export const COMPOSITE = /* glsl */`#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D uScene;
uniform sampler2D uBloom;
uniform sampler2D uBloomWide;
uniform float uBloomStrength;
uniform vec2 uRes;
uniform float uCollapse;   // 0 scene, 1 unresolved point
uniform float uPointFlux;  // brightness of the unresolved point
uniform vec3 uPointColor;
uniform float uTime;

vec3 aces(vec3 x) {
  const float a = 2.51, b = 0.03, c = 2.43, d = 0.59, e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
}
float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }

void main() {
  vec2 uv = vUv;
  float s = 1.0 - 0.985 * smoothstep(0.0, 0.85, uCollapse);
  vec2 suv = (uv - 0.5) / s + 0.5;
  vec3 col = vec3(0.0);
  if (all(greaterThanEqual(suv, vec2(0.0))) && all(lessThanEqual(suv, vec2(1.0)))) {
    vec3 sc = texture(uScene, suv).rgb;
    vec3 bl = texture(uBloom, suv).rgb;
    vec3 bw = texture(uBloomWide, suv).rgb;
    col = sc + uBloomStrength * (bl * 0.9 + bw * 0.6);
  }
  float fade = 1.0 - smoothstep(0.55, 0.95, uCollapse);
  col *= fade;
  // unresolved source: a soft point spread function
  if (uCollapse > 0.3) {
    vec2 d = (uv - 0.5) * vec2(uRes.x / uRes.y, 1.0);
    float r2 = dot(d, d);
    float psf = exp(-r2 / 0.00006) + 0.25 * exp(-r2 / 0.0012) + 0.05 * exp(-r2 / 0.012);
    col += uPointColor * psf * uPointFlux * smoothstep(0.3, 0.9, uCollapse);
  }
  // vignette
  vec2 q = uv - 0.5;
  col *= 1.0 - 0.35 * dot(q, q) * 1.6;
  // tone map the brightest channel and keep the hue, so hot regions stay coloured instead of clipping to white
  float mx = max(max(col.r, col.g), col.b);
  vec3 hue = col / max(mx, 1e-5);
  float mt = aces(vec3(mx)).r;
  col = hue * mt;
  col = mix(col, vec3(mt), 0.18 * smoothstep(1.5, 6.0, mx));
  col = pow(col, vec3(1.0 / 2.2));
  col += (hash(gl_FragCoord.xy + fract(uTime) * 91.7) - 0.5) / 255.0;
  fragColor = vec4(col, 1.0);
}
`;
