import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { afterEach, expect, test } from "vitest";
import type { PluginContext, ToolContext } from "@modera/plugin-sdk";
import { activate } from "../src/index";

const roots: string[] = [];
const exec = promisify(execFile);
afterEach(async () => { for (const path of roots.splice(0)) await rm(path, { recursive: true, force: true }); });

test("native follow-up run becomes the task's current result and permits archive", async () => {
  const root = await mkdtemp(join(tmpdir(), "modera-worktree-followup-"));
  roots.push(root);
  const target = { projectId: "project", sessionId: "task-session" };
  await writeFile(join(root, "tasks.json"), JSON.stringify({ version: 1, tasks: [{ id: "task", projectId: "project", title: "Fix bug", base: "main", target, runId: "first-run", createdAt: 1 }] }));
  let archived = false;
  const host = { storagePath: root, signal: new AbortController().signal, invalidateUi() {}, runBackground() {}, scheduling: {
    options: async () => ({ isolatedWorkspaces: true, models: [] }), target() {}, prepare() {}, startRole() {},
    inspect: async (_target: unknown, runId?: string) => runId === "first-run" ? { outcome: "unknown", busy: false } : { outcome: "completed", runId: "followup-run", busy: false },
    result: async (_target: unknown, runId: string) => ({ outcome: "completed", text: `Latest result from ${runId}` }),
    workspace: async () => ({ kind: "git-worktree", path: root, ...(archived ? { released: true } : {}) }),
    archiveWorkspace: async () => { archived = true; return { branch: "modera/task-followup" }; },
  } } as unknown as PluginContext;
  const workbench = (await activate(host))?.ui?.[0];
  if (!workbench?.act || !workbench.render) throw new Error("Worktree workbench missing");
  const context = { projectId: "project", signal: host.signal } as ToolContext;
  const request = { id: workbench.id, sessionId: "", projectId: "project", locale: "zh-CN" };
  const view = await workbench.render(request, context);
  expect(JSON.stringify(view.children)).toContain("Latest result from followup-run");
  expect(JSON.stringify(view.children)).toContain("归档工作树");
  expect(JSON.parse(await readFile(join(root, "tasks.json"), "utf8")).tasks[0].runId).toBe("followup-run");
  await workbench.act({ id: "requestArchive", value: "task" }, context, request);
  await workbench.act({ id: "confirmArchive", value: "task" }, context, request);
  expect(archived).toBe(true);
});

