// dsh-billing-chip host half — 计费牌的数据后端。
//
// 提供四条同源 HTTP 路由给 client half（无 CORS、无跨域）：
//   GET  /api/dsh-billing-chip/state    当前会话模型、本轮用量、今日累计、余额
//   POST /api/dsh-billing-chip/key      { apiKey } 保存 DeepSeek API Key（0600）并立即刷新余额
//   POST /api/dsh-billing-chip/refresh  重新拉一次余额
//   POST /api/dsh-billing-chip/ui       { enabled?, position? } 记下界面偏好
//
// 数据来源是 DSH 自己的会话日志（$DSH_HOME/sessions/**/session*.jsonl.zstd），
// 不订阅任何内部事件、不依赖未公开 API：日志里有 assistant/message 的 usage
// 与 request/header 的 provider/model，足够算钱。
//
// 费用口径：按 DeepSeek 官方价（元/百万 token），缓存命中/未命中/输出分别计价，
// 北京时间工作日 09:00–12:00、14:00–18:00 为高峰（价格翻倍），法定节假日不算高峰。

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { homedir } from "node:os";
import { zstdDecompressSync } from "node:zlib";

export const name = "dsh-billing-chip";
export const inject = ["webServer"];

const API = "/api/dsh-billing-chip";
const SETTINGS_VERSION = 1;

/** 官方价，单位：元 / 百万 token。[谷时, 峰时] */
const PRICE = {
  "deepseek-v4-pro": { hit: [0.15, 0.3], miss: [4.5, 9], out: [13.5, 27] },
  "deepseek-flash": { hit: [0.02, 0.04], miss: [1, 2], out: [4, 8] },
  _default: { hit: [0.02, 0.04], miss: [1, 2], out: [4, 8] },
};

/** 法定节假日（这些日子全天按谷时价）。每年补一次即可。 */
const HOLIDAYS = new Set([
  "2026-01-01", "2026-01-02", "2026-01-03",
  "2026-02-15", "2026-02-16", "2026-02-17", "2026-02-18", "2026-02-19", "2026-02-20", "2026-02-21", "2026-02-22", "2026-02-23",
  "2026-04-04", "2026-04-05", "2026-04-06",
  "2026-05-01", "2026-05-02", "2026-05-03", "2026-05-04", "2026-05-05",
  "2026-06-19", "2026-06-20", "2026-06-21",
  "2026-09-25", "2026-09-26", "2026-09-27",
  "2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04", "2026-10-05", "2026-10-06", "2026-10-07",
]);

const DAY_MS = 86400000;
const CACHE_MS = 1500;
const BALANCE_MS = 60000;

// ---------------------------------------------------------------------------
// 时间与价格
// ---------------------------------------------------------------------------

function bjParts(ts = Date.now()) {
  const d = new Date(ts + 8 * 3600e3);
  return {
    date: d.toISOString().slice(0, 10),
    day: d.getUTCDay(),
    hour: d.getUTCHours() + d.getUTCMinutes() / 60,
  };
}

function bjDate(ts = Date.now()) {
  return bjParts(ts).date;
}

/** 是否高峰时段（北京时间工作日 09-12、14-18，节假日除外）。 */
function isPeak(ts = Date.now()) {
  const p = bjParts(ts);
  if (HOLIDAYS.has(p.date)) return false;
  if (p.day === 0 || p.day === 6) return false;
  return (p.hour >= 9 && p.hour < 12) || (p.hour >= 14 && p.hour < 18);
}

function priceFor(model, overrides) {
  const m = String(model || "").toLowerCase();
  const table = { ...PRICE, ...(overrides || {}) };
  for (const key of Object.keys(table).sort((a, b) => b.length - a.length)) {
    if (key !== "_default" && m.includes(key)) return table[key];
  }
  return table._default;
}

/** 一次 usage → 人民币。峰谷决定用哪一档。 */
function costOf(usage, model, peak, overrides) {
  const p = priceFor(model, overrides);
  const slot = peak ? 1 : 0;
  const hit = Number(usage?.cacheReadTokens) || 0;
  const missInput = (Number(usage?.inputTokens) || 0) + (Number(usage?.cacheWriteTokens) || 0);
  const out = Number(usage?.outputTokens) || 0;
  const cost =
    (hit * p.hit[slot] + missInput * p.miss[slot] + out * p.out[slot]) / 1e6;
  return { cost, hit, missInput, out, price: p };
}

function emptyUsage() {
  return { inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, totalTokens: 0 };
}

