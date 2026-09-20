// wows-helper · 触发词识别（纯函数，可单测）
//
// 为什么需要它：官方 wws 机器人的判定是"消息里 @ 了机器人 + 以 wws 开头"。
// QQ Agent 的 OneBot 文本已经把 at 段还原成了 `@<群名片或QQ号>`，
// 所以实际收到的可能长这样：
//
//   "@老八(QQ:1000000001) wws 大和"
//   "@老八(QQ:1) wws 单船 大和 recent 30"
//   "wws me"                              ← 没 @ 机器人（requireAt 打开时不认领）
//   "@wws 大和"                            ← 有人干脆直接 @ 叫 wws 这个名字
//   "  wws  roll 日本 战列舰 10"
//   "@老八(QQ:1) 帮我看看 wws 大和"          ← ❌ 触发词不在最前
//
// 两条判定（AND）：
//   ① `requireAt` 打开时，消息必须 **@ 了机器人本人**（默认打开，与官方机器人一致）
//   ② 去掉开头的 @提及 与空白后，**第一个词**必须是触发词
//
// ⚠️ 为什么坚持"触发词必须在最前"：群里聊到 wws 三个字母是常态，
//    只要含 wws 就触发会疯狂抢话。宁可不触发，也不能抢话。

/**
 * 提取开头的连续 @提及。
 *
 * 实现走"逐字符扫描"而不是一条大正则，原因见下面注释里记的两个真实坑：
 *   坑 1（指令丢失）：用惰性量词 /^@[^\s@]{0,64}?/ 时，"@老八(QQ:123) wws 大和"
 *        里的名字只吃到"老"，QQ 后缀匹配不上，剩下的"八(QQ:123)"被当成了触发词。
 *   坑 2（群名片带括号）：要允许"@"后面出现括号（群名片常写成"@老八(开黑)"），
 *        但 QQ 后缀恰好也是括号 —— 用一条正则同时表达两者必然二义。
 *
 * 扫描规则：一个提及 = @ + 昵称(? + 括号段, 整段没有空白则并入)，
 * 遇到空白就结束；连续多个 @ 都会被吃掉。
 *
 * @returns {{text:string, mentions:Array<{name:string,qid:string|null,raw:string}>, last:object|null}}
 *   text    = 去掉全部前导 @提及 后的正文
 *   mentions= 按出现顺序的提及列表（qid 为 "(QQ:n)" 里的 n，没有则为 null）
 *   last    = 最后一个提及（用于兼容"@wws 大和"这种写法）
 */
export function extractMentions(text) {
  let s = String(text ?? '').replace(/^[\s\u200b\u200e\u200f\ufeff]+/, '');
  const mentions = [];

  for (let round = 0; round < 6 && s.startsWith('@'); round++) {
    const afterAt = s.slice(1);
    let name = '';
    let qid = null;
    let paren = '';

    // ① QQ 号后缀：`@(QQ:123)`（at 段没解析出名字时的形态）
    const bareQq = afterAt.match(/^\(QQ:(\d+)\)/i);
    if (bareQq) {
      qid = bareQq[1];
      name = qid;
      s = afterAt.slice(bareQq[0].length);
    } else {
      // ② 昵称：~QQ 号 或 纯数字（@123456）
      const numeric = afterAt.match(/^(~?\d{3,15})/);
      if (numeric) {
        name = numeric[1];
        s = afterAt.slice(numeric[0].length);
      } else {
        // ⚠️ 昵称**不能吃进括号**：`@老八(QQ:123)` 里若把括号一起吃掉，
        //    "(QQ:123)" 就成了名字的一部分，永远匹配不到机器人（自检抓到过）。
        const nm = afterAt.match(/^([^\s@(]{1,32})/);
        if (!nm) break;
        name = nm[1];
        s = afterAt.slice(nm[0].length);
      }
      // ③ 后缀：`(QQ:n)` 优先，其次是群名片里的括号段（如 `@老八(开黑)`）
      const qq = s.match(/^\(QQ:(\d+)\)/i);
      if (qq) {
        qid = qq[1];
        paren = qq[0];
        s = s.slice(qq[0].length);
      } else {
        const pm = s.match(/^\(([^\s()]{1,32})\)/);
        if (pm) {
          paren = pm[0];
          s = s.slice(pm[0].length);
        }
      }
    }

    mentions.push({ name, qid, raw: `@${name}${paren}` });
    s = s.replace(/^[\s\u3000:：,，]+/, '');
  }
  return { text: s, mentions, last: mentions.length ? mentions[mentions.length - 1] : null };
}

/**
 * 这条消息有没有 @ 机器人本人。
 *
 * 判定顺序（命中即返回）：
 *   ① 提及带了 `(QQ:n)` 后缀：只有当 n 在 selfNames 的数字里才算命中（**唯一身份**）
 *   ② 提及不带 QQ 后缀（如 `@机器人`）：名字等于机器人昵称/人设名才算命中
 *   ③ 原始文本里出现 `qq=机器人QQ` 的 CQ 码 → 命中（极少数未归一化的路径）
 *
 * ⚠️ 带 QQ 后缀的提及**不会**再退回按名字判：`@机器人(QQ:999)` 里名字虽然相同，
 *    但 QQ 明确是别人 —— 群里真的出现过同名成员，按名字判会误认领。
 * ⚠️ 也不按"文本里出现机器人 QQ 数字"来判：`@某人(QQ:1234)` 里恰好含 1 时不能命中。
 *
 * @param {string} text 原始消息文本
 * @param {string[]} selfNames 机器人可能的称呼（昵称、人设名、selfId 字符串）
 */
export function isBotMentioned(text, selfNames = []) {
  const t = String(text ?? '');
  if (!t) return false;
  const { mentions } = extractMentions(t);
  const norm = (v) => String(v ?? '').trim().toLowerCase();
  const names = (Array.isArray(selfNames) ? selfNames : [selfNames])
    .map((n) => String(n ?? '').trim())
    .filter(Boolean);
  // ⚠️ 这里是"整串是否全是数字"，**不能**要求 3 位以上：
  //    测试账号、短号（如 selfId='1'）也是合法 QQ 号，写死 {3,15} 会让它们永远匹配不上。
  const isNumeric = (n) => /^\d+$/.test(n);
  const ids = names.filter(isNumeric);
  const nicknames = names.filter((n) => !isNumeric(n));

  // ① 带 QQ 后缀的提及（QQ 号是唯一身份，优先用它）
  for (const m of mentions) {
    if (m.qid && ids.some((id) => String(id) === String(m.qid))) return true;
  }
  // ② 裸名匹配：只对**没有 QQ 后缀**的提及生效。
  //    带后缀的提及已经由 ① 判过（QQ 对不上就是别人），此时再看名字会误判 ——
  //    群里出现同名成员（实测有）时，`@机器人(QQ:999)` 会被当成"@ 了我"。
  for (const m of mentions) {
    if (m.qid) continue;
    if (nicknames.some((n) => norm(n) === norm(m.name))) return true;
  }
  // ③ CQ 码兜底：极少数未归一化的路径会在文本里留下原始 at 段
  if (ids.length) {
    const re = /\[CQ:at(?:,[^\]]*?)?qq=(\d+)[^\]]*\]/gi;
    let hit;
    while ((hit = re.exec(t))) {
      if (ids.some((id) => String(id) === String(hit[1]))) return true;
    }
  }
  return false;
}

