/**
 * The folder name `git clone` would pick for `url`: its last path segment without `.git`, e.g.
 * "grit" for "https://github.com/ada/grit.git", "git@host:ada/grit.git" or "/srv/git/grit/".
 * Empty when the URL has no usable name yet.
 */
export function repoNameFromUrl(url: string): string {
  let rest = url.trim().replace(/[?#].*$/, "");
  // "https://example.com" is a host without a repository path.
  if (/^[a-z][a-z0-9+.-]*:\/\/[^/]*\/?$/i.test(rest)) return "";
  rest = rest.replace(/[/\\]+$/, "");
  if (rest.endsWith(".git")) rest = rest.slice(0, -4);
  // The segment after the last separator: "/" or "\" in paths and URLs, ":" in scp-style addresses.
  return rest.split(/[/\\:]/).pop() ?? "";
}
