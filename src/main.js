import "@fontsource-variable/onest";
import "@phosphor-icons/web/regular";
import "@phosphor-icons/web/fill";
import "@phosphor-icons/web/bold";
import "./styles.css";

import * as api from "./lib/api.js";
import * as player from "./lib/player.js";
import { esc, fmtTime, toast, confirmDialog, promptDialog, sampleColor, makeSlider } from "./lib/ui.js";
import { openMenu, closeMenu } from "./lib/menu.js";
import * as views from "./views.js";
import * as viz from "./viz.js";
import * as eqPanel from "./eq.js";
import * as fullscreen from "./fullscreen.js";

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
const appWindow = window.__TAURI__.window.getCurrentWindow();

// macOS: native traffic lights live in the titlebar (see tauri.macos.conf.json), so our
// Windows-style window buttons are hidden and the brand shifts right.
if (/Mac/i.test(navigator.platform) && !player.IOS) document.documentElement.classList.add("mac");
// iOS: plain-audio playback (see player.js) — hide controls that need Web Audio / element volume.
if (player.IOS) document.documentElement.classList.add("ios");

const isPhone = () => matchMedia("(max-width: 760px)").matches;

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

// ======================= router =======================
const history = [];
let current = null;
let renderSeq = 0;

function go(name, params = {}, { push = true, replace = false } = {}) {
  if (current && push && !replace) history.push(current);
  current = { name, params };
  render();
}

function back() {
  if (!history.length) return go("wave", {}, { push: false });
  current = history.pop();
  render();
}

async function render() {
  const seq = ++renderSeq;
  const alive = () => seq === renderSeq;
  const { name, params } = current;
  views.lists.clear();
  const view = $("#view");
  view.replaceWith(view.cloneNode(false)); // drops old listeners, replays enter animation
  const root = $("#view");
  $("#main").scrollTop = 0;

  const navKey = name === "library" ? `library:${params.tab || "playlists"}` : name;
  $$(".nav-item").forEach((b) => b.classList.toggle("active", (b.dataset.tab ? `${b.dataset.go}:${b.dataset.tab}` : b.dataset.go) === navKey));
  const tabKey = ["library", "liked", "playlist", "album", "artist"].includes(name) ? "library" : name;
  $$(".tab-item[data-go]").forEach((b) => b.classList.toggle("active", b.dataset.go === tabKey));
  $$(".nav-pl").forEach((b) => b.classList.toggle("active", name === "playlist" && b.dataset.uid == params.uid && b.dataset.kind == params.kind));

  await (views[name] || views.wave)(root, params, alive);
  if (!alive()) return;
  if (name === "wave") updateWaveHero();
  viz.refresh();
}

// ======================= delegated clicks =======================
document.addEventListener("click", async (e) => {
  const t = e.target;
  // iOS taptic feedback on the controls that matter
  const hap = t.closest('[data-action="toggle"], [data-action="next"], [data-action="prev"], [data-action="wave-toggle"], .tab-item');
  if (hap) player.haptic(hap.classList.contains("tab-item") ? "selection" : "light");

  const win = t.closest("[data-win]");
  if (win) {
    const a = win.dataset.win;
    if (a === "min") appWindow.minimize();
    else if (a === "max") appWindow.toggleMaximize();
    else appWindow.close();
    return;
  }

  const action = t.closest("[data-action]");
  if (action && (await handleAction(action.dataset.action, action, e)) !== false) return;

  const playctx = t.closest("[data-playctx]");
  if (playctx) {
    e.stopPropagation();
    const btn = playctx;
    btn.disabled = true;
    try {
      const { tracks, context } = await views.resolvePlayCtx(btn.dataset.playctx);
      if (!tracks.length) toast("Здесь пока нечего слушать");
      else player.playList(tracks, 0, context);
    } catch (err) {
      toast(`Ошибка: ${err}`, "error");
    } finally {
      btn.disabled = false;
    }
    return;
  }

  const link = t.closest("[data-go]");
  if (link) {
    const { go: name, id, uid, kind, tab, replace } = link.dataset;
    const params = {};
    if (id) params.id = id;
    if (uid) params.uid = uid;
    if (kind) params.kind = kind;
    if (tab) params.tab = tab;
    go(name, params, { replace: !!replace });
    return;
  }

  const row = t.closest(".row[data-list]");
  if (row) {
    if (longPress?.fired) return (longPress = null); // the long-press already opened the menu
    playRow(row);
  }
});