test("worktree task requests host allocation and keeps a project lifetime signal", async () => {
  const root = await mkdtemp(join(tmpdir(), "modera-worktree-plugin-test-"));
  roots.push(root);
  const checkout = join(root, "checkout");
  await mkdir(checkout);
  const git = (...args: string[]) => exec("git", ["-C", checkout, ...args]);
  await git("init", "-q");
  await git("config", "user.name", "Test");
  await git("config", "user.email", "test@example.invalid");
  await writeFile(join(checkout, "file.txt"), "committed");
  await git("add", "file.txt");
  await git("commit", "-qm", "seed");
  await git("branch", "alternate");
  await writeFile(join(checkout, "file.txt"), "modified");
  const uiController = new AbortController();
  const projectController = new AbortController();
  let background: Promise<void> | undefined;
  let source: unknown;
  let actualSelection: unknown;
  let runSignal: AbortSignal | undefined;
  let workerPrompt = "";
  const host = {
    storagePath: root,
    signal: new AbortController().signal,
    scopeSignal: () => projectController.signal,
    invalidateUi() {},
    runBackground(_context: unknown, task: (signal: AbortSignal) => Promise<void>) { background = task(new AbortController().signal); },
    scheduling: {
      options: async () => ({ isolatedWorkspaces: true, models: [{ profileId: "local", name: "Local", models: ["test-model", "other-model"], efforts: { "test-model": ["medium"], "other-model": ["high"] } }] }),
      target: async (projectId: string, sessionId: string, selection: unknown) => { actualSelection = selection; return { projectId, sessionId, selection }; },
      prepare: async (target: object, _title: string, _fresh: boolean, taskSource: unknown) => { source = taskSource; return { ...target, sessionId: "task-session" }; },
      workspace: async () => ({ kind: "git-worktree", path: checkout }),
      startRole: async (_target: unknown, role: { prompt: string }, _prompt: string, signal: AbortSignal) => { workerPrompt = role.prompt; runSignal = signal; return { runId: "task-run" }; },
      inspect: async () => ({ outcome: "completed" }),
      result: async () => ({ outcome: "completed", text: "Changed two files and ran checks" }),
    },
  } as unknown as PluginContext;
  const contributions = await activate(host);
  const workbench = contributions?.ui?.[0];
  if (!workbench?.act || !workbench.render) throw new Error("Worktree workbench missing");
  const context = { projectId: "project", sessionId: "parent", workspacePath: checkout, signal: uiController.signal } as ToolContext;
  const initial = await workbench.render({ id: workbench.id, sessionId: "", projectId: "project", locale: "zh-CN" }, context);
  const selector = initial.children.find(node => node.type === "select" && node.action === "setModel");
  if (!selector) throw new Error("Worktree model selector missing");
  const baseSelector = initial.children.find(node => node.type === "select" && node.action === "setBase");
  if (baseSelector?.type !== "select") throw new Error("Worktree base selector missing");
  const alternate = baseSelector.options.find(option => option.label.startsWith("alternate · "));
  expect(alternate).toBeDefined();
  await workbench.act({ id: "setBase", value: JSON.stringify({ value: alternate!.value }) }, context, { id: workbench.id, sessionId: "", projectId: "project", locale: "zh-CN" });
  await expect(workbench.act({ id: "setModel", value: JSON.stringify({ value: "forged" }) }, context, { id: workbench.id, sessionId: "", projectId: "project", locale: "zh-CN" })).rejects.toThrow("模型已不可用");
  await workbench.act({ id: "setModel", value: JSON.stringify({ value: selector.options[1]!.value }) }, context, { id: workbench.id, sessionId: "", projectId: "project", locale: "zh-CN" });
  await workbench.act({ id: "create", value: "Fix the issue" }, context, { id: workbench.id, sessionId: "", projectId: "project", locale: "zh-CN" });
  await background;
  await git("add", "file.txt");
  await git("commit", "-qm", "implement task change");
  expect(actualSelection).toMatchObject({ profileId: "local", model: "other-model", reasoningEffort: "high" });
  expect(workerPrompt).toContain("提交到当前任务分支");
  expect(source).toMatchObject({ workspace: "git-worktree", conversationMode: "native", workbenchId: workbench.id, baseCommit: expect.stringMatching(/^[0-9a-f]{40}$/) });
  expect(JSON.parse(await readFile(join(root, "tasks.json"), "utf8")).tasks[0].base).toMatch(/^alternate · /);
  uiController.abort();
  expect(runSignal?.aborted).toBe(false);
  projectController.abort();
  expect(runSignal?.aborted).toBe(true);
  const view = await workbench.render({ id: workbench.id, sessionId: "", projectId: "project", locale: "zh-CN" }, context);
  expect(JSON.stringify(view.children)).toContain("task-session");
  expect(JSON.stringify(view.children)).toContain("Changed two files and ran checks");
  expect(JSON.stringify(view.children)).toContain("执行模型：other-model");
  expect(JSON.stringify(view.children)).toContain("任务提交（最近 10 条）");
  expect(JSON.stringify(view.children)).toContain("implement task change");
  expect(JSON.stringify(view.children)).toContain("已提交文件改动");
  expect(JSON.stringify(view.children)).toContain("未提交文件改动：无");
  expect(view.children.some(node => node.type === "document" && node.text.includes(checkout))).toBe(true);
  expect(JSON.stringify(view.children)).toContain("file.txt");
  const recordFile = join(root, "tasks.json");
  const oldState = JSON.parse(await readFile(recordFile, "utf8")) as { tasks: { baseCommit?: string }[] };
  delete oldState.tasks[0]!.baseCommit;
  await writeFile(recordFile, JSON.stringify(oldState));
  const legacy = (await activate(host))?.ui?.[0];
  const legacyView = await legacy?.render?.({ id: workbench.id, sessionId: "", projectId: "project", locale: "zh-CN" }, context);
  expect(JSON.stringify(legacyView?.children)).toContain("起点提交未记录");
});

