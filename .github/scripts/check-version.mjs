// Ensures package.json, Cargo.toml and tauri.conf.json carry the same version,
// and that it matches the release tag (vX.Y.Z) when one is passed.
//
// Usage: node .github/scripts/check-version.mjs [tag]
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

const versions = {
  "package.json": JSON.parse(read("package.json")).version,
  "src-tauri/tauri.conf.json": JSON.parse(read("src-tauri/tauri.conf.json")).version,
  "src-tauri/Cargo.toml": /^\[package\][^[]*?^version\s*=\s*"([^"]+)"/m.exec(read("src-tauri/Cargo.toml"))?.[1],
};

for (const [file, version] of Object.entries(versions)) {
  console.log(`${file.padEnd(28)} ${version ?? "(not found)"}`);
}

const unique = new Set(Object.values(versions));
if (unique.size !== 1 || unique.has(undefined)) {
  console.error("::error::Versions differ between package.json, Cargo.toml and tauri.conf.json");
  process.exit(1);
}

const tag = process.argv[2];
const [version] = unique;
if (tag && tag !== `v${version}`) {
  console.error(`::error::Tag ${tag} does not match version ${version} (expected v${version})`);
  process.exit(1);
}
console.log(tag ? `Tag ${tag} matches.` : "No tag given; versions are consistent.");
