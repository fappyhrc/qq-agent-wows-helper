// 桥接服务 HTTP 契约测试：用 Node 起一个假的 hikari_bridge.py（同样的响应结构），
// 验证插件侧的 bridge.js 能正确解析 success / wait / failed / error / 超时 / 口令 六种情况。
// 用法：node plugins/wows-helper/bridge/client-test.mjs
import http from 'node:http';
import { bridgeQuery, bridgePing, friendlyBridgeError } from '../lib/bridge.js';
import { buildContextNote } from '../lib/format.js';

let pass = 0;
let fail = 0;
function check(cond, name, extra = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${extra}`); }
}

const seen = [];
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const payload = body ? JSON.parse(body) : {};
    seen.push({ url: req.url, headers: req.headers, payload });

    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, ready: true, version: '1.2.5' }));
      return;
    }
    if (req.url === '/slow/query') {
      setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, status: 'success', text: '太慢了' }));
      }, 1500);
      return;
    }
    if (req.headers['x-hikari-token'] === 'bad') {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'unauthorized', hint: '访问口令不一致' }));
      return;
    }
    if (payload.command === 'boom') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, status: 'error', text: '桥接服务内部错误：RuntimeError', options: [] }));
      return;
    }
    if (payload.command === 'wait') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ok: true, status: 'wait', text: '请选择要查询的舰船', options: [{ name: '大和' }, { name: '大和改' }],
        image_base64: null, data_type: 'list'
      }));
      return;
    }
    if (payload.command === 'fail') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, status: 'failed', text: '未找到该玩家', options: [] }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true, status: 'success', text: '胜率 54.3% 场次 1200',
      image_base64: Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64'),
      image_mime: 'image/png', data_type: 'png'
    }));
  });
});

await new Promise((r) => server.listen(32901, '127.0.0.1', r));
const url = 'http://127.0.0.1:32901';

console.log('— 探活 —');
const ping = await bridgePing({ url });
check(ping.ok === true && ping.ready === true, 'health 解析成功');

console.log('— 请求体契约 —');
const okRes = await bridgeQuery({
  url, token: 'good', command: 'ship 大和 recent 30', platform: 'QQ_CHANNEL', platformId: '1000000001',
  botId: '0', groupId: '12345', runtime: { imageType: 'webp', useBrowser: 'firefox', http2: false, gamePath: 'D:/data' },
  timeoutMs: 5000
});
check(okRes.status === 'success', 'success 透传');
check(okRes.text.includes('胜率 54.3%'), '文本透传');
const sent = seen.at(-1);
check(sent.payload.command === 'ship 大和 recent 30', 'command 原样透传');
check(sent.payload.platform === 'QQ_CHANNEL', 'platform 透传');
check(sent.payload.platform_id === '1000000001', 'platform_id 透传');
check(sent.payload.group_id === '12345', 'group_id 转字符串');
check(sent.payload.config.image_type === 'webp', 'image_type 映射到 config.image_type');
check(sent.payload.config.use_browser === 'firefox', '浏览器映射');
check(sent.payload.config.game_path === 'D:/data', 'game_path 映射');
check(sent.headers['x-hikari-token'] === 'good', '口令走 X-Hikari-Token 头');
check(sent.payload.session_key == null, '未传 session_key 时字段为 null');
await bridgeQuery({
  url, command: '大和', platform: 'QQ', platformId: '1000000001', sessionKey: 'group:1#1000000001', timeoutMs: 5000
});
check(seen.at(-1).payload.session_key === 'group:1#1000000001',
  '新查询也带 sessionKey（桥接据此清理同会话的旧挂起项）');

console.log('— 多选 / 失败 / 内部错误 —');
const waitRes = await bridgeQuery({ url, command: 'wait', platform: 'QQ', platformId: '1', timeoutMs: 5000 });
check(waitRes.status === 'wait', 'wait 状态透传');
check(waitRes.options.length === 2, '待选项透传');
const waitNote = buildContextNote({ command: 'single 大和', data: waitRes, autoSendImage: true, maxChars: 500 });
check(waitNote.includes('1. 大和') && waitNote.includes('需要用户选择'), 'wait 能生成可用的上下文块', waitNote);
// requireAt 默认开启时，提示必须写明两件事：
//   ① 让群友 **@机器人** 后回序号（否则他回裸数字认不上）；
//   ② 选择列表图已由插件直接发出，模型不要再发一次。
check(waitNote.includes('@机器人'), '提示写明了回复方式（带 @）', waitNote);
check(waitNote.includes('选择列表图') && waitNote.includes('直接发'),
  '提示说明选择列表图已发出（避免模型重复发图）', waitNote);
const failRes = await bridgeQuery({ url, command: 'fail', platform: 'QQ', platformId: '1', timeoutMs: 5000 });
check(failRes.status === 'failed', 'failed 透传');
check(failRes.text === '未找到该玩家', '失败文案透传');
const errRes = await bridgeQuery({ url, command: 'boom', platform: 'QQ', platformId: '1', timeoutMs: 5000 });
check(errRes.status === 'error', 'error 透传');

console.log('— 续查参数 —');
await bridgeQuery({ url, command: '大和', platform: 'QQ', platformId: '77', selectIndex: 2, sessionKey: 'group:1#77', timeoutMs: 5000 });
const sel = seen.at(-1).payload;
check(sel.select_index === 2, 'select_index 透传');
check(sel.session_key === 'group:1#77', 'session_key 透传');

console.log('— 错误路径 —');
try {
  await bridgeQuery({ url, token: 'bad', command: 'x', platform: 'QQ', platformId: '1', timeoutMs: 5000 });
  check(false, '口令错误应当抛错');
} catch (error) {
  check(error.kind === 'http' && error.status === 401, '口令错误 → http 错误');
  check(error.message.includes('口令'), '带出服务端 hint', error.message);
}
try {
  await bridgeQuery({ url: 'http://127.0.0.1:32999', command: 'x', platform: 'QQ', platformId: '1', timeoutMs: 1200 });
  check(false, '不可达应当抛错');
} catch (error) {
  check(error.kind === 'offline', '不可达 → offline');
  check(friendlyBridgeError(error).includes('没启动'), '给出可读提示');
}
try {
  // 注意：bridgeQuery 一律请求 <base>/query，所以这里要把 /slow 当成"基地址"来用
  await bridgeQuery({ url: `${url}/slow`, command: 'slow', platform: 'QQ', platformId: '1', timeoutMs: 400 });
  check(false, '超时应当抛错');
} catch (error) {
  check(error.kind === 'timeout', '超时 → timeout');
  check(friendlyBridgeError(error).includes('超时'), '超时提示可读');
}

server.close();
console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
