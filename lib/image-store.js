/**
 * yuyuko-helper · 渲染图暂存（内存 + 磁盘双份）
 * ==========================================
 *
 * 为什么两种介质都要保留：
 *
 * * **磁盘**（供 `file:///` 与 base64 回退使用）
 *   发送队列的 `sendImage` 优先把**本地路径**交给协议端自行读盘：HTTP body 从数 MB
 *   降到几百字节，这是"图画出来了却发不出去"的正解（base64 内联容易撞上协议端超时）。
 * * **内存**（`Buffer`）
 *   本地图片服务要按 token 把图吐给协议端/模型，必须能在进程内直接取字节。
 *
 * 生命周期由 TTL + 条数上限共同约束（`prune`）：群里连发数十条 yuyuko 也不会撑爆内存，
 * 进程退出后残留的临时文件也会在下次写入时被清理。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

/** mime 后缀 → 文件扩展名（磁盘文件名用）。 */
const EXT = { jpeg: 'jpg', jpg: 'jpg', png: 'png', webp: 'webp', gif: 'gif' };

/** 唯一存储：`token → { token, file, buffer, mime, bytes, at, tag, url? }`。 */
const store = new Map();

/** 临时目录的就绪 Promise（惰性创建，失败后可重试）。 */
let dirReady = null;
let tempRoot = '';

/**
 * 惰性创建并缓存临时目录（`<系统临时目录>/qq-agent-yuyuko-helper`）。
 *
 * @returns {Promise<string>} 目录绝对路径。
 * @remarks 失败时清空缓存以便下次重试 —— 系统临时目录偶尔会被外部清理工具删除。
 */
function ensureDir() {
  if (dirReady) return dirReady;
  tempRoot = path.join(os.tmpdir(), 'qq-agent-yuyuko-helper');
  dirReady = (async () => {
    await fs.promises.mkdir(tempRoot, { recursive: true });
    return tempRoot;
  })().catch((error) => {
    dirReady = null;
    throw error;
  });
  return dirReady;
}

/**
 * 清理过期与超量条目（同时删除对应的磁盘文件）。
 *
 * @param {number} [ttlSec=600] 保留秒数（下限 30，防止配置成 0 导致图片立刻消失）。
 * @param {number} [maxEntries=40] 条数上限，超出时按最旧优先淘汰。
 * @returns {void}
 * @remarks 每次写入前调用一次：条数很少，成本可忽略；由它统一保证内存与磁盘不增长。
 */
export function prune(ttlSec = 600, maxEntries = 40) {
  const now = Date.now();
  const ttl = Math.max(30, Number(ttlSec) || 600) * 1000;
  for (const [token, item] of store) {
    if (now - item.at > ttl) {
      store.delete(token);
      removeFile(item.file);
    }
  }
  if (store.size <= maxEntries) return;
  // 超量时按最旧先删
  const ordered = [...store.entries()].sort((a, b) => a[1].at - b[1].at);
  while (ordered.length && store.size > maxEntries) {
    const [token, item] = ordered.shift();
    if (!store.has(token)) continue;
    store.delete(token);
    removeFile(item.file);
  }
}

/** 尽力删除磁盘文件；失败静默（文件已被外部清理或仍被占用都属正常）。 */
function removeFile(file) {
  if (!file) return;
  fs.promises.unlink(file).catch(() => { /* 已被清理/占用：忽略 */ });
}

/**
 * 判定图片 mime：优先采信调用方给的提示，再用魔数兜底。
 *
 * @param {Buffer} buffer 图片字节。
 * @param {string} [hinted] mime 或格式名（如 `image/png`、`jpeg`）。
 * @returns {'jpeg'|'png'|'gif'|'webp'} 归一化后的格式名（无法判定时按 jpeg）。
 * @remarks 魔数兜底不可省：桥接的 `Data_Type` 由上游给出，格式写错时若照抄，
 * 会把 jpg 当成 png 发给协议端。
 */
