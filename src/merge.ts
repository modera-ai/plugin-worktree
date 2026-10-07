import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const git = async (path: string, args: string[]) => (await exec("git", ["-C", path, ...args], { timeout: 120_000, maxBuffer: 262144 })).stdout.trim();
const samePath = (left: string, right: string) => resolve(left).toLowerCase() === resolve(right).toLowerCase();
const branchPattern = /^modera\/task-[0-9a-f]{24}$/;

export interface MergePreview {
  readonly sourcePath: string;
  readonly sourceBranch: string;
  readonly sourceHead: string;
  readonly taskBranch: string;
  readonly taskHead: string;
  readonly commits: string;
  readonly files: string;
}

/** Plugin-owned Git operation; the host only supplies the project and owner-bound task paths. */
export async function previewTaskMerge(input: { projectPath: string; baseBranch: string; taskPath?: string; archivedBranch?: string }): Promise<MergePreview> {
  const sourcePath = await realpath(await git(input.projectPath, ["rev-parse", "--show-toplevel"]));
  const sourceBranch = await git(sourcePath, ["branch", "--show-current"]);
  if (!input.baseBranch || sourceBranch !== input.baseBranch) throw new Error(`当前项目分支不是任务起点分支「${input.baseBranch}」；请先切回该分支`);
  if (await git(sourcePath, ["status", "--porcelain=v1", "--untracked-files=all"])) throw new Error("项目工作目录有未提交或未追踪文件，请先保存这些改动");
  if (await git(sourcePath, ["rev-parse", "-q", "--verify", "MERGE_HEAD"]).then(() => true, () => false)) throw new Error("项目已有未完成的合并，请先处理");
  const sourceHead = await git(sourcePath, ["rev-parse", "HEAD"]);
  const taskBranch = input.taskPath ? await git(input.taskPath, ["branch", "--show-current"]) : input.archivedBranch;
  if (!taskBranch || !branchPattern.test(taskBranch)) throw new Error("任务分支身份无法核实");
  if (input.taskPath) {
    const taskPath = await realpath(input.taskPath);
    const sourceCommon = await realpath(resolve(sourcePath, await git(sourcePath, ["rev-parse", "--git-common-dir"])));
    const taskCommon = await realpath(resolve(taskPath, await git(taskPath, ["rev-parse", "--git-common-dir"])));
    if (!samePath(sourceCommon, taskCommon)) throw new Error("任务工作目录不属于当前项目仓库");
    if (await git(taskPath, ["status", "--porcelain=v1", "--untracked-files=all"])) throw new Error("任务工作目录有未提交或未追踪文件，请先在任务会话保存改动");
  }
  const taskHead = await git(sourcePath, ["rev-parse", "--verify", `refs/heads/${taskBranch}^{commit}`]);
  const mergeBase = await git(sourcePath, ["merge-base", sourceHead, taskHead]);
  if (mergeBase === taskHead) throw new Error("任务分支没有尚未合入的提交");
  try { await git(sourcePath, ["merge-tree", "--write-tree", "--no-messages", sourceHead, taskHead]); }
  catch { throw new Error("预览发现合并冲突或当前 Git 不支持安全预览；请在 Git 工具中手动处理，不会改动项目目录"); }
  const [commits, files] = await Promise.all([
    git(sourcePath, ["log", "-10", "--format=%h %s", `${mergeBase}..${taskHead}`]),
    git(sourcePath, ["diff", "--name-status", mergeBase, taskHead]),
  ]);
  return { sourcePath, sourceBranch, sourceHead, taskBranch, taskHead, commits: commits.slice(0, 3000), files: files.slice(0, 3000) };
}

export async function applyTaskMerge(input: { projectPath: string; baseBranch: string; taskPath?: string; archivedBranch?: string }, preview: MergePreview): Promise<{ branch: string; commit: string }> {
  const current = await previewTaskMerge(input);
  if (current.sourcePath !== preview.sourcePath || current.sourceBranch !== preview.sourceBranch || current.sourceHead !== preview.sourceHead || current.taskBranch !== preview.taskBranch || current.taskHead !== preview.taskHead)
    throw new Error("项目或任务分支在预览后发生变化，请重新预览");
  await git(current.sourcePath, ["merge", "--no-ff", "--no-edit", "-m", `Merge ${current.taskBranch}`, current.taskHead]);
  return { branch: current.sourceBranch, commit: await git(current.sourcePath, ["rev-parse", "HEAD"]) };
}