test("completed task requires confirmation to archive and keeps its conversation visible", async () => {
  const root = await mkdtemp(join(tmpdir(), "modera-worktree-archive-ui-"));
  roots.push(root);
  const target = { projectId: "project", sessionId: "task-session" };
  await writeFile(join(root, "tasks.json"), JSON.stringify({ version: 1, tasks: [{ id: "task", projectId: "project", title: "Fix bug", base: "main", target, runId: "run", createdAt: 1 }] }));
  let released = false;
  let archiveCalls = 0;
  const host = { storagePath: root, signal: new AbortController().signal, invalidateUi() {}, runBackground() {}, scheduling: {
    options: async () => ({ isolatedWorkspaces: true, models: [] }), target() {}, prepare() {}, startRole() {}, result: async () => ({ text: "Done" }),
    inspect: async () => ({ outcome: "completed", busy: false }), workspace: async () => ({ kind: "git-worktree", path: root, ...(released ? { released: true } : {}) }),
    archiveWorkspace: async () => { archiveCalls++; released = true; return { branch: "modera/task-123" }; },
  } } as unknown as PluginContext;
  const workbench = (await activate(host))?.ui?.[0];
  if (!workbench?.act || !workbench.render) throw new Error("Worktree workbench missing");
  const request = { id: workbench.id, sessionId: "", projectId: "project", locale: "zh-CN" };
  const context = { projectId: "project", signal: host.signal } as ToolContext;
  await expect(workbench.act({ id: "confirmArchive", value: "task" }, context, request)).rejects.toThrow("先确认");
  await workbench.act({ id: "requestArchive", value: "task" }, context, request);
  expect(JSON.stringify((await workbench.render(request, context)).children)).toContain("确认归档工作树");
  expect(archiveCalls).toBe(0);
  await workbench.act({ id: "confirmArchive", value: "task" }, context, request);
  expect(archiveCalls).toBe(1);
  const view = await workbench.render(request, context);
  expect(JSON.stringify(view.children)).toContain("modera/task-123");
  expect(JSON.stringify(view.children)).toContain("task-session");
  expect(JSON.stringify(view.children)).not.toContain("确认归档工作树");
});

test("slash command configures worktree mode while explicit task drafts remain available", async () => {
  const root = await mkdtemp(join(tmpdir(), "modera-worktree-draft-"));
  roots.push(root);
  let background: Promise<void> | undefined;
  let startedPrompt = "";
  const host = { storagePath: root, signal: new AbortController().signal, invalidateUi() {},
    runBackground(_context: unknown, task: (signal: AbortSignal) => Promise<void>) { background = task(new AbortController().signal); },
    scheduling: {
      options: async () => ({ isolatedWorkspaces: true, models: [{ profileId: "local", name: "Local", models: ["test"], efforts: { test: ["medium"] } }] }),
      target: async (projectId: string, sessionId: string, selection: unknown) => ({ projectId, sessionId, selection }),
      prepare: async (target: object) => ({ ...target, sessionId: "draft-session" }),
      startRole: async (_target: unknown, _role: unknown, prompt: string) => { startedPrompt = prompt; return { runId: "run" }; },
      inspect: async () => ({ outcome: "completed" }), result: async () => ({ text: "Done" }),
    },
  } as unknown as PluginContext;
  const contributions = await activate(host);
  const command = contributions?.composer?.[0];
  const tool = contributions?.tools?.[0];
  const workbench = contributions?.ui?.find(item => item.id === "modera.worktree.workbench");
  const resultCard = contributions?.ui?.find(item => item.id === "modera.worktree.result");
  if (!command?.execute || !tool || !workbench?.act || !workbench.render || !resultCard?.render) throw new Error("Worktree draft contributions missing");
  const context = { projectId: "project", signal: host.signal } as ToolContext;
  const request = { id: workbench.id, projectId: "project", sessionId: "", locale: "zh-CN" };
  expect(await command.execute({ locale: "zh-CN", query: "Fix login" }, { ...context, workspacePath: root })).toEqual([{ type: "configure", uiId: "modera.worktree.environment" }]);
  const created = await tool.execute({ title: "Fix login", instruction: "Fix login and run the focused checks" }, context) as { taskId: string };
  expect(background).toBeUndefined();
  const draft = await workbench.render(request, context);
  expect(JSON.stringify(draft.children)).toContain("待确认");
  expect(JSON.stringify(draft.children)).toContain("按上方起点分支和模型启动此任务");
  const card = await resultCard.render({ id: resultCard.id, projectId: "project", sessionId: "", locale: "zh-CN", tool: { result: JSON.stringify(created) } }, context);
  expect(card.children.some(node => node.type === "open-slot" && node.target === workbench.id)).toBe(true);
  await expect(workbench.act({ id: "startDraft", value: created.taskId }, { ...context, projectId: "other" }, request)).rejects.toThrow("找不到");
  await workbench.act({ id: "startDraft", value: created.taskId }, context, request);
  await background;
  expect(startedPrompt).toBe("Fix login and run the focused checks");
  await expect(workbench.act({ id: "startDraft", value: created.taskId }, context, request)).rejects.toThrow("找不到");
});

