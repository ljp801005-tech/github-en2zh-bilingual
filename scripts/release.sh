#!/usr/bin/env bash
# 一键发版：把改好的脚本复制到仓库 -> 校验 -> commit -> 打 tag -> push
# push 会通过 GitHub Webhook 触发 Greasy Fork 从 raw 地址同步出新版本。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
TARGET="$ROOT/github-en2zh-bilingual.user.js"
SRC="${1:-$ROOT/../github网页英译中双语对照.user.js}"

if [[ ! -f "$SRC" ]]; then
  echo "找不到源脚本：$SRC"
  echo "用法: ./scripts/release.sh /path/to/your.user.js"
  exit 1
fi

command -v node >/dev/null 2>&1 || { echo "需要 node（用于语法检查）"; exit 1; }
node --check "$SRC" || { echo "源脚本语法检查失败"; exit 1; }

NEW_VER="$(grep -m1 '^// @version' "$SRC" | awk '{print $3}')"
OLD_VER="$(grep -m1 '^// @version' "$TARGET" | awk '{print $3}')"
if [[ -z "$NEW_VER" ]]; then echo "源脚本缺少 @version"; exit 1; fi
if [[ "$NEW_VER" == "$OLD_VER" ]]; then
  echo "版本号未变化（仍为 $OLD_VER）。请先把脚本里的 @version 提升到更高版本，否则 Greasy Fork 不会生成新版本。"
  exit 1
fi
# 语义化版本递增检查（CI 会在 push 后再查一次，这里提前拦截，避免把坏版本推上去）
if ! node -e 'const a=process.argv[1].split(".").map(Number),b=process.argv[2].split(".").map(Number);let ok=false;for(let i=0;i<3;i++){if(a[i]!==b[i]){ok=b[i]>a[i];break}}process.exit(ok?0:1)' "$OLD_VER" "$NEW_VER"; then
  echo "版本号必须递增：$OLD_VER -> $NEW_VER 不是有效升级"
  exit 1
fi

cp "$SRC" "$TARGET"
node scripts/check-meta.mjs

cd "$ROOT"
git add -A
if git diff --cached --quiet; then echo "没有待提交改动"; exit 0; fi
git commit -m "release: v$NEW_VER"
if git rev-parse "v$NEW_VER" >/dev/null 2>&1; then
  echo "标签 v$NEW_VER 已存在，跳过打标签"
else
  git tag -a "v$NEW_VER" -m "v$NEW_VER"
fi
git push --follow-tags

echo ""
echo "v$NEW_VER 已推送：https://github.com/ljp801005-tech/github-en2zh-bilingual/releases/tag/v$NEW_VER"
echo "GitHub Webhook 会通知 Greasy Fork 拉取 raw 脚本，约数十秒后生成新版本："
echo "  https://greasyfork.org/zh-CN/scripts/604516"
