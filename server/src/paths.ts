// Vault-relative path helpers. All vault paths use "/" and never start with "/".

export function normalizePath(p: string): string {
  let s = p.replace(/\\/g, "/").replace(/\/+/g, "/");
  s = s.replace(/^\.\//, "").replace(/^\/+/, "").replace(/\/+$/, "");
  return s.normalize("NFC");
}

/** Resolve a user-supplied path inside the vault; throws on traversal. */
export function safeVaultPath(p: string): string {
  const n = normalizePath(p);
  if (n === "") return "";
  const parts = n.split("/");
  for (const part of parts) {
    if (part === ".." || part === "." || part === "") throw new PathError(`Invalid path: ${p}`);
    if (part.includes("\0")) throw new PathError(`Invalid path: ${p}`);
  }
  return parts.join("/");
}

export class PathError extends Error {
  status = 400;
}

export function basename(p: string): string {
  const i = p.lastIndexOf("/");
  return i === -1 ? p : p.slice(i + 1);
}

export function dirname(p: string): string {
  const i = p.lastIndexOf("/");
  return i === -1 ? "" : p.slice(0, i);
}

export function extname(p: string): string {
  const b = basename(p);
  const i = b.lastIndexOf(".");
  return i <= 0 ? "" : b.slice(i + 1).toLowerCase();
}

/** File name without extension (".md" note name). */
export function stem(p: string): string {
  const b = basename(p);
  const i = b.lastIndexOf(".");
  return i <= 0 ? b : b.slice(0, i);
}

export function isMarkdown(p: string): boolean {
  return extname(p) === "md";
}

/** Paths that are never part of the note space. */
export function isHidden(p: string): boolean {
  return p.split("/").some((s) => s.startsWith("."));
}

/** Natural sort comparator (numbers compared numerically, case-insensitive). */
export const naturalCompare = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" }).compare;
