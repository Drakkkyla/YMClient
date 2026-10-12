// Frontend wrappers over the Rust `ym` proxy. Shapes follow the unofficial Yandex Music API.
const { invoke } = window.__TAURI__.core;

const strMap = (o) =>
  o && Object.fromEntries(Object.entries(o).filter(([, v]) => v != null).map(([k, v]) => [k, String(v)]));

export function ym(path, { method = "GET", query, form, json } = {}) {
  return invoke("ym", { req: { method, path, query: strMap(query), form: strMap(form), json } }).catch((e) => {
    if (/HTTP 401/.test(String(e))) window.dispatchEvent(new Event("ym-unauthorized"));
    throw e;
  });
}

/** Synced (LRC) or plain lyrics: { format: "LRC" | "TEXT", text }. Needs a token. */
export const lyrics = (id, synced) => invoke("lyrics", { id: String(id), synced: !!synced });

export const trackUrl = (id) => invoke("track_url", { id: String(id) });

export const me = { uid: null, login: "", name: "", hasPlus: false };

export async function loadAccount() {
  const r = await ym("/account/status");
  const a = r.account || {};
  if (!a.uid) throw new Error("Токен недействителен");
  Object.assign(me, {
    uid: a.uid,
    login: a.login || "",
    name: a.displayName || a.firstName || a.login || "Слушатель",
    hasPlus: !!r.plus?.hasPlus,
  });
  return me;
}

// ---------- helpers ----------

export function cover(obj, size = 400) {
  if (!obj) return "";
  const uri =
    typeof obj === "string"
      ? obj
      : obj.coverUri ||
        obj.cover?.uri ||
        obj.cover?.itemsUri?.[0] ||
        obj.albums?.[0]?.coverUri ||
        obj.ogImage ||
        "";
  return uri ? "https://" + uri.replace("%%", `${size}x${size}`) : "";
}

export const artistsOf = (t) => (t?.artists || []).map((a) => a.name).join(", ");
export const trackKey = (t) => (t.albums?.[0]?.id ? `${t.id}:${t.albums[0].id}` : String(t.id));
export const webUrl = (t) =>
  t.albums?.[0]?.id ? `https://music.yandex.ru/album/${t.albums[0].id}/track/${t.id}` : null;

const chunk = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));

export async function getTracks(ids) {
  const out = [];
  for (const part of chunk(ids, 200)) {
    const r = await ym("/tracks", { method: "POST", form: { "track-ids": part.join(","), "with-positions": "true" } });
    out.push(...(r || []));
  }
  return out;
}

// ---------- likes ----------

export const likes = { tracks: new Set() };

/** Liked track refs, newest first: [{ id, albumId, timestamp }] */
export async function likedTrackRefs() {
  const r = await ym(`/users/${me.uid}/likes/tracks`);
  const list = r.library?.tracks || [];
  likes.tracks = new Set(list.map((t) => String(t.id)));
  return list;
}

export const isLiked = (t) => likes.tracks.has(String(t.id));

export async function setLike(t, on) {
  await ym(`/users/${me.uid}/likes/tracks/${on ? "add-multiple" : "remove"}`, {
    method: "POST",
    form: { "track-ids": trackKey(t) },
  });
  on ? likes.tracks.add(String(t.id)) : likes.tracks.delete(String(t.id));
}

export const dislike = (t) =>
  ym(`/users/${me.uid}/dislikes/tracks/add-multiple`, { method: "POST", form: { "track-ids": trackKey(t) } });

// ---------- catalog ----------

export const search = (text) => ym("/search", { query: { text, type: "all", page: 0, nocorrect: "false" } });

export async function album(id) {
  const a = await ym(`/albums/${id}/with-tracks`);
  a.tracks = (a.volumes || []).flat();
  return a;
}

export const artist = (id) => ym(`/artists/${id}/brief-info`);

export async function playlist(uid, kind) {
  const p = await ym(`/users/${uid}/playlists/${kind}`, { query: { "rich-tracks": "true" } });
  const items = p.tracks || [];
  // _pos = position inside the playlist, needed for delete ops even if some items fail to resolve.
  let tracks = items.map((i, pos) => i.track && Object.assign(i.track, { _pos: pos })).filter(Boolean);
  if (tracks.length < items.length) {
    const posById = new Map(items.map((i, pos) => [String(i.id), pos]));
    tracks = await getTracks(items.map((i) => (i.albumId ? `${i.id}:${i.albumId}` : i.id)));
    tracks.forEach((t) => (t._pos = posById.get(String(t.id))));
  }
  p.tracks = tracks;
  return p;
}

// ---------- playlist editing ----------

/** The user's own playlists (with fresh revisions, no tracks). */
export const ownPlaylists = async () => (await ym(`/users/${me.uid}/playlists/list`)) || [];

