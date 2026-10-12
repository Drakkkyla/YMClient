// Full-screen "now playing": big cover + controls over a blurred background — the track's clip
// loop (Yandex's 10 s `previewUrl`) when it has one, the blurred cover otherwise.
import * as api from "./lib/api.js";
import * as player from "./lib/player.js";
import { esc, fmtTime, makeSlider, toast } from "./lib/ui.js";
import { artistLinks } from "./views.js";
import * as viz from "./viz.js";

const appWindow = window.__TAURI__.window.getCurrentWindow();
const $ = (s) => document.querySelector(s);
const fs = $("#fs");
const video = $("#fsVideo");

let isOpen = false;

// ---------- clip background ----------
const clipCache = new Map(); // track id -> previewUrl | null
let clipFor = null;

async function loadClip(t) {
  const id = String(t.id);
  if (clipFor === id) return;
  clipFor = id;
  fs.classList.remove("has-clip", "focus");
  video.classList.remove("in");
  video.pause();

  let url = clipCache.get(id);
  if (url === undefined) {
    try {
      const sup = await api.ym(`/tracks/${id}/supplement`);
      url = sup?.clips?.find((c) => c.previewUrl)?.previewUrl || null;
    } catch {
      url = null;
    }
    clipCache.set(id, url);
  }
  if (clipFor !== id) return;
  if (!url) {
    video.removeAttribute("src");
    video.load();
    return;
  }
  fs.classList.add("has-clip");
  video.src = url;
  syncVideo();
}

/** The clip moves only while the music does. */
function syncVideo() {
  if (!isOpen || !video.getAttribute("src")) return;
  if (player.state.playing) video.play().catch(() => {});
  else video.pause();
}

video.addEventListener("playing", () => video.classList.add("in"));
video.addEventListener("error", () => fs.classList.remove("has-clip", "focus"));

// ---------- rendering ----------
const progress = makeSlider($("#fsProgress"), {
  onInput: (f) => ($("#fsCur").textContent = fmtTime(f * player.state.duration)),
  onCommit: (f) => player.seek(f),
});

export function sync() {
  if (!isOpen) return;
  const { track: t, playing, loading, mode, shuffle, repeat, context } = player.state;
  if (!t) return close();

  fs.classList.toggle("wave", mode === "wave");
  fs.classList.toggle("paused", !playing); // phone: artwork shrinks while paused
  const cover = api.cover(t, 1000);
  for (const img of [$("#fsCover"), $("#fsBgCover")]) if (img.getAttribute("src") !== cover) img.src = cover;
  $("#fsTitle").textContent = t.title + (t.version ? ` (${t.version})` : "");
  $("#fsArtists").innerHTML = artistLinks(t);
  const alb = t.albums?.[0];
  $("#fsAlbum").innerHTML = alb ? `<span class="link" data-go="album" data-id="${alb.id}">${esc(alb.title)}</span>${alb.year ? ` · ${alb.year}` : ""}` : "";
  $("#fsFrom").innerHTML = context?.label
    ? `<span class="fs-from-k">Играет из</span><span class="link" data-action="now-playing">${esc(context.label)}</span>`
    : "";

  const pb = $("#fsPlay");
  pb.classList.toggle("loading", loading);
  pb.innerHTML = `<i class="ph-fill ${playing ? "ph-pause" : "ph-play"}"></i>`;
  pb.setAttribute("aria-label", playing ? "Пауза" : "Играть");
  $("#fsShuffle").classList.toggle("on", shuffle);
  $("#fsRepeat").classList.toggle("on", repeat !== "off");
  $("#fsRepeat").classList.toggle("repeat-one", repeat === "one");
  const liked = api.isLiked(t);
  $("#fsLike").classList.toggle("liked", liked);
  $("#fsLike").innerHTML = `<i class="${liked ? "ph-fill" : "ph"} ph-heart"></i>`;

  loadClip(t);
  syncVideo();
  syncLyrics(t);
  syncTime();
}

function syncTime() {
  if (isOpen) highlightLyrics();
  if (!isOpen || progress.dragging) return;
  const { time, duration } = player.state;
  progress.set(duration ? time / duration : 0);
  $("#fsCur").textContent = fmtTime(time);
  $("#fsDur").textContent = fmtTime(duration);
}

