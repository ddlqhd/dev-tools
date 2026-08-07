import type { InstanceRow, RepoRow, TaskRow } from "./db/store.js";

/** Strip secrets before returning repo rows over HTTP. */
export function publicRepo(row: RepoRow): Omit<RepoRow, "github_token"> & {
  has_github_token: boolean;
} {
  const { github_token, ...rest } = row;
  return { ...rest, has_github_token: Boolean(github_token) };
}

/** Strip kernel auth token from instance rows. */
export function publicInstance(row: InstanceRow): Omit<InstanceRow, "token"> {
  const { token: _token, ...rest } = row;
  return rest;
}

export function publicTask(row: TaskRow): TaskRow {
  return row;
}
