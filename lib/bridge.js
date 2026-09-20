/**
 * wows-helper · 桥接服务 HTTP 客户端
 * ==================================
 *
 * 本模块是 Node 侧唯一与 Python 桥接服务通信的地方，负责四件事：
 * 拼装请求、**真超时**、错误分类、把技术性错误翻译成用户能照做的提示。
 *
 * 超时策略（重要）
 * ----------------
 * 所有请求都经 `AbortController` 而非仅靠 `Promise.race` 计时。
 * 原因：`Promise.race` 只是"不再等这个结果"，被放弃的 HTTP 请求仍会继续占着连接，
 * 桥接侧也仍在渲染 —— 群里连发几条指令就会堆出一串僵尸查询，把浏览器实例拖死。
 * `abort()` 会真正掐断请求。
 *
 * 错误分类
 * --------
 * `BridgeError.kind` 取值：`timeout`（超时）、`offline`（连不上）、`http`（非 2xx）、
 * `bad-json`（响应不是 JSON）。分类的目的是让上层给出可操作的提示，
 * 而不是把 `fetch failed` 原样丢给用户。
 */

/**
 * 桥接调用失败时抛出的错误。
 *
 * @property {string} kind `timeout` | `offline` | `http` | `bad-json` | `error`
 * @property {number} status HTTP 状态码（仅 `http` 类有意义）
 * @property {string} body 原始响应体片段（仅 `http` 类，用于排查）
 */
export class BridgeError extends Error {
  constructor(message, { kind = 'error', status = 0, body = '' } = {}) {
    super(message);
    this.name = 'BridgeError';
    this.kind = kind;
    this.status = status;
    this.body = body;
  }
}

/**
 * 把桥接连通性错误翻译成给群友看的一句话。
 *
 * @param {unknown} error 任意错误对象。
 * @returns {string} 中文提示（不可达属部署问题，因此提示指向"检查桥接服务"）。
 */
export function friendlyBridgeError(error) {
  if (error instanceof BridgeError) {
    if (error.kind === 'timeout') return '战舰世界数据服务响应超时了，稍后再试一次。';
    if (error.kind === 'offline') return '战舰世界数据服务没启动或地址不对（请检查 wows-helper 的桥接服务）。';
    return `战舰世界数据服务返回了异常：${error.message}`;
  }
  return `战舰世界数据服务调用失败：${error?.message ?? error}`;
}

/**
 * 判断桥接响应是否表示"没有配置 yuyuko 凭据"。
 *
 * @param {object|string} data 桥接响应体，或错误文本。
 * @returns {boolean}
 *
 * @remarks 匹配串刻意收得很窄：`TOKEN_MISSING_TEXT` 自身也含"yuyuko API 凭据"字样，
 * 泛化匹配会把**正常结果**误判为"缺凭据"。
 */
export function isTokenMissing(data) {
  const t = typeof data === 'string' ? data : `${data?.text ?? ''}${data?.hint ?? ''}${data?.message ?? ''}`;
  return /没有配置 yuyuko API 凭据/.test(t);
}

/** 凭据缺失时统一使用的提示文案（指向设置页的具体位置）。 */
export const TOKEN_MISSING_TEXT = '还没有配置战舰世界的 yuyuko API 凭据：请在 QQ Agent 的「插件 → 战舰世界助手」设置里填「yuyuko API 凭据」（格式：账号ID:Token）。填好后无需重启，下一句指令即可生效。';

/**
 * 调桥接服务的 /query。
 *
 * @param {object} params
 * @param {string} params.url       桥接根地址，如 http://127.0.0.1:8788
 * @param {string} [params.token]   本服务的访问口令（对应 --access-token），与下面的 yuyuko 凭据无关
 * @param {string} params.command   wws 指令正文（不带 wws 前缀）
 * @param {string} params.platform  'QQ' | 'QQ_CHANNEL' | 'QQ_OFFICIAL'
 * @param {string} params.platformId 触发者 ID（Hikari 的 PlatformId）
 * @param {string} params.botId
 * @param {string} [params.groupId]
 * @param {number} [params.selectIndex] 有挂起的多选会话时，用户回的序号
 * @param {string} [params.sessionKey]  多选会话键（群号:用户号）
 * @param {object} params.runtime   桥接侧的 Hikari 配置覆盖（imageType/gamePath/proxy/yuyukoToken…）
 * @param {number} params.timeoutMs
 * @returns {Promise<object>} 桥接服务原样返回的 JSON
 */
