/**
 * 战舰世界助手（yuyuko-helper）· 插件入口
 * =====================================
 *
 * 职责
 * ----
 * 让群里一句「@机器人 yuyuko 大和」变成"查得到、画得出、发得出去"，并把链路拆成两段，
 * 各用各的扩展机制（对照 `doc/extend_development/plugin-development.md` §0/§2）：
 *
 * 1. **确定性一段** —— `before-context` 钩子负责**认领**。
 *    判定条件能写成 if（「@ 了机器人本人」+「去掉 @提及 后第一个词是 yuyuko」），
 *    漏认领就没有下文，因此必须走钩子、不经模型。钩子同时把
 *    「谁在问、问的什么、该调哪个工具」写进本批上下文。
 * 2. **LLM 一段** —— 模型据此调用 `wows-query` 工具。
 *    工具是模型唯一能主动发起查询的入口；拿到真实数据后由模型决定怎么接话。
 *
 * 为什么查询不放在钩子里
 * ----------------------
 * 钩子硬超时 5 秒（核心 `src/skills/manager.js` 的 `DEFAULT_HOOK_TIMEOUT_MS`），
 * 而实测一次 yuyuko 查询需 5~13 秒（yuyuko API + 浏览器端模板渲染 + 截图）。
 * 预取必然超时，只会让每次 `@机器人 yuyuko …` 白等几秒再退回工具 —— 因此默认 `hookPrefetch=false`，
 * 查询交给没有时限的工具。实测数据与复核脚本见 DEVELOPMENT.md 与 `bridge/probe_hikari.py`。
 *
 * 为什么渲染图默认由插件直接发
 * ----------------------------
 * 模型看不到图片内容。把"这张图要不要发"交给它判断，实测结果是"图躺在缓存里、
 * 群里什么都没有"。因此默认 `autoSendImage=true`：查询成功即走
 * `ctx.sender.sendImage`（发送队列 → 限频 → 去重 → 留档），模型只负责接话。
 * 关闭后，工具返回里会写明"渲染图尚未发送"并给出工具名。
 *
 * 边界（本模块不做什么）
 * ----------------------
 * * 不直连 yuyuko API —— 指令解析与模板渲染都在 Python 侧，只经本地桥接调用；
 * * 不绕过发送队列 —— 图片一律走 `ctx.sender.sendImage`，不碰 `onebot.send*`；
 * * 不在钩子里发消息、不重试 —— 钩子只做认领与本批上下文加工。
 *
 * 模块导出
 * --------
 * `setup` / `activate` / `deactivate` / `dispose` / `available` 为插件生命周期；
 * `hooks` 提供 `before-context`；`internals` 仅导出给自检脚本，不参与运行时。
 */
import { bindConfig, cfg } from './lib/config.js';
import { matchTrigger, parseSelectIndex, isBotMentioned, extractMentions } from './lib/trigger.js';
import { bridgeQuery, bridgePing, friendlyBridgeError, isTokenMissing, TOKEN_MISSING_TEXT } from './lib/bridge.js';
import { saveImage, attachUrl, clearAll, prune } from './lib/image-store.js';
import * as imageServer from './lib/image-server.js';
import { buildContextNote, formatResultText, clip, waitingHint, formatOptions } from './lib/format.js';

// ── 模块级状态 ────────────────────────────────────────────────────────────────
// 这些都是"当前进程的运行态"，全部带容量/TTL 上限；deactivate 与 dispose 里会清空，
// 避免禁用后重新启用还拿着过期数据，也避免长时间运行导致内存增长。

/** 日志出口，由 `setup(api)` 注入（带 `[skill:yuyuko-helper]` 前缀）。 */
let log = () => {};
let warn = () => {};

/** 多选会话：`会话键 → { at, options }`。用户回序号后据此续查。 */
const pending = new Map();

/** 最近一次查询结果：`chatKey → { at, text, dataType, command, image }`，供补发图片用。 */
const lastResult = new Map();

/**
 * 本轮触发消息的 id：`chatKey → messageId`。
 * 唯一用途：`replyToTrigger` 打开时，自动发出的图能引用那句"yuyuko xxx"。
 * 钩子里拿得到（`triggerEntries[].id`），工具执行时该上下文已不存在，故在此过一手。
 */
const triggerMsg = new Map();

/**
 * 最近一次 yuyuko 触发者：`chatKey → senderId`。
 *
 * 必须记录的原因：工具执行时拿到的 `ctx` 里**没有触发者 QQ 号**
 * （只有 `chatKey` / `chatId` / `selfId`），而 yuyuko 的账号绑定正是按 PlatformId 查询。
 * 用群号或机器人号去查必然查到别人（或查不到）。钩子认领时存下，工具路径再取回。
 */
const triggerSender = new Map();

/** 桥接可用性缓存：undefined=未知（乐观放行），false=探测失败过。 */
let bridgeOk = null;
let bridgeProbing = false;
let probeFailedAt = 0;

/**
 * 机器人自己的身份：用来判断"这条消息 @ 的是不是我"。
 *
 * 触发判定要求 **既 @ 了机器人、又有 yuyuko**（两个条件缺一不可）。
 * QQ Agent 的 OneBot 文本把 at 段还原成 `@昵称(QQ:机器人QQ)`，所以：
 *   · selfId（机器人 QQ）→ 精确命中，且能从这条消息里直接学到（见 learnSelfId）
 *   · 昵称               → `@昵称`（speaker-identity 插件关闭时的形态）
 * 两者都能从聊天文本里观察到；此外还尝试问一次 get_login_info 做交叉验证。
 */
const selfInfo = { id: '', nickname: '', at: 0, triedAt: 0 };

/**
 * 从一条消息里学习机器人自身身份（文本形如 `@昵称(QQ:机器人QQ)`）。
 *
 * 分两级：优先采信调用方传入的 `selfId`（即钩子上下文的 `ctx.selfId`）；
 * 没有时退化到"推断"—— `@机器人 yuyuko <指令>` 中
 * **紧邻触发词的最后一个 @提及**就是机器人本人。
 *
 * @param {string} text 消息原文。
 * @param {string} [selfId] 来自上下文的机器人 QQ 号；为空则走推断分支。
 * @returns {void} 结果写入模块级 `selfInfo`。
 *
 * @remarks
 * **只学 QQ 号，绝不学昵称。** `@机器人 yuyuko 大和` 里"@ 后面那个名字"确实是机器人，
 * 但 `@群友 yuyuko 大和`（查别人水表）中同一位置是**别人的名字**。一旦把它记成机器人昵称，
 * 之后所有 `@那个群友` 都会被误判为"@ 了我"。QQ 号无此问题：它是被 @ 者的真实身份。
 * 昵称只从可信来源取：钩子上下文的 `selfNickname`/`botName`，或 `get_login_info`。
 */
