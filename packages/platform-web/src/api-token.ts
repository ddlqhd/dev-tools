/** PLATFORM_TOKEN for console: localStorage, or Vite env at build time. */
export function getPlatformToken(): string | undefined {
  try {
    const fromStore = localStorage.getItem("platformToken");
    if (fromStore) return fromStore;
  } catch {
    // ignore
  }
  const fromEnv = import.meta.env.VITE_PLATFORM_TOKEN as string | undefined;
  return fromEnv || undefined;
}
