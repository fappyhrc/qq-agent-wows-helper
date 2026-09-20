// 战舰世界助手（wows-helper）· 确定性认领 + LLM 接话
//
// ── 这个插件解决的到底是什么问题 ───────────────────────────────────────────
// 群里喊一句「@机器人 wws 大和」，期望是"查得到、画得出、发得出去"。链路拆成两段：
//
//   ① **确定性一段** —— `before-context` 钩子负责认领：判定「@ 了机器人本人」+「第一个词是 wws」，
//      记下发起的 QQ 号，并把「该调哪个工具、参数是什么」写进这一批上下文。
//      规则能写死（就是几个 if），漏认领就没有下文 → 必须走钩子，不经模型。
//   ② **LLM 一段** —— 模型据此调用 `wows-query` 工具（工具是模型唯一能主动发起查询的入口），
//      拿到真实数据后自己决定怎么接话。
//
// ⚠️ 查询为什么不放在钩子里：钩子硬超时 5 秒（manager.js 的 DEFAULT_HOOK_TIMEOUT_MS），
//    而实测一次 wws 查询要 5~13 秒（yuyuko API + 浏览器端模板渲染 + 截图），
//    预取必然超时、只会白等。所以 `hookPrefetch` 默认关闭，查询交给没有时限的工具。
//    相关实测数据见 README §1 与 bridge/probe_hikari.py。
//
// ── 图片为什么默认由插件直接发 ───────────────────────────────────────────
// 模型看不到图片内容。把"这张渲染图要不要发"交给它判断，实测结果就是
// "图躺在缓存里、群里什么都没有"。所以默认 autoSendImage=true：查询成功即走
// `ctx.sender.sendImage`（队列 → 限频 → 去重 → 留档），模型只负责接话。
// 关掉后工具返回里会写明"渲染图尚未发送"，并给出工具名。
//
// ── 边界（它不做什么）──────────────────────────────────────────────────────
//   · 不直连 yuyuko API：指令解析与模板渲染都在 Python 侧的 Hikari-core-v2，
//     这里只通过 bridge/hikari_bridge.py 这个本地桥接调用它（超时、探活、降级都在这层）。
//   · 不绕过发送队列：图片一律走 ctx.sender.sendImage，不碰 onebot.send*。
//   · 不在钩子里发消息、不重试：钩子只做认领与本批上下文加工。
import { bindConfig, cfg } from './lib/config.js';
import { matchTrigger, parseSelectIndex, isBotMentioned, extractMentions } from './lib/trigger.js';
import { bridgeQuery, bridgePing, friendlyBridgeError, isTokenMissing, TOKEN_MISSING_TEXT } from './lib/bridge.js';
import { saveImage, attachUrl, clearAll, prune } from './lib/image-store.js';
import * as imageServer from './lib/image-server.js';
import { buildContextNote, formatResultText, clip, waitingHint, formatOptions } from './lib/format.js';

let log = () => {};
let warn = () => {};

/** wws 需要用户选择时挂起的会话：key → { at, options }。容量与时间都有限，防内存增长。 */
const pending = new Map();

/** 最近一次查询结果：按会话保存，供"模型想补发这张图"时取用。 */
const lastResult = new Map();     // chatKey → { at, text, dataType, command, image }

/**
 * 本轮触发消息的 id：chatKey → messageId。
 * 只为一件事存在 —— `replyToTrigger` 打开时，自动发出的图能引用那句"wws xxx"。
 * 钩子里拿得到（triggerEntries[].id），工具执行时那个上下文已经没了，所以要在这里过一手。
 */
const triggerMsg = new Map();

/**
 * 最近一次 wws 触发者：chatKey → senderId。
 *
 * 为什么必须记：工具执行时的 `ctx` 里**没有触发者 QQ 号**（只有 chatKey/chatId/selfId）。
 * 而 wws 的绑定是按 PlatformId 查的，用群号或机器人号去查必然查不到别人的水表。
 * 所以钩子认领时把 senderId 存下来，工具路径再取回去 —— 两条路必须查到同一个人。
 */