// Touch: long-press a track row → the same menu as right-click.
let longPress = null;
document.addEventListener(
  "touchstart",
  (e) => {
    const row = e.target.closest(".row[data-list]");
    if (!row || e.touches.length > 1) return;
    const { clientX: x, clientY: y } = e.touches[0];
    longPress = {
      x,
      y,
      fired: false,
      timer: setTimeout(() => {
        const hit = rowTrack(row);
        if (!hit) return;
        longPress.fired = true;
        player.haptic("medium");
        trackMenu(hit.track, { x, y }, row);
      }, 450),
    };
  },
  { passive: true },
);
document.addEventListener(
  "touchmove",
  (e) => {
    if (!longPress || longPress.fired) return;
    const t = e.touches[0];
    if (Math.hypot(t.clientX - longPress.x, t.clientY - longPress.y) > 10) clearTimeout(longPress.timer), (longPress = null);
  },
  { passive: true },
);
document.addEventListener("touchend", () => longPress && !longPress.fired && (clearTimeout(longPress.timer), (longPress = null)));

function rowTrack(row) {
  const list = views.lists.get(row.dataset.list);
  return list && { list, track: list.tracks[+row.dataset.i], index: +row.dataset.i };
}

function playRow(row) {
  const hit = rowTrack(row);
  if (!hit) return;
  const cur = player.state.track;
  if (cur && String(cur.id) === String(hit.track.id)) return player.toggle();
  player.playList(hit.list.tracks, hit.index, hit.list.context, { shuffle: false });
}

async function toggleLike(track) {
  const on = !api.isLiked(track);
  try {
    await api.setLike(track, on);
    if (on) player.haptic("success");
    syncLikes(track.id);
    if (on && player.state.mode === "wave" && String(player.state.track?.id) === String(track.id))
      api.wave.feedback(player.state.station.id, "like", track._batch, { trackId: api.trackKey(track) });
  } catch (err) {
    toast(`Не удалось: ${err}`, "error");
  }
}

function syncLikes(id) {
  const liked = api.likes.tracks.has(String(id));
  $$(`.row[data-tid="${id}"] .like`).forEach((b) => {
    b.classList.toggle("liked", liked);
    b.innerHTML = `<i class="${liked ? "ph-fill" : "ph"} ph-heart"></i>`;
  });
  views.renderHistory();
  updatePlayer();
}

// ======================= track menu & playlists =======================
function trackMenu(track, pos, row) {
  const hit = row && rowTrack(row);
  const liked = api.isLiked(track);
  const alb = track.albums?.[0];
  const art = track.artists?.[0];
  const items = [
    { icon: "ph-queue", label: "Играть следующим", onClick: () => player.playNext(track) },
    { icon: "ph-plus-circle", label: "Добавить в плейлист", submenu: () => playlistPicker(track) },
    {
      icon: "ph-waveform",
      label: "Волна по треку",
      onClick: () => player.startWave({ id: `track:${track.id}`, label: `Волна по треку «${track.title}»`, route: { name: "wave" } }),
    },
    { icon: liked ? "ph-heart-break" : "ph-heart", label: liked ? "Убрать из «Мне нравится»" : "Мне нравится", onClick: () => toggleLike(track) },
  ];
  if (hit?.list.playlist?.own)
    items.push({ icon: "ph-trash", label: "Удалить из плейлиста", danger: true, onClick: () => removeFromPlaylist(row) });
  items.push({ sep: true });
  if (alb) items.push({ icon: "ph-vinyl-record", label: "Перейти к альбому", onClick: () => go("album", { id: String(alb.id) }) });
  if (art) items.push({ icon: "ph-microphone-stage", label: "Перейти к исполнителю", onClick: () => go("artist", { id: String(art.id) }) });
  const artists = (track.artists || []).filter((a) => a.id);
  if (artists.length === 1)
    items.push({ icon: "ph-prohibit", label: `Не рекомендовать ${artists[0].name}`, onClick: () => player.blockArtist(artists[0]) });
  else if (artists.length > 1)
    items.push({
      icon: "ph-prohibit",
      label: "Не рекомендовать исполнителя",
      submenu: async () => artists.map((a) => ({ icon: "ph-user", label: a.name, onClick: () => player.blockArtist(a) })),
    });
  const url = api.webUrl(track);
  if (url)
    items.push({
      icon: "ph-link",
      label: "Скопировать ссылку",
      onClick: () => navigator.clipboard.writeText(url).then(() => toast("Ссылка скопирована"), () => toast("Не удалось скопировать", "error")),
    });
  openMenu(pos, items);
}

