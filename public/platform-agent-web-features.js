/** Small resident feature entrances. Heavy scripts load only after the user opens one. */
const assets = new Map();

function script(src) {
  if (assets.has(src)) return assets.get(src);
  const task = new Promise((resolve, reject) => {
    const node = document.createElement('script');
    node.src = src;
    node.onload = () => resolve();
    node.onerror = () => { node.remove(); reject(new Error('功能资源加载失败，请重试。')); };
    document.head.append(node);
  }).catch(error => { assets.delete(src); throw error; });
  assets.set(src, task);
  return task;
}

function stylesheet(href) {
  if (assets.has(href)) return assets.get(href);
  const task = new Promise((resolve, reject) => {
    const node = document.createElement('link');
    node.rel = 'stylesheet'; node.href = href;
    node.onload = () => resolve();
    node.onerror = () => { node.remove(); reject(new Error('功能样式加载失败，请重试。')); };
    document.head.append(node);
  }).catch(error => { assets.delete(href); throw error; });
  assets.set(href, task);
  return task;
}

async function markdown() {
  if (!globalThis.markdownit) await script('/vendor/markdown-it/markdown-it.min.js?v=14.3.0');
  if (!globalThis.AgentMarkdown) await script('/app-markdown.js?v=20260825-mobile-files-1');
}

export async function openAgentWebMemories(options) {
  await Promise.all([
    stylesheet('/agent-memories.css?v=20261003-change-timeline-1'),
    markdown().then(() => script('/agent-memories.js?v=20261009-lazy-1')),
  ]);
  globalThis.AgentMemories.open(options);
}

export async function openAgentWebIntegrations() {
  await Promise.all([
    stylesheet('/agent-integrations.css?v=20260825-custom-keys-1'),
    script('/agent-integrations.js?v=20260825-custom-keys-1'),
  ]);
  globalThis.AgentIntegrations.open();
}

export async function loadAgentWebVoice() {
  await script('/shared/voice-recovery-store.js?v=20260717-2');
  await script('/shared/voice-capture-widget.js?v=20260717-recovery-3');
  if (!globalThis.VoiceCapture?.create) throw new Error('语音输入暂时不可用，请重试。');
  return globalThis.VoiceCapture;
}
