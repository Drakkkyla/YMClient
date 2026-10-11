// Playback engine: queue, waves (rotor stations), shuffle/repeat, crossfade, loudness
// normalization, sleep timer, Media Session (Windows SMTC), Discord RPC, and a Web Audio
// analyser so visuals are driven by the real signal.
//
// Two <audio> "decks" exist so tracks can overlap during a crossfade. `audio` always points at
// the deck that is logically current; every event handler ignores the other one.
import * as api from "./api.js";
import { toast } from "./ui.js";

const { invoke, convertFileSrc } = window.__TAURI__.core;

/**
 * iOS can't play a music app's audio in the webview: it interrupts Web Audio as soon as the app
 * is backgrounded and ignores <audio>.volume. So there playback runs natively on AVAudioEngine
 * (the `ymaudio` plugin, src-tauri/plugins/ymaudio) behind `NativeDeck`, a small stand-in for
 * HTMLAudioElement — the rest of this file drives both kinds of deck the same way.
 * iOS also freezes the webview's JS ~30 s into the background, so on iOS *native* decides what
 * plays next: we hand it the upcoming tracks (`syncNativeQueue`) and follow its `advanced` events.
 */
export const IOS =
  /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
export const NATIVE = IOS;
export const WEB_AUDIO = !NATIVE;

const native = (cmd, args = {}) => invoke(`plugin:ymaudio|${cmd}`, args);

/** Taptic feedback on iOS (light | medium | rigid | selection | success); no-op elsewhere. */
export const haptic = (style = "light") => {
  if (NATIVE) native("haptic", { style }).catch(() => {});
};
let nativeToken = 0;

/** HTMLAudioElement-shaped proxy for one native deck (only what this file uses). */
class NativeDeck extends EventTarget {
  constructor(index) {
    super();
    this.index = index;
    this._src = "";
    this._key = "";
    this._token = 0;
    this._paused = true;
    this._ended = false;
    this._pos = 0;
    this._dur = NaN;
    this._ready = Promise.resolve();
    this.error = null;
    this.preload = "auto";
    this.volume = 1; // iOS: hardware volume buttons
  }
  _emit(type) {
    this.dispatchEvent(new Event(type));
  }
  get src() {
    return this._src;
  }
  set src(url) {
    const token = (this._token = ++nativeToken);
    Object.assign(this, { _src: url, _paused: true, _ended: false, _pos: 0, _dur: NaN, error: null });
    this._ready = native("load", { deck: this.index, token, key: this._key || url, url }).then(
      (r) => {
        if (token !== this._token) return;
        this._dur = r?.duration || NaN;
        this._emit("loadedmetadata");
      },
      (e) => {
        if (token === this._token) (this.error = { code: 4, message: String(e) }), this._emit("error");
        throw new Error(String(e));
      },
    );
  }
  /** Native already started this deck on its own (queued advance): just follow it. */
  adopt(token, url) {
    Object.assign(this, { _token: token, _src: url || "native", _paused: false, _ended: false, _pos: 0, _dur: NaN, error: null });
    this._ready = Promise.resolve();
  }
  removeAttribute(name) {
    if (name !== "src") return;
    this._src = "";
    this._token = ++nativeToken;
    native("stop", { deck: this.index }).catch(() => {});
  }
  load() {}
  async play() {
    await this._ready;
    await native("play", { deck: this.index });
    this._paused = false;
    this._ended = false;
    this._emit("play");
    this._emit("playing");
  }
  pause() {
    if (this._paused) return;
    this._paused = true;
    native("pause", { deck: this.index }).catch(() => {});
    this._emit("pause");
  }
  get paused() {
    return this._paused;
  }
  get ended() {
    return this._ended;
  }
  get duration() {
    return this._dur;
  }
  get currentTime() {
    return this._pos;
  }
  set currentTime(v) {
    this._pos = v;
    this._ended = false;
    native("seek", { deck: this.index, position: v }).then(() => this._emit("seeked"), () => {});
  }
}

/** Desktop audio goes through the Rust `ymstream:` proxy so CORS never depends on the page
 *  origin (macOS serves the page from tauri://localhost, which the CDN doesn't allow). */
const streamSrc = (url) => (WEB_AUDIO ? convertFileSrc(url, "ymstream") : url);

