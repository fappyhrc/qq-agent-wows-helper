/**
 * wows-helper · 运行时配置读取
 * ============================
 *
 * 本模块是"配置"这件事的唯一入口，承担两件事：
 *
 * 1. **每次现读，绝不快照**。
 *    用户在控制台随时可能改设置（例如把桥接地址换成别的端口）。若在 `setup` 阶段
 *    把值取出来存成普通变量，之后改了就不生效 —— 这是项目文档点名的经典坑。
 *    因此对外只暴露 `bindConfig(api.config)`，真正取值一律经 `cfg()`。
 * 2. **取值即规整**。
 *    `configSchema` 是"写入白名单"，不是类型保证：用户在设置页可以填出空串、
 *    负数、超大数字。这里统一做边界收敛，避免把 `NaN` 拼进 URL，
 *    或把 `0` 当成"无限超时"。
 *
 * 约定：`DEFAULTS` 必须与 `plugin.json` 的 `settings` 保持一致，
 * 保证"配置读不到"与"用户未改过"两种情况下行为相同。
 */

/**
 * 兜底默认值（与 `plugin.json` 的 `settings` 逐项对应）。
 *
 * 这里只在 `api.config()` 取不到值时使用；正常路径下核心已合并 manifest 的默认值。
 */
export const DEFAULTS = {
  // 触发词**必须与 plugin.json 的 settings.triggerKeywords 一致**（自检会交叉校验）。
  // yuyuko 是主触发词（用户要求）；wws 保留，因为上游自己的帮助页与官方机器人用的就是它，
  // 删掉会让老文案直接失效。触发词**后面的内容**原样交给 Hikari-core-v2。
  triggerKeywords: ['yuyuko', '@yuyuko', 'wws', '@wws'],
  // 严格的 AND 判定：**既要 @ 机器人，又要触发词在开头**。
  // 关掉它等价于"消息以触发词开头即认领"，群里聊到这些词时容易被抢话。
  // ⚠️ 注意"严格 @ 机器人"是用户明确要求的行为，别为了省事关掉。
  requireAt: true,
  bridgeUrl: 'http://127.0.0.1:8788',
  bridgeToken: '',
  // yuyuko API 凭据（账号ID:Token）。在设置页填写后随每次查询下发给桥接服务。
  // 默认留空由用户填 —— 这是"不敲命令行"的用户唯一走得通的路径。
  yuyukoToken: '',
  // 钩子内预取：默认**关闭**，这是实测后的决定而非保守取值。
  // 一次 wws 查询要经过 "yuyuko API + 浏览器端 Nunjucks 渲染 + 截图"，实测
  // （Python 3.14 / chromium / 热态）单次 5.2~13.1 秒；首次还需下载浏览器与
  // 船图缓存（约 150 秒）。钩子硬超时仅 5 秒，预取在普通机器上必然超时，
  // 只会让每次 @wws 白等几秒再退回工具。默认交给 wows-query 工具执行。
  hookPrefetch: false,
  hookPrefetchTimeoutMs: 3600,
  requestTimeoutMs: 60000,
  autoSendImage: true,
  includeDataInContext: true,
  contextDataMaxChars: 1600,
  atTriggerUser: false,
  replyToTrigger: false,
  platform: 'QQ',
  platformIdOverride: '',
  botId: '0',
  commandLanguage: 'zh',
  imageType: 'jpeg',
  gamePath: '',
  proxy: '',
  useBrowser: 'chromium',
  http2: true,
  autoRendering: true,
  autoImage: true,
  serveImage: true,
  imageServerHost: '127.0.0.1',
  imageServerPort: 32801,
  imageTtlSec: 600,
  maxImageMB: 12,
  maxPending: 6,
  debug: false
};

/** 配置读取器；由 `bindConfig` 注入，未绑定时返回空对象（此时全部走 DEFAULTS）。 */
let readConfig = () => ({});

/**
 * 绑定核心提供的配置读取函数（在 `setup(api)` 中调用一次）。
 *
 * @param {() => object} fn 通常就是 `api.config`。
 * @returns {void}
 *
 * @remarks 传入非函数时静默退化为空读，避免插件因为核心接口变化而直接抛错。
 */
export function bindConfig(fn) {
  readConfig = typeof fn === 'function' ? fn : () => ({});
}

/**
 * 读取原始配置对象（核心已合并 manifest 的 `settings` 默认值）。
 *
 * @returns {object} 配置对象；读取器抛错或返回非对象时返回 `{}`。
 */
export function raw() {
  try {
    const c = readConfig();
    return c && typeof c === 'object' ? c : {};
  } catch {
    return {};
  }
}

/**
 * 数值收敛：非有限数回落默认值，并按需夹到 `[min, max]`。
 * @param {*} v 原始值。
 * @param {number} fallback 兜底值。
 * @param {{min?: number, max?: number}} [range] 允许区间（省略则不限）。
 * @returns {number}
 */
function num(v, fallback, { min = null, max = null } = {}) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  if (min !== null && n < min) return min;
  if (max !== null && n > max) return max;
  return n;
}

/**
 * 布尔收敛：接受真正的布尔值，也接受设置页可能存下来的 `'true'/'1'/'0'` 等字符串。
 * @param {*} v 原始值。
 * @param {boolean} fallback 无法判定时的兜底值。
 * @returns {boolean}
 */
