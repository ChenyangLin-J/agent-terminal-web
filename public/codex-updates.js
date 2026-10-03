(() => {
  const container = document.querySelector("#codex-update-notices");
  const openButton = document.querySelector("#open-codex-updates");
  if (!container || !openButton) return;

  const dismissedPrefix = "agent-codex-update-dismissed:";
  const requestedVersion = new URLSearchParams(location.search).get("codexUpdate") || "";
  let notices = [];
  let showHistory = false;

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
  }

  function addSection(card, label, items, limit) {
    if (!items?.length) return;
    const section = element("div", "codex-update-section");
    section.append(element("strong", "", label));
    const list = element("ul");
    for (const item of items.slice(0, limit)) list.append(element("li", "", item));
    section.append(list);
    if (items.length > limit) {
      const more = element("details", "codex-update-more");
      more.append(element("summary", "", `展开其余 ${items.length - limit} 项`));
      const remaining = element("ul");
      for (const item of items.slice(limit)) remaining.append(element("li", "", item));
      more.append(remaining);
      section.append(more);
    }
    card.append(section);
  }

  function dismiss(version) {
    try { localStorage.setItem(`${dismissedPrefix}${version}`, "1"); } catch {}
    const url = new URL(location.href);
    if (url.searchParams.get("codexUpdate") === version) {
      url.searchParams.delete("codexUpdate");
      history.replaceState(history.state, "", url);
    }
    showHistory = false;
    render();
  }

  function render() {
    container.replaceChildren();
    const visible = notices.filter((notice) => {
      if (showHistory || notice.version === requestedVersion && new URLSearchParams(location.search).has("codexUpdate")) return true;
      try { return localStorage.getItem(`${dismissedPrefix}${notice.version}`) !== "1"; } catch { return true; }
    });
    if (!visible.length && !showHistory) {
      container.classList.add("hidden");
      return;
    }
    container.classList.remove("hidden");
    container.append(element("h2", "codex-update-heading", showHistory ? "Codex 更新记录" : "Codex 有新版本"));
    if (!visible.length) {
      container.append(element("p", "codex-update-empty", "暂时没有更新记录。"));
      return;
    }
    for (const notice of visible.slice(0, showHistory ? 20 : 5)) {
      const card = element("article", "codex-update-card");
      const header = element("div", "codex-update-header");
      const title = element("h3", "", `Codex CLI ${notice.version}`);
      const date = notice.publishedAt ? new Date(notice.publishedAt).toLocaleDateString("zh-CN", { timeZone: "Asia/Shanghai" }) : "";
      header.append(title, element("span", "", date));
      card.append(header);
      addSection(card, "新功能", notice.features, 3);
      addSection(card, "修复", notice.fixes, 2);
      addSection(card, "文档", notice.documentation, 1);
      addSection(card, "维护", notice.chores, 1);
      if (![notice.features, notice.fixes, notice.documentation, notice.chores].some((items) => items?.length)) {
        card.append(element("p", "", "官方未列出可提取的变更要点。"));
      }
      card.append(element("p", "codex-update-question", "要升级 Codex 吗？这些新功能需要加入 Agent Web 或单独启用吗？告诉我你的决定后再执行。"));
      const actions = element("div", "codex-update-actions");
      if (notice.url) {
        const link = element("a", "", "查看官方发布说明 ↗");
        link.href = notice.url;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        actions.append(link);
      }
      const later = element("button", "", "稍后再说");
      later.type = "button";
      later.addEventListener("click", () => dismiss(notice.version));
      actions.append(later);
      card.append(actions);
      container.append(card);
    }
  }

  async function refresh() {
    try {
      const response = await fetch("/api/codex-updates", { cache: "no-store" });
      if (!response.ok) return;
      const data = await response.json();
      notices = Array.isArray(data.items) ? data.items : [];
      render();
    } catch {
      // Keep the last successful notice list during a temporary network failure.
    }
  }

  openButton.addEventListener("click", () => {
    showHistory = true;
    render();
    document.querySelector("#nav-control-center")?.click();
    container.scrollIntoView({ behavior: "smooth", block: "start" });
  });
  window.addEventListener("focus", refresh);
  window.setInterval(refresh, 30 * 60 * 1000);
  refresh();
})();
