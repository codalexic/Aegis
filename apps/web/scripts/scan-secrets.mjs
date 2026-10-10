// Prints paths and categories only, never matching credential values.
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { resolve, relative, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

const root = fileURLToPath(new URL("../../../", import.meta.url));
function files(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((item) => item.isDirectory() ? files(join(directory, item.name)) : item.isFile() ? [join(directory, item.name)] : []);
}
function base58(bytes) {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let n = BigInt(`0x${bytes.toString("hex")}`), result = "";
  while (n) { result = alphabet[Number(n % 58n)] + result; n /= 58n; }
  for (const byte of bytes) { if (byte !== 0) break; result = `1${result}`; }
  return result;
}
const secrets = new Set();
for (const path of files(join(root, ".keys"))) {
  if (!path.endsWith(".json")) continue;
  let bytes;
  try { bytes = JSON.parse(readFileSync(path, "utf8")); } catch { continue; }
  if (!Array.isArray(bytes) || bytes.length !== 64 || !bytes.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)) continue;
  secrets.add(JSON.stringify(bytes));
  for (const data of [Buffer.from(bytes), Buffer.from(bytes.slice(0, 32))]) {
    secrets.add(data.toString("hex")); secrets.add(data.toString("base64")); secrets.add(base58(data));
  }
}
const envFiles = readdirSync(root).filter((name) => name === ".env" || name.startsWith(".env."));
for (const name of envFiles) {
  for (const [key, value] of Object.entries(parseEnv(readFileSync(join(root, name), "utf8")))) {
    if (/KEY|SECRET|TOKEN|PASSWORD/.test(key) && value.length >= 16) secrets.add(value);
  }
}
for (const key of ["GEMINI_API_KEY", "AEGIS_AGENT_SECRET", "AEGIS_FAUCET_SECRET"]) {
  if (process.env[key]?.length >= 16) secrets.add(process.env[key]);
}
const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: root }).toString().split("\0").filter(Boolean);
const dist = resolve(root, process.argv[2] ?? "apps/web/dist");
if (!existsSync(dist)) throw new Error("Build output is missing; build the web app first.");
const targets = [...new Set([...tracked.map((path) => join(root, path)), ...files(dist)])];
let failures = 0;
for (const path of targets) {
  const name = relative(root, path);
  const text = readFileSync(path).toString("utf8");
  const compact = text.replace(/\s/g, "");
  const categories = [];
  if (/(^|\/)\.keys\/|(^|\/)\.env($|\.)|(^|\/)[^/]*-keypair\.json$/.test(name) && tracked.includes(name)) categories.push("tracked credential file");
  if ([...secrets].some((secret) => text.includes(secret) || compact.includes(secret.replace(/\s/g, "")))) categories.push("local credential match");
  if (/AIza[\w-]{35}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(text)) categories.push("credential pattern");
  if (/\[\s*\d{1,3}(?:\s*,\s*\d{1,3}){63}\s*\]/.test(text)) categories.push("literal 64-byte key array");
  if (path.startsWith(`${dist}/`) && /secretKey|AEGIS_AGENT_SECRET|AEGIS_FAUCET_SECRET/.test(text)) categories.push("server signing material in browser bundle");
  if (categories.length) { failures++; console.error(`${name}: ${categories.join(", ")}`); }
}
if (failures) { console.error(`FAIL: ${failures} files require review.`); process.exitCode = 1; }
else console.log(`PASS: ${tracked.length} git-tracked files and ${files(dist).length} bundle files; no credentials or browser signing material found.`);
