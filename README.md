# dsh-billing-chip

挂在 DSH Web 界面右下角的一小块**纯文字计费牌**：当前模型、这一轮花了多少、今天累计多少、DeepSeek 账户还剩多少、现在是峰时还是谷时。右键可以直接填 API Key。

没有头像、没有插画、没有动画 —— 只有数字。窄到不挡事，一眼能看完。

![计费牌](docs/chip.png)

## 它算的是什么

DSH 每一轮对话都会把 `usage`（输入 / 缓存命中 / 缓存写入 / 输出 token）写进会话日志：

```
$DSH_HOME/sessions/<workspace>/<session-id>/session.v4.jsonl.zstd
```

这个插件**只读这些日志文件**，然后用 DeepSeek 官方价换算出钱：

| 项目 | 说明 |
| --- | --- |
| 本轮 | 当前会话最后一个 turn 的累计花费（每来一次 `assistant/message` 就涨一点，实时刷新） |
| 今日 | 今天所有会话加起来的花费与 token 数（跨 workspace、跨 session 汇总） |
| 余额 | 调 `GET https://api.deepseek.com/user/balance`，显示 CNY 可用余额 |
| 峰 / 谷 | 北京时间工作日 09:00–12:00、14:00–18:00 为高峰（价格翻倍）；周末与法定节假日全天按谷时价 |

它不订阅任何内部事件、不碰未公开 API，因此 DSH 升级后只要日志格式不变就还能用。

## 显示

```
deepseek-flash          峰
本轮 ¥1.2981
今日 ¥2.5729  余额 ¥34.19
```

- **拖动**：按住牌子拖到任意位置（位置记在 localStorage，同时回报给后端）
- **双击**：折叠成一行（只留模型和本轮金额）
- **右键**：菜单

![右键菜单](docs/menu.png)

右键菜单里：

- **刷新余额** —— 立刻重新拉一次（平时 60 秒自动刷新一次）
- **输入 API Key…** —— 弹出输入框，保存后马上验证并显示余额；留空保存等于清除
- **折叠 / 展开**
- **重置位置** —— 回到右下角
- **隐藏** —— 只是本地隐藏，刷新页面就回来

还没填 Key 的时候，直接**点一下牌子**也会弹出输入框。

## 安装

### 作为 bundle 装进 profile（推荐）

```bash
# 1. 把包 link 进 profile（dsh plugin 就是把参数转发给 pnpm）
dsh plugin --profile web add link:/path/to/dsh-billing-chip

# 2. 手动把名字加进 profile 的 dsh.profile.bundles —— 这一步 dsh plugin 不会替你做
#    然后 pnpm install / 重启 dsh web
```

profile 的 `package.json` 应该长这样：

```json
{
  "dependencies": {
    "dsh-billing-chip": "link:/path/to/dsh-billing-chip"
  },
  "dsh": {
    "profile": {
      "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-billing-chip"]
    }
  }
}
```

然后 `pnpm install`、重启 `dsh web`。插件自带 `cordis.patch.yml`，bundle 加载时会自动 insert。

### 装进已有 profile 的 patch

不想改 bundles 的话，把这条抄进 profile 的 `cordis.patch.yml`：

```yaml
- insert:
    - id: dsh-billing-chip
      name: 'dsh-billing-chip'
```

## 配置

在 `cordis.yml`（或 profile 的 patch）里给插件传 config，全部可选：

```yaml
- id: dsh-billing-chip
  name: 'dsh-billing-chip'
  config:
    apiKey: ''              # 也可以在这里给 Key（不推荐，会进版本库）
    defaultModel: deepseek-flash   # 日志里读不到模型时的兜底
    settingsPath: ''        # 默认 $DSH_HOME/dsh-billing-chip/settings.json
    allowRemote: false      # true 才允许任意来源（含非浏览器的远程脚本）访问它的 HTTP 路由
    priceOverrides:         # 官方调价时不用改代码
      deepseek-flash:
        hit: [0.02, 0.04]
        miss: [1, 2]
        out: [4, 8]
```

**API Key 的三种来源**（优先级从高到低）：

1. 右键菜单里填的 —— 存在 `$DSH_HOME/dsh-billing-chip/settings.json`，权限 `0600`
2. 插件 config 里的 `apiKey`
3. 环境变量 `DEEPSEEK_API_KEY`

填过之后牌子上会显示余额；鼠标悬停能看到 Key 来自哪一层。

## HTTP 接口（同源，给 client 用）

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| GET | `/api/dsh-billing-chip/state` | 模型、本轮、今日、余额、界面偏好 |
| POST | `/api/dsh-billing-chip/key` | `{ "apiKey": "sk-..." }` 保存并立即验证；空串等于清除 |
| POST | `/api/dsh-billing-chip/refresh` | 重新拉余额 |
| POST | `/api/dsh-billing-chip/ui` | `{ "position": {x,y}, "collapsed": bool }` 记界面偏好 |

`state` 返回示例：

```json
{
  "ok": true,
  "model": "deepseek-flash",
  "provider": "deepseek-official",
  "turn": { "index": 2, "cost": 0.7561, "peak": true, "done": false,
            "usage": { "inputTokens": 117045, "cacheReadTokens": 6781184,
                       "cacheWriteTokens": 0, "outputTokens": 31347,
                       "totalTokens": 6929576 } },
  "today": { "date": "2026-10-26", "cost": 2.03, "tokens": 25371513, "messages": 259 },
  "peak": true,
  "sessions": 5,
  "hasKey": true,
  "keyMasked": "sk-c4…d318",
  "keySource": "settings",
  "balance": { "currency": "CNY", "total": 34.19, "granted": 0, "toppedUp": 34.19, "available": true },
  "allowRemote": false,
  "ui": {}
}
```

## 隐私与安全

- **只读**：会话日志只读不写；除 `GET /user/balance`（带你的 Key）之外不向任何地方发请求，也没有埋点。
- **Key 只存在本机**：写进 `$DSH_HOME/dsh-billing-chip/settings.json`，`0600`；接口只回显掩码（`sk-c4…d318`），不返回明文。日志里不打印 Key。
- **默认只接受本机或同源请求**：`allowRemote: false` 时，只有回环地址（127.0.0.1 / ::1）或者 Origin 与 Host 一致的浏览器请求能通过。也就是说，你在局域网里用 `http://192.168.31.206:3080` 打开 DSH，牌子照常工作；但外部脚本直接 `curl` 这个接口会被 403 挡掉。远程运维要直连接口时才把它设成 `true`。
- 顺带一提：这个端口本身有没有登录保护取决于你的 DSH 部署 —— 插件只是不额外扩大暴露面。
- 界面完全由 client half 自绘，样式跟随 DSH 主题变量（`--dsw-alias-*`），亮色/暗色都自适应。

## 已知限制

- **只认 DeepSeek 官方价**。用别的 provider（openrouter、自建中转等）时，token 数是对的，钱数只是按 DeepSeek 价估算 —— 想准就自己配 `priceOverrides`。
- **是估算，不是账单**。DSH 记录的是模型返回的 usage，官方的实际扣费可能因为缓存判定、四舍五入有细微差别。
- 今日累计扫的是 `$DSH_HOME/sessions` 下所有 workspace 的日志，**子代理的会话也算在里面**（它们的 usage 同样落在日志里）。
- 节假日表写在 `src/index.js` 顶部，每年要补一次。
- 需要 Node ≥ 22.13（用到 `zlib.zstdDecompressSync`）。
- 目前只在 DeepSeek Harness 0.2 的 Web profile 上验证过。

## License

MIT