const makeDeck = (i) => {
  if (NATIVE) return { el: new NativeDeck(i), gain: null };
  const el = new Audio();
  el.crossOrigin = "anonymous"; // needed for the analyser; the ymstream proxy answers with ACAO:*
  el.preload = "auto";
  return { el, gain: null };
};
const decks = [makeDeck(0), makeDeck(1)];
let audio = decks[0].el;
const deckOf = (el) => decks.find((d) => d.el === el);
const otherDeck = () => decks.find((d) => d.el !== audio);

// ---------- audio graph: decks → gains → preamp → 10-band EQ → analyser → master → out ----------
export const EQ_BANDS = [32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];

function makeBands(ctx) {
  return EQ_BANDS.map((f, i) => {
    const b = ctx.createBiquadFilter();
    b.type = i === 0 ? "lowshelf" : i === EQ_BANDS.length - 1 ? "highshelf" : "peaking";
    b.frequency.value = f;
    b.Q.value = 1.1;
    return b;
  });
}

let actx, analyser, bins, preamp, master, bands = [];
function ensureGraph() {
  if (!WEB_AUDIO) return;
  if (actx) {
    if (actx.state === "suspended") actx.resume();
    return;
  }
  actx = new AudioContext();
  preamp = actx.createGain();
  bands = makeBands(actx);
  analyser = actx.createAnalyser();
  analyser.fftSize = 512;
  analyser.smoothingTimeConstant = 0.8;
  master = actx.createGain();
  for (const d of decks) {
    d.gain = actx.createGain();
    actx.createMediaElementSource(d.el).connect(d.gain);
    d.gain.connect(preamp);
  }
  [preamp, ...bands, analyser, master].reduce((a, b) => (a.connect(b), b));
  master.connect(actx.destination);
  bins = new Uint8Array(analyser.frequencyBinCount);
  applyEq(true);
  setDeckGain(deckOf(audio), normGain(state.track));
  setDeckGain(otherDeck(), 0);
}

/** Current frequency bins (0..255) or null if nothing has played yet. */
const nativeBins = new Uint8Array(256);
export function spectrum() {
  if (NATIVE) return state.playing ? nativeBins : null;
  if (!analyser) return null;
  analyser.getByteFrequencyData(bins);
  return bins;
}

/** Set (or ramp over `secs`) a deck's gain. */
function setDeckGain(deck, value, secs = 0) {
  if (NATIVE) {
    if (deck) native("gain", { deck: decks.indexOf(deck), value, seconds: secs }).catch(() => {});
    return;
  }
  if (!actx || !deck?.gain) return;
  const g = deck.gain.gain, now = actx.currentTime;
  g.cancelScheduledValues(now);
  g.setValueAtTime(g.value, now);
  secs > 0 ? g.linearRampToValueAtTime(value, now + secs) : g.setValueAtTime(value, now);
}

// ---------- state & events ----------
const listeners = new Set();
export const on = (fn) => (listeners.add(fn), () => listeners.delete(fn));
const emit = (what) => {
  listeners.forEach((fn) => fn(what));
  if (what === "queue" || what === "settings" || what === "sleep") scheduleNativeSync();
};

const store = (k, d) => {
  try {
    const v = localStorage.getItem(k);
    return v == null ? d : JSON.parse(v);
  } catch {
    return d;
  }
};
const save = (k, v) => {
  try {
    localStorage.setItem(k, JSON.stringify(v));
  } catch {}
};

export const MY_WAVE = { id: "user:onyourwave", label: "Моя волна" };

export const state = {
  queue: [],
  original: null, // un-shuffled queue
  index: -1,
  mode: null, // "wave" | "list"
  station: MY_WAVE, // current rotor station when mode === "wave"
  context: null, // { label, route }
  history: [], // tracks played from waves this session, newest first
  shuffle: false,
  repeat: "off", // off | all | one
  volume: store("volume", 0.8),
  muted: false,
  loading: false,
  rpc: store("rpc", true),
  normalize: store("normalize", true),
  crossfade: store("crossfade", 0), // seconds, 0 = off
  blocked: store("blockedArtists", []), // [{ id, name }] never played in waves
  get track() {
    return this.queue[this.index] || null;
  },
  get playing() {
    return !audio.paused && !audio.ended;
  },
  get time() {
    return audio.currentTime || 0;
  },
  get duration() {
    return audio.duration || (this.track?.durationMs || 0) / 1000;
  },
};

