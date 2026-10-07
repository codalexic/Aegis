import { copyFile, mkdir, readdir } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const destination = new URL("artifacts/idl/", root);
const files = [];

for (const [directory, extension] of [["target/idl/", ".json"], ["target/types/", ".ts"]]) {
  const source = new URL(directory, root);
  const names = (await readdir(source)).filter((name) => name.endsWith(extension)).sort();
  if (names.length === 0) {
    throw new Error(`No ${extension} files in ${directory}; run anchor build first.`);
  }
  for (const name of names) {
    files.push([new URL(name, source), new URL(name, destination)]);
  }
}

await mkdir(destination, { recursive: true });
for (const [source, target] of files) {
  await copyFile(source, target);
}
console.log(`Copied ${files.length} generated IDL/type files to artifacts/idl/.`);
