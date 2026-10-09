import { execFile } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, test, vi } from "vitest";
import type { PluginContext, ToolContext } from "@modera/plugin-sdk";
import { activate } from "../src/index";
const exec = promisify(execFile), roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const selection = { profileId: "p", model: "test", reasoningEffort: "medium" as const };
async function fixture(saved?: unknown) {
  const root = await mkdtemp(join(tmpdir(), "modera-chat-tree-")); roots.push(root);
  const project = join(root, "project"); await mkdir(project);
  const git = async (path: string, ...args: string[]) => (await exec("git", ["-C", path, ...args])).stdout.trim();
  await git(project, "init", "-b", "main"); await git(project, "config", "user.name", "Test"); await git(project, "config", "user.email", "test@example.invalid");
  await writeFile(join(project, "base"), "seed"); await git(project, "add", "."); await git(project, "commit", "-qm", "seed");
  const workspaces = new Map<string, any>(); let busy = false;
  const api = {
    options: async () => ({ isolatedWorkspaces: true, models: [{ profileId: "p", name: "Test", models: ["test"] }] }),
    target: async (projectId: string, sessionId: string, selection: unknown) => ({ projectId, sessionId, selection }),
    prepare: vi.fn(async (target: any, _title: string, _fresh: boolean, source: any) => {
      const path = join(root, source.taskId); await git(project, "worktree", "add", "--detach", path, source.baseCommit);
      const sessionId = source.taskId; workspaces.set(sessionId, { kind: "git-worktree", path, checkout: "detached", baseCommit: source.baseCommit }); return { ...target, sessionId };
    }),
    workspace: async (target: any) => workspaces.get(target.sessionId),
    workspaceStatus: async (target: any) => { const path = workspaces.get(target.sessionId).path; const changes = await git(path, "status", "--short"); return { head: await git(path, "rev-parse", "HEAD"), branch: await git(path, "branch", "--show-current") || undefined, changes, dirty: !!changes }; },
    createWorkspaceBranch: vi.fn(async (target: any, name: string) => { const workspace = workspaces.get(target.sessionId); await git(workspace.path, "switch", "-c", name); workspace.branch = name; workspace.checkout = "branch"; return workspace; }),
    archiveWorkspace: vi.fn(async (target: any) => { const workspace = workspaces.get(target.sessionId); await git(project, "worktree", "remove", workspace.path); workspace.released = true; return { branch: workspace.branch }; }),
    inspect: async () => ({ busy, outcome: busy ? "running" : "completed" }),
    startRole: vi.fn(async () => ({ runId: "run" })),
  };
  const host = { storagePath: join(root, "storage"), signal: new AbortController().signal, invalidateUi() {}, scheduling: api } as unknown as PluginContext;
  const context = { projectId: "project", workspacePath: project, sessionId: "", runId: "composer", signal: host.signal } as ToolContext;
  if (saved !== undefined) { await mkdir(host.storagePath); await writeFile(join(host.storagePath, "tasks.json"), JSON.stringify(saved)); }
  const contributions = (await activate(host))!;
  const environment = contributions.ui!.find(item => item.slot === "composer.environment")!;
  await environment.act!({ id: "toggle", value: "true" }, context, { id: environment.id, sessionId: "", locale: "zh-CN" });
  return { root, project, git, workspaces, api, host, context, contributions, setBusy: (value: boolean) => { busy = value; } };
}
test("legacy task envelopes preserve records and allow composer submission after restart", async () => {
  const legacy = { id: "old-task", projectId: "project", title: "Existing", base: "main", createdAt: 123, target: { projectId: "project", sessionId: "old-session", selection } };
  const f = await fixture({ version: 1, tasks: [legacy] });
  const receipt = await f.contributions.composer![0]!.submit!({ locale: "zh-CN", query: "Fix login", selection }, f.context);
  expect(receipt).toMatchObject({ runId: "run" });
  const saved = JSON.parse(await readFile(join(f.host.storagePath, "tasks.json"), "utf8"));
  expect(saved).toHaveLength(2); expect(saved[0]).toEqual(legacy);
  const restored = (await activate(f.host))!;
  await restored.tools![0]!.execute({ title: "Next", instruction: "Next task" }, f.context);
  expect(JSON.parse(await readFile(join(f.host.storagePath, "tasks.json"), "utf8"))).toHaveLength(3);
}, 20000);

