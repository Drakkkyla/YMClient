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
  syncTime();
}

function syncTime() {
  if (!isOpen || progress.dragging) return;
  const { time, duration } = player.state;
  progress.set(duration ? time / duration : 0);
  $("#fsCur").textContent = fmtTime(time);
  $("#fsDur").textContent = fmtTime(duration);
}

player.on((what) => (what === "time" ? syncTime() : sync()));

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
