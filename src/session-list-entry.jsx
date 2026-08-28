import React from "react";
import { createRoot } from "react-dom/client";
import { SessionList, SessionWorkspace } from "@agent-workbench/platform/ui";
import "@agent-workbench/platform/styles.css";

const roots = new Map();

function requestAction(type, payload = {}) {
  return new Promise((resolve, reject) => {
    window.dispatchEvent(new CustomEvent("agent-session-list-action", {
      detail: { type, ...payload, resolve, reject },
    }));
  });
}

function requestWorkspaceAction(type, payload = {}) {
  return new Promise((resolve, reject) => {
    window.dispatchEvent(new CustomEvent("agent-session-workspace-action", {
      detail: { type, ...payload, resolve, reject },
    }));
  });
}

function agentDocumentResourceUrl({ file = {}, href = "" } = {}) {
  const reference = String(href || "").trim();
  const sourcePath = String(file.path || "").trim();
  if (!reference || !sourcePath || reference.startsWith("#") || /^(?:https?:|data:|blob:)/i.test(reference)) return reference;
  try {
    const resolved = new URL(reference, `file://${sourcePath}`).pathname;
    return `/open/local?path=${encodeURIComponent(decodeURIComponent(resolved))}`;
  } catch {
    return reference;
  }
}

function HostFilters({ hosts = [], selectedId = "all" }) {
  if (hosts.length < 2) return null;
  return (
    <nav className="agent-core-host-filters" aria-label="会话账号筛选">
      {hosts.map((host) => (
        <button
          aria-pressed={host.id === selectedId}
          className={host.id === selectedId ? "is-active" : ""}
          key={host.id}
          onClick={() => requestAction("host-filter", { hostId: host.id })}
          type="button"
        >{host.label}</button>
      ))}
    </nav>
  );
}

function SharedSessionList({ snapshot }) {
  return (
    <SessionList
      actions={{
        onArchive: (session, archived) => requestAction("archive", { id: session.id, archived }),
        onCollapse: () => requestAction("collapse"),
        onCreate: () => requestAction("create"),
        onEnd: (session) => requestAction("end", { id: session.id }),
        onFavorite: (session, favorited) => requestAction("favorite", { id: session.id, favorited }),
        onFullTextSearch: (query) => requestAction("full-text-search", { query }),
        onOpenHistory: () => requestAction("history"),
        onRefresh: () => requestAction("refresh"),
        onSelect: (session) => requestAction("select", { id: session.id }),
      }}
      browser={snapshot.browser}
      extensions={{
        renderListFilters: () => (
          <HostFilters hosts={snapshot.hosts} selectedId={snapshot.selectedHostId} />
        ),
      }}
      labels={{
        archive: "归档",
        collapseList: "收起快速切换",
        countSuffix: "个当前",
        createAriaLabel: "新建 Session",
        end: "结束",
        favorite: "置顶",
        fullTextSearch: "全文",
        history: "历史",
        listAriaLabel: "快速切换 Session",
        listEmpty: "当前没有 Session。",
        listLabel: "按状态",
        manage: "归档或结束",
        refresh: "刷新",
        searchAriaLabel: "搜索当前 Session",
        searchEmpty: "没有匹配的 Session。",
        searchPlaceholder: "搜索标题、项目或当前任务",
        unfavorite: "取消置顶",
      }}
    />
  );
}

function WorkspaceHeaderActions() {
  return (
    <>
      <button className="cwu-button" onClick={() => requestWorkspaceAction("open-list")} type="button">列表</button>
      <button className="cwu-button" onClick={() => requestWorkspaceAction("open-agents")} type="button">Agents</button>
      <button className="cwu-button" onClick={() => requestWorkspaceAction("open-side-chat")} type="button">侧问</button>
      <details className="agent-platform-canary-tools">
        <summary className="cwu-button">工具</summary>
        <div>
          <button onClick={() => requestWorkspaceAction("open-memories")} type="button">记忆</button>
          <button onClick={() => requestWorkspaceAction("open-tree")} type="button">关系</button>
          <button onClick={() => requestWorkspaceAction("open-share")} type="button">分享</button>
          <button onClick={() => requestWorkspaceAction("open-realtime")} type="button">语音</button>
        </div>
      </details>
      <button
        className="cwu-button agent-platform-canary-exit"
        onClick={() => requestWorkspaceAction("disable-canary")}
        title="恢复 Agent Terminal 原界面"
        type="button"
      >退出新版</button>
    </>
  );
}

function SharedSessionWorkspace({ snapshot }) {
  return (
    <SessionWorkspace
      actions={{
        documentResourceUrl: agentDocumentResourceUrl,
        onBack: () => requestWorkspaceAction("back"),
        onCloseDocument: () => requestWorkspaceAction("close-document"),
        onDraftChange: (draft) => requestWorkspaceAction("draft-change", { draft }),
        onEditMessage: (payload) => requestWorkspaceAction("edit-message", payload),
        onForkMessage: (payload) => requestWorkspaceAction("fork-message", payload),
        onInterrupt: snapshot.actionAvailability?.interrupt
          ? () => requestWorkspaceAction("interrupt")
          : undefined,
        onLoadEarlier: () => requestWorkspaceAction("load-earlier"),
        onOpenAttachment: (attachment, message) => requestWorkspaceAction("open-attachment", { attachment, message }),
        onOpenDocumentExternal: (file) => requestWorkspaceAction("open-document-external", { file }),
        onOpenLink: (href, sourceFile) => requestWorkspaceAction("open-link", { href, sourceFile }),
        onRespondToRequest: (response) => requestWorkspaceAction("respond-request", { response }),
        onSaveDocument: (change) => requestWorkspaceAction("save-document", { change }),
        onSubmit: (submission) => requestWorkspaceAction("submit", { submission }),
        onUploadAttachments: (files) => requestWorkspaceAction("upload-attachments", { files }),
      }}
      attachmentPolicy={snapshot.attachmentPolicy}
      documentPreview={snapshot.documentPreview}
      extensions={{ renderHeaderActions: () => <WorkspaceHeaderActions /> }}
      features={snapshot.features}
      labels={snapshot.labels}
      session={snapshot.session}
    />
  );
}

function render(container, snapshot) {
  if (!container) return false;
  let root = roots.get(container);
  if (!root) {
    root = createRoot(container);
    roots.set(container, root);
  }
  root.render(<SharedSessionList snapshot={snapshot} />);
  return true;
}

function renderWorkspace(container, snapshot) {
  if (!container) return false;
  let root = roots.get(container);
  if (!root) {
    root = createRoot(container);
    roots.set(container, root);
  }
  root.render(<SharedSessionWorkspace snapshot={snapshot} />);
  return true;
}

function unmount(container = null) {
  if (container) {
    roots.get(container)?.unmount();
    roots.delete(container);
    return;
  }
  for (const root of roots.values()) root.unmount();
  roots.clear();
}

window.AgentSessionList = { render, unmount };
window.AgentSessionWorkspace = { render: renderWorkspace, unmount };
window.dispatchEvent(new Event("agent-session-list-ready"));
window.dispatchEvent(new Event("agent-session-workspace-ready"));