test.each([null, {}, { version: 2, tasks: [] }, { version: 1, tasks: {} }, [null]])("invalid task storage is rejected without overwriting it: %j", async saved => {
  const f = await fixture();
  const file = join(f.host.storagePath, "tasks.json"), original = JSON.stringify(saved);
  await writeFile(file, original);
  await expect(activate(f.host)).rejects.toThrow("工作树记录格式无效");
  expect(await readFile(file, "utf8")).toBe(original);
});
test("chat creates detached workspaces, forwards exact input and policy, and never intercepts follow-ups", async () => {
  const f = await fixture(), submit = f.contributions.composer![0]!.submit!;
  const first = (await submit({ locale: "zh-CN", query: "Fix login", selection, attachmentIds: ["image"] }, f.context))!;
  const second = (await submit({ locale: "zh-CN", query: "Export", selection }, f.context))!;
  expect(first.sessionId).not.toBe(second.sessionId);
  expect(f.api.prepare.mock.calls[0][3]).toMatchObject({ checkout: "detached", conversationMode: "native" });
  const role = f.api.startRole.mock.calls[0] as unknown as any[];
  expect(role[1].prompt).toContain("默认保留未提交修改"); expect(role[2]).toBe("Fix login"); expect(role[4].attachmentIds).toEqual(["image"]);
  const path = f.workspaces.get(first.sessionId).path;
  await writeFile(join(path, "task"), "keep");
  expect(await submit({ locale: "zh-CN", query: "Continue", selection }, { ...f.context, sessionId: first.sessionId })).toBeUndefined();
  expect(f.api.prepare).toHaveBeenCalledTimes(2); expect(await readFile(join(path, "task"), "utf8")).toBe("keep");
  expect(await f.git(f.project, "branch", "--show-current")).toBe("main");
  expect(f.contributions.ui!.some(item => item.slot === "workbench")).toBe(false);
  const restored = (await activate(f.host))!; const header = restored.ui!.find(item => item.slot === "conversation.header")!;
  expect(JSON.stringify(await header.render!({ id: header.id, sessionId: first.sessionId, locale: "zh-CN" }, f.context))).toContain("分离 HEAD");
}, 20000);
test("chat header creates an arbitrary branch, previews and merges, blocks busy operations and archives", async () => {
  const f = await fixture(); const receipt = (await f.contributions.composer![0]!.submit!({ locale: "zh-CN", query: "Implement", selection }, f.context))!;
  const header = f.contributions.ui!.find(item => item.slot === "conversation.header")!;
  const request = { id: header.id, sessionId: receipt.sessionId, locale: "zh-CN" }, path = f.workspaces.get(receipt.sessionId).path;
  f.context = { ...f.context, workspacePath: path };
  expect((await header.render!({ ...request, sessionId: "other" }, f.context)).children).toEqual([]);
  f.setBusy(true); await expect(header.act!({ id: "createBranch", value: JSON.stringify({ text: "feature/task" }) }, f.context, request)).rejects.toThrow("执行完成"); f.setBusy(false);
  await writeFile(join(path, "task"), "delivered");
  await header.act!({ id: "createBranch", value: JSON.stringify({ text: "feature/task" }) }, f.context, request);
  await expect(header.act!({ id: "requestMerge" }, f.context, request)).rejects.toThrow("未提交");
  await f.git(path, "add", "."); await f.git(path, "commit", "-qm", "task");
  await header.act!({ id: "requestMerge" }, f.context, request);
  expect(JSON.stringify(await header.render!(request, f.context))).toContain("合并预览");
  await header.act!({ id: "confirmMerge" }, f.context, request); expect(await readFile(join(f.project, "task"), "utf8")).toBe("delivered");
  await expect(header.act!({ id: "confirmArchive" }, f.context, request)).rejects.toThrow("确认归档");
  await header.act!({ id: "requestArchive" }, f.context, request); await header.act!({ id: "confirmArchive" }, f.context, request);
  expect(JSON.stringify(await header.render!(request, f.context))).toContain("已归档");
}, 20000);
test("draft result selects base and model and starts directly without a workbench", async () => {
  const f = await fixture(); const tool = f.contributions.tools![0]!;
  const result = await tool.execute({ title: "Draft", instruction: "Implement draft" }, f.context);
  const id = (result as { taskId: string }).taskId;
  const card = f.contributions.ui!.find(item => item.slot === "tool.result")!;
  const request = { id: card.id, sessionId: "parent", locale: "zh-CN", tool: { name: "worktree_draft", input: {}, result: JSON.stringify(result) } };
  await card.act!({ id: "setBase", value: JSON.stringify({ context: id, value: "main" }) }, f.context, request);
  await card.act!({ id: "setModel", value: JSON.stringify({ context: id, value: JSON.stringify(selection) }) }, f.context, request);
  await card.act!({ id: "start", value: id }, f.context, request);
  const view = await card.render!(request, f.context);
  expect(view.children[0]).toMatchObject({ type: "conversation-link" });
  await expect(card.act!({ id: "start", value: id }, f.context, request)).rejects.toThrow("已启动");
}, 20000);
