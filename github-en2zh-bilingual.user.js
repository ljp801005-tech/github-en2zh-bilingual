// ==UserScript==
// @name         github网页英译中双语对照
// @namespace   workbuddy.userjs.en2zh.bilingual
// @version     1.6.0
// @description 自动识别网页语言、站点与页面类型：GitHub 及纯英文外网自动把英文段落译为中文，显示在原文上方或下方，中文站点自动跳过。GitHub 跳过代码/diff/文件名并原样保留内联代码。默认网易有道，可切换百度或本地离线服务。隐私说明：在线翻译时会将页面英文文本发送至你所选的翻译服务（有道/百度）；本地离线模式数据不出本机。
// @author      WorkBuddy
// @license     MIT
// @homepageURL https://github.com/ljp801005-tech/github-en2zh-bilingual
// @supportURL  https://github.com/ljp801005-tech/github-en2zh-bilingual/issues
// @match       *://*/*
// @match       file:///*
// @grant       GM_xmlhttpRequest
// @grant       GM_getValue
// @grant       GM_setValue
// @grant       GM_registerMenuCommand
// @grant       GM_addStyle
// @connect     aidemo.youdao.com
// @connect     fanyi-api.baidu.com
// @connect     localhost
// @connect     127.0.0.1
// @connect     *
// @run-at      document-idle
// ==/UserScript==

/* global GM_xmlhttpRequest, GM_getValue, GM_setValue, GM_registerMenuCommand, GM_addStyle */

