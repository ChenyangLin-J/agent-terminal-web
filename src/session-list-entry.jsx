import React from "react";
import { createRoot } from "react-dom/client";
import { SessionList } from "@agent-workbench/platform/ui";
import "@agent-workbench/platform/styles.css";

const roots = new Map();

function requestAction(type, payload = {}) {
  return new Promise((resolve, reject) => {
    window.dispatchEvent(new CustomEvent("agent-session-list-action", {
      detail: { type, ...payload, resolve, reject },
    }));
  });
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
window.dispatchEvent(new Event("agent-session-list-ready"));
