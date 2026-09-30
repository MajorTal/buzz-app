#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    buzz_agent_controller::dispatch_agent_supervisor();
    buzz_foundation_lib::run();
}