test("completed task previews and explicitly merges its branch into the project", async () => {
  const root = await mkdtemp(join(tmpdir(), "modera-worktree-merge-ui-"));
  roots.push(root);
  const source = join(root, "project"), taskPath = join(root, "task");
  await mkdir(source);
  const gitAt = (path: string, ...args: string[]) => exec("git", ["-C", path, ...args]);
  await gitAt(source, "init", "-q");
  await gitAt(source, "config", "user.name", "Test");
  await gitAt(source, "config", "user.email", "test@example.invalid");
  await writeFile(join(source, "base.txt"), "seed");
  await gitAt(source, "add", ".");
  await gitAt(source, "commit", "-qm", "seed");
  const baseBranch = (await gitAt(source, "branch", "--show-current")).stdout.trim();
  const baseCommit = (await gitAt(source, "rev-parse", "HEAD")).stdout.trim();
  const taskBranch = `modera/task-${"c".repeat(24)}`;
  await gitAt(source, "worktree", "add", "-b", taskBranch, taskPath, "HEAD");
  await writeFile(join(root, "tasks.json"), JSON.stringify({ version: 1, tasks: [{ id: "task", projectId: "project", title: "Feature", base: `${baseBranch} · ${baseCommit.slice(0, 8)}`, baseBranch, baseCommit, target: { projectId: "project", sessionId: "session" }, runId: "run", createdAt: 1 }] }));
  const host = { storagePath: root, signal: new AbortController().signal, invalidateUi() {}, runBackground() {}, scheduling: {
    options: async () => ({ isolatedWorkspaces: true, models: [] }), target() {}, prepare() {}, startRole() {}, result: async () => ({ text: "Done" }),
    inspect: async () => ({ outcome: "completed", busy: false }), workspace: async () => ({ kind: "git-worktree", path: taskPath, branch: taskBranch }),
  } } as unknown as PluginContext;
  const workbench = (await activate(host))?.ui?.find(item => item.id === "modera.worktree.workbench");
  if (!workbench?.act || !workbench.render) throw new Error("Worktree workbench missing");
  const context = { projectId: "project", workspacePath: source, signal: host.signal } as ToolContext;
  const request = { id: workbench.id, projectId: "project", sessionId: "", locale: "zh-CN" };
  const noCommitsView = JSON.stringify((await workbench.render(request, context)).children);
  expect(noCommitsView).toContain("任务分支尚无新提交");
  expect(noCommitsView).not.toContain("预览合并到项目分支");
  await gitAt(taskPath, "config", "user.name", "Test");
  await gitAt(taskPath, "config", "user.email", "test@example.invalid");
  await writeFile(join(taskPath, "feature.txt"), "feature");
  await gitAt(taskPath, "add", ".");
  await gitAt(taskPath, "commit", "-qm", "feature");
  await writeFile(join(taskPath, "unfinished.txt"), "uncommitted");
  const dirtyView = JSON.stringify((await workbench.render(request, context)).children);
  expect(dirtyView).toContain("任务工作目录仍有未提交改动");
  expect(dirtyView).toContain("打开任务会话，检查并提交改动");
  expect(dirtyView).not.toContain("预览合并到项目分支");
  await expect(workbench.act({ id: "requestMerge", value: "task" }, context, request)).rejects.toThrow("未提交");
  await rm(join(taskPath, "unfinished.txt"));
  expect(JSON.stringify((await workbench.render(request, context)).children)).toContain("预览合并到项目分支");
  await gitAt(source, "checkout", "-qb", "other");
  const wrongBranchView = JSON.stringify((await workbench.render(request, context)).children);
  expect(wrongBranchView).toContain(`请先在项目目录切回「${baseBranch}」`);
  expect(wrongBranchView).not.toContain("预览合并到项目分支");
  await expect(workbench.act({ id: "requestMerge", value: "task" }, context, request)).rejects.toThrow("不是任务起点分支");
  await gitAt(source, "checkout", "-q", baseBranch);
  expect(JSON.stringify((await workbench.render(request, context)).children)).toContain("预览合并到项目分支");
  await expect(workbench.act({ id: "confirmMerge", value: "task" }, context, request)).rejects.toThrow("先预览");
  await expect(workbench.act({ id: "requestMerge", value: "task" }, { ...context, projectId: "other" }, request)).rejects.toThrow("无法合并");
  await gitAt(taskPath, "switch", "-c", `modera/task-${"e".repeat(24)}`);
  const switchedView = JSON.stringify((await workbench.render(request, context)).children);
  expect(switchedView).toContain("任务工作目录不在创建时的分支");
  expect(switchedView).not.toContain("预览合并到项目分支");
  await expect(workbench.act({ id: "requestMerge", value: "task" }, context, request)).rejects.toThrow("已切换分支");
  await gitAt(taskPath, "switch", taskBranch);
  await workbench.act({ id: "requestMerge", value: "task" }, context, request);
  const previewNodes = (await workbench.render(request, context)).children;
  const previewDocument = previewNodes.find(node => node.type === "document" && node.label === "合并预览");
  expect(previewDocument?.previewText).toContain("展开查看任务提交、文件和完整差异");
  expect(previewDocument?.expandLabel).toBe("展开查看完整合并预览");
  const previewView = JSON.stringify(previewNodes);
  expect(previewView).toContain("确认合并到项目分支");
  expect(previewView).toContain("合并后相对当前项目提交的改动");
  expect(previewView).toContain("+feature");
  await workbench.act({ id: "confirmMerge", value: "task" }, context, request);
  expect(await readFile(join(source, "feature.txt"), "utf8")).toBe("feature");
  expect(JSON.stringify((await workbench.render(request, context)).children)).toContain("已合并到项目分支");
});

