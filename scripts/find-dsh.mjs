#!/usr/bin/env node
// find-dsh.mjs —— 部署时确定「这台 DSH 在哪」。
//
// 只在安装/部署时跑一次，不需要常驻。三级探测，按顺序来，找到就停：
//   1. 环境变量 / 命令参数（DSH_WEB_URL、--url）—— DSH 会话里通常已经有
//   2. 本机监听端口 —— 先看看自己这台机器上有没有 DSH 在听
//   3. 局域网扫描 —— 拿本机网段 + 候选端口，找同一网段里像 DSH 的 HTTP 服务
//   4. 都找不到 → 打印手动填写指引（--manual 可直接交互输入）
//
// 指纹：DSH 的 web 在未登录时对所有路径返回 401 + 明文
//   "dsh web authentication required; reopen the URL printed by dsh web."
// 登录后的首页 HTML 里带 window.__DSH_BOOT__。两条中命中任意一条就算 DSH。
//
// 零依赖，Node >= 18。用法：
//   node scripts/find-dsh.mjs                 # 自动：环境变量 → 本机 → 局域网
//   node scripts/find-dsh.mjs --lan           # 跳过本机，直接扫局域网
//   node scripts/find-dsh.mjs --local         # 只看本机监听端口
//   node scripts/find-dsh.mjs --range 192.168.1.0/24
//   node scripts/find-dsh.mjs --ports 3080,3099,8080
//   node scripts/find-dsh.mjs --url http://192.168.1.5:3080   # 只验证给定地址
//   node scripts/find-dsh.mjs --manual        # 全程手动（交互输入）
//   node scripts/find-dsh.mjs --json          # 机器可读输出
//   node scripts/find-dsh.mjs --timeout 900 --concurrency 96

import http from "node:http";
import https from "node:https";
import os from "node:os";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createInterface } from "node:readline/promises";

const DEFAULT_PORTS = [3080, 3099, 3000, 8080, 8000];
const USER_AGENT = "dsh-billing-chip/find-dsh";

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  if (i === -1 || i === argv.length - 1) return fallback;
  return argv[i + 1];
};

const TIMEOUT = Number(opt("timeout", 900)) || 900;
const CONCURRENCY = Math.max(1, Number(opt("concurrency", 128)) || 128);
const JSON_OUT = flag("json");
const MANUAL = flag("manual");

// ---------------------------------------------------------------------------
// HTTP 探测
// ---------------------------------------------------------------------------

function request(url, { timeout = TIMEOUT, method = "GET", headers = {} } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    let lib = http;
    let parsed;
    try {
      parsed = new URL(url);
      if (parsed.protocol === "https:") lib = https;
    } catch {
      return done({ ok: false, error: "bad-url" });
    }
    // 注意：http.request 的 timeout 只管 socket 空闲，连不上的地址（ARP 无回应）
    // 会一直挂到系统级超时。所以自己拿一个总时长保险丝。
    const fuse = setTimeout(() => {
      req.destroy();
      done({ ok: false, error: "timeout" });
    }, timeout);
    const req = lib.request(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
        path: `${parsed.pathname}${parsed.search}`,
        method,
        agent: false,
        headers: { host: parsed.host, "user-agent": USER_AGENT, connection: "close", ...headers },
        rejectUnauthorized: false,
        timeout,
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          if (body.length < 8192) body += chunk;
        });
        res.on("end", () => {
          clearTimeout(fuse);
          done({ ok: true, status: res.statusCode, headers: res.headers, body });
        });
      },
    );
    req.on("timeout", () => {
      req.destroy();
      clearTimeout(fuse);
      done({ ok: false, error: "timeout" });
    });
    req.on("error", (error) => {
      clearTimeout(fuse);
      done({ ok: false, error: error.code || error.message });
    });
    req.end();
  });
}

const NEEDLE_UNAUTH = "dsh web authentication required";
const NEEDLE_BOOT = "__DSH_BOOT__";

/** 判断一个 base URL 是不是 DSH。返回 { hit, authenticated, evidence } */
async function probe(baseUrl) {
  const root = await request(baseUrl, { timeout: TIMEOUT });
  if (root.ok) {
    const text = String(root.body || "");
    const lower = text.toLowerCase();
    if (lower.includes(NEEDLE_UNAUTH)) return { hit: true, status: root.status, authenticated: false, evidence: "401 提示文案" };
    if (text.includes(NEEDLE_BOOT)) return { hit: true, status: root.status, authenticated: true, evidence: "__DSH_BOOT__" };
    // 反向代理挂在子路径时根路径可能是别的东西，再试两个 DSH 专属路径
    if (root.status === 404 || root.status === 200) {
      const api = await request(`${baseUrl.replace(/\/$/, "")}/api/file`, { timeout: TIMEOUT });
      if (api.ok && api.status === 401) {
        const first = await request(`${baseUrl.replace(/\/$/, "")}/?dsh-probe=1`, { timeout: TIMEOUT });
        if (first.ok && String(first.body || "").toLowerCase().includes(NEEDLE_UNAUTH)) {
          return { hit: true, status: first.status, authenticated: false, evidence: "/api/file 401 + 文案" };
        }
      }
    }
    return { hit: false, status: root.status, evidence: `HTTP ${root.status}` };
  }
  return { hit: false, error: root.error };
}

