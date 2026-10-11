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

/// Desktop: opens Yandex's own login page in a separate window and catches the token from the redirect.
#[cfg(desktop)]
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

// ---------- mobile login ----------
// iOS has a single webview, so the Yandex login page opens *in place*: the main window's
// navigation handler (set up in `run`) grabs the token from the redirect and returns to the app.

/// Pseudo-URL behind the "← YMClient" button injected into Yandex pages; intercepted, never loaded.
#[cfg(mobile)]
const BACK_HOST: &str = "ymclient.back";

/// Adds a floating "back to the app" button on any non-app page (i.e. the Yandex login flow),
/// so cancelling the login never strands the user on Yandex's site.
#[cfg(mobile)]
const BACK_BUTTON_JS: &str = r#"(function () {
  if (/^(tauri:|https?:\/\/(tauri\.)?localhost)/.test(location.href)) return;
  function add() {
    if (document.getElementById("__ym_back")) return;
    var b = document.createElement("a");
    b.id = "__ym_back";
    b.href = "https://ymclient.back/";
    b.textContent = "← YMClient";
    b.style.cssText = "position:fixed;left:12px;top:calc(env(safe-area-inset-top) + 8px);z-index:2147483647;" +
      "padding:9px 15px;border-radius:999px;background:#ffcf40;color:#111;text-decoration:none;" +
      "font:600 14px -apple-system,system-ui,sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.35)";
    document.body.appendChild(b);
  }
  if (document.body) add(); else document.addEventListener("DOMContentLoaded", add);
})();"#;

/// The app page to come back to after the in-place login.
#[cfg(mobile)]
#[derive(Default)]
struct LoginReturn(std::sync::Mutex<Option<Url>>);

#[cfg(mobile)]
#[tauri::command]
async fn login(app: AppHandle) -> Result<(), String> {
    let w = app.get_webview_window("main").ok_or("Нет главного окна")?;
    let back = w.url().map_err(|e| e.to_string())?;
    *app.state::<LoginReturn>().0.lock().unwrap() = Some(back);
    w.navigate(OAUTH_URL.parse().unwrap()).map_err(|e| e.to_string())
}

/// Main-window navigation guard on mobile: catches the OAuth token and the back button.
#[cfg(mobile)]
fn mobile_navigation(app: &AppHandle, url: &Url) -> bool {
    let token = token_from_url(url);
    let back_pressed = url.host_str() == Some(BACK_HOST);
    if token.is_none() && !back_pressed {
        return true;
    }
    let h = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Some(token) = token {
            let _ = store_token(&h, Some(&token));
        }
        let back = h
            .state::<LoginReturn>()
            .0
            .lock()
            .unwrap()
            .take()
            .unwrap_or_else(|| "tauri://localhost".parse().unwrap());
        if let Some(w) = h.get_webview_window("main") {
            let _ = w.navigate(back);
        }
    });
    false
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_ymaudio::init())
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
            // On iOS the window is created here (tauri.ios.conf.json declares none) so it can carry
            // the login navigation handler; on desktop it comes from tauri.conf.json.
            #[cfg(mobile)]
            {
                app.manage(LoginReturn::default());
                let h = app.handle().clone();
                WebviewWindowBuilder::new(app, "main", WebviewUrl::default())
                    .initialization_script(BACK_BUTTON_JS)
                    .on_navigation(move |url| mobile_navigation(&h, url))
                    .build()?;
            }
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
