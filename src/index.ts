import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { declaredTool, type PluginContext, type PluginModule, type PluginUiNode, type ScheduledRunTarget, type ToolContext, type ComposerRequest } from "@modera/plugin-sdk";
import manifest from "../plugin.json";
import { worktreeEnvironment } from "./environment";
import { previewTaskMerge, applyTaskMerge, type MergePreview } from "./merge";

const exec = promisify(execFile);
const surface = "modera.worktree.session";
const permissions = ["storage.read", "storage.write", "workspace.read", "process.spawn", "runs.schedule", "runs.delegate", "runs.observe"] as const;
const prompt = "在当前独立工作树目录中完成用户任务。先检查实际仓库状态，保留用户改动。默认可以处于分离 HEAD。完成修改和必要验证后报告实际结果，默认保留未提交修改。仅在用户明确要求时创建分支、提交或推送；提交前核对改动范围。不要自动合并或删除工作目录。";
type Task = { id: string; projectId: string; projectPath: string; title: string; instruction: string; baseBranch?: string; baseCommit?: string; includeLocalChanges?: boolean; selection?: ScheduledRunTarget["selection"]; target?: ScheduledRunTarget; error?: string };
const git = async (path: string, ...args: string[]) => (await exec("git", ["-C", path, ...args], { timeout: 120000, maxBuffer: 1024 * 1024, windowsHide: true })).stdout.trim();
async function branches(path?: string) {
  if (!path) return [];
  return (await git(path, "for-each-ref", "--format=%(refname:short)%00%(objectname)", "refs/heads")).split(/\r?\n/).filter(Boolean).map(line => { const [name, commit] = line.split("\0"); return { name: name!, commit: commit! }; });
}
export const activate: PluginModule["activate"] = async host => {
  const api = host.scheduling;
  if (!api?.prepare || !api.target || !api.startRole || !api.workspace || !api.workspaceStatus || !api.createWorkspaceBranch || !api.archiveWorkspace || !api.options) throw new Error("工作树会话接口不可用");
  await mkdir(host.storagePath, { recursive: true });
  const file = join(host.storagePath, "tasks.json");
  let tasks: Task[];
  try {
    const saved = JSON.parse(await readFile(file, "utf8"));
    // Older releases stored a versioned envelope rather than the task array.
    tasks = Array.isArray(saved) ? saved : saved?.version === 1 ? saved.tasks : undefined;
    if (!Array.isArray(tasks) || tasks.some(task => !task || typeof task !== "object" || Array.isArray(task))) throw new Error("工作树记录格式无效");
  }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; tasks = []; }
  let queue = Promise.resolve();
  const save = (change: () => void) => {
    const operation = queue.then(async () => { change(); const temporary = `${file}.${randomUUID()}.tmp`; await writeFile(temporary, JSON.stringify(tasks)); await rename(temporary, file); host.invalidateUi?.(); });
    queue = operation.catch(() => {}); return operation;
  };
  const launching = new Set<string>();
  const confirmations = new Map<string, { kind: "archive" } | { kind: "merge"; preview: MergePreview }>();
  const taskFor = (sessionId: string, projectId?: string) => tasks.find(task => task.target?.sessionId === sessionId && (!projectId || task.projectId === projectId));
  const launch = async (task: Task, request: ComposerRequest, context: ToolContext) => {
    if (launching.has(task.id)) throw new Error("工作树正在准备");
    launching.add(task.id);
    try {
      if (!task.selection || !task.baseCommit || !task.baseBranch) throw new Error("请选择起点分支和模型");
      if (task.target) throw new Error("此草稿已经启动，请打开对应聊天继续");
      const target = await api.prepare!(await api.target!(task.projectId, "", task.selection), task.title, true, { taskId: task.id, workbenchId: surface, workspace: "git-worktree", checkout: "detached", baseBranch: task.baseBranch, baseCommit: task.baseCommit, includeLocalChanges: !!task.includeLocalChanges, conversationMode: "native" });
      await save(() => { task.target = target; task.error = undefined; });
      const started = await api.startRole!(target, { id: "worktree_worker", name: "工作树", prompt, tools: "inherit", selection: task.selection }, request.query, AbortSignal.any([context.signal, host.scopeSignal?.(task.projectId) ?? host.signal]), { nativeExecution: true, workflowTools: ["ask_user_question"], ...(request.attachmentIds ? { attachmentIds: request.attachmentIds } : {}), ...(request.contextMode ? { contextMode: request.contextMode, contextInput: request.contextInput! } : {}) });
      host.invalidateUi?.(); return { sessionId: target.sessionId, runId: started.runId };
    } catch (error) { await save(() => { task.error = String(error); }); throw error; }
    finally { launching.delete(task.id); }
  };
  const environment = await worktreeEnvironment(host, async (request, context, revision) => {
    if (!context.projectId || !context.workspacePath || !request.selection) throw new Error("工作树配置不可用");
    const task: Task = { id: randomUUID(), projectId: context.projectId, projectPath: context.workspacePath!, title: (request.contextInput ?? request.query).trim().slice(0, 120), instruction: request.query, baseBranch: revision.name, baseCommit: revision.commit, includeLocalChanges: revision.includeLocalChanges, selection: request.selection };
    await save(() => tasks.push(task));
    return launch(task, request, context);
  });
  const idle = async (task: Task) => {
    if (!task.target) throw new Error("任务聊天不可用");
    const status = await api.inspect(task.target);
    if (status.busy || status.outcome === "running") throw new Error("请等待当前会话执行完成");
    return task.target;
  };
  const mergeInput = async (task: Task, context: ToolContext) => {
    const target = await idle(task), workspace = await api.workspace!(target);
    if (!workspace || !context.workspacePath || !task.baseBranch) throw new Error("工作树不可用");
    const branch = workspace.released ? workspace.branch : (await api.workspaceStatus!(target)).branch;
    if (!branch) throw new Error("请先创建分支并提交改动");
    return { projectPath: task.projectPath, baseBranch: task.baseBranch, expectedTaskBranch: branch, ...(workspace.released ? { archivedBranch: branch } : { taskPath: workspace.path }) };
  };
  return {
    composer: [environment.composer],
    tools: [{ definition: declaredTool(manifest, "worktree_draft"), async execute(raw, context) {
      const input = raw as { title?: string; instruction?: string };
      if (!context.projectId || !context.workspacePath || typeof input.title !== "string" || !input.title.trim() || input.title.length > 120 || typeof input.instruction !== "string" || !input.instruction.trim() || input.instruction.length > 4000) throw new Error("请输入任务标题和具体要求");
      const task: Task = { id: randomUUID(), projectId: context.projectId, projectPath: context.workspacePath!, title: input.title.trim(), instruction: input.instruction.trim() };
      await save(() => tasks.push(task)); return { taskId: task.id };
    } }],
    ui: [environment.ui, {
      id: surface, slot: "conversation.header", requiredPermissions: permissions,
      actions: ["refresh", "createBranch", "requestMerge", "confirmMerge", "requestArchive", "confirmArchive", "cancel"],
      async act(action, context, request) {
        const task = taskFor(request.sessionId, context.projectId);
        if (!task) throw new Error("此聊天没有工作树");
        if (action.id === "refresh") { host.invalidateUi?.(); return; }
        if (action.id === "cancel") { confirmations.delete(task.id); host.invalidateUi?.(); return; }
        const target = await idle(task);
        if (action.id === "createBranch") {
          const name = (JSON.parse(action.value ?? "{}") as { text?: string }).text?.trim();
          if (!name) throw new Error("请输入分支名");
          await api.createWorkspaceBranch!(target, name); confirmations.delete(task.id);
        } else if (action.id === "requestMerge") {
          confirmations.set(task.id, { kind: "merge", preview: await previewTaskMerge(await mergeInput(task, context)) });
        } else if (action.id === "confirmMerge") {
          const pending = confirmations.get(task.id);
          if (pending?.kind !== "merge") throw new Error("请先预览合并");
          await applyTaskMerge(await mergeInput(task, context), pending.preview); confirmations.delete(task.id);
        } else if (action.id === "requestArchive") confirmations.set(task.id, { kind: "archive" });
        else if (action.id === "confirmArchive") {
          if (confirmations.get(task.id)?.kind !== "archive") throw new Error("请先确认归档范围");
          await api.archiveWorkspace!(target); confirmations.delete(task.id);
        }
        host.invalidateUi?.();
      },
      async render(request, context) {
        const task = taskFor(request.sessionId, context.projectId);
        if (!task?.target) return { title: "工作树", children: [] };
        const workspace = await api.workspace!(task.target);
        if (!workspace) return { title: "工作树", children: [{ type: "text", text: "工作目录不可用" }] };
        if (workspace.released) return { title: "工作树", badge: "已归档", children: [{ type: "text", text: "工作目录已归档，此聊天只可查看。" }, { type: "text", text: `保留分支：${workspace.branch ?? "无"}` }] };
        const status = await api.workspaceStatus!(task.target), run = await api.inspect(task.target);
        const busy = run.busy || run.outcome === "running";
        const children: PluginUiNode[] = [
          { type: "text", text: `目录：${workspace.path}` },
          { type: "text", text: `分支：${status.branch ?? "分离 HEAD"} · ${status.head.slice(0, 12)}` },
          { type: "text", text: `起点：${task.baseBranch} · ${task.baseCommit?.slice(0, 12)}` },
          { type: "document", label: "文件改动", text: status.changes || "工作目录干净", previewText: status.changes.slice(0, 1200) || "工作目录干净" },
          { type: "button", label: "刷新", action: "refresh" },
          { type: "text", text: "修改默认保留；需要提交时请在聊天中提出。", tone: "muted" },
        ];
        if (busy) children.push({ type: "text", text: "会话执行中，完成后可管理分支与归档。" });
        else {
          children.push({ type: "form", label: "在此创建分支", placeholder: "modera/feature-name", action: "createBranch", context: task.id, maxLength: 200 });
          if (status.branch && !status.dirty) children.push({ type: "button", label: "预览合并到起点分支", action: "requestMerge" });
          children.push({ type: "button", label: "归档工作树", action: "requestArchive" });
          const pending = confirmations.get(task.id);
          if (pending?.kind === "merge") children.push({ type: "document", label: "合并预览", previewText: pending.preview.changeSummary, text: `${pending.preview.commits}\n${pending.preview.files}\n${pending.preview.patch}${pending.preview.patchTruncated ? "\n预览已截断，请核实完整差异。" : ""}` }, { type: "button", label: "确认合并", action: "confirmMerge" }, { type: "button", label: "取消", action: "cancel" });
          if (pending?.kind === "archive") children.push({ type: "text", text: "归档将移除干净工作目录并保留聊天和已有分支。存在本地文件或未由分支保留的提交时会拒绝归档。此操作不提供快照恢复。" }, { type: "button", label: "确认归档", action: "confirmArchive" }, { type: "button", label: "取消", action: "cancel" });
        }
        return { title: "工作树", badge: status.branch ?? "分离 HEAD", width: "wide", children };
      },
    }, {
      id: "modera.worktree.result", slot: "tool.result", toolNames: ["worktree_draft"], requiredPermissions: permissions,
      actions: ["setBase", "setModel", "setIncludeLocalChanges", "start"],
      async act(action, context) {
        const value = JSON.parse(action.id === "start" ? "{}" : action.value ?? "{}") as { context?: string; value?: string };
        const id = action.id === "start" ? action.value : value.context;
        const task = tasks.find(item => item.id === id && item.projectId === context.projectId);
        if (!task || task.target || launching.has(task.id)) throw new Error("草稿不可更改或已启动");
        if (value.value === "__unselected__") return;
        if (action.id === "setBase") {
          const branch = (await branches(context.workspacePath)).find(item => item.name === value.value);
          if (!branch) throw new Error("起点分支不存在");
          await save(() => { task.baseBranch = branch.name; task.baseCommit = branch.commit; task.includeLocalChanges = false; });
        } else if (action.id === "setModel") {
          const chosen = JSON.parse(value.value ?? "null") as ScheduledRunTarget["selection"];
          const options = await api.options!(task.projectId);
          if (!chosen || !options.models.some(profile => profile.profileId === chosen.profileId && profile.models.includes(chosen.model))) throw new Error("模型不可用");
          await save(() => { task.selection = chosen; });
        } else if (action.id === "setIncludeLocalChanges") {
          if (!context.workspacePath || await git(context.workspacePath, "branch", "--show-current") !== task.baseBranch) throw new Error("带入本地修改只允许选择当前分支");
          await save(() => { task.includeLocalChanges = value.value === "true"; });
        } else if (action.id === "start") {
          await launch(task, { locale: "zh-CN", query: task.instruction, selection: task.selection }, context);
        }
      },
      async render(request, context) {
        const id = (JSON.parse(request.tool?.result ?? "{}") as { taskId?: string }).taskId;
        const task = tasks.find(item => item.id === id && item.projectId === context.projectId);
        if (!task) return { title: "工作树草稿", children: [{ type: "text", text: "草稿不可用" }] };
        if (task.target) return { title: task.title, children: [{ type: "conversation-link", label: "打开工作树聊天", sessionId: task.target.sessionId }, ...(task.error ? [{ type: "text" as const, text: task.error }] : [])] };
        const bases = await branches(context.workspacePath), options = await api.options!(task.projectId);
        const models = options.models.flatMap(profile => profile.models.map(model => ({ label: `${profile.name} / ${model}`, value: JSON.stringify({ profileId: profile.profileId, model, reasoningEffort: profile.efforts?.[model]?.includes("medium") ? "medium" : profile.efforts?.[model]?.[0] ?? "medium" }) })));
        return { title: task.title, children: [
          { type: "text", text: task.instruction },
          { type: "select", label: "起点分支", action: "setBase", context: task.id, value: task.baseBranch ?? "__unselected__", options: [{ label: "请选择起点分支", value: "__unselected__" }, ...bases.map(branch => ({ label: branch.name, value: branch.name }))] },
          { type: "select", label: "模型", action: "setModel", context: task.id, value: task.selection ? JSON.stringify(task.selection) : "__unselected__", options: [{ label: "请选择模型", value: "__unselected__" }, ...models] },
          { type: "select", label: "带入本地修改（仅当前分支）", action: "setIncludeLocalChanges", context: task.id, value: String(!!task.includeLocalChanges), options: [{ label: "只用已提交版本", value: "false" }, { label: "带入当前分支本地修改", value: "true" }] },
          { type: "button", label: launching.has(task.id) ? "正在准备" : "开始工作树聊天", action: "start", value: task.id },
          ...(task.error ? [{ type: "text" as const, text: task.error }] : []),
        ] };
      },
    }],
  };
};