test("an archived workspace remains mergeable when the plugin archive record was not saved", async () => {
  const root = await mkdtemp(join(tmpdir(), "modera-worktree-archive-recovery-"));
  roots.push(root);
  const source = join(root, "project"), taskPath = join(root, "task");
  await mkdir(source);
  const gitAt = (path: string, ...args: string[]) => exec("git", ["-C", path, ...args]);
  await gitAt(source, "init", "-q");
  await gitAt(source, "config", "user.name", "Test");
  await gitAt(source, "config", "user.email", "test@example.invalid");
  await writeFile(join(source, "base.txt"), "seed");
  await gitAt(source, "add", ".");
  await gitAt(source, "commit", "-qm", "seed");
  const baseBranch = (await gitAt(source, "branch", "--show-current")).stdout.trim();
  const taskBranch = `modera/task-${"a".repeat(24)}`;
  await gitAt(source, "worktree", "add", "-b", taskBranch, taskPath, "HEAD");
  await gitAt(source, "worktree", "remove", taskPath);
  await writeFile(join(root, "tasks.json"), JSON.stringify({ version: 1, tasks: [{ id: "task", projectId: "project", title: "Recovered", base: baseBranch, baseBranch, taskBranch, target: { projectId: "project", sessionId: "session" }, runId: "run", createdAt: 1 }] }));
  let assignedBranch = taskBranch;
  const host = { storagePath: root, signal: new AbortController().signal, invalidateUi() {}, runBackground() {}, scheduling: {
    options: async () => ({ isolatedWorkspaces: true, models: [] }), target() {}, prepare() {}, startRole() {},
    inspect: async () => ({ outcome: "completed", busy: false }), result: async () => ({ outcome: "completed", text: "Done" }),
    workspace: async () => ({ kind: "git-worktree", path: taskPath, branch: assignedBranch, released: true }),
  } } as unknown as PluginContext;
  const workbench = (await activate(host))?.ui?.find(item => item.id === "modera.worktree.workbench");
  if (!workbench?.act || !workbench.render) throw new Error("Worktree workbench missing");
  const context = { projectId: "project", workspacePath: source, signal: host.signal } as ToolContext;
  const request = { id: workbench.id, projectId: "project", sessionId: "", locale: "zh-CN" };
  const noCommits = JSON.stringify((await workbench.render(request, context)).children);
  expect(noCommits).toContain(`本地任务分支：${taskBranch}`);
  expect(noCommits).toContain("任务分支没有尚未合入的提交");
  expect(noCommits).not.toContain("预览合并到项目分支");
  await gitAt(source, "worktree", "add", taskPath, taskBranch);
  await writeFile(join(taskPath, "recovered.txt"), "kept");
  await gitAt(taskPath, "add", ".");
  await gitAt(taskPath, "commit", "-qm", "task work");
  await gitAt(source, "worktree", "remove", taskPath);
  expect(JSON.stringify((await workbench.render(request, context)).children)).toContain("预览合并到项目分支");
  assignedBranch = `modera/task-${"b".repeat(24)}`;
  const mismatch = JSON.stringify((await workbench.render(request, context)).children);
  expect(mismatch).toContain("宿主工作目录与任务记录的分支不一致");
  expect(mismatch).not.toContain("预览合并到项目分支");
  await expect(workbench.act({ id: "requestMerge", value: "task" }, context, request)).rejects.toThrow("分支不一致");
  assignedBranch = taskBranch;
  await workbench.act({ id: "requestMerge", value: "task" }, context, request);
  await workbench.act({ id: "confirmMerge", value: "task" }, context, request);
  expect(await readFile(join(source, "recovered.txt"), "utf8")).toBe("kept");
});

