/** Tiny safe expression evaluator for until/when: supports `nodeId.field` and equality. */

export function evaluateExpression(
  expr: string,
  outcomes: Record<string, Record<string, unknown>>,
): boolean {
  const trimmed = expr.trim();
  if (!trimmed) return false;

  // Support simple boolean path: nodeId.passed / nodeId.approved
  const pathMatch = /^([a-zA-Z_][\w]*)\.([a-zA-Z_][\w]*)$/.exec(trimmed);
  if (pathMatch) {
    const [, nodeId, field] = pathMatch;
    const value = outcomes[nodeId!]?.[field!];
    return Boolean(value);
  }

  // Support == comparisons: nodeId.field == value
  const eqMatch = /^([a-zA-Z_][\w]*)\.([a-zA-Z_][\w]*)\s*==\s*(.+)$/.exec(trimmed);
  if (eqMatch) {
    const [, nodeId, field, rawRight] = eqMatch;
    const left = outcomes[nodeId!]?.[field!];
    const right = parseLiteral(rawRight!.trim());
    return left === right;
  }

  // Support negation: !nodeId.field
  const notMatch = /^!\s*([a-zA-Z_][\w]*)\.([a-zA-Z_][\w]*)$/.exec(trimmed);
  if (notMatch) {
    const [, nodeId, field] = notMatch;
    return !outcomes[nodeId!]?.[field!];
  }

  throw new Error(`Unsupported expression: ${expr}`);
}

function parseLiteral(raw: string): unknown {
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (raw === "null") return null;
  if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
  if (
    (raw.startsWith('"') && raw.endsWith('"')) ||
    (raw.startsWith("'") && raw.endsWith("'"))
  ) {
    return raw.slice(1, -1);
  }
  return raw;
}