player.on((what) => (what === "time" ? syncTime() : sync()));

// ---------- lyrics (synced LRC when Yandex has it, plain text otherwise) ----------
const lyricsBox = $("#fsLyrics");
const lyricsCache = new Map(); // track id -> Promise<{ synced, lines: [{ t, text }] }>
let lyricsFor = null;
let lyricsLines = [];
let lyricsActive = -1;
let userScrolledAt = 0;
let showLyrics = localStorage.getItem("fsLyrics") === "1";

const lyricsInfo = (t) => {
  const i = t?.lyricsInfo || {};
  return { synced: !!i.hasAvailableSyncLyrics, any: !!(i.hasAvailableSyncLyrics || i.hasAvailableTextLyrics || t?.lyricsAvailable) };
};

/** "[mm:ss.xx] line" → [{ t, text }] sorted by time; a line may carry several timestamps. */
function parseLrc(text) {
  const out = [];
  for (const raw of text.split(/\r?\n/)) {
    const stamps = [...raw.matchAll(/\[(\d+):(\d+(?:[.:]\d+)?)\]/g)];
    if (!stamps.length) continue; // metadata like [ar:…] has no time
    const line = raw.replace(/\[[^\]]*\]/g, "").trim();
    for (const m of stamps) out.push({ t: +m[1] * 60 + parseFloat(m[2].replace(":", ".")), text: line });
  }
  return out.sort((a, b) => a.t - b.t);
}

function fetchLyrics(t) {
  const id = String(t.id);
  if (!lyricsCache.has(id)) {
    const { synced } = lyricsInfo(t);
    const p = api.lyrics(id, synced).then((r) =>
      r.format === "LRC"
        ? { synced: true, lines: parseLrc(r.text) }
        : { synced: false, lines: r.text.split(/\r?\n/).map((text) => ({ t: null, text: text.trim() })) },
    );
    p.catch(() => lyricsCache.delete(id)); // let a later open retry
    lyricsCache.set(id, p);
  }
  return lyricsCache.get(id);
}

function syncLyrics(t) {
  const { any } = lyricsInfo(t);
  fs.classList.toggle("has-lyrics", any);
  fs.classList.toggle("lyrics", any && showLyrics);
  $("#fsLyricsBtn").classList.toggle("on", any && showLyrics);
  if (!any || !showLyrics || lyricsFor === String(t.id)) return;
  lyricsFor = String(t.id);
  lyricsLines = [];
  lyricsActive = -1;
  lyricsBox.className = "fs-lyrics";
  lyricsBox.innerHTML = '<div class="lyr-state"><div class="spinner"></div></div>';
  fetchLyrics(t).then(
    ({ synced, lines }) => {
      if (lyricsFor !== String(t.id)) return;
      lyricsLines = lines;
      lyricsBox.classList.toggle("plain", !synced);
      lyricsBox.innerHTML = lines.length
        ? lines.map((l, i) => `<div class="lyr-line" data-i="${i}">${l.text ? esc(l.text) : "♪"}</div>`).join("")
        : '<div class="lyr-state">Текст пустой</div>';
      lyricsBox.scrollTop = 0;
      highlightLyrics(true);
    },
    (e) => {
      if (lyricsFor !== String(t.id)) return;
      lyricsFor = null; // reopening retries
      lyricsBox.innerHTML = `<div class="lyr-state">Текст недоступен<small>${esc(String(e?.message || e)).slice(0, 140)}</small></div>`;
    },
  );
}

function highlightLyrics(force = false) {
  if (!lyricsLines.length || lyricsBox.classList.contains("plain") || !fs.classList.contains("lyrics")) return;
  const time = player.state.time + 0.25; // lines read better slightly early
  let i = -1;
  for (let lo = 0, hi = lyricsLines.length - 1; lo <= hi; ) {
    const mid = (lo + hi) >> 1;
    if (lyricsLines[mid].t <= time) (i = mid), (lo = mid + 1);
    else hi = mid - 1;
  }
  if (i === lyricsActive && !force) return;
  lyricsActive = i;
  lyricsBox.querySelectorAll(".lyr-line").forEach((el, k) => {
    el.classList.toggle("active", k === i);
    el.classList.toggle("past", k < i);
  });
  // Keep the current line centred, unless the user is scrolling through the text themselves.
  const el = lyricsBox.querySelector(`.lyr-line[data-i="${Math.max(i, 0)}"]`);
  if (el && Date.now() - userScrolledAt > 2500) {
    lyricsBox.scrollTo({ top: el.offsetTop - lyricsBox.clientHeight / 2 + el.offsetHeight / 2, behavior: force ? "auto" : "smooth" });
  }
}

