/** Prefer the row with the later `updated_at`. Equal timestamps keep `incoming`. */
export function pickNewerTask<T extends { updated_at: string }>(current: T, incoming: T): T {
  return current.updated_at > incoming.updated_at ? current : incoming;
}

/** Insert or replace one task without regressing a newer local copy. */
export function upsertTask<T extends { id: string; updated_at: string }>(prev: T[], task: T): T[] {
  const idx = prev.findIndex((x) => x.id === task.id);
  if (idx < 0) return [task, ...prev];
  const chosen = pickNewerTask(prev[idx]!, task);
  if (chosen === prev[idx]) return prev;
  const next = [...prev];
  next[idx] = chosen;
  return next;
}

/**
 * Fold an HTTP snapshot into local state.
 * `fetchedAt` is the ISO time when the request started: rows that appeared
 * via websocket after that stay even if the snapshot omitted them.
 */
export function mergeTaskSnapshot<T extends { id: string; updated_at: string }>(
  prev: T[],
  incoming: T[],
  fetchedAt: string,
): T[] {
  const incomingIds = new Set(incoming.map((t) => t.id));
  const merged = incoming.map((task) => {
    const existing = prev.find((x) => x.id === task.id);
    return existing ? pickNewerTask(existing, task) : task;
  });
  const extras = prev.filter((t) => !incomingIds.has(t.id) && t.updated_at >= fetchedAt);
  return extras.length === 0 ? merged : [...extras, ...merged];
}
