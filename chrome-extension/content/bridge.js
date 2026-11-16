'use strict';

// 油猴脚本 → Chrome 扩展的桥接层。
// 1. 先用 chrome.storage.local 把配置读进内存，让同步的 GM_getValue 能拿到已保存的配置；
// 2. 提供 GM_setValue / GM_addStyle / GM_registerMenuCommand / GM_xmlhttpRequest；
// 3. 等 DOM 可用后通知后台注入主脚本（与油猴 @run-at document-idle 时机接近）。

(function () {
  const CFG_KEY = 'wb_en2zh_cfg_v1';
  const CACHE_KEY = 'wb_en2zh_cache_v1';

  const boot = Object.create(null);
  let pending = Object.create(null);
  let flushTimer = null;
  let booted = false;

  function flushNow() {
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    const data = pending;
    pending = Object.create(null);
    if (!Object.keys(data).length) { return; }
    try {
      chrome.storage.local.set(data, function () { void chrome.runtime.lastError; });
    } catch (e) { /* 扩展被重载时忽略 */ }
  }

  function scheduleFlush() {
    if (flushTimer) { return; }
    flushTimer = setTimeout(flushNow, 150);
  }

  // ---------- GM_* 兼容层 ----------
  globalThis.GM_getValue = function (key, def) {
    if (Object.prototype.hasOwnProperty.call(boot, key)) { return boot[key]; }
    return def === undefined ? null : def;
  };

  globalThis.GM_setValue = function (key, value) {
    const str = String(value);
    boot[key] = str;
    pending[key] = str;
    scheduleFlush();
  };

  globalThis.GM_deleteValue = function (key) {
    delete boot[key];
    try { chrome.storage.local.remove(key, function () { void chrome.runtime.lastError; }); } catch (e) {}
  };

  globalThis.GM_addStyle = function (css) {
    const style = document.createElement('style');
    style.textContent = String(css);
    (document.head || document.documentElement).appendChild(style);
    return style;
  };

  // 扩展版不注册用户脚本管理器菜单，功能统一在页面左下角「译」图标里
  globalThis.GM_registerMenuCommand = function () {};

  let seq = 0;
  globalThis.GM_xmlhttpRequest = function (opt) {
    opt = opt || {};
    const id = ++seq;
    let closed = false;

    function call(fn, arg) {
      if (closed) { return; }
      closed = true;
      if (typeof fn === 'function') {
        try { fn(arg); } catch (e) { /* 回调里的异常不影响其它请求 */ }
      }
    }

    const req = {
      id: id,
      method: opt.method || 'GET',
      url: opt.url || '',
      headers: opt.headers || {},
      data: opt.data,
      timeout: opt.timeout || 20000
    };

    try {
      chrome.runtime.sendMessage({ type: 'wb-fetch', req: req }, function (resp) {
        if (chrome.runtime.lastError) {
          call(opt.onerror, { error: chrome.runtime.lastError.message });
          return;
        }
        if (!resp) {
          call(opt.onerror, { error: '扩展后台无响应' });
          return;
        }
        if (resp.ok) {
          call(opt.onload, {
            status: resp.status,
            statusText: resp.statusText,
            responseText: resp.body,
            responseHeaders: resp.headers,
            finalUrl: resp.finalUrl,
            readyState: 4
          });
        } else if (resp.timeout) {
          call(opt.ontimeout, {});
        } else {
          call(opt.onerror, { error: resp.error });
        }
      });
    } catch (e) {
      call(opt.onerror, { error: String(e) });
    }

    return { abort: function () { closed = true; } };
  };

  // ---------- 启动 ----------
  function domReady() {
    if (document.readyState !== 'loading') { return Promise.resolve(); }
    return new Promise(function (resolve) {
      let done = false;
      function go() {
        if (done) { return; }
        done = true;
        document.removeEventListener('DOMContentLoaded', go);
        resolve();
      }
      document.addEventListener('DOMContentLoaded', go, { once: true });
      // 兜底：极少数页面不会触发 DOMContentLoaded（例如被 document.write 改写）
      setTimeout(go, 8000);
    });
  }

  function start(stored) {
    if (booted) { return; }
    booted = true;
    Object.keys(stored || {}).forEach(function (k) {
      if (stored[k] != null) { boot[k] = stored[k]; }
    });

    domReady().then(function () {
      try {
        chrome.runtime.sendMessage({ type: 'wb-inject' }, function () {
          void chrome.runtime.lastError;
        });
      } catch (e) { /* 扩展更新中，下次刷新页面即可 */ }
    });
  }

  window.addEventListener('pagehide', flushNow, { once: true });
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') { flushNow(); }
  });

  try {
    chrome.storage.local.get([CFG_KEY, CACHE_KEY], function (stored) {
      void chrome.runtime.lastError;
      start(stored || {});
    });
  } catch (e) {
    start({});
  }
})();
