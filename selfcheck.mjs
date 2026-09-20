// wows-helper 自检脚本（不碰网络、不起外部服务，纯本地逻辑）
// 用法：node plugins/wows-helper/selfcheck.mjs
import { matchTrigger, parseSelectIndex, isBotMentioned, extractMentions } from './lib/trigger.js';
import { buildContextNote, formatResultText, clip } from './lib/format.js';
import { saveImage, getImage, attachUrl, clearAll } from './lib/image-store.js';
import { start, stop, urlFor } from './lib/image-server.js';

let pass = 0;
let fail = 0;
function eq(actual, expected, name) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a === b) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}\n      期望 ${b}\n      实际 ${a}`); }
}

// 测试上下文：机器人 QQ 是 1，群昵称「机器人」，人设名「小八」
const BOT = { requireAt: true, selfNames: ['机器人', '小八', '1'] };

console.log('— @提及 解析 —');
eq(extractMentions('@老八(QQ:1000000001) wws 大和').mentions, [{ name: '老八', qid: '1000000001', raw: '@老八(QQ:1000000001)' }], '带 QQ 后缀');
eq(extractMentions('@老八(开黑) wws 大和').mentions[0].qid, null, '括号群名片不算 QQ 后缀');
eq(extractMentions('@A @B wws 大和').mentions.length, 2, '连续 @ 多人');

console.log('— 是否 @ 了机器人 —');
eq(isBotMentioned('@机器人(QQ:1) wws 大和', BOT.selfNames), true, '按 QQ 号命中');
eq(isBotMentioned('@小八 wws 大和', BOT.selfNames), true, '按人设名命中（无 QQ 后缀的裸名）');
eq(isBotMentioned('@老八(QQ:123) wws 大和', BOT.selfNames), false, '别人的 QQ 不算');
eq(isBotMentioned('@机器人(QQ:999) wws 大和', BOT.selfNames), false, '同名但 QQ 不同 → 不算（群里可能真有同名）');
eq(isBotMentioned('@老八(QQ:1) wws 大和', BOT.selfNames), true, '名字不同但 QQ 是本人 → 命中');
eq(isBotMentioned('@老八(QQ:1234) wws 大和', ['机器人', '1']), false, '号码含 1 不算命中');
eq(isBotMentioned('[CQ:at,qq=1] wws 大和', ['机器人', '1']), true, 'CQ 码兜底');

console.log('— 触发判定：@ + wws 两个条件（AND）—');
eq(matchTrigger('@机器人(QQ:1) wws 大和', ['wws'], BOT).matched, true, '@机器人 + wws → 认领');
eq(matchTrigger('@机器人(QQ:1) wws 大和', ['wws'], BOT).command, '大和', '提取指令正文');
eq(matchTrigger('@机器人(QQ:1) wws 单船 大和 recent 30', ['wws'], BOT).command, '单船 大和 recent 30', '多词指令');
eq(matchTrigger('wws 大和', ['wws'], BOT).matched, false, '只有 wws、没 @ → 不认领');
eq(matchTrigger('wws 大和', ['wws'], BOT).reason, '没有 @ 机器人', '给出"没 @ 机器人"的原因');
eq(matchTrigger('@机器人(QQ:1) 大和', ['wws'], BOT).matched, false, '只有 @、没 wws → 不认领');
eq(matchTrigger('@老八(QQ:123) wws 大和', ['wws'], BOT).matched, false, '@ 的是别人 → 不认领');
eq(matchTrigger('@机器人(QQ:1) 我觉得 wws 不错', ['wws'], BOT).matched, false, '触发词不在最前 → 不认领');
eq(matchTrigger('@机器人(QQ:1) wws', ['wws'], BOT).command, '', '只有触发词（=> 帮助）');
eq(matchTrigger('@机器人(QQ:1) WWS 大和', ['wws'], BOT).command, '大和', '大小写不敏感');
eq(matchTrigger('@机器人(QQ:1) wws：大和', ['wws'], BOT).command, '大和', '中文冒号');
eq(matchTrigger('  @机器人(QQ:1)   wws   roll 日本 战列舰 10 ', ['wws'], BOT).command, 'roll 日本 战列舰 10', '前导/多余空白');
eq(matchTrigger('@wws 大和', ['wws'], { requireAt: false }).command, '大和', '@wws 直接叫触发词');
eq(matchTrigger('@机器人(QQ:1) @wws 大和', ['wws'], BOT).command, '大和', '@机器人 之后再 @wws');
eq(matchTrigger('wws 大和', ['wws'], { requireAt: false, selfNames: [] }).matched, true, 'requireAt 关闭 → 只看触发词');
eq(matchTrigger('[引用 某人：wws 大和]', ['wws'], { requireAt: false }).matched, false, '引用块不误触发');
eq(matchTrigger('@机器人(QQ:1) wws 大和', ['wws', '@wws'], BOT).matched, true, '多触发词配置');

console.log('— 边界：名字/号码的相似与包含 —');
eq(isBotMentioned('@机器人小助手(QQ:9) wws 大和', BOT.selfNames), false, '名字包含"机器人"但不是本人 → 不算');
eq(isBotMentioned('@小八八(QQ:9) wws 大和', BOT.selfNames), false, '名字包含"小八"但不是本人 → 不算');
eq(matchTrigger('@机器人小助手(QQ:9) wws 大和', ['wws'], BOT).matched, false, '相似名字不误认领');
eq(matchTrigger('@机器人(QQ:1) wws ship Jean Bart', ['wws'], BOT).command, 'ship Jean Bart', '多词英文船名完整保留');
eq(matchTrigger('@机器人(QQ:1) wws    ', ['wws'], BOT).command, '', '触发词后只有空白 → 走帮助');
eq(matchTrigger('@机器人(QQ:1) wws\n大和', ['wws'], BOT).command, '大和', '换行分隔也认');
eq(matchTrigger('@机器人(QQ:1)wws 大和', ['wws'], BOT).command, '大和', 'QQ 后缀后紧跟触发词也认（分界明确）');
eq(matchTrigger('@机器人wws 大和', ['wws'], BOT).matched, false, '昵称与触发词粘在一起时不猜（"机器人wws"不是触发词）');

console.log('— 边界：requireAt 关闭时的老行为 —');
eq(matchTrigger('wws 大和', ['wws'], { requireAt: false }).command, '大和', '无需 @ 也能认领');
eq(matchTrigger('@队友 wws 大和', ['wws'], { requireAt: false }).command, '大和', '关闭后不看 @ 的是谁');
eq(parseSelectIndex('2', { requireAt: false }), 2, '关闭后裸序号可续查');

console.log('— 序号回复（续查）—');
eq(parseSelectIndex('@机器人(QQ:1) 2', BOT), 2, '带 @ 的序号');
eq(parseSelectIndex('2', BOT), null, '没 @ 的裸序号 → 不认领');
eq(parseSelectIndex('2', { requireAt: false }), 2, 'requireAt 关闭时裸序号可认领');
eq(parseSelectIndex('@机器人(QQ:1) 选 3', BOT), 3, '“选 3”');
eq(parseSelectIndex('@机器人(QQ:1) 第2个', BOT), 2, '“第2个”');
eq(parseSelectIndex('@机器人(QQ:1) 好的', BOT), null, '普通文本');
eq(parseSelectIndex('@机器人(QQ:1) 99', BOT), null, '越界序号');

console.log('— 上下文注入 —');
const note = buildContextNote({
  command: '大和',
  data: { status: 'success', text: '胜率 54.3%  场次 1200', image_base64: 'AAAA' },
  autoSendImage: true,
  maxChars: 100
});
eq(note.includes('【wws 自动查询结果】'), true, '带结果抬头');
eq(note.includes('胜率 54.3%'), true, '原样带数据');
eq(note.includes('数字照抄'), true, '强调照抄数字');
eq(note.includes('渲染图已由插件自动发出'), true, '说明图已发');
const note2 = buildContextNote({
  command: '大和',
  data: { status: 'success', text: 'x', image_base64: 'AAAA' },
  autoSendImage: false,
  maxChars: 100
});
eq(note2.includes('wows-helper__wows-send-image'), true, '关闭自动发图时给出工具名');
const noteNoData = buildContextNote({
  command: '大和',
  data: { status: 'success', text: '胜率 54.3%', image_base64: 'AAAA' },
  autoSendImage: true,
  maxChars: 100,
  includeData: false
});
eq(noteNoData.includes('胜率 54.3%'), false, 'includeData=false → 不注入数据文本');
eq(noteNoData.includes('wows-query'), true, 'includeData=false → 指向工具');
const note3 = buildContextNote({
  command: '大和',
  data: { status: 'wait', text: '请选择', options: [{ name: '大和' }, { name: '大和改' }] },
  maxChars: 100
});
eq(note3.includes('1. 大和'), true, '多选列表');
eq(note3.includes('需要用户选择'), true, '多选状态');
eq(clip('一二三四五六七八九十', 5).startsWith('一二三四五'), true, '截断生效');
eq(clip('短', 100), '短', '不超长不动');

console.log('— 工具返回文本 —');
const t = formatResultText({
  status: 'success',
  command: 'ship 大和',
  text: '伤害 120000',
  image: { bytes: 2 * 1024 * 1024, file: 'x.jpg', url: 'http://127.0.0.1:1/x', dataUrl: 'base64://AAAA', sent: true },
  sentInfo: { ok: true, via: '本地文件' }
}, { contextDataMaxChars: 500 });
eq(t.includes('伤害 120000'), true, '工具文本带数据');
eq(t.includes('已发给当前聊天'), true, '工具文本说明已发送');
const t2 = formatResultText({ status: 'failed', command: '大和', text: '未找到该玩家' }, {});
eq(t2.includes('未找到该玩家'), true, '失败文案透传');

console.log('— 图片暂存与服务 —');
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(64, 7)
]);
const saved = await saveImage(png, { mime: 'png', ttlSec: 60 });
eq(saved.mime, 'png', '魔数/提示识别为 png');
eq(saved.bytes, png.length, '字节数正确');
eq(typeof saved.file, 'string', '已落盘');
const base = await start({ host: '127.0.0.1', port: 32899, ttlSec: 60 });
eq(typeof base, 'string', '图片服务已启动');
attachUrl(saved.token, urlFor(saved.token));
const res = await fetch(urlFor(saved.token));
eq(res.status, 200, '按 URL 可取图');
eq(res.headers.get('content-type'), 'image/png', 'content-type 正确');
const bytes = Buffer.from(await res.arrayBuffer());
eq(bytes.equals(png), true, '取回的字节一致');
const bad = await fetch('http://127.0.0.1:32899/wows/nonexistenttoken0000');
eq(bad.status, 404, '未知 token → 404');
const root = await fetch('http://127.0.0.1:32899/');
eq(root.status, 404, '非白名单路径 → 404');
await stop();
console.log(`  · 图片暂存条数 ${getImage(saved.token) ? 1 : 0}`);
clearAll();

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
