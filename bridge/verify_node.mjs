// 用**真实桥接服务 + Node fetch**（与插件同一条通路）逐个核验：
//   ① 不带命令行凭据、只靠请求下发（= 用户在 QQ Agent 设置页填的那条路）
//   ② 同一份凭据重复查询（浏览器的复用）
//   ③ --ignore-list 禁用的指令被拒  ④ 未被禁的照常
// 用法（不传命令行凭据，凭据走请求，更贴近真实使用）：
//   node bridge/verify_node.mjs <port> "<账号ID:Token>" <python 解释器路径>
// 注意：本脚本 spawn 子进程用的是 stdio:inherit —— 受限沙箱里管道 stdio 会 EPERM。
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.argv[2] || 32930);
const TOKEN = process.argv[3] || '';
const PY = process.argv[4] || 'python';
const PLATFORM_ID = '1000000001';

const args = [path.join(here, 'hikari_bridge.py'), '--port', String(PORT),
  '--ignore-list', 'set_BindInfo,change_BindInfo,delete_BindInfo'];
if (TOKEN) args.push('--token', TOKEN);

// ⚠️ stdio 用 inherit 而不是 pipe：受限沙箱里 Node 以管道方式拉子进程会 EPERM
//    （DSH 文档记载的边界：管道 stdio 需要命名管道）。日志直接打到控制台。
const child = spawn(PY, args, { stdio: 'inherit' });

const base = `http://127.0.0.1:${PORT}`;
const fails = [];
const t0 = Date.now();

async function call(pathname, payload, timeoutMs = 180000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  const started = Date.now();
  try {
    const res = await fetch(base + pathname, {
      method: payload ? 'POST' : 'GET',
      headers: { 'Content-Type': 'application/json' },
      body: payload ? JSON.stringify(payload) : undefined,
      signal: ac.signal
    });
    const data = await res.json();
    return { data, ms: Date.now() - started, http: res.status };
  } finally {
    clearTimeout(timer);
  }
}

function kb(b64) { return b64 ? `${Math.round(Buffer.from(b64, 'base64').length / 1024)}KB` : 'none'; }

try {
  // 等服务就绪
  let health = null;
  for (let i = 0; i < 120; i++) {
    try { health = (await call('/health', null, 3000)).data; break; } catch { await new Promise((r) => setTimeout(r, 500)); }
  }
  if (!health) { console.log('FAIL 桥接服务未启动'); throw new Error('no health'); }
  console.log('[health]', JSON.stringify({ ready: health.ready, version: health.version, token_configured: health.token_configured, ignored_functions: health.ignored_functions }, null, 0));
  if (health.ready !== true) fails.push('ready 应为 true（hikari-core 没装好？）');
  if (TOKEN && health.token_configured !== true) fails.push('token_configured 应为 true');
  if (JSON.stringify(health.ignored_functions) !== JSON.stringify(['set_BindInfo', 'change_BindInfo', 'delete_BindInfo'])) {
    fails.push(`ignored_functions 不符：${JSON.stringify(health.ignored_functions)}`);
  }

  const q = (command, config = {}) => ({ command, platform: 'QQ', platform_id: PLATFORM_ID, bot_id: '0', group_id: null, config });

  // ① 不带任何命令行凭据 + 请求里下发凭据（= 用户在 QQ Agent 设置页填的那条路）
  const r1 = await call('/query', q('me', TOKEN ? { hikari_token: TOKEN } : {}));
  console.log(`[1 me via plugin token]  status=${r1.data.status} source=${r1.data.token_source} image=${kb(r1.data.image_base64)} ${r1.ms}ms`);
  if (r1.data.status !== 'success' || !r1.data.image_base64) fails.push(`me（插件下发凭据）失败：${r1.data.text}`);
  if (TOKEN && r1.data.token_source !== 'plugin') fails.push(`请求带凭据时 token_source 应为 plugin，实际 ${r1.data.token_source}`);

  // ② 同一份凭据第二次查询（验证可重复、浏览器复用）
  const r2 = await call('/query', q('me', TOKEN ? { hikari_token: TOKEN } : {}));
  console.log(`[2 me 再来一次        ]  status=${r2.data.status} source=${r2.data.token_source} image=${kb(r2.data.image_base64)} ${r2.ms}ms`);
  if (r2.data.status !== 'success') fails.push(`第二次 me 失败：${r2.data.text}`);

  // ③ 被禁用的写操作
  const r3 = await call('/query', q('delete_bind 1'));
  console.log(`[3 delete_bind(禁用)   ]  status=${r3.data.status} text=${String(r3.data.text).slice(0, 30)}`);
  if (r3.data.status !== 'error' || !String(r3.data.text).includes('禁用')) {
    fails.push(`delete_bind 应被拒：${r3.data.status} ${r3.data.text}`);
  }

  // ④ 未被禁的照常
  const r4 = await call('/query', q('bind_list me'));
  console.log(`[4 bind_list(未禁)     ]  status=${r4.data.status} image=${kb(r4.data.image_base64)} ${r4.ms}ms`);
  if (r4.data.status !== 'success') fails.push(`bind_list 不该被禁：${r4.data.text}`);
} catch (error) {
  fails.push(`执行异常：${error?.message ?? error}`);
} finally {
  child.kill();
}

console.log(`\n总耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
if (fails.length) {
  console.log('失败：');
  fails.forEach((f) => console.log('  -', f));
  process.exit(1);
}
console.log('真实通路核验通过：入参 / 凭据下发 / Ignore_List 均按预期');
