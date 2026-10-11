mod api;
mod rpc;
mod stream;

use api::Api;
use serde_json::{json, Value};
use std::path::PathBuf;
use tauri::{AppHandle, Emitter, Manager, State, Url, WebviewUrl, WebviewWindowBuilder};

/// Official Yandex Music app's OAuth client — implicit flow redirects with #access_token=…
const OAUTH_URL: &str =
    "https://oauth.yandex.ru/authorize?response_type=token&client_id=23cabbbdc6cd418abb4b39c32c41195d";

fn config_path(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join("config.json"))
}

fn load_token(app: &AppHandle) -> Option<String> {
    let raw = std::fs::read_to_string(config_path(app)?).ok()?;
    let cfg: Value = serde_json::from_str(&raw).ok()?;
    cfg["token"].as_str().map(str::to_owned)
}

fn store_token(app: &AppHandle, token: Option<&str>) -> Result<(), String> {
    let path = config_path(app).ok_or("Нет папки конфигурации")?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    std::fs::write(&path, json!({ "token": token }).to_string()).map_err(|e| e.to_string())?;
    *app.state::<Api>().token.lock().unwrap() = token.map(str::to_owned);
    Ok(())
}

fn token_from_url(url: &Url) -> Option<String> {
    let frag = url.fragment()?;
    url::form_urlencoded::parse(frag.as_bytes())
        .find(|(k, _)| k == "access_token")
        .map(|(_, v)| v.into_owned())
}

#[tauri::command]
fn has_token(api: State<'_, Api>) -> bool {
    api.token.lock().unwrap().is_some()
}

#[tauri::command]
fn set_token(app: AppHandle, token: String) -> Result<(), String> {
    let token = token.trim();
    if token.is_empty() {
        return Err("Пустой токен".into());
    }
    store_token(&app, Some(token))
}

#[tauri::command]
fn logout(app: AppHandle) -> Result<(), String> {
    store_token(&app, None)
}

/// Opens Yandex's own login page in a separate window and catches the token from the redirect.
#[tauri::command]
async fn login(app: AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("login") {
        let _ = w.set_focus();
        return Ok(());
    }
    let handle = app.clone();
    WebviewWindowBuilder::new(&app, "login", WebviewUrl::External(OAUTH_URL.parse().unwrap()))
        .title("Вход в Яндекс")
        .inner_size(480.0, 720.0)
        .center()
        .on_navigation(move |url| {
            let Some(token) = token_from_url(url) else { return true };
            let h = handle.clone();
            tauri::async_runtime::spawn(async move {
                match store_token(&h, Some(&token)) {
                    Ok(()) => {
                        let _ = h.emit("auth-changed", true);
                    }
                    Err(e) => {
                        let _ = h.emit("auth-error", e);
                    }
                }
                if let Some(w) = h.get_webview_window("login") {
                    let _ = w.close();
                }
            });
            false
        })
        .build()
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .register_asynchronous_uri_scheme_protocol("ymstream", |ctx, request, responder| {
            let app = ctx.app_handle().clone();
            tauri::async_runtime::spawn(async move {
                responder.respond(stream::handle(app, request).await);
            });
        })
        .setup(|app| {
            let token = load_token(app.handle());
            app.manage(Api::new(token));
            app.manage(rpc::spawn());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            has_token,
            set_token,
            logout,
            login,
            api::ym,
            api::track_url,
            api::avatar_url,
            rpc::rpc_update,
            rpc::rpc_clear,
        ])
        .run(tauri::generate_context!())
        .expect("error while running YMClient");
}
