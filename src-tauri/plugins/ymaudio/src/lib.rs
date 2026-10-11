//! YMClient's native audio engine for iOS.
//!
//! WKWebView can't do what a music player needs on iPhone: iOS interrupts Web Audio as soon as
//! the app is backgrounded and ignores `<audio>.volume`. So on iOS playback runs in Swift on
//! AVAudioEngine (two decks for crossfade, a 10-band EQ, per-deck gain for loudness
//! normalization, Now Playing / lock-screen controls), driven from `src/lib/player.js`.
//! On desktop the plugin registers but does nothing — playback stays in the webview there.

use tauri::{
    plugin::{Builder, TauriPlugin},
    Runtime,
};

#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_ymaudio);

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("ymaudio")
        .setup(|_app, _api| {
            #[cfg(target_os = "ios")]
            _api.register_ios_plugin(init_plugin_ymaudio)?;
            Ok(())
        })
        .build()
}
