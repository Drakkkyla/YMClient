// Page renderers. Each view gets (root, params, alive) and fills `root`; `alive()` turns false
// once the user navigated elsewhere, so late responses don't clobber a newer page.
import * as api from "./lib/api.js";
import * as player from "./lib/player.js";
import { esc, fmtTime, fmtTotal, plural } from "./lib/ui.js";

// ---------- track list registry (rows reference lists by id) ----------
export const lists = new Map();
let listSeq = 0;
export function registerList(tracks, context, extra = {}) {
  const id = `l${++listSeq}`;
  lists.set(id, { tracks, context, ...extra });
  return id;
}

// ---------- components ----------
const img = (src, cls = "", alt = "") => (src ? `<img class="${cls}" src="${esc(src)}" alt="${esc(alt)}" loading="lazy" />` : "");

export const artistLinks = (t) =>
  (t.artists || []).map((a) => `<span class="link" data-go="artist" data-id="${a.id}">${esc(a.name)}</span>`).join(", ");

export function trackRow(t, i, listId) {
  const cur = player.state.track;
  const isCur = cur && String(cur.id) === String(t.id);
  const liked = api.isLiked(t);
  const alb = t.albums?.[0];
  const cls = ["row", isCur && "is-current", isCur && player.state.playing && "is-playing", t.available === false && "is-off"]
    .filter(Boolean)
    .join(" ");
  return `<div class="${cls}" data-list="${listId}" data-i="${i}" data-tid="${t.id}">
    <div class="row-num"><span class="n">${i + 1}</span><i class="ph-fill ph-play"></i><i class="ph-fill ph-pause"></i><span class="eq"><b></b><b></b><b></b></span></div>
    ${img(api.cover(t, 100), "row-cover") || '<div class="row-cover"></div>'}
    <div class="row-main">
      <div class="row-title">${esc(t.title)}${t.version ? ` <span class="ver">${esc(t.version)}</span>` : ""}${t.contentWarning === "explicit" ? '<span class="badge-e">E</span>' : ""}</div>
      <div class="row-artists">${artistLinks(t)}</div>
    </div>
    <div class="row-album">${alb ? `<span class="link" data-go="album" data-id="${alb.id}">${esc(alb.title)}</span>` : ""}</div>
    <button class="icon-btn like${liked ? " liked" : ""}" data-action="like" aria-label="Нравится"><i class="${liked ? "ph-fill" : "ph"} ph-heart"></i></button>
    <button class="icon-btn more" data-action="track-menu" aria-label="Ещё"><i class="ph-bold ph-dots-three"></i></button>
    <div class="row-dur">${fmtTime((t.durationMs || 0) / 1000)}</div>
  </div>`;
}

export const trackRows = (tracks, listId, offset = 0) => tracks.map((t, i) => trackRow(t, i + offset, listId)).join("");

function card({ round, go, art, fallbackIcon, title, sub, playctx }) {
  return `<div class="card${round ? " round" : ""}" ${go}>
    <div class="card-art">${art ? img(art) : `<div class="art-fallback"><i class="ph ${fallbackIcon}"></i></div>`}
      ${playctx ? `<button class="card-play" data-playctx="${esc(playctx)}" aria-label="Слушать"><i class="ph-fill ph-play"></i></button>` : ""}
    </div>
    <div class="card-title">${esc(title)}</div>
    <div class="card-sub">${sub}</div>
  </div>`;
}

export const albumCard = (a) =>
  card({
    go: `data-go="album" data-id="${a.id}"`,
    art: api.cover(a, 400),
    fallbackIcon: "ph-vinyl-record",
    title: a.title,
    sub: [esc((a.artists || []).map((x) => x.name).join(", ")), a.year].filter(Boolean).join(" · "),
    playctx: `album:${a.id}`,
  });

