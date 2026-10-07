import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
  let runSignal: AbortSignal | undefined;
  const host = {
    storagePath: root,
    signal: new AbortController().signal,
    scopeSignal: () => projectController.signal,
    invalidateUi() {},
    runBackground(_context: unknown, task: (signal: AbortSignal) => Promise<void>) { background = task(new AbortController().signal); },
    scheduling: {
      options: async () => ({ isolatedWorkspaces: true, models: [{ profileId: "local", name: "Local", models: ["test-model"], efforts: { "test-model": ["medium"] } }] }),
      target: async (projectId: string, sessionId: string, selection: unknown) => ({ projectId, sessionId, selection }),
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
  await workbench.act({ id: "create", value: "Fix the issue" }, context, { id: workbench.id, sessionId: "", projectId: "project", locale: "zh-CN" });
  await background;
  expect(source).toMatchObject({ workspace: "git-worktree", conversationMode: "native", workbenchId: workbench.id });
  uiController.abort();
  expect(runSignal?.aborted).toBe(false);
  projectController.abort();
  expect(runSignal?.aborted).toBe(true);
  const view = await workbench.render({ id: workbench.id, sessionId: "", projectId: "project", locale: "zh-CN" }, context);
  expect(JSON.stringify(view.children)).toContain("task-session");
  expect(JSON.stringify(view.children)).toContain("Changed two files and ran checks");
  expect(view.children.some(node => node.type === "document" && node.text.includes(checkout))).toBe(true);
  expect(JSON.stringify(view.children)).toContain("file.txt");
});
