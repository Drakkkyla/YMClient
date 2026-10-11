//! `ymstream:` protocol — the player's audio goes through Rust instead of straight to the CDN.
//!
//! The stream CDN only grants CORS to a few origins (localhost, tauri.localhost, the Yandex
//! site). The page needs CORS to route audio through Web Audio (EQ, analyser, crossfade), and
//! on macOS the page origin is `tauri://localhost`, which the CDN doesn't list. Proxying makes
//! the origin irrelevant on every platform: we fetch upstream ourselves and answer with
//! permissive CORS headers.
//!
//! URL shape (built by `convertFileSrc(url, "ymstream")` on the JS side):
//!   Windows: http://ymstream.localhost/<percent-encoded upstream url>
//!   macOS:   ymstream://localhost/<percent-encoded upstream url>

use crate::api::Api;
use percent_encoding::percent_decode_str;
use tauri::http::{header, Request, Response, StatusCode};
use tauri::{AppHandle, Manager};

/// Largest slice served per request. Media elements ask for open-ended ranges ("bytes=0-");
/// answering those with a bounded 206 lets playback start fast and they fetch the rest.
const CHUNK: u64 = 2 * 1024 * 1024;

fn allowed(url: &reqwest::Url) -> bool {
    url.scheme() == "https"
        && url
            .host_str()
            .is_some_and(|h| h.ends_with(".yandex.net") || h.ends_with(".yandex.ru"))
}

/// Parses "bytes=START-[END]".
fn parse_range(v: &str) -> Option<(u64, Option<u64>)> {
    let spec = v.strip_prefix("bytes=")?.split(',').next()?.trim();
    let (a, b) = spec.split_once('-')?;
    let start = a.parse().ok()?;
    let end = if b.is_empty() { None } else { Some(b.parse().ok()?) };
    Some((start, end))
}

fn reply(status: StatusCode) -> tauri::http::response::Builder {
    Response::builder()
        .status(status)
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .header(header::ACCESS_CONTROL_ALLOW_HEADERS, "Range")
        .header(header::ACCESS_CONTROL_EXPOSE_HEADERS, "Content-Range, Content-Length, Accept-Ranges")
}

fn error(status: StatusCode, msg: &str) -> Response<Vec<u8>> {
    reply(status)
        .header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
        .body(msg.as_bytes().to_vec())
        .unwrap()
}

pub async fn handle(app: AppHandle, req: Request<Vec<u8>>) -> Response<Vec<u8>> {
    if req.method() == tauri::http::Method::OPTIONS {
        return reply(StatusCode::NO_CONTENT).body(Vec::new()).unwrap();
    }

    let raw = req.uri().path().trim_start_matches('/');
    let decoded = percent_decode_str(raw).decode_utf8_lossy();
    let Ok(upstream) = reqwest::Url::parse(&decoded) else {
        return error(StatusCode::BAD_REQUEST, "bad stream url");
    };
    if !allowed(&upstream) {
        return error(StatusCode::FORBIDDEN, "only Yandex stream hosts are proxied");
    }

    let (start, end) = req
        .headers()
        .get(header::RANGE)
        .and_then(|v| v.to_str().ok())
        .and_then(parse_range)
        .unwrap_or((0, None));
    let end = end.unwrap_or(start + CHUNK - 1).min(start + CHUNK - 1);

    let api = app.state::<Api>();
    let resp = match api
        .http
        .get(upstream)
        .header(header::RANGE, format!("bytes={start}-{end}"))
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => return error(StatusCode::BAD_GATEWAY, &e.to_string()),
    };

    let status = resp.status();
    if !status.is_success() {
        return error(StatusCode::from_u16(status.as_u16()).unwrap_or(StatusCode::BAD_GATEWAY), "upstream error");
    }
    let content_range = resp.headers().get(header::CONTENT_RANGE).cloned();
    let body = match resp.bytes().await {
        Ok(b) => b.to_vec(),
        Err(e) => return error(StatusCode::BAD_GATEWAY, &e.to_string()),
    };

    let mut out = reply(if content_range.is_some() { StatusCode::PARTIAL_CONTENT } else { StatusCode::OK })
    // The CDN says application/octet-stream; WebKit is pickier than Chromium about that.
    .header(header::CONTENT_TYPE, "audio/mpeg")
    .header(header::ACCEPT_RANGES, "bytes")
    .header(header::CONTENT_LENGTH, body.len());
    if let Some(cr) = content_range {
        out = out.header(header::CONTENT_RANGE, cr);
    }
    out.body(body).unwrap()
}
