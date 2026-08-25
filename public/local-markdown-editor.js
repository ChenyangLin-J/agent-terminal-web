(function installLocalMarkdownEditor(global) {
  const editorView = document.querySelector("[data-markdown-editor]");
  const editor = document.querySelector("#markdown-source");
  const saveButton = document.querySelector("#markdown-save");
  const cancelLink = document.querySelector("#markdown-cancel");
  const status = document.querySelector("#markdown-editor-status");
  if (!editorView || !editor || !saveButton || !status) return;

  let version = editorView.dataset.version || "";
  let dirty = false;
  let busy = false;

  editor.addEventListener("input", () => {
    dirty = true;
    setStatus("尚未保存");
  });
  saveButton.addEventListener("click", () => void save());
  cancelLink?.addEventListener("click", (event) => {
    if (!dirty || global.confirm("放弃尚未保存的修改？")) return;
    event.preventDefault();
  });
  global.addEventListener("beforeunload", (event) => {
    if (!dirty || busy) return;
    event.preventDefault();
    event.returnValue = "";
  });
  global.addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
      event.preventDefault();
      void save();
    }
  });

  async function save() {
    if (busy || !dirty) return;
    busy = true;
    saveButton.disabled = true;
    saveButton.textContent = "保存中…";
    setStatus("正在保存…");
    try {
      const response = await fetch(editorView.dataset.saveHref, {
        method: "PUT",
        headers: {
          "content-type": "text/plain; charset=utf-8",
          "if-match": `"${version}"`,
        },
        body: editor.value,
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "保存失败，请稍后重试。");
      version = data.version || version;
      dirty = false;
      setStatus("已保存，正在返回阅读页…", "success");
      global.location.assign(data.href || editorView.dataset.viewHref);
    } catch (error) {
      setStatus(error.message || "保存失败，请稍后重试。", "error");
      busy = false;
      saveButton.disabled = false;
      saveButton.textContent = "保存";
    }
  }

  function setStatus(message, state = "") {
    status.textContent = message;
    if (state) status.dataset.state = state;
    else delete status.dataset.state;
  }
})(globalThis);
