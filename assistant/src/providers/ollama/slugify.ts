const PREFIX = "auto-ollama-";

export function modelKey(tag: string): string {
  const normalized = tag
    .toLowerCase()
    .replace(/[.:_/]/g, "-")
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${PREFIX}${normalized}`;
}

export function ensureUniqueSlug(
  base: string,
  taken: ReadonlySet<string>,
): string {
  if (!taken.has(base)) return base;
  for (let i = 2; ; i += 1) {
    const candidate = `${base}-${i}`;
    if (!taken.has(candidate)) return candidate;
  }
}