test("worktree workbench pages task history and shows only the selected task details", async () => {
  const root = await mkdtemp(join(tmpdir(), "modera-worktree-list-test-"));
  roots.push(root);
  await writeFile(join(root, "tasks.json"), JSON.stringify({ version: 1, tasks: Array.from({ length: 12 }, (_, index) => ({
    id: `task-${index + 1}`, projectId: "project", title: `Task ${index + 1}`, base: `base-${index + 1}`, error: "not started", createdAt: index,
  })) }));
  const host = {
    storagePath: root, signal: new AbortController().signal, invalidateUi() {}, runBackground() {},
    scheduling: {
      options: async () => ({ isolatedWorkspaces: false, models: [], conversations: [] }),
      target() {}, prepare() {}, startRole() {}, result() {}, inspect() {},
    },
  } as unknown as PluginContext;
  const workbench = (await activate(host))?.ui?.[0];
  if (!workbench?.act || !workbench.render) throw new Error("Worktree workbench missing");
  const context = { projectId: "project", signal: host.signal } as ToolContext;
  const request = { id: workbench.id, sessionId: "", projectId: "project", locale: "zh-CN" };
  const first = await workbench.render(request, context);
  expect(first.children.filter(node => node.type === "button" && node.action === "showTask")).toHaveLength(10);
  expect(JSON.stringify(first.children)).toContain("起点：base-1");
  expect(JSON.stringify(first.children)).not.toContain("起点：base-2");
  await expect(workbench.act({ id: "showTask", value: "task-12" }, { ...context, projectId: "other" }, request)).rejects.toThrow("找不到");
  await workbench.act({ id: "showPage", value: "1" }, context, request);
  const second = await workbench.render(request, context);
  expect(second.children.filter(node => node.type === "button" && node.action === "showTask")).toHaveLength(2);
  expect(JSON.stringify(second.children)).toContain("起点：base-11");
  await workbench.act({ id: "showTask", value: "task-12" }, context, request);
  const selected = await workbench.render(request, context);
  expect(JSON.stringify(selected.children)).toContain("起点：base-12");
  expect(JSON.stringify(selected.children)).not.toContain("起点：base-11");
});

