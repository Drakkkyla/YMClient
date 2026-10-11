//! Thin authenticated proxy over the (unofficial) Yandex Music REST API.
//! The frontend builds requests; Rust only adds auth headers, dodges CORS and signs stream URLs.

use reqwest::{Method, StatusCode};
use std::time::Duration;
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Mutex;
use tauri::State;

const BASE: &str = "https://api.music.yandex.net";
const CLIENT_HEADER: &str = "YandexMusicAndroid/24023621";
const SIGN_SALT: &str = "XGRlBW9FXlekgbPrRHuSiA";

pub struct Api {
    pub(crate) http: reqwest::Client,
    /// Doesn't follow redirects: used to resolve get-mp3 → strm CDN URL.
    raw: reqwest::Client,
    pub token: Mutex<Option<String>>,
}

impl Api {
    pub fn new(token: Option<String>) -> Self {
        let http = reqwest::Client::builder()
            .user_agent("YMClient/0.1")
            .build()
            .expect("http client");
        let raw = reqwest::Client::builder()
            .user_agent("YMClient/0.1")
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .expect("http client");
        Self { http, raw, token: Mutex::new(token) }
    }

    fn request(&self, method: Method, url: &str) -> reqwest::RequestBuilder {
        let mut rb = self
            .http
            .request(method, url)
            .header("X-Yandex-Music-Client", CLIENT_HEADER)
            .header("Accept-Language", "ru");
        if let Some(t) = self.token.lock().unwrap().as_deref() {
            rb = rb.header("Authorization", format!("OAuth {t}"));
        }
        rb
    }

    /// Sends a request and returns the response's `result`. Tolerates non-JSON bodies (Yandex
    /// answers some errors — notably 429 — with plain text) and retries 429s: a rate-limited
    /// request was never executed, so repeating it can't double anything.
    async fn call(&self, rb: reqwest::RequestBuilder) -> Result<Value, String> {
        let mut attempt = 0;
        let resp = loop {
            let req = rb.try_clone().ok_or("Не удалось повторить запрос")?;
            let resp = req.send().await.map_err(|e| format!("Сеть недоступна: {e}"))?;
            if resp.status() != StatusCode::TOO_MANY_REQUESTS || attempt >= 2 {
                break resp;
            }
            attempt += 1;
            let wait = resp
                .headers()
                .get(reqwest::header::RETRY_AFTER)
                .and_then(|v| v.to_str().ok())
                .and_then(|v| v.parse::<u64>().ok())
                .unwrap_or(attempt)
                .min(5);
            tokio::time::sleep(Duration::from_secs(wait)).await;
        };

        let status = resp.status();
        let text = resp.text().await.map_err(|e| format!("HTTP {}: {e}", status.as_u16()))?;
        let body: Option<Value> = serde_json::from_str(&text).ok();

        if status == StatusCode::TOO_MANY_REQUESTS {
            return Err("Яндекс временно ограничил запросы (429) — подождите минуту".into());
        }
        if !status.is_success() {
            let msg = body
                .as_ref()
                .and_then(|b| {
                    b.pointer("/error/message")
                        .or_else(|| b.pointer("/error/name"))
                        .or_else(|| b.get("error"))
                        .map(|v| v.as_str().map(str::to_owned).unwrap_or_else(|| v.to_string()))
                })
                .unwrap_or_else(|| text.chars().take(120).collect::<String>().trim().to_owned());
            return Err(format!("HTTP {}: {msg}", status.as_u16()));
        }
        Ok(match body {
            Some(b) => b.get("result").cloned().unwrap_or(b),
            // Some write endpoints answer with an empty or plain-text body — that's still success.
            None if text.trim().is_empty() => Value::Null,
            None => Value::String(text),
        })
    }
}

#[derive(Deserialize)]
pub struct YmRequest {
    method: Option<String>,
    path: String,
    query: Option<HashMap<String, String>>,
    form: Option<HashMap<String, String>>,
    json: Option<Value>,
}

/// Generic API call. Returns the `result` field of the response.
#[tauri::command]
pub async fn ym(api: State<'_, Api>, req: YmRequest) -> Result<Value, String> {
    let method = match req.method.as_deref() {
        Some("POST") => Method::POST,
        _ => Method::GET,
    };
    let mut rb = api.request(method, &format!("{BASE}{}", req.path));
    if let Some(q) = &req.query {
        rb = rb.query(q);
    }
    if let Some(f) = &req.form {
        rb = rb.form(f);
    }
    if let Some(j) = &req.json {
        rb = rb.json(j);
    }
    api.call(rb).await
}

fn xml_tag<'a>(xml: &'a str, tag: &str) -> Option<&'a str> {
    let open = format!("<{tag}>");
    let start = xml.find(&open)? + open.len();
    let end = xml[start..].find(&format!("</{tag}>"))? + start;
    Some(&xml[start..end])
}

/// Resolves a playable MP3 URL for a track (best available bitrate).
#[tauri::command]
pub async fn track_url(api: State<'_, Api>, id: String) -> Result<Value, String> {
    let infos = api
        .call(api.request(Method::GET, &format!("{BASE}/tracks/{id}/download-info")))
        .await?;
    let best = infos
        .as_array()
        .into_iter()
        .flatten()
        .filter(|i| i["codec"] == "mp3")
        .max_by_key(|i| {
            let full = !i["preview"].as_bool().unwrap_or(false);
            (full, i["bitrateInKbps"].as_i64().unwrap_or(0))
        })
        .ok_or("Трек недоступен для прослушивания")?;

    let info_url = best["downloadInfoUrl"].as_str().ok_or("Нет downloadInfoUrl")?;
    let xml = api
        .request(Method::GET, info_url)
        .send()
        .await
        .map_err(|e| e.to_string())?
        .text()
        .await
        .map_err(|e| e.to_string())?;

    let field = |t| xml_tag(&xml, t).ok_or_else(|| format!("download-info без <{t}>"));
    let (host, path, ts, s) = (field("host")?, field("path")?, field("ts")?, field("s")?);
    let sign = format!("{:x}", md5::compute(format!("{SIGN_SALT}{}{s}", &path[1..])));

    let signed = format!("https://{host}/get-mp3/{sign}/{ts}{path}");

    // get-mp3 answers 403 to any request carrying an Origin header (which the webview's
    // CORS-mode <audio> sends), but 30x-redirects plain requests to the strm CDN, which
    // does allow CORS. So resolve the redirect here and hand the CDN URL to the player.
    let url = match api.raw.get(&signed).header("Range", "bytes=0-0").send().await {
        Ok(r) if r.status().is_redirection() => r
            .headers()
            .get("location")
            .and_then(|l| l.to_str().ok())
            .map(str::to_owned)
            .unwrap_or(signed),
        _ => signed,
    };

    Ok(json!({
        "url": url,
        "bitrate": best["bitrateInKbps"],
        "preview": best["preview"].as_bool().unwrap_or(false),
    }))
}

/// Yandex ID avatar of the signed-in user, if they have one.
#[tauri::command]
pub async fn avatar_url(api: State<'_, Api>) -> Result<Option<String>, String> {
    let token = api.token.lock().unwrap().clone().ok_or("Нет токена")?;
    let info: Value = api
        .http
        .get("https://login.yandex.ru/info?format=json")
        .header("Authorization", format!("OAuth {token}"))
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;
    if info["is_avatar_empty"].as_bool().unwrap_or(true) {
        return Ok(None);
    }
    Ok(info["default_avatar_id"]
        .as_str()
        .map(|id| format!("https://avatars.yandex.net/get-yapic/{id}/islands-200")))
}