function learnSelfId(text, selfId) {
  if (selfInfo.id) return;
  // ⚠️ 位数不设下限：短号/测试号（如 selfId='1'）同样是合法 QQ 号
  if (selfId && /^\d{1,15}$/.test(String(selfId))) {
    selfInfo.id = String(selfId);
    selfInfo.at = Date.now();
    return;
  }
  // 走推断分支：`@机器人 yuyuko <指令>` 中紧邻触发词的那个 @ 即机器人
  if (!text) return;
  const parsed = extractMentions(String(text).replace(/^[\s\u200b\u200e\u200f\ufeff]+/, ''));
  if (!parsed.mentions.length) return;
  // 去掉前导 @提及 后的正文，其第一个词必须是触发词（与 matchTrigger 同一判据）
  const head = parsed.text.match(/^([A-Za-z0-9_\u4e00-\u9fa5]+)/);
  if (!head) return;
  if (!cfg().triggerKeywords.includes(head[1].toLowerCase())) return;
  const last = parsed.mentions[parsed.mentions.length - 1];
  if (last?.qid && /^\d{1,15}$/.test(String(last.qid))) {
    selfInfo.id = String(last.qid);
    selfInfo.at = Date.now();
  }
}

/**
 * 机器人可能的称呼集合。顺序即优先级：
 * 钩子上下文里的昵称 → 从聊天里学到的 QQ/昵称 → 清单里配置的 botId。
 */
function selfNames(ctx = {}, c = cfg()) {
  const names = [
    ctx.selfNickname,
    ctx.botName,
    selfInfo.nickname,
    selfInfo.id,
    c.botId && c.botId !== '0' ? c.botId : ''
  ];
  return [...new Set(names.map((n) => String(n ?? '').trim()).filter(Boolean))];
}

/**
 * 后台问一次 get_login_info（只读接口），拿到权威的 selfId/昵称。
 *
 * 失败/拿不到时**允许重试**（每 60 秒最多一次）：OneBot 连接可能比插件晚就绪，
 * 一次失败就永久放弃会让"@昵称"这条路一直不可用。成功后就长期缓存。
 * 全程不抛错、不阻塞钩子（调用方是 fire-and-forget）。
 */
async function probeSelfIdentity(ctx = {}) {
  if (selfInfo.id && selfInfo.nickname) return;       // 已有权威身份，不必再问
  if (Date.now() - selfInfo.triedAt < 60000) return;  // 节流：60 秒最多试一次
  selfInfo.triedAt = Date.now();
  const ob = ctx.onebot;
  try {
    let data = null;
    if (ob && typeof ob.call === 'function') data = await ob.call('get_login_info', {});
    else if (ob && typeof ob.getLoginInfo === 'function') data = await ob.getLoginInfo();
    if (data && data.user_id) {
      selfInfo.id = String(data.user_id);
      if (data.nickname) selfInfo.nickname = String(data.nickname);
      selfInfo.at = Date.now();
    }
  } catch { /* 拿不到就算了：文本里学到的身份已经够用 */ }
}

/**
 * 插件加载入口（核心在动态 import 后调用一次）。
 *
 * @param {object} api 核心注入的 Skill API（`config` / `log` / `warn` / `registerTool` 等）。
 * @returns {void}
 * @side effect 绑定配置读取器、注入日志出口、注册 2 个工具，并在**凭据未配置时提前告警**。
 *
 * @remarks
 * 这里不启动任何需要显式停止的东西（定时器、监听端口）—— 那些放 `activate`。
 * 因为热重载的顺序是"先 deactivate+dispose 旧实例，再 setup 新实例"，
 * 在 setup 里启动常驻资源会导致重载时端口/句柄泄漏。
 */
export function setup(api) {
  bindConfig(api.config);
  log = (...a) => api.log(...a);
  warn = (...a) => api.warn(...a);
  imageServer.setLog((m) => api.log(m));
  registerTools(api);
  api.log('已加载：@机器人 yuyuko 指令将交给 Hikari 桥接服务查询并渲染出图');
  // 凭据未配置是首次部署最常见的拦路虎：在加载时就提示，比等群里报错早一步
  if (!cfg().yuyukoToken) {
    api.warn('还没填「yuyuko API 凭据」（账号ID:Token）——请到本插件设置里填写，'
      + '或在启动桥接服务时用 -Token / 环境变量 HIKARI_TOKEN 提供。填完无需重启。');
  }
  void probeBridge();
}

/**
 * 插件被启用时调用：启动本地图片服务并做一次后台探活。
 *
 * 图片服务的作用是让渲染图能通过 URL 被取用（发送队列的效率通道、以及协议端
 * 与本机不同机时的回退通道）；端口被占用时 `imageServer.start` 会自行降级，
 * 不影响其他功能。
 *
 * @returns {Promise<void>}
 */
export async function activate() {
  const c = cfg();
  if (c.serveImage) {
    await imageServer.start({ host: c.imageServerHost, port: c.imageServerPort, ttlSec: c.imageTtlSec });
  }
  // 后台探活：不阻塞激活流程，结果只用于把错误提示写得更准确
  void probeBridge();
}

/**
 * 插件被禁用时调用：停止图片服务并清空运行态。
 *
 * 必须清理的原因：这些 Map 缓存的是"当前进程内有效"的会话与图片记录，
 * 禁用后若不清空，重新启用时会拿着过期选项去续查、或误判"这张图已经发过"。
 * 渲染图本身不立即删除，仍在 TTL 内（协议端可能正在取图）。
 *
 * @returns {Promise<void>}
 */
export async function deactivate() {
  await imageServer.stop();
  pending.clear();
  lastResult.clear();
  triggerMsg.clear();
  triggerSender.clear();
  prune(cfg().imageTtlSec, 20);
}

