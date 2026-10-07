import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type { PluginContext, PluginModule, PluginUiNode, ScheduledRunTarget } from "@modera/plugin-sdk";

const exec = promisify(execFile);
type Selection = ScheduledRunTarget["selection"];
type Models = Awaited<ReturnType<NonNullable<NonNullable<PluginContext["scheduling"]>["options"]>>>["models"];
type Task = { id: string; projectId: string; title: string; base: string; selection?: Selection; target?: ScheduledRunTarget; runId?: string; error?: string; createdAt: number };
type State = { version: 1; tasks: Task[] };
const outcomeLabels: Record<string, string> = { running: "运行中", completed: "已完成", cancelled: "已取消", failed: "失败", interrupted: "已中断", unknown: "状态待核实" };
const modelOptions = (models: Models) => models.flatMap(profile => profile.models.map(model => {
  const efforts = profile.efforts?.[model];
  const selection: Selection = { profileId: profile.profileId, model, reasoningEffort: efforts?.includes("medium") ? "medium" : efforts?.[0] ?? "medium" };
  return { value: JSON.stringify([selection.profileId, selection.model]), label: `${profile.name} / ${model}`.slice(0, 200), selection };
}));
const parseText = (value?: string) => {
  if (typeof value !== "string" || !value.trim() || value.length > 4000) throw new Error("请输入 1–4000 字的任务要求");
  return value.trim();
};

