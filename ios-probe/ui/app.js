// YMProbe: plays anonymous previews back to back in one of two modes and logs everything
// that matters for background playback, so the log tells us exactly where iOS stopped us.
const { invoke, convertFileSrc } = window.__TAURI__.core;
const $ = (s) => document.querySelector(s);

// ---------- log (survives reloads; readable after unlocking) ----------
const LOG_KEY = "probe.log";
let lines = [];
try {
  lines = JSON.parse(localStorage.getItem(LOG_KEY) || "[]");
} catch {}
const t0 = performance.now();
function log(msg) {
  const d = new Date();
  const stamp = `${d.toTimeString().slice(0, 8)}.${String(d.getMilliseconds()).padStart(3, "0")}`;
  lines.push(`${stamp} ${msg}`);
  if (lines.length > 600) lines = lines.slice(-600);
  try {
    localStorage.setItem(LOG_KEY, JSON.stringify(lines));
  } catch {}
  const box = $("#log");
  box.value = lines.join("\n");
  box.scrollTop = box.scrollHeight;
}

// ---------- two players: plain element vs. the YMClient path ----------
const simple = new Audio(); // straight from the CDN, no CORS, no Web Audio
const wa = new Audio(); // through the ymstream proxy into an AudioContext, like YMClient
wa.crossOrigin = "anonymous";
for (const el of [simple, wa]) el.preload = "auto";

let actx, analyser, bins;
function ensureGraph() {
  if (actx) return actx.state === "suspended" ? actx.resume() : null;
  actx = new AudioContext();
  analyser = actx.createAnalyser();
  analyser.fftSize = 256;
  actx.createMediaElementSource(wa).connect(analyser);
  analyser.connect(actx.destination);
  bins = new Uint8Array(analyser.frequencyBinCount);
  actx.addEventListener("statechange", () => log(`AudioContext → ${actx.state}`));
  log(`AudioContext создан (${actx.state}, ${actx.sampleRate} Гц)`);
}

let mode = null;
let tracks = [];
let index = -1;
const el = () => (mode === "webaudio" ? wa : simple);

for (const [name, a] of [["simple", simple], ["webaudio", wa]]) {
  const on = (type, fn) => a.addEventListener(type, (e) => mode === name && fn(e));
  on("play", () => log(`▶ play`));
  on("playing", () => log(`▶ playing (${a.currentTime.toFixed(1)} с)`));
  on("pause", () => log(`⏸ pause (${a.currentTime.toFixed(1)} с)`));
  on("waiting", () => log(`… waiting`));
  on("stalled", () => log(`… stalled`));
  on("ended", () => {
    log(`■ ended → следующий`);
    play(index + 1);
  });
  on("error", () => log(`✖ media error ${a.error?.code}: ${a.error?.message || ""}`));
}

async function play(i) {
  if (!tracks.length) return;
  index = (i + tracks.length) % tracks.length;
  const t = tracks[index];
  $("#title").textContent = t.title;
  $("#artists").textContent = t.artists;
  $("#cover").src = t.cover;
  try {
    const url = await invoke("track_url", { id: String(t.id) });
    const a = el();
    a.src = mode === "webaudio" ? convertFileSrc(url, "ymstream") : url;
    if (mode === "webaudio") ensureGraph();
    await a.play();
    log(`♪ ${index + 1}/${tracks.length} «${t.title}» [${mode}] (видимость: ${document.visibilityState})`);
    setSession(t);
  } catch (e) {
    log(`✖ не удалось включить «${t.title}»: ${e?.message || e}`);
  }
}

async function start(m) {
  for (const a of [simple, wa]) a.pause();
  mode = m;
  document.querySelectorAll(".mode").forEach((b) => b.classList.toggle("on", b.dataset.mode === m));
  log(`==== режим: ${m === "simple" ? "простой" : "как в YMClient"} ====`);
  if (!tracks.length) {
    try {
      tracks = await invoke("probe_tracks");
      log(`загружено треков: ${tracks.length}`);
    } catch (e) {
      return log(`✖ список треков: ${e}`);
    }
  }
  play(index < 0 ? 0 : index);
}

// ---------- lock screen / Control Center ----------
const ms = navigator.mediaSession;
function setSession(t) {
  if (!ms) return;
  ms.metadata = new MediaMetadata({ title: t.title, artist: t.artists, album: "YMProbe", artwork: [{ src: t.cover, sizes: "400x400", type: "image/jpeg" }] });
}
if (ms) {
  const act = (name, fn) => {
    try {
      ms.setActionHandler(name, () => (log(`🔒 кнопка экрана блокировки: ${name}`), fn()));
    } catch (e) {
      log(`mediaSession ${name} не поддерживается`);
    }
  };
  act("play", () => el().play());
  act("pause", () => el().pause());
  act("nexttrack", () => play(index + 1));
  act("previoustrack", () => play(index - 1));
} else log("navigator.mediaSession недоступен");

// ---------- lifecycle & heartbeat ----------
document.addEventListener("visibilitychange", () => log(`👁 visibility: ${document.visibilityState}`));
window.addEventListener("pagehide", () => log("pagehide"));
window.addEventListener("pageshow", () => log("pageshow"));
window.addEventListener("blur", () => log("blur"));
window.addEventListener("focus", () => log("focus"));

// Every 20 s: is JS alive, is audio moving? Gaps in these lines = iOS suspended the app.
setInterval(() => {
  if (!mode) return;
  const a = el();
  log(`♥ ${document.visibilityState} | ${a.paused ? "пауза" : "играет"} ${a.currentTime.toFixed(1)}/${(a.duration || 0).toFixed(0)} с${actx ? ` | ctx ${actx.state}` : ""}`);
}, 20000);

// Level meter: proves the Web Audio path carries real signal (not tainted/silent).
(function meter() {
  requestAnimationFrame(meter);
  if (mode !== "webaudio" || !analyser) return ($("#meter").style.width = "0");
  analyser.getByteFrequencyData(bins);
  let sum = 0;
  for (const v of bins) sum += v;
  $("#meter").style.width = `${Math.min(100, (sum / bins.length / 128) * 100)}%`;
})();

// ---------- buttons ----------
document.querySelectorAll(".mode").forEach((b) => b.addEventListener("click", () => start(b.dataset.mode)));
$("#toggle").addEventListener("click", () => {
  if (!mode) return;
  const a = el();
  a.paused ? (ensureGraph(), a.play()) : a.pause();
});
$("#next").addEventListener("click", () => mode && play(index + 1));
$("#clear").addEventListener("click", () => {
  lines = [];
  localStorage.removeItem(LOG_KEY);
  $("#log").value = "";
});
$("#copy").addEventListener("click", async () => {
  const text = `YMProbe | ${navigator.userAgent}\n` + lines.join("\n");
  try {
    await navigator.clipboard.writeText(text);
    $("#status").textContent = "Журнал скопирован ✓";
  } catch {
    // Fallback: select the textarea so a long-press → Copy works.
    const box = $("#log");
    box.removeAttribute("readonly");
    box.select();
    document.execCommand("copy");
    box.setAttribute("readonly", "");
    $("#status").textContent = "Если не скопировалось — выдели текст журнала и скопируй вручную";
  }
});

log(`запуск (${Math.round(performance.now() - t0)} мс) — ${navigator.userAgent.match(/OS [\d_]+/)?.[0] || ""}`);
$("#log").value = lines.join("\n");
