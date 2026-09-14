(function installAgentMemories(global) {
  const dialog = document.querySelector("#memory-dialog");
  const closeButton = document.querySelector("#memory-close");
  const refreshButton = document.querySelector("#memory-refresh");
  const statusElement = document.querySelector("#memory-status");
  const contextElement = document.querySelector("#memory-context");
  const contentElement = document.querySelector("#memory-content");
  const projectRoutingElement = document.querySelector("#memory-project-routing");
  const projectRoutingNote = document.querySelector("#memory-project-routing-note");
  const projectAutoButton = document.querySelector("#memory-project-auto");
  const projectOptionsElement = document.querySelector("#memory-project-options");
  const tabs = [...document.querySelectorAll("[data-memory-view]")];
  const triggerButtons = [...document.querySelectorAll(".memory-trigger")];
  const renderer = global.AgentMarkdown?.createRenderer() || null;
  let activeView = "overview";
  let activeProjects = [];
  let routingMode = "auto";
  let routingSource = "global";
  let routingEnabled = false;
  let projectChangeHandler = null;
  let projectCatalog = [];
  let requestSequence = 0;
  let actionFeedback = null;

  if (!dialog) {
    global.AgentMemories = Object.freeze({ open() {} });
    return;
  }

  closeButton?.addEventListener("click", () => dialog.close());
  refreshButton?.addEventListener("click", () => {
    actionFeedback = null;
    void loadView();
  });
  projectAutoButton?.addEventListener("click", () => {
    routingMode = "auto";
    routingSource = activeProjects.length ? "retained" : "global";
    renderProjectRouting();
    projectChangeHandler?.({ mode: routingMode, projects: activeProjects });
  });
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) dialog.close();
  });
  tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      actionFeedback = null;
      activeView = normalizeManagerView(tab.dataset.memoryView);
      syncTabs();
      void loadView();
    });
  });
  void refreshStatus();

  function open(options = {}) {
    actionFeedback = null;
    activeProjects = Object.hasOwn(options, "projects")
      ? normalizeProjects(options.projects)
      : normalizeProjects([options.project]);
    routingMode = options.mode === "manual" ? "manual" : "auto";
    routingSource = normalizeRoutingSource(options.source);
    routingEnabled = typeof options.onProjectChange === "function";
    projectChangeHandler = routingEnabled ? options.onProjectChange : null;
    projectRoutingElement?.classList.add("hidden");
    activeView = normalizeManagerView(options.view);
    syncTabs();
    renderProjectRouting();
    renderContext();
    if (!dialog.open) dialog.showModal();
    void loadView();
  }

  async function loadView(source = "") {
    const sequence = ++requestSequence;
    contentElement.replaceChildren(message("正在读取个人记忆…", "loading"));
    refreshButton.disabled = true;
    try {
      const query = new URLSearchParams({ view: activeView });
      if (activeView === "detail" && activeProjects.length) {
        query.set("project", activeProjects[0]);
        query.set("projects", JSON.stringify(activeProjects));
      }
      if (source) query.set("source", source);
      const response = await fetch(`/api/memories?${query}`);
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "读取失败");
      if (sequence !== requestSequence) return;
      projectCatalog = Array.isArray(data.personal?.projectCatalog) ? data.personal.projectCatalog : [];
      renderProjectRouting();
      renderStatus({ ...(data.status || {}), personal: data.personal, knowledge: data.knowledge });
      renderDocument(data);
    } catch (error) {
      if (sequence !== requestSequence) return;
      statusElement.textContent = "读取失败";
      statusElement.dataset.state = "error";
      renderTriggerStatus({ error: true });
      contentElement.replaceChildren(message(error.message || "个人记忆暂时不可用。", "error"));
    } finally {
      if (sequence === requestSequence) refreshButton.disabled = false;
    }
  }

  function renderStatus(status) {
    const pendingCount = Number(status.knowledge?.counts?.pending ?? status.personal?.counts?.pending ?? 0);
    const runtime = status.personal?.runtime || {};
    const state = pendingCount
      ? `待确认 ${pendingCount}`
      : runtime.status === "error"
        ? "自动整理异常"
        : runtime.status === "running"
          ? "正在自动整理"
          : runtime.initializedAt
            ? "自动检查中"
            : "尚未启动";
    statusElement.textContent = state;
    statusElement.dataset.state = pendingCount || runtime.status === "running" ? "working" : runtime.status === "error" ? "error" : runtime.initializedAt ? "ready" : "off";
    statusElement.title = runtime.lastRunAt
      ? `最近检查：${formatDate(runtime.lastRunAt)}`
      : "Turn 完成后会被自动整理";
    renderTriggerStatus({ status, pendingCount, runtime });
  }

  async function refreshStatus() {
    try {
      const response = await fetch("/api/memories/status");
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "读取失败");
      renderTriggerStatus({
        status: data,
        pendingCount: Number(data.knowledge?.counts?.pending ?? data.personal?.counts?.pending ?? 0),
        runtime: data.personal?.runtime || {},
      });
    } catch {
      renderTriggerStatus({ error: true });
    }
  }

  function renderTriggerStatus({ pendingCount = 0, runtime = {}, error = false } = {}) {
    const state = error || runtime.status === "error"
      ? { key: "error", text: "异常", title: "个人记忆自动整理异常；点击查看详情" }
      : pendingCount
        ? { key: "working", text: `待确认 ${pendingCount}`, title: `有 ${pendingCount} 条个人记忆需要确认` }
        : runtime.status === "running"
          ? { key: "working", text: "整理中", title: "个人记忆正在后台自动整理" }
          : runtime.initializedAt
            ? { key: "ready", text: "自动整理", title: "后台自动沉淀明确的个人记忆；点击管理和追溯" }
            : { key: "off", text: "未启动", title: "个人记忆后台尚未启动" };
    for (const button of triggerButtons) {
      button.dataset.memoryState = state.key;
      const value = button.querySelector("[data-memory-trigger-status]");
      if (value) {
        value.textContent = state.text;
        button.title = state.title;
      } else {
        button.dataset.memoryRuntimeTitle = state.title;
      }
    }
  }

  function renderContext() {
    const labels = {
      overview: "Core、Now 与 Topics 文档",
      detail: "各项目 AGENTS.md",
      changes: "待确认置顶 · 自动变更可追溯",
    };
    contextElement.textContent = labels[activeView] || "个人记忆";
  }

  function renderProjectRouting() {
    if (!routingEnabled || !projectRoutingElement) return;
    const sourceLabels = {
      manual: "手动选择；从下一条消息生效，后续不会自动切换",
      prompt: "自动：由当前消息识别",
      retained: "自动：沿用本 Session 上一轮",
      cwd: "自动：由具体项目目录识别",
      title: "自动：由 Session 标题识别",
      global: "自动：暂未识别项目，默认读取 Core 与 Now",
    };
    projectRoutingNote.textContent = `${sourceLabels[routingMode === "manual" ? "manual" : routingSource] || sourceLabels.global}；workspace 只负责文件范围`;
    projectAutoButton.disabled = routingMode === "auto";
    projectOptionsElement.replaceChildren();
    if (!projectCatalog.length) {
      projectOptionsElement.append(message("还没有可选的项目记忆。", "empty"));
      return;
    }
    const selected = new Set(activeProjects);
    for (const item of projectCatalog) {
      const project = normalizeProject(item.project);
      if (!project) continue;
      const label = documentElement("label", "memory-project-option");
      const input = document.createElement("input");
      input.type = "checkbox";
      input.checked = selected.has(project);
      input.addEventListener("change", () => {
        const next = new Set(activeProjects);
        if (input.checked) next.add(project);
        else next.delete(project);
        activeProjects = [...next];
        routingMode = "manual";
        routingSource = "manual";
        renderContext();
        renderProjectRouting();
        projectChangeHandler?.({ mode: routingMode, projects: activeProjects });
        if (activeView === "detail") void loadView();
      });
      const text = document.createElement("span");
      text.textContent = `${shortProjectName(project)} · ${Number(item.count || 0)}`;
      text.title = project;
      label.append(input, text);
      projectOptionsElement.append(label);
    }
  }

  function updateSessionRouting(options = {}) {
    if (!routingEnabled) return;
    activeProjects = normalizeProjects(options.projects);
    routingMode = options.mode === "manual" ? "manual" : "auto";
    routingSource = normalizeRoutingSource(options.source);
    renderContext();
    renderProjectRouting();
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
    const fragment = documentFragment();
    fragment.append(viewNote(activeView));
    if (actionFeedback) fragment.append(actionFeedbackElement(actionFeedback));
    if (activeView === "overview") {
      if (data.personal?.runtime) fragment.append(renderAutomationStatus(data.personal.runtime));
      const documents = data.personal?.documents || [];
      if (documents.length) fragment.append(renderPersonalDocuments(documents));
      else fragment.append(message("还没有可展示的个人记忆 Markdown 文档。", "empty"));
    } else if (activeView === "detail") {
      const documents = data.projectRules?.documents || [];
      if (documents.length) fragment.append(renderProjectRuleDocuments(documents));
      else fragment.append(message("workspace 一级项目目录中还没有可展示的 AGENTS.md。", "empty"));
    } else {
      const knowledgeChanges = data.knowledge?.changes || [];
      if (knowledgeChanges.length) fragment.append(renderKnowledgeChanges(knowledgeChanges));
      else fragment.append(message("还没有记忆、项目规则或 Skill 的变更记录。", "empty"));
    }
    contentElement.replaceChildren(fragment);
  }

  function renderPersonalDocuments(documents) {
    const section = documentElement("section", "memory-document-list");
    for (const document of documents) {
      const label = document.kind === "core"
        ? `Core · ${document.fileName}`
        : document.kind === "now"
          ? `Now · ${document.fileName}`
          : `Topic · ${document.title || document.fileName}`;
      section.append(markdownDocumentDetails(label, document.content, document.kind !== "topic"));
    }
    return section;
  }

  function renderProjectRuleDocuments(documents) {
    const section = documentElement("section", "memory-document-list");
    const expand = documents.length <= 2;
    for (const document of documents) {
      section.append(markdownDocumentDetails(`${document.project} · AGENTS.md`, document.content, expand));
    }
    return section;
  }

  function markdownDocumentDetails(label, content, open) {
    const details = documentElement("details", "memory-markdown-file");
    details.open = open;
    const summary = document.createElement("summary");
    summary.textContent = label;
    const article = documentElement("article", "memory-document app-transcript-markdown");
    if (global.AgentMarkdown) global.AgentMarkdown.render(article, content, renderer);
    else article.textContent = content;
    details.append(summary, article);
    return details;
  }

  function renderKnowledgeChanges(changes) {
    const section = documentElement("section", "memory-entry-list memory-change-list");
    let currentGroup = "";
    for (const change of changes) {
      const group = change.status === "pending" ? "待审批" : "历史记录";
      if (group !== currentGroup) {
        const heading = documentElement("h3", "memory-change-group-title");
        heading.textContent = group;
        section.append(heading);
        currentGroup = group;
      }
      const card = documentElement("article", "memory-entry-card memory-change-card");
      const header = documentElement("header", "memory-entry-meta");
      const target = documentElement("strong", "memory-entry-category");
      target.textContent = targetTypeLabel(change.targetType);
      const action = documentElement("span", "memory-entry-scope");
      action.textContent = actionLabel(change.action);
      const status = documentElement("span", `memory-change-status memory-change-status-${change.status}`);
      status.textContent = statusLabel(change.status, change.targetType);
      header.append(target, action, status);

      const path = documentElement("p", "memory-change-path");
      path.textContent = change.targetPath;
      const unresolvedTarget = change.targetType === "project_rule" && String(change.targetPath || "").startsWith("project:");
      const targetWarning = unresolvedTarget ? documentElement("p", "memory-change-target-warning") : null;
      if (targetWarning) {
        targetWarning.textContent = "项目规则只允许写入 workspace 一级子目录的 AGENTS.md；这条旧候选没有有效目标，不能应用。";
      }
      const diff = documentElement("div", "memory-change-diff");
      if (change.before !== null) diff.append(diffValue("删除 / 原内容", change.before, "before"));
      if (change.after !== null) {
        const afterLabel = change.targetType === "native_review" ? "检查结论" : change.before === null ? "新增" : "改为";
        diff.append(diffValue(afterLabel, change.after, "after"));
      }

      const rationale = documentElement("div", "memory-change-rationale");
      const rationaleTitle = documentElement("strong", "memory-change-subtitle");
      rationaleTitle.textContent = "为什么这样改";
      const rationaleText = documentElement("p", "memory-entry-text");
      rationaleText.textContent = change.rationale || "没有记录修改原因。";
      rationale.append(rationaleTitle, rationaleText);

      const review = change.reviewReason ? documentElement("div", "memory-change-rationale memory-change-review") : null;
      if (review) {
        const reviewTitle = documentElement("strong", "memory-change-subtitle");
        reviewTitle.textContent = "审批反馈";
        const reviewText = documentElement("p", "memory-entry-text");
        reviewText.textContent = change.reviewReason;
        review.append(reviewTitle, reviewText);
      }

      const evidence = documentElement("details", "memory-entry-evidence");
      const evidenceTitle = document.createElement("summary");
      evidenceTitle.textContent = `来源证据 ${change.evidence?.length || 0} · 置信度 ${Math.round(Number(change.confidence || 0) * 100)}%`;
      evidence.append(evidenceTitle);
      for (const item of change.evidence || []) {
        const row = documentElement("p", "memory-entry-source");
        row.textContent = item.quote ? `${item.title || "未命名 Session"}：${item.quote}` : item.title || item.threadId;
        evidence.append(row);
      }

      const actions = documentElement("div", "memory-entry-actions");
      if (change.status === "pending") {
        if (change.targetType !== "skill") {
          actions.append(actionButton("批准并应用", "primary", () => mutateKnowledgeChange(change, "approve")));
          actions.append(actionButton("修改后再审", "secondary", () => editKnowledgeChange(change, card)));
        } else {
          actions.append(actionButton("批准候选", "primary", () => mutateKnowledgeChange(change, "approve")));
          actions.append(actionButton("修改后再审", "secondary", () => editKnowledgeChange(change, card)));
        }
        actions.append(actionButton("拒绝", "danger", () => confirmKnowledgeChange(change, "reject", card)));
      } else if (change.targetType !== "native_review" && ["auto_applied", "approved"].includes(change.status)) {
        actions.append(actionButton("撤回", "danger", () => confirmKnowledgeChange(change, "revert", card)));
      }
      card.append(header, path);
      if (targetWarning) card.append(targetWarning);
      card.append(diff, rationale);
      if (review) card.append(review);
      card.append(evidence, actions);
      section.append(card);
    }
    return section;
  }

  function diffValue(label, value, tone) {
    const item = documentElement("div", `memory-change-value memory-change-value-${tone}`);
    const title = documentElement("strong", "memory-change-subtitle");
    title.textContent = label;
    const content = documentElement("p", "memory-entry-text");
    content.textContent = changeValueText(value);
    item.append(title, content);
    return item;
  }

  function changeValueText(value) {
    if (typeof value === "string") return value;
    if (value?.text) return value.text;
    if (value?.summary) {
      const workflow = Array.isArray(value.workflow) && value.workflow.length ? `\n流程：${value.workflow.join(" → ")}` : "";
      return `${value.name || "Skill"}：${value.summary}${value.trigger ? `\n触发：${value.trigger}` : ""}${workflow}${value.verification ? `\n验证：${value.verification}` : ""}`;
    }
    return JSON.stringify(value, null, 2);
  }

  function editKnowledgeChange(change, card) {
    const current = changeValueText(change.after);
    showInlineEditor(card, {
      value: current,
      saveLabel: "保存修改",
      emptyMessage: "修改后的内容不能为空。",
      onSave: (next) => mutateKnowledgeChange(change, "edit", { after: next }),
    });
  }

  function confirmKnowledgeChange(change, action, card) {
    const options = action === "reject"
      ? { message: "拒绝后不会应用这条变更。", confirmLabel: "确认拒绝" }
      : { message: "撤回会恢复变更前的内容；如果目标后来被修改，系统会停止并标记冲突。", confirmLabel: "确认撤回" };
    showInlineConfirmation(card, {
      ...options,
      onConfirm: () => mutateKnowledgeChange(change, action),
    });
  }

  async function mutateKnowledgeChange(change, action, extra = {}) {
    setActionButtonsDisabled(true);
    showActionFeedback("正在处理这条变更…", "loading");
    try {
      const response = await fetch(`/api/knowledge-changes/${encodeURIComponent(change.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, ...extra }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "操作失败");
      actionFeedback = { tone: "success", text: knowledgeActionResult(action) };
      await loadView();
      void refreshStatus();
    } catch (error) {
      actionFeedback = {
        tone: "error",
        text: `没有改写目标：${error.message || "知识变更操作失败。"}`,
      };
      await loadView();
      void refreshStatus();
    } finally {
      setActionButtonsDisabled(false);
    }
  }

  function knowledgeActionResult(action) {
    return {
      approve: "已批准并应用。",
      reject: "已拒绝，没有写入目标。",
      revert: "已撤回这条变更。",
      edit: "修改已保存，仍待审批。",
    }[action] || "操作已完成。";
  }

  function showActionFeedback(text, tone) {
    actionFeedback = { text, tone };
    contentElement.querySelector(".memory-action-feedback")?.remove();
    contentElement.prepend(actionFeedbackElement(actionFeedback));
  }

  function actionFeedbackElement(feedback) {
    const element = message(feedback.text, feedback.tone);
    element.classList.add("memory-action-feedback");
    element.setAttribute("role", feedback.tone === "error" ? "alert" : "status");
    return element;
  }

  function setActionButtonsDisabled(disabled) {
    for (const button of contentElement.querySelectorAll(".memory-entry-action")) button.disabled = disabled;
  }

  function targetTypeLabel(value) {
    return { personal_memory: "个人记忆", project_rule: "项目规则", skill: "Skill 候选", native_review: "Codex 原生记忆" }[value] || "知识变更";
  }

  function actionLabel(value) {
    return { create: "新增", update: "修改", delete: "删除", review: "检查" }[value] || value;
  }

  function statusLabel(value, targetType = "") {
    if (targetType === "skill" && value === "approved") return "已批准，待创建";
    if (targetType === "native_review" && value === "approved") return "已检查";
    return {
      pending: "未应用",
      auto_applied: "已自动应用",
      approved: "已批准",
      rejected: "已拒绝",
      reverted: "已撤回",
      conflict: "有冲突",
      superseded: "已合并",
    }[value] || value;
  }

  function renderAutomationStatus(runtime) {
    const section = documentElement("aside", "memory-automation-status");
    const today = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());
    const usage = runtime.usage?.days?.[today] || {};
    const totalTokens = Number(usage.inputTokens || 0) + Number(usage.outputTokens || 0);
    const state = documentElement("strong", "memory-automation-title");
    state.textContent = runtime.status === "running" ? "后台正在整理" : runtime.status === "error" ? "后台整理遇到问题，会自动重试" : "Turn 完成 1 分钟后整理 · Home 语音与原生记忆变化后检查 · 每 10 分钟兜底";
    const detail = documentElement("span", "memory-automation-detail");
    const lastRun = runtime.lastRun || {};
    const scanned = Number(lastRun.scanned || 0);
    const eligible = Number(lastRun.eligible || 0);
    const processed = Number(lastRun.processed || 0);
    const nativeReviewed = Number(lastRun.nativeReviewed || 0);
    const homeCapturesReviewed = Number(lastRun.homeCapturesReviewed || 0);
    const runSummary = eligible === 0
      ? `本轮扫描 ${scanned} 个 Session，没有可整理的已完成内容`
      : `本轮扫描 ${scanned} 个 Session，可整理 ${eligible} 个，已整理 ${processed} 个`;
    const nativeSummary = nativeReviewed ? ` · 原生记忆已对照 ${nativeReviewed} 次` : "";
    const homeSummary = homeCapturesReviewed ? ` · Home 语音已检查 ${homeCapturesReviewed} 条` : "";
    detail.textContent = `最近检查 ${runtime.lastRunAt ? formatDate(runtime.lastRunAt) : "尚未运行"} · 今天模型整理 ${Number(usage.runs || 0)} 次 / ${formatTokenCount(totalTokens)} · ${runSummary}${nativeSummary}${homeSummary}`;
    section.append(state, detail);
    if (runtime.lastError) {
      const error = documentElement("span", "memory-automation-error");
      error.textContent = runtime.lastError;
      section.append(error);
    }
    return section;
  }

  function actionButton(label, tone, handler) {
    const button = documentElement("button", `memory-entry-action memory-entry-action-${tone}`);
    button.type = "button";
    button.textContent = label;
    button.addEventListener("click", handler);
    return button;
  }

  function showInlineEditor(card, options) {
    clearInlinePanel(card);
    const panel = documentElement("section", "memory-inline-panel memory-inline-editor");
    const textarea = document.createElement("textarea");
    textarea.className = "memory-inline-textarea";
    textarea.value = options.value;
    textarea.rows = 5;
    const validation = documentElement("p", "memory-inline-validation");
    validation.hidden = true;
    const actions = documentElement("div", "memory-inline-actions");
    const save = actionButton(options.saveLabel, "primary", async () => {
      const next = textarea.value.trim();
      if (!next) {
        validation.textContent = options.emptyMessage;
        validation.hidden = false;
        textarea.focus();
        return;
      }
      if (next === options.value.trim()) {
        panel.remove();
        return;
      }
      await options.onSave(next);
    });
    const cancel = actionButton("取消", "secondary", () => panel.remove());
    actions.append(save, cancel);
    panel.append(textarea, validation, actions);
    insertInlinePanel(card, panel);
    textarea.focus();
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
  }

  function showInlineConfirmation(card, options) {
    clearInlinePanel(card);
    const panel = documentElement("section", "memory-inline-panel memory-inline-confirmation");
    const message = documentElement("p", "memory-inline-message");
    message.textContent = options.message;
    const actions = documentElement("div", "memory-inline-actions");
    actions.append(
      actionButton(options.confirmLabel, "danger", options.onConfirm),
      actionButton("取消", "secondary", () => panel.remove()),
    );
    panel.append(message, actions);
    insertInlinePanel(card, panel);
  }

  function insertInlinePanel(card, panel) {
    const actions = card.querySelector(":scope > .memory-entry-actions");
    if (actions) actions.before(panel);
    else card.append(panel);
  }

  function clearInlinePanel(card) {
    card.querySelector(":scope > .memory-inline-panel")?.remove();
  }

  function viewNote(view) {
    const note = documentElement("aside", "memory-note");
    const copy = {
      overview: "这里按 Markdown 文档展示 Obsidian 中的 Core、Now 与 Topics。明确、低风险的个人记忆会自动沉淀；其他候选等待确认。",
      detail: "这里直接展示 workspace 一级项目目录中的 AGENTS.md；项目事实和产品需求仍应留在项目文档、代码或测试中。",
      changes: "待确认变更置顶，自动应用与已处理记录接在后面；每条都保留原因与来源证据，并可在安全时撤回。",
    };
    note.textContent = copy[view] || "";
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

  function normalizeManagerView(value) {
    if (value === "detail") return "detail";
    if (["changes", "pending", "sources"].includes(value)) return "changes";
    return "overview";
  }

  function normalizeProjects(value) {
    return [...new Set((Array.isArray(value) ? value : []).map(normalizeProject).filter(Boolean))];
  }

  function normalizeRoutingSource(value) {
    return ["manual", "prompt", "retained", "cwd", "title", "global"].includes(value) ? value : "global";
  }

  function shortProjectName(value) {
    return normalizeProject(value).split("/").filter(Boolean).at(-1) || "项目";
  }

  function formatDate(value) {
    const date = new Date(value);
    return Number.isNaN(date.getTime())
      ? "时间未知"
      : new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(date);
  }

  function formatTokenCount(value) {
    const count = Number(value || 0);
    if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M tokens`;
    if (count >= 1_000) return `${Math.round(count / 1_000)}K tokens`;
    return `${count} tokens`;
  }

  global.AgentMemories = Object.freeze({ open, refreshStatus, updateSessionRouting });
})(globalThis);