lyricsBox.addEventListener("wheel", () => (userScrolledAt = Date.now()), { passive: true });
lyricsBox.addEventListener("touchmove", () => (userScrolledAt = Date.now()), { passive: true });
lyricsBox.addEventListener("click", (e) => {
  const line = e.target.closest(".lyr-line");
  const l = line && lyricsLines[+line.dataset.i];
  if (l?.t == null || !player.state.duration) return;
  userScrolledAt = 0;
  player.seek(l.t / player.state.duration);
});

function toggleLyrics() {
  showLyrics = !showLyrics;
  localStorage.setItem("fsLyrics", showLyrics ? "1" : "0");
  if (showLyrics) fs.classList.remove("focus"); // lyrics and the unblurred clip don't mix
  lyricsFor = null;
  sync();
}

// ---------- open / close ----------
export function open() {
  if (!player.state.track || isOpen) return;
  isOpen = true;
  fs.hidden = false;
  requestAnimationFrame(() => {
    fs.classList.add("open");
    viz.refresh(); // .fs.open is a level-var target only once the class is on
  });
  sync();
}

export async function close() {
  if (!isOpen) return;
  isOpen = false;
  fs.classList.remove("open", "focus");
  video.pause();
  if (fs.classList.contains("os-full")) setOsFullscreen(false);
  setTimeout(() => !isOpen && (fs.hidden = true), 350);
  viz.refresh();
}

export const isOpenNow = () => isOpen;

// OS fullscreen state lives in the .os-full class — we're the only ones toggling it,
// so there's no need for an isFullscreen() round-trip.
async function setOsFullscreen(on) {
  try {
    await appWindow.setFullscreen(on);
    fs.classList.toggle("os-full", on);
    $("#fsOsBtn").innerHTML = `<i class="ph ${on ? "ph-arrows-in" : "ph-arrows-out"}"></i>`;
  } catch (e) {
    toast(`Не удалось переключить полноэкранный режим: ${e}`, "error");
  }
}

fs.addEventListener("click", (e) => {
  // Navigating somewhere (artist, album, "playing from") leaves the full-screen view.
  if (e.target.closest("[data-go], [data-action='now-playing']")) return close();
  const a = e.target.closest("[data-action]")?.dataset.action;
  if (a === "fs-close") close();
  else if (a === "fs-clip") fs.classList.toggle("focus");
  else if (a === "fs-lyrics") toggleLyrics();
  else if (a === "fs-os") setOsFullscreen(!fs.classList.contains("os-full"));
});

fs.addEventListener("dblclick", (e) => {
  if (!e.target.closest("button, .slider, .link")) setOsFullscreen(!fs.classList.contains("os-full"));
});

// Phone: swipe the player down to close it.
let swipe = null;
fs.addEventListener(
  "touchstart",
  (e) => {
    if (e.touches.length !== 1 || e.target.closest(".slider")) return;
    swipe = { x: e.touches[0].clientX, y: e.touches[0].clientY };
  },
  { passive: true },
);
fs.addEventListener(
  "touchmove",
  (e) => {
    if (!swipe) return;
    const dy = e.touches[0].clientY - swipe.y;
    const dx = Math.abs(e.touches[0].clientX - swipe.x);
    $(".fs-main").style.transform = dy > 0 && dy > dx ? `translateY(${dy * 0.6}px)` : "";
  },
  { passive: true },
);
fs.addEventListener("touchend", (e) => {
  if (!swipe) return;
  const dy = e.changedTouches[0].clientY - swipe.y;
  const dx = Math.abs(e.changedTouches[0].clientX - swipe.x);
  swipe = null;
  $(".fs-main").style.transform = "";
  if (dy > 110 && dy > dx * 1.5) close();
});

document.addEventListener("keydown", (e) => {
  if (!isOpen || e.key !== "Escape" || document.querySelector(".menu, .modal-backdrop")) return;
  close();
});
