// Simulated gas kiln firing.
// Used by the dashboard's demo mode (in the browser) and by simulator/simulate.js (in Node).
// Temperatures are in °C, time in hours since the burners were lit.
(function (root) {
  'use strict';

  const AMBIENT_C = 24;

  // Heating schedule for a cone 10 reduction glaze firing: [hours, °C].
  // The small dip at 7–7.25 h is body reduction (damper in, temperature stalls/drops a little).
  const GLAZE_C10 = [
    [0, AMBIENT_C], [1, 90], [2, 190], [4, 470], [6, 760], [7, 890], [7.25, 880],
    [8.25, 950], [9, 1010], [10.5, 1170], [11.5, 1260], [12, 1285], [12.5, 1290],
  ];

  // Bisque to about cone 06.
  const BISQUE_06 = [
    [0, AMBIENT_C], [1.5, 95], [3, 200], [5, 450], [7, 760], [8.5, 960], [9, 995], [9.25, 998],
  ];

  // Small deterministic random generator, so the same seed always gives the same firing.
  function rng(seed) {
    let a = (seed >>> 0) || 1;
    return function () {
      a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // opts: { seed, kind: 'glaze' | 'bisque', stall: bool, overshoot: bool, coolTau: hours }
  function createFiring(opts) {
    opts = opts || {};
    const rand = rng(opts.seed || 1);
    let pts = (opts.kind === 'bisque' ? BISQUE_06 : GLAZE_C10).map(p => p.slice());

    // Vary timing and temperatures a little so no two firings are identical.
    const orig = pts.map(p => p[0]);
    for (let i = 1; i < pts.length; i++) {
      pts[i][0] = pts[i - 1][0] + (orig[i] - orig[i - 1]) * (1 + (rand() - 0.5) * 0.16);
      if (i < pts.length - 2) pts[i][1] *= 1 + (rand() - 0.5) * 0.04;
    }
    if (opts.overshoot) {
      const last = pts[pts.length - 1];
      pts.push([last[0] + 0.75, 1345]);
    }
    if (opts.stall) {
      // Insert a 2-hour flat spot around 1100 °C (e.g. a regulator problem).
      const i = pts.findIndex(p => p[1] > 1100);
      if (i > 0) {
        const [h0, c0] = pts[i - 1], [h1, c1] = pts[i];
        const hs = h0 + (1100 - c0) / (c1 - c0) * (h1 - h0);
        const rest = pts.slice(i).map(p => [p[0] + 2, p[1]]);
        pts = pts.slice(0, i).concat([[hs, 1100], [hs + 2, 1104]], rest);
      }
    }

    const heatHours = pts[pts.length - 1][0];
    const peakC = pts[pts.length - 1][1];
    const tau = opts.coolTau || 6.5 + rand() * 1.5;
    const coolHours = tau * Math.log((peakC - AMBIENT_C) / (90 - AMBIENT_C)); // until ~90 °C
    const p1 = rand() * 10, p2 = rand() * 10;

    function noise(h) {
      return 0.6 * Math.sin(h * 37.1 + p1) + 0.4 * Math.sin(h * 91.7 + p2);
    }

    function tempAt(h) {
      if (h <= 0) return AMBIENT_C + noise(h) * 0.3;
      if (h <= heatHours) {
        let i = 1;
        while (pts[i][0] < h) i++;
        const [h0, c0] = pts[i - 1], [h1, c1] = pts[i];
        const t = (h - h0) / (h1 - h0);
        // Burner wobble is a little stronger while the kiln is hot.
        return c0 + (c1 - c0) * t + noise(h) * (h > 6 ? 2 : 1);
      }
      return AMBIENT_C + (peakC - AMBIENT_C) * Math.exp(-(h - heatHours) / tau) + noise(h) * 0.5;
    }

    return { heatHours, totalHours: heatHours + coolHours, peakC, tempAt };
  }

  // Generate [epochMs, °C] readings for a firing that starts at startMs.
  // preHours of cold kiln are included before the start.
  function generate(firing, startMs, stepSec, preHours) {
    const out = [];
    const step = stepSec * 1000;
    const from = startMs - (preHours || 0) * 3600000;
    const to = startMs + firing.totalHours * 3600000;
    for (let t = from; t <= to; t += step) {
      out.push([t, Math.round(firing.tempAt((t - startMs) / 3600000) * 100) / 100]);
    }
    return out;
  }

  const api = { AMBIENT_C, createFiring, generate };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.KilnSim = api;
})(this);
