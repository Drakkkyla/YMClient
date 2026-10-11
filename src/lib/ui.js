// Small UI helpers: escaping, formatting, toasts, custom modal, cover color sampling.

export const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

export function fmtTime(sec) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function fmtTotal(ms) {
  const min = Math.round(ms / 60000);
  return min >= 60 ? `${Math.floor(min / 60)} ч ${min % 60} мин` : `${min} мин`;
}

export function plural(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100;
  const w = m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? few : many;
  return `${n.toLocaleString("ru-RU")} ${w}`;
}

// ---------- toasts ----------
let toastHost;
export function toast(text, kind = "info") {
  toastHost ??= document.getElementById("toasts");
  const el = document.createElement("div");
  el.className = `toast toast-${kind}`;
  el.innerHTML = `<i class="ph${kind === "error" ? " ph-warning-circle" : " ph-info"}"></i><span>${esc(text)}</span>`;
  toastHost.append(el);
  requestAnimationFrame(() => el.classList.add("in"));
  setTimeout(() => {
    el.classList.remove("in");
    setTimeout(() => el.remove(), 300);
  }, kind === "error" ? 5200 : 3200);
}

// ---------- modal ----------
/** Custom confirm dialog. Resolves true/false. */
export function confirmDialog({ title, text, ok = "Да", cancel = "Отмена", danger = false }) {
  return new Promise((resolve) => {
    const wrap = document.createElement("div");
    wrap.className = "modal-backdrop";
    wrap.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true">
        <h3>${esc(title)}</h3>
        ${text ? `<p>${esc(text)}</p>` : ""}
        <div class="modal-actions">
          <button class="btn btn-ghost" data-r="0">${esc(cancel)}</button>
          <button class="btn ${danger ? "btn-danger" : "btn-accent"}" data-r="1">${esc(ok)}</button>
        </div>
      </div>`;
    const close = (r) => {
      wrap.classList.remove("in");
      document.removeEventListener("keydown", onKey);
      setTimeout(() => wrap.remove(), 200);
      resolve(r);
    };
    const onKey = (e) => e.key === "Escape" && close(false);
    wrap.addEventListener("click", (e) => {
      if (e.target === wrap) return close(false);
      const b = e.target.closest("[data-r]");
      if (b) close(b.dataset.r === "1");
    });
    document.addEventListener("keydown", onKey);
    document.body.append(wrap);
    requestAnimationFrame(() => wrap.classList.add("in"));
    wrap.querySelector('[data-r="1"]').focus();
  });
}

// ---------- cover color ----------
const colorCache = new Map();
/** Vivid-ish dominant color of an image as [r,g,b]; covers are served with CORS. */
export function sampleColor(url) {
  if (!url) return Promise.resolve(null);
  if (colorCache.has(url)) return Promise.resolve(colorCache.get(url));
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      try {
        const c = document.createElement("canvas");
        c.width = c.height = 24;
        const g = c.getContext("2d", { willReadFrequently: true });
        g.drawImage(img, 0, 0, 24, 24);
        const d = g.getImageData(0, 0, 24, 24).data;
        let best = null, bestScore = -1, sum = [0, 0, 0];
        for (let i = 0; i < d.length; i += 4) {
          const [r, gg, b] = [d[i], d[i + 1], d[i + 2]];
          sum[0] += r; sum[1] += gg; sum[2] += b;
          const max = Math.max(r, gg, b), min = Math.min(r, gg, b);
          const sat = max ? (max - min) / max : 0;
          const score = sat * 0.7 + (max / 255) * 0.3 - (max < 50 ? 1 : 0);
          if (score > bestScore) (bestScore = score), (best = [r, gg, b]);
        }
        const n = d.length / 4;
        const avg = sum.map((v) => v / n);
        // Fall back to the average for near-greyscale covers.
        let col = bestScore > 0.35 ? best : avg;
        // Lift dark colors so the glow stays visible on the black UI.
        const max = Math.max(...col);
        if (max < 150) col = col.map((v) => Math.min(255, v * (150 / Math.max(max, 1))));
        col = col.map(Math.round);
        colorCache.set(url, col);
        resolve(col);
      } catch {
        resolve(null);
      }
    };
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

/** Custom text prompt. Resolves the trimmed string, or null if cancelled. */
export function promptDialog({ title, placeholder = "", value = "", ok = "Готово" }) {
  return new Promise((resolve) => {
    const wrap = document.createElement("div");
    wrap.className = "modal-backdrop";
    wrap.innerHTML = `
      <form class="modal" role="dialog" aria-modal="true">
        <h3>${esc(title)}</h3>
        <input class="modal-input" maxlength="100" placeholder="${esc(placeholder)}" value="${esc(value)}" />
        <div class="modal-actions">
          <button type="button" class="btn btn-ghost" data-r="0">Отмена</button>
          <button type="submit" class="btn btn-accent">${esc(ok)}</button>
        </div>
      </form>`;
    const input = wrap.querySelector("input");
    const close = (r) => {
      wrap.classList.remove("in");
      document.removeEventListener("keydown", onKey);
      setTimeout(() => wrap.remove(), 200);
      resolve(r);
    };
    const onKey = (e) => e.key === "Escape" && close(null);
    wrap.addEventListener("click", (e) => {
      if (e.target === wrap || e.target.closest('[data-r="0"]')) close(null);
    });
    wrap.querySelector("form").addEventListener("submit", (e) => {
      e.preventDefault();
      const v = input.value.trim();
      if (v) close(v);
      else input.focus();
    });
    document.addEventListener("keydown", onKey);
    document.body.append(wrap);
    requestAnimationFrame(() => wrap.classList.add("in"));
    input.focus();
    input.select();
  });
}

// ---------- horizontal slider ----------
/** Wires a `.slider` element (track/fill/thumb). Returns { dragging, set(frac) }. */
export function makeSlider(el, { onInput, onCommit }) {
  const fill = el.querySelector(".slider-fill"), thumb = el.querySelector(".slider-thumb");
  const frac = (e) => {
    const r = el.getBoundingClientRect();
    return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
  };
  const api = {
    dragging: false,
    set(f) {
      fill.style.width = `${f * 100}%`;
      thumb.style.left = `${f * 100}%`;
    },
  };
  el.addEventListener("pointerdown", (e) => {
    api.dragging = true;
    el.classList.add("dragging");
    el.setPointerCapture(e.pointerId);
    api.set(frac(e));
    onInput?.(frac(e));
  });
  el.addEventListener("pointermove", (e) => {
    if (!api.dragging) return;
    api.set(frac(e));
    onInput?.(frac(e));
  });
  const end = (e) => {
    if (!api.dragging) return;
    api.dragging = false;
    el.classList.remove("dragging");
    onCommit?.(frac(e));
  };
  el.addEventListener("pointerup", end);
  el.addEventListener("pointercancel", end);
  return api;
}
