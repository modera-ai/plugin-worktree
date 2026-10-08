import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, test, vi } from "vitest";
import type { PluginContext, ToolContext } from "@modera/plugin-sdk";
import { worktreeEnvironment } from "../src/environment";
import { activate } from "../src/index";

const exec = promisify(execFile);
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "modera-tree-env-")); roots.push(root);
  const project = join(root, "project"); await mkdir(project);
  const host = { storagePath: join(root, "storage"), signal: new AbortController().signal, invalidateUi() {} } as unknown as PluginContext;
  const context = { projectId: "project", workspacePath: project, sessionId: "", runId: "composer", signal: host.signal } as ToolContext;
  const git = async (...args: string[]) => (await exec("git", ["-C", project, ...args], { windowsHide: true })).stdout.trim();
  const request = { id: "modera.worktree.environment", projectId: "project", sessionId: "", locale: "zh-CN" };
  return { root, project, host, context, git, request };
}
const selection = { profileId: "local", model: "test", reasoningEffort: "medium" as const };

test("non-Git enable asks first; cancellation preserves files; confirmation creates only an empty baseline", async () => {
  const f = await fixture(); await writeFile(join(f.project, "private.txt"), "original");
  const env = await worktreeEnvironment(f.host, vi.fn());
  expect(await env.composer.execute!({ locale: "zh-CN", query: "" }, f.context)).toEqual([{ type: "configure", uiId: env.ui.id }]);
  expect(JSON.stringify(await env.ui.render!(f.request, f.context))).toContain("是否初始化");
  await expect(f.git("rev-parse", "--show-toplevel")).rejects.toThrow();
  await env.ui.act!({ id: "cancelInit" }, f.context, f.request);
  await expect(env.ui.act!({ id: "confirmInit" }, f.context, f.request)).rejects.toThrow("先确认");
  await env.ui.act!({ id: "toggle", value: "true" }, f.context, f.request);
  await env.ui.act!({ id: "confirmInit" }, f.context, f.request);
  expect(await f.git("ls-tree", "--name-only", "HEAD")).toBe("");
  expect(await readFile(join(f.project, "private.txt"), "utf8")).toBe("original");
  expect((await env.ui.render!(f.request, f.context)).children[0]).toMatchObject({ type: "toggle", checked: true });
}, 20000);

test("toggle persists across restarts; selected branches are validated; disabled mode does not intercept", async () => {
  const f = await fixture(); const submit = vi.fn(async () => ({ sessionId: "task", runId: "run" }));
  const env = await worktreeEnvironment(f.host, submit);
  await env.ui.act!({ id: "toggle", value: "true" }, f.context, f.request);
  await env.ui.act!({ id: "confirmInit" }, f.context, f.request);
  await env.ui.act!({ id: "createBranch", value: JSON.stringify({ text: "feature/login" }) }, f.context, f.request);
  const restored = await worktreeEnvironment(f.host, submit);
  await restored.composer.submit!({ locale: "zh-CN", query: "Fix login", selection }, f.context);
  expect(submit).toHaveBeenCalledWith(expect.objectContaining({ query: "Fix login" }), f.context, expect.objectContaining({ name: "feature/login" }));
  await expect(restored.ui.act!({ id: "setBranch", value: "missing" }, f.context, f.request)).rejects.toThrow("不存在");
  await writeFile(join(f.project, "unfinished.txt"), "keep");
  await expect(restored.ui.act!({ id: "switchBranch" }, f.context, f.request)).rejects.toThrow("未提交");
  await restored.ui.act!({ id: "toggle", value: "false" }, f.context, f.request);
  expect(await restored.composer.submit!({ locale: "zh-CN", query: "Ordinary task", selection }, f.context)).toBeUndefined();
  expect(submit).toHaveBeenCalledTimes(1);
}, 20000);

test("implicit submission allocates a real worktree and forwards exact user text, model and attachments", async () => {
  const f = await fixture();
  let workspace = ""; let source: any; let prompt = ""; let role: any; let options: any;
  const host = { ...f.host, runBackground() {}, scheduling: {
    options: async () => ({ isolatedWorkspaces: true, models: [] }), result() {}, inspect() {},
    target: async (projectId: string, sessionId: string, model: unknown) => ({ projectId, sessionId, selection: model }),
    prepare: async (target: any, _title: string, _fresh: boolean, input: any) => {
      source = input; workspace = join(f.root, "task");
      await f.git("worktree", "add", "-b", "modera/task-111111111111111111111111", workspace, input.baseCommit);
      return { ...target, sessionId: "task-session" };
    },
    workspace: async () => ({ kind: "git-worktree", path: workspace, branch: "modera/task-111111111111111111111111" }),
    startRole: async (_target: unknown, definition: unknown, text: string, _signal: unknown, input: unknown) => { prompt = text; role = definition; options = input; return { runId: "run" }; },
  } } as unknown as PluginContext;
  const contributions = await activate(host);
  const ui = contributions!.ui!.find(item => item.id === "modera.worktree.environment")!;
  await ui.act!({ id: "toggle", value: "true" }, f.context, f.request);
  await ui.act!({ id: "confirmInit" }, f.context, f.request);
  const receipt = await contributions!.composer![0]!.submit!({ locale: "zh-CN", query: "Fix login exactly", selection, attachmentIds: ["image"] }, f.context);
  expect(receipt).toEqual({ sessionId: "task-session", runId: "run" });
  expect(prompt).toBe("Fix login exactly"); expect(role.selection).toEqual(selection); expect(options.attachmentIds).toEqual(["image"]);
  expect(source).toMatchObject({ workspace: "git-worktree", conversationMode: "native" });
  await writeFile(join(workspace, "task.txt"), "isolated");
  await expect(readFile(join(f.project, "task.txt"))).rejects.toThrow();
  const state = JSON.parse(await readFile(join(host.storagePath, "tasks.json"), "utf8"));
  expect(state.tasks[0]).toMatchObject({ runId: "run", target: { sessionId: "task-session" } });
}, 20000);
