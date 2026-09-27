//! Test bridge to the real native manager; never reads the user's default profile.
use buzzodz_plugins::Manager;
use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::path::PathBuf;
fn main() {
    let args: Vec<_> = std::env::args().skip(1).collect();
    let home = PathBuf::from(&args[0]);
    assert!(home.is_absolute());
    if args[1] == "hold-lock" {
        let profile = home.join("profiles/proof");
        fs::create_dir_all(&profile).unwrap();
        let lock = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(profile.join("registry.lock"))
            .unwrap();
        lock.lock().unwrap();
        println!("locked");
        std::io::stdout().flush().unwrap();
        // Explicit parent-controlled release, not a sleep-as-synchronization.
        std::io::stdin().read_exact(&mut [0]).unwrap();
        return;
    }
    let manager = Manager::open(Some(home), "proof", false).unwrap();
    let result = match args[1].as_str() {
        "catalog" => {
            serde_json::json!({"status":"ready","catalog":manager.catalog().unwrap(),"externalPluginsPaused":false})
        }
        "module" => serde_json::json!({"code":manager.module(&args[2], &args[3]).unwrap()}),
        "change" => {
            manager.change(&args[2], &args[3]).unwrap();
            serde_json::json!({"status":"ready","catalog":manager.catalog().unwrap(),"externalPluginsPaused":false})
        }
        "install" => {
            manager.install(&PathBuf::from(&args[2])).unwrap();
            serde_json::json!({"status":"ready","catalog":manager.catalog().unwrap(),"externalPluginsPaused":false})
        }
        _ => panic!("Unknown fixture operation"),
    };
    println!("{result}");
}
