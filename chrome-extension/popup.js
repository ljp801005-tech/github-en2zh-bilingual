'use strict';

const CFG_KEY = 'wb_en2zh_cfg_v1';
const SOURCE_LABEL = {
  youdao: '有道（国内在线）',
  baidu: '百度开放平台',
  local: '本地离线服务'
};

document.getElementById('ver').textContent = chrome.runtime.getManifest().version;

chrome.storage.local.get([CFG_KEY], function (stored) {
  let cfg = {};
  try {
    cfg = JSON.parse((stored && stored[CFG_KEY]) || '{}') || {};
  } catch (e) {
    cfg = {};
  }

  document.getElementById('src').textContent = SOURCE_LABEL[cfg.source] || '有道（国内在线）';
  document.getElementById('pos').textContent = cfg.position === 'above' ? '英文上方' : '英文下方';

  const enabled = cfg.enabled !== false;
  const state = document.getElementById('state');
  state.textContent = enabled ? '已启用' : '已暂停';
  state.className = enabled ? 'on' : 'off';
});