const applyVolume = () => decks.forEach((d) => (d.el.volume = state.muted ? 0 : state.volume ** 2));
applyVolume();

// ---------- loudness normalization (Yandex ships EBU R128 per track) ----------
const TARGET_LUFS = -14;
/** Linear gain bringing a track to TARGET_LUFS without pushing its true peak past -1 dBTP. */
function normGain(t) {
  const r = t?.r128;
  if (!state.normalize || !r || typeof r.i !== "number") return 1;
  let db = TARGET_LUFS - r.i;
  if (typeof r.tp === "number") db = Math.min(db, -1 - r.tp);
  db = Math.max(-12, Math.min(6, db));
  return 10 ** (db / 20);
}

export function setNormalize(on) {
  state.normalize = on;
  save("normalize", on);
  if (!fade) setDeckGain(deckOf(audio), normGain(state.track), 0.3);
  emit("settings");
}

export function setCrossfade(secs) {
  state.crossfade = secs;
  save("crossfade", secs);
  emit("settings");
}

// ---------- equalizer ----------
export const eq = {
  enabled: store("eq.on", false),
  gains: store("eq.gains", EQ_BANDS.map(() => 0)),
  preamp: store("eq.preamp", 0),
  preset: store("eq.preset", "flat"),
};

function applyEq(instant = false) {
  if (NATIVE) {
    native("set_eq", { enabled: eq.enabled, gains: eq.gains, preamp: eq.preamp }).catch(() => {});
    return;
  }
  if (!actx) return;
  const t = actx.currentTime;
  const set = (param, v) => (instant ? (param.value = v) : param.setTargetAtTime(v, t, 0.03));
  bands.forEach((b, i) => set(b.gain, eq.enabled ? eq.gains[i] : 0));
  set(preamp.gain, eq.enabled ? 10 ** (eq.preamp / 20) : 1);
}

export function setEq(patch) {
  Object.assign(eq, patch);
  save("eq.on", eq.enabled);
  save("eq.gains", eq.gains);
  save("eq.preamp", eq.preamp);
  save("eq.preset", eq.preset);
  applyEq();
  emit("eq");
}

// Display-only copy of the filter bank: its gains are set instantly, so the drawn curve
// never lags behind the smoothed live filters.
let probe;
/** Total EQ response in dB at the given frequencies (Float32Array). */
export function eqResponse(freqs) {
  probe ??= makeBands(new OfflineAudioContext(1, 128, 44100));
  const total = new Float32Array(freqs.length).fill(eq.enabled ? eq.preamp : 0);
  if (!eq.enabled) return total;
  const mag = new Float32Array(freqs.length), phase = new Float32Array(freqs.length);
  probe.forEach((b, i) => {
    b.gain.value = eq.gains[i];
    b.getFrequencyResponse(freqs, mag, phase);
    for (let k = 0; k < freqs.length; k++) total[k] += 20 * Math.log10(mag[k]);
  });
  return total;
}

// ---------- blocked artists ----------
const blockedIds = () => new Set(state.blocked.map((a) => String(a.id)));
const isAllowed = (t, ids = blockedIds()) => !(t.artists || []).some((a) => ids.has(String(a.id)));

export function blockArtist(artist) {
  if (blockedIds().has(String(artist.id))) return;
  state.blocked = [...state.blocked, { id: String(artist.id), name: artist.name }];
  save("blockedArtists", state.blocked);
  if (state.mode === "wave") {
    // Drop their upcoming tracks; skip the current one if it's theirs.
    const ids = blockedIds();
    state.queue = [...state.queue.slice(0, state.index + 1), ...state.queue.slice(state.index + 1).filter((t) => isAllowed(t, ids))];
    emit("queue");
    if (state.track && !isAllowed(state.track, ids)) next();
  }
  emit("settings");
  toast(`${artist.name} больше не будет звучать в волнах`);
}

export function unblockArtist(id) {
  state.blocked = state.blocked.filter((a) => String(a.id) !== String(id));
  save("blockedArtists", state.blocked);
  emit("settings");
}

