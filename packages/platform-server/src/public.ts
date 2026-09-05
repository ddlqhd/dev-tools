import type { InstanceRow, RepoRow, TaskRow } from "./db/store.js";

/** Strip secrets before returning repo rows over HTTP. */
export function publicRepo(row: RepoRow): Omit<RepoRow, "github_token"> & {
  has_github_token: boolean;
} {
  const { github_token, ...rest } = row;
  return { ...rest, has_github_token: Boolean(github_token) };
}

export type PublicLiveInstance = Omit<InstanceRow, "token" | "repo_id"> & {
  repo: { id: string; full_name: string } | null;
  tasks: Array<Pick<TaskRow, "id" | "title" | "status" | "current_node" | "branch">>;
};

/** Live kernel view: repo identity + tasks still bound to this process. */
export function publicLiveInstance(
  row: InstanceRow,
  repo: RepoRow | undefined,
  tasks: TaskRow[],
): PublicLiveInstance {
  const { token: _token, repo_id: _repoId, ...rest } = row;
  return {
    ...rest,
    repo: repo ? { id: repo.id, full_name: repo.full_name } : null,
    tasks: tasks.map((task) => ({
      id: task.id,
      title: task.title,
      status: task.status,
      current_node: task.current_node,
      branch: task.branch,
    })),
  };
}

export function publicTask(row: TaskRow): TaskRow {
  return row;
}
