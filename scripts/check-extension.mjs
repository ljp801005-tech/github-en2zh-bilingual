// CI 校验：Chrome 扩展 manifest、图标、与主脚本的一致性
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const EXT = 'chrome-extension';
const problems = [];

function fail(msg) { problems.push(msg); }

let manifest = null;
try {
  manifest = JSON.parse(readFileSync(`${EXT}/manifest.json`, 'utf8'));
} catch (e) {
  fail('manifest.json 无法解析：' + e.message);
}

if (manifest) {
  if (manifest.manifest_version !== 3) { fail('manifest_version 必须为 3（MV3）'); }
  for (const key of ['name', 'version', 'description', 'icons', 'action', 'background', 'content_scripts', 'permissions', 'host_permissions']) {
    if (!manifest[key]) { fail(`manifest 缺少 ${key}`); }
  }
  if (String(manifest.description || '').length > 132) { fail('description 超过 Chrome 的 132 字符上限'); }
  if (!(manifest.host_permissions || []).includes('<all_urls>')) {
    fail('host_permissions 需要包含 <all_urls>：用户可自定义本地/局域网翻译服务地址');
  }
  if (!Array.isArray(manifest.permissions) || !manifest.permissions.includes('storage')) {
    fail('缺少 storage 权限（桥接层用 chrome.storage 保存配置）');
  }
  if (!Array.isArray(manifest.permissions) || !manifest.permissions.includes('scripting')) {
    fail('缺少 scripting 权限（后台注入主脚本）');
  }
  if (!Array.isArray(manifest.content_scripts) || manifest.content_scripts.length !== 1 ||
      !(manifest.content_scripts[0].js || []).includes('content/bridge.js')) {
    fail('content_scripts 必须只注册 content/bridge.js');
  }
  if (manifest.content_scripts && manifest.content_scripts[0] && manifest.content_scripts[0].run_at !== 'document_start') {
    fail('bridge.js 必须在 document_start 运行，才能在主脚本之前准备好配置');
  }
}

const scriptSrc = readFileSync('github-en2zh-bilingual.user.js', 'utf8');
const scriptVer = (scriptSrc.match(/^\/\/\s*@version\s+(\S+)/m) || [])[1];
if (manifest && scriptVer && manifest.version !== scriptVer) {
  fail(`manifest.version（${manifest.version}）与脚本 @version（${scriptVer}）不一致，请运行 scripts/build-extension.sh`);
}

for (const file of ['background.js', 'popup.html', 'popup.js', 'content/bridge.js', 'content/userscript.js']) {
  if (!existsSync(`${EXT}/${file}`)) { fail(`缺少文件 ${EXT}/${file}`); }
}

if (existsSync(`${EXT}/content/userscript.js`)) {
  const copy = readFileSync(`${EXT}/content/userscript.js`, 'utf8');
  if (copy !== scriptSrc) {
    fail('chrome-extension/content/userscript.js 与主脚本不一致，请运行 scripts/build-extension.sh');
  }
}

for (const size of ['16', '48', '128']) {
  const png = `${EXT}/icons/icon${size}.png`;
  if (!existsSync(png)) { fail(`缺少图标 ${png}`); continue; }
  const head = readFileSync(png).subarray(0, 4);
  if (!(head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47)) {
    fail(`${png} 不是有效的 PNG`);
  }
}

for (const file of ['background.js', 'content/bridge.js', 'popup.js', 'content/userscript.js']) {
  const p = `${EXT}/${file}`;
  if (!existsSync(p)) { continue; }
  try {
    execFileSync(process.execPath, ['--check', p], { stdio: 'ignore' });
  } catch (e) {
    fail(`语法错误：${p}`);
  }
}

if (problems.length) {
  console.error('Chrome 扩展检查未通过：');
  for (const p of problems) { console.error(' - ' + p); }
  process.exit(1);
}
console.log(`Chrome 扩展检查通过：v${manifest.version}，桥接层与主脚本一致`);