// ---------- wave feedback & history ----------
let waveCur = null;
function waveTrackStarted(t) {
  if (state.mode !== "wave") return;
  waveCur = t;
  api.wave.feedback(state.station.id, "trackStarted", t._batch, { trackId: api.trackKey(t) });
  if (state.index >= state.queue.length - 2) moreWave();
  state.history = [t, ...state.history.filter((h) => String(h.id) !== String(t.id))].slice(0, 100);
  emit("history");
}
function waveTrackEnded(finishedAnyway = false) {
  if (!waveCur) return;
  const t = waveCur;
  waveCur = null;
  const finished = finishedAnyway || audio.ended || (audio.duration && audio.currentTime >= audio.duration - 3);
  api.wave.feedback(state.station.id, finished ? "trackFinished" : "skip", t._batch, {
    trackId: api.trackKey(t),
    totalPlayedSeconds: audio.currentTime || 0,
  });
}

/** Station tracks minus blocked artists; a few retries in case a whole batch was filtered. */
async function fetchStation(queueAfter) {
  const ids = blockedIds();
  for (let attempt = 0; attempt < 3; attempt++) {
    const tracks = (await api.wave.tracks(state.station.id, queueAfter)).filter((t) => isAllowed(t, ids));
    if (tracks.length) return tracks;
  }
  return [];
}

let fetchingWave = null;
function moreWave() {
  if (fetchingWave) return fetchingWave;
  const last = state.queue[state.queue.length - 1];
  const station = state.station.id;
  fetchingWave = fetchStation(last ? api.trackKey(last) : undefined)
    .then((tracks) => {
      if (state.station.id !== station || state.mode !== "wave") return 0;
      const seen = new Set(state.queue.map((t) => String(t.id)));
      const fresh = tracks.filter((t) => !seen.has(String(t.id)));
      state.queue.push(...fresh);
      emit("queue");
      return fresh.length;
    })
    .catch((e) => (toast(`${state.station.label}: ${e}`, "error"), 0))
    .finally(() => (fetchingWave = null));
  return fetchingWave;
}

// ---------- stream URLs & prefetch ----------
let prefetched = null; // { id, promise, at }
const PREFETCH_TTL = 2 * 60 * 1000; // signed stream URLs go stale; don't reuse old ones
function urlFor(t) {
  if (prefetched?.id === String(t.id) && Date.now() - prefetched.at < PREFETCH_TTL) {
    const p = prefetched.promise;
    prefetched = null;
    return p;
  }
  return api.trackUrl(t.id);
}
function prefetch(t) {
  if (!t || t.available === false || (prefetched?.id === String(t.id) && Date.now() - prefetched.at < PREFETCH_TTL)) return;
  const promise = api.trackUrl(t.id);
  promise.catch(() => prefetched?.promise === promise && (prefetched = null));
  prefetched = { id: String(t.id), promise, at: Date.now() };
}

/** Index of what plays after the current track on its own, or null. */
function nextIndex() {
  return nextIndexFrom(state.index);
}
function nextIndexFrom(from) {
  const i = from + 1;
  if (state.mode === "wave") return i < state.queue.length ? i : null;
  if (state.repeat === "one") return null;
  if (i < state.queue.length) return i;
  return state.repeat === "all" && state.queue.length ? 0 : null;
}

// ---------- iOS: native owns "what's next" (see the NATIVE note at the top) ----------
const nativeItems = new Map(); // queued token -> track
const nativeUrls = new Map(); // track id -> { promise, at }
let nativeSyncTimer = null;
let nativeSyncSeq = 0;

function nativeUrl(t) {
  const id = String(t.id);
  const hit = nativeUrls.get(id);
  if (hit && Date.now() - hit.at < PREFETCH_TTL * 2) return hit.promise;
  const promise = api.trackUrl(t.id);
  promise.catch(() => nativeUrls.get(id)?.promise === promise && nativeUrls.delete(id));
  nativeUrls.set(id, { promise, at: Date.now() });
  return promise;
}

/** Where (s) in `t` the transition to the next track should begin, for native's crossfade. */
function fadeAtFor(t) {
  const dur = (t?.durationMs || 0) / 1000;
  if (!state.crossfade || !dur) return null;
  let start = dur - state.crossfade;
  const out = t.fade?.outStart;
  if (typeof out === "number" && out < start && out > start - 5) start = out;
  return Math.max(start, dur * 0.5);
}

