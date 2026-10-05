// 前端公共工具
window.App = (() => {
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  function el(tag, attrs = {}, children = []) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else if (k === 'html') node.innerHTML = v;
      else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
      else if (v !== null && v !== undefined && v !== false) node.setAttribute(k, v === true ? '' : v);
    }
    for (const child of [].concat(children)) {
      if (child == null || child === false) continue;
      node.append(child.nodeType ? child : document.createTextNode(String(child)));
    }
    return node;
  }

  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]),
    );
  }

  async function api(method, path, body, token) {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    let resp;
    try {
      resp = await fetch(path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new ApiError(0, 'NETWORK', '无法连接服务器，请检查网络后重试');
    }
    let data = null;
    const text = await resp.text();
    if (text) {
      try { data = JSON.parse(text); } catch { data = null; }
    }
    if (!resp.ok) {
      const message = data?.error?.message ?? `请求失败（HTTP ${resp.status}）`;
      const code = data?.error?.code ?? 'ERROR';
      throw new ApiError(resp.status, code, message);
    }
    return data;
  }

  class ApiError extends Error {
    constructor(status, code, message) {
      super(message);
      this.status = status;
      this.code = code;
    }
  }

  function toast(message, kind = 'info', ms = 3600) {
    let host = $('.toast-host');
    if (!host) {
      host = el('div', { class: 'toast-host' });
      document.body.appendChild(host);
    }
    const node = el('div', { class: `toast ${kind}`, text: message });
    host.appendChild(node);
    setTimeout(() => {
      node.style.transition = 'opacity .25s';
      node.style.opacity = '0';
      setTimeout(() => node.remove(), 260);
    }, ms);
  }

  function pad(n) { return String(n).padStart(2, '0'); }

  function fmtTime(ts) {
    if (!ts) return '—';
    const d = new Date(ts);
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }

  function fmtDateTime(ts) {
    if (!ts) return '—';
    const d = new Date(ts);
    return `${d.getMonth() + 1}月${d.getDate()}日 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function openWS(token, onState, onEvent) {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    let ws = null;
    let closedByUs = false;
    let retry = 0;
    let statusCb = null;

    function setStatus(s) { if (statusCb) statusCb(s); }

    function connect() {
      setStatus('connecting');
      ws = new WebSocket(`${proto}://${location.host}/ws?token=${encodeURIComponent(token)}`);
      ws.onopen = () => { retry = 0; setStatus('connected'); };
      ws.onmessage = (ev) => {
        let msg;
        try { msg = JSON.parse(ev.data); } catch { return; }
        if (msg.type === 'state' && msg.state) onState(msg.state);
        if (msg.type === 'event') onEvent?.(msg);
        if (msg.type === 'error') toast(msg.message || '实时连接错误', 'error');
      };
      ws.onclose = (ev) => {
        setStatus('disconnected');
        if (closedByUs) return;
        // 4401：会话失效，不再重连
        if (ev.code === 4401 || ev.code === 4001) {
          toast('登录已失效，请重新进入', 'error', 6000);
          return;
        }
        retry += 1;
        const wait = Math.min(1000 * retry, 5000);
        setTimeout(connect, wait);
      };
      ws.onerror = () => { try { ws.close(); } catch { /* ignore */ } };
    }

    connect();
    return {
      onStatus(cb) { statusCb = cb; },
      send(obj) { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj)); },
      close() { closedByUs = true; try { ws.close(); } catch { /* ignore */ } },
    };
  }

  return { $, $$, el, esc, api, ApiError, toast, fmtTime, fmtDateTime, openWS };
})();
