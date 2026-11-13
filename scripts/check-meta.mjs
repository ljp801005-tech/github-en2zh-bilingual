// CI 校验：元数据完整性、版本号递增、Greasy Fork 规则相关约束
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const FILE = 'github-en2zh-bilingual.user.js';
const src = readFileSync(FILE, 'utf8');
const problems = [];
const warns = [];

function meta(key) {
  const m = src.match(new RegExp('^//\\s*@' + key + '\\s+(.+)$', 'm'));
  return m ? m[1].trim() : null;
}
function versionOf(text) {
  const m = text.match(/^\/\/\s*@version\s+(\d+\.\d+\.\d+)\s*$/m);
  return m ? m[1] : null;
}
function greater(a, b) {
  const x = a.split('.').map(Number), y = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) { if (x[i] !== y[i]) { return x[i] > y[i]; } }
  return false;
}

const REQUIRED = ['name', 'namespace', 'version', 'description', 'author', 'license', 'match', 'homepageURL', 'supportURL'];
for (const k of REQUIRED) {
  if (!meta(k)) { problems.push(`缺少 @${k}`); }
}

const ver = versionOf(src);
if (!ver) { problems.push('@version 不符合 x.y.z 格式'); }
if (meta('name') !== 'github网页英译中双语对照') { warns.push('@name 与 Greasy Fork 上已发布的名称不一致，同步可能新建脚本'); }
if (meta('namespace') !== 'workbuddy.userjs.en2zh.bilingual') { warns.push('@namespace 变更会导致用户脚本管理器视为不同脚本'); }
if (meta('homepageURL') && !meta('homepageURL').includes('github.com/ljp801005-tech/github-en2zh-bilingual')) {
  problems.push('@homepageURL 必须指向本仓库');
}

// 不得用 @require 外链加载主体代码（Greasy Fork 规则）
if (/^\/\/\s*@require\s+/m.test(src)) { problems.push('不允许 @require 外部脚本（主体代码必须内联）'); }
if (src.length > 2 * 1024 * 1024) { problems.push('脚本超过 Greasy Fork 2 MB 上限'); }
if (/^\/\/\s*@(name|description):[a-z-]+\s+/im.test(src)) {
  warns.push('存在本地化元数据键，Greasy Fork 会校验 @description:xx 非空，曾导致发布失败');
}

// 与上一次提交比较版本号：未递增会让 Greasy Fork 拒绝生成新版本
let prevVer = null;
try {
  const prev = execFileSync('git', ['show', `HEAD~1:${FILE}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  prevVer = versionOf(prev);
} catch { /* 首次提交或 shallow clone，跳过 */ }
if (prevVer && ver) {
  if (!greater(ver, prevVer)) { problems.push(`@version 未递增：HEAD~1 为 ${prevVer}，当前为 ${ver}（Greasy Fork 不会创建新版本）`); }
  else { console.log(`版本递增 OK: ${prevVer} -> ${ver}`); }
} else {
  console.log('无上一版本可比，跳过递增检查');
}

for (const w of warns) { console.log('WARN  ' + w); }
for (const p of problems) { console.error('ERROR ' + p); }
console.log(`元数据检查完成：${problems.length} 个错误 / ${warns.length} 个警告，版本 ${ver || '未知'}，大小 ${(src.length / 1024).toFixed(1)} KB`);
process.exit(problems.length ? 1 : 0);
