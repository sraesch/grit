import { RepoInfo } from "./api";

const OPEN_REPOS_KEY = "openRepos";
const ACTIVE_REPO_KEY = "activeRepo";
/** Before tabs, only the last repository was remembered. */
const LEGACY_LAST_REPO_KEY = "lastRepo";

/** The repositories that were open in tabs, in tab order, and the active one. */
export function readOpenTabs(): { roots: string[]; active: string | null } {
  try {
    const stored = localStorage.getItem(OPEN_REPOS_KEY);
    if (stored !== null) {
      const parsed: unknown = JSON.parse(stored);
      const roots = Array.isArray(parsed) ? parsed.filter((r): r is string => typeof r === "string") : [];
      return { roots, active: localStorage.getItem(ACTIVE_REPO_KEY) };
    }
    const last = localStorage.getItem(LEGACY_LAST_REPO_KEY);
    return { roots: last ? [last] : [], active: last };
  } catch {
    return { roots: [], active: null };
  }
}

export function saveOpenTabs(roots: string[], active: string | null) {
  try {
    localStorage.setItem(OPEN_REPOS_KEY, JSON.stringify(roots));
    if (active) localStorage.setItem(ACTIVE_REPO_KEY, active);
    else localStorage.removeItem(ACTIVE_REPO_KEY);
    localStorage.removeItem(LEGACY_LAST_REPO_KEY);
  } catch {
    /* not remembered */
  }
}

/**
 * Tab labels: the repository name, with its parent folder added when two open repositories
 * share a name (e.g. "work/app" and "personal/app").
 */
export function tabLabels(repos: RepoInfo[]): Map<string, string> {
  const counts = new Map<string, number>();
  for (const r of repos) counts.set(r.name, (counts.get(r.name) ?? 0) + 1);
  return new Map(
    repos.map((r) => {
      if ((counts.get(r.name) ?? 0) < 2) return [r.root, r.name];
      const parts = r.root.split(/[\\/]/).filter(Boolean);
      const parent = parts[parts.length - 2];
      return [r.root, parent ? `${parent}/${r.name}` : r.name];
    }),
  );
}

/** The tab to show after closing `root`: the one to its right, else the one to its left. */
export function nextActive(roots: string[], closing: string, active: string | null): string | null {
  if (active !== closing) return active;
  const i = roots.indexOf(closing);
  const rest = roots.filter((r) => r !== closing);
  return rest[Math.min(i, rest.length - 1)] ?? null;
}
