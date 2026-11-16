'use strict';

// 1) 跨域请求代理：content script 的 GM_xmlhttpRequest 统一转到后台 fetch，
//    借助 host_permissions 绕开页面 CORS 限制（等价于油猴的 @connect）。
// 2) 主脚本注入：桥接层把配置读进内存后，等 DOM 可用再通知这里注入 userscript.js。

const INJECTED = new Set();

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg || typeof msg !== 'object') { return; }

  if (msg.type === 'wb-inject') {
    injectMain(sender.tab, sender.frameId).then(
      function (r) { sendResponse(r); },
      function (e) { sendResponse({ ok: false, error: String((e && e.message) || e) }); }
    );
    return true;
  }

  if (msg.type === 'wb-fetch') {
    fetchProxy(msg.req).then(sendResponse, function (e) {
      sendResponse({ ok: false, error: String((e && e.message) || e) });
    });
    return true;
  }

  return false;
});

async function injectMain(tab, frameId) {
  if (!tab || tab.id == null) { return { ok: false, error: 'no tab' }; }
  const fid = typeof frameId === 'number' ? frameId : 0;
  const key = tab.id + ':' + fid;
  if (INJECTED.has(key)) { return { ok: true, skipped: true }; }
  INJECTED.add(key);
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id, frameIds: [fid] },
      files: ['content/userscript.js']
    });
    return { ok: true };
  } catch (e) {
    INJECTED.delete(key);
    return { ok: false, error: String((e && e.message) || e) };
  }
}

function clearTab(tabId) {
  for (const key of Array.from(INJECTED)) {
    if (key.indexOf(tabId + ':') === 0) { INJECTED.delete(key); }
  }
}

chrome.tabs.onUpdated.addListener(function (tabId, info) {
  if (info && info.status === 'loading') { clearTab(tabId); }
});
chrome.tabs.onRemoved.addListener(function (tabId) { clearTab(tabId); });

async function fetchProxy(req) {
  if (!req || !req.url) { return { ok: false, error: '缺少 url' }; }
  const method = String(req.method || 'GET').toUpperCase();
  const timeout = Math.max(1000, Math.min(60000, Number(req.timeout) || 20000));
  const ctrl = new AbortController();
  const timer = setTimeout(function () { ctrl.abort(); }, timeout);

  try {
    const headers = Object.assign({}, req.headers || {});
    // 扩展发起的跨域请求若带 Referer/Origin 容易被第三方接口拒绝，尽量贴近用户脚本的行为
    delete headers.Referer;
    delete headers.referer;

    const init = {
      method: method,
      headers: headers,
      signal: ctrl.signal,
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      cache: 'no-store',
      redirect: 'follow'
    };
    if (req.data != null && method !== 'GET' && method !== 'HEAD') {
      init.body = typeof req.data === 'string' ? req.data : String(req.data);
    }

    const res = await fetch(req.url, init);
    const body = await res.text();
    const lines = [];
    res.headers.forEach(function (value, name) { lines.push(name + ': ' + value); });

    return {
      ok: true,
      status: res.status,
      statusText: res.statusText,
      body: body,
      headers: lines.join('\r\n'),
      finalUrl: res.url
    };
  } catch (e) {
    if (e && e.name === 'AbortError') {
      return { ok: false, timeout: true, error: '请求超时（' + timeout + 'ms）' };
    }
    return { ok: false, error: String((e && e.message) || e) };
  } finally {
    clearTimeout(timer);
  }
}
