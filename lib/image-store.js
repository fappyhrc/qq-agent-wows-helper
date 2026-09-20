// wows-helper · 渲染图暂存（内存 + 磁盘）
//
// 为什么两个都要留：
//   · 磁盘（file:/// + dataUrl 回退）：发送队列的 sendImage 优先把**本地路径**交给协议端
//     自己读盘 —— body 从几 MB 降到几百字节，是"图画出来了但发不出去"的正解。
//   · 内存（Buffer）：本地图片服务要按 token 把图吐给协议端/模型，重启后 key 就失效了。
//
// 容量与生命周期都由 TTL + 条数上限兜住：群里连发几十条 wws，不会把内存撑爆。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const EXT = { jpeg: 'jpg', jpg: 'jpg', png: 'png', webp: 'webp', gif: 'gif' };

/** token → { file, buffer, mime, bytes, at, tag } */
const store = new Map();

let dirReady = null;
let tempRoot = '';

function ensureDir() {
  if (dirReady) return dirReady;
  tempRoot = path.join(os.tmpdir(), 'qq-agent-wows-helper');
  dirReady = (async () => {
    await fs.promises.mkdir(tempRoot, { recursive: true });
    return tempRoot;
  })().catch((error) => {
    dirReady = null;              // 下次再来一次（临时目录偶尔会被清理）
    throw error;
  });
  return dirReady;
}

/** 删掉过期与超量的条目（含磁盘文件）。每次写入前调用，成本可忽略。 */
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

function removeFile(file) {
  if (!file) return;
  fs.promises.unlink(file).catch(() => { /* 已被清理/占用：忽略 */ });
}

function sniffMime(buffer, hinted) {
  const h = String(hinted || '').toLowerCase().replace('image/', '');
  if (h === 'jpg' || h === 'jpeg') return 'jpeg';
  if (EXT[h]) return h;
  // 魔数兜底：桥接把 Data_Type 写错时不至于把 jpg 当 png 发
  if (buffer.length > 3) {
    if (buffer[0] === 0xff && buffer[1] === 0xd8) return 'jpeg';
    if (buffer[0] === 0x89 && buffer[1] === 0x50) return 'png';
    if (buffer[0] === 0x47 && buffer[1] === 0x49) return 'gif';
    if (buffer.subarray(0, 4).toString('ascii') === 'RIFF') return 'webp';
  }
  return 'jpeg';
}

/**
 * 存一张渲染图。
 * @param {Buffer} buffer
 * @param {{mime?:string, tag?:string, ttlSec?:number, maxEntries?:number}} opts
 * @returns {Promise<{token:string, file:string|null, mime:string, bytes:number, url:string|null, dataUrl:string}>}
 */
export async function saveImage(buffer, opts = {}) {
  const bytes = Number(buffer?.length) || 0;
  if (!bytes) throw new Error('图片内容为空');
  prune(opts.ttlSec, opts.maxEntries);

  const mime = sniffMime(buffer, opts.mime);
  const token = `w${crypto.randomBytes(9).toString('hex')}${Date.now().toString(36)}`;

  let file = null;
  try {
    const dir = await ensureDir();
    file = path.join(dir, `${token}.${EXT[mime] || 'jpg'}`);
    await fs.promises.writeFile(file, buffer);
  } catch {
    file = null;   // 落盘失败不影响内存通道（dataUrl 仍可发）
  }

  const item = { token, file, buffer, mime, bytes, at: Date.now(), tag: String(opts.tag ?? '') };
  store.set(token, item);
  return {
    token,
    file,
    mime,
    bytes,
    url: null,                                  // 由 image-server 补上（未启用时为 null）
    dataUrl: `base64://${buffer.toString('base64')}`
  };
}

/** 给已存的图补上对外 URL（图片服务启动后调用）。 */
export function attachUrl(token, url) {
  const item = store.get(token);
  if (item) item.url = url;
  return item?.url ?? null;
}

export function getImage(token) {
  const item = store.get(String(token ?? ''));
  if (!item) return null;
  return item;
}

/** data: URI（给模型看图 / 不支持 file 通道时的回退）。 */
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
