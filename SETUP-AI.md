# AI SETUP —— 帮人装这块计费牌

> 这份文件是给**跑在 DSH 里的 AI**看的：你读到它，说明有人让你把 `dsh-billing-chip` 装到一台机器上。
> 人看的说明在 [README.md](README.md)。这里只讲「怎么一步步做完」，命令都能直接复制。
>
> 原则：**先确定 DSH 在哪，再动 profile**。定位失败就停下来问人，不要猜端口硬装。

## 先判断你在哪

| 你的处境 | 怎么做 |
| --- | --- |
| 你就在跑 `dsh web` 的那台机器上（能读 `$DSH_HOME/sessions`） | 直接照下面做 |
| 你通过 SSH / 远程 shell 进那台机器 | 照下面做，命令前面加 `ssh user@host '…'` |
| 你连不上那台机器，只能看网页 | 只能走到步骤 2 确认地址，安装那步交给能碰机器的人 |
| 用户用的是 Windows | 步骤 1 的脚本能跑（需要 Node ≥ 18）；没有 `ss` 会退到 `netstat`，不用管 |

## 步骤 1 · 定位 DSH（三级探测，一条命令跑完）

```bash
cd /path/to/dsh-billing-chip
node scripts/find-dsh.mjs
```

它按这个顺序找，命中就停：

1. **环境变量** `DSH_WEB_URL` / `DSH_PUBLIC_URL` / `DSH_URL`（DSH 会话里通常已经有）
2. **本机监听端口**：用 `ss -lnt` / `/proc/net/tcp` / `netstat` 列出本机在听的端口，挑出 `3080, 3099, 3000, 8080, 8000` 优先探测，其余逐个试
3. **局域网扫描**：拿本机网段（跳过 docker / VPN 虚拟网卡）× 候选端口，并发探测
4. **手动**：前三级都没结果时打印指引；在终端里跑会直接问你「地址是什么？」

判据（两道，命中任意一条就算 DSH）：

- 未登录：HTTP `401` + 正文 `dsh web authentication required; …`
- 已登录：首页 HTML 里含 `__DSH_BOOT__`

成功输出长这样：

```
DSH_FOUND http://192.168.1.10:3080
  source:        本机端口 3080 (401 提示文案)
  authenticated: no（需要 DSH Web 打印的 token 链接打开）

下一步：用浏览器打开 http://192.168.1.10:3080 ，或者把下面这行给安装脚本：
DSH_URL=http://192.168.1.10:3080
```

失败输出：`DSH_NOT_FOUND 三级探测都没找到，需要手动确认。`

常用变体：

```bash
# 只看本机（快，跳过环境变量和局域网）
node scripts/find-dsh.mjs --local

# 只扫局域网（跳过本机端口，适合 DSH 在另一台机器上）
node scripts/find-dsh.mjs --lan

# 指定网段和端口（端口不是默认那几个时用这个）
node scripts/find-dsh.mjs --lan --range 192.168.1.0/24 --ports 3080,8080

# 已经知道地址，只验证它是不是 DSH
node scripts/find-dsh.mjs --url http://192.168.1.10:3080

# 机器可读（自己解析用）
node scripts/find-dsh.mjs --json

# 全程手动：直接问用户
node scripts/find-dsh.mjs --manual
```

线程/超时也能调：`--timeout 900 --concurrency 128`。

找不到时的标准提问（照抄给用户）：

```
我没在这台机器和它的局域网里找到 DSH Web，能告诉我它的地址吗？
形如 http://192.168.1.10:3080（就是你平时打开 DSH 的那个网址，去掉 ?token=… 后面的部分）
```

## 步骤 2 · 确认这个地址真的是 DSH（别跳过）

```bash
DSH_URL=http://192.168.1.10:3080
curl -s -o /dev/null -w '%{http_code}\n' "$DSH_URL/"
```

- `401` → 对，是 DSH，只是还没登录（正常，浏览器用带 token 的链接打开过就会有 cookie）
- `200` → 也正常（这台浏览器会话已经认证过，或 DSH 关掉了鉴权）
- `000` / `timeout` → 地址或端口不对，回步骤 1
- `404` / 别的服务 → 不是 DSH，回步骤 1

## 步骤 3 · 找到它的 DSH_HOME 和 profile

```bash
echo "$DSH_HOME"                       # 没值就是 ~/.dsh
ls "$DSH_HOME/sessions" | head -3      # 有 workspace 目录说明这台机器在跑 DSH
ls "$DSH_HOME/profiles"                # 通常有 web
cat "$DSH_HOME/profiles/web/package.json"
```

`ls "$DSH_HOME/sessions"` 是空的 → **装错机器了**，插件读不到日志，牌子会一直是「—」。