/** Playlist list for a track; playlists already containing it get a check and toggle it off. */
async function playlistPicker(track) {
  const pls = await api.ownPlaylistsWithTracks();
  return [
    { icon: "ph-plus", label: "Новый плейлист", onClick: () => createPlaylistWith(track) },
    ...(pls.length ? [{ sep: true }] : []),
    ...pls.map((p) => {
      const pos = p.trackIds.indexOf(String(track.id));
      return {
        img: api.cover(p, 100),
        label: p.title,
        check: pos >= 0,
        onClick: () => (pos >= 0 ? removeTrackFrom(p, pos, track) : addTrackTo(p, track)),
      };
    }),
  ];
}

const isOpenPlaylist = (pl) =>
  current?.name === "playlist" && String(current.params.uid) === String(api.me.uid) && String(current.params.kind) === String(pl.kind);

async function removeTrackFrom(pl, pos, track) {
  try {
    await api.removeFromPlaylist(pl.kind, pl.revision, pos, track);
    toast(`Убрано из «${pl.title}»`);
    if (isOpenPlaylist(pl)) render();
  } catch (e) {
    toast(`Не удалось убрать: ${e}`, "error");
  }
}

async function addTrackTo(pl, track) {
  try {
    await api.addToPlaylist(pl, track);
    toast(`Добавлено в «${pl.title}»`);
    if (isOpenPlaylist(pl)) render();
  } catch (e) {
    toast(`Не удалось добавить: ${e}`, "error");
  }
}

async function createPlaylistWith(track) {
  const title = await promptDialog({ title: "Новый плейлист", placeholder: "Название плейлиста", ok: "Создать" });
  if (!title) return;
  try {
    const pl = await api.createPlaylist(title);
    if (track) await addTrackTo(pl, track);
    else toast(`Плейлист «${title}» создан`);
    renderSidebarPlaylists();
  } catch (e) {
    toast(`Не удалось создать плейлист: ${e}`, "error");
  }
}

async function removeFromPlaylist(row) {
  const hit = rowTrack(row);
  if (!hit) return;
  const { list, track, index } = hit;
  const pl = list.playlist;
  const ok = await confirmDialog({
    title: "Удалить трек из плейлиста?",
    text: `«${track.title}» будет удалён из «${pl.title}».`,
    ok: "Удалить",
    danger: true,
  });
  if (!ok) return;
  try {
    const res = await api.removeFromPlaylist(pl.kind, pl.revision, track._pos, track);
    pl.revision = res?.revision ?? pl.revision + 1;
    list.tracks.splice(index, 1);
    list.tracks.forEach((t) => t._pos > track._pos && t._pos--);
    const box = $(`.row[data-list="${row.dataset.list}"]`)?.closest(".tracks");
    if (box) box.innerHTML = list.tracks.length ? views.trackRows(list.tracks, row.dataset.list) : '<div class="empty"><i class="ph ph-playlist"></i>Плейлист пуст</div>';
    const meta = $("#plMeta");
    if (meta) meta.innerHTML = views.playlistMeta({ tracks: list.tracks, owner: { name: api.me.name } });
    viz.refresh();
    toast("Трек удалён из плейлиста");
  } catch (e) {
    toast(`Не удалось удалить: ${e}`, "error");
  }
}