(function () {
  'use strict';

  // ------------------------------------------------------------------
  // 0. 配置
  // ------------------------------------------------------------------
  const CFG_KEY = 'wb_en2zh_cfg_v1';
  const CACHE_KEY = 'wb_en2zh_cache_v1';
  const DEFAULTS = {
    enabled: true,
    position: 'below',          // below = 译文在英文下方；above = 上方
    corner: 'left',             // left = 浮动「译」图标在左下角；right = 右下角
    source: 'youdao',           // youdao | baidu | local
    autoFallback: true,         // 主源失败时自动尝试备用源
    baiduAppid: '',
    baiduKey: '',
    localProtocol: 'libre',     // libre | ollama | openai
    localUrl: 'http://127.0.0.1:8787/translate',
    localModel: 'qwen2.5:3b',
    theme: 'auto',              // auto | light | dark
    lazy: true,                 // 只翻译进入视口附近的内容
    auto: true,                 // 自动翻译；false = 手动按 Alt+Enter 才翻译
    selection: false,           // 划词翻译（Alt+S）
    minChars: 20,               // 段落最少字符数
    maxBlocks: 300,             // 单页最多翻译段落数
    blockedSites: [],           // 站点黑名单
    autoDetect: true,           // 自动识别网页（语言 / 站点 / 页面类型）
    siteMode: 'auto',           // auto | whitelist | all
    siteWhitelist: ['github.com', 'gist.github.com', 'docs.github.com', 'github.io', 'raw.githubusercontent.com'],
    cjkThreshold: 2,            // 中文字符占比超过该百分比视为中文页面
    githubTweaks: true,         // GitHub 专项适配（跳过代码 / diff / 编辑器）
    protectInlineCode: true,    // 内联代码、用户名、hash 用占位符原样保留
    preferMainContent: true,    // 优先翻译正文容器，忽略导航与页脚
    rescanOnScroll: true        // 滚动时补扫漏掉的段落（懒加载 / 折叠 / 延迟渲染）
  };

  const SOURCE_LABEL = {
    youdao: '有道（国内在线）',
    baidu: '百度开放平台',
    local: '本地离线服务'
  };
  const LOCAL_DEFAULTS = {
    libre: 'http://127.0.0.1:8787/translate',
    ollama: 'http://127.0.0.1:11434/api/chat',
    openai: 'http://127.0.0.1:1234/v1/chat/completions'
  };
  const SITE_LABEL = {
    github: 'GitHub', 'github-pages': 'GitHub Pages', 'github-raw': 'GitHub Raw',
    qa: '问答社区', docs: '技术文档', other: '普通网站'
  };
  const TYPE_LABEL = {
    code: '代码页', issue: 'Issue', pull: 'Pull Request', discussion: 'Discussion',
    wiki: 'Wiki', repo: '仓库页', article: '文章/文档', generic: '常规页面'
  };

  let cfg = loadCfg();
  function loadCfg() {
    try {
      return Object.assign({}, DEFAULTS, JSON.parse(GM_getValue(CFG_KEY, '{}') || '{}'));
    } catch (e) {
      return Object.assign({}, DEFAULTS);
    }
  }
  function saveCfg() {
    try { GM_setValue(CFG_KEY, JSON.stringify(cfg)); } catch (e) { /* 忽略 */ }
  }

  // ------------------------------------------------------------------
  // 1. 缓存（跨页面复用，避免重复请求）
  // ------------------------------------------------------------------
  let cache = {};
  try { cache = JSON.parse(GM_getValue(CACHE_KEY, '{}') || '{}') || {}; } catch (e) { cache = {}; }
  let cacheDirty = false;

  function cacheGet(k) { return Object.prototype.hasOwnProperty.call(cache, k) ? cache[k] : undefined; }
  function cacheSet(k, v) {
    cache[k] = v;
    cacheDirty = true;
    const keys = Object.keys(cache);
    if (keys.length > 2000) { keys.slice(0, 600).forEach(function (x) { delete cache[x]; }); }
  }
  function flushCache() {
    if (!cacheDirty) return;
    try { GM_setValue(CACHE_KEY, JSON.stringify(cache)); cacheDirty = false; } catch (e) { /* 忽略 */ }
  }
  setInterval(flushCache, 4000);
  window.addEventListener('pagehide', flushCache);

  // ------------------------------------------------------------------
  // 2. 通用工具
  // ------------------------------------------------------------------
  const sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  const IS_TOP = (function () { try { return window.top === window.self; } catch (e) { return false; } })();

  function rotl(x, n) { return ((x << n) | (x >>> (32 - n))) >>> 0; }

  // 精简 MD5 实现（百度开放平台签名需要，浏览器 crypto.subtle 不支持 MD5）
  // 来源：依据 RFC 1321 (R. Rivest, 1992) 自行实现的紧凑版，非第三方库，未引入外部代码。
  function md5(str) {
    const bytes = new TextEncoder().encode(str);
    const bitLen = bytes.length * 8;
    const rem = (bytes.length + 1) % 64;
    const padLen = rem <= 56 ? 56 - rem : 64 + 56 - rem;
    const total = bytes.length + 1 + padLen + 8;
    const buf = new Uint8Array(total);
    buf.set(bytes);
    buf[bytes.length] = 0x80;
    const dv = new DataView(buf.buffer);
    dv.setUint32(total - 8, bitLen >>> 0, true);
    dv.setUint32(total - 4, Math.floor(bitLen / 0x100000000), true);

    const S = [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
      5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
      4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
      6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21];
    const K = new Uint32Array(64);
    for (let i = 0; i < 64; i++) { K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) >>> 0; }

    let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
    for (let off = 0; off < total; off += 64) {
      const M = new Uint32Array(16);
      for (let j = 0; j < 16; j++) { M[j] = dv.getUint32(off + j * 4, true); }
      let A = a0, B = b0, C = c0, D = d0;
      for (let i = 0; i < 64; i++) {
        let F, g;
        if (i < 16) { F = (B & C) | (~B & D); g = i; }
        else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; }
        else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; }
        else { F = C ^ (B | ~D); g = (7 * i) % 16; }
        const sum = (A + F + K[i] + M[g]) >>> 0;
        const nb = (B + rotl(sum, S[i])) >>> 0;
        A = D; D = C; C = B; B = nb;
      }
      a0 = (a0 + A) >>> 0; b0 = (b0 + B) >>> 0; c0 = (c0 + C) >>> 0; d0 = (d0 + D) >>> 0;
    }
    const out = new Uint8Array(16);
    const odv = new DataView(out.buffer);
    odv.setUint32(0, a0, true); odv.setUint32(4, b0, true);
    odv.setUint32(8, c0, true); odv.setUint32(12, d0, true);
    return Array.from(out, function (x) { return x.toString(16).padStart(2, '0'); }).join('');
  }

  function http(url, extra) {
    return new Promise(function (resolve, reject) {
      const opt = Object.assign({
        method: 'GET',
        url: url,
        timeout: 20000,
        headers: { Accept: 'application/json, text/plain, */*' },
        onload: function (r) {
          if (r.status >= 200 && r.status < 300) { resolve(r.responseText); }
          else { reject(new Error('HTTP ' + r.status)); }
        },
        onerror: function () { reject(new Error('网络请求失败')); },
        ontimeout: function () { reject(new Error('请求超时')); }
      }, extra || {});
      try { GM_xmlhttpRequest(opt); } catch (e) { reject(e); }
    });
  }
  function parseJSON(raw) {
    let d;
    try { d = JSON.parse(raw); } catch (e) { throw new Error('返回不是 JSON'); }
    return d;
  }
  // 多行批量翻译必须严格保持行数，否则宁可降级逐条翻译
  function normalizeOut(lines, texts) {
    if (lines.length !== texts.length) { throw new Error('译文行数不匹配（' + lines.length + '/' + texts.length + '）'); }
    return lines.map(function (x) { return String(x == null ? '' : x).trim(); });
  }
  function cleanLLM(s) {
    return String(s || '')
      .replace(/^```[a-z]*\s*/i, '').replace(/```\s*$/, '')
      .replace(/^\s*(译文|翻译结果|Translation)\s*[:：]\s*/i, '')
      .replace(/^["“]|["”]$/g, '')
      .trim();
  }

  // ------------------------------------------------------------------
  // 3. 翻译源
  //    有道：网易有道 AI 官方演示接口，国内可直连、免注册、CORS 全开
  //    百度：百度翻译开放平台，需 appid + 密钥，稳定无限流
  //    本地：LibreTranslate 协议 / Ollama / OpenAI 兼容接口，完全离线
  // ------------------------------------------------------------------
  async function youdao(texts) {
    const q = texts.join('\n');
    const url = 'https://aidemo.youdao.com/trans?' + new URLSearchParams({
      q: q, from: 'Auto', to: 'zh-CHS'
    }).toString();
    const d = parseJSON(await http(url));
    if (String(d.errorCode) !== '0' || !d.translation || !d.translation.length) {
      throw new Error('有道返回 ' + d.errorCode + (d.errorCode === '411' ? '（频率受限，稍后自动重试）' : ''));
    }
    return normalizeOut(String(d.translation[0]).split('\n'), texts);
  }

  async function baidu(texts) {
    if (!cfg.baiduAppid || !cfg.baiduKey) { throw new Error('请先在设置里填写百度 appid 和密钥'); }
    const q = texts.join('\n');
    const salt = String(Date.now());
    const sign = md5(cfg.baiduAppid + q + salt + cfg.baiduKey);
    const url = 'https://fanyi-api.baidu.com/api/trans/vip/translate?' + new URLSearchParams({
      q: q, from: 'auto', to: 'zh', appid: cfg.baiduAppid, salt: salt, sign: sign
    }).toString();
    const d = parseJSON(await http(url));
    if (d.error_code) { throw new Error('百度 ' + d.error_code + ' ' + (d.error_msg || '')); }
    const out = (d.trans_result || []).map(function (x) { return x.dst; }).join('\n').split('\n');
    return normalizeOut(out, texts);
  }

  const LLM_SYSTEM = '你是专业英译中引擎。把用户消息中的英文逐行翻译成简体中文。' +
    '严格要求：输出行数与输入行数完全一致，一行对一行，保持原有顺序和换行；' +
    '不要合并行、不要添加编号、不要解释、不要输出原文、不要输出任何多余内容；' +
    '形如 WBX700XWB 的大写字母数字标记是受保护的代码片段，必须原样保留，不得改动、不得翻译、不得删除；' +
    '专有名词、品牌名、代码标识符保持原样。';

  async function local(texts) {
    const q = texts.join('\n');
    let body;
    if (cfg.localProtocol === 'ollama' || cfg.localProtocol === 'openai') {
      body = {
        model: cfg.localModel || 'local-model',
        stream: false,
        temperature: 0,
        messages: [
          { role: 'system', content: LLM_SYSTEM },
          { role: 'user', content: q }
        ]
      };
    } else {
      body = { q: q, source: 'en', target: 'zh', format: 'text' };
    }
    const raw = await http(cfg.localUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      data: JSON.stringify(body)
    });
    const d = parseJSON(raw);
    let out;
    if (cfg.localProtocol === 'ollama') {
      out = (d.message && d.message.content) || d.response || '';
    } else if (cfg.localProtocol === 'openai') {
      out = (d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content) || '';
    } else {
      out = d.translatedText || d.translation ||
        (d.data && d.data.translations && d.data.translations[0] && d.data.translations[0].translatedText) || '';
    }
    if (!out) { throw new Error('本地服务未返回译文' + (d.error ? '：' + d.error : '')); }
    return normalizeOut(cleanLLM(out).split('\n'), texts);
  }

  async function translateOnce(texts) {
    const order = [cfg.source];
    if (cfg.autoFallback) {
      if (cfg.source !== 'local') { order.push('local'); }
      if (cfg.source !== 'baidu' && cfg.baiduAppid && cfg.baiduKey) { order.push('baidu'); }
      if (cfg.source !== 'youdao') { order.push('youdao'); }
    }
    let lastErr = null;
    for (const src of order) {
      if (src === 'local' && cfg.source !== 'local' && !cfg.localUrl) { continue; }
      if (src === 'baidu' && (!cfg.baiduAppid || !cfg.baiduKey)) { continue; }
      try {
        const r = src === 'youdao' ? await youdao(texts)
          : src === 'baidu' ? await baidu(texts)
            : await local(texts);
        if (src !== cfg.source) { setStatus('已自动回退到「' + SOURCE_LABEL[src] + '」'); }
        return r;
      } catch (e) { lastErr = e; }
    }
    throw lastErr || new Error('无可用翻译源');
  }

  // ------------------------------------------------------------------
  // 4. 串行队列 + 节流（有道演示接口有频率风控，必须限速）
  // ------------------------------------------------------------------
  const jobs = [];
  let pumping = false, lastReq = 0, failStreak = 0, cooldownUntil = 0, cooldownTimer = 0;

  function gap() { return cfg.source === 'local' ? 120 : cfg.source === 'baidu' ? 400 : 1400; }

  function scheduled(texts) {
    return new Promise(function (resolve, reject) {
      jobs.push({ texts: texts, resolve: resolve, reject: reject });
      pump();
    });
  }

  async function pump() {
    if (pumping) { return; }
    pumping = true;
    while (jobs.length) {
      const job = jobs.shift();
      if (Date.now() < cooldownUntil) { await sleep(cooldownUntil - Date.now()); }
      const wait = lastReq + gap() - Date.now();
      if (wait > 0) { await sleep(wait); }
      lastReq = Date.now();

      let done = false, lastErr = null;
      for (let attempt = 0; attempt < 3 && !done; attempt++) {
        try {
          const res = await translateOnce(job.texts);
          failStreak = 0;
          job.resolve(res);
          done = true;
        } catch (e) {
          lastErr = e;
          if (attempt < 2) { await sleep(1500 * (attempt + 1)); }
        }
      }
      if (!done) {
        failStreak++;
        if (failStreak >= 2) {
          cooldownUntil = Date.now() + 30000;
          failStreak = 0;
          setStatus('翻译接口限流，暂停 30 秒后自动继续：' + lastErr.message, true);
          // 冷却期间滚动过的内容不能丢：结束后自动补扫全页
          if (!cooldownTimer) {
            cooldownTimer = setTimeout(function () {
              cooldownTimer = 0;
              cooldownUntil = 0;
              setStatus('限流结束，正在自动继续翻译');
              rescanPage(true);
            }, 30500);
          }
        }
        job.reject(lastErr);
      }
    }
    pumping = false;
  }

  function pack(items, maxChars, maxCount) {
    const batches = [];
    let cur = [], len = 0;
    items.forEach(function (it) {
      const n = it.text.length + 1;
      if (cur.length && (len + n > maxChars || cur.length >= maxCount)) {
        batches.push(cur); cur = []; len = 0;
      }
      cur.push(it); len += n;
    });
    if (cur.length) { batches.push(cur); }
    return batches;
  }

  // ------------------------------------------------------------------
  // 5. DOM 常量与选择器
  // ------------------------------------------------------------------
  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'INPUT', 'SELECT',
    'OPTION', 'BUTTON', 'PRE', 'SVG', 'MATH', 'CANVAS', 'IFRAME', 'VIDEO', 'AUDIO',
    'OBJECT', 'TEMPLATE', 'META', 'LINK', 'TITLE', 'HEAD']);
  const BLOCK_TAGS = new Set(['P', 'DIV', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
    'BLOCKQUOTE', 'TD', 'TH', 'DD', 'DT', 'FIGCAPTION', 'SECTION', 'ARTICLE',
    'HEADER', 'FOOTER', 'ASIDE', 'MAIN', 'UL', 'OL', 'TABLE', 'TR', 'FORM',
    'LABEL', 'SUMMARY', 'DETAILS', 'CENTER']);

  const BASE_SKIP_SELECTORS = [
    'pre', 'svg', 'math', 'canvas', 'iframe', 'video', 'audio', 'object',
    'script', 'style', 'noscript', 'textarea', 'input', 'select', 'option', 'button',
    '[contenteditable="true"]', '[data-wb-trans]', '#wb-tr-root',
    '[aria-hidden="true"]', '[role="navigation"]', 'nav', 'footer'
  ].join(', ');
  // GitHub 代码查看 / diff / 编辑器 / 徽标等绝对不能翻译的区域
  const GH_SKIP_SELECTORS = [
    '.blob-code', '.blob-num', '.js-file-line', '.diff-table', '.diff-view', '.file-diff',
    '.react-code-lines', '.react-code-text', '.react-code-line',
    '.cm-line', '.cm-content', '.monaco-editor',
    '.highlight', '.snippet-clipboard-content', '.code-view',
    '.Label', '.Counter', '.btn', '.octicon', 'relative-time'
  ].join(', ');
  // 内联代码片段 / @用户名 / commit hash / 文件名：用占位符原样保留在译文里
  const PROTECT_SELECTORS = [
    'code', 'kbd', 'samp', '.user-mention', '.commit-sha', '.sha',
    '.js-navigation-open', '.branch-name', '.commit-ref'
  ].join(', ');
  const MAIN_SELECTORS = [
    'article', 'main', '[role="main"]', '.markdown-body', '.comment-body',
    '#content', '.post-content', '.entry-content', '.content'
  ].join(', ');

  const PH_BASE = 700;   // 占位符编号从 700 起，避免与原文本中的数字冲突
  let _skipCache = '';
  function skipSel() {
    if (!_skipCache) {
      _skipCache = cfg.githubTweaks ? BASE_SKIP_SELECTORS + ', ' + GH_SKIP_SELECTORS : BASE_SKIP_SELECTORS;
    }
    return _skipCache;
  }

  // ------------------------------------------------------------------
  // 6. 自动识别网页：语言 + 站点 + 页面类型
  // ------------------------------------------------------------------
  let detection = null;
  let runAllowed = true;

  function hostMatches(host, rule) {
    rule = String(rule || '').trim().toLowerCase()
      .replace(/^https?:\/\//, '').replace(/^\*:\/\//, '').split('/')[0];
    if (!rule) { return false; }
    return host === rule || host.endsWith('.' + rule);
  }
  function isWhitelisted(host) {
    return (cfg.siteWhitelist || []).some(function (r) { return hostMatches(host, r); });
  }
  function classifySite(host) {
    if (host === 'docs.github.com') { return 'docs'; }
    if (host === 'github.com' || host.endsWith('.github.com')) { return 'github'; }
    if (host.endsWith('github.io')) { return 'github-pages'; }
    if (host.endsWith('githubusercontent.com')) { return 'github-raw'; }
    if (host.endsWith('stackoverflow.com') || host.endsWith('stackexchange.com')) { return 'qa'; }
    if (host.endsWith('developer.mozilla.org') || host.endsWith('docs.python.org')) { return 'docs'; }
    return 'other';
  }
  function classifyPageType(site) {
    const path = location.pathname || '';
    if (site === 'github') {
      if (/\/blob\/|\/tree\/|\/commits\/|\/compare\/|\/pull\/\d+\/files|\/raw\//.test(path)) { return 'code'; }
      if (/\/issues\//.test(path)) { return 'issue'; }
      if (/\/pull\/\d+/.test(path)) { return 'pull'; }
      if (/\/discussions\//.test(path)) { return 'discussion'; }
      if (/\/wiki\//.test(path)) { return 'wiki'; }
      return 'repo';
    }
    if (document.querySelector('article, .markdown-body, .post-content, .entry-content')) { return 'article'; }
    return 'generic';
  }

  function detectPage() {
    const host = location.hostname || '';
    const site = classifySite(host);
    const type = classifyPageType(site);
    const lang = (document.documentElement.lang || '').toLowerCase();
    const metaEl = document.querySelector('meta[http-equiv="content-language"]');
    const meta = String((metaEl && metaEl.content) || '').toLowerCase();
    let allText = '', injected = '';
    try {
      allText = document.body.innerText || document.body.textContent || '';
      // 脚本自己注入的设置面板（中文标签）和译文会污染语言判定，必须扣除
      document.querySelectorAll('#wb-tr-root, .wb-trans').forEach(function (el) {
        injected += (el.innerText || el.textContent || '') + ' ';
      });
    } catch (e) { allText = ''; }
    const compact = function (s) { return String(s || '').replace(/\s/g, ''); };
    const sample = compact(allText).slice(0, 30000);
    const inj = compact(injected);
    const cjk = Math.max(0,
      (sample.match(/[\u3400-\u9fff]/g) || []).length - (inj.match(/[\u3400-\u9fff]/g) || []).length);
    const cjkRatio = cjk / Math.max(1, sample.length - inj.length);
    const isChinese = /^zh\b/.test(lang) || /^zh\b/.test(meta) ||
      cjkRatio * 100 > (cfg.cjkThreshold || 2);
    // Cloudflare 验证页 / 骨架屏 / SPA 尚未渲染时，中文占位文字会误判为中文站
    const verifying = /justamoment|请稍候|正在进行安全验证|验证您是真人|checkingyourbrowser|enablejavascript/i.test(sample);
    const pending = verifying || sample.length < 60;
    return {
      host: host, site: site, type: type, cjkRatio: cjkRatio,
      isChinese: isChinese, whitelisted: isWhitelisted(host), pending: pending,
      label: (SITE_LABEL[site] || '普通网站') + ' · ' + (TYPE_LABEL[type] || '常规页面')
    };
  }

  function shouldRun(d) {
    d = d || detectPage();
    if (!cfg.autoDetect) { return { run: true, reason: '自动识别已关闭，按全局规则运行' }; }
    if (d.pending && cfg.siteMode !== 'all') {
      return { run: false, pending: true, reason: '页面正文尚未加载完成，等待自动重判' };
    }
    if (cfg.siteMode === 'all') { return { run: true, reason: '运行范围设为全部网站' }; }
    if (cfg.siteMode === 'whitelist') {
      return d.whitelisted
        ? { run: true, reason: '命中站点白名单' }
        : { run: false, reason: '不在白名单内，已跳过' };
    }
    if (d.whitelisted) { return { run: true, reason: '白名单站点，豁免中文检测' }; }
    if (d.isChinese) {
      return { run: false, reason: '识别为中文页面（中文占比 ' + (d.cjkRatio * 100).toFixed(1) + '%），已跳过' };
    }
    return { run: true, reason: '识别为纯英文页面（中文占比 ' + (d.cjkRatio * 100).toFixed(1) + '%）' };
  }

  function siteBlocked() {
    const host = location.hostname || '';
    return (cfg.blockedSites || []).some(function (s) {
      return s && (host === s || host.endsWith('.' + s) || location.href.indexOf(s) >= 0);
    });
  }

  // 只取最外层的正文容器，避免导航、页脚、侧栏里的短英文被翻
  function getScanRoots() {
    if (!cfg.preferMainContent) { return [document.body]; }
    const roots = [];
    document.querySelectorAll(MAIN_SELECTORS).forEach(function (el) {
      if (isInInjection(el)) { return; }
      if (roots.some(function (r) { return r === el || r.contains(el); })) { return; }
      for (let i = roots.length - 1; i >= 0; i--) {
        if (el.contains(roots[i])) { roots.splice(i, 1); }
      }
      roots.push(el);
    });
    return roots.length ? roots : [document.body];
  }

  // ------------------------------------------------------------------
  // 7. DOM：识别英文段落
  // ------------------------------------------------------------------
  function isEnglish(t) {
    if (t.length < (cfg.minChars || 20)) { return false; }
    const letters = (t.match(/[A-Za-z]/g) || []).length;
    const cjk = (t.match(/[\u3400-\u9fff]/g) || []).length;
    const noSpace = t.replace(/\s/g, '').length || 1;
    if (letters / noSpace < 0.5 || cjk > 1) { return false; }
    const words = t.match(/[A-Za-z][A-Za-z'-]*/g) || [];
    if (words.length < 4) { return false; }
    if (/^(https?:\/\/|www\.|[\w.+-]+@[\w.-]+\.\w+)/i.test(t)) { return false; }
    if (/[{}<>]|=&gt;|=>|function\s*\(|console\./.test(t) && t.length < 200) { return false; }
    return true;
  }

  function hasBlockChild(el) {
    for (let i = 0; i < el.children.length; i++) {
      if (BLOCK_TAGS.has(el.children[i].tagName)) { return true; }
    }
    return false;
  }

  // 找到"最内层的块级容器"作为插入锚点，避免把整页或整栏当成一段
  function findUnit(start) {
    let el = start;
    while (el && el !== document.body && el !== document.documentElement) {
      if (BLOCK_TAGS.has(el.tagName) && !hasBlockChild(el)) { return el; }
      el = el.parentElement;
    }
    return null;
  }

  function isInInjection(el) {
    return !!(el && el.closest && el.closest('[data-wb-trans], #wb-tr-root'));
  }

  // 整段收集文本：把内联 code / @用户名 / hash 换成占位符，翻译后原样还原
  function collectUnitText(unit) {
    const ph = new Map();
    const parts = [];
    const walker = document.createTreeWalker(unit, NodeFilter.SHOW_TEXT, null);
    let n;
    while ((n = walker.nextNode())) {
      const p = n.parentElement;
      const raw = n.nodeValue || '';
      if (p && isInInjection(p)) { continue; }
      if (p && p.closest && p.closest(skipSel())) { continue; }
      if (cfg.protectInlineCode && p && p.closest && p.closest(PROTECT_SELECTORS)) {
        const val = raw.trim();
        if (!val) { continue; }
        const key = 'WBX' + (PH_BASE + ph.size) + 'XWB';
        ph.set(key, val);
        parts.push(' ' + key + ' ');
      } else {
        parts.push(raw);
      }
    }
    return { text: parts.join(' ').replace(/\s+/g, ' ').trim(), ph: ph };
  }

  function restorePlaceholders(text, ph) {
    if (!ph || !ph.size) { return text; }
    let out = text;
    const byId = new Map();
    ph.forEach(function (val, key) {
      const id = (key.match(/\d+/) || ['0'])[0];
      byId.set(id, val);
      const strict = new RegExp(key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
      out = out.replace(strict, val);
    });
    // 容错：本地小模型偶尔把 WBX701XWB 写成 BWX701XWB，用数字锚点兜底
    out = out.replace(/\b[A-Za-z]{2,6}\s*(\d{3})\s*[A-Za-z]{2,6}\b/g, function (m, id) {
      return byId.has(id) ? byId.get(id) : m;
    });
    return out;
  }

  function scan(roots) {
    if (!cfg.enabled) { return []; }
    const units = new Set();
    const list = roots && roots.length ? roots : getScanRoots();
    list.forEach(function (root) {
      if (!root || (root.nodeType !== 1 && root.nodeType !== 9)) { return; }
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
      let n;
      while ((n = walker.nextNode())) {
        const t = n.nodeValue;
        if (!t || !/[A-Za-z]/.test(t)) { continue; }
        const p = n.parentElement;
        if (!p || isInInjection(p)) { continue; }
        if (p.closest && p.closest(skipSel())) { continue; }
        let bad = false, cur = p;
        while (cur && cur !== document.body) {
          if (SKIP_TAGS.has(cur.tagName)) { bad = true; break; }
          if (cur.isContentEditable || cur.getAttribute('contenteditable') === 'true') { bad = true; break; }
          cur = cur.parentElement;
        }
        if (bad) { continue; }
        const unit = findUnit(p);
        if (!unit || isInInjection(unit)) { continue; }
        if (unit.dataset.wbTrDone || unit.dataset.wbTrQueued) { continue; }
        if (unit.getClientRects && unit.getClientRects().length === 0) { continue; }
        units.add(unit);
      }
    });

    const groups = new Map();
    let count = 0;
    units.forEach(function (unit) {
      if (count >= (cfg.maxBlocks || 300)) { return; }
      const r = collectUnitText(unit);
      if (!isEnglish(r.text) || r.text.length > 900) { return; }
      // 同一段文字里的占位符内容可能不同，缓存键必须包含占位符原值
      const key = r.ph.size ? r.text + ' :: ' + Array.from(r.ph.values()).join('\u0001') : r.text;
      let g = groups.get(key);
      if (!g) { g = { key: key, text: r.text, ph: r.ph, els: [] }; groups.set(key, g); count++; }
      g.els.push(unit);
    });
    return Array.from(groups.values());
  }

  // ------------------------------------------------------------------
  // 8. 插入 / 切换 / 清除译文
  // ------------------------------------------------------------------
  let stat = { done: 0, failed: 0, queued: 0 };

  function insertTranslation(el, text) {
    Array.from(el.children).forEach(function (c) {
      if (c.classList && c.classList.contains('wb-trans')) { c.remove(); }
    });
    const span = document.createElement('span');
    span.className = 'wb-trans';
    span.setAttribute('data-wb-trans', '1');
    span.setAttribute('data-wb-pos', cfg.position);
    span.textContent = text;                      // 用 textContent，杜绝 XSS
    span.title = 'WorkBuddy 双语对照 · 单击淡化 / 恢复';
    span.addEventListener('click', function () { span.classList.toggle('wb-faded'); });
    if (cfg.position === 'above') { el.insertBefore(span, el.firstChild); }
    else { el.appendChild(span); }
    el.dataset.wbTrDone = '1';
    el.removeAttribute('data-wb-tr-queued');
  }

  function insertGroup(g, text) {
    const final = restorePlaceholders(text, g.ph);
    g.els.forEach(function (el) { insertTranslation(el, final); });
    stat.done += g.els.length;
  }

  function repositionAll() {
    document.querySelectorAll('[data-wb-tr-done]').forEach(function (el) {
      const t = Array.from(el.children).find(function (c) {
        return c.classList && c.classList.contains('wb-trans');
      });
      if (!t) { return; }
      t.setAttribute('data-wb-pos', cfg.position);
      if (cfg.position === 'above') { el.insertBefore(t, el.firstChild); }
      else { el.appendChild(t); }
    });
  }

  function clearTranslations() {
    document.querySelectorAll('.wb-trans').forEach(function (n) { n.remove(); });
    document.querySelectorAll('[data-wb-tr-done], [data-wb-tr-queued]').forEach(function (el) {
      el.removeAttribute('data-wb-tr-done');
      el.removeAttribute('data-wb-tr-queued');
    });
    if (io) { io.disconnect(); io = null; }
    el2group.clear();
    pendingRoots.length = 0;
    stat = { done: 0, failed: 0, queued: 0 };
    updateBadge();
  }

  // ------------------------------------------------------------------
  // 9. 懒加载 + 动态内容 + SPA 导航监听
  // ------------------------------------------------------------------
  let io = null;
  const el2group = new Map();

  function ensureIO() {
    if (io) { return io; }
    io = new IntersectionObserver(function (entries) {
      const hit = new Set();
      entries.forEach(function (e) {
        if (!e.isIntersecting) { return; }
        io.unobserve(e.target);
        const g = el2group.get(e.target);
        if (g) { hit.add(g); }
      });
      const list = Array.from(hit);
      list.forEach(function (g) {
        g.els.forEach(function (el) { io.unobserve(el); el2group.delete(el); });
      });
      if (list.length) { enqueue(list); }
    }, { rootMargin: '400px 0px', threshold: 0 });
    return io;
  }

  function scheduleItems(groups) {
    if (!groups.length) { return; }
    if (!cfg.lazy) { enqueue(groups); return; }
    const observer = ensureIO();
    groups.forEach(function (g) {
      g.els.forEach(function (el) {
        el.dataset.wbTrQueued = '1';
        el2group.set(el, g);
        observer.observe(el);
      });
    });
    stat.queued += groups.length;
    updateBadge();
  }

  function enqueue(groups, attempt) {
    const todo = [];
    groups.forEach(function (g) {
      const c = cacheGet(g.key);
      if (c !== undefined) {
        g.els.forEach(function (el) { el.removeAttribute('data-wb-tr-queued'); });
        insertGroup(g, c); return;
      }
      g.els.forEach(function (el) { el.dataset.wbTrQueued = '1'; });
      todo.push(g);
    });
    if (!todo.length) { updateBadge(); return; }
    const maxChars = cfg.source === 'local' ? 1600 : cfg.source === 'baidu' ? 1000 : 600;
    const maxCount = cfg.source === 'local' ? 20 : 12;
    pack(todo, maxChars, maxCount).forEach(function (batch) {
      processBatch(batch, attempt || 0).catch(function () { /* 状态已在内部处理 */ });
    });
    if (!attempt) { stat.queued += todo.length; }
    updateBadge();
  }

  // 限流 / 网络抖动导致的失败不能永久作废，退避后自动重试（最多 2 次）
  function retryGroups(groups, attempt) {
    if (!cfg.enabled) { return; }
    const wait = Math.max(0, cooldownUntil - Date.now()) + 1500 * attempt;
    setTimeout(function () {
      const alive = groups.filter(function (g) {
        return g.els.some(function (el) { return el.isConnected && !el.dataset.wbTrDone; });
      });
      if (alive.length) { enqueue(alive, attempt); }
    }, wait);
  }

  async function processBatch(groups, attempt) {
    const texts = groups.map(function (g) { return g.text; });
    let results = null;
    try {
      results = await scheduled(texts);
    } catch (e) {
      setStatus('批量失败，逐条重试：' + e.message, true);
      results = [];
      for (const t of texts) {
        try { const r = await scheduled([t]); results.push(r[0]); }
        catch (e2) { results.push(null); }
      }
    }
    if (!results || results.length !== texts.length) {
      results = texts.map(function () { return null; });
    }
    const retry = [];
    groups.forEach(function (g, i) {
      const tr = results[i];
      if (tr && tr.trim()) {
        g.els.forEach(function (el) { el.removeAttribute('data-wb-tr-queued'); });
        stat.queued = Math.max(0, stat.queued - 1);
        cacheSet(g.key, tr.trim());
        insertGroup(g, tr.trim());
      } else if ((attempt || 0) < 2) {
        retry.push(g);   // 保留 queued 标记，等退避后重试
      } else {
        g.els.forEach(function (el) { el.removeAttribute('data-wb-tr-queued'); });
        stat.queued = Math.max(0, stat.queued - 1);
        stat.failed += g.els.length;
      }
    });
    updateBadge();
    if (retry.length) {
      setStatus('部分段落翻译失败，正在自动重试', true);
      retryGroups(retry, (attempt || 0) + 1);
    }
  }

  let mo = null, scanTimer = 0;
  const pendingRoots = [];
  function startObserver() {
    if (mo) { return; }
    mo = new MutationObserver(function (muts) {
      if (!cfg.enabled || !cfg.auto || !runAllowed) { return; }
      muts.forEach(function (m) {
        Array.from(m.addedNodes).forEach(function (n) {
          if (n.nodeType !== 1) { return; }
          // 只过滤脚本自己插入的译文 / 面板，避免自触发循环
          if (n.matches && n.matches('[data-wb-trans], #wb-tr-root')) { return; }
          if (n.closest && n.closest('#wb-tr-root')) { return; }
          pendingRoots.push(n);
        });
      });
      if (!pendingRoots.length) { return; }
      clearTimeout(scanTimer);
      scanTimer = setTimeout(function () {
        // 累积全部批次，后一批不能覆盖前一批（连续插入时否则会漏翻）
        const roots = pendingRoots.splice(0).filter(function (n) { return n.isConnected; });
        if (!roots.length) { return; }
        try { scheduleItems(scan(roots)); } catch (e) { /* 忽略单次扫描异常 */ }
      }, 700);
    });
    mo.observe(document.body, { childList: true, subtree: true });
  }

  // ---- 滚动补翻：懒加载漏触发 / 折叠内容展开 / 长页面超出单轮上限 ----
  let lastRescan = 0;
  function rescanPage(force) {
    if (!cfg.enabled || !cfg.auto || !runAllowed) { return; }
    const now = Date.now();
    if (!force && now - lastRescan < 1200) { return; }
    lastRescan = now;

    // IntersectionObserver 偶发不回调：已进入视口却仍排队的段落直接入队
    if (cfg.lazy && el2group.size) {
      const stuck = new Set();
      el2group.forEach(function (g, el) {
        if (!el.isConnected || el.dataset.wbTrDone) {
          el2group.delete(el);
          if (io) { io.unobserve(el); }
          return;
        }
        const r = el.getBoundingClientRect();
        if (r.height > 0 && r.top < window.innerHeight + 300 && r.bottom > -300) { stuck.add(g); }
      });
      if (stuck.size) {
        const list = Array.from(stuck);
        list.forEach(function (g) {
          g.els.forEach(function (el) {
            if (io) { io.unobserve(el); }
            el2group.delete(el);
          });
        });
        enqueue(list);
      }
    }
    // 全页重扫：只捡尚未排队 / 未翻译的段落，长页面滚动几次即可全部覆盖
    try { scheduleItems(scan(getScanRoots())); } catch (e) { /* 忽略单次扫描异常 */ }
  }

  function startScrollWatch() {
    let timer = 0;
    const onChange = function () {
      if (cfg.rescanOnScroll === false) { return; }
      clearTimeout(timer);
      timer = setTimeout(function () { rescanPage(false); }, 350);
    };
    window.addEventListener('scroll', onChange, { passive: true });
    window.addEventListener('resize', onChange, { passive: true });
  }

  // 初始识别可能落在验证页 / 骨架屏上，之后正文渲染完必须重新判定
  let watchdog = 0;
  function startWatchdog() {
    if (watchdog) { return; }
    watchdog = setInterval(function () {
      updateBadge();                     // 让限流倒计时可见
      if (!cfg.enabled || !cfg.auto || siteBlocked() || runAllowed) { return; }
      detection = detectPage();
      const r = shouldRun(detection);
      if (r.run) {
        runAllowed = true;
        updateDetectInfo(r);
        setStatus('页面正文已就绪，开始自动翻译');
        rescanPage(true);
      } else if (r.pending) {
        updateDetectInfo(r);
      }
    }, 2500);
  }

  let lastPageKey = '';
  function pageKey() { return location.origin + location.pathname + location.search; }
  function startNavWatch() {
    lastPageKey = pageKey();
    const onChange = function () {
      if (pageKey() === lastPageKey) { return; }
      lastPageKey = pageKey();
      onPageChanged();
    };
    // GitHub 用 Turbo 做无刷新跳转，页面内容换了但脚本不会重新注入
    ['turbo:load', 'turbo:visit', 'pjax:end', 'popstate'].forEach(function (ev) {
      window.addEventListener(ev, function () { setTimeout(onChange, 120); });
    });
    setInterval(onChange, 1500);   // 兜底：history.pushState 不触发事件
  }
  function onPageChanged() {
    clearTranslations();
    _skipCache = '';
    detection = detectPage();
    const r = shouldRun(detection);
    runAllowed = r.run && !siteBlocked();
    updateDetectInfo(r);
    if (!runAllowed) { setStatus(r.reason); return; }
    setTimeout(function () { startObserver(); translatePage(true); }, 600);
  }

  function translatePage(force) {
    if (!force && !runAllowed) {
      const r = shouldRun(detection);
      setStatus(r.reason);
      updateDetectInfo(r);
      return;
    }
    scheduleItems(scan(getScanRoots()));
  }

  // ------------------------------------------------------------------
  // 10. 样式
  // ------------------------------------------------------------------
  const CSS = `
.wb-trans{
  --wb-bg:rgba(56,132,255,.075); --wb-fg:#2258a8; --wb-line:#4a8cf7;
  display:block !important; box-sizing:border-box !important;
  margin:7px 0 9px !important; padding:6px 10px !important;
  border-left:3px solid var(--wb-line) !important; border-radius:0 4px 4px 0 !important;
  background:var(--wb-bg) !important; color:var(--wb-fg) !important;
  font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif !important;
  font-size:.94em !important; font-weight:400 !important; font-style:normal !important;
  line-height:1.72 !important; letter-spacing:normal !important; text-transform:none !important;
  white-space:pre-wrap !important; word-break:break-word !important;
  cursor:pointer !important; opacity:1 !important;
}
.wb-trans::before{
  content:"译" !important; display:inline-block !important; margin-right:8px !important;
  padding:0 5px !important; font-size:.76em !important; line-height:1.55 !important;
  border:1px solid var(--wb-line) !important; border-radius:3px !important;
  opacity:.8 !important; vertical-align:1px !important;
}
.wb-trans[data-wb-pos="above"]{
  border-left-color:transparent !important; border-bottom:1px dashed var(--wb-line) !important;
  border-radius:0 !important; margin:6px 0 10px !important;
}
.wb-trans.wb-faded{opacity:.25 !important;}
html[data-wb-theme="dark"] .wb-trans{
  --wb-bg:rgba(120,170,255,.13); --wb-fg:#a9c9ff; --wb-line:#6fa8ff;
}
@media (prefers-color-scheme:dark){
  html:not([data-wb-theme="light"]) .wb-trans{
    --wb-bg:rgba(120,170,255,.13); --wb-fg:#a9c9ff; --wb-line:#6fa8ff;
  }
}
#wb-tr-root, #wb-tr-root *{
  box-sizing:border-box !important; font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif !important;
  line-height:1.5 !important; letter-spacing:normal !important; text-transform:none !important;
}
#wb-tr-root{
  position:fixed !important; left:18px !important; bottom:18px !important;
  z-index:2147483647 !important; font-size:13px !important; color:#1f2937 !important;
}
/* 半透明毛玻璃「译」图标：静置时透出页面，悬停 / 展开面板时变清晰并轻轻上浮 */
#wb-tr-toggle{
  position:relative !important; width:46px !important; height:46px !important;
  display:block !important; margin-left:0 !important; padding:0 !important;
  border:1px solid rgba(255,255,255,.5) !important; border-radius:50% !important;
  -webkit-appearance:none !important; appearance:none !important;
  background:linear-gradient(145deg,rgba(125,185,255,.62) 0%,rgba(37,99,235,.46) 100%) !important;
  -webkit-backdrop-filter:blur(10px) saturate(160%) !important;
  backdrop-filter:blur(10px) saturate(160%) !important;
  color:#fff !important;
  font-size:17px !important; font-weight:600 !important; letter-spacing:.5px !important;
  text-shadow:0 1px 3px rgba(15,40,120,.62) !important;
  box-shadow:0 6px 18px rgba(30,64,175,.24), inset 0 1px 0 rgba(255,255,255,.5), inset 0 -7px 14px rgba(30,64,175,.14) !important;
  opacity:.68 !important; cursor:pointer !important;
  transition:opacity .25s ease, transform .25s cubic-bezier(.2,.8,.2,1), box-shadow .25s ease !important;
}
#wb-tr-toggle::after{
  content:"" !important; position:absolute !important; left:9px !important; right:9px !important; top:5px !important;
  height:12px !important; border-radius:50% !important; pointer-events:none !important;
  background:linear-gradient(180deg,rgba(255,255,255,.38),rgba(255,255,255,0)) !important;
}
#wb-tr-toggle:hover, #wb-tr-toggle:focus-visible, #wb-tr-root.wb-open #wb-tr-toggle{
  opacity:.96 !important; transform:translateY(-2px) !important;
  box-shadow:0 10px 26px rgba(30,64,175,.32), inset 0 1px 0 rgba(255,255,255,.62), inset 0 -7px 14px rgba(30,64,175,.14) !important;
}
#wb-tr-toggle:active{transform:translateY(0) scale(.95) !important;}
#wb-tr-toggle.wb-off{
  background:linear-gradient(145deg,rgba(180,192,210,.58),rgba(100,116,139,.46)) !important;
  border-color:rgba(255,255,255,.45) !important; text-shadow:none !important;
  box-shadow:0 5px 15px rgba(71,85,105,.2), inset 0 1px 0 rgba(255,255,255,.42) !important;
}
html[data-wb-theme="dark"] #wb-tr-toggle{
  border-color:rgba(255,255,255,.3) !important;
  background:linear-gradient(145deg,rgba(96,165,250,.6),rgba(29,78,216,.5)) !important;
  box-shadow:0 6px 20px rgba(0,0,0,.42), inset 0 1px 0 rgba(255,255,255,.28) !important;
}
@media (prefers-color-scheme:dark){
  html:not([data-wb-theme="light"]) #wb-tr-toggle{
    border-color:rgba(255,255,255,.3) !important;
    background:linear-gradient(145deg,rgba(96,165,250,.6),rgba(29,78,216,.5)) !important;
    box-shadow:0 6px 20px rgba(0,0,0,.42), inset 0 1px 0 rgba(255,255,255,.28) !important;
  }
}
/* 可选：把图标与面板切回右下角 */
html[data-wb-corner="right"] #wb-tr-root{left:auto !important; right:18px !important;}
html[data-wb-corner="right"] #wb-tr-toggle{margin-left:auto !important;}
#wb-tr-panel{
  width:320px !important; max-height:min(78vh,700px) !important; overflow-y:auto !important;
  margin-bottom:10px !important; padding:14px !important;
  background:rgba(255,255,255,.88) !important; color:#1f2937 !important;
  border:1px solid rgba(255,255,255,.72) !important; border-radius:14px !important;
  -webkit-backdrop-filter:blur(18px) saturate(160%) !important;
  backdrop-filter:blur(18px) saturate(160%) !important;
  box-shadow:0 12px 38px rgba(15,23,42,.16), inset 0 1px 0 rgba(255,255,255,.8) !important;
  animation:wb-panel-in .2s ease-out !important;
}
@keyframes wb-panel-in{
  from{opacity:0; transform:translateY(6px);}
  to{opacity:1; transform:translateY(0);}
}
html[data-wb-theme="dark"] #wb-tr-panel{
  background:rgba(31,36,48,.88) !important; color:#e5e7eb !important;
  border-color:rgba(255,255,255,.08) !important;
  box-shadow:0 12px 38px rgba(0,0,0,.4), inset 0 1px 0 rgba(255,255,255,.06) !important;
}
@media (prefers-color-scheme:dark){
  html:not([data-wb-theme="light"]) #wb-tr-panel{
    background:rgba(31,36,48,.88) !important; color:#e5e7eb !important;
    border-color:rgba(255,255,255,.08) !important;
    box-shadow:0 12px 38px rgba(0,0,0,.4), inset 0 1px 0 rgba(255,255,255,.06) !important;
  }
}
@media (prefers-reduced-motion:reduce){
  #wb-tr-toggle{transition:none !important;}
  #wb-tr-panel{animation:none !important;}
}
#wb-tr-panel h3{margin:0 0 10px !important; font-size:14px !important; font-weight:700 !important; color:inherit !important; display:flex !important; justify-content:space-between !important;}
#wb-tr-panel h3 span{cursor:pointer !important; color:#9ca3af !important; font-weight:400 !important;}
#wb-detect{
  font-size:11px !important; line-height:1.6 !important; white-space:pre-line !important;
  padding:7px 9px !important; margin-bottom:10px !important; border-radius:6px !important;
  background:rgba(37,99,235,.07) !important; color:#3b5b8c !important;
  word-break:break-all !important;
}
html[data-wb-theme="dark"] #wb-detect{background:rgba(120,170,255,.12) !important; color:#a9c9ff !important;}
@media (prefers-color-scheme:dark){
  html:not([data-wb-theme="light"]) #wb-detect{background:rgba(120,170,255,.12) !important; color:#a9c9ff !important;}
}
#wb-tr-panel .row{display:flex !important; align-items:center !important; justify-content:space-between !important; gap:8px !important; margin:9px 0 !important;}
#wb-tr-panel label{margin:0 !important; font-size:12px !important; color:inherit !important; flex:0 0 auto !important;}
#wb-tr-panel input[type=text], #wb-tr-panel input[type=number], #wb-tr-panel input[type=password], #wb-tr-panel select{
  flex:1 1 auto !important; min-width:0 !important; padding:5px 7px !important;
  border:1px solid #d1d5db !important; border-radius:6px !important;
  background:transparent !important; color:inherit !important; font-size:12px !important; outline:none !important;
}
#wb-tr-panel input[type=checkbox]{accent-color:#2563eb !important; width:15px !important; height:15px !important; margin:0 !important;}
#wb-tr-panel .seg{display:flex !important; gap:4px !important;}
#wb-tr-panel .seg button, #wb-tr-panel .btn{
  flex:1 1 auto !important; padding:6px 8px !important; border:1px solid #d1d5db !important;
  border-radius:6px !important; background:transparent !important; color:inherit !important;
  font-size:12px !important; cursor:pointer !important;
}
#wb-tr-panel .seg button.on{background:#2563eb !important; border-color:#2563eb !important; color:#fff !important;}
#wb-tr-panel .btn:hover, #wb-tr-panel .seg button:hover{border-color:#2563eb !important;}
#wb-tr-panel hr{border:none !important; border-top:1px solid #e5e7eb !important; margin:12px 0 !important;}
#wb-tr-status{font-size:11px !important; line-height:1.6 !important; color:#6b7280 !important; word-break:break-all !important;}
#wb-tr-status.err{color:#dc2626 !important;}
#wb-tr-tip{font-size:11px !important; color:#9ca3af !important; margin-top:8px !important; line-height:1.6 !important;}
.wb-sel-bubble{
  position:fixed !important; z-index:2147483647 !important; max-width:340px !important;
  padding:9px 12px !important; border-radius:8px !important;
  background:#fff !important; color:#1f2937 !important; border:1px solid #d1d5db !important;
  box-shadow:0 6px 24px rgba(0,0,0,.18) !important; font-size:13px !important;
  line-height:1.6 !important; white-space:pre-wrap !important;
}
@media (prefers-color-scheme:dark){.wb-sel-bubble{background:#1f2430 !important; color:#e5e7eb !important; border-color:#3a4150 !important;}}
`;

  // ------------------------------------------------------------------
  // 11. 设置面板 / 状态 / 快捷键 / 划词
  // ------------------------------------------------------------------
  let rootEl = null, panelEl = null, toggleEl = null, statusEl = null;

  function setStatus(msg, isErr) {
    if (!statusEl) { return; }
    statusEl.textContent = msg;
    statusEl.classList.toggle('err', !!isErr);
  }

  function updateDetectInfo(r) {
    if (!rootEl) { return; }
    const el = rootEl.querySelector('#wb-detect');
    if (!el) { return; }
    const d = detection || detectPage();
    r = r || shouldRun(d);
    el.textContent = '网页识别：' + d.label + ' · 中文占比 ' + (d.cjkRatio * 100).toFixed(1) + '%\n' +
      (r.run ? '状态：启用翻译' : '状态：已跳过') + '（' + r.reason + '）';
  }

  function updateBadge() {
    if (!statusEl) { return; }
    statusEl.classList.remove('err');
    statusEl.textContent = '源：' + (SOURCE_LABEL[cfg.source] || cfg.source) +
      ' · 已译 ' + stat.done + ' 段' +
      (stat.queued ? ' · 队列 ' + stat.queued : '') +
      (stat.failed ? ' · 失败 ' + stat.failed : '') +
      ' · 缓存 ' + Object.keys(cache).length + ' 条';
    const cd = Math.ceil((cooldownUntil - Date.now()) / 1000);
    if (cd > 0) { statusEl.textContent += ' · 限流中 ' + cd + 's 后自动继续'; }
    if (toggleEl) { toggleEl.classList.toggle('wb-off', !cfg.enabled); }
  }

  function applyTheme() {
    if (cfg.theme === 'auto') { document.documentElement.removeAttribute('data-wb-theme'); }
    else { document.documentElement.setAttribute('data-wb-theme', cfg.theme); }
  }

  function applyCorner() {
    if (cfg.corner === 'right') { document.documentElement.setAttribute('data-wb-corner', 'right'); }
    else { document.documentElement.removeAttribute('data-wb-corner'); }
  }

  // 面板显隐统一走这里，顺便让图标在展开时保持清晰
  function setPanel(show) {
    if (!panelEl || !rootEl) { return; }
    panelEl.style.display = show ? 'block' : 'none';
    rootEl.classList.toggle('wb-open', !!show);
    if (show) { syncUI(); }
  }

  function buildUI() {
    rootEl = document.createElement('div');
    rootEl.id = 'wb-tr-root';
    rootEl.innerHTML = `
      <div id="wb-tr-panel" style="display:none">
        <h3>网页英译中 · 双语对照 <span id="wb-tr-close">关闭 ✕</span></h3>
        <div id="wb-detect"></div>
        <div class="row"><label>启用翻译</label><input type="checkbox" id="c-enabled"></div>
        <div class="row"><label>译文位置</label>
          <div class="seg" style="flex:1">
            <button data-pos="above">英文上方</button><button data-pos="below">英文下方</button>
          </div>
        </div>
        <div class="row"><label>图标位置</label>
          <div class="seg" style="flex:1">
            <button data-corner="left">左下角</button><button data-corner="right">右下角</button>
          </div>
        </div>
        <hr>
        <div class="row"><label>自动识别网页</label><input type="checkbox" id="c-detect"></div>
        <div class="row"><label>运行范围</label>
          <select id="c-sitemode">
            <option value="auto">自动（白名单 + 纯英文页面）</option>
            <option value="whitelist">仅白名单站点</option>
            <option value="all">所有网站（不判断）</option>
          </select>
        </div>
        <div class="row"><label>白名单域名</label><input type="text" id="c-whitelist" placeholder="github.com, docs.github.com"></div>
        <div class="row"><label>中文占比阈值</label><input type="number" id="c-cjk" min="0" max="80" style="width:64px;flex:0 0 auto"> <span style="font-size:11px;color:#9ca3af">% 超过即视为中文站</span></div>
        <div class="row"><label>GitHub 专项适配</label><input type="checkbox" id="c-gh"></div>
        <div class="row"><label>保护内联代码</label><input type="checkbox" id="c-protect"></div>
        <div class="row"><label>只翻正文区域</label><input type="checkbox" id="c-main"></div>
        <hr>
        <div class="row"><label>翻译源</label>
          <select id="c-source">
            <option value="youdao">有道（国内在线·免注册）</option>
            <option value="baidu">百度翻译开放平台</option>
            <option value="local">本地离线服务</option>
          </select>
        </div>
        <div class="row"><label>失败自动回退</label><input type="checkbox" id="c-fallback"></div>
        <div id="wb-baidu-cfg" style="display:none">
          <div class="row"><label>appid</label><input type="text" id="c-appid" placeholder="百度翻译开放平台 appid"></div>
          <div class="row"><label>密钥</label><input type="password" id="c-key" placeholder="密钥"></div>
        </div>
        <div id="wb-local-cfg" style="display:none">
          <div class="row"><label>接口协议</label>
            <select id="c-protocol">
              <option value="libre">LibreTranslate / 自建服务</option>
              <option value="ollama">Ollama</option>
              <option value="openai">OpenAI 兼容（LM Studio 等）</option>
            </select>
          </div>
          <div class="row"><label>地址</label><input type="text" id="c-url" placeholder="http://127.0.0.1:8787/translate"></div>
          <div class="row"><label>模型名</label><input type="text" id="c-model" placeholder="qwen2.5:3b"></div>
        </div>
        <hr>
        <div class="row"><label>自动翻译</label><input type="checkbox" id="c-auto"></div>
        <div class="row"><label>仅翻译可见区域</label><input type="checkbox" id="c-lazy"></div>
        <div class="row"><label>滚动时补翻遗漏段落</label><input type="checkbox" id="c-rescan"></div>
        <div class="row"><label>划词翻译 (Alt+S)</label><input type="checkbox" id="c-selection"></div>
        <div class="row"><label>最短段落</label><input type="number" id="c-min" min="6" max="200" style="width:70px;flex:0 0 auto"> <span style="font-size:11px;color:#9ca3af">字符</span></div>
        <div class="row"><label>配色</label>
          <select id="c-theme"><option value="auto">跟随系统</option><option value="light">浅色</option><option value="dark">深色</option></select>
        </div>
        <hr>
        <div class="row"><button class="btn" id="b-now">立即翻译本页</button><button class="btn" id="b-test">测试翻译源</button></div>
        <div class="row"><button class="btn" id="b-clear">清除本页译文</button><button class="btn" id="b-cache">清空缓存</button></div>
        <div class="row"><label>本站不翻译</label><button class="btn" id="b-block">加入黑名单 / 移出</button></div>
        <div id="wb-tr-status"></div>
        <div id="wb-tr-tip">快捷键：Alt+T 开关 · Alt+P 上/下切换 · Alt+Enter 翻译本页 · Alt+S 划词<br>「立即翻译本页」可强制翻译被自动识别跳过的页面。</div>
      </div>
      <button id="wb-tr-toggle" title="网页英译中 · 双语对照（点击展开设置）">译</button>
    `;
    document.body.appendChild(rootEl);
    panelEl = rootEl.querySelector('#wb-tr-panel');
    toggleEl = rootEl.querySelector('#wb-tr-toggle');
    statusEl = rootEl.querySelector('#wb-tr-status');

    const $ = function (id) { return rootEl.querySelector(id); };
    toggleEl.addEventListener('click', function () {
      setPanel(panelEl.style.display === 'none');
    });
    $('#wb-tr-close').addEventListener('click', function () { setPanel(false); });

    $('#c-enabled').addEventListener('change', function (e) {
      cfg.enabled = e.target.checked; saveCfg();
      if (!cfg.enabled) { clearTranslations(); } else { translatePage(true); startObserver(); }
      updateBadge();
    });
    rootEl.querySelectorAll('[data-pos]').forEach(function (b) {
      b.addEventListener('click', function () {
        cfg.position = b.dataset.pos; saveCfg(); repositionAll(); syncUI();
      });
    });
    rootEl.querySelectorAll('[data-corner]').forEach(function (b) {
      b.addEventListener('click', function () {
        cfg.corner = b.dataset.corner; saveCfg(); applyCorner(); syncUI();
      });
    });

    // 网页识别相关设置变更后重新判定并刷新译文
    $('#c-detect').addEventListener('change', function (e) { cfg.autoDetect = e.target.checked; saveCfg(); onPageChanged(); });
    $('#c-sitemode').addEventListener('change', function (e) { cfg.siteMode = e.target.value; saveCfg(); onPageChanged(); });
    $('#c-whitelist').addEventListener('change', function (e) {
      cfg.siteWhitelist = e.target.value.split(/[,，\s]+/).filter(Boolean); saveCfg(); onPageChanged();
    });
    $('#c-cjk').addEventListener('change', function (e) {
      cfg.cjkThreshold = Math.max(0, Math.min(80, parseInt(e.target.value, 10) || 2)); saveCfg(); onPageChanged();
    });
    $('#c-gh').addEventListener('change', function (e) { cfg.githubTweaks = e.target.checked; saveCfg(); onPageChanged(); });
    $('#c-protect').addEventListener('change', function (e) { cfg.protectInlineCode = e.target.checked; saveCfg(); onPageChanged(); });
    $('#c-main').addEventListener('change', function (e) { cfg.preferMainContent = e.target.checked; saveCfg(); onPageChanged(); });

    $('#c-source').addEventListener('change', function (e) {
      cfg.source = e.target.value; saveCfg(); syncUI(); updateBadge();
    });
    $('#c-fallback').addEventListener('change', function (e) { cfg.autoFallback = e.target.checked; saveCfg(); });
    $('#c-appid').addEventListener('change', function (e) { cfg.baiduAppid = e.target.value.trim(); saveCfg(); });
    $('#c-key').addEventListener('change', function (e) { cfg.baiduKey = e.target.value.trim(); saveCfg(); });
    $('#c-protocol').addEventListener('change', function (e) {
      const old = cfg.localProtocol;
      cfg.localProtocol = e.target.value;
      if (!cfg.localUrl || cfg.localUrl === LOCAL_DEFAULTS[old]) { cfg.localUrl = LOCAL_DEFAULTS[cfg.localProtocol]; }
      saveCfg(); syncUI();
    });
    $('#c-url').addEventListener('change', function (e) { cfg.localUrl = e.target.value.trim(); saveCfg(); });
    $('#c-model').addEventListener('change', function (e) { cfg.localModel = e.target.value.trim(); saveCfg(); });
    $('#c-auto').addEventListener('change', function (e) { cfg.auto = e.target.checked; saveCfg(); if (cfg.auto) { startObserver(); translatePage(true); } });
    $('#c-lazy').addEventListener('change', function (e) { cfg.lazy = e.target.checked; saveCfg(); });
    $('#c-rescan').addEventListener('change', function (e) { cfg.rescanOnScroll = e.target.checked; saveCfg(); });
    $('#c-selection').addEventListener('change', function (e) { cfg.selection = e.target.checked; saveCfg(); });
    $('#c-min').addEventListener('change', function (e) { cfg.minChars = Math.max(6, parseInt(e.target.value, 10) || 20); saveCfg(); });
    $('#c-theme').addEventListener('change', function (e) { cfg.theme = e.target.value; saveCfg(); applyTheme(); });

    $('#b-now').addEventListener('click', function () { translatePage(true); setStatus('已扫描本页，正在翻译…'); });
    $('#b-clear').addEventListener('click', function () { clearTranslations(); setStatus('已清除本页译文'); });
    $('#b-cache').addEventListener('click', function () {
      cache = {}; cacheDirty = true; flushCache(); setStatus('缓存已清空');
    });
    $('#b-block').addEventListener('click', function () {
      const host = location.hostname || location.href;
      const i = cfg.blockedSites.indexOf(host);
      if (i >= 0) { cfg.blockedSites.splice(i, 1); } else { cfg.blockedSites.push(host); }
      saveCfg(); location.reload();
    });
    $('#b-test').addEventListener('click', async function () {
      setStatus('正在测试：Hello world');
      try {
        const r = await scheduled(['Hello world, this is a connection test.']);
        setStatus('测试成功：' + r[0]);
      } catch (e) { setStatus('测试失败：' + e.message, true); }
    });

    syncUI();
    updateBadge();
    updateDetectInfo();
  }

  function syncUI() {
    if (!rootEl) { return; }
    const $ = function (id) { return rootEl.querySelector(id); };
    $('#c-enabled').checked = cfg.enabled;
    $('#c-source').value = cfg.source;
    $('#c-fallback').checked = cfg.autoFallback;
    $('#c-appid').value = cfg.baiduAppid;
    $('#c-key').value = cfg.baiduKey;
    $('#c-protocol').value = cfg.localProtocol;
    $('#c-url').value = cfg.localUrl;
    $('#c-model').value = cfg.localModel;
    $('#c-auto').checked = cfg.auto;
    $('#c-lazy').checked = cfg.lazy;
    $('#c-rescan').checked = cfg.rescanOnScroll !== false;
    $('#c-selection').checked = cfg.selection;
    $('#c-min').value = cfg.minChars;
    $('#c-theme').value = cfg.theme;
    $('#c-detect').checked = cfg.autoDetect;
    $('#c-sitemode').value = cfg.siteMode;
    $('#c-whitelist').value = (cfg.siteWhitelist || []).join(', ');
    $('#c-cjk').value = cfg.cjkThreshold;
    $('#c-gh').checked = cfg.githubTweaks;
    $('#c-protect').checked = cfg.protectInlineCode;
    $('#c-main').checked = cfg.preferMainContent;
    rootEl.querySelectorAll('[data-pos]').forEach(function (b) {
      b.classList.toggle('on', b.dataset.pos === cfg.position);
    });
    rootEl.querySelectorAll('[data-corner]').forEach(function (b) {
      b.classList.toggle('on', b.dataset.corner === (cfg.corner || 'left'));
    });
    $('#wb-baidu-cfg').style.display = cfg.source === 'baidu' ? 'block' : 'none';
    $('#wb-local-cfg').style.display = cfg.source === 'local' ? 'block' : 'none';
    const host = location.hostname || location.href;
    $('#b-block').textContent = cfg.blockedSites.indexOf(host) >= 0 ? '移出黑名单' : '加入黑名单';
  }

  function toggleEnabled() {
    cfg.enabled = !cfg.enabled; saveCfg();
    if (!cfg.enabled) { clearTranslations(); } else { startObserver(); translatePage(true); }
    if (IS_TOP) { syncUI(); updateBadge(); }
  }
  function togglePosition() {
    cfg.position = cfg.position === 'below' ? 'above' : 'below';
    saveCfg(); repositionAll();
    if (IS_TOP) { syncUI(); }
    setStatus('译文位置：英文' + (cfg.position === 'below' ? '下方' : '上方'));
  }

  function bindKeys() {
    document.addEventListener('keydown', function (e) {
      if (!e.altKey) { return; }
      const k = e.key.toLowerCase();
      if (k === 't') { e.preventDefault(); toggleEnabled(); }
      else if (k === 'p') { e.preventDefault(); togglePosition(); }
      else if (e.key === 'Enter') { e.preventDefault(); translatePage(true); setStatus('已扫描本页，正在翻译…'); }
      else if (k === 's' && cfg.selection) { e.preventDefault(); translateSelection(); }
    });
  }

  async function translateSelection() {
    const sel = window.getSelection();
    const t = sel ? sel.toString().replace(/\s+/g, ' ').trim() : '';
    if (!t || !/[A-Za-z]/.test(t)) { return; }
    let rect = { left: 20, top: 20, bottom: 40 };
    try { rect = sel.getRangeAt(0).getBoundingClientRect(); } catch (e) { /* 忽略 */ }
    const bubble = document.createElement('div');
    bubble.className = 'wb-sel-bubble';
    bubble.textContent = '翻译中…';
    bubble.style.left = Math.max(8, Math.min(rect.left, innerWidth - 350)) + 'px';
    bubble.style.top = Math.min(rect.bottom + 8, innerHeight - 90) + 'px';
    document.body.appendChild(bubble);
    try {
      const r = await scheduled([t]);
      bubble.textContent = r[0] || '翻译失败';
    } catch (e) { bubble.textContent = '翻译失败：' + e.message; }
    setTimeout(function () { bubble.remove(); }, 6000);
  }

  function registerMenus() {
    try {
      GM_registerMenuCommand('开启 / 暂停翻译 (Alt+T)', toggleEnabled);
      GM_registerMenuCommand('译文位置：上 / 下 (Alt+P)', togglePosition);
      GM_registerMenuCommand('立即翻译本页 (Alt+Enter)', function () { translatePage(true); });
      GM_registerMenuCommand('清除本页译文', clearTranslations);
      GM_registerMenuCommand('重新识别本网页', onPageChanged);
      GM_registerMenuCommand('打开设置面板', function () { setPanel(true); });
    } catch (e) { /* 某些管理器不支持菜单 */ }
  }

  // ------------------------------------------------------------------
  // 12. 启动
  // ------------------------------------------------------------------
  function init() {
    if (!document.body) { return; }
    // 幂等：同一页面已注入过实例时直接退出（例如同时装了 Chrome 扩展版与油猴版）
    if (document.getElementById('wb-tr-root')) { return; }
    GM_addStyle(CSS);
    applyTheme();
    applyCorner();

    detection = detectPage();
    const r = shouldRun(detection);
    runAllowed = r.run && !siteBlocked();

    if (IS_TOP) { buildUI(); registerMenus(); bindKeys(); updateDetectInfo(r); }
    if (siteBlocked()) { setStatus('该站点在黑名单中，已跳过'); return; }

    // 即使初次判定为跳过，也要启动监听：验证页 / 延迟渲染的正文随后会自动接管
    startObserver();
    startNavWatch();
    startScrollWatch();
    startWatchdog();
    if (!runAllowed) {
      setStatus(r.reason + (r.pending ? '（正文加载完成后会自动重判）' : ''));
      return;
    }
    if (cfg.enabled && cfg.auto) { setTimeout(function () { translatePage(true); }, 600); }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else { init(); }
})();
