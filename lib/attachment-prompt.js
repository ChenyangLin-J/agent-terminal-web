const OPEN_TAG = "<agent_web_attachments>";
const CLOSE_TAG = "</agent_web_attachments>";

// Codex App Server does not surface `mention` file paths to the model, so file
// attachments also travel as a tagged text item. Transcript rendering drops it
// because the attachment cards already come from the `mention` entries.
export function fileAttachmentPromptText(attachments = []) {
  if (!attachments.length) return "";
  const lines = attachments.map((attachment) => `- ${attachment.originalName}: ${attachment.path}`);
  return [OPEN_TAG, "用户随本消息上传了以下文件，请按需读取：", ...lines, CLOSE_TAG].join("\n");
}

export function isAttachmentPromptText(text) {
  const value = String(text || "").trim();
  return value.startsWith(OPEN_TAG) && value.endsWith(CLOSE_TAG);
}
