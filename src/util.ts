export function relativeTime(unixSeconds: number): string {
  const diff = Date.now() / 1000 - unixSeconds;
  const units: [number, string][] = [
    [60, "second"],
    [60, "minute"],
    [24, "hour"],
    [7, "day"],
    [4.35, "week"],
    [12, "month"],
    [Number.POSITIVE_INFINITY, "year"],
  ];
  let value = diff;
  for (const [size, name] of units) {
    if (Math.abs(value) < size) {
      const n = Math.max(0, Math.round(value));
      return n <= 1 && name === "second" ? "just now" : `${n} ${name}${n === 1 ? "" : "s"} ago`;
    }
    value /= size;
  }
  return "";
}

export function fullDate(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleString();
}

export function splitPath(path: string): { dir: string; name: string } {
  const i = path.lastIndexOf("/");
  return i < 0 ? { dir: "", name: path } : { dir: path.slice(0, i + 1), name: path.slice(i + 1) };
}

export const LANE_COLORS = [
  "#4f9cf9",
  "#e5734f",
  "#5cc28a",
  "#c27ae6",
  "#e8b84a",
  "#46c2c9",
  "#e5609a",
  "#9aa64a",
];

export function laneColor(index: number): string {
  return LANE_COLORS[index % LANE_COLORS.length];
}