test("saving a draft keeps the oldest worktree task after one hundred entries and a restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "modera-worktree-retention-"));
  roots.push(root);
  await writeFile(join(root, "tasks.json"), JSON.stringify({ version: 1, tasks: Array.from({ length: 100 }, (_, index) => ({
    id: `task-${index}`, projectId: "project", title: `Task ${index}`, base: "main", createdAt: index,
  })) }));
  const host = { storagePath: root, signal: new AbortController().signal, invalidateUi() {}, runBackground() {}, scheduling: {
    options: async () => ({ isolatedWorkspaces: false, models: [], conversations: [] }),
    target() {}, prepare() {}, startRole() {}, result() {}, inspect() {},
  } } as unknown as PluginContext;
  const context = { projectId: "project", signal: host.signal } as ToolContext;
  const first = await activate(host);
  await first?.tools?.[0]?.execute({ title: "New task", instruction: "Do the task" }, context);
  expect((JSON.parse(await readFile(join(root, "tasks.json"), "utf8")) as { tasks: unknown[] }).tasks).toHaveLength(101);
  const workbench = (await activate(host))?.ui?.find(item => item.id === "modera.worktree.workbench");
  if (!workbench?.act || !workbench.render) throw new Error("Worktree workbench missing");
  const request = { id: workbench.id, sessionId: "", projectId: "project", locale: "zh-CN" };
  await workbench.act({ id: "showPage", value: "10" }, context, request);
  expect(JSON.stringify((await workbench.render(request, context)).children)).toContain("Task 99");
  await workbench.act({ id: "showTask", value: "task-99" }, context, request);
  expect(JSON.stringify((await workbench.render(request, context)).children)).toContain("Task 99");
});

test("a repository with more than one hundred branches keeps the current branch and accepts an exact branch name", async () => {
  const root = await mkdtemp(join(tmpdir(), "modera-worktree-many-branches-"));
  roots.push(root);
  const checkout = join(root, "checkout");
  await mkdir(checkout);
  const git = (...args: string[]) => exec("git", ["-C", checkout, ...args]);
  await git("init", "-q");
  await git("config", "user.name", "Test");
  await git("config", "user.email", "test@example.invalid");
  await writeFile(join(checkout, "file.txt"), "committed");
  await git("add", "file.txt");
  await git("commit", "-qm", "seed");
  const commit = (await git("rev-parse", "HEAD")).stdout.trim();
  for (let index = 1; index <= 105; index++) await git("update-ref", `refs/heads/a${String(index).padStart(3, "0")}`, commit);
  await git("checkout", "-qb", "z-current");
  let background: Promise<void> | undefined;
  const host = { storagePath: root, signal: new AbortController().signal, invalidateUi() {},
    runBackground(_context: unknown, task: (signal: AbortSignal) => Promise<void>) { background = task(new AbortController().signal); },
    scheduling: {
      options: async () => ({ isolatedWorkspaces: true, models: [{ profileId: "local", name: "Local", models: ["test"], efforts: { test: ["medium"] } }] }),
      target: async (projectId: string, sessionId: string, selection: unknown) => ({ projectId, sessionId, selection }),
      prepare: async (target: object) => ({ ...target, sessionId: "task-session" }),
      startRole: async () => ({ runId: "run" }), inspect: async () => ({ outcome: "completed" }), result: async () => ({ outcome: "completed", text: "Done" }),
    },
  } as unknown as PluginContext;
  const workbench = (await activate(host))?.ui?.find(item => item.id === "modera.worktree.workbench");
  if (!workbench?.act || !workbench.render) throw new Error("Worktree workbench missing");
  const context = { projectId: "project", workspacePath: checkout, signal: host.signal } as ToolContext;
  const request = { id: workbench.id, sessionId: "", projectId: "project", locale: "zh-CN" };
  const first = await workbench.render(request, context);
  const select = first.children.find(node => node.type === "select" && node.action === "setBase");
  if (select?.type !== "select") throw new Error("Branch selector missing");
  expect(select.options).toHaveLength(100);
  expect(select.options.find(item => item.value === select.value)?.label).toMatch(/^z-current · /);
  expect(first.children.some(node => node.type === "form" && node.action === "setBaseName")).toBe(true);
  await expect(workbench.act({ id: "setBaseName", value: "missing" }, context, request)).rejects.toThrow("找不到这个本地分支");
  await workbench.act({ id: "setBaseName", value: "a105" }, context, request);
  const changed = await workbench.render(request, context);
  const chosen = changed.children.find(node => node.type === "select" && node.action === "setBase");
  if (chosen?.type !== "select") throw new Error("Selected branch missing");
  expect(chosen.options.find(item => item.value === chosen.value)?.label).toMatch(/^a105 · /);
  await workbench.act({ id: "create", value: "Use selected branch" }, context, request);
  await background;
  expect(JSON.parse(await readFile(join(root, "tasks.json"), "utf8")).tasks[0].baseBranch).toBe("a105");
});

