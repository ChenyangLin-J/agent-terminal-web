(function installAgentMarkdown(global) {
  function createRenderer() {
    if (typeof global.markdownit !== "function") return null;
    const renderer = global.markdownit({ html: false, linkify: true, breaks: true, typographer: false });
    const defaultLinkOpen = renderer.renderer.rules.link_open;
    renderer.renderer.rules.link_open = (tokens, index, options, environment, self) => {
      const href = tokens[index].attrGet("href");
      if (isWorkspaceLocalHref(href)) {
        tokens[index].attrSet("href", localOpenHref(href));
        tokens[index].attrSet("title", "打开文件");
      }
      tokens[index].attrSet("target", "_blank");
      tokens[index].attrSet("rel", "noopener noreferrer");
      return defaultLinkOpen
        ? defaultLinkOpen(tokens, index, options, environment, self)
        : self.renderToken(tokens, index, options);
    };
    return renderer;
  }

  function isWorkspaceLocalHref(href) {
    if (!href) return false;
    try {
      return decodeURIComponent(href).startsWith("/home/ubuntu/workspace/");
    } catch {
      return href.startsWith("/home/ubuntu/workspace/");
    }
  }

  function localOpenHref(href) {
    const decoded = decodeLocalHref(href);
    const line = decoded.match(/:(\d+)(?::\d+)?(?:#.*)?$/)?.[1];
    return `/open/local?path=${encodeURIComponent(href)}${line ? `#L${line}` : ""}`;
  }

  function decodeLocalHref(href) {
    try {
      return decodeURIComponent(href);
    } catch {
      return href;
    }
  }

  function render(container, text, renderer) {
    if (!renderer) {
      container.textContent = text;
      return;
    }
    container.classList.add("app-transcript-markdown");
    container.innerHTML = renderer.render(text);
  }

  global.AgentMarkdown = Object.freeze({ createRenderer, render });
})(globalThis);
