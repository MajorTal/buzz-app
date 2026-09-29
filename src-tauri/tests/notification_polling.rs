#![cfg(target_os = "macos")]

//! Native regression harness: real polling code and Foundation, fake OS boundary.
use std::{path::PathBuf, process::Command};

#[test]
fn shared_dismissal_polling() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let temporary = tempfile::tempdir().expect("create native harness directory");
    let binary = temporary.path().join("dismissal-poll");
    let compiled = Command::new("xcrun")
        .args([
            "clang",
            "-fblocks",
            "-Wno-deprecated-declarations",
            "-framework",
            "Cocoa",
        ])
        .arg(root.join("tests/notification_polling.m"))
        .arg("-o")
        .arg(&binary)
        .output()
        .expect("compile native polling regression harness");
    assert!(
        compiled.status.success(),
        "{}",
        String::from_utf8_lossy(&compiled.stderr)
    );
    let result = Command::new(&binary).output();
    let result = result.expect("run native polling regression harness");
    assert!(
        result.status.success(),
        "stdout: {}\nstderr: {}",
        String::from_utf8_lossy(&result.stdout),
        String::from_utf8_lossy(&result.stderr)
    );
}
