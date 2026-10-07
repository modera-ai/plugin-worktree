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
  await writeFile(join(checkout, "file.txt"), "modified");
  const uiController = new AbortController();
  const projectController = new AbortController();
  let background: Promise<void> | undefined;
  let source: unknown;
  let actualSelection: unknown;
  let runSignal: AbortSignal | undefined;
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
      startRole: async (_target: unknown, _role: unknown, _prompt: string, signal: AbortSignal) => { runSignal = signal; return { runId: "task-run" }; },
      inspect: async () => ({ outcome: "completed" }),
      result: async () => ({ outcome: "completed", text: "Changed two files and ran checks" }),
    },
  } as unknown as PluginContext;
  const contributions = await activate(host);
  const workbench = contributions?.ui?.[0];
  if (!workbench?.act || !workbench.render) throw new Error("Worktree workbench missing");
  const context = { projectId: "project", sessionId: "parent", signal: uiController.signal } as ToolContext;
  const initial = await workbench.render({ id: workbench.id, sessionId: "", projectId: "project", locale: "zh-CN" }, context);
  const selector = initial.children.find(node => node.type === "select");
  if (!selector) throw new Error("Worktree model selector missing");
  await expect(workbench.act({ id: "setModel", value: JSON.stringify({ value: "forged" }) }, context, { id: workbench.id, sessionId: "", projectId: "project", locale: "zh-CN" })).rejects.toThrow("模型已不可用");
  await workbench.act({ id: "setModel", value: JSON.stringify({ value: selector.options[1]!.value }) }, context, { id: workbench.id, sessionId: "", projectId: "project", locale: "zh-CN" });
  await workbench.act({ id: "create", value: "Fix the issue" }, context, { id: workbench.id, sessionId: "", projectId: "project", locale: "zh-CN" });
  await background;
  await git("add", "file.txt");
  await git("commit", "-qm", "implement task change");
  expect(actualSelection).toMatchObject({ profileId: "local", model: "other-model", reasoningEffort: "high" });
  expect(source).toMatchObject({ workspace: "git-worktree", conversationMode: "native", workbenchId: workbench.id });
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
