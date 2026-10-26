#!/usr/bin/env node
// enable-in-profile.mjs —— 把一个 dsh 插件挂进指定 profile。
//
// 做的事就是手工那三步，但不会漏：
//   1. profile/package.json 的 dependencies 里写上 link:<插件绝对路径>
//   3. dsh.profile.bundles 里加上插件名（去重）
//   2. 在该 profile 目录跑 pnpm install
//
// 默认 dry-run，只打印将要做的改动；确认无误后加 --write 才真的写盘。
//
// 用法：
//   node scripts/enable-in-profile.mjs                       # dry-run，profile=web
//   node scripts/enable-in-profile.mjs --profile billing     # 指定 profile
//   node scripts/enable-in-profile.mjs --write               # 真的改 + pnpm install
//   node scripts/enable-in-profile.mjs --write --no-install  # 只改文件，不装

import { readFileSync, writeFileSync, existsSync, copyFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 || i === argv.length - 1 ? fallback : argv[i + 1];
};

const here = dirname(fileURLToPath(import.meta.url));
const pluginDir = resolve(here, "..");
const pluginJson = JSON.parse(readFileSync(join(pluginDir, "package.json"), "utf8"));
const pluginName = pluginJson.name;

const profileName = opt("profile", "web");
const dshHome = process.env.DSH_HOME || join(homedir(), ".dsh");
const profileDir = join(dshHome, "profiles", profileName);
const profileJsonPath = join(profileDir, "package.json");
const WRITE = flag("write");
const INSTALL = !flag("no-install");

function die(message) {
  console.error(`✗ ${message}`);
  process.exit(1);
}

if (!existsSync(profileJsonPath)) {
  die(`找不到 profile：${profileJsonPath}\n  先用 dsh --profile ${profileName} 启动一次让它初始化，或者检查 DSH_HOME`);
}

const before = readFileSync(profileJsonPath, "utf8");
let data;
try {
  data = JSON.parse(before);
} catch (error) {
  die(`profile/package.json 不是合法 JSON：${error.message}`);
}

data.dependencies = data.dependencies && typeof data.dependencies === "object" ? data.dependencies : {};
data.dsh = data.dsh && typeof data.dsh === "object" ? data.dsh : {};
data.dsh.profile = data.dsh.profile && typeof data.dsh.profile === "object" ? data.dsh.profile : {};
const bundles = Array.isArray(data.dsh.profile.bundles) ? [...data.dsh.profile.bundles] : [];
if (!bundles.includes(pluginName)) bundles.push(pluginName);
data.dsh.profile.bundles = bundles;

const wantDep = `link:${pluginDir}`;
const depChanged = data.dependencies[pluginName] !== wantDep;
data.dependencies[pluginName] = wantDep;

const after = `${JSON.stringify(data, null, 2)}\n`;

console.log(`插件：${pluginName}  (${pluginDir})`);
console.log(`profile：${profileName}  (${profileDir})`);
console.log(`DSH_HOME：${dshHome}`);
console.log("");
console.log("将做这些改动：");
console.log(`  dependencies["${pluginName}"] = "${wantDep}"${depChanged ? "" : "   ← 已经是这个值"}`);
console.log(`  dsh.profile.bundles = ${JSON.stringify(bundles)}`);
console.log("");

if (before === after && !flag("force")) {
  console.log("profile 已经是目标状态，不需要改。");
  if (!INSTALL || !WRITE) process.exit(0);
} else {
  console.log("--- 改动预览 ---");
  const beforeLines = before.split("\n");
  const afterLines = after.split("\n");
  for (const line of afterLines) {
    const text = line.trim();
    if (text.includes(pluginName) || text.includes("bundles") || text.includes("dependencies")) {
      const isNew = !beforeLines.some((b) => b.trim() === text);
      console.log(`${isNew ? "+" : " "} ${line}`);
    }
  }
  console.log("");
}

if (!WRITE) {
  console.log("这是 dry-run。确认没问题后重跑并加 --write：");
  console.log(`  node scripts/enable-in-profile.mjs --profile ${profileName} --write`);
  process.exit(0);
}

const backup = `${profileJsonPath}.bak.${Date.now()}`;
copyFileSync(profileJsonPath, backup);
writeFileSync(profileJsonPath, after);
console.log(`✓ 已写入 ${profileJsonPath}`);
console.log(`  备份：${backup}`);

if (INSTALL) {
  console.log("\n跑 pnpm install…");
  try {
    execFileSync("pnpm", ["install", "--no-frozen-lockfile"], { cwd: profileDir, stdio: "inherit" });
    console.log("✓ 依赖装好");
  } catch (error) {
    die(`pnpm install 失败：${error.message}\n  手动进 ${profileDir} 跑一次 pnpm install`);
  }
}

console.log("\n下一步：重启 dsh web 让插件生效（client half 也会跟着刷新）。");
console.log("  重启后验证：");
console.log(`    curl -s "$DSH_URL/api/${pluginName}/state" -H "Origin: $DSH_URL"`);
