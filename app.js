/* DSH — 直连 DeepSeek API 的聊天客户端
 * 单文件、无构建、无后端。API Key 只存在本机 localStorage，绝不写入代码或仓库。
 */
(function () {
  'use strict';

  var API_URL = 'https://api.deepseek.com/chat/completions';
  var LS_KEY = 'dsh.key.v1';
  var LS_CONVOS = 'dsh.convos.v1';
  var LS_SETTINGS = 'dsh.settings.v1';
  var LS_CURRENT = 'dsh.current.v1';

  var SYSTEM_PROMPT = '你是 DSH，一个严谨、直接的中文 AI 助手。回答准确、简洁，不吹嘘、不编造。' +
    '涉及代码时给出可运行的完整片段；不确定的事情明确说明不确定。';

  /* ---------------- 存储 ---------------- */

  function load(key, fallback) {
    try {
      var raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) {
      return fallback;
    }
  }

  function save(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (e) {
      toast('本地存储写入失败，可能是空间已满');
    }
  }

  var settings = Object.assign(
    { model: 'deepseek-flash', thinking: true, effort: 'high' },
    load(LS_SETTINGS, {})
  );
  var apiKey = localStorage.getItem(LS_KEY) || '';
  var convos = load(LS_CONVOS, []);
  var currentId = localStorage.getItem(LS_CURRENT) || null;

  function persistSettings() { save(LS_SETTINGS, settings); }
  function persistConvos() { save(LS_CONVOS, convos); }

  function current() {
    return convos.filter(function (c) { return c.id === currentId; })[0] || null;
  }

  function newConvo() {
    var c = { id: uid(), title: '新会话', messages: [], at: Date.now() };
    convos.unshift(c);
    currentId = c.id;
    persistConvos();
    localStorage.setItem(LS_CURRENT, currentId);
    return c;
  }

  function uid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  /* ---------------- 工具 ---------------- */

  var $ = function (sel) { return document.querySelector(sel); };

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  }

  var toastTimer = null;
  function toast(msg) {
    var el = $('#toast');
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.hidden = true; }, 2200);
  }

  function scrollDown(force) {
    var m = $('#messages');
    var nearBottom = m.scrollHeight - m.scrollTop - m.clientHeight < 140;
    if (force || nearBottom) m.scrollTop = m.scrollHeight;
  }

  /* ---------------- Markdown（子集，先转义再解析，避免注入） ---------------- */

  function inline(text) {
    var out = esc(text);
    out = out.replace(/`([^`\n]+)`/g, function (_, code) { return '<code>' + code + '</code>'; });
    out = out.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
    out = out.replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em>$2</em>');
    out = out.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, function (_, label, url) {
      return '<a href="' + url + '" target="_blank" rel="noopener noreferrer">' + label + '</a>';
    });
    return out;
  }

  function markdown(src) {
    var lines = String(src).replace(/\r\n/g, '\n').split('\n');
    var html = '';
    var i = 0;

    while (i < lines.length) {
      var line = lines[i];

      // 围栏代码块
      var fence = line.match(/^\s*```(\w*)\s*$/);
      if (fence) {
        var buf = [];
        i++;
        while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) { buf.push(lines[i]); i++; }
        i++;
        html += '<pre><code>' + esc(buf.join('\n')) + '</code></pre>';
        continue;
      }

      // 标题
      var head = line.match(/^(#{1,6})\s+(.*)$/);
      if (head) { html += '<h3>' + inline(head[2]) + '</h3>'; i++; continue; }

      // 无序列表
      if (/^\s*[-*+]\s+/.test(line)) {
        var items = [];
        while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
          items.push('<li>' + inline(lines[i].replace(/^\s*[-*+]\s+/, '')) + '</li>');
          i++;
        }
        html += '<ul>' + items.join('') + '</ul>';
        continue;
      }

      // 有序列表
      if (/^\s*\d+[.)]\s+/.test(line)) {
        var oitems = [];
        while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) {
          oitems.push('<li>' + inline(lines[i].replace(/^\s*\d+[.)]\s+/, '')) + '</li>');
          i++;
        }
        html += '<ol>' + oitems.join('') + '</ol>';
        continue;
      }

      // 空行
      if (!line.trim()) { i++; continue; }

      // 段落
      var para = [];
      while (i < lines.length && lines[i].trim() &&
             !/^\s*```/.test(lines[i]) &&
             !/^(#{1,6})\s+/.test(lines[i]) &&
             !/^\s*[-*+]\s+/.test(lines[i]) &&
             !/^\s*\d+[.)]\s+/.test(lines[i])) {
        para.push(lines[i]);
        i++;
      }
      html += '<p>' + inline(para.join('\n')).replace(/\n/g, '<br>') + '</p>';
    }
    return html;
  }

  /* ---------------- 渲染 ---------------- */

  function bubbleHtml(msg) {
    var inner = '';

    if (msg.role === 'assistant' && msg.reasoning) {
      inner += '<details class="think"><summary><span class="dots">已思考</span></summary>' +
        '<div class="think-body">' + esc(msg.reasoning) + '</div></details>';
    }

    inner += '<div class="body">' + (msg.content ? markdown(msg.content) : '') + '</div>';

    if (msg.error) inner += '<div class="err">' + esc(msg.error) + '</div>';

    if (msg.role === 'assistant' && msg.content && !msg.streaming) {
      inner += '<div class="msg-actions"><button class="mini" data-copy="' + msg.id + '">复制</button></div>';
    }

    return '<div class="msg ' + msg.role + '"><div class="bubble" data-bubble="' + msg.id + '">' + inner + '</div></div>';
  }

  function render(forceScroll) {
    var c = current();
    var wrap = $('#messages');

    if (!c || !c.messages.length) {
      wrap.innerHTML = '';
      wrap.appendChild(renderWelcome());
      return;
    }

    wrap.innerHTML = c.messages.map(bubbleHtml).join('');
    wrap.querySelectorAll('[data-copy]').forEach(function (btn) {
      btn.onclick = function () {
        var m = c.messages.filter(function (x) { return x.id === btn.dataset.copy; })[0];
        if (m) copy(m.content);
      };
    });
    scrollDown(forceScroll);
  }

  var welcomeNode = null;
  function renderWelcome() {
    if (!welcomeNode) {
      welcomeNode = document.createElement('section');
      welcomeNode.className = 'welcome';
      var starters = [
        ['解释一个概念', '用三句话解释量子纠缠，不要用比喻'],
        ['写一段脚本', '帮我写一个 Python 脚本，批量把目录里的 PNG 压缩到宽度 1080'],
        ['审一段代码', '下面这段代码有什么问题？请指出并给出修改建议：\n\n'],
        ['中译英', '把这段话翻译成地道的英文，保持技术语气：\n\n']
      ];
      welcomeNode.innerHTML =
        '<div class="welcome-mark" aria-hidden="true">' +
        '<svg viewBox="0 0 256 256"><rect width="256" height="256" rx="36" fill="#0b898d"/>' +
        '<path d="M91 133c0-27 17-47 40-47 22 0 34 14 34 32 0 23-17 35-38 35h-9v25h-27zm27-4h7c9 0 14-4 14-12 0-7-5-11-13-11h-8z" fill="#fff"/>' +
        '</svg></div><h1>DSH</h1><p id="welcome-hint"></p>' +
        '<div class="starters" id="starters" hidden>' +
        starters.map(function (s) {
          return '<button data-starter="' + esc(s[1]) + '">' + esc(s[0]) + '</button>';
        }).join('') +
        '</div>';
      welcomeNode.querySelectorAll('[data-starter]').forEach(function (b) {
        b.onclick = function () {
          var i = $('#input');
          i.value = b.dataset.starter;
          autoGrow();
          i.focus();
        };
      });
    }
    var hint = welcomeNode.querySelector('#welcome-hint');
    var starters = welcomeNode.querySelector('#starters');
    if (apiKey) {
      hint.textContent = '直连 DeepSeek API · ' + settings.model;
      starters.hidden = false;
    } else {
      hint.textContent = '先去「设置」填入你的 DeepSeek API Key 就能开始。';
      starters.hidden = true;
    }
    return welcomeNode;
  }

  function copy(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { toast('已复制'); },
        function () { toast('复制失败'); });
    } else {
      var ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); toast('已复制'); } catch (e) { toast('复制失败'); }
      document.body.removeChild(ta);
    }
  }

  /* ---------------- API ---------------- */

  var FATAL = {
    400: '请求格式有误（400）。',
    401: 'API Key 无效或已失效（401），请到「设置」重新填写。',
    402: '账户余额不足（402），请到 platform.deepseek.com 充值。',
    422: '请求参数不被接受（422）。',
    429: '请求过于频繁（429），稍等片刻再试。',
    500: 'DeepSeek 服务端出错（500），请稍后重试。',
    503: 'DeepSeek 服务过载（503），请稍后重试。'
  };

  function describeError(status, detail) {
    var head = FATAL[status] || ('请求失败（HTTP ' + status + '）。');
    return detail ? head + ' ' + detail : head;
  }

  async function ask(convo, assistantMsg, signal) {
    var payload = {
      model: settings.model,
      stream: true,
      messages: [{ role: 'system', content: SYSTEM_PROMPT }].concat(
        convo.messages
          .filter(function (m) { return !m.error && m.content; })
          .map(function (m) { return { role: m.role, content: m.content }; })
      ),
      thinking: { type: settings.thinking ? 'enabled' : 'disabled' }
    };
    // 思考模式不接受 temperature 等采样参数（发了也会被静默忽略），因此仅在关闭思考时保留默认行为。

    if (settings.thinking) payload.reasoning_effort = settings.effort;

    var res;
    try {
      res = await fetch(API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + apiKey
        },
        body: JSON.stringify(payload),
        signal: signal
      });
    } catch (e) {
      if (e.name === 'AbortError') return;
      assistantMsg.error = '网络请求失败。请检查手机网络后重试。';
      return;
    }

    if (!res.ok) {
      var detail = '';
      try {
        var j = await res.json();
        detail = (j && j.error && j.error.message) || '';
      } catch (e) { /* 响应体不是 JSON */ }
      if (res.status === 401) {
        apiKey = '';
        localStorage.removeItem(LS_KEY);
        fillSettings();
      }
      assistantMsg.error = describeError(res.status, detail);
      return;
    }

    if (!res.body || !res.body.getReader) {
      // 环境不支持流式读取，退回一次性解析
      await readWhole(res, assistantMsg);
      return;
    }

    var reader = res.body.getReader();
    var decoder = new TextDecoder('utf-8');
    var buffer = '';

    while (true) {
      var chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });

      var lines = buffer.split('\n');
      buffer = lines.pop();

      for (var k = 0; k < lines.length; k++) {
        var line = lines[k].trim();
        if (!line || line.charAt(0) === ':') continue;
        if (line.indexOf('data:') !== 0) continue;
        var data = line.slice(5).trim();
        if (data === '[DONE]') continue;
        try {
          var parsed = JSON.parse(data);
          var delta = parsed.choices && parsed.choices[0] && parsed.choices[0].delta;
          if (!delta) continue;
          var changed = false;
          if (delta.reasoning_content) { assistantMsg.reasoning = (assistantMsg.reasoning || '') + delta.reasoning_content; changed = true; }
          if (delta.content) { assistantMsg.content = (assistantMsg.content || '') + delta.content; changed = true; }
          if (changed) paint(assistantMsg);
        } catch (e) { /* 跳过无法解析的分片 */ }
      }
    }
  }

  async function readWhole(res, assistantMsg) {
    try {
      var j = await res.json();
      var msg = j.choices && j.choices[0] && j.choices[0].message;
      if (msg) {
        assistantMsg.reasoning = msg.reasoning_content || '';
        assistantMsg.content = msg.content || '';
        paint(assistantMsg);
      }
    } catch (e) {
      assistantMsg.error = '响应解析失败。';
    }
  }

  // 流式过程中只更新这一条气泡，避免整屏重绘导致滚动跳动
  function paint(msg) {
    var el = document.querySelector('[data-bubble="' + msg.id + '"]');
    if (!el) { render(true); return; }
    var wasOpen = el.querySelector('.think');
    var openState = wasOpen ? wasOpen.open : false;

    var inner = '';
    if (msg.reasoning) {
      inner += '<details class="think"' + (openState ? ' open' : '') + '>' +
        '<summary><span class="dots">思考中</span></summary>' +
        '<div class="think-body">' + esc(msg.reasoning) + '</div></details>';
    }
    inner += '<div class="body cursor">' + markdown(msg.content || '') + '</div>';
    el.innerHTML = inner;
    scrollDown(false);
  }

  /* ---------------- 发送流程 ---------------- */

  var controller = null;
  var busy = false;

  function setBusy(state) {
    busy = state;
    $('#btn-send').hidden = state;
    $('#btn-stop').hidden = !state;
    $('#input').disabled = false;
  }

  async function send(text) {
    if (!apiKey) { openSheet('sheet-settings'); toast('请先填入 API Key'); return; }
    if (busy) return;

    var c = current() || newConvo();

    var userMsg = { id: uid(), role: 'user', content: text };
    var assistantMsg = { id: uid(), role: 'assistant', content: '', reasoning: '', streaming: true };

    c.messages.push(userMsg, assistantMsg);
    if (c.title === '新会话') c.title = text.slice(0, 24);
    c.at = Date.now();
    persistConvos();

    render(true);
    setBusy(true);

    controller = new AbortController();
    try {
      await ask(c, assistantMsg, controller.signal);
    } catch (e) {
      if (e && e.name !== 'AbortError') assistantMsg.error = assistantMsg.error || '发生未知错误。';
    } finally {
      assistantMsg.streaming = false;
      controller = null;
      persistConvos();
      setBusy(false);
      render(true);
      renderHistory();
    }
  }

  /* ---------------- 设置面板 ---------------- */

  function fillSettings() {
    $('#key-input').value = apiKey;
    $('#model-select').value = settings.model;
    $('#model-label').textContent = settings.model;
    $('#thinking-toggle').checked = settings.thinking;
    $('#effort-select').value = settings.effort;
    $('#effort-field').style.display = settings.thinking ? '' : 'none';
  }

  function openSheet(id) {
    fillSettings();
    $('#' + id).hidden = false;
  }

  function closeSheet(id) { $('#' + id).hidden = true; }

  function renderHistory() {
    var list = $('#history-list');
    if (!convos.length) {
      list.innerHTML = '<p class="empty-note">还没有历史会话</p>';
      return;
    }
    list.innerHTML = convos.map(function (c) {
      return '<div class="hist-item' + (c.id === currentId ? ' active' : '') + '" data-open="' + c.id + '">' +
        '<span class="hist-copy"><b>' + esc(c.title) + '</b>' +
        '<small>' + c.messages.length + ' 条 · ' + new Date(c.at).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) + '</small></span>' +
        '<button class="hist-del" data-del="' + c.id + '" aria-label="删除">✕</button></div>';
    }).join('');

    list.querySelectorAll('[data-open]').forEach(function (el) {
      el.onclick = function (ev) {
        if (ev.target.dataset.del) return;
        currentId = el.dataset.open;
        localStorage.setItem(LS_CURRENT, currentId);
        closeSheet('sheet-history');
        render(true);
      };
    });
    list.querySelectorAll('[data-del]').forEach(function (el) {
      el.onclick = function (ev) {
        ev.stopPropagation();
        convos = convos.filter(function (c) { return c.id !== el.dataset.del; });
        if (currentId === el.dataset.del) currentId = convos.length ? convos[0].id : null;
        if (currentId) localStorage.setItem(LS_CURRENT, currentId); else localStorage.removeItem(LS_CURRENT);
        persistConvos();
        renderHistory();
        render(true);
      };
    });
  }

  /* ---------------- 输入框 ---------------- */

  function autoGrow() {
    var ta = $('#input');
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, window.innerHeight * 0.34) + 'px';
    $('#btn-send').disabled = !ta.value.trim() || busy;
  }

  /* ---------------- 事件绑定 ---------------- */

  var input = $('#input');
  input.addEventListener('input', autoGrow);
  input.addEventListener('keydown', function (e) {
    // 桌面端 Enter 发送；手机端虚拟键盘的回车换行，交给发送按钮
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && window.matchMedia('(min-width: 820px)').matches) {
      e.preventDefault();
      $('#composer').requestSubmit();
    }
  });

  $('#composer').addEventListener('submit', function (e) {
    e.preventDefault();
    var text = input.value.trim();
    if (!text || busy) return;
    // 先校验 Key 再清空输入框，避免用户被叫去填 Key 时丢掉已经打好的内容
    if (!apiKey) { openSheet('sheet-settings'); toast('请先填入 API Key'); return; }
    input.value = '';
    autoGrow();
    send(text);
  });

  $('#btn-stop').onclick = function () {
    if (controller) controller.abort();
    toast('已停止');
  };
  $('#btn-new').onclick = function () {
    currentId = null;
    localStorage.removeItem(LS_CURRENT);
    render(true);
    toast('新会话');
  };
  $('#btn-history').onclick = function () { renderHistory(); openSheet('sheet-history'); };
  $('#btn-model').onclick = function () { openSheet('sheet-settings'); };
  $('#btn-settings') && ($('#btn-settings').onclick = function () { openSheet('sheet-settings'); });

  document.querySelectorAll('[data-close]').forEach(function (b) {
    b.onclick = function () { closeSheet(b.dataset.close); };
  });
  document.querySelectorAll('.sheet').forEach(function (s) {
    s.addEventListener('click', function (e) { if (e.target === s) s.hidden = true; });
  });

  $('#key-input').addEventListener('change', function () {
    apiKey = $('#key-input').value.trim();
    if (apiKey) localStorage.setItem(LS_KEY, apiKey); else localStorage.removeItem(LS_KEY);
    render(true);
  });

  $('#model-select').addEventListener('change', function () {
    settings.model = $('#model-select').value;
    persistSettings();
    fillSettings();
  });

  $('#thinking-toggle').addEventListener('change', function () {
    settings.thinking = $('#thinking-toggle').checked;
    persistSettings();
    fillSettings();
  });

  $('#effort-select').addEventListener('change', function () {
    settings.effort = $('#effort-select').value;
    persistSettings();
  });

  $('#btn-test').onclick = async function () {
    var status = $('#settings-status');
    var key = $('#key-input').value.trim() || apiKey;
    if (!key) { status.className = 'status bad'; status.textContent = '请先填入 API Key。'; return; }
    status.className = 'status';
    status.textContent = '正在测试…';
    try {
      var res = await fetch(API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
        body: JSON.stringify({
          model: settings.model,
          messages: [{ role: 'user', content: 'ping' }],
          max_tokens: 1,
          thinking: { type: 'disabled' }
        })
      });
      if (res.ok) {
        status.className = 'status ok';
        status.textContent = '连接正常，key 可用（' + settings.model + '）。';
      } else {
        var detail = '';
        try { var j = await res.json(); detail = (j.error && j.error.message) || ''; } catch (e) {}
        status.className = 'status bad';
        status.textContent = describeError(res.status, detail);
      }
    } catch (e) {
      status.className = 'status bad';
      status.textContent = '网络不可达。请确认手机能访问 api.deepseek.com。';
    }
  };

  $('#btn-clear').onclick = function () {
    if (!confirm('将删除本机保存的 API Key、全部会话与设置，确定吗？')) return;
    [LS_KEY, LS_CONVOS, LS_SETTINGS, LS_CURRENT].forEach(function (k) { localStorage.removeItem(k); });
    apiKey = '';
    convos = [];
    currentId = null;
    settings = { model: 'deepseek-flash', thinking: true, effort: 'high' };
    fillSettings();
    render(true);
    renderHistory();
    $('#settings-status').className = 'status';
    $('#settings-status').textContent = '已清空。';
  };

  /* ---------------- 启动 ---------------- */

  fillSettings();
  render(true);
  renderHistory();
  autoGrow();

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('sw.js').catch(function () { /* 离线能力不可用不影响在线使用 */ });
    });
  }
})();