document.addEventListener("contextmenu", (e) => {
  if (e.target.closest("input, textarea")) return;
  e.preventDefault(); // no browser menu (Reload / Inspect) inside the app
  const row = e.target.closest(".row[data-list]");
  const hit = row && rowTrack(row);
  if (hit) trackMenu(hit.track, { x: e.clientX, y: e.clientY }, row);
});

function anchorPos(el) {
  const r = el.getBoundingClientRect();
  return { x: r.left, y: r.bottom + 4, flipY: r.top - 4 };
}

function toggleHistory(force) {
  const open = $("#historyPanel").classList.toggle("open", force);
  if (open) views.renderHistory();
}

$("#historyList").addEventListener("click", (e) => {
  const item = e.target.closest(".q-item[data-h]");
  if (!item || e.target.closest("[data-action]")) return;
  const tracks = player.state.history.slice();
  player.playList(tracks, +item.dataset.h, { label: "История волны", route: { name: "wave" } }, { shuffle: false });
});

function togglePanel(which) {
  const opening = which === "eq" ? !$("#eqPanel").classList.contains("open") : !$("#queuePanel").classList.contains("open");
  toggleQueue(which === "queue" && opening);
  eqPanel.toggle(which === "eq" && opening);
  $("#btnEq").classList.toggle("open", which === "eq" && opening);
}

async function handleAction(name, el, e) {
  switch (name) {
    case "back": return back();
    case "toggle": return player.toggle();
    case "next": return player.next();
    case "prev": return player.prev();
    case "shuffle": return player.toggleShuffle();
    case "repeat": return player.cycleRepeat();
    case "mute": return player.toggleMute();
    case "dislike": return player.dislikeCurrent();
    case "queue": return togglePanel("queue");
    case "eq": return togglePanel("eq");
    case "track-menu": {
      e.stopPropagation();
      const row = el.closest(".row");
      const hit = rowTrack(row);
      return hit && trackMenu(hit.track, anchorPos(el), row);
    }
    case "add-current": {
      const t = player.state.track;
      return t && openMenu(anchorPos(el), playlistPicker(t));
    }
    case "settings": return openSettings();
    case "login": return startLogin();
    case "like": {
      e.stopPropagation();
      const hit = rowTrack(el.closest(".row"));
      return hit && toggleLike(hit.track);
    }
    case "like-current": return player.state.track && toggleLike(player.state.track);
    case "wave-toggle":
      if (isPlayingStation(player.MY_WAVE.id)) return player.toggle();
      return player.startWave();
    case "station": {
      const id = el.dataset.station;
      if (isPlayingStation(id)) return player.toggle();
      return player.startWave({ id, label: el.dataset.label, route: stationRoute(id) });
    }
    case "history": return toggleHistory();
    case "history-like": {
      e.stopPropagation();
      const t = player.state.history[+el.dataset.h];
      return t && toggleLike(t);
    }
    case "station-tab": return views.renderStations($("#waveStations"), el.dataset.stationTab);
    case "sleep": return openMenu(anchorPos(el), sleepMenu());
    case "wave-setting": return applyWaveSetting(el.dataset.group, el.dataset.value);
    case "play-list":
    case "shuffle-list": {
      const list = views.lists.get(el.dataset.list);
      if (!list?.tracks.length) return toast("Треки ещё загружаются");
      return player.playList(list.tracks, name === "shuffle-list" ? undefined : 0, list.context, { shuffle: name === "shuffle-list" });
    }
    case "play-best": {
      const list = views.lists.get(el.dataset.list);
      const i = list?.tracks.findIndex((t) => String(t.id) === el.dataset.tid);
      if (i >= 0) player.playList(list.tracks, i, list.context, { shuffle: false });
      return;
    }
    case "now-playing": {
      const r = player.state.context?.route;
      if (r) go(r.name, r.params || {});
      return;
    }
  }
  return false;
}

async function applyWaveSetting(group, value) {
  const s = views.waveSettings();
  s[group] = value;
  localStorage.setItem("waveSettings", JSON.stringify(s));
  $$(`.chip[data-group="${group}"]`).forEach((c) => c.classList.toggle("on", c.dataset.value === value));
  try {
    await api.wave.settings(s);
    if (isPlayingStation(player.MY_WAVE.id)) player.startWave();
  } catch (err) {
    toast(`Не удалось применить настройки волны: ${err}`, "error");
  }
}

