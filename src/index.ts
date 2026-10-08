import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { declaredTool, type PluginContext, type PluginModule, type PluginUiNode, type ScheduledRunTarget, type ToolContext } from "@modera/plugin-sdk";
import manifest from "../plugin.json";
import { worktreeEnvironment } from "./environment";
import { applyTaskMerge, previewTaskMerge, type MergePreview } from "./merge";

const exec = promisify(execFile);
type Selection = ScheduledRunTarget["selection"];
type Models = Awaited<ReturnType<NonNullable<NonNullable<PluginContext["scheduling"]>["options"]>>>["models"];
type Task = { id: string; projectId: string; title: string; instruction?: string; draft?: true; base: string; baseBranch?: string; baseCommit?: string; taskBranch?: string; selection?: Selection; target?: ScheduledRunTarget; runId?: string; archived?: { branch: string; at: number }; merged?: { branch: string; commit: string; at: number }; mergeError?: string; error?: string; errorStage?: "prepare" | "start"; createdAt: number };
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
  if (state.version !== 1 || !Array.isArray(state.tasks)) throw new Error("工作树记录格式无效");
  const selectedModels = new Map<string, string>();
  const selectedBases = new Map<string, string>();
  const selectedTasks = new Map<string, string>();
  const taskPages = new Map<string, number>();
  const archiveConfirmations = new Map<string, string>();
  const mergeConfirmations = new Map<string, { taskId: string; preview: MergePreview }>();
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
      const [branch, commit] = await Promise.allSettled([
        exec("git", ["-C", path, "branch", "--show-current"], { timeout: 10000 }),
        exec("git", ["-C", path, "rev-parse", "--short", "HEAD"], { timeout: 10000 }),
      ]);
      if (branch.status !== "fulfilled" || commit.status !== "fulfilled") return "非 Git 项目";
      return `${branch.value.stdout.trim() || "分离提交"} · ${commit.value.stdout.trim()}`;
    } catch { return "非 Git 项目"; }
  };
  const bases = async (path?: string) => {
    if (!path) return [];
    try {
      const { stdout } = await exec("git", ["-C", path, "for-each-ref", "--format=%(refname:short)%00%(objectname)", "refs/heads"], { timeout: 10000, maxBuffer: 1024 * 1024 });
      return stdout.split(/\r?\n/).filter(Boolean).flatMap(line => {
        const [name, commit] = line.split("\0");
        return name && commit && /^[0-9a-f]{40,64}$/i.test(commit) ? [{ name, commit, value: JSON.stringify([name, commit]), label: `${name} · ${commit.slice(0, 8)}`.slice(0, 200) }] : [];
      });
    } catch { return []; }
  };
  const details = async (path: string, baseCommit?: string) => {
    try {
      const [branch, commit, changed] = await Promise.allSettled([
        exec("git", ["-C", path, "branch", "--show-current"], { timeout: 10000 }),
        exec("git", ["-C", path, "rev-parse", "HEAD"], { timeout: 10000 }),
        exec("git", ["-C", path, "status", "--short"], { timeout: 10000, maxBuffer: 65536 }),
      ]);
      if (branch.status !== "fulfilled" || commit.status !== "fulfilled" || changed.status !== "fulfilled") throw new Error("Git status unavailable");
      const summarize = (output: string, limit: number) => {
        const lines = output.trimEnd().split(/\r?\n/).filter(Boolean);
        return lines.length ? `${lines.slice(0, limit).join("\n").slice(0, 3000)}${lines.length > limit ? `\n…另外 ${lines.length - limit} 项` : ""}` : "无";
      };
      let committed = "起点提交未记录，无法比较旧任务的已提交改动。";
      if (baseCommit && /^[0-9a-f]{40,64}$/i.test(baseCommit)) {
        try {
          const [log, files] = await Promise.all([
            exec("git", ["-C", path, "log", "-10", "--format=%h %s", `${baseCommit}..HEAD`], { timeout: 10000, maxBuffer: 65536 }),
            exec("git", ["-C", path, "diff", "--name-status", baseCommit, "HEAD"], { timeout: 10000, maxBuffer: 65536 }),
          ]);
          committed = `任务提交（最近 10 条）：${summarize(log.stdout, 10) === "无" ? "无" : `\n${summarize(log.stdout, 10)}`}\n已提交文件改动：${files.stdout.trim() ? `\n${summarize(files.stdout, 20)}` : "无"}`;
        } catch { committed = "起点提交无法比较，请打开任务会话核实。"; }
      }
      return { text: `工作目录：${path}\n当前分支：${branch.value.stdout.trim() || "分离提交（未创建分支）"}\n当前提交：${commit.value.stdout.trim().slice(0, 12)}\n${committed}\n未提交文件改动：${changed.value.stdout.trim() ? `\n${summarize(changed.value.stdout, 20)}` : "无"}`, branch: branch.value.stdout.trim(), dirty: !!changed.value.stdout.trim(), hasCommits: baseCommit && /^[0-9a-f]{40,64}$/i.test(baseCommit) ? commit.value.stdout.trim() !== baseCommit : undefined };
    } catch { return { text: `工作目录：${path}\nGit 状态读取失败，请打开任务会话核实。`, dirty: undefined }; }
  };
  const archivedHasUnmergedCommits = async (projectPath: string, branch: string): Promise<boolean | undefined> => {
    if (!/^modera\/task-[0-9a-f]{24}$/.test(branch)) return undefined;
    try {
      const taskHead = (await exec("git", ["-C", projectPath, "rev-parse", "--verify", `refs/heads/${branch}^{commit}`], { timeout: 10000 })).stdout.trim();
      const mergeBase = (await exec("git", ["-C", projectPath, "merge-base", "HEAD", taskHead], { timeout: 10000 })).stdout.trim();
      return mergeBase !== taskHead;
    } catch { return undefined; }
  };
  const inspectTask = async (task: Task) => {
    if (!task.target) return undefined;
    // Native follow-ups keep the task conversation but receive a new run identity.
    const current = await host.scheduling!.inspect(task.target);
    if (current.runId && current.runId !== task.runId) {
      await save(() => { task.runId = current.runId; task.error = undefined; task.errorStage = undefined; });
      return current;
    }
    return task.runId ? host.scheduling!.inspect(task.target, task.runId) : current;
  };
  const launch = (task: Task, context: ToolContext) => {
    const selection = task.selection!;
    host.runBackground!({ ...context, label: `工作树：${task.title.slice(0, 120)}` }, async backgroundSignal => {
      const signal = AbortSignal.any([backgroundSignal, host.scopeSignal?.(task.projectId) ?? host.signal]);
      let stage: "prepare" | "start" = "prepare";
      try {
        const target = await host.scheduling!.prepare!(await host.scheduling!.target!(task.projectId, "", selection), task.title.slice(0, 120), true,
          { taskId: task.id, workbenchId: "modera.worktree.workbench", workspace: "git-worktree", ...(task.baseCommit ? { baseCommit: task.baseCommit } : {}), conversationMode: "native" });
        let baseCommit: string | undefined;
        let taskBranch: string | undefined;
        let allocatedBranch: string | undefined;
        try {
          const workspace = await host.scheduling!.workspace?.(target);
          if (workspace?.kind === "git-worktree") {
            allocatedBranch = workspace.branch;
            const [commit, branch] = await Promise.all([
              exec("git", ["-C", workspace.path, "rev-parse", "HEAD"], { timeout: 10000 }),
              exec("git", ["-C", workspace.path, "branch", "--show-current"], { timeout: 10000 }),
            ]);
            baseCommit = commit.stdout.trim(); taskBranch = branch.stdout.trim();
          }
        } catch { /* Status stays available even if the comparison base cannot be read. */ }
        if (task.baseCommit && baseCommit !== task.baseCommit) throw new Error("工作树起点提交与所选分支不一致，请核实任务工作目录");
        if (allocatedBranch && taskBranch !== allocatedBranch) throw new Error("工作树当前分支与宿主分配的任务分支不一致，请核实任务工作目录");
        await save(() => { task.target = target; task.baseCommit = baseCommit; task.taskBranch = taskBranch && /^modera\/task-[0-9a-f]{24}$/.test(taskBranch) ? taskBranch : undefined; });
        stage = "start";
        const started = await host.scheduling!.startRole!(target,
          { id: "worktree_worker", name: "工作树任务", prompt: "在当前工作目录完成用户任务。先检查实际仓库状态和分支；保存用户原有改动。完成修改和必要检查后，把本任务改动提交到当前任务分支；若无法提交，说明原因及剩余未提交文件。报告任务分支、提交、修改文件和实际检查结果。不要自行合并、推送或删除工作目录。", tools: "inherit", selection },
          task.instruction ?? task.title, signal, { workflowTools: ["ask_user_question"] });
        await save(() => { task.runId = started.runId; task.errorStage = undefined; });
      } catch (error) {
        await save(() => { task.error = String(error); task.errorStage = stage; });
      }
    });
  };
  const configure = async (projectId: string, workspacePath?: string) => {
    const capabilities = await host.scheduling!.options!(projectId);
    if (!capabilities.isolatedWorkspaces) throw new Error("此项目暂不支持工作树，请确认它是已有提交的 Git 仓库");
    const options = modelOptions(capabilities.models);
    const chosen = selectedModels.get(projectId);
    const selected = chosen ? options.find(item => item.value === chosen) : options[0];
    if (!selected) throw new Error(chosen ? "所选模型已不可用，请重新选择" : "请先配置可用模型");
    const optionsBase = await bases(workspacePath);
    const chosenBase = selectedBases.get(projectId);
    const activeBranch = (await base(workspacePath)).split(" · ")[0];
    const revision = chosenBase ? optionsBase.find(item => item.value === chosenBase) : optionsBase.find(item => item.name === activeBranch) ?? optionsBase[0];
    if (!revision && workspacePath) throw new Error("找不到可用的本地起点分支");
    if (chosenBase && !optionsBase.some(item => item.value === chosenBase)) throw new Error("所选起点分支已变化，请刷新后重新选择");
    return { selection: selected.selection, base: revision?.label ?? await base(workspacePath), baseBranch: revision?.name, baseCommit: revision?.commit };
  };
  const environment = await worktreeEnvironment(host, async (request, context, revision) => {
    if (!context.projectId || !request.selection) throw new Error("工作树配置不可用");
    const task: Task = { id: randomUUID(), projectId: context.projectId, title: (request.contextInput ?? request.query).trim().slice(0, 120), instruction: request.query, base: `${revision.name} · ${revision.commit.slice(0, 8)}`, baseBranch: revision.name, baseCommit: revision.commit, selection: request.selection, createdAt: Date.now() };
    await save(() => { state.tasks.unshift(task); });
    selectedTasks.set(task.projectId, task.id);
    try {
      const target = await host.scheduling!.prepare!(await host.scheduling!.target!(task.projectId, "", request.selection), task.title, true, { taskId: task.id, workbenchId: "modera.worktree.workbench", workspace: "git-worktree", baseCommit: revision.commit, conversationMode: "native" });
      const workspace = await host.scheduling!.workspace?.(target);
      if (!workspace || workspace.released) throw new Error("工作树目录分配失败");
      await save(() => { task.target = target; task.taskBranch = workspace.branch; });
      const started = await host.scheduling!.startRole!(target, { id: "worktree_worker", name: "工作树任务", prompt: "在当前独立工作树目录中完成用户任务。先检查仓库和分支，保留用户改动。完成修改和必要验证后提交到任务分支，报告实际结果。不要自行合并、推送或删除工作目录。", tools: "inherit", selection: request.selection }, request.query, AbortSignal.any([host.signal, host.scopeSignal?.(task.projectId) ?? host.signal]), { workflowTools: ["ask_user_question"], ...(request.attachmentIds ? { attachmentIds: request.attachmentIds } : {}), ...(request.contextMode ? { contextMode: request.contextMode, contextInput: request.contextInput! } : {}) });
      await save(() => { task.runId = started.runId; });
      return { sessionId: target.sessionId, runId: started.runId };
    } catch (error) {
      await save(() => { task.error = String(error); task.errorStage = task.target ? "start" : "prepare"; });
      throw error;
    }
  });
  return { composer: [environment.composer], tools: [{ definition: declaredTool(manifest, "worktree_draft"), async execute(raw, context) {
    if (!context.projectId) throw new Error("请选择 Git 项目");
    const input = raw as { title?: string; instruction?: string };
    const title = parseText(input.title);
    const instruction = parseText(input.instruction);
    if (title.length > 120) throw new Error("任务名称最多 120 字");
    const task: Task = { id: randomUUID(), projectId: context.projectId, title, instruction, draft: true, base: "待选择", createdAt: Date.now() };
    await save(() => { state.tasks.unshift(task); });
    selectedTasks.set(context.projectId, task.id); taskPages.set(context.projectId, 0);
    return { taskId: task.id, title, status: "draft", message: "草稿已保存，请在工作树工作台选择起点分支和模型并启动" };
  } }], ui: [{
    id: "modera.worktree.workbench", slot: "workbench",
    workbench: { title: "工作树", icon: "files", order: -102 },
    requiredPermissions: ["storage.read", "storage.write", "runs.schedule", "runs.delegate", "runs.observe", "workspace.read", "process.spawn"],
    actions: ["create", "startDraft", "retryPrepare", "refresh", "setModel", "setBase", "setBaseName", "showTask", "showPage", "requestArchive", "confirmArchive", "cancelArchive", "requestMerge", "confirmMerge", "cancelMerge"],
    async act(action, context) {
      if (action.id === "refresh") return;
      if (["requestMerge", "confirmMerge", "cancelMerge"].includes(action.id)) {
        if (!context.projectId || !context.workspacePath) throw new Error("请选择 Git 项目");
        const task = state.tasks.find(item => item.projectId === context.projectId && item.id === action.value);
        if (!task?.target || !task.runId || task.merged || !host.scheduling!.workspace) throw new Error("此任务无法合并");
        if (action.id === "cancelMerge") { mergeConfirmations.delete(context.projectId); host.invalidateUi?.(); return; }
        const inspected = await inspectTask(task);
        if (inspected?.outcome !== "completed" || inspected.busy || inspected.waitingForInput) throw new Error("请等待任务完成后再合并");
        const workspace = await host.scheduling!.workspace(task.target);
        if (workspace?.kind !== "git-worktree") throw new Error("任务工作目录归属无法核实");
        if (workspace.branch && ((task.taskBranch && workspace.branch !== task.taskBranch) || (task.archived?.branch && workspace.branch !== task.archived.branch)))
          throw new Error("宿主记录与任务记录的分支不一致，请核实后再合并");
        const archivedBranch = workspace.branch ?? task.archived?.branch ?? task.taskBranch;
        const input = { projectPath: context.workspacePath, baseBranch: task.baseBranch ?? task.base.split(" · ")[0]!, expectedTaskBranch: workspace.branch ?? task.taskBranch ?? task.archived?.branch, ...(workspace.released ? { archivedBranch } : { taskPath: workspace.path }) };
        if (workspace.released && !archivedBranch) throw new Error("归档任务的分支无法核实");
        if (action.id === "requestMerge") {
          const preview = await previewTaskMerge(input);
          mergeConfirmations.set(context.projectId, { taskId: task.id, preview });
          host.invalidateUi?.();
          return;
        }
        const pending = mergeConfirmations.get(context.projectId);
        if (!pending || pending.taskId !== task.id) throw new Error("请先预览合并内容");
        mergeConfirmations.delete(context.projectId);
        try {
          const result = await applyTaskMerge(input, pending.preview);
          await save(() => { task.merged = { ...result, at: Date.now() }; task.mergeError = undefined; });
        } catch (error) { await save(() => { task.mergeError = String(error).slice(0, 1500); }); throw error; }
        return;
      }
      if (["requestArchive", "confirmArchive", "cancelArchive"].includes(action.id)) {
        if (!context.projectId) throw new Error("请选择项目");
        const task = state.tasks.find(item => item.projectId === context.projectId && item.id === action.value);
        if (!task?.target || !task.runId || task.archived || !host.scheduling!.archiveWorkspace) throw new Error("此任务无法归档工作树");
        if (action.id === "cancelArchive") { archiveConfirmations.delete(context.projectId); host.invalidateUi?.(); return; }
        const inspected = await inspectTask(task);
        if (inspected?.outcome !== "completed" || inspected.busy || inspected.waitingForInput) throw new Error("请等待任务完成后再归档");
        const workspace = await host.scheduling!.workspace?.(task.target);
        if (workspace?.kind !== "git-worktree" || workspace.released) throw new Error("工作树已归档或不可用");
        if (action.id === "requestArchive") { archiveConfirmations.set(context.projectId, task.id); host.invalidateUi?.(); return; }
        if (archiveConfirmations.get(context.projectId) !== task.id) throw new Error("请先确认归档范围");
        archiveConfirmations.delete(context.projectId);
        const result = await host.scheduling!.archiveWorkspace(task.target);
        await save(() => { task.archived = { branch: result.branch, at: Date.now() }; });
        return;
      }
      if (action.id === "retryPrepare") {
        if (!context.projectId) throw new Error("请选择 Git 项目");
        const task = state.tasks.find(item => item.projectId === context.projectId && item.id === action.value);
        if (!task || task.errorStage !== "prepare" || task.target || task.runId || !task.selection) throw new Error("此任务的启动状态不能安全重试，请核实任务会话");
        const capabilities = await host.scheduling!.options!(task.projectId);
        if (!capabilities.isolatedWorkspaces || !modelOptions(capabilities.models).some(item => item.selection.profileId === task.selection!.profileId && item.selection.model === task.selection!.model && item.selection.reasoningEffort === task.selection!.reasoningEffort))
          throw new Error("工作树或执行模型已不可用");
        await save(() => { if (task.errorStage !== "prepare" || task.target || task.runId) throw new Error("任务状态已变化"); task.error = undefined; task.errorStage = undefined; });
        launch(task, context);
        return;
      }
      if (action.id === "showTask") {
        if (!context.projectId || !state.tasks.some(item => item.projectId === context.projectId && item.id === action.value)) throw new Error("当前项目中找不到该任务");
        selectedTasks.set(context.projectId, action.value!);
        host.invalidateUi?.();
        return;
      }
      if (action.id === "showPage") {
        if (!context.projectId) throw new Error("请选择项目");
        const count = state.tasks.filter(item => item.projectId === context.projectId).length;
        const page = Number(action.value);
        if (!Number.isInteger(page) || page < 0 || page >= Math.ceil(count / 10)) throw new Error("任务页码无效");
        taskPages.set(context.projectId, page);
        selectedTasks.delete(context.projectId);
        host.invalidateUi?.();
        return;
      }
      if (action.id === "setModel") {
        if (!context.projectId) throw new Error("请选择 Git 项目");
        const input = JSON.parse(action.value ?? "{}") as { value?: string };
        const options = modelOptions((await host.scheduling!.options!(context.projectId)).models);
        if (!options.some(item => item.value === input.value)) throw new Error("所选模型已不可用");
        selectedModels.set(context.projectId, input.value!);
        host.invalidateUi?.();
        return;
      }
      if (action.id === "setBase") {
        if (!context.projectId) throw new Error("请选择 Git 项目");
        const input = JSON.parse(action.value ?? "{}") as { value?: string };
        const options = await bases(context.workspacePath);
        if (!options.some(item => item.value === input.value)) throw new Error("所选起点分支已变化，请刷新后重新选择");
        selectedBases.set(context.projectId, input.value!);
        host.invalidateUi?.();
        return;
      }
      if (action.id === "setBaseName") {
        if (!context.projectId) throw new Error("请选择 Git 项目");
        const name = action.value?.trim();
        const options = await bases(context.workspacePath);
        const branch = options.find(item => item.name === name);
        if (!branch) throw new Error("找不到这个本地分支，请输入完整分支名");
        selectedBases.set(context.projectId, branch.value);
        host.invalidateUi?.();
        return;
      }
      if (action.id === "startDraft") {
        if (!context.projectId) throw new Error("请选择 Git 项目");
        const task = state.tasks.find(item => item.projectId === context.projectId && item.id === action.value);
        if (!task?.draft || task.target || task.runId) throw new Error("当前项目中找不到可启动的任务草稿");
        const configuration = await configure(context.projectId, context.workspacePath);
        await save(() => {
          if (!task.draft || task.target || task.runId) throw new Error("任务状态已变化");
          task.draft = undefined; task.base = configuration.base; task.baseBranch = configuration.baseBranch; task.baseCommit = configuration.baseCommit; task.selection = configuration.selection;
        });
        selectedTasks.set(context.projectId, task.id);
        launch(task, context);
        return;
      }
      if (action.id !== "create" || !context.projectId) throw new Error("请选择 Git 项目");
      const title = parseText(action.value);
      const configuration = await configure(context.projectId, context.workspacePath);
      const task: Task = { id: randomUUID(), projectId: context.projectId, title, base: configuration.base, ...(configuration.baseBranch ? { baseBranch: configuration.baseBranch } : {}), ...(configuration.baseCommit ? { baseCommit: configuration.baseCommit } : {}), selection: configuration.selection, createdAt: Date.now() };
      await save(() => { state.tasks.unshift(task); });
      selectedTasks.set(context.projectId, task.id);
      taskPages.set(context.projectId, 0);
      launch(task, context);
    },
    async render(_request, context) {
      if (!context.projectId) return { title: "工作树", children: [{ type: "text", text: "请先选择一个项目。" }] };
      const projectId = context.projectId;
      const capabilities = await host.scheduling!.options!(projectId);
      const models = modelOptions(capabilities.models);
      const chosen = selectedModels.get(projectId);
      const selected = chosen && models.some(item => item.value === chosen) ? chosen : models[0]?.value;
      const visibleModels = models.slice(0, 100);
      if (selected && !visibleModels.some(item => item.value === selected)) visibleModels[99] = models.find(item => item.value === selected)!;
      const currentBase = await base(context.workspacePath);
      const branchOptions = await bases(context.workspacePath);
      const chosenBase = selectedBases.get(projectId);
      const currentBranch = currentBase.split(" · ")[0];
      const defaultBranch = branchOptions.find(item => item.name === currentBranch) ?? branchOptions[0];
      const selectedBase = chosenBase && branchOptions.some(item => item.value === chosenBase) ? chosenBase : defaultBranch?.value;
      const visibleBranches = branchOptions.slice(0, 100);
      const selectedBranch = branchOptions.find(item => item.value === selectedBase);
      if (selectedBranch && !visibleBranches.some(item => item.value === selectedBase)) visibleBranches[99] = selectedBranch;
      const children: PluginUiNode[] = [
        { type: "text", text: "选择一个本地分支的已提交版本作为起点。创建并启动后会生成独立 Git 工作目录及自动命名的本地任务分支（modera/task-…）。当前目录的未提交改动不会带入；任务完成后不会自动合并或推送。也可在聊天输入 /worktree 开启工作树模式，直接发送任务。" },
        ...(branchOptions.length ? [{ type: "select" as const, label: "起点分支与提交", action: "setBase", value: selectedBase!, options: visibleBranches.map(({ value, label }) => ({ value, label })) }] : [{ type: "text" as const, text: `找不到本地分支；当前 Git 状态：${currentBase}` }]),
        ...(branchOptions.length > 100 ? [{ type: "form" as const, label: `本地分支共 ${branchOptions.length} 个；输入完整分支名选择未列出的分支`, placeholder: "例如：feature/login", action: "setBaseName", maxLength: 200 }] : []),
        ...(chosenBase && chosenBase !== selectedBase ? [{ type: "text" as const, text: "之前选择的起点分支已变化，请重新选择后创建任务。" }] : []),
        ...(models.length ? [{ type: "select" as const, label: "执行模型", action: "setModel", value: selected ?? models[0]!.value, options: visibleModels.map(({ value, label }) => ({ value, label })) }] : [{ type: "text" as const, text: "请先配置可用模型" }]),
        ...(chosen && chosen !== selected ? [{ type: "text" as const, text: "之前选择的模型已不可用，请重新选择后创建任务。" }] : []),
        ...(capabilities.isolatedWorkspaces ? [{ type: "form" as const, label: "创建并启动工作树任务", placeholder: "例如：修复登录后页面空白，并运行相关检查", action: "create", maxLength: 4000 }] : [{ type: "text" as const, text: "此项目不能创建工作树：需要一个已有提交的 Git 仓库。" }]),
        { type: "button", label: "刷新任务状态", action: "refresh" },
      ];
      const tasks = state.tasks.filter(item => item.projectId === projectId);
      const page = Math.min(taskPages.get(projectId) ?? 0, Math.max(0, Math.ceil(tasks.length / 10) - 1));
      const visibleTasks = tasks.slice(page * 10, page * 10 + 10);
      const selectedTask = visibleTasks.find(item => item.id === selectedTasks.get(projectId)) ?? visibleTasks[0];
      const taskStatuses = await Promise.all(visibleTasks.map(async task => {
        let status = task.draft ? "待确认" : task.error ? "启动失败" : task.runId ? "运行中" : "准备中";
        if (task.target) {
          try {
            const inspected = await inspectTask(task);
            if (inspected?.runId || task.runId) status = inspected?.waitingForInput ? "等待你的答复" : outcomeLabels[inspected?.outcome ?? "unknown"] ?? "状态待核实";
          }
          catch { status = "状态待核实"; }
        }
        return status;
      }));
      if (tasks.length) {
        children.push({ type: "text", text: `任务记录 · ${tasks.length} 项 · 第 ${page + 1}/${Math.ceil(tasks.length / 10)} 页` });
        children.push(...visibleTasks.map((task, index): PluginUiNode => ({ type: "button", label: `${task.title.slice(0, 70)} · ${taskStatuses[index]}${task.id === selectedTask?.id ? " ✓" : ""}`, action: "showTask", value: task.id })));
        if (tasks.length > 10) children.push({ type: "row", children: [
          ...(page > 0 ? [{ type: "button" as const, label: "上一页", action: "showPage", value: String(page - 1) }] : []),
          ...(page < Math.ceil(tasks.length / 10) - 1 ? [{ type: "button" as const, label: "下一页", action: "showPage", value: String(page + 1) }] : []),
        ] });
      }
      if (selectedTask) {
        let workspace = "";
        let workspaceReleased = !!selectedTask.archived;
        let workspaceDirty: boolean | undefined;
        let workspaceHasCommits: boolean | undefined;
        let workspaceBranch: string | undefined;
        let assignedBranch: string | undefined;
        let result = "";
        if (selectedTask.target && host.scheduling!.workspace) {
          try {
            const allocated = await host.scheduling!.workspace(selectedTask.target);
            if (allocated?.kind === "git-worktree") {
              assignedBranch = allocated.branch;
              workspaceReleased = !!allocated.released;
              if (allocated.released) {
                const branch = allocated.branch ?? selectedTask.archived?.branch ?? selectedTask.taskBranch;
                workspace = `工作树已归档；本地任务分支：${branch ?? "请在 Git 分支列表核实"}。任务会话和结果仍可查看。`;
                if (context.workspacePath && currentBranch === (selectedTask.baseBranch ?? selectedTask.base.split(" · ")[0]) && branch)
                  workspaceHasCommits = await archivedHasUnmergedCommits(context.workspacePath, branch);
              }
              else { const detail = await details(allocated.path, selectedTask.baseCommit); workspace = detail.text; workspaceBranch = detail.branch; workspaceDirty = detail.dirty; workspaceHasCommits = detail.hasCommits; }
            }
          } catch { workspace = "工作目录归属或路径待核实。"; }
        }
        if (selectedTask.target && selectedTask.runId && taskStatuses[visibleTasks.indexOf(selectedTask)] === "已完成") {
          try { result = (await host.scheduling!.result!(selectedTask.target, selectedTask.runId)).text.slice(0, 1500); }
          catch { result = "任务结果读取失败，请打开任务会话核实。"; }
        }
        const status = taskStatuses[visibleTasks.indexOf(selectedTask)];
        children.push({ type: "document", label: `${selectedTask.title.slice(0, 90)} · ${status}`, text: `${selectedTask.instruction ? `任务要求：${selectedTask.instruction}\n` : ""}起点：${selectedTask.base}${selectedTask.selection ? `\n执行模型：${selectedTask.selection.model}` : ""}${workspace ? `\n${workspace}` : ""}${selectedTask.error ? `\n${selectedTask.error}` : ""}${result ? `\n\n任务结果：${result}` : ""}${status === "等待你的答复" ? "\n\n请打开任务会话回答问题。" : ""}` });
        if (status === "已完成" && workspaceDirty) children.push({ type: "text", text: "任务工作目录仍有未提交改动。请打开任务会话检查并提交到当前任务分支，然后刷新状态；提交前不能合并或归档工作树。" });
        if (selectedTask.draft) children.push({ type: "button", label: "按上方起点分支和模型启动此任务", action: "startDraft", value: selectedTask.id });
        if (selectedTask.errorStage === "prepare" && !selectedTask.target && !selectedTask.runId) children.push({ type: "button", label: "重新准备此任务", action: "retryPrepare", value: selectedTask.id });
        if (selectedTask.errorStage === "start" && !selectedTask.runId) children.push({ type: "text", text: "启动请求的结果无法确认，请先打开任务会话核实，避免重复执行。" });
        if (selectedTask.merged) children.push({ type: "text", text: `已合并到项目分支 ${selectedTask.merged.branch} · ${selectedTask.merged.commit.slice(0, 12)}。请在项目目录运行需要的检查。` });
        if (selectedTask.mergeError) children.push({ type: "text", text: `上次合并未完成：${selectedTask.mergeError}。请检查项目目录的 Git 状态；若出现冲突，先处理冲突再继续。` });
        const mergeBaseBranch = selectedTask.baseBranch ?? selectedTask.base.split(" · ")[0];
        const wrongMergeBranch = currentBranch !== mergeBaseBranch;
        const expectedTaskBranch = assignedBranch ?? selectedTask.taskBranch;
        const branchRecordsDisagree = !!assignedBranch && ((!!selectedTask.taskBranch && assignedBranch !== selectedTask.taskBranch) || (!!selectedTask.archived?.branch && assignedBranch !== selectedTask.archived.branch));
        const wrongTaskBranch = !workspaceReleased && !!expectedTaskBranch && workspaceBranch !== expectedTaskBranch;
        if (selectedTask.target && selectedTask.runId && status === "已完成" && !selectedTask.merged && branchRecordsDisagree)
          children.push({ type: "text", text: "宿主工作目录与任务记录的分支不一致。请在 Git 工具中核实并手动处理合并；工作台不会对身份不明的分支执行合并。" });
        if (selectedTask.target && selectedTask.runId && status === "已完成" && !selectedTask.merged && wrongTaskBranch)
          children.push({ type: "text", text: `任务工作目录不在创建时的分支「${expectedTaskBranch}」。请切回该任务分支，核实提交后再预览合并。` });
        if (selectedTask.target && selectedTask.runId && status === "已完成" && !selectedTask.merged && !workspaceDirty && context.workspacePath && wrongMergeBranch)
          children.push({ type: "text", text: `此任务从「${mergeBaseBranch}」创建；当前项目在「${currentBranch}」。请先在项目目录切回「${mergeBaseBranch}」，再预览合并。` });
        if (selectedTask.target && selectedTask.runId && status === "已完成" && !selectedTask.merged && !workspaceDirty && workspaceHasCommits === false)
          children.push({ type: "text", text: workspaceReleased ? "任务分支没有尚未合入的提交，因此无需再次合并。保留的本地分支可在 Git 工具中查看或清理。" : "任务分支尚无新提交，因此没有可合并的内容。若任务修改了文件，请在任务会话提交后刷新；无需合并时可以归档工作树。" });
        if (selectedTask.target && selectedTask.runId && status === "已完成" && !selectedTask.merged && !workspaceDirty && context.workspacePath && !wrongMergeBranch && !wrongTaskBranch && !branchRecordsDisagree && workspaceHasCommits !== false) {
          const pending = mergeConfirmations.get(projectId);
          if (pending?.taskId === selectedTask.id) {
            children.push({ type: "document", label: "合并预览", previewText: `项目分支：${pending.preview.sourceBranch} · ${pending.preview.sourceHead.slice(0, 12)}\n任务分支：${pending.preview.taskBranch} · ${pending.preview.taskHead.slice(0, 12)}\n合并后改动：${(pending.preview.changeSummary || "无").slice(0, 1200)}\n展开查看任务提交、文件和完整差异，再确认合并。`, expandLabel: "展开查看完整合并预览", collapseLabel: "收起合并预览", text: `项目分支：${pending.preview.sourceBranch} · ${pending.preview.sourceHead.slice(0, 12)}\n任务分支：${pending.preview.taskBranch} · ${pending.preview.taskHead.slice(0, 12)}\n任务提交（最近 10 条）：\n${pending.preview.commits || "无"}\n任务改动文件：\n${pending.preview.files || "无"}\n\n合并后相对当前项目提交的改动：\n${pending.preview.changeSummary || "无"}\n\n改动内容预览：\n${pending.preview.patch || "无文本差异"}${pending.preview.patchTruncated ? "\n\n预览内容已截断或无法完整读取；确认前请用 Git 工具查看完整差异。" : ""}\n\n确认后将向当前项目分支创建合并提交。若 Git 报错或出现冲突，会保留现场供你处理。` });
            children.push({ type: "row", children: [{ type: "button", label: "确认合并到项目分支", action: "confirmMerge", value: selectedTask.id }, { type: "button", label: "取消合并", action: "cancelMerge", value: selectedTask.id }] });
          } else children.push({ type: "button", label: "预览合并到项目分支", action: "requestMerge", value: selectedTask.id });
        }
        if (selectedTask.target && selectedTask.runId && status === "已完成" && !workspaceReleased && !workspaceDirty && host.scheduling!.archiveWorkspace) {
          if (archiveConfirmations.get(projectId) === selectedTask.id) {
            children.push({ type: "text", text: "确认归档：将移除这个任务的干净工作目录，保留本地任务分支和已提交内容。任务会话保留供查看，不能继续在此工作目录运行。若有未提交或忽略的文件，归档会失败并保留目录。" });
            children.push({ type: "row", children: [{ type: "button", label: "确认归档工作树", action: "confirmArchive", value: selectedTask.id }, { type: "button", label: "取消", action: "cancelArchive", value: selectedTask.id }] });
          } else children.push({ type: "button", label: "归档工作树", action: "requestArchive", value: selectedTask.id });
        }
        if (selectedTask.target?.sessionId) children.push({ type: "conversation-link", label: workspaceDirty ? "打开任务会话，检查并提交改动" : "打开任务会话并查看改动", sessionId: selectedTask.target.sessionId });
      }
      return { title: "工作树", children };
    },
  }, {
    id: "modera.worktree.result", slot: "tool.result", toolNames: ["worktree_draft"], requiredPermissions: ["storage.read", "storage.write"],
    async render(request, context) {
      const result = request.tool?.result ? JSON.parse(request.tool.result) as { taskId?: string } : {};
      const task = result.taskId && context.projectId ? state.tasks.find(item => item.id === result.taskId && item.projectId === context.projectId) : undefined;
      return { title: "工作树任务草稿", children: task ? [
        { type: "text", text: `${task.title} · ${task.draft ? "待选择起点分支和模型" : "已开始或已完成"}` },
        { type: "open-slot", label: "打开工作树工作台", target: "modera.worktree.workbench" },
      ] : [{ type: "text", text: "草稿记录不可用，请打开工作树工作台核实。" }] };
    },
  }, environment.ui] };
};