export const plUid = (p) => p.owner?.uid ?? p.uid;
export const playlistCard = (p) =>
  card({
    go: `data-go="playlist" data-uid="${plUid(p)}" data-kind="${p.kind}"`,
    art: api.cover(p, 400),
    fallbackIcon: "ph-playlist",
    title: p.title,
    sub: esc(p.trackCount != null ? plural(p.trackCount, "трек", "трека", "треков") : p.owner?.name || ""),
    playctx: `playlist:${plUid(p)}:${p.kind}`,
  });

export const artistCard = (a) =>
  card({
    round: true,
    go: `data-go="artist" data-id="${a.id}"`,
    art: api.cover(a, 400),
    fallbackIcon: "ph-user",
    title: a.name,
    sub: "Исполнитель",
    playctx: `artist:${a.id}`,
  });

const likedCard = (count) =>
  `<div class="card" data-go="liked">
    <div class="card-art"><div class="art-fallback liked-art"><i class="ph-fill ph-heart"></i></div>
      <button class="card-play" data-playctx="liked" aria-label="Слушать"><i class="ph-fill ph-play"></i></button></div>
    <div class="card-title">Мне нравится</div>
    <div class="card-sub">${count != null ? plural(count, "трек", "трека", "треков") : "Ваши любимые треки"}</div>
  </div>`;

const skeletonGrid = (n = 6) =>
  `<div class="grid">${Array.from({ length: n }, () => '<div><div class="skeleton" style="aspect-ratio:1"></div><div class="skeleton" style="height:14px;margin-top:10px;width:70%"></div></div>').join("")}</div>`;
const skeletonRows = (n = 8) => Array.from({ length: n }, () => '<div class="skeleton sk-row"></div>').join("");
const empty = (icon, text) => `<div class="empty"><i class="ph ${icon}"></i>${esc(text)}</div>`;
const errorBox = (e) => empty("ph-cloud-slash", `Не удалось загрузить: ${e?.message || e}`);
const backBtn = `<button class="back-btn" data-action="back" aria-label="Назад"><i class="ph ph-arrow-left"></i></button>`;

function heroBlock({ round, art, fallbackIcon, kind, title, meta, actions = "" }) {
  return `<header class="hero${round ? " round" : ""}">
    <div class="hero-art">${art ? img(art, "", title) : `<div class="art-fallback">${fallbackIcon}</div>`}</div>
    <div class="hero-text">
      <div class="hero-kind">${esc(kind)}</div>
      <h1 class="hero-title">${esc(title)}</h1>
      <div class="hero-meta">${meta}</div>
      <div class="hero-actions">${actions}</div>
    </div>
  </header>`;
}

const playActions = (listId) => `
  <button class="btn btn-accent" data-action="play-list" data-list="${listId}"><i class="ph-fill ph-play"></i>Слушать</button>
  <button class="btn btn-ghost" data-action="shuffle-list" data-list="${listId}"><i class="ph ph-shuffle"></i>Перемешать</button>`;

/** "Волна" button that starts a seeded rotor station (artist:ID, album:ID, track:ID). */
export const stationBtn = (station, label, text = "Волна") =>
  `<button class="btn btn-ghost" data-action="station" data-station="${esc(station)}" data-label="${esc(label)}"><i class="ph ph-waveform"></i>${esc(text)}</button>`;

// ---------- Моя волна ----------
const STATION_TABS = [
  ["mood", "Настроение"],
  ["activity", "Занятие"],
  ["epoch", "Эпоха"],
  ["genre", "Жанр"],
];
let stationTab = "mood";

function stationChip(st) {
  const playing = player.state.mode === "wave" && player.state.station.id === st.id;
  return `<button class="station${playing ? " on" : ""}" data-action="station" data-station="${esc(st.id)}" data-label="${esc(st.label)}" style="--st:${esc(st.color)}">
    <span class="station-icon">${st.icon ? `<img src="${esc(st.icon)}" alt="" loading="lazy" />` : ""}</span>
    <span class="station-name">${esc(st.label)}</span>
  </button>`;
}