function addUsage(a, b) {
  return {
    inputTokens: (a.inputTokens || 0) + (Number(b?.inputTokens) || 0),
    cacheReadTokens: (a.cacheReadTokens || 0) + (Number(b?.cacheReadTokens) || 0),
    cacheWriteTokens: (a.cacheWriteTokens || 0) + (Number(b?.cacheWriteTokens) || 0),
    outputTokens: (a.outputTokens || 0) + (Number(b?.outputTokens) || 0),
    totalTokens: (a.totalTokens || 0) + (Number(b?.totalTokens) || 0),
  };
}

// ---------------------------------------------------------------------------
// 会话日志
// ---------------------------------------------------------------------------

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/**
 * 解压一个 DSH 会话日志。
 * 日志是多个 zstd frame 串起来的，一次性 zstdDecompressSync 只解第一帧，
 * 所以要按 magic 切帧后逐帧解。
 */
function readSessionLog(file) {
  const buf = readFileSync(file);
  const starts = [];
  for (let i = 0; i + 3 < buf.length; i++) {
    if (buf[i] === 0x28 && buf[i + 1] === 0xb5 && buf[i + 2] === 0x2f && buf[i + 3] === 0xfd) starts.push(i);
  }
  if (starts.length === 0) return buf.toString("utf8");
  let text = "";
  for (let k = 0; k < starts.length; k++) {
    const end = k + 1 < starts.length ? starts[k + 1] : buf.length;
    try {
      text += zstdDecompressSync(buf.subarray(starts[k], end)).toString("utf8");
    } catch {
      /* 尾帧可能正在写入，跳过 */
    }
  }
  return text;
}

/** 从一份日志里抽出计费需要的部分。 */
function parseSession(file) {
  const text = readSessionLog(file);
  const out = {
    file,
    model: null,
    provider: null,
    lastTime: 0,
    turns: new Map(), // turn → usage
    endedTurns: new Set(), // turn/end 出现过的轮次
    todayUsage: emptyUsage(),
    todayEvents: [], // {time, usage, model} 供逐条计价
    eventCount: 0,
  };
  const today = bjDate();
  for (const line of text.split("\n")) {
    if (!line) continue;
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    out.eventCount++;
    const t = Number(ev.time) || 0;
    if (t > out.lastTime) out.lastTime = t;
    if (ev.type === "request/header") {
      const cfg = ev.data?.header?.config;
      if (cfg) {
        out.provider = cfg.provider ?? out.provider;
        out.model = cfg.model ?? out.model;
      }
      continue;
    }
    if (ev.type === "turn/end") {
      const t2 = Number(ev.data?.turn);
      if (Number.isFinite(t2)) out.endedTurns.add(t2);
      continue;
    }
    if (ev.type !== "assistant/message") continue;
    const usage = ev.data?.usage;
    if (!usage) continue;
    const turn = Number(ev.data?.turn);
    if (Number.isFinite(turn)) {
      out.turns.set(turn, addUsage(out.turns.get(turn) || emptyUsage(), usage));
    }
    if (bjDate(t) === today) {
      out.todayUsage = addUsage(out.todayUsage, usage);
      out.todayEvents.push({ time: t, usage, turn });
    }
  }
  return out;
}

function sessionsRoot() {
  const home = process.env.DSH_HOME || join(homedir(), ".dsh");
  return join(home, "sessions");
}

/** 列出改过的会话日志：{file, mtimeMs, size} */
function listLogs(root) {
  const found = [];
  const walk = (dir, depth) => {
    if (depth > 3) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        walk(p, depth + 1);
        continue;
      }
      if (!/^session.*\.jsonl(\.zstd)?$/.test(e.name)) continue;
      try {
        const st = statSync(p);
        found.push({ file: p, mtimeMs: st.mtimeMs, size: st.size });
      } catch {
        /* ignore */
      }
    }
  };
  walk(root, 0);
  return found;
}

// ---------------------------------------------------------------------------
// 设置（API Key + UI 偏好）
// ---------------------------------------------------------------------------

function settingsPath(config) {
  if (config && typeof config.settingsPath === "string" && config.settingsPath) return config.settingsPath;
  const home = process.env.DSH_HOME || join(homedir(), ".dsh");
  return join(home, "dsh-billing-chip", "settings.json");
}

function readSettings(file) {
  try {
    const raw = JSON.parse(readFileSync(file, "utf8"));
    return {
      version: SETTINGS_VERSION,
      apiKey: typeof raw.apiKey === "string" ? raw.apiKey : "",
      ui: raw.ui && typeof raw.ui === "object" ? raw.ui : {},
      priceOverrides: raw.priceOverrides && typeof raw.priceOverrides === "object" ? raw.priceOverrides : {},
    };
  } catch {
    return { version: SETTINGS_VERSION, apiKey: "", ui: {}, priceOverrides: {} };
  }
}

function writeSettings(file, data) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(data, null, 2), { mode: 0o600 });
  try {
    chmodSync(file, 0o600);
  } catch {
    /* ignore */
  }
}

