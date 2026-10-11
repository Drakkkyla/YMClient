// Real audio-reactive visuals. One rAF loop reads the analyser and:
//  - sets --l1/--l2/--l3 (bass/mid/high, 0..1) on the few elements that use them,
//  - draws the My Wave rings on #waveCanvas when that page is open.
import * as player from "./lib/player.js";

let color = [255, 207, 64];
export const setColor = (rgb) => rgb && (color = rgb);

const N = 96; // ring points
const layers = [new Float32Array(N), new Float32Array(N), new Float32Array(N)];
let targets = [];
let levels = [0, 0, 0];

/** Re-collect elements that consume level vars (call after render / track change). */
export function refresh() {
  targets = [...document.querySelectorAll("#player, .wave-hero, .row.is-current, .fs.open")];
}

const band = (bins, from, to) => {
  let s = 0;
  for (let i = from; i < to; i++) s += bins[i];
  return s / (to - from) / 255;
};
// Map 0..1 band energy into a punchier 0..1 (music rarely sits near 0).
const shape = (v, floor) => Math.max(0, Math.min(1, (v - floor) / (1 - floor))) ** 1.4;

function frame(time) {
  requestAnimationFrame(frame);
  const bins = player.state.playing ? player.spectrum() : null;

  const next = bins ? [shape(band(bins, 1, 5), 0.35), shape(band(bins, 6, 32), 0.25), shape(band(bins, 32, 110), 0.12)] : [0, 0, 0];
  let changed = false;
  for (let i = 0; i < 3; i++) {
    const v = levels[i] + (next[i] - levels[i]) * 0.45;
    if (Math.abs(v - levels[i]) > 0.004) changed = true;
    levels[i] = v;
  }
  if (changed) {
    for (const el of targets) {
      el.style.setProperty("--l1", levels[0].toFixed(3));
      el.style.setProperty("--l2", levels[1].toFixed(3));
      el.style.setProperty("--l3", levels[2].toFixed(3));
    }
  }

  const cv = document.getElementById("waveCanvas");
  if (cv) drawRings(cv, bins, time);
}

function drawRings(cv, bins, time) {
  const dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth, h = cv.clientHeight;
  if (!w) return;
  if (cv.width !== Math.round(w * dpr)) {
    cv.width = Math.round(w * dpr);
    cv.height = Math.round(h * dpr);
  }
  const g = cv.getContext("2d");
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);

  const cx = w / 2, cy = h / 2;
  const base = Math.min(w, h) * 0.25;
  const half = N / 2;
  const [r, gg, b] = color;

  for (let L = layers.length - 1; L >= 0; L--) {
    const pts = layers[L];
    for (let i = 0; i < N; i++) {
      // Mirror around the ring so it reads as one symmetric shape; log-ish frequency spread.
      const k = i <= half ? i : N - i;
      let target = 0;
      if (bins) {
        const idx = Math.floor(2 + (k / half) ** 1.6 * (90 + L * 15));
        target = (bins[idx] / 255) ** 1.8;
      }
      pts[i] += (target - pts[i]) * (target > pts[i] ? 0.5 : 0.12);
    }

    const rot = time * 0.00006 * (L % 2 ? -1 : 1) * (L + 1);
    const amp = base * (0.55 - L * 0.12);
    const rad = base * (1 + L * 0.07);
    const xy = [];
    for (let i = 0; i < N; i++) {
      // Tiny idle drift keeps the ring alive when paused; the size itself only comes from audio.
      const idle = Math.sin(time * 0.0012 + i * 0.35 + L) * 1.2;
      const rr = rad + pts[i] * amp + idle;
      const a = (i / N) * Math.PI * 2 + rot - Math.PI / 2;
      xy.push([cx + Math.cos(a) * rr, cy + Math.sin(a) * rr]);
    }

    g.beginPath();
    for (let i = 0; i <= N; i++) {
      const [x0, y0] = xy[i % N];
      const [x1, y1] = xy[(i + 1) % N];
      const mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
      i === 0 ? g.moveTo(mx, my) : g.quadraticCurveTo(x0, y0, mx, my);
    }
    g.closePath();

    const alpha = [0.9, 0.35, 0.16][L];
    const grad = g.createRadialGradient(cx, cy, base * 0.3, cx, cy, rad + amp);
    grad.addColorStop(0, `rgba(${r},${gg},${b},${alpha * 0.05})`);
    grad.addColorStop(1, `rgba(${r},${gg},${b},${alpha * 0.32})`);
    g.fillStyle = grad;
    g.shadowColor = `rgba(${r},${gg},${b},${0.6 * alpha})`;
    g.shadowBlur = L === 0 ? 24 + levels[0] * 40 : 0;
    g.fill();
    g.shadowBlur = 0;
    g.lineWidth = L === 0 ? 2 : 1.2;
    g.strokeStyle = `rgba(${r},${gg},${b},${alpha})`;
    g.stroke();
  }
}

export function start() {
  requestAnimationFrame(frame);
}