// ======================= player bar =======================
const playerEl = $("#player");

function updatePlayer() {
  const { track: t, playing, loading, mode, shuffle, repeat } = player.state;
  playerEl.classList.toggle("wave", mode === "wave");
  playerEl.classList.toggle("empty", !t); // phone: the floating mini player appears with the first track
  $("#npTitle").textContent = t ? t.title + (t.version ? ` (${t.version})` : "") : "Ничего не играет";
  $("#npArtists").innerHTML = t ? views.artistLinks(t) : "Запустите Мою волну";
  const cov = t ? api.cover(t, 200) : "";
  if ($("#npCover").getAttribute("src") !== cov) cov ? $("#npCover").setAttribute("src", cov) : $("#npCover").removeAttribute("src");
  const liked = t && api.isLiked(t);
  $("#npLike").classList.toggle("liked", !!liked);
  $("#npLike").innerHTML = `<i class="${liked ? "ph-fill" : "ph"} ph-heart"></i>`;
  $("#npLike").style.visibility = t ? "" : "hidden";
  $("#npAdd").style.visibility = t ? "" : "hidden";

  const pb = $("#btnPlay");
  pb.classList.toggle("loading", loading);
  pb.innerHTML = `<i class="ph-fill ${playing ? "ph-pause" : "ph-play"}"></i>`;
  pb.setAttribute("aria-label", playing ? "Пауза" : "Играть");
  $("#btnShuffle").classList.toggle("on", shuffle);
  const rb = $("#btnRepeat");
  rb.classList.toggle("on", repeat !== "off");
  rb.classList.toggle("repeat-one", repeat === "one");

  // rows
  $$(".row.is-current").forEach((r) => r.classList.remove("is-current", "is-playing"));
  if (t) $$(`.row[data-tid="${t.id}"]`).forEach((r) => r.classList.add("is-current", ...(playing ? ["is-playing"] : [])));
  updateWaveHero();
  fullscreen.sync();
  viz.refresh();
}

const isPlayingStation = (id) => player.state.mode === "wave" && player.state.station.id === id && !!player.state.track;

/** Where "playing from" leads for a station: the seed's page, or the wave screen. */
function stationRoute(id) {
  const [type, tag] = id.split(":");
  if (type === "artist") return { name: "artist", params: { id: tag } };
  if (type === "album") return { name: "album", params: { id: tag } };
  return { name: "wave" };
}

function updateWaveHero() {
  const now = $("#waveNow");
  if (!now) return;
  const { track: t, mode, playing, loading } = player.state;
  const inWave = isPlayingStation(player.MY_WAVE.id) && t;
  $("#wavePlay").innerHTML = `<i class="ph-fill ${inWave && playing ? "ph-pause" : "ph-play"}"></i>`;
  now.innerHTML = inWave
    ? `<img src="${esc(api.cover(t, 100))}" alt="" /><div><div class="t">${esc(t.title)}</div><div class="a">${views.artistLinks(t)}</div></div>`
    : loading && mode === "wave" && player.state.station.id === player.MY_WAVE.id
      ? '<div class="spinner"></div>'
      : "";
  views.markStations();
}

let lastAmbient = null;
async function updateAmbient() {
  const t = player.state.track;
  const url = t ? api.cover(t, 100) : null;
  if (url === lastAmbient) return;
  lastAmbient = url;
  const rgb = (await sampleColor(url)) || [138, 99, 255];
  if (url !== lastAmbient) return;
  document.documentElement.style.setProperty("--ambient", rgb.join(", "));
  viz.setColor(rgb);
}

player.on((what) => {
  if (what === "eq") return $("#btnEq").classList.toggle("on", player.eq.enabled);
  if (what === "history") return views.renderHistory();
  if (what === "sleep") return updateSleep();
  if (what === "settings") return;
  if (what === "time") return updateTime();
  if (what === "volume") return updateVolume();
  if (what === "queue") return renderQueue();
  if (what === "track") (updateAmbient(), renderQueue(), views.renderHistory());
  updatePlayer();
});