export async function renderStations(box, tab = stationTab) {
  stationTab = tab;
  box.querySelectorAll(".tab").forEach((b) => b.classList.toggle("active", b.dataset.stationTab === tab));
  const grid = box.querySelector(".stations");
  try {
    const groups = await api.stationCatalog();
    // Genres come as a tree (rock → indie, post-punk…); top level only keeps the list browsable.
    const list = (groups[tab] || []).filter((s) => tab !== "genre" || !s.parent);
    grid.innerHTML = list.length
      ? list.map(stationChip).join("")
      : empty("ph-radio", Object.keys(groups).length ? "Нет станций" : "Яндекс не отдал список станций — откройте вкладку позже");
  } catch (e) {
    grid.innerHTML = errorBox(e);
  }
}

/** Re-highlight the playing station without re-rendering the catalog. */
export function markStations() {
  const cur = player.state.mode === "wave" ? player.state.station.id : null;
  document.querySelectorAll(".station[data-station]").forEach((b) => b.classList.toggle("on", b.dataset.station === cur));
}

/** Fills the left slide-out history panel and the counter on the wave screen's button. */
export function renderHistory() {
  const tracks = player.state.history;
  const count = document.getElementById("historyCount");
  if (count) count.textContent = tracks.length || "";
  const list = document.getElementById("historyList");
  if (!list) return;
  const cur = player.state.track;
  list.innerHTML = tracks.length
    ? tracks
        .map((t, i) => {
          const liked = api.isLiked(t);
          const isCur = cur && String(cur.id) === String(t.id);
          return `<div class="q-item${isCur ? " current" : ""}" data-h="${i}">
            ${img(api.cover(t, 100)) || "<img />"}
            <div><div class="q-t">${esc(t.title)}</div><div class="q-a">${esc(api.artistsOf(t))}</div></div>
            <button class="icon-btn like${liked ? " liked" : ""}" data-action="history-like" data-h="${i}" aria-label="Нравится"><i class="${liked ? "ph-fill" : "ph"} ph-heart"></i></button>
          </div>`;
        })
        .join("")
    : '<div class="empty"><i class="ph ph-clock-counter-clockwise"></i>Пока пусто — запустите волну</div>';
}

export const WAVE_CHIPS = {
  diversity: [
    ["default", "Любое"],
    ["favorite", "Любимое"],
    ["discover", "Незнакомое"],
    ["popular", "Популярное"],
  ],
  moodEnergy: [
    ["all", "Любое"],
    ["active", "Бодрое"],
    ["fun", "Весёлое"],
    ["calm", "Спокойное"],
    ["sad", "Грустное"],
  ],
  language: [
    ["any", "Любой"],
    ["russian", "Русский"],
    ["not-russian", "Иностранный"],
  ],
};

export function waveSettings() {
  try {
    return { diversity: "default", moodEnergy: "all", language: "any", ...JSON.parse(localStorage.getItem("waveSettings") || "{}") };
  } catch {
    return { diversity: "default", moodEnergy: "all", language: "any" };
  }
}