function scheduleNativeSync() {
  if (!NATIVE) return;
  clearTimeout(nativeSyncTimer);
  nativeSyncTimer = setTimeout(syncNativeQueue, 60);
}

/** Hand native the next 3 tracks (URLs, gain, crossfade point, Now Playing info). */
async function syncNativeQueue() {
  const cur = state.track;
  if (!NATIVE || !cur) return;
  const seq = ++nativeSyncSeq;
  const upcoming = [];
  if (sleep.mode !== "track") {
    let i = state.index;
    for (let k = 0; k < 6 && upcoming.length < 3; k++) {
      i = nextIndexFrom(i);
      if (i == null || i === state.index) break;
      if (state.queue[i]?.available !== false) upcoming.push(state.queue[i]);
    }
  }
  const items = [];
  for (const t of upcoming) {
    let url;
    try {
      ({ url } = await nativeUrl(t));
    } catch {
      break;
    }
    if (seq !== nativeSyncSeq) return;
    const token = ++nativeToken;
    nativeItems.set(token, t);
    items.push({
      token,
      key: String(t.id),
      url,
      gain: normGain(t),
      fadeAt: fadeAtFor(t),
      title: t.title + (t.version ? ` (${t.version})` : ""),
      artist: api.artistsOf(t) || "",
      album: t.albums?.[0]?.title || null,
      artwork: api.cover(t, 600) || null,
      duration: t.durationMs ? t.durationMs / 1000 : null,
    });
  }
  if (seq !== nativeSyncSeq) return;
  native("set_queue", { items, crossfade: state.crossfade, currentFadeAt: fadeAtFor(cur) }).catch(() => {});
}

/** Native moved on by itself (crossfade point, track end, lock-screen "next"): follow it. */
function onNativeAdvanced({ deck, token, key }) {
  const d = decks[deck]?.el;
  if (!d) return;
  const queued = nativeItems.get(token);
  let i = state.queue.findIndex((x, k) => k > state.index && String(x.id) === String(key));
  if (i < 0) i = state.queue.findIndex((x) => String(x.id) === String(key));
  waveTrackEnded(true);
  const old = audio;
  d.adopt(token);
  if (old !== d) old._paused = true; // native fades it out and stops it
  audio = d;
  if (i >= 0) state.index = i;
  else if (queued) state.queue.splice(++state.index, 0, queued);
  loadSeq++; // supersede any JS-side load still in flight
  failStreak = 0;
  state.loading = false;
  emit("track");
  emit("state");
  updateMediaSession();
  waveTrackStarted(state.track);
  pushRpc();
  scheduleNativeSync();
}

// ---------- crossfade ----------
let fade = null; // { old: HTMLAudioElement, timer }
let fadeStarting = false;

/** Stop the outgoing deck right away (manual skip, pause, new load). */
function finishFade() {
  if (!fade) return;
  clearTimeout(fade.timer);
  const old = fade.old;
  fade = null;
  old.pause();
  old.removeAttribute("src");
  old.load();
  setDeckGain(deckOf(old), 0);
}

/** Seconds of overlap for the current track, starting where the track itself fades out if earlier. */
function fadePlan(t) {
  const dur = audio.duration;
  if (!state.crossfade || !dur || !isFinite(dur)) return null;
  let start = dur - state.crossfade;
  const out = t?.fade?.outStart;
  // Yandex marks where the master starts fading; begin there if it's close to our window.
  if (typeof out === "number" && out < start && out > start - 5) start = out;
  start = Math.max(start, dur * 0.5);
  return { start, len: Math.max(1, dur - start) };
}

function maybeCrossfade() {
  if (NATIVE) return; // native crossfades on its own (setQueue)
  if (fade || fadeStarting || !actx || state.loading || audio.paused || sleep.mode === "track") return;
  const plan = fadePlan(state.track);
  const ni = nextIndex();
  if (ni == null) return;
  const left = audio.duration - audio.currentTime;
  if (left < (plan?.len ?? 0) + 25) prefetch(state.queue[ni]); // warm the next URL early
  if (plan && audio.currentTime >= plan.start && left > 0.5) startCrossfade(ni, Math.min(plan.len, left));
}

