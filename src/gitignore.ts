/** What can be ignored from the file list: one file, or a folder (its path ends in "/"). */
export type IgnoreTarget = { kind: "file"; path: string } | { kind: "folder"; path: string };

export interface IgnoreOption {
  /** Describes what the pattern matches, e.g. "All files with extension .log". */
  label: string;
  pattern: string;
}

/**
 * Escapes a literal file or folder name for a .gitignore pattern: glob characters and backslashes,
 * a leading "#" (comment) or "!" (negation), and trailing spaces (which git would drop).
 */
export function escapePattern(name: string): string {
  let escaped = name.replace(/[\\*?[]/g, (c) => `\\${c}`);
  if (escaped.startsWith("#") || escaped.startsWith("!")) escaped = `\\${escaped}`;
  return escaped.replace(/ +$/, (spaces) => "\\ ".repeat(spaces.length));
}

/** Escapes each segment of a slash-separated path. */
const escapePath = (path: string) => path.split("/").map(escapePattern).join("/");

/**
 * The patterns offered for ignoring a file or folder, most specific first. Paths are relative to the
 * repository root, where the patterns are written.
 */
export function ignoreOptions(target: IgnoreTarget): IgnoreOption[] {
  if (target.kind === "folder") {
    const path = target.path.replace(/\/+$/, "");
    const name = path.slice(path.lastIndexOf("/") + 1);
    return [
      { label: "Only this folder", pattern: `/${escapePath(path)}/` },
      { label: `All folders named ${name}`, pattern: `${escapePattern(name)}/` },
    ];
  }
  const name = target.path.slice(target.path.lastIndexOf("/") + 1);
  const options = [
    { label: "Only this file", pattern: `/${escapePath(target.path)}` },
    { label: `All files named ${name}`, pattern: escapePattern(name) },
  ];
  // A leading dot starts a name (".env"), not an extension.
  const dot = name.lastIndexOf(".");
  if (dot > 0 && dot < name.length - 1) {
    const ext = name.slice(dot + 1);
    options.push({ label: `All files with extension .${ext}`, pattern: `*.${escapePattern(ext)}` });
  }
  return options;
}