export async function wave(root, _params, alive) {
  const s = waveSettings();
  const chips = (group) =>
    WAVE_CHIPS[group]
      .map(([v, label]) => `<button class="chip${s[group] === v ? " on" : ""}" data-action="wave-setting" data-group="${group}" data-value="${v}">${label}</button>`)
      .join("");
  root.innerHTML = `
    <section class="wave-hero">
      <button class="history-btn" data-action="history" aria-label="История волны"><i class="ph ph-clock-counter-clockwise"></i>История<span id="historyCount"></span></button>
      <div class="wave-stage">
        <canvas id="waveCanvas"></canvas>
        <button class="wave-play" id="wavePlay" data-action="wave-toggle" aria-label="Моя волна"><i class="ph-fill ph-play"></i></button>
      </div>
      <div class="wave-info">
        <h1>Моя волна</h1>
        <p class="lead">Бесконечный поток музыки под ваш вкус. Лайки и пропуски делают его точнее.</p>
        <div class="wave-now" id="waveNow"></div>
        <div class="chips-label">Характер</div>
        <div class="chips">${chips("diversity")}</div>
        <div class="chips-label">Настроение</div>
        <div class="chips">${chips("moodEnergy")}</div>
        <div class="chips-label">Язык</div>
        <div class="chips">${chips("language")}</div>
      </div>
    </section>
    <section class="section" id="waveStations">
      <h2 class="section-title">Другие волны</h2>
      <div class="tabs">${STATION_TABS.map(([k, l]) => `<button class="tab" data-action="station-tab" data-station-tab="${k}">${l}</button>`).join("")}</div>
      <div class="stations"><div class="skeleton" style="height:64px;grid-column:1/-1"></div></div>
    </section>
    <section class="section">
      <h2 class="section-title">Ваша медиатека</h2>
      <div id="homeGrid">${skeletonGrid(6)}</div>
    </section>`;
  renderStations(root.querySelector("#waveStations"));
  renderHistory();

  try {
    const [pls, refs] = await Promise.all([api.myPlaylists(), api.likedTrackRefs().catch(() => null)]);
    if (!alive()) return;
    root.querySelector("#homeGrid").innerHTML = `<div class="grid">${likedCard(refs?.length)}${pls.slice(0, 11).map(playlistCard).join("")}</div>`;
  } catch (e) {
    if (alive()) root.querySelector("#homeGrid").innerHTML = errorBox(e);
  }
}

// ---------- Поиск ----------
let lastQuery = "";
let searchSeq = 0;

export async function search(root, _params, alive) {
  root.innerHTML = `
    <div class="page-head"><h1 class="page-title">Поиск</h1></div>
    <div class="search-box">
      <i class="ph ph-magnifying-glass"></i>
      <input id="q" type="search" placeholder="Трек, альбом, исполнитель или плейлист" value="${esc(lastQuery)}" autocomplete="off" spellcheck="false" />
    </div>
    <div id="results">${lastQuery ? "" : empty("ph-music-notes", "Начните вводить запрос")}</div>`;
  const input = root.querySelector("#q");
  const results = root.querySelector("#results");
  // On a phone, don't pop the keyboard up just because the tab was opened.
  if (!matchMedia("(max-width: 760px)").matches) {
    input.focus();
    input.select();
  }
  let timer;
  input.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(() => runSearch(input.value.trim(), results, alive), 320);
  });
  if (lastQuery) runSearch(lastQuery, results, alive);
}