/**
 * API Key 的三个来源，优先级从高到低：
 *   1. settings.json 里用户自己填的（右键 → 输入 API Key）
 *   2. 插件配置里的 apiKey（cordis.yml 里给 dsh-billing-chip 配 config.apiKey）
 *   3. 环境变量 DEEPSEEK_API_KEY
 */
function resolveKey(settings, cfg) {
  if (settings && settings.apiKey) return { key: settings.apiKey, source: "settings" };
  const fromConfig = cfg && typeof cfg.apiKey === "string" ? cfg.apiKey.trim() : "";
  if (fromConfig) return { key: fromConfig, source: "config" };
  const fromEnv = String(process.env.DEEPSEEK_API_KEY || "").trim();
  if (fromEnv) return { key: fromEnv, source: "env" };
  return { key: "", source: null };
}

function maskKey(key) {
  if (!key) return "";
  if (key.length <= 10) return "****";
  return `${key.slice(0, 5)}…${key.slice(-4)}`;
}

// ---------------------------------------------------------------------------
// 余额
// ---------------------------------------------------------------------------

async function fetchBalance(apiKey) {
  if (!apiKey) return { ok: false, error: "未配置 API Key" };
  const res = await fetch("https://api.deepseek.com/user/balance", {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    return { ok: false, error: `HTTP ${res.status} ${body.slice(0, 160)}`.trim() };
  }
  const data = await res.json().catch(() => null);
  const infos = Array.isArray(data?.balance_infos) ? data.balance_infos : [];
  const cny = infos.find((i) => String(i.currency).toUpperCase() === "CNY") || infos[0];
  if (!cny) return { ok: false, error: "响应里没有余额条目" };
  return {
    ok: true,
    currency: cny.currency || "CNY",
    total: Number(cny.total_balance) || 0,
    granted: Number(cny.granted_balance) || 0,
    toppedUp: Number(cny.topped_up_balance) || 0,
    available: data?.is_available !== false,
    at: Date.now(),
  };
}

// ---------------------------------------------------------------------------
// 路由
// ---------------------------------------------------------------------------

/** 请求是否来自本机回环。 */
function isLoopback(req) {
  const addr = String(req.socket?.remoteAddress || "");
  return (
    addr === "127.0.0.1" ||
    addr === "::1" ||
    addr === "::ffff:127.0.0.1" ||
    addr.startsWith("127.") ||
    addr === ""
  );
}

/**
 * 浏览器发起的同源请求：Origin 必须存在且与 Host 一致。
 * 局域网里用 192.168.x.x:端口 打开 DSH 时就走这条路；
 * 而外部脚本没有 Origin，会被挡在门外（除非 allowRemote）。
 */
function isSameOrigin(req) {
  const origin = req.headers?.origin;
  if (!origin) return false;
  try {
    return new URL(origin).host === String(req.headers.host || "");
  } catch {
    return false;
  }
}

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(text),
  });
  res.end(text);
}

async function readJsonBody(req, limit = 64 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error("body too large");
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return {};
  }
}

