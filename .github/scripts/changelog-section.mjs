// Prints one section of CHANGELOG.md, without its heading, for use as release notes.
//
// Usage: node .github/scripts/changelog-section.mjs <name>
//   <name> is a version ("0.2.0") or "Unreleased". Exits with 1 if the section
//   is missing or empty.
import { readFileSync } from "node:fs";

const name = process.argv[2];
if (!name) {
  console.error("Usage: changelog-section.mjs <version|Unreleased>");
  process.exit(2);
}

const lines = readFileSync(new URL("../../CHANGELOG.md", import.meta.url), "utf8").split("\n");
const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const start = lines.findIndex((l) => new RegExp(`^## \\[${escaped}\\]`).test(l));
if (start < 0) {
  console.error(`No "## [${name}]" section in CHANGELOG.md`);
  process.exit(1);
}

const body = [];
for (const line of lines.slice(start + 1)) {
  // Stop at the next section or at the link references at the end of the file.
  if (/^## \[/.test(line) || /^\[[^\]]+\]:\s/.test(line)) break;
  body.push(line);
}

const text = body.join("\n").trim();
if (!text) {
  console.error(`Section "## [${name}]" in CHANGELOG.md is empty`);
  process.exit(1);
}
console.log(text);