/**
 * 插件被卸载（或热重载替换）时调用：清空全部缓存并删除暂存的渲染图文件。
 *
 * 与 `deactivate` 的区别：这里连磁盘上的临时图片也一并清掉（`clearAll`），
 * 避免反复热重载在系统临时目录里堆积文件。
 *
 * @returns {void}
 */
export function dispose() {
  pending.clear();
  lastResult.clear();
  triggerMsg.clear();
  triggerSender.clear();
  clearAll();
}

/**
 * 可用性自检。**必须同步** —— 核心的判定链是同步的，返回 Promise 会被当成"可用"。
 *
 * 采用"首次乐观放行 + 后台探测 + 结果缓存"：在探出问题之前不阻断用户，
 * 探到不通则给出确切原因，并允许 60 秒后重试（用户可能刚把桥接服务起起来）。
 *
 * @returns {{ok: boolean, reason?: string}} `ok` 为 false 时 `reason` 会显示在「插件」页。
 */
export function available() {
  const c = cfg();
  if (!c.bridgeUrl) return { ok: false, reason: '未配置 Hikari 桥接服务地址' };
  if (bridgeOk === false && !bridgeProbing) {
    const now = Date.now();
    if (!probeFailedAt || now - probeFailedAt > 60000) {
      probeFailedAt = 0;
      void probeBridge();
    }
    return { ok: true, reason: '桥接服务暂不可达，正在重试（查询会明确报错）' };
  }
  return { ok: true };
}

/**
 * 探测桥接服务可用性并缓存结果（并发去重，同一时刻只跑一次）。
 *
 * 除了记住 `bridgeOk`，还承担两件"把话说在前面"的事：
 * * 桥接在但依赖未就绪（`ready=false`）时给出提示；
 * * 桥接报告 `token_configured=false` 且插件也没填凭据时，明确告知去哪填。
 *
 * @returns {Promise<void>}
 * @side effect 更新 `bridgeOk` / `probeFailedAt`，并通过 `log`/`warn` 输出。
 */
async function probeBridge() {
  if (bridgeProbing) return;
  bridgeProbing = true;
  try {
    const c = cfg();
    const r = await bridgePing({ url: c.bridgeUrl, token: c.bridgeToken, timeoutMs: 2500 });
    if (r.ok) {
      bridgeOk = true;
      log(r.ready ? '桥接服务连接正常' : '桥接服务已连接，但依赖还没就绪（hikari-core / playwright）');
      // 凭据没配时提前说清楚 —— 否则用户第一次 @机器人 yuyuko 只会看到"未授权"，很难定位
      if (r.detail?.token_configured === false && !c.yuyukoToken) {
        warn('还没配置 yuyuko API 凭据：请在插件设置里填「yuyuko API 凭据」（账号ID:Token），'
          + '或用 --token / 环境变量 HIKARI_TOKEN 启动桥接服务。');
      }
    } else {
      bridgeOk = false;
      probeFailedAt = Date.now();
      warn(`桥接服务不可达：${c.bridgeUrl}（${r.detail?.error || '请先启动 bridge/hikari_bridge.py'}）`);
    }
  } catch {
    bridgeOk = false;
    probeFailedAt = Date.now();
  } finally {
    bridgeProbing = false;
  }
}

// ── 工具 ────────────────────────────────────────────────────────────────────

/**
 * 注册本插件的 2 个工具。
 *
 * 工具是模型唯一能主动发起查询/发图的入口 —— 能力（providers）对模型完全不可见。
 * 工具 id 只写短名，核心会加 `yuyuko-helper__` 前缀（双下划线），
 * 且只允许 `[a-zA-Z0-9_-]`：带 `:` 或 `.` 会被严格端点以 400 拒掉整个请求。
 *
 * @param {object} api 核心注入的 Skill API。
 * @returns {void}
 */
