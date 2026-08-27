#!/usr/bin/env node
/**
 * Sets the app version in the three places that must agree.
 *
 * They matter for different reasons: package.json is the npm manifest,
 * tauri.conf.json is what the updater manifest advertises, and Cargo.toml is
 * what the binary reports. If they drift, the updater compares the wrong
 * numbers and either misses a release or offers one that is already installed.
 *
 *   node scripts/set-version.mjs 0.2.0
 */

import { readFileSync, writeFileSync } from "node:fs";

const version = process.argv[2];

if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
  console.error("Usage: node scripts/set-version.mjs <major.minor.patch>");
  process.exit(1);
}

function edit(path, transform) {
  const before = readFileSync(path, "utf8");
  const after = transform(before);
  if (after === before) {
    console.error(`Could not find a version to replace in ${path}`);
    process.exit(1);
  }
  writeFileSync(path, after);
  console.log(`  ${path}`);
}

console.log(`Setting version ${version} in:`);

edit("package.json", (raw) => {
  const parsed = JSON.parse(raw);
  parsed.version = version;
  return `${JSON.stringify(parsed, null, 2)}\n`;
});

edit("src-tauri/tauri.conf.json", (raw) => {
  const parsed = JSON.parse(raw);
  parsed.version = version;
  return `${JSON.stringify(parsed, null, 2)}\n`;
});

// Only the [package] version, not any dependency's.
edit("src-tauri/Cargo.toml", (raw) =>
  raw.replace(/^version = "\d+\.\d+\.\d+"$/m, `version = "${version}"`),
);

console.log(`\nNext:\n  cargo check --manifest-path src-tauri/Cargo.toml   # refresh Cargo.lock`);
console.log(`  git commit -am "Release v${version}" && git tag v${version} && git push --follow-tags`);
