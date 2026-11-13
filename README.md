# github网页英译中双语对照

[![Greasy Fork](https://img.shields.io/badge/Greasy%20Fork-604516-blue)](https://greasyfork.org/zh-CN/scripts/604516)
[![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![validate](https://github.com/ljp801005-tech/github-en2zh-bilingual/actions/workflows/validate.yml/badge.svg)](https://github.com/ljp801005-tech/github-en2zh-bilingual/actions/workflows/validate.yml)

自动识别网页语言、站点与页面类型，在 **GitHub 与纯英文外网** 上把英文段落译成中文，显示在原文**上方或下方**形成双语对照；中文网站自动跳过。GitHub 的代码区、diff、文件名不动，内联代码（如 `npm install`）原样保留。

页面左下角有一个蓝色「译」按钮，点开是设置面板（可在设置里切回右下角）。

## 安装

| 方式 | 地址 | 更新来源 |
|---|---|---|
| **Greasy Fork（推荐）** | https://greasyfork.org/zh-CN/scripts/604516 → 点「安装此脚本」 | Greasy Fork，由本仓库自动同步 |
| GitHub 直装 | [raw.githubusercontent.com/…/github-en2zh-bilingual.user.js](https://raw.githubusercontent.com/ljp801005-tech/github-en2zh-bilingual/main/github-en2zh-bilingual.user.js) | Tampermonkey 记住安装 URL，直接检查本仓库 raw |

需要 Tampermonkey / Violentmonkey / 脚本猫。首次安装时会提示 `@connect` 授权，点「允许」。用有道源无需任何配置，打开英文网页即生效。

## 自动更新链路

**本仓库是唯一代码源**，Greasy Fork 只是分发渠道：

```
编辑脚本（必须提升 @version）
      ↓  push 到 main
GitHub Actions：语法 / 元数据 / 版本号校验
      ↓  push 事件
GitHub Webhook → Greasy Fork 收到通知，立即从 raw 地址拉取
      ↓
Greasy Fork 生成新版本（约数十秒）
      ↓
用户脚本管理器按自身更新设置检查到新版
```

兜底：Greasy Fork 的「源代码同步」设为「自动 - 将定期检查更新并进行同步」，即使 Webhook 未触发，也会定期检查 raw 地址。

当前状态：脚本同步（自动）与附加信息同步均已配置，仓库 Webhook 已启用（仅 `push` 事件，`application/json`，使用 Greasy Fork 生成的 Secret），实测 push 回执 `HTTP 200 / OK` 且页面说明自动更新。1.4.0 已由一次真实同步生成 `Imported from URL` 版本。注意：Greasy Fork 的 Secret 必须先在用户页点「Generate」生成并填进 GitHub Webhook，否则请求一律 403。

> **每次发版必须提升 `@version`**，否则 Greasy Fork 不会创建新版本。CI 会拦截版本号未递增的 push。

维护者首次配置（已完成，仅作记录）：

1. Greasy Fork 脚本页 →「管理」→「源代码同步」填入
   `https://raw.githubusercontent.com/ljp801005-tech/github-en2zh-bilingual/main/github-en2zh-bilingual.user.js`，模式选「自动」。
2. 同一页的「附加信息同步」填入
   `https://raw.githubusercontent.com/ljp801005-tech/github-en2zh-bilingual/main/docs/greasyfork-description.md`，格式 Markdown —— 页面详细说明也会随仓库更新。
3. Greasy Fork 用户页 https://greasyfork.org/zh-CN/users/webhook-info 复制专属 Webhook URL。
4. 本仓库 → Settings → Webhooks → Add webhook：Payload URL 填该地址，Content type 选 `application/json`，事件选 `Just the push event`，Secret 留空。

## 维护者发版

```bash
# 把改好的脚本（任意文件名）作为唯一参数，脚本会自动读 @version
./scripts/release.sh "/path/to/github网页英译中双语对照.user.js"
```

`release.sh` 会：检查语法 → 比对版本是否变化 → 复制到仓库根目录 → commit → 打 `vX.Y.Z` 标签 → `git push --follow-tags`。push 之后 Webhook 自动触发 Greasy Fork 新版本，无需再去论坛点发布。

手动发版等价命令：

```bash
cp /path/to/script.user.js github-en2zh-bilingual.user.js
git add -A && git commit -m "release: 1.4.0" && git tag v1.4.0
git push --follow-tags
```

## 功能

- 译文在英文**上方 / 下方**切换（设置面板或 `Alt+P`）
- 自动识别：`html[lang]` / meta language / 正文中文占比 → 站点类型（GitHub、GitHub Pages、问答社区、技术文档）→ GitHub 页面类型（代码页、Issue、PR、Discussion、Wiki）
- 运行范围三档：自动（白名单站点 + 纯英文页）、仅白名单、所有网站
- GitHub 专项：跳过代码 / diff / Monaco / 徽标 / 文件名；内联代码用占位符保护，本地小模型改写标记也能容错还原
- 滚动补翻、动态加载内容补翻、Cloudflare 验证页 / 骨架屏延迟重判、限流冷却倒计时后自动恢复、失败退避重试
- 跨页面译文缓存、划词翻译、站点黑名单、亮/暗配色、SPA / Turbo 导航监听
- 翻译源：**有道**（默认，国内直连免注册）、**百度翻译开放平台**（需 appid + 密钥）、**本地离线服务**（LibreTranslate / Ollama / OpenAI 兼容协议，数据不出本机）

## 快捷键

| 键 | 作用 |
|---|---|
| `Alt+T` | 开启 / 暂停翻译 |
| `Alt+P` | 译文切到英文上方 / 下方 |
| `Alt+Enter` | 立即翻译本页（可强制翻译被自动识别跳过的页面） |
| `Alt+S` | 划词翻译（需在设置里开启） |

## 翻译源与隐私

在线源（有道 / 百度）会把页面中的英文文本发送给你所选的服务商；本地离线源完全不出本机。有道使用官方演示接口，有频率风控（错误码 411），脚本会限速、批量合并、退避重试并在冷却结束后自动续翻；要彻底免限流请切百度或本地源。

`@match` 使用 `*://*/*` 是因为功能目标就是「任意纯英文网站」，脚本会自动跳过中文站与黑名单站点；`@connect *` 是为支持用户自填的本地服务地址。

## 目录

| 文件 | 说明 |
|---|---|
| `github-en2zh-bilingual.user.js` | 脚本本体（发版文件，Greasy Fork 同步此文件） |
| `docs/说明与使用教程.md` | 完整安装、设置、判定规则、FAQ |
| `docs/greasyfork-description.md` | Greasy Fork 页面「详细说明」的同步源（GF 会自动拉取） |
| `docs/GreasyFork发布说明.md` | 同上，中文文件名备份 |
| `scripts/check-meta.mjs` | CI 用的语法 / 元数据 / 版本递增检查 |
| `scripts/release.sh` | 一键发版 |
| `.github/workflows/validate.yml` | push / PR 自动校验 |

详细使用说明见 [docs/说明与使用教程.md](docs/说明与使用教程.md)。问题反馈：https://github.com/ljp801005-tech/github-en2zh-bilingual/issues

## 许可

MIT，见 [LICENSE](LICENSE)。
