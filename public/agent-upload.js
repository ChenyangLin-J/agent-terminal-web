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
      setUploadStatus("Uploading...");

      try {
        const response = await fetch("/api/uploads", {
          method: "POST",
          body: form,
        });

        if (response.status === 401) {
          redirectToLogin();
          return;
        }

        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || "Upload failed.");

        insertUploadedFiles(data.files || []);
        setUploadStatus(`Attached ${(data.files || []).length} file${(data.files || []).length === 1 ? "" : "s"}.`, {
          clear: true,
        });
      } catch (error) {
        setUploadStatus(error.message || "Upload failed.");
      } finally {
        setUploading(false);
      }
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
      const paths = files.map((file) => file.path).filter(Boolean);
      if (!paths.length) return;
      insertPromptText(paths.map((filePath) => `请读取这个文件：${filePath}`).join("\n"));
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