/**
 * 判断一条消息是不是 wws 指令。
 *
 * @param {string} text 消息文本（store 里的 text 字段）
 * @param {string[]} keywords 触发词（大小写不敏感，写不写 @ 都行）
 * @param {{requireAt?:boolean, selfNames?:string[]}} options
 *   requireAt: true（默认）时必须 @ 了机器人；false 时只看触发词位置
 *   selfNames: 机器人可能的称呼，requireAt 时用来判定"@ 的是不是本人"
 * @returns {{matched:boolean, command:string, raw:string, atBot:boolean, reason:string}}
 *   command = 去掉触发词后的指令正文（不带 wws 前缀，正好是 Hikari 要的格式）
 */
export function matchTrigger(text, keywords = ['wws'], options = {}) {
  const rawText = String(text ?? '');
  const requireAt = options.requireAt !== false;
  const words = (Array.isArray(keywords) ? keywords : [])
    .map((k) => String(k ?? '').replace(/^@/, '').trim().toLowerCase())
    .filter(Boolean);
  const miss = (reason) => ({ matched: false, command: '', raw: rawText, atBot: false, reason });
  if (!words.length) return miss('未配置触发词');

  const { text: body0, mentions, last } = extractMentions(rawText);
  const atBot = isBotMentioned(rawText, options.selfNames || []);
  if (requireAt && !atBot) return miss('没有 @ 机器人');

  // "@wws 大和"：被吃掉的提及本身就是触发词 → 用它当头部，后面照常取指令
  const reused = last && words.includes(String(last.name).trim().toLowerCase());
  const body = reused ? `${last.name} ${body0}`.trim() : body0;

  const m = body.match(/^([A-Za-z0-9_\u4e00-\u9fa5]+)([\s\S]*)$/);
  if (!m) return miss('触发词不在最前');
  const head = m[1].toLowerCase();
  if (!words.includes(head)) return miss('触发词不在最前');

  // 触发词与指令之间允许有冒号/逗号（"wws：大和"），一并吃掉
  const command = String(m[2] ?? '').replace(/^[\s:：,，、]+/, '').trim();
  return { matched: true, command, raw: rawText, atBot, reason: mentions.length ? '已 @ 机器人' : '触发词匹配' };
}

/**
 * 编号回复的识别：wws 需要用户选择时（重名舰船/多绑定），
 * 用户在下一句回"2"或"选2"。这类消息本身不带触发词，靠"上一轮有挂起的选择"来认领。
 *
 * 同样受 requireAt 约束：只有当那条回复也 @ 了机器人（或 requireAt 关闭）时才认领 ——
 * 群里连着两句"2"太常见，没有 @ 就不该被当成万国牌的续查。
 *
 * @returns {number|null} 1 起的序号；不是序号回复时返回 null
 */
export function parseSelectIndex(text, options = {}) {
  const raw = String(text ?? '');
  const requireAt = options.requireAt !== false;
  if (requireAt && !isBotMentioned(raw, options.selfNames || [])) return null;
  const s = extractMentions(raw).text.trim();
  const m = s.match(/^(?:选|选择|第|回复)?\s*(\d{1,2})\s*(?:号|项|个)?$/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isInteger(n) && n >= 1 && n <= 30 ? n : null;
}