async function startCrossfade(ni, len) {
  const t = state.queue[ni];
  if (!t || t.available === false) return;
  fadeStarting = true;
  const seq = loadSeq;
  const nd = otherDeck();
  try {
    const { url } = await urlFor(t);
    if (seq !== loadSeq) return;
    nd.el.src = streamSrc(url);
    setDeckGain(nd, 0);
    await nd.el.play();
    if (seq !== loadSeq) return nd.el.pause();
  } catch {
    return; // fall back to a hard cut on `ended`
  } finally {
    fadeStarting = false;
  }

  const old = audio;
  setDeckGain(deckOf(old), 0, len);
  setDeckGain(nd, normGain(t), len);

  waveTrackEnded(true);
  audio = nd.el;
  state.index = ni;
  fade = { old, timer: setTimeout(finishFade, len * 1000 + 150) };
  emit("track");
  emit("state");
  updateMediaSession();
  syncSession();
  waveTrackStarted(t);
  pushRpc();
}

// ---------- loading ----------
let loadSeq = 0;
let failStreak = 0;

async function load(i, autoplay = true) {
  const t = state.queue[i];
  if (!t) return;
  waveTrackEnded();
  finishFade();
  state.index = i;
  state.loading = true;
  emit("track");
  updateMediaSession();

  const seq = ++loadSeq;
  try {
    if (t.available === false) throw new Error("Трек недоступен");
    const { url, preview } = await urlFor(t);
    if (seq !== loadSeq) return;
    audio._key = String(t.id); // native download cache key
    audio.src = streamSrc(url);
    setDeckGain(deckOf(audio), normGain(t));
    if (autoplay) {
      ensureGraph();
      await audio.play();
    }
    failStreak = 0;
    if (preview) toast("Доступно только 30‑секундное превью — нужна подписка Плюс");
    waveTrackStarted(t);
    scheduleNativeSync();
  } catch (e) {
    if (seq !== loadSeq || e?.name === "AbortError") return;
    audio.pause(); // a media error leaves `paused` false, which would show a stuck "pause" button
    toast(`Не удалось воспроизвести «${t.title}»: ${e?.message || e}`, "error");
    if (++failStreak < 4) setTimeout(() => seq === loadSeq && next(true), 600);
  } finally {
    if (seq === loadSeq) {
      state.loading = false;
      emit("state");
      pushRpc();
    }
  }
}

// ---------- public controls ----------

/**
 * Start a rotor station. `station` = { id: "user:onyourwave" | "genre:rock" | "track:123" | …,
 * label, route? } — route is where "playing from" leads.
 */
export async function startWave(station = MY_WAVE) {
  state.mode = "wave";
  state.station = station;
  state.context = { label: station.label, route: station.route || { name: "wave" } };
  state.shuffle = false;
  state.original = null;
  state.loading = true;
  emit("state");
  try {
    waveTrackEnded();
    state.queue = await fetchStation();
    if (!state.queue.length) throw new Error("станция не вернула треков");
    state.index = -1;
    api.wave.feedback(station.id, "radioStarted", state.queue[0]?._batch);
    emit("queue");
    await load(0);
  } catch (e) {
    state.loading = false;
    emit("state");
    toast(`Не удалось запустить «${station.label}»: ${e?.message || e}`, "error");
  }
}

