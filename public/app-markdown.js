(function installAgentMarkdown(global) {
  function createRenderer() {
    if (typeof global.markdownit !== "function") return null;
    const renderer = global.markdownit({ html: false, linkify: true, breaks: true, typographer: false });
    const defaultLinkOpen = renderer.renderer.rules.link_open;
    renderer.renderer.rules.link_open = (tokens, index, options, environment, self) => {
      tokens[index].attrSet("target", "_blank");
      tokens[index].attrSet("rel", "noopener noreferrer");
      return defaultLinkOpen
        ? defaultLinkOpen(tokens, index, options, environment, self)
        : self.renderToken(tokens, index, options);
    };
    return renderer;
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
