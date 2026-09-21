/**
 * yuyuko-helper · 本地只读图片服务
 * ==============================
 *
 * 存在的唯一理由：**渲染图必须能被"别人"按 URL 取到**。
 *
 * * 发送队列（`ctx.sender.sendImage`）优先走 `file:///` 让协议端读本地磁盘，
 *   但那是回退链的第一级 —— 协议端不在本机时会失败；
 * * 核心的 `send_image` 工具只接受 `http(s)` 直链，本地路径被明确拒绝；
 * * 所有发送都要经过"限频 → 去重 → 留档"的管道，而管道接收的是 URL 或路径。
 *
 * 因此这里挂一个只读、带随机 token、默认仅监听回环地址的极简服务。
 *
 * 安全边界（明确记录，避免日后被当作"又一个随手开的本地端口"）：
 *
 * 1. 只接受 `GET`/`HEAD`，只匹配 `/wows/<token>` 一条路径，其余一律 404；
 * 2. token 为 22 字符以上随机串，不可枚举；过期即 404 并删除文件；
 * 3. 响应体只有图片字节 —— 无目录列举、无写入接口、无任何动态行为；
 * 4. 默认绑定 `127.0.0.1`；只有用户显式改为 `0.0.0.0` 才可能被外部访问。
 */
import http from 'node:http';
import { getImage } from './image-store.js';

/** 当前监听的服务器实例；未启动时为 `null`。 */
let server = null;
/** 已绑定的地址与端口 `{ host, port }`；未启动时为 `null`。 */
let bound = null;
/** 对外根地址，如 `http://127.0.0.1:32801`；未启动时为空串。 */
let baseUrl = '';
/** 日志出口，由 `setLog` 注入。 */
let log = () => {};

/**
 * 注入日志出口（插件在 `setup` 阶段调用一次）。
 * @param {(msg: string) => void} fn
 * @returns {void}
 */
export function setLog(fn) {
  log = typeof fn === 'function' ? fn : () => {};
}

/**
 * 当前对外根地址。
 * @returns {string} 如 `http://127.0.0.1:32801`；未启动时为空串。
 */
export function currentBaseUrl() {
  return baseUrl;
}

/**
 * 当前实际绑定的地址与端口。
 * @returns {{host: string, port: number}|null} 未启动时 `null`。
 */
export function currentBound() {
  return bound;
}

/**
 * 启动（或按新配置重启）图片服务。
 *
 * @param {{host?: string, port?: number, ttlSec?: number}} [opts]
 *   `host` 默认 `127.0.0.1`；仅当协议端在别的机器上时才需改为 `0.0.0.0`。
 * @returns {Promise<string|null>} 成功时返回根地址（如 `http://127.0.0.1:32801`）；
 *   端口被占用等失败情况返回 `null`，**不抛错** —— 调用方据此退回 file/base64 通道，
 *   使"图片服务起不来"不至于让整个功能失效。
 * @side effect 建立监听；若已有实例且地址/端口不同，会先停掉旧实例。
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
        // 丢弃 query：token 后面可能被挂上 ?v=1 之类的缓存参数，不应影响取图
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
          // 同一 token 的内容不可变，允许长缓存：协议端/模型可据此避免重复下载
          'Cache-Control': `private, max-age=${Math.max(30, Number(ttlSec) || 600)}`,
          'Access-Control-Allow-Origin': '*'
        });
        if (req.method === 'HEAD') res.end();
        else res.end(item.buffer);
      } catch (error) {
        try {
          res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('internal error');
        } catch { /* 响应头已发出，无法再改状态码 */ }
        log(`图片服务处理失败：${error?.message ?? error}`);
      }
    });

    srv.on('error', (error) => {
      // 最常见的失败是端口被占用：降级而非中断，功能仍可用（走 file/base64 通道）
      log(`图片服务启动失败（${host}:${port}）：${error?.message ?? error} —— 已退回 file/base64 通道`);
      server = null;
      bound = null;
      baseUrl = '';
      resolve(null);
    });

    srv.listen(port, host, () => {
      server = srv;
      bound = { host, port };
      // 绑 0.0.0.0 时对外给出的地址仍用回环地址：URL 是给本机的插件/协议端用的
      baseUrl = `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}`;
      log(`图片服务已就绪：${baseUrl}/wows/<token>`);
      resolve(baseUrl);
    });
  });
}

/**
 * 停止图片服务并清空状态。可重复调用（未启动时直接 resolve）。
 *
 * @returns {Promise<void>}
 * @remarks 对 keep-alive 连接 `close()` 会等待，因此这里设了 500ms 上限 ——
 * 热重载时不能因为一个挂着的连接把禁用流程卡住。
 */
export function stop() {
  return new Promise((resolve) => {
    const srv = server;
    server = null;
    bound = null;
    baseUrl = '';
    if (!srv) { resolve(); return; }
    try { srv.close(() => resolve()); } catch { resolve(); }
    setTimeout(resolve, 500);
  });
}

/**
 * 把图片令牌拼成对外可访问的 URL。
 *
 * @param {string} token `saveImage` 返回的令牌。
 * @returns {string|null} 完整 URL；服务未启动或令牌为空时返回 `null`
 *   （调用方据此退回 `file:///` 或 base64 通道）。
 */
export function urlFor(token) {
  if (!baseUrl || !token) return null;
  return `${baseUrl}/wows/${token}`;
}
