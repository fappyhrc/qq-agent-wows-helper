// 端到端自检：用假的桥接服务 + 假的 api/ctx 真正跑一遍插件，
// 验证「钩子注入上下文」与「工具查询并自动发图」两条主链路。
// 不需要 Python，也不需要 QQ。
// 用法：node plugins/wows-helper/e2e-test.mjs
import http from 'node:http';
import { readFileSync } from 'node:fs';
import * as plugin from './index.js';

let pass = 0;
let fail = 0;
function check(cond, name, extra = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${extra}`); }
}

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(128, 3)]);

// ── 假桥接服务 ──────────────────────────────────────────────────────────────
const bridgeReqs = [];
const bridge = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const payload = body ? JSON.parse(body) : {};
    if (req.url === '/health') {
      // 探活不算"业务请求"：它由 activate() 与 available() 在后台发起，
      // 记进来会让"钩子没有发起网络请求"这类计数断言变得不确定。
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, ready: true, version: 'test' }));
      return;
    }
    bridgeReqs.push(payload);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (payload.command === '帮助' || payload.command === '') {
      res.end(JSON.stringify({ ok: true, status: 'success', text: 'wws 帮助：me / ship / recent ...', options: [] }));
      return;
    }
    if (payload.command === 'wait') {
      // ⚠️ 必须区别对待"首次查询"与"带序号的续查"：
      //    首次返回 status=wait + 待选项；带序号续查才返回 success + 渲染图。
      //    早期假桥接对 command=wait 一律返回 wait，于是"续查拿到图"这条路径
      //    **从来没有被测到** —— 而真实环境里正是这条路径丢了图。
      if (payload.select_index) {
        res.end(JSON.stringify({
          ok: true, status: 'success',
          text: `你选择的候选项：大和改\n玩家：老八\n胜率 51.2%  场次 300`,
          image_base64: PNG.toString('base64'), image_mime: 'image/png', data_type: 'png'
        }));
        return;
      }
      res.end(JSON.stringify({
        ok: true, status: 'wait', text: '请选择',
        options: [{ name: '大和' }, { name: '大和改' }],
        // ⚠️ 多选也要带图：上游会渲染一张"选择列表图"（select-ship-v6.html）。
        //    插件必须把它直接发出去，用户才知道要选什么。
        image_base64: PNG.toString('base64'), image_mime: 'image/png', data_type: 'png'
      }));
      return;
    }
    res.end(JSON.stringify({
      ok: true, status: 'success',
      text: '玩家：老八\n胜率 54.3%  场次 1200\n平均伤害 68000',
      image_base64: PNG.toString('base64'), image_mime: 'image/png', data_type: 'png'
    }));
  });
});
await new Promise((r) => bridge.listen(32905, '127.0.0.1', r));

// ── 假的 api / ctx ─────────────────────────────────────────────────────────
// 机器人自己：QQ 号 1、群昵称「机器人」。触发要求"@ 机器人 + wws"两个条件。
const BOT_QQ = '1';
const BOT_NICK = '机器人';
const ctxFields = { selfId: BOT_QQ, selfNickname: BOT_NICK, botName: BOT_NICK, kind: 'group', chatId: '12345', chatKey: 'group:12345' };

const settings = {
  triggerKeywords: ['wws', '@wws'],
  requireAt: true,
  bridgeUrl: 'http://127.0.0.1:32905',
  bridgeToken: '',
  yuyukoToken: 'ui:token',      // 用户在设置页填的凭据，应随每次查询下发
  bridgeToken: '',
  hookPrefetch: true,
  hookPrefetchTimeoutMs: 3600,
  requestTimeoutMs: 10000,
  autoSendImage: true,
  includeDataInContext: true,
  contextDataMaxChars: 1600,
  hookPrefetch: false,        // 默认就是关的（实测查询 5~13 秒，放不进 5 秒的钩子）
  serveImage: true,
  imageServerHost: '127.0.0.1',
  imageServerPort: 32906,
  imageTtlSec: 600,
  maxImageMB: 12,
  maxPending: 6,
  platform: 'QQ',
  botId: '0',
  imageType: 'png',
  debug: false
};

const tools = new Map();
const logs = [];
const api = {
  config: () => ({ ...settings }),
  registerTool: (def) => { tools.set(def.id, def); return def.id; },
  hasCapability: () => true,
  capability: () => undefined,
  isSkillActive: () => true,
  log: (...a) => logs.push(['log', ...a]),
  warn: (...a) => logs.push(['warn', ...a]),
  error: (...a) => logs.push(['error', ...a])
};

plugin.setup(api);
await plugin.activate();

console.log('— 注册结果 —');
check(tools.has('wows-query'), '注册了 wows-query 工具');
check(tools.has('wows-send-image'), '注册了 wows-send-image 工具');
check(typeof plugin.hooks['before-context'] === 'function', '导出了 before-context 钩子');
check(plugin.available().ok === true, 'available() 是同步的且乐观放行');
check(!(plugin.available() instanceof Promise), 'available() 没有返回 Promise');

console.log('— 钩子：认领（默认不预取，只交给工具）—');
const entry = { id: 1001, senderId: '1000000001', senderName: '老八', text: `@${BOT_NICK}(QQ:${BOT_QQ}) wws 大和` };
const entries = [entry];
await plugin.hooks['before-context']({
  triggerEntries: entries, store: {}, memory: {},
  chatKey: 'group:12345', ...ctxFields, chatName: '测试群'
});
check(entry.text.startsWith(`@${BOT_NICK}(QQ:${BOT_QQ}) wws 大和`), '原话保留在最前（不是替换）');
check(entry.text.includes('【yuyuko 指令已认领】'), '注入了认领块');
check(entry.text.includes('wows-helper__wows-query'), '把工具名交给模型');
check(entry.text.includes('command="大和"'), '把指令正文交给模型（不带 wws）');
check(entry.text.includes('QQ:1000000001'), '把发起人写清楚（工具 ctx 里没有这个信息）');
check(bridgeReqs.length === 0, '默认不预取 → 钩子不发起网络请求');

console.log('— 钩子：两个条件缺一不可 —');
const cases = [
  ['只有 wws、没 @', 'wws 大和', false],
  ['@ 了别人', '@老八(QQ:1000000001) wws 大和', false],
  ['@ 了机器人但没 wws', `@${BOT_NICK}(QQ:${BOT_QQ}) 大和`, false],
  ['触发词在句中', `@${BOT_NICK}(QQ:${BOT_QQ}) 我觉得 wws 不错`, false],
  ['两个条件都满足', `@${BOT_NICK}(QQ:${BOT_QQ}) wws 大和`, true]
];
for (const [name, text, shouldFire] of cases) {
  const e = { id: 90, senderId: '1000000001', senderName: '老八', text };
  const before = bridgeReqs.length;
  await plugin.hooks['before-context']({ triggerEntries: [e], chatKey: 'group:12345', ...ctxFields });
  const fired = e.text.includes('【yuyuko 指令已认领】');
  check(fired === shouldFire, `${name} → ${shouldFire ? '认领' : '不认领'}`, e.text.slice(0, 60));
  check(bridgeReqs.length === before, `${name} → 钩子没有发起网络请求`);
}

console.log('— 钩子：触发词 yuyuko（线上默认）也要认领，且后面的内容原样作指令 —');
// 用 plugin.json 里的**真实默认触发词**跑一遍，避免测试自己配一套而与线上漂移
const manifestKeywords = JSON.parse(readFileSync(new URL('./plugin.json', import.meta.url), 'utf8'))
  .settings.triggerKeywords;
settings.triggerKeywords = manifestKeywords;
check(manifestKeywords.includes('yuyuko'), 'plugin.json 默认触发词含 yuyuko', JSON.stringify(manifestKeywords));

const yCases = [
  [`@${BOT_NICK}(QQ:${BOT_QQ}) yuyuko ship 大和`, true, 'ship 大和'],
  [`@${BOT_NICK}(QQ:${BOT_QQ}) yuyuko ship 大和 recent 30`, true, 'ship 大和 recent 30'],
  [`@${BOT_NICK}(QQ:${BOT_QQ}) Yuyuko 大和`, true, '大和'],
  [`@${BOT_NICK}(QQ:${BOT_QQ}) yuyuko`, true, ''],
  ['yuyuko ship 大和', false, ''],                                  // 没 @ → 严格不认领
  ['@老八(QQ:1000000001) yuyuko ship 大和', false, ''],              // @ 的是别人
  [`@${BOT_NICK}(QQ:${BOT_QQ}) 用 yuyuko 查一下`, false, ''],         // 触发词在句中
];
for (const [text, shouldFire, wantCmd] of yCases) {
  const e = { id: 89, senderId: '1000000001', senderName: '老八', text };
  await plugin.hooks['before-context']({ triggerEntries: [e], chatKey: 'group:12345', ...ctxFields });
  const fired = e.text.includes('【yuyuko 指令已认领】');
  check(fired === shouldFire, `${text.slice(-24)} → ${shouldFire ? '认领' : '不认领'}`,
    e.text.slice(0, 80));
  if (shouldFire && wantCmd) {
    check(e.text.includes(`command="${wantCmd}"`),
      `yuyuko 之后的内容原样作指令：${JSON.stringify(wantCmd)}`, e.text.slice(0, 120));
  }
}
settings.triggerKeywords = ['wws', '@wws'];   // 还原，避免影响后续用例

console.log('— 机器人身份未知时的兜底学习 —');
// 模拟"钩子上下文里既没有 selfId 也没有昵称"的最坏情况（核心将来改字段也不至于全瘫）
const savedId = plugin.internals.selfInfo.id;
plugin.internals.selfInfo.id = '';
const blind = { id: 91, senderId: '1000000001', senderName: '老八', text: `@${BOT_NICK}(QQ:${BOT_QQ}) wws 大和` };
await plugin.hooks['before-context']({ triggerEntries: [blind], chatKey: 'group:12345', kind: 'group', chatId: '12345' });
check(plugin.internals.selfInfo.id === BOT_QQ, '从"触发词前的那个 @(QQ:n)"学到机器人 QQ', plugin.internals.selfInfo.id);
check(blind.text.includes('【yuyuko 指令已认领】'), '身份未知时仍能认领（同一批内完成学习）');
// 只有昵称、没有 QQ 后缀时不采信（避免把别人的昵称当成机器人名）
plugin.internals.selfInfo.id = '';
const nameOnly = { id: 92, senderId: '1000000001', senderName: '老八', text: '@某位路人 wws 大和' };
await plugin.hooks['before-context']({ triggerEntries: [nameOnly], chatKey: 'group:12345', kind: 'group', chatId: '12345' });
check(plugin.internals.selfInfo.id === '', '裸昵称不采信（防止把别人当机器人）', plugin.internals.selfInfo.id);
// 也不能把"@ 群友(QQ:n)"里的名字学成机器人昵称 —— 否则以后 @ 那个群友都会被误判
plugin.internals.selfInfo.id = '';
plugin.internals.selfInfo.nickname = '';
const otherPerson = { id: 93, senderId: '1000000001', senderName: '老八', text: '@群友甲(QQ:66666) wws 大和' };
await plugin.hooks['before-context']({ triggerEntries: [otherPerson], chatKey: 'group:12345', kind: 'group', chatId: '12345' });
check(plugin.internals.selfInfo.nickname !== '群友甲', '不把被 @ 的群友名字学成机器人昵称', plugin.internals.selfInfo.nickname || '(空)');
plugin.internals.selfInfo.id = savedId;

console.log('— 钩子：开启预取时才查（可选路径）—');
settings.hookPrefetch = true;
const beforePrefetch = bridgeReqs.length;
const prefetchEntry = { id: 1002, senderId: '1000000001', senderName: '老八', text: `@${BOT_NICK}(QQ:${BOT_QQ}) wws 大和` };
await plugin.hooks['before-context']({ triggerEntries: [prefetchEntry], chatKey: 'group:12345', ...ctxFields });
check(bridgeReqs.length === beforePrefetch + 1, '开启预取 → 钩子恰好查了一次', `before=${beforePrefetch} after=${bridgeReqs.length}`);
const preq = bridgeReqs.at(-1);
check(preq.command === '大和', '预取传的指令去掉了 wws 前缀');
check(preq.platform_id === '1000000001', '预取的 PlatformId = 触发者 QQ（不是群号）');
check(preq.group_id === '12345', '预取带上群号');
check(prefetchEntry.text.includes('【yuyuko 自动查询结果】'), '预取结果注入上下文');
check(prefetchEntry.text.includes('胜率 54.3%'), '预取数据进入上下文');
check(prefetchEntry.text.includes('渲染图已由插件自动发出'), '预取路径说明图片状态');
settings.hookPrefetch = false;

console.log('— 钩子：多选 + 序号续查（钩子只认领，真查询交给工具）—');
const waitEntry = { id: 3, senderId: '1000000001', senderName: '老八', text: `@${BOT_NICK}(QQ:${BOT_QQ}) wws wait` };
// 多选会话是在查询时挂起的 → 这里临时开预取，让钩子把选项挂上
settings.hookPrefetch = true;
await plugin.hooks['before-context']({ triggerEntries: [waitEntry], chatKey: 'group:12345', ...ctxFields });
settings.hookPrefetch = false;
check(waitEntry.text.includes('1. 大和'), '多选待选项进入上下文');
const bareSel = { id: 40, senderId: '1000000001', senderName: '老八', text: '2' };
await plugin.hooks['before-context']({ triggerEntries: [bareSel], chatKey: 'group:12345', ...ctxFields });
check(!bareSel.text.includes('【yuyuko 自动查询结果】'), '没 @ 的裸序号 → 不续查（避免群里"2"被误认）');

// ⚠️ 续查**不能**在钩子里查：钩子硬超时 5 秒，而一次渲染实测 5.5~10 秒。
//    早期版本在这里直接预取，结果续查永远只剩一条"续查失败"，数据和图全丢。
//    现在钩子只认领并指示模型调工具，与正常路径一致。
const reqsBeforeSel = bridgeReqs.length;
const selEntry = { id: 4, senderId: '1000000001', senderName: '老八', text: `@${BOT_NICK}(QQ:${BOT_QQ}) 2` };
await plugin.hooks['before-context']({ triggerEntries: [selEntry], chatKey: 'group:12345', ...ctxFields });
check(bridgeReqs.length === reqsBeforeSel, '钩子没有对桥接发任何查询请求（不再预取续查）',
  `新增 ${bridgeReqs.length - reqsBeforeSel} 条`);
check(selEntry.text.includes('【yuyuko 多选续查】'), '钩子注入了续查认领提示', selEntry.text);
check(selEntry.text.includes('selectIndex=2'), '提示里写明 selectIndex=2', selEntry.text);
check(selEntry.text.includes('wows-helper__wows-query'), '提示里指明该调哪个工具', selEntry.text);
check(selEntry.text.includes('大和改'), '提示里带上该序号对应的选项名', selEntry.text);
check(selEntry.text.includes('command="wait"'), '提示里带上原始 command（工具需要它才能找到挂起的会话）', selEntry.text);
// 认领后立刻清掉挂起会话：防止群友同一句"1"被重复认领。
// 真正的挂起对象在**桥接进程**的 PENDING 里（按 session_key 取），这里删掉的只是
// "还有没有待选会话"这个标记，不影响工具带着 selectIndex 去执行。
check(!plugin.internals.pending.has('group:12345#1000000001'),
  '认领后续查会话被清掉（避免重复认领）');

console.log('— 工具：查询并自动发图 —');
const sent = [];
// ⚠️ 首次查询**必须**带上 session_key：桥接只有拿到它才会把多选候选挂起，
//    否则用户回序号时桥接找不到会话，只能"再查一次"——群里表现就是
//    "回了序号又弹出选择列表、始终没有图"（实测事故，用户日志里 PENDING 是别人的键）。
const reqsBeforeTool = bridgeReqs.length;
// 注意 ctx 故意**不带 senderId**：真实运行环境里就是这样，
// 插件靠钩子记下的触发者来还原 PlatformId（这一条是关键行为，必须自检覆盖）。
const ctx = {
  ...ctxFields,
  session: { id: 's1', sent: [] },
  emit: () => {},
  sender: {
    sendImage: async (chatKey, img, options) => {
      sent.push({ chatKey, img, options });
      return { message_id: 999 };
    }
  }
};
const res = await tools.get('wows-query').execute(ctx, { command: 'ship 大和 recent 30' });
check(res.isError !== true, '工具执行成功', JSON.stringify(res).slice(0, 200));
check(String(res.content).includes('胜率 54.3%'), '工具文本带数据');
check(bridgeReqs.at(-1).platform_id === '1000000001', '工具路径用回了钩子记下的触发者（不是群号/机器人号）');
// 首次查询带 session_key，是"续查能找到挂起会话"的前提条件
check(typeof bridgeReqs.at(-1).session_key === 'string' && bridgeReqs.at(-1).session_key.includes('#'),
  '首次查询带回会话键（桥接据此挂起多选候选）', JSON.stringify(bridgeReqs.at(-1).session_key));
// 凭据随查询下发（用户在设置页填的那份）——这是"不会敲命令行"用户的唯一通路
check(bridgeReqs.at(-1).config?.hikari_token === 'ui:token', '设置页填的 yuyuko 凭据随查询下发', JSON.stringify(bridgeReqs.at(-1).config));
check(sent.length === 1, '自动发图被调用了一次');
check(sent[0].chatKey === 'group:12345', '发到当前会话');
check(typeof sent[0].img.file === 'string' && sent[0].img.file.endsWith('.png'), '首选本地文件通道');
check(typeof sent[0].img.dataUrl === 'string' && sent[0].img.dataUrl.startsWith('base64://'), '带 base64 回退备份');
check(ctx.session.sent.length === 1, '渲染图写进了会话留档');
// 图片记录里同时带本地图片服务 URL（发送队列 file 通道失败时的备选来源）
const lastImage = plugin.internals.lastResult.get('group:12345')?.image;
check(typeof lastImage?.url === 'string' && lastImage.url.startsWith('http://127.0.0.1:32906/wows/'), '图片记录带本地图片服务 URL', JSON.stringify(lastImage?.url));

console.log('— 工具：多选（wait）时必须把选择列表图直接发出去 —');
// 依据用户反馈：多选时插件只把选项拼成文字交给模型，图被丢掉 —— 群里看不到选项图，
// 模型也只是照文字复述，用户不知道该怎么选。现在 wait 分支必须自己把图发出去。
const sentBeforeWait = sent.length;
const resWait = await tools.get('wows-query').execute(ctx, { command: 'wait' });
check(String(resWait.content).includes('1. 大和'), '多选结果把待选项交给模型', String(resWait.content).slice(0, 200));
check(sent.length === sentBeforeWait + 1, '选择列表图被直接发到群里（用户反馈的缺失点）');
check(String(resWait.content).includes('选择列表图已由插件直接发出')
  || String(resWait.content).includes('选择列表图已生成但发送失败'),
  '明确告知模型"图已发出"（避免它重复发图）', String(resWait.content).slice(0, 260));
check(String(resWait.content).includes('@机器人'), '提示模型让群友 @机器人 后回序号', String(resWait.content).slice(0, 260));

console.log('— 工具：序号续查（钩子认领之后，真查询走这里）—');// 承接上面钩子挂起的会话：验证工具确实把 selectIndex 与 session_key 下发给桥接了。
const sentBeforeSel = sent.length;
const resSel = await tools.get('wows-query').execute(ctx, { command: 'wait', selectIndex: 2 });
check(resSel.isError !== true, '续查走工具执行成功', JSON.stringify(resSel).slice(0, 200));
const reqSelTool = bridgeReqs.at(-1);
check(reqSelTool.select_index === 2, '续查把序号 2 下发给了桥接', JSON.stringify(reqSelTool.select_index));
check(reqSelTool.session_key === 'group:12345#1000000001', '续查带上了会话键', JSON.stringify(reqSelTool.session_key));
check(sent.length === sentBeforeSel + 1, '续查结果里的渲染图被自动发出（这正是原先丢图的地方）');
// 序号越界必须被工具自己的校验拦下（不能透传给桥接换回一句难懂的报错）
const resBadSel = await tools.get('wows-query').execute(ctx, { command: 'wait', selectIndex: 99 });
check(resBadSel.isError === true, 'selectIndex 越界被校验拦下', String(resBadSel.content));

console.log('— 工具：发送结果确实可被协议端取到 —');
const imgRes = await fetch(lastImage.url);
check(imgRes.status === 200, '本地图片服务能按 URL 取图');
check(Buffer.from(await imgRes.arrayBuffer()).equals(PNG), '取回的字节与渲染结果一致');

console.log('— 凭据：留空时不下发该字段（桥接回落到自己的 --token）—');
settings.yuyukoToken = '';
const keep = sent.length;
await tools.get('wows-query').execute(ctx, { command: '大和' });
check(bridgeReqs.at(-1).config?.hikari_token === undefined, '留空 → 请求里没有 hikari_token');
check(bridgeReqs.at(-1).config?.image_type === 'png', '其他运行时配置不受影响', JSON.stringify(bridgeReqs.at(-1).config));
check(sent.length === keep + 1, '留空仍能正常查询并发图');
settings.yuyukoToken = 'ui:token';

console.log('— 工具：显式发图与参数校验 —');
const res2 = await tools.get('wows-send-image').execute(ctx, {});
check(res2.isError !== true && String(res2.content).includes('已发出'), '显式发图走通', String(res2.content));
const res3 = await tools.get('wows-query').execute(ctx, { command: '' });
check(res3.isError === true, '空 command 被校验拦下');

console.log('— 桥接不可达时的降级 —');
settings.bridgeUrl = 'http://127.0.0.1:32999';
const bad = await tools.get('wows-query').execute(ctx, { command: '大和' });
check(String(bad.content).includes('没启动') || String(bad.content).includes('失败'), '给出可读的不可达提示', String(bad.content));
settings.bridgeUrl = 'http://127.0.0.1:32905';

await plugin.deactivate();
bridge.close();
console.log(`\n结果：${pass} 通过，${fail} 失败`);
if (fail) { console.log('日志：', logs.slice(-5)); }
process.exit(fail ? 1 : 0);
