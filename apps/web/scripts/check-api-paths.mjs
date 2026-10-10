import { readdirSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const directory = resolve(process.argv[2] ?? fileURLToPath(new URL("../../../api", import.meta.url)));
let files = 0;
function check(directory) {
  const segments = new Map();
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const extension = extname(entry.name);
    const stem = extension && !/^\[.*\]$/.test(entry.name) ? entry.name.slice(0, -extension.length) : entry.name;
    // Dynamic siblings occupy the same route segment regardless of parameter name.
    const segment = /^\[.*\]$/.test(stem) ? "[]" : stem;
    if (segments.has(segment)) throw new Error(`Conflicting API paths: ${join(directory, segments.get(segment))} and ${join(directory, entry.name)}`);
    segments.set(segment, entry.name);
    if (entry.isDirectory()) check(join(directory, entry.name));
    else if (entry.isFile()) files++;
  }
}

try {
  check(directory);
  console.log(`PASS: ${files} API files; no conflicting path segments or filenames.`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
