// Post-build guard for the generated service worker (run after `next build`).
// Usage: node apps/web/scripts/check-sw.mjs
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const publicDir = join(dirname(fileURLToPath(import.meta.url)), "..", "public");
const failures = [];
for (const f of ["notification-192.png", "badge-96.png"]) {
  try {
    readFileSync(join(publicDir, "icons", f));
  } catch {
    failures.push(`public/icons/${f} is missing (run scripts/generate-notification-icons.mjs)`);
  }
}
const check = (ok, msg) => {
  if (!ok) failures.push(msg);
};

let sw = "";
try {
  sw = readFileSync(join(publicDir, "sw.js"), "utf8");
} catch {
  failures.push("public/sw.js not found (run the web build first)");
}

if (sw) {
  // Token pages must be NetworkOnly and matched before the default runtimeCaching rules
  // (next-pwa registers its own "/"-only start-url route before both; it is harmless).
  const tokenRule = sw.search(/forgot-password\|reset-password\|activate/);
  check(tokenRule !== -1, "sw.js has no forgot-password|reset-password|activate rule");
  if (tokenRule !== -1) {
    const afterRule = sw.slice(tokenRule, tokenRule + 400);
    check(/NetworkOnly/.test(afterRule), "token-page rule is not NetworkOnly");
    const firstDefault = sw.search(/cacheName:\s*"(?:google-fonts|static-|next-|apis|others|pages)/);
    check(firstDefault === -1 || tokenRule < firstDefault, "token-page rule comes after a default caching rule");
  }

  const imports = [...sw.matchAll(/importScripts\(([^)]*)\)/g)];
  const workerImports = imports.filter((m) => /worker-/.test(m[1]));
  check(workerImports.length === 1, `expected exactly one importScripts("worker-..."), found ${workerImports.length}`);
  for (const m of workerImports) {
    check(!/https?:/.test(m[1]), "worker importScripts is not same-origin");
  }
  check(!/importScripts\([^)]*https?:/.test(sw), "sw.js imports an http(s) script URL");
}

const workerFiles = readdirSync(publicDir).filter((f) => /^worker-.*\.js$/.test(f));
check(workerFiles.length >= 1, "no public/worker-*.js generated");
if (workerFiles.length) {
  const worker = readFileSync(join(publicDir, workerFiles[workerFiles.length - 1]), "utf8");
  check(/addEventListener\(\s*["']push["']/.test(worker), "worker has no push handler");
  check(/addEventListener\(\s*["']notificationclick["']/.test(worker), "worker has no notificationclick handler");
  check(/notification-192\.png/.test(worker) && /badge-96\.png/.test(worker), "worker does not use the PNG notification icon and badge");
}

if (failures.length) {
  console.error("check-sw FAILED:\n- " + failures.join("\n- "));
  process.exit(1);
}
console.log("check-sw OK");