function sniffMime(buffer, hinted) {
  const h = String(hinted || '').toLowerCase().replace('image/', '');
  if (h === 'jpg' || h === 'jpeg') return 'jpeg';
  if (EXT[h]) return h;
  if (buffer.length > 3) {
    if (buffer[0] === 0xff && buffer[1] === 0xd8) return 'jpeg';
    if (buffer[0] === 0x89 && buffer[1] === 0x50) return 'png';
    if (buffer[0] === 0x47 && buffer[1] === 0x49) return 'gif';
    if (buffer.subarray(0, 4).toString('ascii') === 'RIFF') return 'webp';
  }
  return 'jpeg';
}

/**
 * 暂存一张渲染图，返回可供发送的三种引用。
 *
 * @param {Buffer} buffer 图片字节。
 * @param {{mime?: string, tag?: string, ttlSec?: number, maxEntries?: number}} [opts]
 *   `tag` 仅用于排查（例如原始指令），不参与业务判断。
 * @returns {Promise<{token: string, file: string|null, mime: string, bytes: number, url: null, dataUrl: string}>}
 *   `file` 为落盘路径（落盘失败为 `null`）；`dataUrl` 为 `base64://` 前缀形式，
 *   可直接交给 `ctx.sender.sendImage`；`url` 由图片服务启动后经 `attachUrl` 补。
 * @throws {Error} 图片内容为空时抛出（调用方已保证非空，属防御性判断）。
 * @side effect 写入内存表与临时目录（落盘失败仅降级，不影响内存通道）。
 */
export async function saveImage(buffer, opts = {}) {
  const bytes = Number(buffer?.length) || 0;
  if (!bytes) throw new Error('图片内容为空');
  prune(opts.ttlSec, opts.maxEntries);

  const mime = sniffMime(buffer, opts.mime);
  // token 同时充当"不可枚举的访问凭据"（图片服务的 URL 路径）与内存表键
  const token = `w${crypto.randomBytes(9).toString('hex')}${Date.now().toString(36)}`;

  let file = null;
  try {
    const dir = await ensureDir();
    file = path.join(dir, `${token}.${EXT[mime] || 'jpg'}`);
    await fs.promises.writeFile(file, buffer);
  } catch {
    file = null;   // 落盘失败不影响内存通道：dataUrl 仍然可发
  }

  const item = { token, file, buffer, mime, bytes, at: Date.now(), tag: String(opts.tag ?? '') };
  store.set(token, item);
  return {
    token,
    file,
    mime,
    bytes,
    url: null,                                  // 由 image-server 经 attachUrl 补上
    dataUrl: `base64://${buffer.toString('base64')}`
  };
}

/**
 * 给已暂存的图片补上对外 URL（图片服务就绪后调用）。
 *
 * @param {string} token 图片令牌。
 * @param {string} url 可被协议端/模型访问的地址。
 * @returns {string|null} 写入后的 URL；令牌不存在时返回 `null`。
 */
export function attachUrl(token, url) {
  const item = store.get(token);
  if (item) item.url = url;
  return item?.url ?? null;
}

/**
 * 按令牌取出图片记录。
 *
 * @param {string} token 图片令牌。
 * @returns {object|null} 记录对象（含 `buffer` / `file` / `mime`），不存在时 `null`。
 */
export function getImage(token) {
  const item = store.get(String(token ?? ''));
  if (!item) return null;
  return item;
}

/**
 * 转为 `data:` URI（供需要内联图片的场景，如给模型看图）。
 *
 * @param {object} item `saveImage` 返回或 `getImage` 取出的记录。
 * @returns {string} `data:image/...;base64,...`；无内容时返回空串。
 */
export function toDataUrl(item) {
  if (!item?.buffer) return '';
  return `data:image/${item.mime};base64,${item.buffer.toString('base64')}`;
}

/** 清理全部（热重载 / 插件关闭时调用，避免留下孤儿文件）。 */
export function clearAll() {
  for (const [, item] of store) removeFile(item.file);
  store.clear();
}

export function size() {
  return store.size;
}

export function tempDir() {
  return tempRoot;
}