export const activate: PluginModule["activate"] = async host => {
  if (!host.scheduling?.options || !host.scheduling.target || !host.scheduling.prepare || !host.scheduling.startRole || !host.scheduling.result || !host.runBackground)
    throw new Error("任务会话能力不可用");
  const file = join(host.storagePath, "tasks.json");
  await mkdir(dirname(file), { recursive: true });
  let state: State;
  try { state = JSON.parse(await readFile(file, "utf8")) as State; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; state = { version: 1, tasks: [] }; }
  if (state.version !== 1 || !Array.isArray(state.tasks)) throw new Error("工作副本记录格式无效");
  const selectedModels = new Map<string, string>();
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
  const details = async (path: string) => {
    try {
      const [branch, commit, changed] = await Promise.all([
        exec("git", ["-C", path, "branch", "--show-current"], { timeout: 10000 }),
        exec("git", ["-C", path, "rev-parse", "--short", "HEAD"], { timeout: 10000 }),
        exec("git", ["-C", path, "status", "--short"], { timeout: 10000, maxBuffer: 65536 }),
      ]);
      const files = changed.stdout.trimEnd().split(/\r?\n/).filter(Boolean);
      return `工作目录：${path}\n当前分支：${branch.stdout.trim() || "分离提交（未创建分支）"}\n当前提交：${commit.stdout.trim()}\n文件改动：${files.length ? `\n${files.slice(0, 20).join("\n")}${files.length > 20 ? `\n…另外 ${files.length - 20} 项` : ""}` : "无"}`;
    } catch { return `工作目录：${path}\nGit 状态读取失败，请打开任务会话核实。`; }
  };
  return { ui: [{
    id: "modera.worktree.workbench", slot: "workbench",
    workbench: { title: "工作副本", icon: "files", order: -102 },
    requiredPermissions: ["storage.read", "storage.write", "runs.schedule", "runs.delegate", "runs.observe", "workspace.read", "process.spawn"],
    actions: ["create", "refresh", "setModel"],
    async act(action, context) {
      if (action.id === "refresh") return;
      if (action.id === "setModel") {
        if (!context.projectId) throw new Error("请选择 Git 项目");
        const input = JSON.parse(action.value ?? "{}") as { value?: string };
        const options = modelOptions((await host.scheduling!.options!(context.projectId)).models);
        if (!options.some(item => item.value === input.value)) throw new Error("所选模型已不可用");
        selectedModels.set(context.projectId, input.value!);
        host.invalidateUi?.();
        return;
      }
      if (action.id !== "create" || !context.projectId) throw new Error("请选择 Git 项目");
      const title = parseText(action.value);
      const capabilities = await host.scheduling!.options!(context.projectId);
      if (!capabilities.isolatedWorkspaces) throw new Error("此项目暂不支持工作副本，请确认它是已有提交的 Git 仓库");
      const options = modelOptions(capabilities.models);
      const chosen = selectedModels.get(context.projectId);
      const selected = chosen ? options.find(item => item.value === chosen) : options[0];
      if (!selected) throw new Error(chosen ? "所选模型已不可用，请重新选择" : "请先配置可用模型");
      const selection = selected.selection;
      const task: Task = { id: randomUUID(), projectId: context.projectId, title, base: await base(context.workspacePath), selection, createdAt: Date.now() };
      await save(() => { state.tasks.unshift(task); state.tasks = state.tasks.slice(0, 100); });
      host.runBackground!({ ...context, label: `工作副本：${title.slice(0, 120)}` }, async backgroundSignal => {
        const signal = AbortSignal.any([backgroundSignal, host.scopeSignal?.(task.projectId) ?? host.signal]);
        try {
          const target = await host.scheduling!.prepare!(await host.scheduling!.target!(task.projectId, "", selection), title.slice(0, 120), true,
            { taskId: task.id, workbenchId: "modera.worktree.workbench", workspace: "git-worktree", conversationMode: "native" });
          await save(() => { task.target = target; });
          const started = await host.scheduling!.startRole!(target,
            { id: "worktree_worker", name: "工作副本任务", prompt: "在当前工作目录完成用户任务。先检查实际仓库状态和分支；保存用户原有改动。完成后报告任务分支、修改文件和实际检查结果。不要自行合并、推送或删除工作目录。", tools: "inherit", selection },
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
      const models = modelOptions(capabilities.models);
      const chosen = selectedModels.get(context.projectId);
      const selected = chosen && models.some(item => item.value === chosen) ? chosen : models[0]?.value;
      const visibleModels = models.slice(0, 100);
      if (selected && !visibleModels.some(item => item.value === selected)) visibleModels[99] = models.find(item => item.value === selected)!;
      const currentBase = await base(context.workspacePath);
      const children: PluginUiNode[] = [
        { type: "text", text: "新任务从当前已提交版本创建独立 Git 工作目录及自动命名的本地任务分支（modera/task-…）。当前目录的未提交改动不会带入；任务完成后不会自动合并或推送。" },
        { type: "text", text: `当前起点：${currentBase}` },
        ...(models.length ? [{ type: "select" as const, label: "执行模型", action: "setModel", value: selected ?? models[0]!.value, options: visibleModels.map(({ value, label }) => ({ value, label })) }] : [{ type: "text" as const, text: "请先配置可用模型" }]),
        ...(chosen && chosen !== selected ? [{ type: "text" as const, text: "之前选择的模型已不可用，请重新选择后创建任务。" }] : []),
        ...(capabilities.isolatedWorkspaces ? [{ type: "form" as const, label: "新建工作副本任务", placeholder: "例如：修复登录后页面空白，并运行相关检查", action: "create", maxLength: 4000 }] : [{ type: "text" as const, text: "此项目不能创建工作副本：需要一个已有提交的 Git 仓库。" }]),
        { type: "button", label: "刷新任务状态", action: "refresh" },
      ];
      const taskViews = await Promise.all(state.tasks.filter(item => item.projectId === context.projectId).slice(0, 30).map(async task => {
        let status = task.error ? "启动失败" : task.runId ? "运行中" : "准备中";
        let result = "";
        let workspace = "";
        if (task.target && host.scheduling!.workspace) {
          try {
            const allocated = await host.scheduling!.workspace(task.target);
            if (allocated?.kind === "git-worktree") workspace = await details(allocated.path);
          } catch { workspace = "工作目录归属或路径待核实。"; }
        }
        if (task.target && task.runId) {
          try {
            const inspected = await host.scheduling!.inspect(task.target, task.runId);
            status = inspected.waitingForInput ? "等待你的答复" : outcomeLabels[inspected.outcome] ?? "状态待核实";
            if (inspected.outcome === "completed") result = (await host.scheduling!.result!(task.target, task.runId)).text.slice(0, 1500);
          }
          catch { status = "状态待核实"; }
        }
        return [
          { type: "document" as const, label: `${task.title.slice(0, 90)} · ${status}`, text: `起点：${task.base}${task.selection ? `\n执行模型：${task.selection.model}` : ""}${workspace ? `\n${workspace}` : ""}${task.error ? `\n${task.error}` : ""}${result ? `\n\n任务结果：${result}` : ""}${status === "等待你的答复" ? "\n\n请打开任务会话回答问题。" : ""}` },
          ...(task.target?.sessionId ? [{ type: "conversation-link" as const, label: "打开任务会话并查看改动", sessionId: task.target.sessionId }] : []),
        ];
      }));
      children.push(...taskViews.flat());
      return { title: "工作副本", children };
    },
  }] };
};
