// 用 GitHub API 创建仓库（幂等：已存在则直接返回，不报错）
//
// 用途：首次发布本插件时建一个私有仓库。之后不需要再用。
//   set GH_API_TOKEN=<你的 token>
//   node bridge/create-repo.mjs fappyhrc/qq-agent-yuyuko-helper          # 私有（默认）
//   node bridge/create-repo.mjs fappyhrc/qq-agent-yuyuko-helper --public # 公开
//
// token 只从环境变量读取：不落盘、不打印、不进日志。
// token 至少需要 repo 权限（细粒度 token 请勾 "Administration: Read and write"）。
const [full, ...flags] = process.argv.slice(2);
const isPublic = flags.includes('--public');
const token = process.env.GH_API_TOKEN || '';
if (!full || !token) {
  console.error('用法: set GH_API_TOKEN=... && node bridge/create-repo.mjs <owner/repo> [--public]');
  process.exit(2);
}
const [owner, name] = full.split('/');

const call = async (url, init = {}) => {
  const headers = {
    'User-Agent': 'yuyuko-helper-setup',
    Accept: 'application/vnd.github+json',
    // 认证头由下面拼装：值来自环境变量
    ...(init.headers || {})
  };
  headers.Authorization = 'Bearer ' + token;
  const res = await fetch(url, { ...init, headers });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* 非 JSON 响应 */ }
  return { status: res.status, json, text };
};

(async () => {
  const existed = await call(`https://api.github.com/repos/${owner}/${name}`);
  if (existed.status === 200) {
    // 仓库已存在：若带了 --public 而当前是私有，就顺手改成公开（幂等）。
    // 之前这里只打印一行"已存在，跳过创建"，于是"想改公开"没有入口。
    if (isPublic && existed.json.private) {
      const patched = await call(`https://api.github.com/repos/${owner}/${name}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ private: false })
      });
      if (patched.status !== 200) {
        console.error(`改为公开失败：HTTP ${patched.status} ${String(patched.text).slice(0, 300)}`);
        process.exit(1);
      }
      console.log(`已改为公开：${patched.json.full_name}  private=${patched.json.private}`);
      console.log(`地址: ${patched.json.html_url}`);
      return;
    }
    console.log(`已存在，跳过创建：${existed.json.full_name}（private=${existed.json.private}）`);
    console.log(`clone: ${existed.json.clone_url}`);
    return;
  }
  if (existed.status !== 404) {
    console.error(`查询失败：HTTP ${existed.status} ${String(existed.text).slice(0, 200)}`);
    process.exit(1);
  }

  const created = await call('https://api.github.com/user/repos', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name,
      private: !isPublic,
      description: 'QQ Agent 插件：@机器人 yuyuko <指令> → 经本地 Hikari-core-v2 桥接查询 yuyuko 数据源并渲染出图',
      has_issues: true,
      has_wiki: false,
      has_projects: false,
      auto_init: false
    })
  });

  if (created.status !== 201) {
    console.error(`创建失败：HTTP ${created.status} ${String(created.text).slice(0, 300)}`);
    process.exit(1);
  }
  console.log(`创建成功：${created.json.full_name}  private=${created.json.private}`);
  console.log(`clone: ${created.json.clone_url}`);
})().catch((error) => {
  console.error('异常：', error?.message ?? error);
  process.exit(1);
});
