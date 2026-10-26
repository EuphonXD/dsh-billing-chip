// dsh-billing-chip client half — 屏幕右下角的一小块计费牌。
//
// 只显示文字，没有头像、没有插画：模型名、本轮花费、今日累计、账户余额、峰谷。
// 右键（或长按）弹出菜单：刷新余额 / 输入 API Key… / 折叠 / 重置位置。
// 所有数据来自 host half 的 /api/dsh-billing-chip/* 路由，这里只负责画。
//
// 不依赖任何插槽（slot）与 React：直接往 body 里挂一个 fixed 容器，
// 所以它在任何 DSH Web 版本里都能出现，卸载时整个移除。
window.__ModuleLoader__.load({
	id: "dsh-billing-chip",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;

		const name = "dsh-billing-chip-client";
		const inject = [];
		// DSH 可能挂在子路径下（例如 nginx 把 3080 反代到 /dsh/），
		// 这时绝对路径 /api/… 会打到反代的 catch-all 上去，拿回一段 HTML 404。
		// 所以接口地址要相对"当前部署的根"来算：优先用前端自己加载 /assets/ 的前缀。
		function detectBase() {
			try {
				const boot = window.__DSH_BOOT__;
				const declared =
					(typeof boot?.basePath === "string" && boot.basePath) ||
					(typeof boot?.base === "string" && boot.base);
				if (declared) {
					const p = declared.startsWith("/") ? declared : `/${declared}`;
					return p.endsWith("/") ? p : `${p}/`;
				}
			} catch {
				/* boot 不存在就算了 */
			}
			try {
				const nodes = document.querySelectorAll('script[src], link[rel="stylesheet"][href]');
				for (const node of nodes) {
					const raw = node.getAttribute("src") || node.getAttribute("href") || "";
					if (!raw.includes("assets/")) continue;
					const url = new URL(raw, location.href);
					const m = url.pathname.match(/^(.*?)\/assets\//);
					if (m) return `${m[1]}/`;
				}
			} catch {
				/* 忽略 */
			}
			const path = location.pathname;
			if (path.endsWith("/")) return path;
			const last = path.slice(path.lastIndexOf("/") + 1);
			return last.includes(".") ? path.slice(0, path.lastIndexOf("/") + 1) : `${path}/`;
		}

		const BASE = detectBase();
		const API = `${BASE.replace(/\/$/, "")}/api/dsh-billing-chip`;
		const POLL_MS = 3000;
		const LS_POS = "dsh-billing-chip:pos";
		const LS_COLLAPSED = "dsh-billing-chip:collapsed";

		const CSS = `
/* 配色直接取自桌宠 #chip（yufeng-pet/renderer/styles.css）：
   深梦蓝渐变底 + 浅蓝模型名 + 暖黄主数字 + 奶油次要文字，
   本轮进行中＝粉、结算瞬间＝金闪、平时＝奶油。 */
.dbc-root {
  position: fixed;
  right: 16px;
  bottom: 16px;
  z-index: 2147483000;
  font: 12px/1.45 var(--dsw-font-family-code, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);
  font-variant-numeric: tabular-nums;
  color: #f6e7d3;
  user-select: none;
  -webkit-user-select: none;
}
.dbc-card {
  min-width: 158px;
  max-width: 264px;
  padding: 5px 10px 6px 9px;
  border-radius: 13px;
  background: linear-gradient(180deg, rgba(20, 31, 48, .92), rgba(11, 19, 34, .9));
  border: 1px solid rgba(127, 208, 255, .28);
  box-shadow: 0 4px 16px rgba(0, 0, 0, .35), inset 0 1px 0 rgba(255, 255, 255, .06);
  backdrop-filter: blur(6px);
  color: #f6e7d3;
  cursor: grab;
  transition: border-color .2s, transform .15s;
}
.dbc-card:hover { border-color: rgba(127, 208, 255, .6); }
.dbc-card:active { cursor: grabbing; }
.dbc-row { display: flex; align-items: center; gap: 6px; white-space: nowrap; }
.dbc-model {
  overflow: hidden;
  text-overflow: ellipsis;
  color: #bfeaff;
  font-size: 10.5px;
}
.dbc-badge {
  margin-left: auto;
  padding: 0 4px;
  border-radius: 4px;
  font-size: 9px;
  line-height: 14px;
  color: #6fd3a8;
  border: 1px solid rgba(111, 211, 168, .45);
}
.dbc-badge[data-peak="1"] {
  color: #e8a33d;
  border-color: rgba(232, 163, 61, .5);
}
.dbc-main {
  margin-top: 1px;
  font-size: 13px;
  font-weight: 700;
  letter-spacing: .2px;
  color: #ffe1a8;
  transition: color .2s;
}
.dbc-main .dbc-cur {
  font-size: 9.5px;
  font-weight: 400;
  color: rgba(246, 231, 211, .62);
  margin-right: 4px;
  letter-spacing: 0;
}
/* 桌宠：还在涨（估算）→ 粉 */
.dbc-main[data-state="estimated"] {
  color: #ffb3d1;
  font-weight: 600;
  text-shadow: 0 0 8px rgba(255, 150, 200, .5);
}
/* 桌宠：刚结算 → 金闪 */
.dbc-main[data-state="spent"] {
  color: #ffd873;
  font-weight: 700;
  text-shadow: 0 0 10px rgba(255, 190, 80, .65);
  animation: dbcTurnGlow 1.6s ease-in-out infinite;
}
@keyframes dbcTurnGlow { 0%, 100% { opacity: 1 } 50% { opacity: .7 } }
.dbc-main[data-state="idle"] { color: rgba(246, 231, 211, .45); font-weight: 400; }
.dbc-sub {
  margin-top: 1px;
  display: flex;
  gap: 8px;
  font-size: 9.5px;
  color: rgba(246, 231, 211, .62);
}
.dbc-sub span { white-space: nowrap; }
.dbc-balance { color: rgba(246, 231, 211, .62); }
.dbc-balance[data-ok="1"] { color: #ffe1a8; font-weight: 600; }
.dbc-err { color: #ff9d94; font-size: 10.5px; margin-top: 2px; }
.dbc-menu {
  position: fixed;
  z-index: 2147483001;
  min-width: 158px;
  padding: 4px;
  border-radius: 13px;
  background: rgba(11, 19, 34, .96);
  border: 1px solid rgba(127, 208, 255, .3);
  box-shadow: 0 10px 30px rgba(0, 0, 0, .45);
  color: #f6e7d3;
  font: 12px/1.5 system-ui, -apple-system, "Segoe UI", "PingFang SC", sans-serif;
}
.dbc-item {
  padding: 5px 9px;
  border-radius: 7px;
  cursor: pointer;
  white-space: nowrap;
  color: #f6e7d3;
}
.dbc-item:hover { background: rgba(127, 208, 255, .12); }
.dbc-sep { height: 1px; margin: 4px 6px; background: rgba(127, 208, 255, .18); }
.dbc-overlay {
  position: fixed;
  inset: 0;
  z-index: 2147483002;
  background: rgba(3, 8, 16, .55);
}
.dbc-dialog {
  position: fixed;
  z-index: 2147483003;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  width: 340px;
  padding: 15px 16px 13px;
  border-radius: 13px;
  background: rgba(11, 19, 34, .97);
  border: 1px solid rgba(127, 208, 255, .3);
  box-shadow: 0 20px 48px rgba(0, 0, 0, .5);
  color: #f6e7d3;
  font: 13px/1.6 system-ui, -apple-system, "Segoe UI", "PingFang SC", sans-serif;
}
.dbc-dialog h4 { margin: 0 0 6px; font-size: 13px; font-weight: 600; color: #bfeaff; }
.dbc-dialog p { margin: 0 0 10px; font-size: 11.5px; color: rgba(246, 231, 211, .6); }
.dbc-input {
  width: 100%;
  box-sizing: border-box;
  padding: 6px 8px;
  border-radius: 7px;
  border: 1px solid rgba(127, 208, 255, .3);
  background: rgba(12, 22, 34, .6);
  color: #f6e7d3;
  font: 12px/1.4 var(--dsw-font-family-code, ui-monospace, Menlo, Consolas, monospace);
  outline: none;
}
.dbc-input:focus { border-color: rgba(127, 208, 255, .65); }
.dbc-actions { margin-top: 12px; display: flex; gap: 8px; justify-content: flex-end; }
.dbc-btn {
  padding: 4px 12px;
  border-radius: 7px;
  border: 1px solid rgba(127, 208, 255, .25);
  background: transparent;
  color: rgba(246, 231, 211, .85);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}
.dbc-btn:hover { background: rgba(127, 208, 255, .12); color: #f6e7d3; }
.dbc-btn[data-primary="1"] {
  border-color: rgba(127, 208, 255, .45);
  background: rgba(127, 208, 255, .16);
  color: #bfeaff;
}
.dbc-btn[data-primary="1"]:hover { background: rgba(127, 208, 255, .24); }
.dbc-btn[data-primary="1"]:disabled { opacity: .5; cursor: default; }
.dbc-msg { margin-top: 8px; font-size: 11px; min-height: 14px; color: rgba(246, 231, 211, .55); }
.dbc-msg[data-kind="err"] { color: #ff9d94; }
.dbc-msg[data-kind="ok"] { color: #6fd3a8; }
`;

		// ---------------------------------------------------------------------
		// 小工具
		// ---------------------------------------------------------------------

		function el(tag, cls, text) {
			const node = document.createElement(tag);
			if (cls) node.className = cls;
			if (text !== undefined) node.textContent = text;
			return node;
		}

		function fmtMoney(v, digits) {
			const n = Number(v);
			if (!Number.isFinite(n)) return "—";
			if (n === 0) return (0).toFixed(digits);
			if (n < 0.0001 && digits < 4) return "<0.0001";
			return n.toFixed(digits);
		}

		function fmtTokens(v) {
			const n = Number(v) || 0;
			if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
			if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
			return String(n);
		}

		function fmtBalance(b) {
			if (!b) return null;
			const sym = String(b.currency || "CNY").toUpperCase() === "CNY" ? "¥" : "";
			return `${sym}${fmtMoney(b.total, 2)}`;
		}

		// 与桌宠牌子完全一致的金额刻度：>=1 两位、>=0.01 三位、更小四位
		function money4(v) {
			const n = Number(v);
			if (!Number.isFinite(n)) return "--";
			if (n >= 1) return n.toFixed(2);
			if (n >= 0.01) return n.toFixed(3);
			return n.toFixed(4);
		}

		function money2(v) {
			const n = Number(v);
			return Number.isFinite(n) ? n.toFixed(2) : "--";
		}

		async function api(path, body) {
			const init = body === undefined
				? { method: "GET", credentials: "same-origin" }
				: {
					method: "POST",
					credentials: "same-origin",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(body),
				};
			const res = await fetch(`${API}${path}`, init);
			const text = await res.text();
			let data;
			try {
				data = JSON.parse(text);
			} catch {
				const looksHtml = /^\s*<(!doctype|html)/i.test(text);
				if (looksHtml) {
					throw new Error(
						`接口没走到插件（HTTP ${res.status}，返回了网页）：当前部署在子路径下时，` +
							`反代需要把 ${API} 一并转发给 dsh。`,
					);
				}
				throw new Error(`HTTP ${res.status}: ${text.slice(0, 120)}`);
			}
			if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
			return data;
		}

		// ---------------------------------------------------------------------
		// 界面
		// ---------------------------------------------------------------------

		function mount(ctx) {
			const style = el("style");
			style.dataset.dbcCss = "1";
			style.textContent = CSS;
			document.head.appendChild(style);

			const root = el("div", "dbc-root");
			const card = el("div", "dbc-card");
			card.title = "右键打开菜单";
			root.appendChild(card);

			const rowTop = el("div", "dbc-row");
			const modelEl = el("span", "dbc-model", "…");
			const badgeEl = el("span", "dbc-badge", "—");
			rowTop.append(modelEl, badgeEl);

			const mainEl = el("div", "dbc-main");
			const curEl = el("span", "dbc-cur", "本轮");
			const turnEl = el("span", "", "—");
			mainEl.append(curEl, turnEl);

			const subEl = el("div", "dbc-sub");
			const todayEl = el("span", "", "今日 —");
			const balanceEl = el("span", "dbc-balance", "余额 —");
			subEl.append(todayEl, balanceEl);

			const errEl = el("div", "dbc-err");
			errEl.style.display = "none";

			card.append(rowTop, mainEl, subEl, errEl);

			let collapsed = false;
			try {
				collapsed = localStorage.getItem(LS_COLLAPSED) === "1";
			} catch {
				/* ignore */
			}
			try {
				const raw = localStorage.getItem(LS_POS);
				if (raw) {
					const pos = JSON.parse(raw);
					if (Number.isFinite(pos?.x) && Number.isFinite(pos?.y)) {
						root.style.right = "auto";
						root.style.bottom = "auto";
						root.style.left = `${pos.x}px`;
						root.style.top = `${pos.y}px`;
					}
				}
			} catch {
				/* ignore */
			}

			document.body.appendChild(root);

			function applyCollapsed(next) {
				collapsed = next;
				try {
					localStorage.setItem(LS_COLLAPSED, next ? "1" : "0");
				} catch {
					/* ignore */
				}
				mainEl.style.display = next ? "none" : "";
				subEl.style.display = next ? "none" : "";
				errEl.style.display = next ? "none" : errEl.dataset.show === "1" ? "" : "none";
			}
			applyCollapsed(collapsed);

			// ---- 状态渲染 ----
			let last = null;
			let lastError = null;
			let lastTurnDone = null;
			let spentUntil = 0;
			let flashTimer = null;
			let timer = null;
			let inFlight = false;

			function render(state) {
				last = state;
				modelEl.textContent = state.model || "未知模型";
				const peak = Boolean(state.peak);
				badgeEl.textContent = peak ? "峰" : "谷";
				badgeEl.dataset.peak = peak ? "1" : "0";
				badgeEl.title = peak ? "高峰时段：价格翻倍" : "谷时价";

				const turn = state.turn || {};
				const usage = turn.usage || {};
				const turnCost = Number(turn.cost);
				const hasTurn = Number.isFinite(turnCost) && Number(usage.totalTokens) > 0;
				const done = turn.done === true;

				// 流式预估（host 订阅 assistant 流算出来的，不受日志落盘延迟影响）
				const live = state.live || null;
				const liveActive = Boolean(live && live.active === true);
				const liveEst =
					live && live.hasEst !== false && Number.isFinite(live.estCost) && live.estCost > 0.0001
						? live.estCost
						: null;
				const liveActual = live && Number.isFinite(live.actualCost) ? live.actualCost : null;

				if (hasTurn && done && lastTurnDone === false) {
					spentUntil = Date.now() + 2400;
					clearTimeout(flashTimer);
					flashTimer = setTimeout(() => render(last), 2450);
				}
				lastTurnDone = done;
				const flashing = spentUntil > Date.now();

				// 桌宠口径：跑着 = 粉色 ≈（估算中）；刚结算 = 金色闪一下；稳住 = 奶油
				// 另外：跑着优先用流式预估，结算后把"实际 · 预估"并排显示
				let mainState = "idle";
				let text = "本轮 --";
				if (liveActive && liveEst !== null) {
					text = "≈ ¥" + money4(liveEst);
					mainState = "estimated";
				} else if (done) {
					const actual = liveActual !== null ? liveActual : turnCost;
					text = Number.isFinite(actual) ? "¥" + money4(actual) : "本轮 --";
					// 预估和实际差不到 3% 就不啰嗦了，只显示实际
					if (liveEst !== null && Number.isFinite(actual) && Math.abs(liveEst - actual) / Math.max(actual, 1e-6) >= 0.03) {
						text += " · ≈¥" + money2(liveEst);
					}
					mainState = flashing ? "spent" : "";
				} else if (hasTurn) {
					text = "≈ ¥" + money4(turnCost);
					mainState = "estimated";
				} else if (liveEst !== null && liveEst > 0) {
					text = "≈ ¥" + money4(liveEst);
					mainState = "estimated";
				}
				turnEl.textContent = text;
				mainEl.dataset.state = mainState;

				const tips = [];
				if (hasTurn) tips.push(`本轮 #${turn.index} · ${fmtTokens(usage.totalTokens)} tokens`);
				if (live && Number.isFinite(live.turn)) {
					tips.push(`流式 #${live.turn}${live.active ? " 进行中" : " 已停"}`);
				}
				if (liveEst !== null) {
					tips.push(`预估 ≈¥${money4(liveEst)}（${live.chars} 字符 ≈ 输出 ${fmtTokens(live.estOut)} tokens）`);
				}
				if (liveActual !== null) tips.push(`实际 ¥${money4(liveActual)}`);
				if (hasTurn) {
					tips.push(`输入 ${fmtTokens(usage.inputTokens)} / 缓存 ${fmtTokens(usage.cacheReadTokens)} / 输出 ${fmtTokens(usage.outputTokens)}`);
				}
				mainEl.title = tips.length ? tips.join(" · ") : "本轮还没有用量";

				todayEl.textContent = `今日 ¥${money2(state.today?.cost)}`;
				todayEl.title = `今日 ${fmtTokens(state.today?.tokens)} tokens / ${state.today?.messages ?? 0} 次响应`;

				const bal = fmtBalance(state.balance);
				if (bal) {
					balanceEl.dataset.ok = "1";
					balanceEl.textContent = `余额 ${bal}`;
					balanceEl.title =
						state.balance?.available === false
							? "余额接口报告不可用"
							: state.keySource === "env"
								? "Key 来自环境变量 DEEPSEEK_API_KEY"
								: state.keySource === "config"
									? "Key 来自插件配置"
									: "Key 来自本机设置文件";
				} else if (state.hasKey && state.balanceError) {
					balanceEl.dataset.ok = "0";
					balanceEl.textContent = "余额 —";
					balanceEl.title = state.balanceError;
				} else if (!state.hasKey) {
					balanceEl.dataset.ok = "0";
					balanceEl.textContent = "余额 未设置";
					balanceEl.title = "右键 → 输入 API Key 后显示余额";
				} else {
					balanceEl.dataset.ok = "0";
					balanceEl.textContent = "余额 …";
				}

				if (lastError) {
					errEl.textContent = lastError;
					errEl.dataset.show = "1";
					if (!collapsed) errEl.style.display = "";
				} else {
					errEl.dataset.show = "0";
					errEl.style.display = "none";
				}
			}

			async function tick() {
				if (inFlight || document.visibilityState === "hidden") return;
				inFlight = true;
				try {
					const state = await api("/state");
					lastError = null;
					render(state);
				} catch (error) {
					lastError = `连接不上：${error instanceof Error ? error.message : String(error)}`;
					errEl.textContent = lastError;
					errEl.dataset.show = "1";
					if (!collapsed) errEl.style.display = "";
				} finally {
					inFlight = false;
				}
			}

			function schedule() {
				if (timer) clearInterval(timer);
				timer = setInterval(tick, POLL_MS);
			}

			// ---- 右键菜单 ----
			let menu = null;

			function closeMenu() {
				if (menu) {
					menu.remove();
					menu = null;
				}
			}

			function openMenu(x, y) {
				closeMenu();
				menu = el("div", "dbc-menu");

				const items = [
					{
						label: "刷新余额",
						run: async () => {
							closeMenu();
							try {
								const r = await api("/refresh", {});
								if (r?.ok === false) lastError = r.error || "刷新失败";
								else lastError = null;
								await tick();
							} catch (error) {
								lastError = `刷新失败：${error.message}`;
								render(last || {});
							}
						},
					},
					{
						label: last?.hasKey ? `输入 API Key…（当前 ${last.keyMasked}）` : "输入 API Key…",
						run: () => {
							closeMenu();
							openKeyDialog();
						},
					},
					{ sep: true },
					{
						label: collapsed ? "展开" : "折叠",
						run: () => {
							closeMenu();
							applyCollapsed(!collapsed);
						},
					},
					{
						label: "重置位置",
						run: () => {
							closeMenu();
							root.style.left = "";
							root.style.top = "";
							root.style.right = "16px";
							root.style.bottom = "16px";
							try {
								localStorage.removeItem(LS_POS);
							} catch {
								/* ignore */
							}
						},
					},
					{ sep: true },
					{
						label: "隐藏（刷新页面恢复）",
						run: () => {
							closeMenu();
							root.style.display = "none";
							timer && clearInterval(timer);
						},
					},
				];

				for (const item of items) {
					if (item.sep) {
						menu.appendChild(el("div", "dbc-sep"));
						continue;
					}
					const node = el("div", "dbc-item", item.label);
					node.addEventListener("click", (event) => {
						event.stopPropagation();
						try {
							item.run();
						} catch (error) {
							console.warn("[dsh-billing-chip]", error);
						}
					});
					menu.appendChild(node);
				}

				menu.style.left = "0px";
				menu.style.top = "0px";
				document.body.appendChild(menu);
				const rect = menu.getBoundingClientRect();
				const vw = window.innerWidth;
				const vh = window.innerHeight;
				// 优先往上弹（计费牌本身贴底，往下会出屏）
				const left = Math.max(8, Math.min(x, vw - rect.width - 8));
				let top = y - rect.height - 6;
				if (top < 8) top = Math.max(8, Math.min(y + 6, vh - rect.height - 8));
				menu.style.left = `${left}px`;
				menu.style.top = `${top}px`;
			}

			// ---- API Key 对话框 ----
			let dialog = null;
			let overlay = null;

			function closeDialog() {
				if (dialog) {
					dialog.remove();
					dialog = null;
				}
				if (overlay) {
					overlay.remove();
					overlay = null;
				}
			}

			function openKeyDialog() {
				closeDialog();
				dialog = el("div", "dbc-dialog");
				const h = el("h4", "", "DeepSeek API Key");
				const p = el("p", "", "只存在本机 $DSH_HOME/dsh-billing-chip/settings.json（权限 600），用于查询账户余额；不会写进日志或会话。");
				const input = el("input", "dbc-input");
				input.type = "password";
				input.placeholder = "sk-…";
				input.autocomplete = "off";
				input.spellcheck = false;
				const msg = el("div", "dbc-msg");
				const actions = el("div", "dbc-actions");
				const cancel = el("button", "dbc-btn", "取消");
				const save = el("button", "dbc-btn", "保存并刷新");
				save.dataset.primary = "1";
				actions.append(cancel, save);
				dialog.append(h, p, input, msg, actions);
				overlay = el("div", "dbc-overlay");
				overlay.addEventListener("mousedown", closeDialog);
				document.body.append(overlay, dialog);
				input.focus();

				async function submit() {
					const key = input.value.trim();
					save.disabled = true;
					cancel.disabled = true;
					msg.dataset.kind = "";
					msg.textContent = key ? "保存中…" : "清除中…";
					try {
						const r = await api("/key", { apiKey: key });
						if (!key) {
							msg.dataset.kind = "ok";
							msg.textContent = "已清除 API Key";
							setTimeout(closeDialog, 500);
							await tick();
							return;
						}
						if (r?.balance?.ok) {
							msg.dataset.kind = "ok";
							msg.textContent = `已保存 · 余额 ${fmtBalance(r.balance)}`;
							setTimeout(closeDialog, 700);
						} else {
							msg.dataset.kind = "err";
							msg.textContent = `已保存，但余额查询失败：${r?.balance?.error || "未知原因"}`;
						}
						await tick();
					} catch (error) {
						msg.dataset.kind = "err";
						msg.textContent = `保存失败：${error.message}`;
					} finally {
						save.disabled = false;
						cancel.disabled = false;
					}
				}

				save.addEventListener("click", submit);
				cancel.addEventListener("click", closeDialog);
				input.addEventListener("keydown", (event) => {
					if (event.key === "Enter") submit();
					if (event.key === "Escape") closeDialog();
				});
			}

			// ---- 交互 ----
			card.addEventListener("contextmenu", (event) => {
				event.preventDefault();
				event.stopPropagation();
				openMenu(event.clientX, event.clientY);
			});

			card.addEventListener("dblclick", (event) => {
				event.preventDefault();
				applyCollapsed(!collapsed);
			});

			// 还没有 Key 的时候，点一下牌子就直接要 Key，省得去翻右键菜单
			card.addEventListener("click", (event) => {
				if (event.detail !== 1) return;
				if (last && last.hasKey) return;
				if (drag && drag.moved) return;
				openKeyDialog();
			});

			// 拖动（超过 3px 才算拖，避免和双击/右键打架）
			let drag = null;
			card.addEventListener("pointerdown", (event) => {
				if (event.button !== 0) return;
				const rect = root.getBoundingClientRect();
				drag = { startX: event.clientX, startY: event.clientY, left: rect.left, top: rect.top, moved: false };
				card.setPointerCapture?.(event.pointerId);
			});
			card.addEventListener("pointermove", (event) => {
				if (!drag) return;
				const dx = event.clientX - drag.startX;
				const dy = event.clientY - drag.startY;
				if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 3) return;
				drag.moved = true;
				const x = Math.max(0, Math.min(window.innerWidth - 60, drag.left + dx));
				const y = Math.max(0, Math.min(window.innerHeight - 30, drag.top + dy));
				root.style.right = "auto";
				root.style.bottom = "auto";
				root.style.left = `${x}px`;
				root.style.top = `${y}px`;
			});
			card.addEventListener("pointerup", (event) => {
				if (!drag) return;
				const moved = drag.moved;
				drag = null;
				if (!moved) return;
				try {
					const rect = root.getBoundingClientRect();
					localStorage.setItem(LS_POS, JSON.stringify({ x: rect.left, y: rect.top }));
					api("/ui", { position: { x: Math.round(rect.left), y: Math.round(rect.top) } }).catch(() => {});
				} catch {
					/* ignore */
				}
			});

			const onDocClick = () => closeMenu();
			document.addEventListener("click", onDocClick);
			document.addEventListener("contextmenu", onDocClick);

			const onKey = (event) => {
				if (event.key === "Escape") {
					closeMenu();
					closeDialog();
				}
			};
			document.addEventListener("keydown", onKey);

			const onVisibility = () => {
				if (document.visibilityState === "visible") tick();
			};
			document.addEventListener("visibilitychange", onVisibility);

			tick();
			schedule();

			return () => {
				if (timer) clearInterval(timer);
				document.removeEventListener("click", onDocClick);
				document.removeEventListener("contextmenu", onDocClick);
				document.removeEventListener("keydown", onKey);
				document.removeEventListener("visibilitychange", onVisibility);
				closeMenu();
				closeDialog();
				root.remove();
				style.remove();
			};
		}

		function apply(ctx) {
			// 同一页面只挂一份（HMR 重载时先清掉旧的）
			for (const stale of Array.from(document.querySelectorAll(".dbc-root"))) stale.remove();
			for (const stale of Array.from(document.querySelectorAll("style[data-dbc-css]"))) stale.remove();
			const dispose = mount(ctx);
			if (ctx && typeof ctx.effect === "function") {
				return ctx.effect(() => dispose, "dsh-billing-chip: overlay");
			}
			return dispose;
		}

		exports.name = name;
		exports.inject = inject;
		exports.apply = apply;
		return module.exports;
	},
});