async function runSearch(q, box, alive) {
  lastQuery = q;
  const seq = ++searchSeq;
  if (!q) {
    box.innerHTML = empty("ph-music-notes", "Начните вводить запрос");
    return;
  }
  box.innerHTML = `<div class="search-top"><div class="skeleton" style="height:240px"></div><div>${skeletonRows(4)}</div></div>`;
  let r;
  try {
    r = await api.search(q);
  } catch (e) {
    if (seq === searchSeq && alive()) box.innerHTML = errorBox(e);
    return;
  }
  if (seq !== searchSeq || !alive()) return;

  const tracks = r.tracks?.results || [];
  const albums = r.albums?.results || [];
  const artists = r.artists?.results || [];
  const playlists = r.playlists?.results || [];
  if (!tracks.length && !albums.length && !artists.length && !playlists.length) {
    box.innerHTML = empty("ph-magnifying-glass", `Ничего не нашлось по запросу «${q}»`);
    return;
  }
  const listId = registerList(tracks, { label: `Поиск: ${q}`, route: { name: "search" } });

  let best = "";
  const b = r.best?.result;
  if (b) {
    const type = r.best.type;
    const conf = {
      artist: { go: `data-go="artist" data-id="${b.id}"`, title: b.name, sub: "", pill: "Исполнитель", round: true },
      album: { go: `data-go="album" data-id="${b.id}"`, title: b.title, sub: esc((b.artists || []).map((a) => a.name).join(", ")), pill: "Альбом" },
      playlist: { go: `data-go="playlist" data-uid="${plUid(b)}" data-kind="${b.kind}"`, title: b.title, sub: esc(b.owner?.name || ""), pill: "Плейлист" },
      track: { go: `data-action="play-best" data-list="${listId}" data-tid="${b.id}"`, title: b.title, sub: esc((b.artists || []).map((a) => a.name).join(", ")), pill: "Трек" },
    }[type];
    if (conf) {
      best = `<div class="best${conf.round ? " round" : ""}" ${conf.go}>
        ${img(api.cover(b, 200)) || '<div class="skeleton" style="width:112px;height:112px"></div>'}
        <div class="best-title">${esc(conf.title)}</div>
        <div class="best-sub">${conf.sub}</div>
        <span class="pill">${conf.pill}</span>
      </div>`;
    }
  }

  box.innerHTML = `
    ${tracks.length ? `<div class="search-top">
      <div><h2 class="section-title">Лучший результат</h2>${best}</div>
      <div><h2 class="section-title">Треки</h2><div class="tracks no-album">${trackRows(tracks.slice(0, 5), listId)}</div></div>
    </div>` : ""}
    ${artists.length ? `<section class="section"><h2 class="section-title">Исполнители</h2><div class="grid">${artists.slice(0, 6).map(artistCard).join("")}</div></section>` : ""}
    ${albums.length ? `<section class="section"><h2 class="section-title">Альбомы</h2><div class="grid">${albums.slice(0, 12).map(albumCard).join("")}</div></section>` : ""}
    ${tracks.length > 5 ? `<section class="section"><h2 class="section-title">Ещё треки</h2><div class="tracks">${trackRows(tracks.slice(5), listId, 5)}</div></section>` : ""}
    ${playlists.length ? `<section class="section"><h2 class="section-title">Плейлисты</h2><div class="grid">${playlists.slice(0, 12).map(playlistCard).join("")}</div></section>` : ""}`;
}

// ---------- Мне нравится ----------
export async function liked(root, _params, alive) {
  const tracks = [];
  const listId = registerList(tracks, { label: "Мне нравится", route: { name: "liked" } });
  root.innerHTML = `
    ${heroBlock({
      art: "",
      fallbackIcon: '<div class="art-fallback liked-art"><i class="ph-fill ph-heart"></i></div>',
      kind: "Плейлист",
      title: "Мне нравится",
      meta: '<span id="likedMeta">Загрузка…</span>',
      actions: playActions(listId),
    })}
    <div class="tracks" id="likedList">${skeletonRows(10)}</div>
    <div class="load-more" id="likedMore"></div>`;
  const list = root.querySelector("#likedList");
  const more = root.querySelector("#likedMore");
  try {
    const refs = await api.likedTrackRefs();
    if (!alive()) return;
    root.querySelector("#likedMeta").textContent = plural(refs.length, "трек", "трека", "треков");
    list.innerHTML = refs.length ? "" : empty("ph-heart", "Здесь появятся треки, которые вам понравятся");
    const ids = refs.map((r) => (r.albumId ? `${r.id}:${r.albumId}` : r.id));
    // Progressive load: first page fast, the rest in the background.
    for (let i = 0; i < ids.length; i += 150) {
      more.innerHTML = '<div class="spinner"></div>';
      const page = await api.getTracks(ids.slice(i, i + 150));
      if (!alive()) return;
      const offset = tracks.length;
      tracks.push(...page);
      list.insertAdjacentHTML("beforeend", trackRows(page, listId, offset));
    }
    more.innerHTML = "";
    root.querySelector("#likedMeta").textContent =
      `${plural(tracks.length, "трек", "трека", "треков")} · ${fmtTotal(tracks.reduce((s, t) => s + (t.durationMs || 0), 0))}`;
  } catch (e) {
    if (alive()) (list.innerHTML = errorBox(e)), (more.innerHTML = "");
  }
}

// ---------- Медиатека ----------
const LIB_TABS = [
  ["playlists", "Плейлисты"],
  ["albums", "Альбомы"],
  ["artists", "Исполнители"],
];

