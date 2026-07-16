/**
 * Deterministic JSON serialization: recursively key-sorted, no whitespace.
 * Every party that hashes an object (agents, verifier, merchant-sim, tests)
 * must serialize through this function — a second implementation anywhere
 * silently breaks evidence-hash verification.
 */
export function canonicalJSON(value: unknown): string {
  if (value === null) return "null";
  const t = typeof value;
  if (t === "string" || t === "boolean") return JSON.stringify(value);
  if (t === "number") {
    if (!Number.isFinite(value as number)) {
      throw new Error("canonicalJSON: non-finite numbers are not representable");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return "[" + value.map(canonicalJSON).join(",") + "]";
  }
  if (t === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return (
      "{" +
      entries.map(([k, v]) => JSON.stringify(k) + ":" + canonicalJSON(v)).join(",") +
      "}"
    );
  }
  // undefined, bigint, function, symbol: force the caller to convert
  // explicitly rather than guessing a lossy representation here.
  throw new Error(`canonicalJSON: unsupported type ${t}`);
}