export async function bridgeQuery(params) {
  const {
    url, token = '', command, platform, platformId, botId = '0', groupId = null,
    selectIndex = null, sessionKey = null, runtime = {}, timeoutMs = 60000
  } = params;

  const endpoint = `${String(url).replace(/\/+$/, '')}/query`;
  const payload = {
    command: String(command ?? ''),
    platform: String(platform || 'QQ'),
    platform_id: String(platformId || ''),
    bot_id: String(botId || '0'),
    group_id: groupId == null ? null : String(groupId),
    select_index: selectIndex == null ? null : Number(selectIndex),
    session_key: sessionKey == null ? null : String(sessionKey),
    // want_image/auto_image 交给桥接侧按 runtime 决定：Node 侧只表达"想要什么"
    config: {
      image_type: runtime.imageType || 'jpeg',
      use_browser: runtime.useBrowser || 'chromium',
      http2: runtime.http2 !== false,
      auto_rendering: runtime.autoRendering !== false,
      auto_image: runtime.autoImage !== false,
      command_language: runtime.commandLanguage || 'zh',
      game_path: runtime.gamePath || '',
      proxy: runtime.proxy || '',
      // yuyuko API 凭据随请求下发：用户是在 QQ Agent 的设置页里填的，
      // 不需要去敲命令行参数或设环境变量。留空时桥接回落到它自己的 --token。
      // 键名用 snake_case，与桥接侧的 resolve_token() 读取的字段一致。
      ...(runtime.yuyukoToken ? { hikari_token: String(runtime.yuyukoToken) } : {})
    }
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(500, Number(timeoutMs) || 60000));
  let res;
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { 'X-Hikari-Token': String(token) } : {})
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new BridgeError(`桥接服务 ${timeoutMs}ms 未返回`, { kind: 'timeout' });
    }
    throw new BridgeError(String(error?.message ?? error), { kind: 'offline' });
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text().catch(() => '');
  if (!res.ok) {
    let detail = text.slice(0, 300);
    try {
      const j = JSON.parse(text);
      if (j?.hint || j?.message) detail = String(j.hint || j.message).slice(0, 300);
    } catch { /* 非 JSON 错误体，直接用原文 */ }
    throw new BridgeError(detail || `HTTP ${res.status}`, { kind: 'http', status: res.status, body: text.slice(0, 1000) });
  }

  try {
    const data = JSON.parse(text);
    if (!data || typeof data !== 'object') throw new Error('响应不是对象');
    return data;
  } catch (error) {
    throw new BridgeError(`响应不是合法 JSON：${String(error?.message ?? error)}`, { kind: 'bad-json', body: text.slice(0, 500) });
  }
}

/**
 * 探活：读取桥接服务的 `/health`。
 *
 * @param {{url: string, token?: string, timeoutMs?: number}} params
 * @returns {Promise<{ok: boolean, ready: boolean, detail: object}>}
 *   `ok` 表示服务进程可达且状态正常；`ready` 表示其依赖（hikari-core）已就绪；
 *   `detail` 为原始响应体（含 `core_error` / `token_configured` / `ignored_functions`）。
 *   **不抛错**：探活失败本身就是一种需要上报的结果，交由调用方决定怎么提示。
 */
export async function bridgePing({ url, token = '', timeoutMs = 3000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${String(url).replace(/\/+$/, '')}/health`, {
      headers: token ? { 'X-Hikari-Token': String(token) } : {},
      signal: controller.signal
    });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok && data?.ok === true, ready: data?.ready === true, detail: data };
  } catch (error) {
    return { ok: false, ready: false, detail: { error: String(error?.message ?? error) } };
  } finally {
    clearTimeout(timer);
  }
}