function registerTools(api) {
  api.registerTool({
    id: 'wows-query',
    name: '战舰世界查询',
    // description 是模型判断"要不要调用"的唯一依据，必须同时写清"做什么"与"何时用"
    description:
      '查询战舰世界（World of Warships）玩家/舰船/军团/排行榜数据，数据来自 Hikari-core-v2（yuyuko 平台），'
      + '结果通常会被渲染成图片。参数 command 只填 yuyuko 后面的部分，不要带 yuyuko 前缀。'
      + '例：command="大和"（某人总水表）、command="ship 大和"（单船水表）、command="recent 30"（近期 30 天）、'
      + 'command="ship.rank cn 大和"（单船排行榜）、command="cw.rank"（军团战排行）、command="帮助"。'
      + '什么时候用：群里有人问战舰世界战绩/水表/排名，或你判断需要这些数据来把话接下去。'
      + '返回的是真实数据（自动出图并默认已发到群里），照抄数字即可，不要自己编。',
    category: 'query',
    icon: '⚓',
    parameters: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'yuyuko 指令正文（不含 yuyuko 前缀），如"大和"、"ship 大和 recent 30"、"cw.rank asia"、"帮助"'
        },
        platformId: {
          type: 'string',
          description: '可选：指定查询目标（游戏昵称或平台 ID）。一般不用填，默认查触发者自己。'
        },
        selectIndex: {
          type: 'number',
          description: '可选：上一轮结果提示"需要用户回复序号"时，把用户回复的序号填这里继续查询（1~30）。'
        }
      },
      required: ['command']
    },
    /**
     * @param {object} ctx 运行上下文（含 sender / chatKey / session，用于发图与留档）。
     * @param {{command: string, platformId?: string, selectIndex?: number}} args 模型给出的参数。
     * @returns {Promise<{content: string, isError?: boolean}>} 文本面向**模型**，不是直接发群的话。
     */
    async execute(ctx, args) {
      try {
        const command = String(args?.command ?? '').trim();
        if (!command) return { content: '缺少 command：请填 yuyuko 后面的指令正文，例如 "大和" 或 "帮助"。', isError: true };
        // 序号口径必须与 lib/trigger.js 的 parseSelectIndex 一致（1~30）：
        // 模型可能给 0 / 负数 / 99，直接透传给桥接只会换回一句难懂的报错
        let selectIndex = null;
        if (args?.selectIndex != null && args.selectIndex !== '') {
          const n = Number(args.selectIndex);
          if (!Number.isInteger(n) || n < 1 || n > 30) {
            return { content: `selectIndex 必须是 1~30 的整数（收到 ${JSON.stringify(args.selectIndex)}）。`, isError: true };
          }
          selectIndex = n;
        }
        const res = await handleQuery({
          ctx,
          command,
          platformIdOverride: String(args?.platformId ?? '').trim(),
          selectIndex,
          source: 'tool'
        });
        return { content: res.text, isError: !res.ok };
      } catch (error) {
        // 自己兜住异常并返回人话：抛出会被外层包成 {content:'错误：...'}，可读性略差
        return { content: `战舰世界查询失败：${error?.message ?? error}`, isError: true };
      }
    }
  });

  api.registerTool({
    id: 'wows-send-image',
    name: '发送战舰世界渲染图',
    description:
      '把最近一次战舰世界查询渲染出来的图片发到当前聊天。只在"渲染图未发送（自动发送已关闭）"或群友明确要求重发时使用；'
      + '如果上一步结果里写着"渲染图已由插件自动发出"，就不要再调这个工具（会重复刷屏，发送队列也会按去重拦掉）。',
    category: 'media',
    icon: '🖼️',
    parameters: {
      type: 'object',
      properties: {
        note: { type: 'string', description: '可选：配一句话一起发（不要重复图里的内容）' },
        replyToMessageId: { type: ['integer', 'string'], description: '可选：引用某条消息的 id' },
        atUserId: { type: ['integer', 'string'], description: '可选：@ 某人（填 QQ 号）' }
      }
    },
    /**
     * @param {object} ctx 运行上下文（需 `sender.sendImage`）。
     * @param {{note?: string, replyToMessageId?: (number|string), atUserId?: (number|string)}} args
     * @returns {Promise<{content: string, isError?: boolean}>}
     *
     * @remarks 正常路径下图片已由 `handleQuery` 自动发出，本工具只在
     * `autoSendImage=false` 或用户明确要求重发时才会被调用。去重命中不算失败。
     */
    async execute(ctx, args) {
      try {
        const last = lastResult.get(String(ctx.chatKey ?? ''));
        if (!last?.image) return { content: '还没有可发送的战舰世界渲染图 —— 先用 wows-query 查一次。', isError: true };
        if (!ctx.sender?.sendImage) return { content: '当前运行环境没有发送队列，无法发图。', isError: true };
        const info = await sendImageNow(ctx, last.image, {
          note: args?.note,
          replyToMessageId: args?.replyToMessageId ?? null,
          atUserId: args?.atUserId ?? null
        });
        if (!info.ok) {
          // 被去重拦下不是"失败"：同一张图刚发过，如实说明即可，不必让模型重试
          return { content: info.skipped ? '这张渲染图刚刚发过，已跳过重复发送。' : `渲染图发送失败：${info.error}`, isError: !info.skipped };
        }
        last.image.sent = true;
        last.image.sentAt = Date.now();
        return { content: `渲染图已发出（${info.via}，${Math.round((last.image.bytes || 0) / 1024)}KB）。`, isError: false };
      } catch (error) {
        return { content: `发送失败：${error?.message ?? error}`, isError: true };
      }
    }
  });
}

// ── 查询主流程 ──────────────────────────────────────────────────────────────

/**
 * 解析 Hikari 需要的平台身份三元组。
 *
 * `PlatformId` 必须是**触发者本人**：yuyuko 的账号绑定（bind）按 PlatformId 存储，
 * 传群号会把"我的水表"变成"群号的水表"；传机器人自己的号则会查到机器人账号。
 *
 * @param {{kind?: string, chatId?: string, selfId?: string, senderId?: string}} [ctxFields]
 *   `kind` 为 `'group'`/`'private'`；`senderId` 来自消息本身。
 * @param {object} c 归一化配置（用其 `platform` 与 `platformIdOverride`）。
 * @returns {{platform: string, platformId: string, groupId: (string|null)}} 传给桥接的身份字段。
 *
 * @remarks 取值顺序：消息发送者 → （私聊）会话对方 → 机器人自己。
 * 最后一级只是兜底，正常情况下不会用到；`platformIdOverride` 配置项可强制覆盖。
 */
function platformFor({ kind = 'group', chatId = '', selfId = '', senderId = '' } = {}, c) {
  const isGroup = String(kind) === 'group';
  const id = String(senderId || '').trim()
    || (isGroup ? '' : String(chatId || '').trim())
    || String(selfId || '').trim();
  return {
    platform: c.platform || 'QQ',
    platformId: c.platformIdOverride || id,
    groupId: isGroup ? String(chatId || '') || null : null
  };
}

/**
 * 构造多选会话键：`<chatKey>#<platformId>`。
 *
 * @param {{chatKey?: string, kind?: string, chatId?: string, senderId?: string, platformId?: string}} ctxFields
 * @param {object} c 归一化配置。
 * @returns {string} 会话键。
 *
 * @remarks **钩子与工具必须调用同一个函数**。两处各写一份会导致"序号回复认不上"——
 * 一处用 `platformIdOverride`、另一处用解析后的 `platformId`，在配置了覆盖时必然错位
 * （该问题由自检捕获过）。
 */
function sessionKeyOf({ chatKey = '', kind = 'group', chatId = '', senderId = '', platformId = '' }, c) {
  const key = String(chatKey || '').trim()
    || (String(kind) === 'group' ? `group:${chatId}` : `private:${chatId}`);
  const pid = String(platformId || '').trim() || c.platformIdOverride || String(senderId || '').trim();
  return `${key}#${pid}`;
}

/**
 * 记录"最近一次 yuyuko 是谁发起的"（`chatKey → senderId`），超出 50 条淘汰最旧。
 *
 * @param {string} chatKey 会话键。
 * @param {string} senderId 触发者 QQ 号。
 * @returns {void}
 *
 * @remarks 存的是**最近一次**，多人连续查询时后者覆盖前者 —— 这正是期望行为：
 * 模型补查时应当查"刚发指令的那个人"。见模块级 `triggerSender` 的说明。
 */
function rememberSender(chatKey, senderId) {
  const id = String(senderId || '').trim();
  if (!chatKey || !id) return;
  triggerSender.set(String(chatKey), id);
  while (triggerSender.size > 50) {
    const oldest = triggerSender.keys().next().value;
    if (oldest === undefined) break;
    triggerSender.delete(oldest);
  }
}