/** Own playlists plus the ids of the tracks in each (in playlist order), in two requests total. */
export async function ownPlaylistsWithTracks() {
  const list = await ownPlaylists();
  if (!list.length) return [];
  const full = await ym(`/users/${me.uid}/playlists`, {
    method: "POST",
    form: { kinds: list.map((p) => p.kind).join(","), mixed: "true", "rich-tracks": "false" },
  });
  const byKind = new Map((full || []).map((p) => [String(p.kind), p]));
  return list.map((p) => {
    const f = byKind.get(String(p.kind));
    return { ...p, revision: f?.revision ?? p.revision, trackIds: (f?.tracks || []).map((t) => String(t.id)) };
  });
}

const trackRef = (t) => (t.albums?.[0]?.id ? { id: String(t.id), albumId: t.albums[0].id } : { id: String(t.id) });

const changePlaylist = (kind, diff, revision) =>
  ym(`/users/${me.uid}/playlists/${kind}/change-relative`, {
    method: "POST",
    form: { kind, revision, diff: JSON.stringify(diff) },
  });

/** Adds a track to the top of a playlist; retries once with a fresh revision if it went stale. */
export async function addToPlaylist(pl, t) {
  const diff = [{ op: "insert", at: 0, tracks: [trackRef(t)] }];
  try {
    return await changePlaylist(pl.kind, diff, pl.revision);
  } catch (e) {
    const fresh = (await ownPlaylists()).find((p) => p.kind === pl.kind);
    if (!fresh || fresh.revision === pl.revision) throw e;
    return changePlaylist(pl.kind, diff, fresh.revision);
  }
}

export const removeFromPlaylist = (kind, revision, pos, t) =>
  changePlaylist(kind, [{ op: "delete", from: pos, to: pos + 1, tracks: [trackRef(t)] }], revision);

export const createPlaylist = (title) =>
  ym(`/users/${me.uid}/playlists/create`, { method: "POST", form: { title, visibility: "private" } });

const unwrap = (list, key) => (list || []).map((x) => x?.[key] || x).filter((x) => x?.id || x?.kind != null);

export async function myPlaylists() {
  const [own, liked] = await Promise.all([
    ym(`/users/${me.uid}/playlists/list`).catch(() => []),
    ym(`/users/${me.uid}/likes/playlists`).catch(() => []),
  ]);
  return [...(own || []), ...unwrap(liked, "playlist")];
}

export const likedAlbums = async () => unwrap(await ym(`/users/${me.uid}/likes/albums`, { query: { rich: "true" } }), "album");
export const likedArtists = async () =>
  unwrap(await ym(`/users/${me.uid}/likes/artists`, { query: { "with-timestamps": "false" } }), "artist");

// ---------- waves (rotor stations) ----------
// A station id is "<type>:<tag>": user:onyourwave (My Wave), genre:rock, mood:calm,
// activity:run, epoch:the-90s, or seeded ones — track:<id>, artist:<id>, album:<id>.

const MY_WAVE = "user:onyourwave";

export const wave = {
  async tracks(station, queue) {
    const r = await ym(`/rotor/station/${station}/tracks`, { query: { settings2: "true", queue } });
    return (r.sequence || [])
      .map((s) => s.track)
      .filter(Boolean)
      .map((t) => ((t._batch = r.batchId), t));
  },
  feedback(station, type, batchId, extra = {}) {
    return ym(`/rotor/station/${station}/feedback`, {
      method: "POST",
      query: batchId ? { "batch-id": batchId } : undefined,
      json: { type, timestamp: Date.now() / 1000, from: "ymclient", ...extra },
    }).catch(() => {});
  },
  settings({ moodEnergy, diversity, language = "any" }) {
    return ym(`/rotor/station/${MY_WAVE}/settings3`, {
      method: "POST",
      json: { moodEnergy, diversity, language, type: "rotor" },
    });
  },
};

let stationsCache = null;
/** Station catalog grouped by type: { genre: [...], mood: [...], activity: [...], epoch: [...] }. */
export function stationCatalog() {
  stationsCache ??= ym("/rotor/stations/list", { query: { language: "ru" } })
    .then((list) => {
      const groups = {};
      for (const { station: s } of list || []) {
        if (!s?.id) continue;
        (groups[s.id.type] ??= []).push({
          id: `${s.id.type}:${s.id.tag}`,
          label: s.name,
          color: s.icon?.backgroundColor || "#444",
          icon: s.icon?.imageUrl ? "https://" + s.icon.imageUrl.replace("%%", "100x100") : "",
          parent: s.parentId ? `${s.parentId.type}:${s.parentId.tag}` : null,
        });
      }
      // An empty catalog is a transient server answer — don't keep it for the whole session.
      if (!Object.keys(groups).length) stationsCache = null;
      return groups;
    })
    .catch((e) => {
      stationsCache = null;
      throw e;
    });
  return stationsCache;
}
