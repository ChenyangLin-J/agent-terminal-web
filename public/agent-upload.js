(function () {
  function createUploadController({
    attachButton,
    fileInput,
    composer,
    insertPromptText,
    setUploadStatus,
    redirectToLogin,
  }) {
    return {
      install,
      uploadFiles,
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

        insertUploadedFiles(data.files || []);
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

    function insertUploadedFiles(files) {
      const uploadedFiles = files.filter((file) => file.path);
      if (!uploadedFiles.length) return;
      insertPromptText(
        uploadedFiles
          .map((file) => `请读取这个文件（原始文件名：${file.originalName || file.storedName || "未知"}）：${file.path}`)
          .join("\n"),
      );
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