/**
 * 执行一次完整查询：调桥接 → 存图 → （按配置）自动发图 → 组装给模型看的文本。
 *
 * @param {object} params
 * @param {object} params.ctx 运行上下文；必须含 `sender`（用于发图）。
 * @param {string} params.command 指令正文（不含 `yuyuko`）。
 * @param {string} [params.platformIdOverride] 本次强制指定的查询目标。
 * @param {number|null} [params.selectIndex] 续查序号（1~30）。
 * @param {string} [params.source] 调用来源，仅用于日志与措辞（`'tool'` / `'hook'`）。
 * @returns {Promise<{ok: boolean, text: string, status?: string, result?: object}>}
 *   `text` 是给**模型**的资料；`ok=false` 时调用方应标记为错误结果。
 * @side effect 命中 `status=wait` 时挂起多选会话；成功且开启自动发图时**会真的发消息**。
 *
 * @remarks 失败一律返回 `ok:false` 而不是抛错 —— 文本里已经写明原因与下一步，
 * 交给模型转述比让异常冒泡更有用。
 */
async function handleQuery({ ctx, command, platformIdOverride = '', selectIndex = null, source = 'tool' }) {
  const c = cfg();
  if (!ctx?.sender) {
    return { ok: false, text: '当前运行环境缺少发送通道，无法处理战舰世界查询。' };
  }
  const chatKey = String(ctx.chatKey ?? '');
  // ctx 里没有触发者 QQ 号：优先用钩子记下的那位，其次才是 ctx 自带字段
  const knownSender = triggerSender.get(chatKey) || String(ctx.senderId ?? ctx.userId ?? '');
  const plat = platformFor({ ...ctx, senderId: knownSender }, c);
  const platformId = platformIdOverride || c.platformIdOverride || plat.platformId;
  const sessionKey = sessionKeyOf({ ...ctx, senderId: knownSender, platformId });

  const t0 = Date.now();
  let data;
  try {
    data = await bridgeQuery({
      url: c.bridgeUrl,
      token: c.bridgeToken,
      command,
      platform: plat.platform,
      platformId,
      botId: c.botId,
      groupId: plat.groupId,
      selectIndex: selectIndex == null ? null : selectIndex,
      // 始终带上会话键：续查要靠它找挂起的会话；新查询也带着，
      // 桥接侧才能在"同一个会话又发起新查询"时把旧的挂起项清掉，避免内存里堆僵尸会话。
      sessionKey,
      runtime: c,
      timeoutMs: c.requestTimeoutMs
    });
    bridgeOk = true;
  } catch (error) {
    bridgeOk = false;
    probeFailedAt = Date.now();
    if (c.debug) warn(`桥接调用失败（${source}，"${command}"）：${error?.message ?? error}`);
    return { ok: false, text: `【yuyuko 自动查询结果】\n查询失败：${friendlyBridgeError(error)}` };
  }
  const elapsed = Date.now() - t0;

  const status = String(data?.status ?? 'error');
  const dataType = String(data?.data_type ?? '');
  const text = String(data?.text ?? '').trim();
  const options = Array.isArray(data?.options) ? data.options : null;

  // 凭据没配：把桥接的英文/技术化措辞换成"去哪填"的人话（这是最常见的首次使用故障）
  if (isTokenMissing(data)) {
    return { ok: false, text: `【yuyuko 自动查询结果】\n指令：yuyuko ${command}\n${TOKEN_MISSING_TEXT}` };
  }

  // 出图：桥接把渲染结果以 base64 回传（浏览器端 Nunjucks 渲染只有 Python 侧能做）。
  // 放在最前面：**多选时的选择列表图也要走同一条路** —— 否则模型只拿到一串选项文字，
  // 群里看不到那张图，用户根本不知道要选什么。
  const attachImage = async (tag, platformIdForImage) => {
    if (!data?.image_base64) return null;
    try {
      const buffer = Buffer.from(String(data.image_base64), 'base64');
      const saved = await saveImage(buffer, {
        mime: data.image_mime || dataType || c.imageType,
        tag,
        ttlSec: c.imageTtlSec,
        maxEntries: 20
      });
      const url = imageServer.urlFor(saved.token);
      if (url) attachUrl(saved.token, url);
      if (saved.bytes > c.maxImageMB * 1024 * 1024) {
        warn(`渲染图 ${(saved.bytes / 1048576).toFixed(1)}MB 超过上限 ${c.maxImageMB}MB，已跳过发送`);
        return { ...saved, url, platformId: platformIdForImage, oversized: true, sent: false };
      }
      return { ...saved, url, platformId: platformIdForImage, sent: false };
    } catch (error) {
      warn(`渲染图暂存失败：${error?.message ?? error}`);
      return null;
    }
  };

  /**
   * 把一张已暂存的图按当前配置发出去（引用触发消息 / @ 触发者）。
   *
   * @param {object|null} image `attachImage` 的返回值。
   * @returns {Promise<object|null>} 发送结果；未发送时返回 `null`。
   */
  const autoSend = async (image) => {
    if (!image || !c.autoSendImage || image.oversized) return null;
    const info = await sendImageNow(ctx, image, {
      replyToMessageId: c.replyToTrigger ? (triggerMsg.get(chatKey) ?? null) : null,
      atUserId: c.atTriggerUser ? plat.platformId : null,
      platformId
    });
    image.sent = info.ok;
    if (info.ok) image.sentAt = Date.now();
    if (!info.ok && c.debug) warn(`渲染图自动发送失败：${info.error}`);
    return info;
  };

  // ── 多选：把待选项挂起，等用户回序号（他下一句靠 pending 认领）──
  if (status === 'wait' && options?.length) {
    rememberPending(sessionKey, options, c.maxPending, command);
    rememberSender(chatKey, platformId);
    // ⚠️ 这张"选择列表图"必须**直接发出去**：用户要在图里看选项，再由模型 @ 他回序号。
    //    早期这里只把选项拼成文字交给模型，图被丢掉了 —— 群里既看不到选项图，
    //    模型也只是照着文字复述，用户完全不知道该怎么选。
    const image = await attachImage(`yuyuko ${command}（多选）`, platformId);
    const sentInfo = await autoSend(image);
    const label = selectIndex == null ? command : `${command}（续查 · 选择 ${selectIndex}）`;
    const out = [
      '【yuyuko 自动查询结果】',
      `指令：yuyuko ${label}`,
      waitingHint(c.requireAt),                       // 与钩子路径共用一份文案
      image
        ? (sentInfo?.ok
          ? '选择列表图已由插件直接发出（群友照着图回序号即可）。不要再用 wows-send-image 重复发这张图。'
          : '选择列表图已生成但发送失败（见桥接日志）。不要用文字编造选项，据实说明图片没发出去。')
        : '',
      text ? `服务端提示：${clip(text, 300)}` : '',
      '待选项（与图中一致）：',
      formatOptions(options)
    ].filter(Boolean).join('\n');
    // 留档：这张图也在 lastResult 里，用户要求重发时有据可依
    lastResult.set(chatKey, {
      at: Date.now(), text: out, dataType, command,
      image: image ? { ...image, sent: !!sentInfo?.ok } : null
    });
    return { ok: true, text: out, status };
  }

  // ── 失败：提示文案来自 Hikari（如"未找到该玩家"），照实转达，别让模型编 ──
  // ── 失败：提示文案来自 Hikari（如"未找到该玩家"），照实转达，别让模型编 ──
  if (status === 'failed' || status === 'error') {
    return {
      ok: false,
      text: `【yuyuko 自动查询结果】\n指令：yuyuko ${command}\n结果：${clip(text || '服务端返回失败但没有说明', 500)}`
    };
  }

  // ── 成功 ──
  const bodyText = text || (dataType ? '（服务端只返回了图片，没有文本数据）' : '（服务端没有返回内容）');
  const result = {
    ok: true,
    status,
    dataType,
    text: bodyText,
    command,
    image: null,
    sentInfo: null
  };

  // 默认直接发图：模型不会主动发它看不见的图，等它判断的结果通常是"群里什么都没有"。
  result.image = await attachImage(`yuyuko ${command}`, platformId);
  result.sentInfo = await autoSend(result.image);

  lastResult.set(chatKey, { at: Date.now(), text: bodyText, dataType, command, image: result.image });
  if (lastResult.size > 50) {
    const oldest = [...lastResult.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (oldest) lastResult.delete(oldest[0]);
  }

  if (c.debug) log(`yuyuko 查询完成（${source}）："${command}" ${status} ${elapsed}ms ${result.image ? `图 ${Math.round(result.image.bytes / 1024)}KB` : '无图'}`);

  return { ok: true, text: formatResultText(result, c), result };
}

/**
 * 把渲染图交给发送队列，按可靠性依次尝试三种图片来源。
 *
 * @param {object} ctx 运行上下文，需 `sender.sendImage` 与 `chatKey`。
 * @param {{file?: string, url?: string, dataUrl: string}} image 已暂存的图片记录。
 * @param {{note?: string, replyToMessageId?: (number|string|null), atUserId?: (number|string|null)}} [options]
 * @returns {Promise<{ok: boolean, via?: string, messageId?: any, error?: string, skipped?: boolean}>}
 *
 * @remarks
 * 三条通道**都只是给发送队列一个图片来源**，队列 / 限频 / 去重 / 留档一个都不少，
 * 全程不触碰 `onebot.send*`：
 *
 * 1. `file` —— 协议端直接读本地磁盘，HTTP body 从数 MB 降到几百字节（首选）；
 * 2. `url`  —— 本地只读图片服务，适用于协议端无法读取该路径的情况；
 * 3. `dataUrl` —— base64 内联，最后的兜底。
 *
 * 前三者任一成功即返回。被发送队列按去重拦下时返回 `skipped:true` 而非报错 ——
 * "这张图刚发过"是保护机制生效，不是故障。
 */
async function sendImageNow(ctx, image, { note = null, replyToMessageId = null, atUserId = null } = {}) {
  if (!image) return { ok: false, error: '没有图片' };
  const attempts = [];
  if (image.file) attempts.push({ name: '本地文件', img: { file: image.file, dataUrl: image.dataUrl } });
  if (image.url) attempts.push({ name: '本地图片服务', img: { url: image.url, dataUrl: image.dataUrl } });
  attempts.push({ name: 'base64 内联', img: { dataUrl: image.dataUrl } });

  let lastError = '';
  for (const attempt of attempts) {
    try {
      const r = await ctx.sender.sendImage(ctx.chatKey, attempt.img, {
        note: note || undefined,
        replyToMessageId: replyToMessageId ?? null,
        atUserId: atUserId ?? null
      });
      // 会话留档：失败不影响"已发出"这一事实，故单独 try 包裹
      try {
        ctx.session?.sent?.push({
          type: 'image',
          text: `[yuyuko 渲染图${note ? `:${String(note).slice(0, 40)}` : ''}]`,
          at: new Date().toLocaleTimeString('zh-CN', { hour12: false })
        });
        if (ctx.session?.id) ctx.emit?.('session-update', ctx.session.id);
      } catch { /* 留档失败不影响发送结果 */ }
      return { ok: true, via: attempt.name, messageId: r?.message_id ?? null };
    } catch (error) {
      lastError = String(error?.message ?? error);
      if (/刚刚发过|已跳过/.test(lastError)) return { ok: false, error: '这张图刚刚发过（已按去重跳过）', skipped: true };
    }
  }
  return { ok: false, error: lastError || '未知错误' };
}

/**
 * 挂起一个等待用户选择的多选会话（`sessionKey → {command, options}`）。
 *
 * @param {string} sessionKey 会话键，见 `sessionKeyOf`。
 * @param {Array} options 归一化后的待选项（桥接已裁剪为最多 12 条）。
 * @param {number} maxPending 会话数上限（配置项，默认 6）。
 * @param {string} [command] 原始指令。**必须存**：用户回序号后要由工具带着同一个
 *     command 发起续查（桥接按它 + sessionKey 找到挂起的候选对象），
 *     而钩子注入的提示里也要写明这个 command。
 * @returns {void}
 *
 * @remarks TTL 固定 5 分钟：用户回序号通常只隔几十秒，再长也没有意义。
 * ⚠️ 单位是**毫秒** —— 此处曾误写成 `5 * 60 * 1000 * 1000`（等于永不过期），
 * 造成选项长期滞留，修改时请勿再加错数量级。
 */
function rememberPending(sessionKey, options, maxPending, command = '') {
  pending.set(sessionKey, { at: Date.now(), options, command: String(command || '') });
  const ttl = 5 * 60 * 1000;
  const now = Date.now();
  for (const [key, item] of pending) {
    if (now - item.at > ttl) pending.delete(key);
  }
  const cap = Math.max(1, Number(maxPending) || 6);
  while (pending.size > cap) {
    const oldest = [...pending.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (!oldest) break;
    pending.delete(oldest[0]);
  }
}

// ── 钩子 ──────────────────────────────────────────────────────────────────────

export const hooks = {
  /**
   * `before-context`：在提示词组装之前完成**确定性认领**，并把结果追加到本批消息上。
   *
   * 两遍扫描，职责互不重叠：
   *
   * 1. 第一遍 —— 认领 yuyuko 指令。命中后记录触发者与消息 id；默认只注入一条
   *    「【yuyuko 指令已认领】」块，告诉模型调哪个工具、参数是什么。
   *    若开启 `hookPrefetch`，则在此限时预取数据并直接注入结果。
   * 2. 第二遍 —— 认领序号回复。用户对上一轮的多选提示回数字时，代其续查并注入结果。
   *
   * @param {object} ctx 钩子上下文
   * @param {Array<object>} ctx.triggerEntries 本批触发消息（**可原地修改 `text`**）。
   * @param {string} ctx.chatKey 会话键，如 `group:123`。
   * @param {string} ctx.kind `'group'` / `'private'`。
   * @param {string} ctx.chatId 群号或 QQ 号。
   * @param {string} [ctx.selfId] 机器人 QQ 号（缺失时走身份推断）。
   * @param {string} [ctx.selfNickname] 机器人在本群的昵称。
   * @param {string} [ctx.botName] 人设里配置的机器人名字。
   * @param {object} [ctx.onebot] OneBot 客户端（用于补问 `get_login_info`）。
   * @returns {Promise<void>} 只通过修改 `triggerEntries[].text` 生效（钩子不该发消息）。
   *
   * @remarks
   * **这是有意的"宁可不触发"设计**：触发词必须在最前、且必须 @ 到机器人本人。
   * 群里聊到 yuyuko 是常态，抢话比漏答更糟；判定失败时只在 `debug` 日志里
   * 留一行原因，绝不猜。
   *
   * 关于"钩子里做网络请求"：默认路径**不发任何请求**（纯文本判定，微秒级）。
   * 仅当用户显式打开 `hookPrefetch` 时才限时预取（默认 3.6s、上限 4.5s，
   * 用 AbortController 真掐断，保证撞不到 5 秒硬超时）。实测一次查询需 5~13 秒，
   * 因此该选项默认关闭 —— 依据见 DEVELOPMENT.md §2.3 与 §8。
   */
  'before-context': async ({ triggerEntries, chatKey, kind, chatId, selfId, selfNickname, botName, onebot } = {}) => {
    if (!Array.isArray(triggerEntries) || !triggerEntries.length) return;
    const c = cfg();
    const key = chatKey || (String(kind) === 'group' ? `group:${chatId}` : `private:${chatId}`);

    // 先学一次机器人身份：文本里的 `@昵称(QQ:机器人QQ)` 就能确定 selfId，
    // 拿不到时后台问一次 get_login_info（只读接口）交叉验证。
    for (const entry of triggerEntries) {
      learnSelfId(String(entry?.text ?? ''), selfId);
    }
    if (!selfInfo.id) void probeSelfIdentity({ onebot, selfNickname, botName }).catch(() => {});
    const names = selfNames({ selfNickname, botName }, c);
    const matchOpts = { requireAt: c.requireAt, selfNames: names };

    for (const entry of triggerEntries) {
      const text = String(entry?.text ?? '');
      const hit = matchTrigger(text, c.triggerKeywords, matchOpts);
      if (!hit.matched) {
        // 只差一个 @ 时给模型一句提示（写进上下文，用户自己也会看到"没反应"）：
        // 这是有意的"宁可不触发"—— 但把原因说清楚，免得用户以为插件坏了。
        if (c.requireAt && hit.reason === '没有 @ 机器人') {
          if (c.debug) log(`跳过（未 @ 机器人）：${String(text).slice(0, 40)}`);
        }
        continue;
      }
      // 记下触发消息 id：replyToTrigger 打开时，自动发的图要引用这一句
      if (entry?.id && (kind === 'group' || kind === 'private')) {
        triggerMsg.set(key, entry.id);
        if (triggerMsg.size > 50) {
          const oldest = triggerMsg.keys().next().value;
          if (oldest) triggerMsg.delete(oldest);
        }
      }
      // 记下触发者：工具路径的 ctx 里没有 QQ 号，靠这里带过去
      rememberSender(key, entry?.senderId);

      const label = `yuyuko ${hit.command || '帮助'}`;
      if (c.debug) log(`认领指令：${String(entry?.senderName ?? entry?.senderId ?? '?')} 「${label}」（${hit.reason}）`);

      // ① 预取：钩子内限时（真 abort），把结果写进上下文
      let note = '';
      if (c.hookPrefetch) {
        const command = hit.command || '帮助';
        const plat = platformFor({ kind, chatId, selfId, senderId: entry?.senderId }, c);
        try {
          const data = await withTimeout(
            bridgeQuery({
              url: c.bridgeUrl,
              token: c.bridgeToken,
              command,
              platform: plat.platform,
              platformId: plat.platformId,
              botId: c.botId,
              groupId: plat.groupId,
              runtime: c,
              timeoutMs: c.hookPrefetchTimeoutMs
            }),
            c.hookPrefetchTimeoutMs
          );
          bridgeOk = true;
          // 多选：钩子路径也要挂起会话，否则用户回"2"时没人认领
          //（工具路径在 handleQuery 里挂，两条路必须都挂 —— 这是同一份状态的写入口）
          if (String(data?.status) === 'wait' && Array.isArray(data?.options) && data.options.length) {
            rememberPending(sessionKeyOf({ chatKey: key, senderId: entry?.senderId }, c), data.options, c.maxPending, command);
            rememberSender(key, entry?.senderId);
          }
          note = buildContextNote({
            command,
            data,
            autoSendImage: c.autoSendImage,
            maxChars: c.contextDataMaxChars,
            includeData: c.includeDataInContext,
            requireAt: c.requireAt
          });
          if (c.debug) log(`预取成功：${label}`);
        } catch (error) {
          bridgeOk = false;
          probeFailedAt = Date.now();
          const msg = String(error?.message ?? error);
          const timedOut = error?.kind === 'timeout' || /超时|abort/i.test(msg);
          if (isTokenMissing(msg)) {
            // 凭据没配是最常见的首次故障：这里直接把"去哪填"说清楚
            note = `【yuyuko 自动查询结果】\n指令：yuyuko ${command}\n${TOKEN_MISSING_TEXT}`;
          } else {
            note = timedOut
              ? `【yuyuko 自动查询结果】\n指令：yuyuko ${command}\n本次预取超时（渲染较慢）。请立刻用 wows-query 工具重查一次（工具没有 5 秒限制），查到后再接话；不要凭印象说数据。`
              : `【yuyuko 自动查询结果】\n指令：yuyuko ${command}\n查询失败：${friendlyBridgeError(error)}`;
          }
          if (c.debug) warn(`预取失败：${label} —— ${msg}`);
        }
      } else {
        // 默认路径：钩子只做"确定性认领"，真正的查询交给 wows-query 工具。
        // 为什么不在钩子里查：一次查询要经过 yuyuko API + 浏览器渲染 + 截图，
        // 实测热态 5~13 秒（首次还要下载 chromium 与船图缓存，约 150 秒），
        // 而钩子硬超时只有 5 秒 —— 预取必然超时，只会让每次 @机器人 白等几秒（见 DEVELOPMENT.md §8）。
        // 这里必须把"谁在问、问的什么"写清楚 —— 工具执行时的 ctx 里没有触发者 QQ 号。
        const cmd = hit.command || '帮助';
        note = '【yuyuko 指令已认领】\n'
          + `发起人：${String(entry?.senderName ?? entry?.senderId ?? '群友')}（QQ:${entry?.senderId ?? '?'}）\n`
          + `指令：yuyuko ${cmd}\n`
          + `请立刻调用 yuyuko-helper__wows-query 工具执行它（command="${cmd}"，不要带 yuyuko 前缀），`
          + '查到数据/出图后再接话。这个工具会真实查询并自动把渲染图发到群里，通常几秒。\n'
          + '在工具返回之前，不要凭印象说任何战绩数字。';
      }

      if (note) {
        // 追加而不是替换：原话必须留着（模型要能看到是谁在问、问的什么）
        entry.text = `${text}\n\n${clip(note, c.contextDataMaxChars + 400)}`;
      }
    }

    // ② 序号回复：不带触发词，但上一轮挂起了多选会话。
    // 同样要求 @ 了机器人（或 requireAt 关闭）—— 群里连着两句"2"太常见。
    //
    // ⚠️ 这里**只认领、不查询**，和 ① 的默认路径保持一致。
    //    早期版本在这里直接 bridgeQuery + hookPrefetchTimeoutMs（3.6s）预取，
    //    结果是"续查永远没有数据和图"：一次渲染实测 5.5~10 秒，3.6 秒必然超时，
    //    上下文里只剩一条"续查失败"，模型只能自己编。
    //    钩子本身还有 5 秒硬超时，所以这里也不可能等到结果 —— 必须交给工具。
    for (const entry of triggerEntries) {
      const text = String(entry?.text ?? '').trim();
      if (!text) continue;
      if (matchTrigger(text, c.triggerKeywords, matchOpts).matched) continue;
      const idx = parseSelectIndex(text, matchOpts);
      if (idx == null) continue;
      const senderId = String(entry?.senderId ?? '');
      const sessionKey = sessionKeyOf({ chatKey: key, senderId }, c);
      const pend = pending.get(sessionKey);
      if (!pend) continue;
      const pl = pend.options[idx - 1];
      if (!pl) {
        entry.text = `${text}\n\n【yuyuko 多选续查】群友回复了序号 ${idx}，但上一轮只有 ${pend.options.length} 个待选项，该序号不合法。请提醒对方重新选择。`;
        continue;
      }
      if (entry?.id) triggerMsg.set(key, entry.id);
      rememberSender(key, senderId);
      // 选项名的键名与 lib/format.js 的 formatOptions 保持一致：
      // 桥接 extract_options() 统一下发的是 {name}，这里不能再猜 label 之类的键名，
      // 否则提示里只会剩"选项 2"这种没信息量的兜底文案。
      const label = pl.name ?? pl.text ?? `选项 ${idx}`;
      if (c.debug) log(`认领续查：${String(entry?.senderName ?? senderId ?? '?')} 选择 ${idx}（${label}）`);
      // 立刻清掉挂起会话：这次续查已认领，避免群友同一句"1"连发两次被重复认领
      // （真实的查询与挂起对象由工具带着 sessionKey 去桥接取，所以这里删掉不影响执行）
      pending.delete(sessionKey);
      // 上下文里带上待选项：序号不合法时模型要能把可选项原样报回去。
      entry.text = `${text}\n\n【yuyuko 多选续查】\n`
        + `发起人：${String(entry?.senderName ?? senderId ?? '群友')}（QQ:${senderId}）\n`
        + `该群友回复的是序号 ${idx}，对应：${clip(String(label), 80)}\n`
        + `待选项：\n${formatOptions(pend.options)}\n`
        + `请立刻调用 yuyuko-helper__wows-query 工具执行这次续查：`
        + `command="${pend.command || ''}"、selectIndex=${idx}。\n`
        + '这个工具会真实查询并自动把渲染图发到群里，通常几秒；'
        + '在它返回之前，不要凭印象说这条船的数据或结果。';
    }
  }
};

/** 给 Promise 加真超时：超时后 abort 上游请求（见 bridge.js 的 AbortController）。 */
function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const e = new Error(`预取超过 ${ms}ms`);
      e.kind = 'timeout';
      reject(e);
    }, Math.max(200, Number(ms) || 3600));
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export const internals = {
  matchTrigger,
  parseSelectIndex,
  isBotMentioned,
  extractMentions,
  buildContextNote,
  formatResultText,
  sessionKeyOf,
  pending,
  lastResult,
  triggerSender,
  selfInfo,
  imageServer
};
