// wows-helper · 与 Hikari 桥接服务（bridge/hikari_bridge.py）通信的客户端
//
// 为什么中间要有一层 Python 服务：
//   Hikari-core-v2 是 Python SDK，指令解析 + yuyuko API 查询 + 模板渲染出图
//   全靠它（模板是浏览器端 Nunjucks，需要 playwright chromium 截图）。
//   Node 侧做不到这两件事，所以最干净的接法是"薄客户端 + 本地常驻桥接"：
//   Node 只管 QQ 的收发与确定性触发，Python 只管 wws 的命令解析与出图。
//
// 超时策略：所有请求都带 AbortController。
//   钩子里的预取若靠 Promise.race 单独超时，被放弃的那次 fetch 仍会继续占用
//   连接和（桥接侧的）渲染进程 —— 必须真正 abort，否则群里连发几条指令就会
//   堆一串僵尸查询，把浏览器挤爆。

export class BridgeError extends Error {
  constructor(message, { kind = 'error', status = 0, body = '' } = {}) {
    super(message);
    this.name = 'BridgeError';
    this.kind = kind;      // 'timeout' | 'offline' | 'http' | 'bad-json' | 'error'
    this.status = status;
    this.body = body;
  }
}

/** 桥接服务不可达 / 报错时，给群友看的人话（不可达是部署问题，不是指令问题）。 */
export function friendlyBridgeError(error) {
  if (error instanceof BridgeError) {
    if (error.kind === 'timeout') return '战舰世界数据服务响应超时了，稍后再试一次。';
    if (error.kind === 'offline') return '战舰世界数据服务没启动或地址不对（请检查 wows-helper 的桥接服务）。';
    return `战舰世界数据服务返回了异常：${error.message}`;
  }
  return `战舰世界数据服务调用失败：${error?.message ?? error}`;
}

/**
 * 桥接返回体里带"凭据没配"时，把它换成用户能直接照做的一句话。
 * 不这么做的话，群里看到的是"桥接服务内部错误：RuntimeError: 没有配置 yuyuko API 凭据…"——
 * 又长又不像给人看的（实测这类信息用户基本会忽略）。
 */
export function isTokenMissing(data) {
  const t = typeof data === 'string' ? data : `${data?.text ?? ''}${data?.hint ?? ''}${data?.message ?? ''}`;
  // 注意不能泛泛匹配 "yuyuko API 凭据"：TOKEN_MISSING_TEXT 自己也含这几个字，
  // 误判会把正常结果当成"缺凭据"。
  return /没有配置 yuyuko API 凭据/.test(t);
}

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

/** 轻量探活：给 available() 的异步探测与调试用。 */
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