// ======================= sliders =======================
const progress = makeSlider($("#progress"), {
  onInput: (f) => ($("#tCur").textContent = fmtTime(f * player.state.duration)),
  onCommit: (f) => player.seek(f),
});
const volume = makeSlider($("#volume"), { onInput: (f) => player.setVolume(f) });
$("#volume").addEventListener("wheel", (e) => player.setVolume(player.state.volume - Math.sign(e.deltaY) * 0.05), { passive: true });

function updateTime() {
  if (progress.dragging) return;
  const { time, duration } = player.state;
  progress.set(duration ? time / duration : 0);
  $("#tCur").textContent = fmtTime(time);
  $("#tDur").textContent = fmtTime(duration);
}

function updateVolume() {
  const { volume: v, muted } = player.state;
  volume.set(muted ? 0 : v);
  const icon = muted || v === 0 ? "ph-speaker-x" : v < 0.5 ? "ph-speaker-low" : "ph-speaker-high";
  $("#btnMute").innerHTML = `<i class="ph ${icon}"></i>`;
}

// ======================= queue =======================
function toggleQueue(force) {
  const open = $("#queuePanel").classList.toggle("open", force);
  $("#btnQueue").classList.toggle("on", open);
  if (open) renderQueue();
}

function renderQueue() {
  const panel = $("#queuePanel");
  if (!panel.classList.contains("open")) return;
  const { queue, index, context } = player.state;
  $("#queueFrom").innerHTML = context ? `Играет из: <span class="link" data-action="now-playing">${esc(context.label || "")}</span>` : "";
  const list = $("#queueList");
  if (!queue.length) {
    list.innerHTML = '<div class="empty"><i class="ph ph-queue"></i>Очередь пуста</div>';
    return;
  }
  // Keep it light for huge queues: a bit of history plus what's ahead.
  const from = Math.max(0, index - 5);
  const to = Math.min(queue.length, index + 150);
  list.innerHTML = queue
    .slice(from, to)
    .map((t, k) => {
      const i = from + k;
      const cls = i === index ? " current" : i < index ? " past" : "";
      return `<div class="q-item${cls}" data-q="${i}">${api.cover(t, 100) ? `<img src="${esc(api.cover(t, 100))}" alt="" loading="lazy" />` : "<img />"}
        <div><div class="q-t">${esc(t.title)}</div><div class="q-a">${esc(api.artistsOf(t))}</div></div></div>`;
    })
    .join("");
  $(".q-item.current", list)?.scrollIntoView({ block: "nearest" });
}

$("#queueList").addEventListener("click", (e) => {
  const item = e.target.closest("[data-q]");
  if (item) player.jump(+item.dataset.q);
});
$("#npCover").addEventListener("click", () => fullscreen.open());
$("#npTitle").addEventListener("click", () => fullscreen.open());
// Phone mini-player: tapping anywhere but its buttons/links opens the full-screen player.
$(".np").addEventListener("click", (e) => {
  if (isPhone() && !e.target.closest("button, .link, #npCover, #npTitle")) fullscreen.open();
});

// ======================= sleep timer =======================
function sleepMenu() {
  const s = player.sleep;
  const items = [];
  if (s.mode) items.push({ icon: "ph-x-circle", label: "Выключить таймер", danger: true, onClick: () => (player.setSleep(null), toast("Таймер сна выключен")) }, { sep: true });
  for (const m of [15, 30, 45, 60, 90])
    items.push({ icon: "ph-timer", label: `Через ${m} мин`, onClick: () => (player.setSleep("time", m), toast(`Музыка плавно остановится через ${m} мин`)) });
  items.push({
    icon: "ph-music-note",
    label: "После этого трека",
    check: s.mode === "track",
    onClick: () => (player.setSleep("track"), toast("Музыка остановится после этого трека")),
  });
  return items;
}