test("a preparation failure can retry the same task while an uncertain start cannot", async () => {
  const root = await mkdtemp(join(tmpdir(), "modera-worktree-retry-test-"));
  roots.push(root);
  let prepareCalls = 0;
  let startCalls = 0;
  let failStart = false;
  let background: Promise<void> | undefined;
  const host = {
    storagePath: root, signal: new AbortController().signal, invalidateUi() {},
    runBackground(_context: unknown, task: (signal: AbortSignal) => Promise<void>) { background = task(new AbortController().signal); },
    scheduling: {
      options: async () => ({ isolatedWorkspaces: true, models: [{ profileId: "local", name: "Local", models: ["test-model"], efforts: { "test-model": ["medium"] } }] }),
      target: async (projectId: string, sessionId: string, selection: unknown) => ({ projectId, sessionId, selection }),
      prepare: async (target: object) => { prepareCalls++; if (prepareCalls === 1) throw new Error("temporary allocation failure"); return { ...target, sessionId: `session-${prepareCalls}` }; },
      startRole: async () => { startCalls++; if (failStart) throw new Error("start result uncertain"); return { runId: "run" }; },
      inspect: async () => ({ outcome: "completed" }), result: async () => ({ text: "done" }),
    },
  } as unknown as PluginContext;
  const workbench = (await activate(host))?.ui?.[0];
  if (!workbench?.act || !workbench.render) throw new Error("Worktree workbench missing");
  const context = { projectId: "project", signal: host.signal } as ToolContext;
  const request = { id: workbench.id, sessionId: "", projectId: "project", locale: "zh-CN" };
  await workbench.act({ id: "create", value: "Retry preparation" }, context, request);
  await background;
  const failed = await workbench.render(request, context);
  const retry = failed.children.find(node => node.type === "button" && node.action === "retryPrepare");
  if (retry?.type !== "button") throw new Error("Preparation retry missing");
  await workbench.act({ id: "retryPrepare", value: retry.value }, context, request);
  await background;
  expect(prepareCalls).toBe(2);
  expect(startCalls).toBe(1);
  expect((JSON.parse(await readFile(join(root, "tasks.json"), "utf8")) as { tasks: unknown[] }).tasks).toHaveLength(1);
  await expect(workbench.act({ id: "retryPrepare", value: retry.value }, context, request)).rejects.toThrow("不能安全重试");
  failStart = true;
  await workbench.act({ id: "create", value: "Uncertain start" }, context, request);
  await background;
  const uncertain = await workbench.render(request, context);
  expect(JSON.stringify(uncertain.children)).toContain("启动请求的结果无法确认");
  expect(uncertain.children.some(node => node.type === "button" && node.action === "retryPrepare")).toBe(false);
});
