// Equalizer panel: 10 vertical band sliders + preamp, presets, and the real response curve.
import * as player from "./lib/player.js";
import { esc } from "./lib/ui.js";

const MAX_DB = 12;
const PRESETS = [
  ["flat", "Обычный", [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]],
  ["bass", "Бас", [6, 5, 4, 2, 0, 0, 0, 0, 0, 0]],
  ["bassplus", "Мощный бас", [9, 8, 6, 3, 1, 0, 0, 0, 0, 0]],
  ["vocal", "Вокал", [-2, -2, -1, 1, 3, 4, 4, 3, 1, 0]],
  ["rock", "Рок", [5, 4, 2, -1, -2, -1, 2, 3, 4, 4]],
  ["pop", "Поп", [-1, 1, 3, 4, 3, 1, -1, -1, 0, 0]],
  ["electronic", "Электроника", [6, 5, 1, 0, -2, 1, 0, 2, 4, 5]],
  ["hiphop", "Хип‑хоп", [6, 5, 2, 3, -1, -1, 1, 0, 2, 3]],
  ["acoustic", "Акустика", [4, 3, 2, 1, 2, 2, 3, 3, 2, 1]],
  ["treble", "Высокие", [0, 0, 0, 0, 0, 1, 3, 5, 6, 7]],
];
const fmtHz = (f) => (f >= 1000 ? `${f / 1000}к` : String(f));
const fmtDb = (v) => `${v > 0 ? "+" : ""}${Number.isInteger(v) ? v : v.toFixed(1)}`;

const panel = document.getElementById("eqPanel");
let built = false;

function build() {
  built = true;
  const { eq, EQ_BANDS } = player;
  const slider = (key, label, cls = "") => `
    <div class="band ${cls}" data-band="${key}">
      <span class="band-val"></span>
      <div class="vslider" tabindex="0" role="slider" aria-label="${esc(label)}" aria-valuemin="-${MAX_DB}" aria-valuemax="${MAX_DB}">
        <div class="vslider-track"><div class="vslider-fill"></div></div><div class="vslider-thumb"></div>
      </div>
      <span class="band-hz">${esc(label)}</span>
    </div>`;
  panel.innerHTML = `
    <div class="eq-head">
      <h3>Эквалайзер</h3>
      <div class="eq-head-actions">
        <button class="switch" id="eqSwitch" aria-label="Включить эквалайзер"></button>
        <button class="icon-btn" data-action="eq" aria-label="Закрыть"><i class="ph ph-x"></i></button>
      </div>
    </div>
    <div class="eq-presets" id="eqPresets">
      ${PRESETS.map(([k, l]) => `<button class="chip" data-preset="${k}">${l}</button>`).join("")}
      <button class="chip" data-preset="custom" disabled>Свой</button>
    </div>
    <div class="eq-body">
      ${slider("pre", "Пред.", "band-pre")}
      <div class="eq-bands">
        <canvas id="eqCurve"></canvas>
        <div class="eq-zero"></div>
        ${EQ_BANDS.map((f, i) => slider(i, fmtHz(f))).join("")}
      </div>
    </div>
    <div class="eq-foot"><span>Двойной клик по ползунку — сброс в 0 дБ</span><button class="btn btn-ghost btn-sm" id="eqReset"><i class="ph ph-arrow-counter-clockwise"></i>Сбросить</button></div>`;

  panel.querySelectorAll(".band").forEach((band) => {
    const key = band.dataset.band;
    const el = band.querySelector(".vslider");
    const get = () => (key === "pre" ? eq.preamp : eq.gains[+key]);
    const set = (v) => {
      v = Math.max(-MAX_DB, Math.min(MAX_DB, Math.round(v * 2) / 2));
      if (v === get()) return;
      if (key === "pre") player.setEq({ preamp: v, enabled: true });
      else {
        const gains = eq.gains.slice();
        gains[+key] = v;
        player.setEq({ gains, preset: "custom", enabled: true });
      }
    };
    const fromY = (e) => {
      const r = el.getBoundingClientRect();
      return (1 - (e.clientY - r.top) / r.height) * 2 * MAX_DB - MAX_DB;
    };
    let drag = false;
    el.addEventListener("pointerdown", (e) => {
      drag = true;
      el.setPointerCapture(e.pointerId);
      band.classList.add("dragging");
      set(fromY(e));
    });
    el.addEventListener("pointermove", (e) => drag && set(fromY(e)));
    const end = () => ((drag = false), band.classList.remove("dragging"));
    el.addEventListener("pointerup", end);
    el.addEventListener("pointercancel", end);
    el.addEventListener("dblclick", () => set(0));
    el.addEventListener("wheel", (e) => (e.preventDefault(), set(get() - Math.sign(e.deltaY))), { passive: false });
    el.addEventListener("keydown", (e) => {
      const d = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1 }[e.key];
      if (d) (e.preventDefault(), e.stopPropagation(), set(get() + d * 0.5));
    });
  });

  panel.querySelector("#eqSwitch").addEventListener("click", () => player.setEq({ enabled: !eq.enabled }));
  panel.querySelector("#eqReset").addEventListener("click", () => applyPreset("flat"));
  panel.querySelector("#eqPresets").addEventListener("click", (e) => {
    const b = e.target.closest("[data-preset]");
    if (b && !b.disabled) applyPreset(b.dataset.preset);
  });
}

