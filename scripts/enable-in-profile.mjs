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
const SERVICE = opt("service", "dsh-web.service");
const STOP_SERVICE = flag("stop-service");

// pnpm 重建 node_modules 期间，如果 dsh web 正在跑，HMR 会立刻重载插件层 →
// 重载时 node_modules 还是空的 → 所有插件加载失败（表现：记忆/口袋/团队全没了），
// 而且安装本身也会被打断，留下一个空的 node_modules。
// 所以：默认要求先停服务；--stop-service 让它自己停、装完再起。
function serviceActive() {
  try {
    const out = execFileSync("systemctl", ["is-active", SERVICE], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return out === "active";
  } catch {
    return false;
  }
}

function systemctl(verb) {
  execFileSync("systemctl", [verb, SERVICE], { stdio: "inherit" });
}

/** node_modules 硬链接快照：秒级、几乎不占空间，安装失败可以立刻还原 */
function snapshotNodeModules() {
  const target = join(profileDir, `node_modules.bak.${Date.now()}`);
  if (!existsSync(join(profileDir, "node_modules"))) return null;
  try {
    execFileSync("cp", ["-al", join(profileDir, "node_modules"), target], { stdio: "ignore" });
    return target;
  } catch {
    return null;
  }
}

function restoreSnapshot(target) {
  if (!target || !existsSync(target)) return false;
  const live = join(profileDir, "node_modules");
  try {
    execFileSync("rm", ["-rf", live], { stdio: "ignore" });
    execFileSync("mv", [target, live], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

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
  if (serviceActive()) {
    console.log("");
    console.log(`⚠ ${SERVICE} 正在运行。真正安装前请先停它，或者加 --stop-service 让脚本自己停：`);
    console.log(`  systemctl stop ${SERVICE}`);
  }
  process.exit(0);
}

// 写盘前的守卫：服务还在跑 + 要动 node_modules = 会把自己（正在运行的 dsh web）搞坏
if (INSTALL && serviceActive() && !STOP_SERVICE) {
  console.error(`✗ ${SERVICE} 正在运行，不能直接改 node_modules。`);
  console.error("");
  console.error("  pnpm 重建 node_modules 的这几秒里，dsh 的 HMR 会发现 profile 变了并立刻重载；");
  console.error("  重载时依赖还没落地 → 所有插件一起加载失败（记忆、口袋、团队都会消失），");
  console.error("  安装本身也可能被打断，只剩一个空的 node_modules。");
  console.error("");
  console.error("两种做法，选一种：");
  console.error("  A) 手动编排：");
  console.error(`       systemctl stop ${SERVICE}`);
  console.error(`       node scripts/enable-in-profile.mjs --profile ${profileName} --write`);
  console.error(`       systemctl start ${SERVICE}`);
  console.error("  B) 让脚本自己停、装、起：");
  console.error(`       node scripts/enable-in-profile.mjs --profile ${profileName} --write --stop-service`);
  console.error("");
  console.error("  只想先改 package.json、不碰 node_modules（服务可继续跑）：加 --no-install");
  process.exit(2);
}

const backup = `${profileJsonPath}.bak.${Date.now()}`;
copyFileSync(profileJsonPath, backup);
writeFileSync(profileJsonPath, after);
console.log(`✓ 已写入 ${profileJsonPath}`);
console.log(`  备份：${backup}`);

if (INSTALL) {
  const wasActive = serviceActive();
  if (wasActive && STOP_SERVICE) {
    console.log(`\n先停 ${SERVICE}…`);
    systemctl("stop");
  }

  const snapshot = snapshotNodeModules();
  if (snapshot) console.log(`node_modules 快照：${snapshot}`);

  // 两阶段，尽量不动网络、不动旧依赖：
  //   1) pnpm add <name>@link:… --lockfile-only   只改 lock，不碰 node_modules
  //   2) pnpm install --frozen-lockfile --prefer-offline  按 lock 从 store 链接
  // 这样即使中途被打断，也不会留下一堆下载了一半的包。
  console.log("\n[1/2] 更新 lockfile（不碰 node_modules）…");
  let lockOk = false;
  try {
    execFileSync("pnpm", ["add", `${pluginName}@link:${pluginDir}`, "--lockfile-only"], {
      cwd: profileDir,
      stdio: "inherit",
      timeout: 120000,
    });
    lockOk = true;
  } catch (error) {
    console.error(`  lockfile-only 失败（${error.message}），退回到整体安装`);
  }

  console.log("\n[2/2] 链接依赖（frozen lockfile + 本地 store）…");
  try {
    const args = lockOk
      ? ["install", "--frozen-lockfile", "--prefer-offline"]
      : ["install", "--no-frozen-lockfile", "--prefer-offline"];
    execFileSync("pnpm", args, { cwd: profileDir, stdio: "inherit", timeout: 300000 });
    console.log("✓ 依赖装好");
  } catch (error) {
    console.error(`✗ pnpm install 失败：${error.message}`);
    if (snapshot && restoreSnapshot(snapshot)) {
      console.error("✓ 已从快照还原 node_modules（服务恢复原样）");
    } else {
      console.error("⚠ 没能还原快照，手动跑一次：");
      console.error(`   cd ${profileDir} && pnpm install --frozen-lockfile --prefer-offline`);
    }
    if (wasActive && STOP_SERVICE) {
      console.error(`把服务起回来：systemctl start ${SERVICE}`);
      try {
        systemctl("start");
      } catch {
        /* ignore */
      }
    }
    process.exit(1);
  }

  if (snapshot && existsSync(snapshot)) {
    try {
      execFileSync("rm", ["-rf", snapshot], { stdio: "ignore" });
    } catch {
      /* ignore */
    }
  }

  if (wasActive && STOP_SERVICE) {
    console.log(`\n重新启动 ${SERVICE}…`);
    systemctl("start");
    console.log("✓ 服务已起");
  }
}

console.log("\n下一步：重启 dsh web 让插件生效（client half 也会跟着刷新）。");
console.log("  重启后验证：");
console.log(`    curl -s "$DSH_URL/api/${pluginName}/state" -H "Origin: $DSH_URL"`);