export function apply(ctx, config) {
  const webServer = ctx.get("webServer");
  if (webServer === void 0) return;
  const cfg = config !== null && typeof config === "object" ? config : {};
  const file = settingsPath(cfg);
  const allowRemote = cfg.allowRemote === true;

  let cache = null; // { key, at, value }
  let balanceCache = null; // { at, value }

  function computeState(settings) {
    const resolved = resolveKey(settings, cfg);
    const root = sessionsRoot();
    const logs = listLogs(root).sort((a, b) => b.mtimeMs - a.mtimeMs);
    const key = `${resolved.source}:${resolved.key.length}|${logs.map((l) => `${l.file}:${l.size}:${l.mtimeMs}`).join("|")}`;
    if (cache && cache.key === key && Date.now() - cache.at < CACHE_MS) return cache.value;

    const today = bjDate();
    const dayStart = Date.parse(`${today}T00:00:00+08:00`);
    const todayLogs = logs.filter((l) => l.mtimeMs >= dayStart - DAY_MS);
    let todayCost = 0;
    let todayTokens = 0;
    let todayTurns = 0;
    let model = null;
    let current = null;

    for (const log of todayLogs) {
      let parsed;
      try {
        parsed = parseSession(log.file);
      } catch {
        continue;
      }
      if (!model && parsed.model) model = parsed.model;
      for (const e of parsed.todayEvents) {
        const peak = isPeak(e.time);
        const c = costOf(e.usage, parsed.model || cfg.defaultModel, peak, settings.priceOverrides);
        todayCost += c.cost;
        todayTokens += Number(e.usage.totalTokens) || 0;
        todayTurns++;
      }
      if (!current || parsed.lastTime > current.lastTime) current = parsed;
    }

    // 本轮：当前日志里最后一个 turn 的用量
    let turn = null;
    if (current) {
      const turnIds = [...current.turns.keys()].sort((a, b) => a - b);
      const lastTurn = turnIds.length > 0 ? turnIds[turnIds.length - 1] : null;
      if (lastTurn !== null) {
        const usage = current.turns.get(lastTurn);
        const lastEvent = current.todayEvents.filter((e) => e.turn === lastTurn).pop();
        const peak = isPeak(lastEvent?.time || Date.now());
        const c = costOf(usage, current.model || model, peak, settings.priceOverrides);
        turn = {
          index: lastTurn,
          usage,
          cost: c.cost,
          peak,
          done: current.endedTurns.has(lastTurn),
        };
      }
      if (current.model) model = current.model;
    }

    const value = {
      ok: true,
      at: Date.now(),
      model: model || cfg.defaultModel || "未知模型",
      provider: current?.provider || null,
      turn,
      today: { date: today, cost: todayCost, tokens: todayTokens, messages: todayTurns },
      peak: isPeak(),
      sessions: todayLogs.length,
      hasKey: Boolean(resolved.key),
      keyMasked: maskKey(resolved.key),
      keySource: resolved.source,
      allowRemote,
      balance: balanceCache && Date.now() - balanceCache.at < BALANCE_MS ? balanceCache.value : null,
      ui: settings.ui,
    };
    cache = { key, at: Date.now(), value };
    return value;
  }

  const routes = [
    {
      path: `${API}/state`,
      async handler(_ctx, req, res) {
        if (req.method !== "GET") return sendJson(res, 405, { ok: false, error: "GET only" });
        const settings = readSettings(file);
        return sendJson(res, 200, computeState(settings));
      },
    },
    {
      path: `${API}/key`,
      async handler(_ctx, req, res) {
        if (req.method !== "POST") return sendJson(res, 405, { ok: false, error: "POST only" });
        const body = await readJsonBody(req);
        const apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
        const settings = readSettings(file);
        settings.apiKey = apiKey;
        writeSettings(file, settings);
        balanceCache = null;
        cache = null;
        if (!apiKey) return sendJson(res, 200, { ok: true, hasKey: false, balance: null });
        const balance = await fetchBalance(apiKey);
        if (balance.ok) balanceCache = { at: Date.now(), value: balance };
        return sendJson(res, 200, { ok: true, hasKey: true, keyMasked: maskKey(apiKey), keySource: "settings", balance });
      },
    },
    {
      path: `${API}/refresh`,
      async handler(_ctx, req, res) {
        if (req.method !== "POST") return sendJson(res, 405, { ok: false, error: "POST only" });
        const settings = readSettings(file);
        const resolved = resolveKey(settings, cfg);
        if (!resolved.key) return sendJson(res, 200, { ok: false, error: "未配置 API Key（右键 → 输入 API Key）" });
        const balance = await fetchBalance(resolved.key);
        if (balance.ok) balanceCache = { at: Date.now(), value: balance };
        return sendJson(res, 200, { ok: balance.ok, balance, error: balance.ok ? undefined : balance.error });
      },
    },
    {
      path: `${API}/ui`,
      async handler(_ctx, req, res) {
        if (req.method !== "POST") return sendJson(res, 405, { ok: false, error: "POST only" });
        const body = await readJsonBody(req);
        const settings = readSettings(file);
        const ui = { ...settings.ui };
        if (body.enabled !== undefined) ui.enabled = Boolean(body.enabled);
        if (body.position && typeof body.position === "object") {
          const x = Number(body.position.x);
          const y = Number(body.position.y);
          if (Number.isFinite(x) && Number.isFinite(y)) ui.position = { x, y };
        }
        if (body.collapsed !== undefined) ui.collapsed = Boolean(body.collapsed);
        settings.ui = ui;
        writeSettings(file, settings);
        cache = null;
        return sendJson(res, 200, { ok: true, ui });
      },
    },
  ];

  for (const route of routes) {
    ctx.effect(
      () =>
        webServer.register({
          kind: "exact",
          path: route.path,
          handler: async (req, res) => {
            try {
              if (!allowRemote && !isLoopback(req) && !isSameOrigin(req)) {
                sendJson(res, 403, {
                  ok: false,
                  error: "forbidden: 只接受本机或同源浏览器请求（config.allowRemote 可放开）",
                });
                return;
              }
              await route.handler(ctx, req, res);
            } catch (error) {
              sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
            }
          },
        }),
      `dsh-billing-chip: ${basename(route.path)}`,
    );
  }

  // 启动时说一句，方便排查
  ctx.logger?.info?.("dsh-billing-chip: routes mounted at %s", API);
}