function applyPreset(key) {
  const p = PRESETS.find(([k]) => k === key);
  if (!p) return;
  // Leave headroom for boosts so loud masters don't clip.
  const preamp = -Math.round(Math.max(0, ...p[2]) / 2);
  player.setEq({ gains: p[2].slice(), preamp, preset: key, enabled: true });
}

function sync() {
  if (!built) return;
  const { eq } = player;
  panel.classList.toggle("off", !eq.enabled);
  panel.querySelector("#eqSwitch").classList.toggle("on", eq.enabled);
  panel.querySelectorAll("[data-preset]").forEach((b) => b.classList.toggle("on", b.dataset.preset === eq.preset));
  panel.querySelectorAll(".band").forEach((band) => {
    const key = band.dataset.band;
    const v = key === "pre" ? eq.preamp : eq.gains[+key];
    const frac = (v + MAX_DB) / (2 * MAX_DB);
    const fill = band.querySelector(".vslider-fill");
    fill.style.bottom = `${Math.min(frac, 0.5) * 100}%`;
    fill.style.height = `${Math.abs(frac - 0.5) * 100}%`;
    band.querySelector(".vslider-thumb").style.bottom = `${frac * 100}%`;
    band.querySelector(".band-val").textContent = fmtDb(v);
    band.querySelector(".vslider").setAttribute("aria-valuenow", v);
  });
  drawCurve();
}

let freqs;
function drawCurve() {
  const cv = panel.querySelector("#eqCurve");
  const w = cv.clientWidth, h = cv.clientHeight;
  if (!w) return;
  const dpr = devicePixelRatio || 1;
  cv.width = Math.round(w * dpr);
  cv.height = Math.round(h * dpr);
  const g = cv.getContext("2d");
  g.setTransform(dpr, 0, 0, dpr, 0, 0);

  // Log-frequency axis aligned with the band columns: each band sits at the centre of its column.
  const n = player.EQ_BANDS.length;
  const col = w / n;
  const xOf = (f) => col / 2 + (Math.log2(f / player.EQ_BANDS[0]) / Math.log2(player.EQ_BANDS[n - 1] / player.EQ_BANDS[0])) * (w - col);
  if (!freqs || freqs.length !== Math.round(w)) {
    freqs = new Float32Array(Math.round(w));
    const lo = Math.log2(20), hi = Math.log2(20000);
    for (let i = 0; i < freqs.length; i++) freqs[i] = 2 ** (lo + (i / (freqs.length - 1)) * (hi - lo));
  }
  const db = player.eqResponse(freqs);
  const yOf = (d) => h / 2 - (Math.max(-MAX_DB * 1.5, Math.min(MAX_DB * 1.5, d)) / (2 * MAX_DB)) * h;
  const rgb = getComputedStyle(document.documentElement).getPropertyValue("--ambient").trim() || "138, 99, 255";

  g.beginPath();
  for (let i = 0; i < freqs.length; i++) {
    const x = xOf(freqs[i]), y = yOf(db[i]);
    i ? g.lineTo(x, y) : g.moveTo(x, y);
  }
  g.lineWidth = 2;
  g.strokeStyle = `rgba(${rgb}, ${player.eq.enabled ? 0.95 : 0.3})`;
  g.stroke();
  g.lineTo(xOf(freqs[freqs.length - 1]), h / 2);
  g.lineTo(xOf(freqs[0]), h / 2);
  g.closePath();
  const grad = g.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, `rgba(${rgb}, 0.22)`);
  grad.addColorStop(0.5, `rgba(${rgb}, 0.02)`);
  grad.addColorStop(1, `rgba(${rgb}, 0.22)`);
  g.fillStyle = grad;
  g.fill();
}

export function toggle(force) {
  if (!built) build();
  const open = panel.classList.toggle("open", force);
  if (open) sync();
  return open;
}

player.on((what) => what === "eq" && sync());
