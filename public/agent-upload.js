(function () {
  function createUploadController({
    attachButton,
    fileInput,
    composer,
    attachmentsHost,
    setUploadStatus,
    redirectToLogin,
  }) {
    const maxPendingAttachments = 5;
    let pendingAttachments = [];

    return {
      install,
      uploadFiles,
      getAttachments,
      clearAttachments,
      restoreAttachments,
    };

    function install() {
      attachButton.addEventListener("click", () => fileInput.click());
      fileInput.addEventListener("change", async () => {
        await uploadFiles(fileInput.files);
        fileInput.value = "";
      });
      installComposerDragUpload();
    }

    async function uploadFiles(fileList) {
      const files = [...(fileList || [])];
      if (!files.length) return;

      const form = new FormData();
      for (const file of files) form.append("files", file);

      setUploading(true);
      const progress = createUploadProgress(files);
      progress.start();

      try {
        const response = await uploadForm(form, progress);

        if (response.status === 401) {
          redirectToLogin();
          return;
        }

        const data = response.data;
        if (!response.ok) throw new Error(data.error || "Upload failed.");

        addUploadedFiles(data.files || []);
        setUploadStatus(`Attached ${(data.files || []).length} file${(data.files || []).length === 1 ? "" : "s"}.`, {
          clear: true,
        });
      } catch (error) {
        setUploadStatus(error.message || "Upload failed.");
      } finally {
        progress.stop();
        setUploading(false);
      }
    }

    function uploadForm(form, progress) {
      return new Promise((resolve, reject) => {
        const request = new XMLHttpRequest();
        request.open("POST", "/api/uploads");
        request.upload.addEventListener("progress", progress.update);
        request.upload.addEventListener("load", progress.sent);
        request.addEventListener("load", () => {
          let data = {};
          try {
            data = JSON.parse(request.responseText || "{}");
          } catch {
            data = {};
          }
          resolve({
            status: request.status,
            ok: request.status >= 200 && request.status < 300,
            data,
          });
        });
        request.addEventListener("error", () => reject(new Error("Upload failed. Check the connection.")));
        request.addEventListener("abort", () => reject(new Error("Upload cancelled.")));
        request.send(form);
      });
    }

    function createUploadProgress(files) {
      const expectedTotal = files.reduce((sum, file) => sum + (Number(file.size) || 0), 0);
      let startedAt = 0;
      let lastProgressAt = 0;
      let loaded = 0;
      let total = expectedTotal;
      let speed = 0;
      let timer = null;
      let uploadSent = false;

      return {
        start,
        update,
        sent,
        stop,
      };

      function start() {
        startedAt = performance.now();
        lastProgressAt = startedAt;
        render();
        timer = window.setInterval(render, 500);
      }

      function update(event) {
        const now = performance.now();
        loaded = event.loaded;
        if (event.lengthComputable && event.total) total = event.total;
        const elapsedSeconds = Math.max((now - startedAt) / 1000, 0.001);
        speed = loaded / elapsedSeconds;
        lastProgressAt = now;
        render();
      }

      function sent() {
        uploadSent = true;
        if (total) loaded = total;
        render();
      }

      function stop() {
        window.clearInterval(timer);
      }

      function render() {
        if (uploadSent) {
          setUploadStatus("Uploaded 100% · processing...");
          return;
        }

        const now = performance.now();
        const percent = total ? Math.min(100, Math.round((loaded / total) * 100)) : null;
        const amount = total ? `${formatBytes(loaded)} / ${formatBytes(total)}` : formatBytes(loaded);
        const idle = now - lastProgressAt >= 3000;
        const activity = idle ? "waiting for network" : speed > 0 ? `${formatBytes(speed)}/s` : "starting...";
        setUploadStatus(`Uploading${percent === null ? "" : ` ${percent}%`} · ${amount} · ${activity}`);
      }
    }

    function formatBytes(bytes) {
      if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
      const units = ["B", "KB", "MB", "GB"];
      const unitIndex = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
      const value = bytes / 1024 ** unitIndex;
      const digits = value >= 100 || unitIndex === 0 ? 0 : value >= 10 ? 1 : 2;
      return `${value.toFixed(digits)} ${units[unitIndex]}`;
    }

    function installComposerDragUpload() {
      if (!composer) return;

      composer.addEventListener("dragenter", (event) => {
        if (!hasDraggedFiles(event)) return;
        event.preventDefault();
        composer.classList.add("drag-over");
      });

      composer.addEventListener("dragover", (event) => {
        if (!hasDraggedFiles(event)) return;
        event.preventDefault();
        composer.classList.add("drag-over");
      });

      composer.addEventListener("dragleave", (event) => {
        if (event.relatedTarget && composer.contains(event.relatedTarget)) return;
        composer.classList.remove("drag-over");
      });

      composer.addEventListener("drop", (event) => {
        if (!hasDraggedFiles(event)) return;
        event.preventDefault();
        composer.classList.remove("drag-over");
        uploadFiles(event.dataTransfer.files);
      });
    }

    function hasDraggedFiles(event) {
      return [...(event.dataTransfer?.types || [])].includes("Files");
    }

    function addUploadedFiles(files) {
      const knownPaths = new Set(pendingAttachments.map((file) => file.path));
      const uploadedFiles = files.filter((file) => file?.path && !knownPaths.has(file.path));
      const available = Math.max(0, maxPendingAttachments - pendingAttachments.length);
      pendingAttachments = [...pendingAttachments, ...uploadedFiles.slice(0, available)];
      renderAttachments();
      if (uploadedFiles.length > available) {
        setUploadStatus(`最多同时发送 ${maxPendingAttachments} 个附件，其余文件未加入。`);
      }
    }

    function getAttachments() {
      return pendingAttachments.map((file) => ({ ...file }));
    }

    function clearAttachments() {
      pendingAttachments = [];
      renderAttachments();
    }

    function restoreAttachments(files) {
      const knownPaths = new Set(pendingAttachments.map((file) => file.path));
      const restored = (Array.isArray(files) ? files : []).filter((file) => file?.path && !knownPaths.has(file.path));
      pendingAttachments = [...pendingAttachments, ...restored].slice(0, maxPendingAttachments);
      renderAttachments();
    }

    function renderAttachments() {
      if (!attachmentsHost) return;
      attachmentsHost.replaceChildren(...pendingAttachments.map(createAttachmentItem));
      attachmentsHost.classList.toggle("hidden", !pendingAttachments.length);
    }

    function createAttachmentItem(file) {
      const item = document.createElement("div");
      item.className = "composer-attachment";

      const preview = document.createElement(file.mime?.startsWith("image/") ? "img" : "span");
      preview.className = "composer-attachment-preview";
      if (preview instanceof HTMLImageElement) {
        preview.src = `/open/local?path=${encodeURIComponent(file.path)}`;
        preview.alt = "";
      } else {
        preview.textContent = fileExtension(file.originalName || file.storedName);
        preview.setAttribute("aria-hidden", "true");
      }

      const copy = document.createElement("span");
      copy.className = "composer-attachment-copy";
      const name = document.createElement("strong");
      name.textContent = file.originalName || file.storedName || "附件";
      name.title = name.textContent;
      const meta = document.createElement("small");
      meta.textContent = formatBytes(Number(file.size) || 0);
      copy.append(name, meta);

      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "composer-attachment-remove";
      remove.textContent = "×";
      remove.title = `移除 ${name.textContent}`;
      remove.setAttribute("aria-label", remove.title);
      remove.addEventListener("click", () => {
        pendingAttachments = pendingAttachments.filter((entry) => entry.path !== file.path);
        renderAttachments();
      });

      item.append(preview, copy, remove);
      return item;
    }

    function fileExtension(name) {
      const match = String(name || "").match(/\.([^.]+)$/);
      return (match?.[1] || "FILE").slice(0, 5).toUpperCase();
    }

    function setUploading(uploading) {
      attachButton.disabled = uploading;
      attachButton.textContent = uploading ? "Uploading" : "Attach";
    }
  }

  window.AgentUpload = {
    create: createUploadController,
  };
})();
