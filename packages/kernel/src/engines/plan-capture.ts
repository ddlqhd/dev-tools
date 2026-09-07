/** Shared extraction of plan markdown from engine plan-tool arguments. */
export function extractPlanMarkdown(
  args: Record<string, unknown> | undefined,
): string | undefined {
  if (!args) return undefined;
  const candidates = [
    args.plan,
    args.overview,
    args.content,
    args.markdown,
    args.body,
    typeof args.name === "string" && typeof args.overview === "string"
      ? `# ${args.name}\n\n${args.overview}`
      : undefined,
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c.trim().length >= 40) return c.trim();
  }
  // Last resort: pretty-print known fields as markdown
  const name = typeof args.name === "string" ? args.name : undefined;
  const overview = typeof args.overview === "string" ? args.overview : undefined;
  const todos = args.todos ?? args.steps;
  if (!name && !overview && !todos) return undefined;
  const lines: string[] = [];
  if (name) lines.push(`# ${name}`, "");
  if (overview) lines.push(overview, "");
  if (Array.isArray(todos)) {
    lines.push("## Steps", "");
    for (const t of todos) {
      if (typeof t === "string") lines.push(`- ${t}`);
      else if (t && typeof t === "object") {
        const item = t as Record<string, unknown>;
        const text = String(item.content ?? item.title ?? item.text ?? JSON.stringify(t));
        lines.push(`- ${text}`);
      }
    }
  }
  const md = lines.join("\n").trim();
  return md.length >= 40 ? md : undefined;
}

/** OpenCode (and similar) tool names that carry a plan payload. */
export function isPlanToolInput(tool: string): boolean {
  return /plan/i.test(tool);
}
