#!/usr/bin/env bash
# 构建 Chrome 扩展：同步主脚本、对齐 manifest 版本、打可分发的 zip
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="${1:-$ROOT/../github网页英译中双语对照.user.js}"
EXT="$ROOT/chrome-extension"

if [[ ! -f "$SRC" ]]; then
  echo "找不到源脚本：$SRC"
  echo "用法: ./scripts/build-extension.sh /path/to/your.user.js"
  exit 1
fi
command -v node >/dev/null 2>&1 || { echo "需要 node（用于语法检查与 manifest 校验）"; exit 1; }
command -v zip >/dev/null 2>&1 || { echo "需要 zip 命令用于打包"; exit 1; }

node --check "$SRC" || { echo "源脚本语法检查失败"; exit 1; }
VER="$(grep -m1 '^// @version' "$SRC" | awk '{print $3}')"
[[ -n "$VER" ]] || { echo "源脚本缺少 @version"; exit 1; }

mkdir -p "$EXT/content"
cp "$SRC" "$EXT/content/userscript.js"
echo "已同步主脚本 -> chrome-extension/content/userscript.js（${VER}）"

node - "$EXT/manifest.json" "$VER" <<'NODE'
const fs = require('fs');
const file = process.argv[2];
const version = process.argv[3];
const m = JSON.parse(fs.readFileSync(file, 'utf8'));
if (m.version !== version) {
  m.version = version;
  fs.writeFileSync(file, JSON.stringify(m, null, 2) + '\n');
}
console.log('manifest.json 版本：' + m.version);
NODE

# 打包：解压后用「加载已解压的扩展程序」安装，或直接分发 zip
DIST="$ROOT/dist"
mkdir -p "$DIST"
ZIP="$DIST/github-en2zh-bilingual-chrome-v$VER.zip"
rm -f "$ZIP"
( cd "$EXT" && zip -qr "$ZIP" . -x "*.DS_Store" -x "__MACOSX/*" )
echo "打包完成：${ZIP}（$(du -h "$ZIP" | awk '{print $1}')）"
