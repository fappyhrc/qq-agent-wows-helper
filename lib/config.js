// wows-helper · 运行时配置读取
//
// 设计要点：**不在 setup 时快照配置**。
// 用户随时可能在控制台改设置（比如把桥接地址从 8788 改成别的端口），
// 一旦在加载时把值存成普通变量，改了就不生效 —— 这是本项目文档里点名的经典坑。
// 所以这里只导出 `bindConfig(api.config)`，之后每次用都现读。
//
// 同时把"取出来的值"做一次规整：configSchema 是写入白名单，不是类型保险，
// 用户在设置页可以填出空串、负数、超大数字。读的时候统一兜底，
// 免得后面把 NaN 拼进 URL 或者把 0 当成"无限超时"。

/** 与 plugin.json 的 settings 保持一致：这里是"配置读不到时"的最后一道默认值。 */
export const DEFAULTS = {
  triggerKeywords: ['wws', '@wws'],
  // 与官方 wws 机器人一致的判定：**既要 @ 机器人，又要 wws**。
  // 关掉它 = 只要求消息以 wws 开头（老行为），群里聊到 wws 就容易被抢话。
  requireAt: true,
  bridgeUrl: 'http://127.0.0.1:8788',
  bridgeToken: '',
  // yuyuko API 凭据（账号ID:Token）。在 QQ Agent 设置页填，随查询下发给桥接服务。
  // 默认留空：由用户在界面上自己填 —— 这是"不会敲命令行"的用户唯一走得通的路。
  yuyukoToken: '',
  // 钩子内预取：默认**关闭**，这是实测后的决定，不是保守。
  // 一次 wws 查询要经过 "yuyuko API + 浏览器端 Nunjucks 渲染 + 截图"，
  // 实测（Python 3.14 / chromium / 热态）单次 5.2~13.1 秒，首次运行还要多出
  // 浏览器与船图缓存的下载（约 150 秒）。钩子硬超时是 5 秒，所以预取在普通机器上
  // **必然超时**，只会让每次 @wws 白等几秒再退回工具。默认交给 wows-query 工具。
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

let readConfig = () => ({});

/** 由 index.js 在 setup(api) 里绑定 api.config。 */
export function bindConfig(fn) {
  readConfig = typeof fn === 'function' ? fn : () => ({});
}

/** 原始配置（已合并 settings 默认值）。 */
export function raw() {
  try {
    const c = readConfig();
    return c && typeof c === 'object' ? c : {};
  } catch {
    return {};
  }
}

function num(v, fallback, { min = null, max = null } = {}) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  if (min !== null && n < min) return min;
  if (max !== null && n > max) return max;
  return n;
}

function bool(v, fallback) {
  if (typeof v === 'boolean') return v;
  if (v === 'true' || v === 1 || v === '1') return true;
  if (v === 'false' || v === 0 || v === '0') return false;
  return fallback;
}

function str(v, fallback = '') {
  const s = String(v ?? '').trim();
  return s || fallback;
}

/** 触发词：兼容旧的 `triggerKeyword` 单字符串写法 + 新的数组写法，去重、去空。 */
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
 * 归一化后的配置视图。每次调用都现读一次 —— 用户改完设置下一句消息就生效。
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
