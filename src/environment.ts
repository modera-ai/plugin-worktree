import { execFile } from "node:child_process";
import { mkdir, readFile, rename, writeFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import type { ComposerContribution, ComposerRequest, PluginContext, PluginUiContribution, PluginUiNode, ToolContext } from "@modera/plugin-sdk";

const exec = promisify(execFile);
type Mode = { enabled: boolean; branch?: string };
export async function worktreeEnvironment(host: PluginContext, submit: (request: ComposerRequest, context: ToolContext, base: { name: string; commit: string }) => Promise<{ sessionId: string; runId: string }>) {
  const file = join(host.storagePath, "environment.json");
  await mkdir(host.storagePath, { recursive: true });
  let modes: Record<string, Mode>;
  try { modes = JSON.parse(await readFile(file, "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; modes = {}; }
  const confirmations = new Map<string, "init" | "commit">();
  const deletions = new Map<string, string>();
  const branchViews = new Set<string>();
  const mode = (id: string) => modes[id] ?? { enabled: false };
  let queue = Promise.resolve();
  const save = (id: string, next: Mode) => {
    const operation = queue.then(async () => {
      modes[id] = next;
      const temporary = `${file}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify(modes)); await rename(temporary, file); host.invalidateUi?.();
    });
    queue = operation.catch(() => {}); return operation;
  };
  const git = async (context: ToolContext, args: string[]) => {
    if (!context.workspacePath) throw new Error("请先选择本地项目");
    return (await exec("git", ["-C", context.workspacePath, ...args], { signal: context.signal, timeout: 10000, maxBuffer: 1024 * 1024, windowsHide: true })).stdout.trim();
  };
  const repository = async (context: ToolContext) => {
    if (!context.workspacePath) return { git: false, committed: false, branch: "", branches: [] as { name: string; commit: string }[] };
    let root: string;
    try { root = await git(context, ["rev-parse", "--show-toplevel"]); }
    catch { return { git: false, committed: false, branch: "", branches: [] as { name: string; commit: string }[] }; }
    // A folder inside somebody else's repository must not initialize or manage its parent.
    if ((await realpath(root)).toLowerCase() !== (await realpath(context.workspacePath)).toLowerCase()) throw new Error("当前项目是其他仓库的子目录，请选择仓库根目录后配置工作树");
    const branch = await git(context, ["branch", "--show-current"]);
    const lines = await git(context, ["for-each-ref", "--format=%(refname:short)%00%(objectname)", "refs/heads"]);
    const branches = lines.split(/\r?\n/).filter(Boolean).map(line => { const [name, commit] = line.split("\0"); return { name: name!, commit: commit! }; });
    return { git: true, committed: branches.length > 0, branch, branches };
  };
  const enable = async (context: ToolContext, enabled: boolean) => {
    const id = context.projectId!;
    if (!enabled) { confirmations.delete(id); await save(id, { ...mode(id), enabled: false }); return; }
    const info = await repository(context);
    if (!info.git || !info.committed) { confirmations.set(id, info.git ? "commit" : "init"); host.invalidateUi?.(); return; }
    await save(id, { enabled: true, branch: mode(id).branch && info.branches.some(item => item.name === mode(id).branch) ? mode(id).branch! : info.branch || info.branches[0]!.name });
  };
  const permissions = ["storage.read", "storage.write", "workspace.read", "process.spawn", "runs.schedule", "runs.delegate", "runs.observe"] as const;
  const uiId = "modera.worktree.environment";
  const composer: ComposerContribution = {
    id: "modera.worktree.command", title: "工作树", description: "开启工作树模式", kind: "command", aliases: ["worktree"], configurationUiId: uiId, handlesSubmit: true, requiredPermissions: permissions,
    async execute(_request, context) {
      if (!context.projectId || !context.workspacePath) throw new Error("请先选择本地项目");
      await enable(context, !mode(context.projectId).enabled);
      return [{ type: "configure", uiId }];
    },
    async submit(request, context) {
      if (!context.projectId || !mode(context.projectId).enabled) return undefined;
      const info = await repository(context);
      if (!info.git || !info.committed) throw new Error("工作树需要已有提交的 Git 仓库，请打开环境配置完成初始化");
      const selected = info.branches.find(item => item.name === mode(context.projectId!).branch);
      if (!selected) throw new Error("工作树起点分支已不存在，请重新选择");
      return submit(request, context, selected);
    },
  };
  const ui: PluginUiContribution = {
    id: uiId, slot: "composer.environment", requiredPermissions: permissions,
    actions: ["showBranches", "hideBranches", "toggle", "cancelInit", "confirmInit", "setBranch", "createBranch", "switchBranch", "requestDelete", "confirmDelete", "cancelDelete"],
    async act(action, context) {
      if (!context.projectId || !context.workspacePath) throw new Error("请先选择本地项目");
      const id = context.projectId;
      if (action.id === "showBranches") { branchViews.add(id); host.invalidateUi?.(); return; }
      if (action.id === "hideBranches") { branchViews.delete(id); host.invalidateUi?.(); return; }
      if (action.id === "toggle") { await enable(context, action.value === "true"); return; }
      if (action.id === "cancelInit") { confirmations.delete(id); host.invalidateUi?.(); return; }
      if (action.id === "confirmInit") {
        const expected = confirmations.get(id);
        if (!expected) throw new Error("请先确认初始化范围");
        const info = await repository(context);
        if (expected === "init" && info.git || expected === "commit" && (!info.git || info.committed)) throw new Error("仓库状态已变化，请重新开启工作树");
        if (!info.git) await git(context, ["init", "-b", "main"]);
        // Do not stage or commit any user files. An empty baseline is enough for worktree add.
        await git(context, ["-c", "user.name=Modera", "-c", "user.email=modera@localhost", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "--only", "-m", "Initialize worktree baseline"]);
        confirmations.delete(id); await enable(context, true); return;
      }
      const info = await repository(context);
      if (!info.git || !info.committed) throw new Error("请先初始化 Git 仓库");
      if (action.id === "setBranch") {
        if (!info.branches.some(item => item.name === action.value)) throw new Error("分支已不存在");
        await save(id, { ...mode(id), branch: action.value! }); return;
      }
      if (action.id === "createBranch") {
        const envelope = JSON.parse(action.value ?? "{}") as { text?: string };
        const name = envelope.text?.trim();
        if (!name || name.length > 200 || name.startsWith("-")) throw new Error("请输入有效分支名");
        await git(context, ["check-ref-format", "--branch", name]);
        await git(context, ["branch", name, "HEAD"]);
        await save(id, { ...mode(id), branch: name }); return;
      }
      const selected = mode(id).branch;
      if (!selected || !info.branches.some(item => item.name === selected)) throw new Error("请选择有效分支");
      if (action.id === "switchBranch") {
        if (await git(context, ["status", "--porcelain=v1", "--untracked-files=all"])) throw new Error("项目有未提交改动，请先保存后再切换分支");
        await git(context, ["switch", selected]);
      } else if (action.id === "requestDelete") {
        if (selected === info.branch) throw new Error("不能删除当前项目分支");
        deletions.set(id, selected);
      } else if (action.id === "cancelDelete") deletions.delete(id);
      else if (action.id === "confirmDelete") {
        if (deletions.get(id) !== selected || selected === info.branch) throw new Error("分支选择已变化，请重新确认");
        await git(context, ["branch", "-d", selected]); deletions.delete(id);
        await save(id, { ...mode(id), branch: info.branch });
      }
      host.invalidateUi?.();
    },
    async render(_request, context) {
      const id = context.projectId ?? "";
      const current = mode(id);
      const info = await repository(context);
      const children: PluginUiNode[] = [{ type: "toggle", label: "工作树", checked: current.enabled && info.git && info.committed, action: "toggle", disabled: !context.workspacePath }];
      const pending = confirmations.get(id);
      if (pending) children.push({ type: "text", text: pending === "init" ? "当前项目不是 Git 仓库。是否初始化 Git 并创建一个空的起点提交？现有文件不会被加入提交。" : "仓库还没有提交。是否创建一个空的起点提交？现有文件不会被加入提交。" }, { type: "row", children: [{ type: "button", label: "确认初始化", action: "confirmInit" }, { type: "button", label: "取消", action: "cancelInit" }] });
      else if (!info.git) children.push({ type: "text", text: "此项目不是 Git 仓库，开启工作树时可确认初始化。", tone: "muted" });
      if (info.git && info.committed && !branchViews.has(id)) children.push({ type: "configuration-link", label: "分支", value: current.branch ?? info.branch, icon: "branch", action: "showBranches" });
      if (info.git && info.committed && branchViews.has(id)) {
        children.push({ type: "button", label: "返回环境配置", action: "hideBranches" });
        children.push({ type: "text", text: `项目分支：${info.branch || "分离提交"}`, tone: "muted" }, { type: "select", label: "起点分支", action: "setBranch", value: current.branch ?? info.branch, options: info.branches.map(item => ({ label: item.name, value: item.name })) }, { type: "form", label: "新建分支", placeholder: "分支名称", action: "createBranch", context: "branch", maxLength: 200 }, { type: "row", children: [{ type: "button", label: "项目切换到所选分支", action: "switchBranch" }, { type: "button", label: "删除所选分支", action: "requestDelete" }] });
        if (deletions.has(id)) children.push({ type: "text", text: `确认删除分支「${deletions.get(id)}」？仅允许删除已合并且未被工作树占用的分支。` }, { type: "row", children: [{ type: "button", label: "确认删除", action: "confirmDelete" }, { type: "button", label: "取消", action: "cancelDelete" }] });
      }
      children.push({ type: "open-slot", label: "管理工作树任务", target: "modera.worktree.workbench" });
      return { title: "工作树", badge: current.enabled && info.git && info.committed ? "关闭工作树模式" : "开启工作树模式", children };
    },
  };
  return { composer, ui };
}