export async function library(root, { tab = "playlists" }, alive) {
  root.innerHTML = `
    <div class="page-head"><h1 class="page-title">Медиатека</h1></div>
    <div class="tabs">${LIB_TABS.map(([k, l]) => `<button class="tab${k === tab ? " active" : ""}" data-go="library" data-tab="${k}" data-replace="1">${l}</button>`).join("")}</div>
    <div id="libBody">${skeletonGrid(12)}</div>`;
  const body = root.querySelector("#libBody");
  try {
    let html;
    if (tab === "playlists") {
      const pls = await api.myPlaylists();
      html = `<div class="grid">${likedCard()}${pls.map(playlistCard).join("")}</div>`;
    } else if (tab === "albums") {
      const albums = await api.likedAlbums();
      html = albums.length ? `<div class="grid">${albums.map(albumCard).join("")}</div>` : empty("ph-vinyl-record", "Вы ещё не добавили ни одного альбома");
    } else {
      const artists = await api.likedArtists();
      html = artists.length ? `<div class="grid">${artists.map(artistCard).join("")}</div>` : empty("ph-microphone-stage", "Вы ещё не подписались ни на одного исполнителя");
    }
    if (alive()) body.innerHTML = html;
  } catch (e) {
    if (alive()) body.innerHTML = errorBox(e);
  }
}

// ---------- Плейлист ----------
export async function playlist(root, { uid, kind }, alive) {
  root.innerHTML = `<div class="page-head">${backBtn}</div><div class="hero"><div class="hero-art skeleton"></div></div>${skeletonRows(8)}`;
  try {
    const p = await api.playlist(uid, kind);
    if (!alive()) return;
    const own = String(uid) === String(api.me.uid);
    const listId = registerList(
      p.tracks,
      { label: p.title, route: { name: "playlist", params: { uid, kind } } },
      { playlist: { kind: p.kind, title: p.title, revision: p.revision, own } },
    );
    root.innerHTML = `
      <div class="page-head">${backBtn}</div>
      ${heroBlock({
        art: api.cover(p, 400),
        fallbackIcon: '<i class="ph ph-playlist"></i>',
        kind: "Плейлист",
        title: p.title,
        meta: `<span id="plMeta">${playlistMeta(p)}</span>`,
        actions: playActions(listId),
      })}
      <div class="tracks">${p.tracks.length ? trackRows(p.tracks, listId) : empty("ph-playlist", "Плейлист пуст")}</div>`;
  } catch (e) {
    if (alive()) root.innerHTML = `<div class="page-head">${backBtn}</div>${errorBox(e)}`;
  }
}

export function playlistMeta(p) {
  const dur = p.tracks.reduce((s, t) => s + (t.durationMs || 0), 0);
  return [p.owner?.name && esc(p.owner.name), plural(p.tracks.length, "трек", "трека", "треков"), dur && fmtTotal(dur)]
    .filter(Boolean)
    .join(" · ");
}

// ---------- Альбом ----------
export async function album(root, { id }, alive) {
  root.innerHTML = `<div class="page-head">${backBtn}</div><div class="hero"><div class="hero-art skeleton"></div></div>${skeletonRows(8)}`;
  try {
    const a = await api.album(id);
    if (!alive()) return;
    const listId = registerList(a.tracks, { label: a.title, route: { name: "album", params: { id } } });
    const dur = a.tracks.reduce((s, t) => s + (t.durationMs || 0), 0);
    const kind = a.type === "single" ? "Сингл" : a.metaType === "podcast" ? "Подкаст" : "Альбом";
    let offset = 0;
    const volumes = (a.volumes || [a.tracks])
      .map((vol, vi, all) => {
        const html = (all.length > 1 ? `<div class="disc">Диск ${vi + 1}</div>` : "") + trackRows(vol, listId, offset);
        offset += vol.length;
        return html;
      })
      .join("");
    root.innerHTML = `
      <div class="page-head">${backBtn}</div>
      ${heroBlock({
        art: api.cover(a, 400),
        fallbackIcon: '<i class="ph ph-vinyl-record"></i>',
        kind,
        title: a.title + (a.version ? ` (${a.version})` : ""),
        meta: [artistLinks(a), a.year, plural(a.tracks.length, "трек", "трека", "треков"), dur && fmtTotal(dur)]
          .filter(Boolean)
          .map((m) => `<span>${m}</span>`)
          .join("<span>·</span>"),
        actions: playActions(listId) + stationBtn(`album:${id}`, `Волна по альбому «${a.title}»`),
      })}
      <div class="tracks no-cover">${volumes}</div>`;
  } catch (e) {
    if (alive()) root.innerHTML = `<div class="page-head">${backBtn}</div>${errorBox(e)}`;
  }
}