const shuffled = (arr) => {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = (Math.random() * (i + 1)) | 0;
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

/** Play a list of tracks starting at `index`. `context` = { label, route } for "playing from". */
export function playList(tracks, index = 0, context = null, { shuffle } = {}) {
  if (!tracks?.length) return;
  if (shuffle != null) state.shuffle = shuffle;
  state.mode = "list";
  state.context = context;
  state.original = tracks.slice();
  if (state.shuffle) {
    const first = tracks[index] ?? tracks[(Math.random() * tracks.length) | 0];
    state.queue = [first, ...shuffled(tracks.filter((t) => t !== first))];
    index = 0;
  } else {
    state.queue = tracks.slice();
  }
  emit("queue");
  load(index);
}

/** Insert a track right after the current one. */
export function playNext(t) {
  if (!state.track) return playList([t], 0, null);
  state.queue.splice(state.index + 1, 0, t);
  if (state.original) {
    const oi = state.original.indexOf(state.track);
    state.original.splice(oi + 1, 0, t);
  }
  prefetched = null;
  emit("queue");
  toast(`«${t.title}» заиграет следующим`);
}

export function jump(i) {
  if (i >= 0 && i < state.queue.length) load(i);
}

export function toggle() {
  if (!state.track) return startWave();
  ensureGraph();
  if (audio.paused) audio.play().catch((e) => toast(String(e), "error"));
  else pause();
}

function pause() {
  finishFade();
  audio.pause();
}

export async function next(auto = false) {
  const i = state.index + 1;
  if (state.mode === "wave") {
    if (i >= state.queue.length && !(await moreWave())) return;
    return load(i);
  }
  if (i < state.queue.length) return load(i);
  if (state.repeat === "all" && state.queue.length) return load(0);
  if (auto) {
    audio.pause();
    audio.currentTime = 0;
  }
}

export function prev() {
  if (audio.currentTime > 3 || state.index <= 0) {
    audio.currentTime = 0;
    return;
  }
  load(state.index - 1);
}

export function seek(frac) {
  if (!audio.duration) return;
  finishFade();
  audio.currentTime = Math.max(0, Math.min(1, frac)) * audio.duration;
}

export function setVolume(v) {
  state.volume = Math.max(0, Math.min(1, v));
  state.muted = false;
  applyVolume();
  save("volume", state.volume);
  emit("volume");
}

export function toggleMute() {
  state.muted = !state.muted;
  applyVolume();
  emit("volume");
}

export function toggleShuffle() {
  if (state.mode === "wave") return;
  state.shuffle = !state.shuffle;
  const cur = state.track;
  if (state.original && cur) {
    if (state.shuffle) {
      state.queue = [cur, ...shuffled(state.original.filter((t) => t !== cur))];
      state.index = 0;
    } else {
      state.queue = state.original.slice();
      state.index = state.queue.indexOf(cur);
    }
  }
  prefetched = null;
  emit("queue");
  emit("state");
}

export function cycleRepeat() {
  state.repeat = { off: "all", all: "one", one: "off" }[state.repeat];
  scheduleNativeSync();
  emit("state");
}

export async function dislikeCurrent() {
  const t = state.track;
  if (!t) return;
  try {
    await api.dislike(t);
    if (state.mode === "wave") api.wave.feedback(state.station.id, "dislike", t._batch, { trackId: api.trackKey(t) });
    toast("Больше не будем такое предлагать");
    next();
  } catch (e) {
    toast(`Ошибка: ${e}`, "error");
  }
}

export function setRpc(onOff) {
  state.rpc = onOff;
  save("rpc", onOff);
  onOff ? pushRpc() : invoke("rpc_clear");
}

// ---------- sleep timer ----------
export const sleep = { mode: null, until: 0 }; // mode: null | "time" | "track"
let sleepTimer = null;

/** mode "time" + minutes, "track" (stop after the current one), or null to cancel. */
export function setSleep(mode, minutes = 0) {
  clearTimeout(sleepTimer);
  sleep.mode = mode;
  sleep.until = mode === "time" ? Date.now() + minutes * 60000 : 0;
  // iOS: the timer runs natively; JS is frozen while the screen is locked.
  if (NATIVE) native("sleep", { seconds: mode === "time" ? minutes * 60 : 0 }).catch(() => {});
  else if (mode === "time") sleepTimer = setTimeout(sleepNow, minutes * 60000);
  emit("sleep");
}

async function sleepNow() {
  setSleep(null);
  if (!state.playing) return;
  const FADE = 8;
  if (master) {
    const g = master.gain, now = actx.currentTime;
    g.cancelScheduledValues(now);
    g.setValueAtTime(g.value, now);
    g.linearRampToValueAtTime(0, now + FADE);
    await new Promise((r) => setTimeout(r, FADE * 1000));
  }
  pause();
  if (master) master.gain.setValueAtTime(1, actx.currentTime);
  toast("Таймер сна: музыка остановлена");
}

// ---------- audio events (both decks; only the current one counts) ----------
const onDeck = (type, fn) => decks.forEach((d) => d.el.addEventListener(type, (e) => e.target === audio && fn(e)));

onDeck("play", () => (emit("state"), pushRpc(), syncSession()));
onDeck("pause", () => (emit("state"), pushRpc(), syncSession()));
onDeck("seeked", () => (pushRpc(), syncSession()));
onDeck("loadedmetadata", () => (emit("time"), syncSession()));
onDeck("timeupdate", () => (emit("time"), maybeCrossfade()));
onDeck("waiting", () => ((state.loading = true), emit("state")));
onDeck("playing", () => ((state.loading = false), emit("state")));
onDeck("ended", () => {
  if (sleep.mode === "track") {
    setSleep(null);
    toast("Таймер сна: музыка остановлена");
    return emit("state");
  }
  if (state.repeat === "one" && state.mode !== "wave") {
    audio.currentTime = 0;
    audio.play();
  } else next(true);
});
onDeck("error", () => {
  if (!audio.src || state.loading) return; // load() reports its own failures
  toast("Ошибка загрузки аудио", "error");
});

// ---------- Media Session (media keys, Windows overlay) ----------
const ms = NATIVE ? null : navigator.mediaSession; // iOS: native Now Playing + remote commands
function updateMediaSession() {
  const t = state.track;
  if (NATIVE && t) {
    native("now_playing", {
      title: t.title + (t.version ? ` (${t.version})` : ""),
      artist: api.artistsOf(t) || "",
      album: t.albums?.[0]?.title || null,
      artwork: api.cover(t, 600) || null,
      duration: t.durationMs ? t.durationMs / 1000 : null,
    }).catch(() => {});
    return;
  }
  if (!ms || !t) return;
  ms.metadata = new MediaMetadata({
    title: t.title,
    artist: api.artistsOf(t),
    album: t.albums?.[0]?.title || "",
    artwork: [{ src: api.cover(t, 400), sizes: "400x400", type: "image/jpeg" }],
  });
}
function syncSession() {
  if (!ms) return;
  ms.playbackState = audio.paused ? "paused" : "playing";
  if (audio.duration && isFinite(audio.duration)) {
    try {
      ms.setPositionState({ duration: audio.duration, position: Math.min(audio.currentTime, audio.duration), playbackRate: 1 });
    } catch {}
  }
}
if (ms) {
  ms.setActionHandler("play", () => toggle());
  ms.setActionHandler("pause", () => pause());
  ms.setActionHandler("nexttrack", () => next());
  ms.setActionHandler("previoustrack", () => prev());
  ms.setActionHandler("seekto", (d) => audio.duration && seek(d.seekTime / audio.duration));
}

// ---------- Discord RPC ----------
function pushRpc() {
  const t = state.track;
  if (!state.rpc) return;
  if (!t) return invoke("rpc_clear");
  const now = Date.now();
  const pos = (audio.currentTime || 0) * 1000;
  const dur = (audio.duration || t.durationMs / 1000 || 0) * 1000;
  invoke("rpc_update", {
    presence: {
      title: t.title + (t.version ? ` (${t.version})` : ""),
      artists: api.artistsOf(t) || "Неизвестный исполнитель",
      album: t.albums?.[0]?.title || null,
      cover: api.cover(t, 400) || null,
      url: api.webUrl(t),
      playing: !audio.paused,
      start: Math.round(now - pos),
      end: dur ? Math.round(now - pos + dur) : null,
    },
  }).catch(() => {});
}

// ---------- iOS native engine events ----------
if (NATIVE) {
  const { addPluginListener } = window.__TAURI__.core;
  const listen = (event, fn) => addPluginListener("ymaudio", event, fn).catch((e) => console.error("ymaudio", event, e));
  const deckFor = (s) => {
    const d = decks[s.deck]?.el;
    return d && s.token === d._token ? d : null;
  };
  listen("state", (s) => {
    const d = deckFor(s);
    if (!d) return;
    d._pos = s.position;
    if (s.duration) d._dur = s.duration;
    // Native is the source of truth for play/pause (lock screen, calls, unplugged headphones).
    if (s.playing === d._paused) {
      d._paused = !s.playing;
      d._emit(s.playing ? "play" : "pause");
    }
    d._emit("timeupdate");
  });
  listen("ended", (s) => {
    const d = deckFor(s);
    if (!d) return;
    d._ended = true;
    d._paused = true;
    d._emit("pause");
    d._emit("ended");
  });
  listen("advanced", onNativeAdvanced);
  listen("remote", ({ command }) => {
    if (command === "next") next();
    else if (command === "prev") prev();
    else if (command === "slept") {
      setSleep(null);
      toast("Таймер сна: музыка остановлена");
    }
  });
  listen("spectrum", ({ bins }) => nativeBins.set(bins.slice(0, 256)));
  applyEq();
}