function updateSleep() {
  const { mode, until } = player.sleep;
  const btn = $("#btnSleep");
  btn.classList.toggle("on", !!mode);
  const left = mode === "time" ? Math.max(1, Math.ceil((until - Date.now()) / 60000)) : 0;
  $("#sleepLeft").textContent = mode === "time" ? `${left}м` : mode === "track" ? "трек" : "";
  btn.setAttribute("aria-label", mode ? `Таймер сна: ${mode === "time" ? `осталось ${left} мин` : "после этого трека"}` : "Таймер сна");
}
setInterval(() => player.sleep.mode === "time" && updateSleep(), 15000);

// ======================= settings =======================
const CROSSFADES = [0, 3, 6, 9, 12];

function blockedList() {
  const list = player.state.blocked;
  return list.length
    ? list.map((a) => `<span class="blocked-chip">${esc(a.name)}<button data-s="unblock" data-id="${esc(a.id)}" aria-label="Вернуть ${esc(a.name)}"><i class="ph ph-x"></i></button></span>`).join("")
    : '<span class="s-d">Пусто. Добавить можно через меню трека: «Не рекомендовать…»</span>';
}

function openSettings() {
  const wrap = document.createElement("div");
  wrap.className = "modal-backdrop";
  wrap.innerHTML = `
    <div class="modal" role="dialog" aria-modal="true">
      <h3>Настройки</h3>
      <div style="margin-top:10px">
        <div class="setting web-audio-only">
          <div><div class="s-t">Выравнивать громкость</div><div class="s-d">Тихие и громкие треки звучат одинаково (по данным Яндекса о громкости)</div></div>
          <button class="switch${player.state.normalize ? " on" : ""}" data-s="normalize" aria-label="Выравнивание громкости"></button>
        </div>
        <div class="setting setting-col web-audio-only">
          <div><div class="s-t">Плавный переход</div><div class="s-d">Треки перетекают друг в друга, а не обрываются</div></div>
          <div class="chips">${CROSSFADES.map((v) => `<button class="chip${player.state.crossfade === v ? " on" : ""}" data-s="xf" data-v="${v}">${v ? `${v} с` : "Выкл"}</button>`).join("")}</div>
        </div>
        <div class="setting setting-col">
          <div><div class="s-t">Не рекомендовать в волнах</div><div class="s-d">Эти исполнители не будут звучать в Моей волне и других станциях</div></div>
          <div class="blocked" id="blockedList">${blockedList()}</div>
        </div>
        <div class="setting">
          <div><div class="s-t">Статус в Discord</div><div class="s-d">Показывать, что вы слушаете, в профиле Discord</div></div>
          <button class="switch${player.state.rpc ? " on" : ""}" data-s="rpc" aria-label="Discord RPC"></button>
        </div>
        <div class="setting">
          <div><div class="s-t">${esc(api.me.name)}</div><div class="s-d">${esc(api.me.login)}${api.me.hasPlus ? " · Плюс активен" : " · без подписки Плюс"}</div></div>
          <button class="btn btn-ghost" data-s="logout"><i class="ph ph-sign-out"></i>Выйти</button>
        </div>
      </div>
      <div class="modal-actions"><button class="btn btn-ghost" data-s="close">Готово</button></div>
    </div>`;
  const close = () => {
    wrap.classList.remove("in");
    setTimeout(() => wrap.remove(), 200);
  };
  wrap.addEventListener("click", async (e) => {
    if (e.target === wrap) return close();
    const s = e.target.closest("[data-s]")?.dataset.s;
    if (s === "close") close();
    if (s === "normalize") {
      player.setNormalize(!player.state.normalize);
      e.target.closest(".switch").classList.toggle("on", player.state.normalize);
    }
    if (s === "xf") {
      const btn = e.target.closest("[data-v]");
      player.setCrossfade(+btn.dataset.v);
      wrap.querySelectorAll('[data-s="xf"]').forEach((c) => c.classList.toggle("on", c === btn));
    }
    if (s === "unblock") {
      player.unblockArtist(e.target.closest("[data-id]").dataset.id);
      wrap.querySelector("#blockedList").innerHTML = blockedList();
    }
    if (s === "rpc") {
      player.setRpc(!player.state.rpc);
      e.target.closest(".switch").classList.toggle("on", player.state.rpc);
    }
    if (s === "logout") {
      close();
      const ok = await confirmDialog({ title: "Выйти из аккаунта?", text: "Токен будет удалён с этого компьютера.", ok: "Выйти", danger: true });
      if (!ok) return;
      await invoke("logout");
      location.reload();
    }
  });
  document.body.append(wrap);
  requestAnimationFrame(() => wrap.classList.add("in"));
}

