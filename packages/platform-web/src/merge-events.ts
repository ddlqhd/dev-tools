/** Keep live token-level events that the coalesced disk snapshot has not reached yet. */
export function mergePersistedAndLive<T extends { seq: number }>(persisted: T[], live: T[]): T[] {
  if (persisted.length === 0) return live;
  const maxPersisted = persisted.reduce((max, event) => (event.seq > max ? event.seq : max), 0);
  const extras = live.filter((event) => event.seq > maxPersisted);
  return extras.length === 0 ? persisted : persisted.concat(extras);
}