function bool(v, fallback) {
  if (typeof v === 'boolean') return v;
  if (v === 'true' || v === 1 || v === '1') return true;
  if (v === 'false' || v === 0 || v === '0') return false;
  return fallback;
}

/**
 * 字符串收敛：去空白，空串时回落默认值。
 * @param {*} v 原始值。
 * @param {string} [fallback]
 * @returns {string}
 */
function str(v, fallback = '') {
  const s = String(v ?? '').trim();
  return s || fallback;
}

/**
 * 触发词列表归一化。
 *
 * 同时兼容两种历史写法：数组（当前）与单字符串 `triggerKeyword`（早期版本）；
 * 统一去掉前缀 `@`、转小写、去重。全部为空时回落到 `DEFAULTS.triggerKeywords`，
 * 避免用户误清空导致插件彻底不响应。
 *
 * @param {object} c 原始配置。
 * @returns {string[]} 小写触发词列表。
 */
function keywords(c) {
  const list = [];
  const push = (x) => {
    const s = String(x ?? '').replace(/^@/, '').trim();
    if (s && !list.includes(s.toLowerCase())) list.push(s.toLowerCase());
  };
  if (Array.isArray(c.triggerKeywords)) c.triggerKeywords.forEach(push);
  else if (typeof c.triggerKeywords === 'string') c.triggerKeywords.split(/[\s,，]+/).forEach(push);
  if (!list.length) push(c.triggerKeyword);
  if (!list.length) DEFAULTS.triggerKeywords.forEach(push);
  return list;
}

/**
 * 归一化后的配置视图 —— **每次调用都现读一次**，因此用户改完设置，
 * 下一句消息就生效，无需重启插件或 QQ Agent。
 *
 * @returns {object} 已完成类型收敛与边界夹取的配置对象（字段见 `DEFAULTS`）。
 */
export function cfg() {
  const c = raw();
  return {
    triggerKeywords: keywords(c),
    requireAt: bool(c.requireAt, DEFAULTS.requireAt),
    bridgeUrl: str(c.bridgeUrl, DEFAULTS.bridgeUrl).replace(/\/+$/, ''),
    bridgeToken: str(c.bridgeToken, ''),
    yuyukoToken: str(c.yuyukoToken, ''),
    hookPrefetch: bool(c.hookPrefetch, DEFAULTS.hookPrefetch),
    // 钩子硬超时是 5s（核心 src/skills/manager.js 的 DEFAULT_HOOK_TIMEOUT_MS），
    // 预取（默认关闭）必须留足余量：超过 4.5s 会被判超时，整批结果作废、白花一次查询。
    hookPrefetchTimeoutMs: num(c.hookPrefetchTimeoutMs, DEFAULTS.hookPrefetchTimeoutMs, { min: 500, max: 4500 }),
    requestTimeoutMs: num(c.requestTimeoutMs, DEFAULTS.requestTimeoutMs, { min: 3000, max: 300000 }),
    autoSendImage: bool(c.autoSendImage, DEFAULTS.autoSendImage),
    includeDataInContext: bool(c.includeDataInContext, DEFAULTS.includeDataInContext),
    contextDataMaxChars: num(c.contextDataMaxChars, DEFAULTS.contextDataMaxChars, { min: 300, max: 8000 }),
    atTriggerUser: bool(c.atTriggerUser, DEFAULTS.atTriggerUser),
    replyToTrigger: bool(c.replyToTrigger, DEFAULTS.replyToTrigger),
    platform: str(c.platform, DEFAULTS.platform),
    platformIdOverride: str(c.platformIdOverride, ''),
    botId: str(c.botId, DEFAULTS.botId),
    commandLanguage: str(c.commandLanguage, DEFAULTS.commandLanguage) === 'en' ? 'en' : 'zh',
    imageType: ['jpeg', 'png', 'webp'].includes(str(c.imageType).toLowerCase())
      ? str(c.imageType).toLowerCase()
      : DEFAULTS.imageType,
    gamePath: str(c.gamePath, ''),
    proxy: str(c.proxy, ''),
    useBrowser: str(c.useBrowser, DEFAULTS.useBrowser) === 'firefox' ? 'firefox' : 'chromium',
    http2: bool(c.http2, DEFAULTS.http2),
    autoRendering: bool(c.autoRendering, DEFAULTS.autoRendering),
    autoImage: bool(c.autoImage, DEFAULTS.autoImage),
    serveImage: bool(c.serveImage, DEFAULTS.serveImage),
    imageServerHost: str(c.imageServerHost, DEFAULTS.imageServerHost),
    imageServerPort: num(c.imageServerPort, DEFAULTS.imageServerPort, { min: 1, max: 65535 }),
    imageTtlSec: num(c.imageTtlSec, DEFAULTS.imageTtlSec, { min: 30, max: 3600 }),
    maxImageMB: num(c.maxImageMB, DEFAULTS.maxImageMB, { min: 1, max: 64 }),
    maxPending: num(c.maxPending, DEFAULTS.maxPending, { min: 1, max: 50 }),
    debug: bool(c.debug, DEFAULTS.debug)
  };
}
