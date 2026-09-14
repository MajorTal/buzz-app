// Native drag ghost: an always-on-top window Rust moves under the pointer while
// a tab is dragged. The title arrives in the query string on creation and via
// hashchange on reuse; this page needs no IPC and has no capability.
// Appearance is read from the same-origin storage the app windows save to
// (keys as in appearance-init.js), on every show so a theme change is followed.
const render = () => {
  let mode = "light";
  let scale = 1;
  try {
    if (localStorage.getItem("buzz-appearance.v1") === "dark") mode = "dark";
    const value = Number(localStorage.getItem("buzz-font-scale.v1"));
    if (Number.isFinite(value) && value >= 0.8 && value <= 2)
      scale = Math.round(value * 10) / 10;
  } catch {
    // Storage may be denied; the light palette is the safe default.
  }
  document.documentElement.dataset.colorMode = mode;
  document.documentElement.style.setProperty(
    "--buzz-text-scale",
    String(scale),
  );
  const title =
    new URLSearchParams(location.hash.slice(1)).get("title") ||
    new URLSearchParams(location.search).get("title") ||
    "";
  document.getElementById("tab").textContent = title;
};
window.addEventListener("hashchange", render);
render();