// ---------------------------------------------------------------------------
// 本机监听端口
// ---------------------------------------------------------------------------

function localListeningPorts() {
  const ports = new Set();

  // Linux：优先 ss（快、稳定），退到 /proc/net/tcp
  try {
    const out = execFileSync("ss", ["-lntH"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    for (const line of out.split("\n")) {
      const m = line.trim().match(/\s(\S+):(\d+)\s/);
      if (m) ports.add(Number(m[2]));
    }
    if (ports.size > 0) return [...ports];
  } catch {
    /* ss 不在就继续 */
  }

  try {
    for (const file of ["/proc/net/tcp", "/proc/net/tcp6"]) {
      let text = "";
      try {
        text = readFileSync(file, "utf8");
      } catch {
        continue;
      }
      for (const line of text.split("\n").slice(1)) {
        const cols = line.trim().split(/\s+/);
        if (cols.length < 4) continue;
        if (cols[3] !== "0A") continue; // 0A = LISTEN
        const hex = cols[1].split(":").pop();
        if (hex) ports.add(parseInt(hex, 16));
      }
    }
    if (ports.size > 0) return [...ports];
  } catch {
    /* ignore */
  }

  // macOS / Windows：netstat
  try {
    const args = process.platform === "win32" ? ["-ano", "-p", "tcp"] : ["-an", "-p", "tcp"];
    const out = execFileSync("netstat", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    for (const line of out.split("\n")) {
      if (!/LISTEN|LISTENING/i.test(line)) continue;
      const m = line.match(/[.:](\d{1,5})\s/);
      if (m) ports.add(Number(m[1]));
    }
  } catch {
    /* ignore */
  }

  return [...ports];
}

// ---------------------------------------------------------------------------
// 网段
// ---------------------------------------------------------------------------

function netmaskToPrefix(mask) {
  if (!mask) return 24;
  return mask
    .split(".")
    .map((part) => Number(part).toString(2).padStart(8, "0"))
    .join("")
    .split("")
    .filter((b) => b === "1").length;
}

/** 本机所有 IPv4 网段的 /24 区块（大网段截断到 /24，最多 4 个网段） */
// 这些网卡不是"用户真正在用的局域网"：容器网桥、VPN、虚拟网卡。
// 默认跳过，避免把 172.17/172.21… 这些 docker 网段也铺一遍（能省掉 80% 的探测点）。
const VIRTUAL_IFACE = /^(docker|br-|veth|virbr|vmnet|vboxnet|utun|tun|tap|zt|tailscale|wg|ham)/i;

function localSubnets({ includeVirtual = false } = {}) {
  const result = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    if (!includeVirtual && VIRTUAL_IFACE.test(name)) continue;
    for (const addr of addrs || []) {
      if (addr.family !== "IPv4" || addr.internal) continue;
      // 172.16.0.0/12 几乎总是 docker / 内网隧道
      if (!includeVirtual && /^172\.(1[6-9]|2\d|3[01])\./.test(addr.address)) continue;
      const prefix = netmaskToPrefix(addr.netmask);
      const effective = Math.max(prefix, 24); // 只扫 /24，避免一次铺满整个 /16
      const ipParts = addr.address.split(".").map(Number);
      const size = 2 ** (32 - effective);
      const base = ipParts.reduce((acc, part, i) => acc + part * 256 ** (3 - i), 0);
      const start = Math.floor(base / size) * size;
      const ranges = [];
      // /24 就是一个块；更大的网段（effective 更小）不会发生，因为至少 /24
      for (let i = 1; i < size - 1; i++) {
        const ip = start + i;
        ranges.push([(ip >>> 24) & 255, (ip >>> 16) & 255, (ip >>> 8) & 255, ip & 255].join("."));
      }
      result.push({ name, iface: addr.address, prefix, effective, hosts: ranges });
    }
  }
  return result;
}

async function pool(items, worker, concurrency) {
  const results = [];
  let index = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (index < items.length) {
      const i = index++;
      results[i] = await worker(items[i], i);
    }
  });
  await Promise.all(runners);
  return results;
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

function normalize(url) {
  let value = String(url || "").trim();
  if (!value) return null;
  if (!/^https?:\/\//i.test(value)) value = `http://${value}`;
  return value.replace(/\/+$/, "");
}

function report(found, extra = {}) {
  if (JSON_OUT) {
    console.log(JSON.stringify({ found, ...extra }, null, 2));
    return;
  }
  if (found) {
    console.log(`DSH_FOUND ${found.url}`);
    console.log(`  source:        ${found.source}${found.evidence ? ` (${found.evidence})` : ""}`);
    console.log(`  authenticated: ${found.authenticated ? "yes（浏览器已登录过）" : "no（需要 DSH Web 打印的 token 链接打开）"}`);
    console.log(`\n下一步：用浏览器打开 ${found.url} ，或者把下面这行给安装脚本：`);
    console.log(`DSH_URL=${found.url}`);
  } else {
    console.log("DSH_NOT_FOUND 三级探测都没找到，需要手动确认。");
    console.log("\n请你回答：DSH Web 的地址是什么？（形如 http://192.168.1.5:3080）");
    console.log("拿到地址后可以直接验证：");
    console.log("  node scripts/find-dsh.mjs --url <你填的地址>");
    console.log("  curl -s -o /dev/null -w '%{http_code}\\n' <你填的地址>/     # 401 就是 DSH");
  }
}

async function tryUrl(url, source) {
  const hit = await probe(url);
  if (hit.hit) {
    return {
      url,
      source,
      authenticated: hit.authenticated,
      evidence: hit.evidence,
      headers: undefined,
    };
  }
  return null;
}

async function main() {
  let lastMode = "auto";
  // 0. 显式地址
  const explicit = normalize(opt("url"));
  if (explicit) {
    const found = await tryUrl(explicit, "--url 指定");
    if (found) return report(found, { mode: "explicit" });
    if (!JSON_OUT) console.error(`指定的 ${explicit} 不像 DSH`);
    return report(null, { mode: "explicit", tried: [explicit] });
  }

  // 1. 环境变量（DSH 会话里通常有）
  if (!MANUAL && !flag("lan") && !flag("local")) {
    for (const key of ["DSH_WEB_URL", "DSH_PUBLIC_URL", "DSH_URL"]) {
      const envUrl = normalize(process.env[key]);
      if (!envUrl) continue;
      const found = await tryUrl(envUrl, `环境变量 ${key}`);
      if (found) return report(found, { mode: "env" });
    }
  }

  // 2. 本机监听端口
  if (!MANUAL && !flag("lan")) {
    const ports = localListeningPorts();
    const ordered = [...new Set([...DEFAULT_PORTS.filter((p) => ports.includes(p)), ...ports])];
    if (!JSON_OUT) console.error(`[find-dsh] 本机 ${ports.length} 个监听端口，检查其中的 HTTP 服务…`);
    for (const port of ordered) {
      const found = await tryUrl(`http://127.0.0.1:${port}`, `本机端口 ${port}`);
      if (found) return report(found, { mode: "local", scanned: ordered.length });
    }
    if (flag("local")) return report(null, { mode: "local" });
  }

  // 3. 局域网扫描
  if (!MANUAL) {
    const subnets = localSubnets({ includeVirtual: flag("all-ifaces") });
    const ports = (opt("ports") || DEFAULT_PORTS.join(",")).split(",").map((p) => Number(p.trim())).filter(Boolean);
    const custom = opt("range");
    let targets = [];
    if (custom) {
      const [base, prefixRaw] = custom.split("/");
      const prefix = Number(prefixRaw || 24);
      const size = 2 ** (32 - Math.max(prefix, 24));
      const baseNum = base.split(".").reduce((acc, part, i) => acc + Number(part) * 256 ** (3 - i), 0);
      for (let i = 1; i < size - 1; i++) {
        const ip = baseNum + i;
        targets.push([(ip >>> 24) & 255, (ip >>> 16) & 255, (ip >>> 8) & 255, ip & 255].join("."));
      }
    } else {
      for (const subnet of subnets) targets.push(...subnet.hosts);
    }
    targets = [...new Set(targets)];
    if (!JSON_OUT) {
      console.error(`[find-dsh] 局域网：${targets.length} 个地址 × ${ports.length} 个端口（并发 ${CONCURRENCY}，超时 ${TIMEOUT}ms）`);
    }
    const jobs = [];
    for (const host of targets) for (const port of ports) jobs.push(`http://${host}:${port}`);
    if (!JSON_OUT) console.error(`[find-dsh] 共 ${jobs.length} 个探测点…`);
    const hits = await pool(
      jobs,
      async (url) => {
        const hit = await probe(url);
        return hit.hit ? { url, source: "局域网扫描", authenticated: hit.authenticated, evidence: hit.evidence } : null;
      },
      CONCURRENCY,
    );
    const found = hits.find(Boolean);
    if (found) return report(found, { mode: "lan", scanned: jobs.length });
    if (!JSON_OUT) console.error(`[find-dsh] 扫了 ${jobs.length} 个探测点，没有 DSH`);
    lastMode = "lan";
  }

  // 4. 手动填写（交互终端才问；--json 或非 TTY 直接给指引）
  if (!JSON_OUT && (MANUAL || process.stdin.isTTY)) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        const answer = await rl.question("DSH Web 地址（形如 http://192.168.1.5:3080，回车跳过）：");
        const url = normalize(answer);
        if (!url) break;
        const found = await tryUrl(url, "手动填写");
        if (found) {
          rl.close();
          return report(found, { mode: "manual" });
        }
        console.log(`  这个地址没回应 DSH 的指纹（401 + "dsh web authentication required"），再试一次？`);
      }
    } finally {
      rl.close();
    }
  }

  return report(null, { mode: lastMode });
}

main().catch((error) => {
  console.error("[find-dsh] 出错：", error?.message || error);
  process.exitCode = 1;
});
