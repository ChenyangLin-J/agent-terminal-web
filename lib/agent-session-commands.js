import { turnRequirement } from './agent-turn-projection.js';

/** Product command routing; execution primitives are supplied by the Runtime. */
export function createAgentSessionCommandHandler(services) {
  const {
    send,
    cleanCustomTitle,
    getAppServerSkills,
    renameSession,
    persistRestorableWebSession,
    broadcast,
    publicSession,
    appServerStatus,
    appServerUsage,
    appServerModels,
    appServerGoal,
    appServerGitDiff,
    appServerMcpInventory,
    appServerPluginInventory,
    appServerHookInventory,
  } = services;
  return async function handleAppServerCommand(session, ws, value, reply = (type, payload) => send(ws, type, payload)) {
    const raw = String(value || "").trim();
    const command = raw.split(/\s+/)[0].toLowerCase();
    const argument = raw.slice(command.length).trim();

    if (command === "/permissions") {
      reply("app-command-result", {
        command,
        kind: "permissions",
        access: session.access,
        activeTurn: Boolean(session.turnState?.active),
      });
      return;
    }

    if (command === "/skills") {
      const skills = await getAppServerSkills(session);
      reply("app-command-result", { command, kind: "inventory", title: "Skills", skills });
      return;
    }

    if (command === "/status") {
      const payload = await appServerStatus(session);
      reply("app-command-result", { command, kind: "status", ...payload });
      return;
    }

    if (command === "/usage") {
      reply("app-command-result", { command, kind: "usage", ...(await appServerUsage(session)) });
      return;
    }

    if (command === "/model") {
      reply("app-command-result", { command, kind: "models", ...(await appServerModels(session, argument)) });
      return;
    }

    if (command === "/fast") {
      const config = (await session.appServer.readConfig({ cwd: session.cwd }))?.config || {};
      const current = session.appServiceTier || config.service_tier || "default";
      session.appServiceTier = current === "priority" ? "default" : "priority";
      persistRestorableWebSession(session);
      reply("app-command-result", {
        command,
        kind: "notice",
        title: "Fast mode",
        content: session.appServiceTier === "priority" ? "Fast 已开启，将从下一轮任务生效。" : "Fast 已关闭，将从下一轮任务生效。",
      });
      return;
    }

    if (command === "/goal") {
      reply("app-command-result", { command, kind: "goal", ...(await appServerGoal(session, argument)) });
      return;
    }

    if (command === "/rename") {
      const title = cleanCustomTitle(argument);
      if (!title) throw new Error("请使用 /rename 新名称。");
      await renameSession(session, title);
      reply("app-command-result", { command, kind: "notice", title: "Rename", content: `Session 已重命名为“${title}”。` });
      return;
    }

    if (command === "/compact") {
      if (session.turnState.active || session.appServer.activeTurnId) throw new Error("当前任务仍在处理，完成后再压缩上下文。");
      await session.appServer.compactThread();
      reply("app-command-result", { command, kind: "notice", title: "Compact", content: "已开始压缩当前 Session 的上下文。" });
      return;
    }

    if (command === "/diff") {
      reply("app-command-result", { command, kind: "text", title: "Working tree diff", ...(await appServerGitDiff(session.cwd)) });
      return;
    }

    if (command === "/review") {
      if (session.turnState.active || session.appServer.activeTurnId) throw new Error("当前任务仍在处理，完成后再启动 Review。");
      session.turnState.sequence += 1;
      session.turnState.active = true;
      session.turnState.turnId = "";
      const requirement = turnRequirement(session.turnState, "Review uncommitted changes", "original", "working");
      session.turnState.requirements = [requirement];
      let result;
      try { result = await session.appServer.startReview({ type: "uncommittedChanges" }); }
      catch (error) { requirement.status = "failed"; session.turnState.active = Boolean(session.appServer.activeTurnId); throw error; }
      session.turnState.active = Boolean(session.appServer.activeTurnId);
      if (session.turnState.active) session.turnState.turnId = session.appServer.activeTurnId || result?.turn?.id || "";
      persistRestorableWebSession(session);
      broadcast(session, "status", publicSession(session));
      reply("app-command-result", { command, kind: "notice", title: "Review", content: "已开始检查当前工作区的未提交修改。" });
      return;
    }

    if (command === "/mcp") {
      reply("app-command-result", { command, kind: "inventory", title: "MCP servers", ...(await appServerMcpInventory(session)) });
      return;
    }

    if (command === "/plugins") {
      reply("app-command-result", { command, kind: "inventory", title: "Plugins", ...(await appServerPluginInventory(session)) });
      return;
    }

    if (command === "/hooks") {
      reply("app-command-result", { command, kind: "inventory", title: "Hooks", ...(await appServerHookInventory(session)) });
      return;
    }

    throw new Error(`${command || "This command"} is not available in App Server mode.`);
  };
}
