// Desktop entry (handy for a quick local run); on iOS the lib's mobile entry point is used.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    ymprobe_lib::run()
}
