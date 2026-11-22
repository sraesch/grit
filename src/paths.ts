import { homeDir } from "@tauri-apps/api/path";
import { api } from "./api";

/** Joins a folder and a name with the folder's own separator (backslashes for Windows paths). */
export function joinPath(dir: string, name: string): string {
  const sep = dir.includes("\\") && !dir.includes("/") ? "\\" : "/";
  return dir.endsWith("/") || dir.endsWith("\\") ? dir + name : dir + sep + name;
}

/** The repositories folder from the settings, else the home folder, or null if neither can be read. */
export async function repositoriesFolder(): Promise<string | null> {
  const settings = await api.getSettings().catch(() => null);
  if (settings?.reposDir) return settings.reposDir;
  return homeDir().catch(() => null);
}