// ---------- Исполнитель ----------
export async function artist(root, { id }, alive) {
  root.innerHTML = `<div class="page-head">${backBtn}</div><div class="hero round"><div class="hero-art skeleton"></div></div>${skeletonRows(6)}`;
  try {
    const r = await api.artist(id);
    if (!alive()) return;
    const a = r.artist || {};
    const top = r.popularTracks || [];
    const listId = registerList(top, { label: a.name, route: { name: "artist", params: { id } } });
    const albums = r.albums || [];
    const also = r.alsoAlbums || [];
    root.innerHTML = `
      <div class="page-head">${backBtn}</div>
      ${heroBlock({
        round: true,
        art: api.cover(a, 400),
        fallbackIcon: '<i class="ph ph-user"></i>',
        kind: "Исполнитель",
        title: a.name || "",
        meta: [
          a.likesCount && `${plural(a.likesCount, "слушатель", "слушателя", "слушателей")} в Яндексе`,
          a.counts?.tracks && plural(a.counts.tracks, "трек", "трека", "треков"),
        ]
          .filter(Boolean)
          .map((m) => `<span>${m}</span>`)
          .join("<span>·</span>"),
        actions: (top.length ? playActions(listId) : "") + stationBtn(`artist:${id}`, `Волна по исполнителю ${a.name || ""}`.trim()),
      })}
      ${top.length ? `<section class="section"><h2 class="section-title">Популярные треки</h2><div class="tracks">${trackRows(top.slice(0, 10), listId)}</div></section>` : ""}
      ${albums.length ? `<section class="section"><h2 class="section-title">Альбомы <span class="count">${albums.length}</span></h2><div class="grid">${albums.map(albumCard).join("")}</div></section>` : ""}
      ${also.length ? `<section class="section"><h2 class="section-title">Сборники и участие</h2><div class="grid">${also.map(albumCard).join("")}</div></section>` : ""}`;
  } catch (e) {
    if (alive()) root.innerHTML = `<div class="page-head">${backBtn}</div>${errorBox(e)}`;
  }
}

/** Resolve a card's play context (data-playctx) into a track list + label. */
export async function resolvePlayCtx(ctx) {
  const [kind, a, b] = ctx.split(":");
  if (kind === "liked") {
    const refs = await api.likedTrackRefs();
    const tracks = await api.getTracks(refs.map((r) => (r.albumId ? `${r.id}:${r.albumId}` : r.id)));
    return { tracks, context: { label: "Мне нравится", route: { name: "liked" } } };
  }
  if (kind === "album") {
    const al = await api.album(a);
    return { tracks: al.tracks, context: { label: al.title, route: { name: "album", params: { id: a } } } };
  }
  if (kind === "playlist") {
    const p = await api.playlist(a, b);
    return { tracks: p.tracks, context: { label: p.title, route: { name: "playlist", params: { uid: a, kind: b } } } };
  }
  if (kind === "artist") {
    const r = await api.artist(a);
    return { tracks: r.popularTracks || [], context: { label: r.artist?.name, route: { name: "artist", params: { id: a } } } };
  }
  return { tracks: [] };
}
