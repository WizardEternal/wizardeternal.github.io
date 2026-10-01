// Caption text for each zoom level and inner-disc mode.
export const COPY = {
  scales: {
    binary: {
      title: 'The whole binary',
      body: `<p>A 10 M☉ black hole and a Sun-like star (1 M☉, 1 R☉) that just fills its Roche lobe. Filling the lobe fixes the orbit: the two are 4.8 R☉ apart and go around once every 8.9 hours. The star is pulled into a teardrop, it's a little darker where it's stretched most because gravity is weaker there, and the side facing the X-rays gets heated. Gas leaks out through L1, the saddle point between the two, and gets bent by the Coriolis force before it hits the disc edge at the bright spot.</p>`,
      alt: 'A teardrop-shaped star feeding a stream of gas into a glowing accretion disc around a black hole.',
    },
    disc: {
      title: 'The accretion disc',
      body: `<p>The gas can't fall straight in, it has too much angular momentum. It settles first into a ring at about 0.31 of the separation (the circularisation radius) and then spreads into a disc, with friction moving mass in and angular momentum out. The temperature goes roughly as r<sup>−3/4</sup>, about 6,300 K at the rim and 5 million K near the hole, so the colours are on a squashed scale: orange is cool and blue-white is X-ray hot. The rim is thicker where the stream hits, and at high inclination that bulge blocks the X-rays for part of every orbit. Those are the dips in the light curve.</p>`,
      alt: 'A flared accretion disc seen close up, with the gas stream hitting its rim.',
    },
    horizon: `The black patch is the shadow, the directions where light fell in. For a non-spinning hole its edge is √27 ≈ 5.2 GM/c² from the centre, seen from far away. Light skimming that edge can loop around the hole before it gets out, so squeezed copies of the disc pile up in a thin ring there, the photon ring. The real one is far thinner than a pixel, so it's drawn about a pixel wide.`,
  },
  modes: {
    quiet: {
      title: 'The last few hundred kilometres',
      body: `<p>Close to the hole light bends. The far side of the disc shows up arched over the top of the shadow, and in the edge-on view its underside shows up below it too. Up close, the disc beyond about 0.7 times your distance from the hole is cut away so you can see past it. Close in the gas moves fast, 0.4 times the speed of light at 6 GM/c². Seen edge-on, the side coming toward you gets a Doppler factor of 1.4 and the side moving away 0.5, and the brightness goes as the fourth power of that, so the two sides differ by about 70 times there. The picture keeps that factor in full before the display squashes all brightness, so the approaching side is the bright, blue one. All of it is a bit redshifted climbing out, too. A plain disc still flickers, here by 5% rms with a power spectrum that goes as 1/f, so it's a flat line with no peak on this plot. The spectrum is built from the simulated light curve 16 times faster than the picture plays. Pick one of the QPO modes to compare.</p>`,
      alt: 'The inner accretion disc around a black hole, bent by gravity into an arch over the black shadow.',
    },
    typec: {
      title: 'Type-C QPO: a wobbling hot flow',
      body: `<p>In the hard state the thin disc stops at 20 GM/c², and inside it there's a hot, puffed-up flow. If the hole spins and the flow is tilted, frame dragging makes the whole flow wobble like a top (Lense-Thirring precession). With the H 1743-322 numbers from my model (10 M☉, spin 0.5, flow from 6 to 20 GM/c²) it precesses at 0.28 Hz, once every 3.6 s on average. The tilt is exaggerated to 20° so you can see it. From Earth's side the flow shows more and then less of itself as it turns, so the X-rays go up and down. Real QPOs aren't clockwork, so here the wobble's phase drifts at random, which spreads the peak to a width of 0.035 Hz (quality factor 8). The wobble is 11% rms of the flux at 84°, with 5% at twice the frequency, on top of 21% rms of flicker that is flat below about 0.07 Hz and falls off above it. The picture plays in real time. The spectrum is built from the same simulated light curve 16 times faster, one 64 s segment every 4 s, so it has something to show within a minute. Lower the inclination toward 0° and the peak fades.</p>`,
      alt: 'A tilted, glowing hot flow precessing inside a truncated accretion disc around a black hole.',
    },
    rpm: {
      title: 'High-frequency QPO: a blob on a precessing orbit',
      body: `<p>A hot blob orbits at 5.7 GM/c², just outside the innermost stable orbit of a 5.3 M☉ hole with spin 0.29 (the GRO J1655-40 numbers in my model). The orbit is a bit eccentric and a bit tilted, so it has more than one frequency: 440 Hz to go around, 296 Hz for the ellipse to turn and 17.5 Hz for the tilt to turn. That's the relativistic precession model. The picture is slowed down 500 times, but the spectrum runs in real time, one 1 s segment per second. Each of the three motions drifts in phase, so the peaks have quality factors of 10, 8 and 6. The blob is 3.5% rms of the flux, on 13% rms of flicker, so the light curve looks like noise. Its Doppler flashes put most of that 3.5% into 440 Hz and its harmonic at 880 Hz, and 440 Hz clears the noise within seconds. The blob's 296 and 17.5 Hz signals are about 8 and 30 times weaker in amplitude, so here they stay buried. GRO J1655-40 showed all three, so a single blob is too simple. Real data also has counting noise, left out here, and a real 440 Hz peak takes hours of data to find.</p>`,
      alt: 'A bright blob of gas orbiting close to a black hole, flashing brighter on the side moving toward the viewer.',
    },
    heart: {
      title: 'Heartbeat: filling and emptying',
      body: `<p>GRS 1915+105 flares every 50 to 100 s. The leading idea is a limit cycle: the inner disc fills up until radiation pressure makes it unstable, then it dumps mass onto the hole in a flare and starts filling again. This is the one-zone version of that model from my code, with a 12 M☉ hole of spin 0.98. The gauge shows the inner disc filling toward the critical line. In the model a cycle takes about 39 s, and it's sped up 6 times here. The spectrum is built 10 times faster than that, one 256 s segment every 4 s. The flares are sharp spikes, not a sine wave, so the spectrum shows the cycle as a peak at 1/39 s plus peaks at 2 and 3 times that. Whether this is what really drives the heartbeat is still open. In my <a href="/research/grs-1915-heartbeat/">GRS 1915+105 paper</a> the X-ray fits didn't need the disc temperature to change at all.</p>`,
      alt: 'The inner accretion disc of a black hole brightening in a flare and fading again.',
    },
  },
};
