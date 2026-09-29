// Static checks for the no-build frontend:
//  1. every module parses (node --check)
//  2. every relative named import exists in the target module
//  3. banned UI patterns (native select, alert/confirm/prompt, inline style attributes)
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const webJs = join(root, "web", "js");
const problems = [];

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith(".js") ? [p] : [];
  });
}

function exportsOf(src) {
  const names = new Set();
  for (const m of src.matchAll(/export\s+(?:async\s+)?(?:function\*?|const|let|class)\s+([A-Za-z0-9_$]+)/g)) names.add(m[1]);
  for (const m of src.matchAll(/export\s*\{([^}]+)\}/g)) {
    m[1].split(",").forEach((part) => {
      const name = part.trim().split(/\s+as\s+/).pop();
      if (name) names.add(name);
    });
  }
  return names;
}

const files = [...walk(webJs), join(root, "web", "sw.js")];
for (const file of files) {
  try {
    execFileSync(process.execPath, ["--check", file], { stdio: "pipe" });
  } catch (err) {
    problems.push(`${relative(root, file)}: syntax error\n${err.stderr}`);
    continue;
  }
  const src = readFileSync(file, "utf8");
  for (const m of src.matchAll(/import\s*\{([^}]+)\}\s*from\s*"(\.[^"]+)"/g)) {
    const target = resolve(dirname(file), m[2]);
    let targetSrc;
    try {
      targetSrc = readFileSync(target, "utf8");
    } catch {
      problems.push(`${relative(root, file)}: cannot resolve ${m[2]}`);
      continue;
    }
    const available = exportsOf(targetSrc);
    for (const raw of m[1].split(",")) {
      const name = raw.trim().split(/\s+as\s+/)[0];
      if (name && !available.has(name)) problems.push(`${relative(root, file)}: "${name}" is not exported by ${m[2]}`);
    }
  }
  const banned = [
    [/h\(\s*"select"/, "native <select>"],
    [/<select/i, "native <select>"],
    [/\b(?:window\.)?(?:alert|confirm|prompt)\(/, "alert/confirm/prompt"],
    [/[{,]\s*style\s*:/, "inline style attribute"],
  ];
  const code = src.split("\n").filter((line) => !/^\s*(\/\/|\/?\*)/.test(line)).join("\n");
  for (const [re, label] of banned) {
    if (re.test(code)) problems.push(`${relative(root, file)}: banned pattern — ${label}`);
  }
}

if (problems.length) {
  console.error(problems.join("\n"));
  process.exit(1);
}
console.log(`web check ok: ${files.length} files`);
