//! YMProbe — a throwaway iOS app answering one question before YMClient goes mobile:
//! does audio keep playing (and advance to the next track) with the screen locked?
//! Anonymous Yandex Music previews (30 s) are enough for that, so no login.

mod stream;

use serde_json::{json, Value};
use tauri::State;

const API: &str = "https://api.music.yandex.net";
const CLIENT_HEADER: &str = "YandexMusicAndroid/24023621";
const SIGN_SALT: &str = "XGRlBW9FXlekgbPrRHuSiA";

pub struct Http {
    pub client: reqwest::Client,
    /// Doesn't follow redirects: used to resolve get-mp3 → strm CDN URL.
    raw: reqwest::Client,
}

/// GET with retries on 429: anonymous requests hit Yandex's concurrency limit often, and a
/// failed lookup at the moment a track ends would stop playback and spoil the test.
async fn get_json(http: &Http, url: &str) -> Result<Value, String> {
    let mut attempt = 0u64;
    let resp = loop {
        let resp = http
            .client
            .get(url)
            .header("X-Yandex-Music-Client", CLIENT_HEADER)
            .send()
            .await
            .map_err(|e| e.to_string())?;
        if resp.status() != reqwest::StatusCode::TOO_MANY_REQUESTS || attempt >= 5 {
            break resp;
        }
        attempt += 1;
        tokio::time::sleep(std::time::Duration::from_millis(800 * attempt)).await;
    };
    let status = resp.status();
    let text = resp.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("HTTP {}: {}", status.as_u16(), text.chars().take(120).collect::<String>()));
    }
    let v: Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    Ok(v.get("result").cloned().unwrap_or(v))
}

/// A handful of popular tracks to loop through.
#[tauri::command]
async fn probe_tracks(http: State<'_, Http>) -> Result<Value, String> {
    let r = get_json(&http, &format!("{API}/search?text=%D1%85%D0%B8%D1%82%D1%8B&type=track&page=0")).await?;
    let tracks: Vec<Value> = r
        .pointer("/tracks/results")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|t| t["available"].as_bool().unwrap_or(true))
        .take(10)
        .map(|t| {
            let artists = t["artists"]
                .as_array()
                .map(|a| a.iter().filter_map(|x| x["name"].as_str()).collect::<Vec<_>>().join(", "))
                .unwrap_or_default();
            let cover = t["coverUri"]
                .as_str()
                .map(|u| format!("https://{}", u.replace("%%", "400x400")))
                .unwrap_or_default();
            json!({ "id": t["id"], "title": t["title"], "artists": artists, "cover": cover })
        })
        .collect();
    Ok(json!(tracks))
}

fn xml_tag<'a>(xml: &'a str, tag: &str) -> Option<&'a str> {
    let open = format!("<{tag}>");
    let start = xml.find(&open)? + open.len();
    let end = xml[start..].find(&format!("</{tag}>"))? + start;
    Some(&xml[start..end])
}

/// Signed stream URL for a track (a 30 s preview without login), redirect already resolved.
#[tauri::command]
async fn track_url(http: State<'_, Http>, id: String) -> Result<String, String> {
    let infos = get_json(&http, &format!("{API}/tracks/{id}/download-info")).await?;
    let info = infos
        .as_array()
        .into_iter()
        .flatten()
        .filter(|i| i["codec"] == "mp3")
        .max_by_key(|i| i["bitrateInKbps"].as_i64().unwrap_or(0))
        .ok_or("нет mp3")?;
    let info_url = info["downloadInfoUrl"].as_str().ok_or("нет downloadInfoUrl")?;
    let xml = http.client.get(info_url).send().await.map_err(|e| e.to_string())?.text().await.map_err(|e| e.to_string())?;
    let field = |t| xml_tag(&xml, t).ok_or_else(|| format!("нет <{t}>"));
    let (host, path, ts, s) = (field("host")?, field("path")?, field("ts")?, field("s")?);
    let sign = format!("{:x}", md5::compute(format!("{SIGN_SALT}{}{s}", &path[1..])));
    let signed = format!("https://{host}/get-mp3/{sign}/{ts}{path}");
    let url = match http.raw.get(&signed).header("Range", "bytes=0-0").send().await {
        Ok(r) if r.status().is_redirection() => r
            .headers()
            .get("location")
            .and_then(|l| l.to_str().ok())
            .map(str::to_owned)
            .unwrap_or(signed),
        _ => signed,
    };
    Ok(url)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let ua = "YMProbe/0.1";
    let http = Http {
        client: reqwest::Client::builder().user_agent(ua).build().expect("http client"),
        raw: reqwest::Client::builder()
            .user_agent(ua)
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .expect("http client"),
    };
    tauri::Builder::default()
        .manage(http)
        .register_asynchronous_uri_scheme_protocol("ymstream", |ctx, request, responder| {
            let app = ctx.app_handle().clone();
            tauri::async_runtime::spawn(async move {
                responder.respond(stream::handle(app, request).await);
            });
        })
        .invoke_handler(tauri::generate_handler![probe_tracks, track_url])
        .run(tauri::generate_context!())
        .expect("error while running YMProbe");
}
