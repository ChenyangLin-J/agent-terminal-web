(() => {
  const sessionScreen = document.querySelector("#session-screen");
  const viewTabs = sessionScreen?.querySelector(".view-tabs");
  if (!sessionScreen || !viewTabs) return;

  const toggle = document.createElement("button");
  toggle.id = "session-focus-toggle";
  toggle.type = "button";
  toggle.setAttribute("aria-label", "进入专注查看");
  toggle.setAttribute("aria-pressed", "false");
  toggle.title = "专注查看";
  toggle.textContent = "⛶";
  viewTabs.classList.add("focus-mode-tabs");
  viewTabs.append(toggle);

  toggle.addEventListener("click", () => setFocusMode(!sessionScreen.classList.contains("session-focus-mode")));
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && sessionScreen.classList.contains("session-focus-mode")) setFocusMode(false);
  });

  sessionScreen.addEventListener(
    "touchmove",
    (event) => {
      if (sessionScreen.classList.contains("session-focus-mode") && event.touches.length > 1) {
        event.stopImmediatePropagation();
      }
    },
    { capture: true, passive: true },
  );

  new MutationObserver(() => {
    if (sessionScreen.classList.contains("hidden")) setFocusMode(false);
  }).observe(sessionScreen, { attributes: true, attributeFilter: ["class"] });

  function setFocusMode(active) {
    if (active && sessionScreen.classList.contains("hidden")) return;
    sessionScreen.classList.toggle("session-focus-mode", active);
    toggle.setAttribute("aria-pressed", String(active));
    toggle.setAttribute("aria-label", active ? "退出专注查看" : "进入专注查看");
    toggle.title = active ? "退出专注查看" : "专注查看";
    toggle.textContent = active ? "×" : "⛶";
    requestAnimationFrame(() => requestAnimationFrame(() => window.dispatchEvent(new Event("resize"))));
  }
})();
