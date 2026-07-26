(function installAgentIntegrations(global) {
  const openButton = document.querySelector("#open-integrations");
  const dialog = document.querySelector("#integrations-dialog");
  const closeButton = document.querySelector("#integrations-close");
  const content = document.querySelector("#integrations-content");

  if (!openButton || !dialog || !content) return;

  openButton.addEventListener("click", open);
  closeButton?.addEventListener("click", () => dialog.close());
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) dialog.close();
  });

  function open() {
    if (!dialog.open) dialog.showModal();
    void load();
  }

  async function load() {
    content.replaceChildren(message("正在读取集成状态…"));
    try {
      const response = await fetch("/api/integrations", { cache: "no-store" });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "读取失败");
      render(Array.isArray(data.integrations) ? data.integrations : []);
    } catch (error) {
      content.replaceChildren(message(error.message || "集成状态暂时不可用。", "error"));
    }
  }

  function render(integrations) {
    content.replaceChildren();
    if (!integrations.length) {
      content.append(message("还没有可配置的集成。"));
      return;
    }
    for (const integration of integrations) content.append(integrationCard(integration));
  }

  function integrationCard(integration) {
    const card = element("article", "integration-card");
    card.dataset.integrationId = integration.id;

    const header = element("header", "integration-card-header");
    const title = element("div", "integration-card-title");
    const name = document.createElement("strong");
    name.textContent = integration.name;
    const description = document.createElement("p");
    description.textContent = integration.description;
    title.append(name, description);

    const status = element("span", "integration-status");
    renderStatus(status, integration.status);
    header.append(title, status);

    const form = element("form", "integration-form");
    form.autocomplete = "off";
    for (const field of integration.fields || []) form.append(secretField(field, integration.status));

    const metadata = element("div", "integration-meta");
    metadata.textContent = integration.status?.verifiedAt
      ? `最近验证：${formatDate(integration.status.verifiedAt)}`
      : "保存前会先连接服务商验证。";

    const feedback = element("p", "integration-feedback");
    feedback.setAttribute("aria-live", "polite");

    const actions = element("div", "integration-actions");
    const save = element("button", "primary");
    save.type = "submit";
    save.textContent = integration.status?.configured ? "替换并验证" : "保存并验证";
    actions.append(save);

    if (integration.docsUrl) {
      const docs = document.createElement("a");
      docs.href = integration.docsUrl;
      docs.target = "_blank";
      docs.rel = "noreferrer";
      docs.textContent = "申请 Key";
      actions.append(docs);
    }

    if (integration.status?.configured) {
      const remove = element("button", "integration-delete");
      remove.type = "button";
      remove.textContent = "删除";
      remove.addEventListener("click", () => removeIntegration(integration, card, feedback));
      actions.append(remove);
    }

    form.append(metadata, feedback, actions);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      void saveIntegration(integration, form, card, feedback);
    });
    card.append(header, form);
    return card;
  }

  function secretField(field, status) {
    const label = element("label", "integration-field");
    const name = document.createElement("span");
    name.textContent = field.label;
    const input = document.createElement("input");
    input.type = "password";
    input.name = field.id;
    input.required = true;
    input.minLength = 16;
    input.maxLength = 128;
    input.autocomplete = "new-password";
    input.spellcheck = false;
    input.placeholder = status?.configured ? "输入完整的新值以替换" : field.placeholder;
    const help = document.createElement("small");
    help.textContent = field.help;
    label.append(name, input, help);
    return label;
  }

  async function saveIntegration(integration, form, card, feedback) {
    const values = Object.fromEntries(new FormData(form));
    const controls = [...form.querySelectorAll("input, button")];
    setBusy(controls, true);
    setFeedback(feedback, "正在验证并保存…");
    try {
      const response = await fetch(`/api/integrations/${encodeURIComponent(integration.id)}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ values }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "保存失败");
      form.reset();
      replaceCard(card, data.integration);
    } catch (error) {
      setFeedback(feedback, error.message || "保存失败。", "error");
      setBusy(controls, false);
    }
  }

  async function removeIntegration(integration, card, feedback) {
    const confirmed = global.confirm(`删除 ${integration.name} 的凭证？之后新会话将无法使用这个集成。`);
    if (!confirmed) return;
    const controls = [...card.querySelectorAll("input, button")];
    setBusy(controls, true);
    setFeedback(feedback, "正在删除…");
    try {
      const response = await fetch(`/api/integrations/${encodeURIComponent(integration.id)}`, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirm: true }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "删除失败");
      await load();
    } catch (error) {
      setFeedback(feedback, error.message || "删除失败。", "error");
      setBusy(controls, false);
    }
  }

  function replaceCard(card, integration) {
    const replacement = integrationCard(integration);
    const feedback = replacement.querySelector(".integration-feedback");
    setFeedback(feedback, "已保存。新建或重新连接 Codex 会话后生效。", "success");
    card.replaceWith(replacement);
  }

  function renderStatus(element, status = {}) {
    element.dataset.state = status.configured ? "ready" : "off";
    element.textContent = status.configured ? "已配置" : "未配置";
  }

  function setBusy(controls, busy) {
    for (const control of controls) control.disabled = busy;
  }

  function setFeedback(element, text, state = "") {
    element.textContent = text;
    if (state) element.dataset.state = state;
    else delete element.dataset.state;
  }

  function message(text, state = "") {
    const node = element("p", "integrations-message");
    node.textContent = text;
    if (state) node.dataset.state = state;
    return node;
  }

  function element(tag, className) {
    const node = document.createElement(tag);
    node.className = className;
    return node;
  }

  function formatDate(value) {
    const date = new Date(value);
    return Number.isNaN(date.getTime())
      ? "时间未知"
      : new Intl.DateTimeFormat("zh-CN", {
          month: "numeric",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        }).format(date);
  }

  global.AgentIntegrations = Object.freeze({ open, refresh: load });
})(globalThis);