## 步骤 4 · 挂进 profile（先看 dry-run，再写）

```bash
# 4.1 先看它会改什么（只读，安全）
node scripts/enable-in-profile.mjs --profile web

# 4.2 确认无误后真的写：改 package.json + 跑 pnpm install
node scripts/enable-in-profile.mjs --profile web --write
```

它做三件事，等价于手工三步，但不会漏：

1. `dependencies["dsh-billing-chip"] = "link:<插件绝对路径>"`
2. `dsh.profile.bundles` 里加上 `dsh-billing-chip`（已有的不重复）
3. 在 profile 目录跑 `pnpm install --no-frozen-lockfile`

注意事项：

- 改之前会自动备份成 `package.json.bak.<时间戳>`
- 不想让它跑 pnpm：加 `--no-install`，自己进 `$DSH_HOME/profiles/web` 跑
- **profile 不是 web** 时用 `--profile <名字>`；不确定就问用户
- 装完必须**重启 `dsh web`**（先问用户，别擅自重启他正在用的服务）

想纯手工的话：

```bash
dsh plugin --profile web add link:/path/to/dsh-billing-chip
# 然后手动把 "dsh-billing-chip" 加进 $DSH_HOME/profiles/web/package.json 的 dsh.profile.bundles
cd "$DSH_HOME/profiles/web" && pnpm install --no-frozen-lockfile
```

## 步骤 5 · 重启后验证

```bash
curl -s "$DSH_URL/api/dsh-billing-chip/state" -H "Origin: $DSH_URL" | head -c 400
```

必须带 `Origin`（等于 `$DSH_URL`），否则插件会以「非本机、非同源」为由返回 `403` —— 那是它的保护，不是装坏了。

期望看到：

```json
{"ok":true,"model":"deepseek-flash","turn":{…},"today":{…},"peak":true,"hasKey":false,…}
```

`model` 是 `未知模型`、`today.cost` 是 `0` → 说明它能跑但读不到你关心的会话，检查步骤 3 的 `sessions` 目录。

## 步骤 6 · 让用户看到牌子

告诉用户：打开 `$DSH_URL`，**右下角**就是。没看到就让他刷新一次（client half 是随页面加载的）。

- 拖到喜欢的位置
- 双击折叠
- 右键 → 刷新余额 / 输入 API Key… / 折叠 / 重置位置 / 隐藏

## 步骤 7 · 填 API Key（可选，但余额要用）

两条路，选一条：

```bash
# 路 A：让用户在牌子上右键 →「输入 API Key…」自己填（推荐，Key 不进对话记录）
# 路 B：你在机器上直接写（注意别让 Key 出现在日志/终端历史里）
curl -s -X POST "$DSH_URL/api/dsh-billing-chip/key" \
  -H "Origin: $DSH_URL" -H 'content-type: application/json' \
  -d "{\"apiKey\":\"$(cat /path/to/keyfile)\"}"
```

Key 存在 `$DSH_HOME/dsh-billing-chip/settings.json`（权限 `0600`），接口只回显掩码。

## 排障对照

| 症状 | 原因 | 处理 |
| --- | --- | --- |
| `/state` 返回 404 | 插件没加载 | bundles 没写 / 没 `pnpm install` / 没重启 dsh web |
| `/state` 返回 403 | 缺 `Origin` 或来源不对 | 加 `-H "Origin: $DSH_URL"`；远程脚本要用就设 `allowRemote: true` |
| 牌子不出现，接口正常 | client half 没加载 | 浏览器 console 看有没有模块加载错误；刷新页面 |
| 模型显示「未知模型」 | 日志路径不对 | 确认 `DSH_HOME` 指向跑 web 的那个 |
| 今日一直是 ￥0 | `sessions` 目录是空的 | 装错机器了 |
| 余额一直是「…」或「未设置」 | 没填 Key / Key 无效 | 右键填一次，看返回的错误原文（会显示官方报错） |
| 局域网另一台机器打开时牌子报错 | 来源校验 | 用浏览器（有 Origin）访问就没事；脚本访问才要 `allowRemote` |
| 点保存弹出 `HTTP 404: <!doctype html>…` | 部署在子路径（如 nginx 把 3080 反代到 `/dsh/`），绝对路径 `/api/…` 落到反代的 catch-all | 0.1.x 起会自动按 `/assets/` 前缀推断 base，刷新页面即可；更早的版本需要在反代里补 `location ^~ /api/dsh-billing-chip/` |

## 一句话总结

```bash
node scripts/find-dsh.mjs && \
node scripts/enable-in-profile.mjs --profile web --write && \
echo "重启 dsh web，然后 curl \$DSH_URL/api/dsh-billing-chip/state -H \"Origin: \$DSH_URL\""
```
