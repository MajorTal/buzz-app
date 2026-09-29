sources = ["env:///bin/packages", "https://github.com/cashapp/hermit-packages.git"]
manage-git = false
# Share Cargo's download caches across worktrees instead of per-worktree .hermit/rust.
env = {
  "CARGO_HOME": "${HOME}/.cargo",
}