// ======================= auth & boot =======================
async function startLogin() {
  try {
    await invoke("login");
  } catch (e) {
    toast(`Не удалось открыть окно входа: ${e}`, "error");
  }
}

$("#tokenForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    await invoke("set_token", { token: $("#tokenInput").value });
    await boot();
  } catch (err) {
    toast(String(err), "error");
  }
});

listen("auth-changed", () => boot());
listen("auth-error", (e) => toast(`Ошибка входа: ${e.payload}`, "error"));

async function renderSidebarPlaylists() {
  try {
    const pls = await api.myPlaylists();
    $("#navPlaylists").innerHTML = pls
      .map((p) => {
        const c = api.cover(p, 100);
        return `<button class="nav-pl" data-go="playlist" data-uid="${views.plUid(p)}" data-kind="${p.kind}">
          ${c ? `<img src="${esc(c)}" alt="" loading="lazy" />` : '<span class="ph-thumb"></span>'}<span>${esc(p.title)}</span></button>`;
      })
      .join("");
  } catch {}
}

/** Swap the letter avatar for the Yandex ID photo once it has actually loaded. */
async function loadAvatar() {
  try {
    const url = await invoke("avatar_url");
    if (!url) return;
    const img = new Image();
    img.alt = "";
    img.onload = () => $("#avatar").replaceChildren(img);
    img.src = url;
  } catch {} // no avatar scope / network — the letter stays
}

async function boot() {
  const login = $("#login");
  if (!(await invoke("has_token"))) {
    login.hidden = false;
    return;
  }
  try {
    const me = await api.loadAccount();
    login.hidden = true;
    $("#avatar").textContent = (me.name || "?").trim()[0].toUpperCase();
    loadAvatar();
    $("#accountName").textContent = me.name;
    const sub = $("#accountSub");
    sub.textContent = me.hasPlus ? "Плюс" : "Без подписки";
    sub.classList.toggle("plus", me.hasPlus);
    api.likedTrackRefs().catch(() => {});
    renderSidebarPlaylists();
    go("wave", {}, { push: false });
  } catch (e) {
    login.hidden = false;
    toast(`Вход не удался: ${e}`, "error");
  }
}

// ======================= keyboard =======================
document.addEventListener("keydown", (e) => {
  const typing = e.target.closest("input, textarea, [contenteditable]");
  if (e.key === "Escape") {
    if ($(".menu, .modal-backdrop")) return;
    toggleQueue(false);
    toggleHistory(false);
    eqPanel.toggle(false);
    $("#btnEq").classList.remove("open");
    return;
  }
  if (typing) return;
  if (e.code === "Space") {
    e.preventDefault();
    player.toggle();
  } else if (e.ctrlKey && e.key === "ArrowRight") player.next();
  else if (e.ctrlKey && e.key === "ArrowLeft") player.prev();
  else if (e.key === "ArrowRight" && player.state.duration) player.seek((player.state.time + 10) / player.state.duration);
  else if (e.key === "ArrowLeft" && player.state.duration) player.seek((player.state.time - 10) / player.state.duration);
  else if (e.key === "ArrowUp") (e.preventDefault(), player.setVolume(player.state.volume + 0.05));
  else if (e.key === "ArrowDown") (e.preventDefault(), player.setVolume(player.state.volume - 0.05));
  else if (e.ctrlKey && e.key.toLowerCase() === "f") (e.preventDefault(), go("search"));
});
document.addEventListener("mouseup", (e) => {
  if (e.button === 3) back();
});

$("#btnEq").classList.toggle("on", player.eq.enabled);
updateSleep();
updatePlayer();
updateTime();
updateVolume();
viz.start();
boot();
