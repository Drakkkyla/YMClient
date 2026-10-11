// Every command is implemented in Swift (ios/Sources/YMAudioPlugin.swift); Tauri forwards
// `plugin:ymaudio|<command>` to the native plugin as lowerCamelCase (set_eq → setEq).
// Listing them here generates the `allow-*` permissions the capability grants.
const COMMANDS: &[&str] = &[
    "load",
    "preload",
    "play",
    "pause",
    "seek",
    "stop",
    "gain",
    "set_eq",
    "now_playing",
    "set_queue",
    "sleep",
    "haptic",
    "register_listener",
    "remove_listener",
];

fn main() {
    tauri_plugin::Builder::new(COMMANDS).ios_path("ios").build();
}
