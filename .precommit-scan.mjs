// 提交前安全扫描：检查将要入库的文件里有没有真实凭据 / 体积异常。
// 用法：node .precommit-scan.mjs
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();

// 只扫这些"会进库"的路径（与 .gitignore 的排除项保持一致）
const SKIP_DIRS = new Set(['.git', 'data', '.hikari-src', '.hikari-deps', '.probe', '.probe2', 'node_modules', '__pycache__']);
const SKIP_EXT = new Set(['.pyc', '.log', '.tar.gz']);

// 桥接请求里出现过的"形如凭据"的字面量检测。
//
// ⚠️ 故意**不**把真实凭据写进本文件：本文件自己也要进库，
//    把凭据当"检测目标"写进来等于自己制造泄露（第一版就是这么被自己拦下的，见下方 README 里的记录）。
//    改用**结构模式**判定：yuyuko 凭据的形态是 `6~12 位数字 : 20~64 位字母数字`，
//    且前后不能是明显的占位符。
const CRED_PATTERN = /\b(\d{6,12}):([A-Za-z0-9]{20,64})\b/;
const PLACEHOLDER = /你的|example|占位|placeholder|xxx+|123456|111111|fake|test:|accountid/i;
const PATTERNS = [
  { name: '形如 数字:长串 的凭据', re: /\b\d{6,12}:[A-Za-z0-9]{20,}\b/ },
  { name: 'Authorization: 硬编码', re: /Authorization['"]?\s*[:=]\s*['"][^'"\s]{16,}/i },
  { name: 'apiKey/token 赋值疑似真实值', re: /(api[_-]?key|token|secret)\s*[:=]\s*['"][A-Za-z0-9:_-]{24,}['"]/i },
];

const files = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.') && e.name !== '.gitignore' && e.name !== '.precommit-scan.mjs') {
      if (SKIP_DIRS.has(e.name)) continue;
    }
    if (SKIP_DIRS.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { walk(p); continue; }
    if (SKIP_EXT.has(path.extname(e.name))) continue;
    files.push(p);
  }
})(ROOT);

const refuses = [];
const warnings = [];
let total = 0;

for (const f of files) {
  const rel = path.relative(ROOT, f).replace(/\\/g, '/');
  const st = fs.statSync(f);
  total += st.size;

  if (st.size > 1024 * 1024) refuses.push(`${rel} 体积 ${(st.size / 1048576).toFixed(1)}MB > 1MB（不该进库）`);

  let text = '';
  try { text = fs.readFileSync(f, 'utf8'); } catch { continue; }

  // ① 形如 `账号ID:Token` 的凭据（本插件唯一会接触的真实密钥形态）
  const cred = text.match(CRED_PATTERN);
  if (cred && !PLACEHOLDER.test(cred[0])) {
    refuses.push(`${rel} 含形如真实凭据的字符串：${cred[1].slice(0, 4)}****:${cred[2].slice(0, 4)}****`);
  }
  // ② 其它常见密钥写法
  for (const { name, re } of PATTERNS) {
    const m = text.match(re);
    if (m) {
      const hit = m[0];
      if (PLACEHOLDER.test(hit) || /\*\*\*\*\*\*/.test(hit)) {
        warnings.push(`${rel} 命中「${name}」但看着像占位符：${hit.slice(0, 50)}`);
      } else {
        refuses.push(`${rel} 命中「${name}」：${hit.slice(0, 60)}`);
      }
    }
  }
}

console.log(`扫描 ${files.length} 个文件，共 ${(total / 1024).toFixed(0)} KB`);
if (warnings.length) {
  console.log('\n提示（需你确认是占位符）：');
  warnings.forEach((w) => console.log('  · ' + w));
}
if (refuses.length) {
  console.log('\n拒绝提交：');
  refuses.forEach((r) => console.log('  ✗ ' + r));
  process.exit(1);
}
console.log('\n通过：没有真实凭据、没有异常大文件');
