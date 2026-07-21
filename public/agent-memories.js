(function installAgentMemories(global) {
  const dialog = document.querySelector("#memory-dialog");
  const closeButton = document.querySelector("#memory-close");
  const refreshButton = document.querySelector("#memory-refresh");
  const statusElement = document.querySelector("#memory-status");
  const contextElement = document.querySelector("#memory-context");
  const contentElement = document.querySelector("#memory-content");
  const tabs = [...document.querySelectorAll("[data-memory-view]")];
  const renderer = global.AgentMarkdown?.createRenderer() || null;
  let activeView = "overview";
  let activeProject = "";
  let requestSequence = 0;

  if (!dialog) {
    global.AgentMemories = Object.freeze({ open() {} });
    return;
  }

  closeButton?.addEventListener("click", () => dialog.close());
  refreshButton?.addEventListener("click", () => void loadView());
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) dialog.close();
  });
  tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      activeView = tab.dataset.memoryView || "overview";
      syncTabs();
      void loadView();
    });
  });

  function open(options = {}) {
    activeProject = normalizeProject(options.project);
    activeView = options.view || "overview";
    syncTabs();
    renderContext();
    if (!dialog.open) dialog.showModal();
    void loadView();
  }

  async function loadView(source = "") {
    const sequence = ++requestSequence;
    contentElement.replaceChildren(message("正在读取 Codex 的本地记忆…", "loading"));
    refreshButton.disabled = true;
    try {
      const query = new URLSearchParams({ view: activeView });
      if (activeView === "detail" && activeProject) query.set("project", activeProject);
      if (source) query.set("source", source);
      const response = await fetch(`/api/memories?${query}`);
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "读取失败");
      if (sequence !== requestSequence) return;
      renderStatus(data.status || {});
      if (activeView === "sources") renderSources(data);
      else renderDocument(data);
    } catch (error) {
      if (sequence !== requestSequence) return;
      statusElement.textContent = "读取失败";
      statusElement.dataset.state = "error";
      contentElement.replaceChildren(message(error.message || "Codex 记忆暂时不可用。", "error"));
    } finally {
      if (sequence === requestSequence) refreshButton.disabled = false;
    }
  }

  function renderStatus(status) {
    const state = !status.enabled ? "未启用" : status.ready ? "已生成" : "后台整理中";
    statusElement.textContent = state;
    statusElement.dataset.state = !status.enabled ? "off" : status.ready ? "ready" : "working";
    statusElement.title = status.updatedAt
      ? `最近更新：${formatDate(status.updatedAt)}`
      : "完成并闲置一段时间的会话会被自动整理";
  }

  function renderContext() {
    const projectLabel = activeProject ? activeProject.split("/").filter(Boolean).at(-1) : "workspace";
    contextElement.textContent = activeView === "detail" ? `项目范围：${projectLabel}` : "全局范围";
  }

  function syncTabs() {
    tabs.forEach((tab) => {
      const active = tab.dataset.memoryView === activeView;
      tab.classList.toggle("active", active);
      tab.setAttribute("aria-selected", String(active));
    });
    renderContext();
  }

  function renderDocument(data) {
    const memoryDocument = data.document || {};
    const fragment = documentFragment();
    fragment.append(viewNote(activeView, data.status || {}, memoryDocument));
    if (!memoryDocument.content) {
      const pendingAvailable = activeView === "overview" && data.status?.documents?.pending?.available;
      fragment.append(
        message(
          pendingAvailable
            ? "原始候选已经生成，最终总览仍在合并。你可以先检查已抽取的内容。"
            : data.status?.enabled
              ? "还没有生成这部分记忆。Codex 会在符合条件的历史会话完成并闲置后，后台逐步整理。"
            : "Codex Memories 尚未启用。",
          "empty",
        ),
      );
      if (pendingAvailable) {
        const review = document.createElement("button");
        review.type = "button";
        review.className = "memory-review-action";
        review.textContent = "查看已抽取内容";
        review.addEventListener("click", () => {
          activeView = "pending";
          syncTabs();
          void loadView();
        });
        fragment.append(review);
      }
    } else {
      const article = document.createElement("article");
      article.className = "memory-document app-transcript-markdown";
      if (global.AgentMarkdown) global.AgentMarkdown.render(article, memoryDocument.content, renderer);
      else article.textContent = memoryDocument.content;
      fragment.append(article);
    }
    contentElement.replaceChildren(fragment);
  }

  function renderSources(data) {
    const fragment = documentFragment();
    fragment.append(viewNote("sources", data.status || {}, {}));
    if (data.selected?.content) {
      const back = document.createElement("button");
      back.type = "button";
      back.className = "memory-source-back";
      back.textContent = "← 返回来源列表";
      back.addEventListener("click", () => void loadView());
      const heading = document.createElement("h3");
      heading.className = "memory-source-title";
      heading.textContent = data.selected.name;
      const article = document.createElement("article");
      article.className = "memory-document app-transcript-markdown";
      if (global.AgentMarkdown) global.AgentMarkdown.render(article, data.selected.content, renderer);
      else article.textContent = data.selected.content;
      fragment.append(back, heading, article);
    } else if (data.sources?.length) {
      const list = document.createElement("div");
      list.className = "memory-source-list";
      for (const source of data.sources) {
        const button = document.createElement("button");
        button.type = "button";
        const name = document.createElement("strong");
        name.textContent = source.name;
        const meta = document.createElement("span");
        meta.textContent = `${formatBytes(source.bytes)} · ${formatDate(source.updatedAt)}`;
        button.append(name, meta);
        button.addEventListener("click", () => void loadView(source.name));
        list.append(button);
      }
      fragment.append(list);
    } else {
      fragment.append(message("还没有会话摘要来源。", "empty"));
    }
    contentElement.replaceChildren(fragment);
  }

  function viewNote(view, status, document) {
    const note = documentElement("aside", "memory-note");
    const copy = {
      overview: "类似 ChatGPT Overview：这里汇总跨工作与生活的稳定背景、偏好和近期主题。",
      detail: document.filtered
        ? "只显示能匹配当前项目名称或路径的工程与过程记忆；未匹配内容不会混入。"
        : "选择具体项目后，会按项目名称和路径筛选工程记忆。",
      pending: "这是 Codex 自动抽取的原始记忆，适合早期检查误判；它不是逐条审批队列，也不等于每一条都已生效。",
      sources: `会话摘要是记忆的证据层，目前共有 ${status.sourceCount || 0} 份。`,
    };
    note.textContent = copy[view] || status.scope || "";
    return note;
  }

  function message(text, tone) {
    const element = documentElement("p", `memory-message memory-message-${tone}`);
    element.textContent = text;
    return element;
  }

  function documentElement(tag, className) {
    const element = document.createElement(tag);
    element.className = className;
    return element;
  }

  function documentFragment() {
    return document.createDocumentFragment();
  }

  function normalizeProject(value) {
    const project = String(value || "").trim();
    return project === "." ? "" : project;
  }

  function formatDate(value) {
    const date = new Date(value);
    return Number.isNaN(date.getTime())
      ? "时间未知"
      : new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(date);
  }

  function formatBytes(value) {
    const bytes = Number(value || 0);
    return bytes >= 1024 ? `${(bytes / 1024).toFixed(bytes >= 10_240 ? 0 : 1)} KB` : `${bytes} B`;
  }

  global.AgentMemories = Object.freeze({ open });
})(globalThis);
