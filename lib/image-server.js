// wows-helper · 本地只读图片服务
//
// 存在的唯一理由：**渲染图必须能被"别人"按 URL 取到**。
//   · 发送队列（ctx.sender.sendImage）优先走 file:/// 让协议端读本地磁盘，但那是回退链的
//     第一级，协议端不在本机时会失败；
//   · 模型侧的 send_image 工具只认 http(s) 直链（本地路径被明确拒绝）；
//   · 数据都要经过"限频 → 去重 → 留档"的发送管道，而管道里传的是 URL/路径。
// 所以这里挂一个只读、带随机 token、只在 127.0.0.1 上监听的极简服务。
//
// 安全边界（写清楚，免得日后被当成"又一个本地端口"）：
//   1. 只认 GET，只认 /wows/<token> 这一条路径，其它一律 404；
//   2. token 是 24 字符随机串，无法枚举；TTL 到期即 404 并删文件；
//   3. 响应只有图片字节，没有任何目录列举、没有任何写入接口；
//   4. 默认绑定 127.0.0.1 —— 想跨机给协议端取图，用户必须显式改成 0.0.0.0。
import http from 'node:http';
import { getImage } from './image-store.js';

let server = null;
let bound = null;            // { host, port }
let baseUrl = '';
let log = () => {};

export function setLog(fn) {
  log = typeof fn === 'function' ? fn : () => {};
}

export function currentBaseUrl() {
  return baseUrl;
}

export function currentBound() {
  return bound;
}

/**
 * 启动（或按新配置重启）图片服务。
 * @returns {Promise<string|null>} 成功时的根地址，失败返回 null（调用方退回 file/data 通道）
 */
export async function start({ host = '127.0.0.1', port = 32801, ttlSec = 600 } = {}) {
  if (server && bound && bound.host === host && bound.port === port) return baseUrl;
  await stop();

  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      try {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('method not allowed');
          return;
        }
        // 去掉 query，避免 token 后面被挂上 ?v=1 之类导致取不到
        const pathname = String(req.url || '').split('?')[0];
        const m = pathname.match(/^\/wows\/([A-Za-z0-9_-]{8,64})$/);
        if (!m) {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('not found');
          return;
        }
        const item = getImage(m[1]);
        if (!item) {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('expired');
          return;
        }
        res.writeHead(200, {
          'Content-Type': `image/${item.mime}`,
          'Content-Length': item.buffer.length,
          // 同一个 token 的内容不可变：让协议端/模型可以直接命中缓存
          'Cache-Control': `private, max-age=${Math.max(30, Number(ttlSec) || 600)}`,
          'Access-Control-Allow-Origin': '*'
        });
        if (req.method === 'HEAD') res.end();
        else res.end(item.buffer);
      } catch (error) {
        try {
          res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('internal error');
        } catch { /* 头已发出，忽略 */ }
        log(`图片服务处理失败：${error?.message ?? error}`);
      }
    });

    srv.on('error', (error) => {
      log(`图片服务启动失败（${host}:${port}）：${error?.message ?? error} —— 已退回 file/base64 通道`);
      server = null;
      bound = null;
      baseUrl = '';
      resolve(null);
    });

    srv.listen(port, host, () => {
      server = srv;
      bound = { host, port };
      baseUrl = `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}`;
      log(`图片服务已就绪：${baseUrl}/wows/<token>`);
      resolve(baseUrl);
    });
  });
}

export function stop() {
  return new Promise((resolve) => {
    const srv = server;
    server = null;
    bound = null;
    baseUrl = '';
    if (!srv) { resolve(); return; }
    try { srv.close(() => resolve()); } catch { resolve(); }
    // close() 对 keep-alive 连接会等；给个上限，别卡住热重载
    setTimeout(resolve, 500);
  });
}

/** 把 token 拼成对外 URL（服务没起来时返回 null）。 */
export function urlFor(token) {
  if (!baseUrl || !token) return null;
  return `${baseUrl}/wows/${token}`;
}
