import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type { PluginModule, PluginUiNode, ScheduledRunTarget } from "@modera/plugin-sdk";

const exec = promisify(execFile);
type Task = { id: string; projectId: string; title: string; base: string; target?: ScheduledRunTarget; runId?: string; error?: string; createdAt: number };
type State = { version: 1; tasks: Task[] };
const parseText = (value?: string) => {
  if (typeof value !== "string" || !value.trim() || value.length > 4000) throw new Error("请输入 1–4000 字的任务要求");
  return value.trim();
};

export const activate: PluginModule["activate"] = async host => {
  if (!host.scheduling?.options || !host.scheduling.target || !host.scheduling.prepare || !host.scheduling.startRole || !host.runBackground)
    throw new Error("任务会话能力不可用");
  const file = join(host.storagePath, "tasks.json");
  await mkdir(dirname(file), { recursive: true });
  let state: State;
  try { state = JSON.parse(await readFile(file, "utf8")) as State; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; state = { version: 1, tasks: [] }; }
  if (state.version !== 1 || !Array.isArray(state.tasks)) throw new Error("工作副本记录格式无效");
  let queue = Promise.resolve();
  const save = (change: () => void) => {
    const operation = queue.then(async () => {
      change();
      const temp = `${file}.${randomUUID()}.tmp`;
      await writeFile(temp, JSON.stringify(state), "utf8");
      await rename(temp, file);
      host.invalidateUi?.();
    });
    queue = operation.then(() => {}, () => {});
    return operation;
  };
  const base = async (path?: string) => {
    if (!path) return "未知分支";
    try {
      const [branch, commit] = await Promise.all([
        exec("git", ["-C", path, "branch", "--show-current"], { timeout: 10000 }),
        exec("git", ["-C", path, "rev-parse", "--short", "HEAD"], { timeout: 10000 }),
      ]);
      return `${branch.stdout.trim() || "分离提交"} · ${commit.stdout.trim()}`;
    } catch { return "非 Git 项目"; }
  };
  return { ui: [{
    id: "modera.worktree.workbench", slot: "workbench",
    workbench: { title: "工作副本", icon: "files", order: -102 },
    requiredPermissions: ["storage.read", "storage.write", "runs.schedule", "runs.delegate", "runs.observe", "workspace.read", "process.spawn"],
    actions: ["create", "refresh"],
    async act(action, context) {
      if (action.id === "refresh") return;
      if (action.id !== "create" || !context.projectId) throw new Error("请选择 Git 项目");
      const title = parseText(action.value);
      const capabilities = await host.scheduling!.options!(context.projectId);
      if (!capabilities.isolatedWorkspaces) throw new Error("此项目暂不支持工作副本，请确认它是已有提交的 Git 仓库");
      const model = capabilities.models[0];
      const name = model?.models[0];
      if (!model || !name) throw new Error("请先配置可用模型");
      const effort = model.efforts?.[name]?.includes("medium") ? "medium" : model.efforts?.[name]?.[0] ?? "medium";
      const selection = { profileId: model.profileId, model: name, reasoningEffort: effort };
      const task: Task = { id: randomUUID(), projectId: context.projectId, title, base: await base(context.workspacePath), createdAt: Date.now() };
      await save(() => { state.tasks.unshift(task); state.tasks = state.tasks.slice(0, 100); });
      host.runBackground!({ ...context, label: `工作副本：${title.slice(0, 120)}` }, async backgroundSignal => {
        const signal = AbortSignal.any([backgroundSignal, host.scopeSignal?.(task.projectId) ?? host.signal]);
        try {
          const target = await host.scheduling!.prepare!(await host.scheduling!.target!(task.projectId, "", selection), title.slice(0, 120), true,
            { taskId: task.id, workbenchId: "modera.worktree.workbench", workspace: "git-worktree", conversationMode: "native" });
          await save(() => { task.target = target; });
          const started = await host.scheduling!.startRole!(target,
            { id: "worktree_worker", name: "工作副本任务", prompt: "在当前工作目录完成用户任务。先检查实际仓库状态；保存用户原有改动。完成后报告修改文件和实际检查结果。不要自行合并、推送或删除工作目录。", tools: "inherit", selection },
            title, signal, { workflowTools: ["ask_user_question"] });
          await save(() => { task.runId = started.runId; });
        } catch (error) {
          await save(() => { task.error = String(error); });
        }
      });
    },
    async render(_request, context) {
      if (!context.projectId) return { title: "工作副本", children: [{ type: "text", text: "请先选择一个项目。" }] };
      const capabilities = await host.scheduling!.options!(context.projectId);
      const currentBase = await base(context.workspacePath);
      const children: PluginUiNode[] = [
        { type: "text", text: "任务默认在另一份 Git 工作目录中修改文件。第一版从已提交版本开始，不带入当前目录的未提交改动，也不自动创建分支或合并。" },
        { type: "text", text: `当前起点：${currentBase}` },
        { type: "text", text: capabilities.models[0]?.models[0] ? `执行模型：${capabilities.models[0].name} / ${capabilities.models[0].models[0]}` : "请先配置可用模型" },
        ...(capabilities.isolatedWorkspaces ? [{ type: "form" as const, label: "新建工作副本任务", placeholder: "例如：修复登录后页面空白，并运行相关检查", action: "create", maxLength: 4000 }] : [{ type: "text" as const, text: "此项目不能创建工作副本：需要一个已有提交的 Git 仓库。" }]),
        { type: "button", label: "刷新任务状态", action: "refresh" },
      ];
      for (const task of state.tasks.filter(item => item.projectId === context.projectId).slice(0, 30)) {
        let status = task.error ? "启动失败" : task.runId ? "运行中" : "准备中";
        if (task.target && task.runId) {
          try { status = (await host.scheduling!.inspect(task.target, task.runId)).outcome; }
          catch { status = "状态待核实"; }
        }
        children.push({ type: "document", label: `${task.title.slice(0, 90)} · ${status}`, text: `起点：${task.base}${task.error ? `\n${task.error}` : ""}` });
        if (task.target?.sessionId) children.push({ type: "conversation-link", label: "打开任务会话并查看改动", sessionId: task.target.sessionId });
      }
      return { title: "工作副本", children };
    },
  }] };
};