const triggerSender = new Map();

/** 桥接可用性缓存：undefined=未知（乐观放行），false=探测失败过。 */
let bridgeOk = null;
let bridgeProbing = false;
let probeFailedAt = 0;

/**
 * 机器人自己的身份：用来判断"这条消息 @ 的是不是我"。
 *
 * 触发判定要求 **既 @ 了机器人、又有 wws**（与官方 wws 机器人一致）。
 * QQ Agent 的 OneBot 文本把 at 段还原成 `@昵称(QQ:机器人QQ)`，所以：
 *   · selfId（机器人 QQ）→ 精确命中，且能从这条消息里直接学到（见 learnSelfId）
 *   · 昵称               → `@昵称`（speaker-identity 插件关闭时的形态）
 * 两者都能从聊天文本里观察到；此外还尝试问一次 get_login_info 做交叉验证。
 */
const selfInfo = { id: '', nickname: '', at: 0, triedAt: 0 };

/** 从一条已被 @ 的消息里学习机器人身份（文本里形如 `@昵称(QQ:机器人QQ)`）。 */
function learnSelfId(text, selfId) {
  if (selfInfo.id) return;
  // ⚠️ 位数不设下限：短号/测试号（如 selfId='1'）也是合法 QQ 号
  if (selfId && /^\d{1,15}$/.test(String(selfId))) {
    selfInfo.id = String(selfId);
    selfInfo.at = Date.now();
    return;
  }
  // 钩子上下文里没有 selfId 时的兜底：靠"紧邻触发词的最后一个 @提及"推断。
  // 依据是官方语义 —— `@机器人 wws <指令>` 里，机器人一定是紧邻触发词的那个 @。
  //
  // ⚠️ 只学 **QQ 号**，绝不学昵称：
  //    `@机器人 wws 大和` 的文本里，机器人的名字恰好是"@ 后面那个名字"，
  //    但如果有人写成 `@群友 wws 大和`（问别人的水表），这个位置就是**别人的名字**。
  //    一旦把它当成机器人昵称，"@那个群友"以后都会被误判成"@ 了我"。
  //    QQ 号则没有这个问题：它是被 @ 者的真实身份，纯数字也不会和别人撞。
  //    昵称只从可信来源取：钩子上下文的 selfNickname / botName，或 get_login_info。
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

export function setup(api) {
  bindConfig(api.config);
  log = (...a) => api.log(...a);
  warn = (...a) => api.warn(...a);
  imageServer.setLog((m) => api.log(m));
  registerTools(api);
  api.log('已加载：@wws 指令将交给 Hikari 桥接服务查询并渲染出图');
  // 凭据还没配时先说一声：这是首次使用最常见的拦路虎，等到群里报错就太晚了
  const c = cfg();
  if (!c.yuyukoToken) {
    api.warn('还没填「yuyuko API 凭据」（账号ID:Token）——请到本插件设置里填写，'
      + '或在启动桥接服务时用 -Token / 环境变量 HIKARI_TOKEN 提供。填完无需重启。');
  }
  void probeBridge();
}

export async function activate() {
  const c = cfg();
  if (c.serveImage) {
    await imageServer.start({ host: c.imageServerHost, port: c.imageServerPort, ttlSec: c.imageTtlSec });
  }
  // 后台探活：不阻塞启动，结果只用来把错误提示写得更准确。
  void probeBridge();
}

export async function deactivate() {
  await imageServer.stop();
  // 钩子里挂起的会话属于"当前进程的运行态"，禁用即清空 ——
  // 否则重新启用后会拿着过期选项去查。
  pending.clear();
  lastResult.clear();
  triggerMsg.clear();
  triggerSender.clear();
  // 渲染图仍留在 TTL 内（协议端可能还在取图），只清理超量的部分。
  const c = cfg();
  prune(c.imageTtlSec, 20);
}

export function dispose() {
  pending.clear();
  lastResult.clear();
  triggerMsg.clear();
  triggerSender.clear();
  clearAll();
}

/**
 * 可用性自检必须**同步**（判定链是同步的，返回 Promise 会被当成"可用"）。
 * 这里用"首次乐观放行 + 后台探测 + 缓存结果"：没探出问题之前不拦人，
 * 探到桥接不通就给出确切原因，比让每句话都失败一遍强。
 */
export function available() {
  const c = cfg();
  if (!c.bridgeUrl) return { ok: false, reason: '未配置 Hikari 桥接服务地址' };
  // 凭据没填时**照常放行**（桥接可能自己带着 --token 启动），
  // 但把原因写进 reason，让「插件」页能一眼看到"还差什么"。
  if (bridgeOk === false && !bridgeProbing) {
    // 探测失败后允许一段时间后重试，避免用户把服务起好了插件还不认
    const now = Date.now();
    if (!probeFailedAt || now - probeFailedAt > 60000) {
      probeFailedAt = 0;
      void probeBridge();
    }
    return { ok: true, reason: '桥接服务暂不可达，正在重试（查询会明确报错）' };
  }
  return { ok: true };
}

async function probeBridge() {
  if (bridgeProbing) return;
  bridgeProbing = true;
  try {
    const c = cfg();
    const r = await bridgePing({ url: c.bridgeUrl, token: c.bridgeToken, timeoutMs: 2500 });
    if (r.ok) {
      bridgeOk = true;
      log(r.ready ? '桥接服务连接正常' : '桥接服务已连接，但依赖还没就绪（hikari-core / playwright）');
      // 凭据没配时提前说清楚 —— 否则用户第一次 @wws 只会看到"未授权"，很难定位
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

function registerTools(api) {
  api.registerTool({
    id: 'wows-query',
    name: '战舰世界查询',
    description:
      '查询战舰世界（World of Warships）玩家/舰船/军团/排行榜数据，数据来自 Hikari-core-v2（yuyuko 平台），'
      + '结果通常会被渲染成图片。参数 command 只填 wws 后面的部分，不要带 wws 前缀。'
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
          description: 'wws 指令正文（不含 wws 前缀），如"大和"、"ship 大和 recent 30"、"cw.rank asia"、"帮助"'
        },
        platformId: {
          type: 'string',
          description: '可选：指定查询目标（游戏昵称或平台 ID）。一般不用填，默认查触发者自己。'
        },
        selectIndex: {
          type: 'number',
          description: '可选：上一轮结果提示"需要用户回复序号"时，把用户回复的序号填这里继续查询。'
        }
      },
      required: ['command']
    },
    async execute(ctx, args) {
      try {
        const command = String(args?.command ?? '').trim();
        if (!command) return { content: '缺少 command：请填 wws 后面的指令正文，例如 "大和" 或 "帮助"。', isError: true };
        // 序号必须是 1~30 的正整数（与 lib/trigger.js 的 parseSelectIndex 同一口径）：
        // 模型可能给 0 / 负数 / 99，直接透传给桥接只会换回一句难懂的报错。
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
    async execute(ctx, args) {
      try {
        const c = cfg();
        const last = lastResult.get(String(ctx.chatKey ?? ''));
        if (!last?.image) return { content: '还没有可发送的战舰世界渲染图 —— 先用 wows-query 查一次。', isError: true };
        if (!ctx.sender?.sendImage) return { content: '当前运行环境没有发送队列，无法发图。', isError: true };
        const info = await sendImageNow(ctx, last.image, {
          note: args?.note,
          replyToMessageId: args?.replyToMessageId ?? null,
          atUserId: args?.atUserId ?? null,
          platformId: last.image.platformId
        });
        if (!info.ok) {
          // 去重拦下不是"失败"：同一张图刚发过，如实说明即可，不必让模型重试
          return { content: info.skipped ? `这张渲染图刚刚发过，已跳过重复发送。` : `渲染图发送失败：${info.error}`, isError: !info.skipped };
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
 * 解析 Hikari 需要的平台身份。
 *
 * PlatformId 必须是**触发者本人**：wws 的绑定（bind）是按 PlatformId 存的，
 * 传群号会让"我的水表"变成"群号的水表"（查不到或串号）。
 *   · 群聊：用消息里的 senderId
 *   · 私聊：会话对方就是发送者，chatId 即其人
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
 * 多选会话键：**钩子与工具必须用同一个函数拼**。
 * 这两处本来就该一致，各写一份的结果是"序号回复认不上"——
 * 一个传的是 platformIdOverride，另一个传的是解析后的 platformId（自检抓到过）。
 */
function sessionKeyOf({ chatKey = '', kind = 'group', chatId = '', senderId = '', platformId = '' }, c) {
  const key = String(chatKey || '').trim()
    || (String(kind) === 'group' ? `group:${chatId}` : `private:${chatId}`);
  const pid = String(platformId || '').trim() || c.platformIdOverride || String(senderId || '').trim();
  return `${key}#${pid}`;
}

/**
 * 记一位触发者（chatKey → senderId），容量有限，最旧的淘汰。
 * 存的是"最近一次 wws 是谁发的"，所以多人连续查询时后一次会覆盖前一次 ——
 * 这正是我们要的：模型调工具补查时，查的是**刚发指令的那个人**。
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
 * 执行一次查询：调桥接 → 出图 → （按配置）发图 → 组装给模型看的文本。
 * `source` 只影响日志与文本措辞（钩子预取 vs 模型主动调工具）。
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
    return { ok: false, text: `【wws 自动查询结果】\n查询失败：${friendlyBridgeError(error)}` };
  }
  const elapsed = Date.now() - t0;

  const status = String(data?.status ?? 'error');
  const dataType = String(data?.data_type ?? '');
  const text = String(data?.text ?? '').trim();
  const options = Array.isArray(data?.options) ? data.options : null;

  // 凭据没配：把桥接的英文/技术化措辞换成"去哪填"的人话（这是最常见的首次使用故障）
  if (isTokenMissing(data)) {
    return { ok: false, text: `【wws 自动查询结果】\n指令：wws ${command}\n${TOKEN_MISSING_TEXT}` };
  }

  // ── 多选：把待选项挂起，等用户回序号（他下一句靠 pending 认领）──
  if (status === 'wait' && options?.length) {
    rememberPending(sessionKey, options, c.maxPending);
    rememberSender(chatKey, platformId);
    const label = selectIndex == null ? command : `${command}（续查 · 选择 ${selectIndex}）`;
    const out = [
      '【wws 自动查询结果】',
      `指令：wws ${label}`,
      waitingHint(c.requireAt),                       // 与钩子路径共用一份文案
      text ? `服务端提示：${clip(text, 300)}` : '',
      '待选项：',
      formatOptions(options)
    ].filter(Boolean).join('\n');
    return { ok: true, text: out, status };
  }

  // ── 失败：提示文案来自 Hikari（如"未找到该玩家"），照实转达，别让模型编 ──
  // ── 失败：提示文案来自 Hikari（如"未找到该玩家"），照实转达，别让模型编 ──
  if (status === 'failed' || status === 'error') {
    return {
      ok: false,
      text: `【wws 自动查询结果】\n指令：wws ${command}\n结果：${clip(text || '服务端返回失败但没有说明', 500)}`
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

  // 出图：桥接把渲染结果以 base64 回传（浏览器端 Nunjucks 渲染只有 Python 侧能做）
  if (data?.image_base64) {
    try {
      const buffer = Buffer.from(String(data.image_base64), 'base64');
      const saved = await saveImage(buffer, {
        mime: data.image_mime || dataType || c.imageType,
        tag: `wws ${command}`,
        ttlSec: c.imageTtlSec,
        maxEntries: 20
      });
      const url = imageServer.urlFor(saved.token);
      if (url) attachUrl(saved.token, url);
      if (saved.bytes > c.maxImageMB * 1024 * 1024) {
        warn(`渲染图 ${(saved.bytes / 1048576).toFixed(1)}MB 超过上限 ${c.maxImageMB}MB，已跳过发送`);
        result.image = { ...saved, url, platformId, oversized: true, sent: false };
      } else {
        result.image = { ...saved, url, platformId, sent: false };
      }
    } catch (error) {
      warn(`渲染图暂存失败：${error?.message ?? error}`);
    }
  }

  // 默认直接发图：模型不会主动发它看不见的图，等它判断的结果通常是"群里什么都没有"。
  if (result.image && c.autoSendImage && !result.image.oversized) {
    const info = await sendImageNow(ctx, result.image, {
      replyToMessageId: c.replyToTrigger ? (triggerMsg.get(chatKey) ?? null) : null,
      atUserId: c.atTriggerUser ? plat.platformId : null,
      platformId
    });
    result.sentInfo = info;
    result.image.sent = info.ok;
    if (info.ok) result.image.sentAt = Date.now();
    if (!info.ok && c.debug) warn(`渲染图自动发送失败：${info.error}`);
  }

  lastResult.set(chatKey, { at: Date.now(), text: bodyText, dataType, command, image: result.image });
  if (lastResult.size > 50) {
    const oldest = [...lastResult.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (oldest) lastResult.delete(oldest[0]);
  }

  if (c.debug) log(`wws 查询完成（${source}）："${command}" ${status} ${elapsed}ms ${result.image ? `图 ${Math.round(result.image.bytes / 1024)}KB` : '无图'}`);

  return { ok: true, text: formatResultText(result, c), result };
}

/**
 * 把渲染图交给发送队列。
 * 三级通道：本地路径（协议端读盘，body 最小） → 本地图片服务 URL → base64 内联。
 * 这不是"绕过 sender"：三条都只是给它一个图片来源，队列/限频/去重/留档一个都不少。
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
      try {
        ctx.session?.sent?.push({
          type: 'image',
          text: `[wws 渲染图${note ? `:${String(note).slice(0, 40)}` : ''}]`,
          at: new Date().toLocaleTimeString('zh-CN', { hour12: false })
        });
        if (ctx.session?.id) ctx.emit?.('session-update', ctx.session.id);
      } catch { /* 留档失败不影响"已发出"这个事实 */ }
      return { ok: true, via: attempt.name, messageId: r?.message_id ?? null };
    } catch (error) {
      lastError = String(error?.message ?? error);
      // "刚刚发过"是去重拦下的，属于正常保护，不算失败
      if (/刚刚发过|已跳过/.test(lastError)) return { ok: false, error: '这张图刚刚发过（已按去重跳过）', skipped: true };
    }
  }
  return { ok: false, error: lastError || '未知错误' };
}

function rememberPending(sessionKey, options, maxPending) {
  pending.set(sessionKey, { at: Date.now(), options });
  // 容量与 TTL 双限：序号回复通常几十秒内到来，5 分钟足够，过期即弃。
  // ttl 单位是毫秒（曾经这里写成 `5 * 60 * 1000 * 1000`，等于永不过期，别再加错）。
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

// ── 钩子：确定性认领 + 预取 ─────────────────────────────────────────────────

export const hooks = {
  /**
   * 组装提示词之前：认出 wws 指令、把真实数据塞进这一批上下文。
   *
   * ⚠️ 这里**故意**在钩子里做了一次网络请求，是权衡后的选择，边界必须守住：
   *   项目文档（plugin-development.md §3.2）规定钩子 5 秒超时、不应做网络请求。
   *   而"群里 @wws 就一定该出数据"——只做识别、把查询留给模型，模型很可能不调工具。
   *   所以这里限时预取（hookPrefetchTimeoutMs，默认 3.6s，配置上限 4.5s），
   *   并用 AbortController 真正掐断，保证**永远撞不到**那 5 秒；超时就退化成
   *   "请模型用 wows-query 重查"（工具路径没有 5 秒限制）。
   *   钩子本身不发消息、不重试 —— 发图交给完整发送管道。
   *   不接受这个折中就把 hookPrefetch 关掉，那时钩子只剩纯文本判定（零网络）。
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

      const label = `wws ${hit.command || '帮助'}`;
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
            rememberPending(sessionKeyOf({ chatKey: key, senderId: entry?.senderId }, c), data.options, c.maxPending);
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
            note = `【wws 自动查询结果】\n指令：wws ${command}\n${TOKEN_MISSING_TEXT}`;
          } else {
            note = timedOut
              ? `【wws 自动查询结果】\n指令：wws ${command}\n本次预取超时（渲染较慢）。请立刻用 wows-query 工具重查一次（工具没有 5 秒限制），查到后再接话；不要凭印象说数据。`
              : `【wws 自动查询结果】\n指令：wws ${command}\n查询失败：${friendlyBridgeError(error)}`;
          }
          if (c.debug) warn(`预取失败：${label} —— ${msg}`);
        }
      } else {
        // 默认路径：钩子只做"确定性认领"，真正的查询交给 wows-query 工具。
        // 为什么不在钩子里查：一次查询要经过 yuyuko API + 浏览器渲染 + 截图，
        // 实测热态 5~13 秒（首次还要下载 chromium 与船图缓存，约 150 秒），
        // 而钩子硬超时只有 5 秒 —— 预取必然超时，只会让每次 @wws 白等几秒。见 README §1。
        // 这里必须把"谁在问、问的什么"写清楚 —— 工具执行时的 ctx 里没有触发者 QQ 号。
        const cmd = hit.command || '帮助';
        note = '【wws 指令已认领】\n'
          + `发起人：${String(entry?.senderName ?? entry?.senderId ?? '群友')}（QQ:${entry?.senderId ?? '?'}）\n`
          + `指令：wws ${cmd}\n`
          + `请立刻调用 wows-helper__wows-query 工具执行它（command="${cmd}"，不要带 wws 前缀），`
          + '查到数据/出图后再接话。这个工具会真实查询并自动把渲染图发到群里，通常几秒。\n'
          + '在工具返回之前，不要凭印象说任何战绩数字。';
      }

      if (note) {
        // 追加而不是替换：原话必须留着（模型要能看到是谁在问、问的什么）
        entry.text = `${text}\n\n${clip(note, c.contextDataMaxChars + 400)}`;
      }
    }

    // ② 序号回复：不带 wws，但上一轮挂起了多选会话。
    // 同样要求 @ 了机器人（或 requireAt 关闭）—— 群里连着两句"2"太常见。
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
        entry.text = `${text}\n\n【wws 多选续查】群友回复了序号 ${idx}，但上一轮只有 ${pend.options.length} 个待选项，该序号不合法。请提醒对方重新选择。`;
        continue;
      }
      if (entry?.id) triggerMsg.set(key, entry.id);
      rememberSender(key, senderId);
      const c2 = cfg();
      const plat = platformFor({ kind, chatId, selfId, senderId }, c2);
      try {
        const data = await withTimeout(
          bridgeQuery({
            url: c2.bridgeUrl,
            token: c2.bridgeToken,
            command: '',
            platform: plat.platform,
            platformId: senderId,
            botId: c2.botId,
            groupId: plat.groupId,
            selectIndex: idx,
            sessionKey,
            runtime: c2,
            timeoutMs: c2.hookPrefetchTimeoutMs
          }),
          c2.hookPrefetchTimeoutMs
        );
        pending.delete(sessionKey);
        entry.text = `${text}\n\n${buildContextNote({
          command: `（续查 · 选择 ${idx}）`,
          data,
          autoSendImage: c2.autoSendImage,
          maxChars: c2.contextDataMaxChars,
          includeData: c2.includeDataInContext,
          requireAt: c2.requireAt
        })}`;
      } catch (error) {
        entry.text = `${text}\n\n【wws 多选续查】按序号 ${idx} 续查失败：${friendlyBridgeError(error)}`;
      }
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
