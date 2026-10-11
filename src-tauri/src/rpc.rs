//! Discord Rich Presence on a dedicated thread, so IPC hiccups never block the UI.
//! Reconnects lazily on the next update if Discord was closed or unreachable.

#[cfg(desktop)]
use discord_rich_presence::activity::{Activity, ActivityType, Assets, Button, Timestamps};
#[cfg(desktop)]
use discord_rich_presence::{DiscordIpc, DiscordIpcClient};
use serde::Deserialize;
use std::sync::mpsc::{self, Sender};
use std::sync::Mutex;
use tauri::State;

#[cfg(desktop)]
const CLIENT_ID: &str = "1555628601846661120";
#[cfg(desktop)]
const ICON_PLAY: &str = "https://cdn.discordapp.com/app-assets/1555628601846661120/1557056758793633892.png";
#[cfg(desktop)]
const ICON_PAUSE: &str = "https://cdn.discordapp.com/app-assets/1555628601846661120/1557056771267371088.png";

#[derive(Deserialize)]
#[cfg_attr(mobile, allow(dead_code))]
pub struct Presence {
    title: String,
    artists: String,
    album: Option<String>,
    cover: Option<String>,
    url: Option<String>,
    playing: bool,
    /// Unix ms when the track (virtually) started, i.e. now - position.
    start: Option<i64>,
    /// Unix ms when the track will end.
    end: Option<i64>,
}

#[cfg_attr(mobile, allow(dead_code))]
enum Msg {
    Set(Presence),
    Clear,
}

pub struct Rpc(Mutex<Sender<Msg>>);

/// Discord requires 2..=128 chars for text fields.
#[cfg(desktop)]
fn fit(s: &str) -> String {
    let mut s: String = s.chars().take(128).collect();
    while s.chars().count() < 2 {
        s.push(' ');
    }
    s
}

#[cfg(desktop)]
fn apply(client: &mut DiscordIpcClient, p: &Presence) -> Result<(), Box<dyn std::error::Error>> {
    let (title, artists) = (fit(&p.title), fit(&p.artists));
    let album = p.album.as_deref().map(fit);
    let mut assets = Assets::new()
        .small_image(if p.playing { ICON_PLAY } else { ICON_PAUSE })
        .small_text(if p.playing { "Играет" } else { "Пауза" });
    if let Some(c) = p.cover.as_deref() {
        assets = assets.large_image(c);
    }
    if let Some(a) = album.as_deref() {
        assets = assets.large_text(a);
    }
    let mut activity = Activity::new()
        .activity_type(ActivityType::Listening)
        .details(&title)
        .state(&artists)
        .assets(assets);
    if p.playing {
        if let (Some(s), Some(e)) = (p.start, p.end) {
            activity = activity.timestamps(Timestamps::new().start(s / 1000).end(e / 1000));
        }
    }
    if let Some(u) = p.url.as_deref() {
        activity = activity.buttons(vec![Button::new("Слушать в Яндекс Музыке", u)]);
    }
    client.set_activity(activity)?;
    Ok(())
}

/// On mobile there's no Discord client: updates are accepted and dropped.
#[cfg(mobile)]
pub fn spawn() -> Rpc {
    let (tx, rx) = mpsc::channel::<Msg>();
    std::thread::spawn(move || for _ in rx {});
    Rpc(Mutex::new(tx))
}

#[cfg(desktop)]
pub fn spawn() -> Rpc {
    let (tx, rx) = mpsc::channel::<Msg>();
    std::thread::spawn(move || {
        let mut client: Option<DiscordIpcClient> = None;
        while let Ok(msg) = rx.recv() {
            // Collapse bursts (seek spam etc.) into the latest state.
            let msg = rx.try_iter().last().unwrap_or(msg);
            if client.is_none() {
                client = DiscordIpcClient::new(CLIENT_ID)
                    .ok()
                    .and_then(|mut c| c.connect().ok().map(|_| c));
            }
            let Some(c) = client.as_mut() else { continue };
            let ok = match &msg {
                Msg::Set(p) => apply(c, p).is_ok(),
                Msg::Clear => c.clear_activity().is_ok(),
            };
            if !ok {
                let _ = c.close();
                client = None;
            }
        }
    });
    Rpc(Mutex::new(tx))
}

#[tauri::command]
pub fn rpc_update(rpc: State<'_, Rpc>, presence: Presence) {
    let _ = rpc.0.lock().unwrap().send(Msg::Set(presence));
}

#[tauri::command]
pub fn rpc_clear(rpc: State<'_, Rpc>) {
    let _ = rpc.0.lock().unwrap().send(Msg::Clear);
}
