/* DSH — 直连 DeepSeek API 的聊天客户端
 * 单文件、无构建、无后端。API Key 只存在本机 localStorage，绝不写入代码或仓库。
 *
 * 关于能力边界（很重要，写在代码里免得被误解）：
 *   网页应用运行在浏览器沙箱里，拿不到系统级"完全权限"：
 *   没有文件系统、不能执行命令、读不到其他 App 的数据。
 *   所以本应用能做的只是：看图、读你主动选中的文档、把结果通过分享面板交回给你。
 *   真正的全权限 agent / computer-use 必须由手机远程连接电脑上运行的 DSH。
 */
(function () {
  'use strict';

  var API_URL = 'https://api.deepseek.com/chat/completions';
  var LS_KEY = 'dsh.key.v1';
  var LS_CONVOS = 'dsh.convos.v1';
  var LS_SETTINGS = 'dsh.settings.v1';
  var LS_CURRENT = 'dsh.current.v1';

  var VISION_MODEL = 'deepseek-flash';   // 唯一支持图片输入的模型
  var MAX_EDGE = 1568;                   // 服务端会压到约 1300×1300，发更大的原图纯属浪费
  var MAX_DOC_CHARS = 120000;            // 单个文档注入上下文的上限，防止撑爆请求

  var SYSTEM_PROMPT = '你是 DSH，一个严谨、直接的中文 AI 助手。回答准确、简洁，不吹嘘、不编造。' +
    '涉及代码时给出可运行的完整片段；不确定的事情明确说明不确定。' +
    '用户可能会附加图片或文档，请先看清内容再回答，不要凭空推测文件里没有的信息。';

  /* ================= IndexedDB：附件载荷 =================
   * localStorage 只有约 5MB，一张手机照片的 base64 就有 400~700KB，
   * 存进去几张就会把整个应用的存储撑爆。所以图片和文档正文一律放 IndexedDB，
   * localStorage 只保留引用和元数据。 */

  var DB_NAME = 'dsh-attachments';
  var DB_STORE = 'payloads';

  function idbOpen() {
    return new Promise(function (res, rej) {
      var req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains(DB_STORE)) db.createObjectStore(DB_STORE);
      };
      req.onsuccess = function () { res(req.result); };
      req.onerror = function () { rej(req.error); };
    });
  }

  function idbTx(mode, fn) {
    return idbOpen().then(function (db) {
      return new Promise(function (res, rej) {
        var tx = db.transaction(DB_STORE, mode);
        var out = fn(tx.objectStore(DB_STORE));
        tx.oncomplete = function () { res(out && out.result); };
        tx.onerror = function () { rej(tx.error); };
      });
    });
  }

  var store = {
    put: function (k, v) { return idbTx('readwrite', function (s) { return s.put(v, k); }); },
    get: function (k) { return idbTx('readonly', function (s) { return s.get(k); }); },
    del: function (k) { return idbTx('readwrite', function (s) { return s.delete(k); }); },
    clear: function () { return idbTx('readwrite', function (s) { return s.clear(); }); }
  };

  /* ================= 基础工具 ================= */

  function load(key, fallback) {
    try { var raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : fallback; }
    catch (e) { return fallback; }
  }
  function save(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); }
    catch (e) { toast('本地存储写入失败，可能在「设置」里清理旧会话'); }
  }

  function uid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'x' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  var $ = function (s) { return document.querySelector(s); };
  var $$ = function (s) { return Array.prototype.slice.call(document.querySelectorAll(s)); };

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  var toastTimer = null;
  function toast(msg) {
    var el = $('#toast');
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.hidden = true; }, 2600);
  }

  function fmtBytes(n) {
    if (!n && n !== 0) return '';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB';
    return (n / 1048576).toFixed(1) + ' MB';
  }

  function scrollDown(force) {
    var m = $('#messages');
    var nearBottom = m.scrollHeight - m.scrollTop - m.clientHeight < 160;
    if (force || nearBottom) m.scrollTop = m.scrollHeight;
  }

  /* ================= 状态 ================= */

  var settings = Object.assign(
    { model: VISION_MODEL, thinking: true, effort: 'high' },
    load(LS_SETTINGS, {})
  );
  var apiKey = localStorage.getItem(LS_KEY) || '';
  var convos = load(LS_CONVOS, []);
  var currentId = localStorage.getItem(LS_CURRENT) || null;
  var pending = [];          // 待发送附件（含完整载荷，仅内存）
  var controller = null;
  var busy = false;

  function persistSettings() { save(LS_SETTINGS, settings); }
  function persistConvos() { save(LS_CONVOS, convos); }
  function current() { return convos.filter(function (c) { return c.id === currentId; })[0] || null; }

  function newConvo() {
    var c = { id: uid(), title: '新会话', messages: [], at: Date.now() };
    convos.unshift(c);
    currentId = c.id;
    persistConvos();
    localStorage.setItem(LS_CURRENT, currentId);
    return c;
  }

  /* ================= Markdown（子集；先转义再解析，避免注入） ================= */

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

      var fence = line.match(/^\s*```(\w*)\s*$/);
      if (fence) {
        var buf = [];
        i++;
        while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) { buf.push(lines[i]); i++; }
        i++;
        var lang = (fence[1] || '').toLowerCase();
        html += '<div class="code">' +
          '<div class="code-head"><span class="code-lang">' + esc(lang || 'text') + '</span>' +
          '<button class="code-copy" type="button">复制</button></div>' +
          '<pre><code>' + esc(buf.join('\n')) + '</code></pre></div>';
        continue;
      }

      var head = line.match(/^(#{1,6})\s+(.*)$/);
      if (head) { html += '<h3>' + inline(head[2]) + '</h3>'; i++; continue; }

      // 分隔线：--- / *** / ___（含被空格分开的写法），必须在列表之前判断
      if (/^\s*(?:-\s*){3,}$/.test(line) || /^\s*(?:\*\s*){3,}$/.test(line) || /^\s*(?:_\s*){3,}$/.test(line)) {
        html += '<hr>';
        i++;
        continue;
      }

      // 表格：表头行 + |---| 分隔行
      if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
        var cells = function (s) {
          return s.trim().replace(/^\||\|$/g, '').split('|').map(function (c) { return c.trim(); });
        };
        var thead = cells(lines[i]);
        i += 2;
        var rows = [];
        while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) { rows.push(cells(lines[i])); i++; }
        html += '<div class="table-wrap"><table><thead><tr>' +
          thead.map(function (c) { return '<th>' + inline(c) + '</th>'; }).join('') +
          '</tr></thead><tbody>' +
          rows.map(function (r) {
            return '<tr>' + r.map(function (c) { return '<td>' + inline(c) + '</td>'; }).join('') + '</tr>';
          }).join('') +
          '</tbody></table></div>';
        continue;
      }

      if (/^>\s?/.test(line)) {
        var quote = [];
        while (i < lines.length && /^>\s?/.test(lines[i])) {
          quote.push(lines[i].replace(/^>\s?/, ''));
          i++;
        }
        html += '<blockquote>' + inline(quote.join('\n')).replace(/\n/g, '<br>') + '</blockquote>';
        continue;
      }

      if (/^\s*[-*+]\s+/.test(line)) {
        var items = [];
        while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
          items.push('<li>' + inline(lines[i].replace(/^\s*[-*+]\s+/, '')) + '</li>');
          i++;
        }
        html += '<ul>' + items.join('') + '</ul>';
        continue;
      }

      if (/^\s*\d+[.)]\s+/.test(line)) {
        var oitems = [];
        while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) {
          oitems.push('<li>' + inline(lines[i].replace(/^\s*\d+[.)]\s+/, '')) + '</li>');
          i++;
        }
        html += '<ol>' + oitems.join('') + '</ol>';
        continue;
      }

      if (!line.trim()) { i++; continue; }

      var para = [];
      while (i < lines.length && lines[i].trim() &&
             !/^\s*```/.test(lines[i]) &&
             !/^(#{1,6})\s+/.test(lines[i]) &&
             !/^>\s?/.test(lines[i]) &&
             !/^\s*\|.*\|\s*$/.test(lines[i]) &&
             !/^\s*(?:-\s*){3,}$/.test(lines[i]) &&
             !/^\s*[-*+]\s+/.test(lines[i]) &&
             !/^\s*\d+[.)]\s+/.test(lines[i])) {
        para.push(lines[i]);
        i++;
      }
      html += '<p>' + inline(para.join('\n')).replace(/\n/g, '<br>') + '</p>';
    }
    return html;
  }

  /* ================= 图片处理 ================= */

  function loadImage(url) {
    return new Promise(function (res, rej) {
      var img = new Image();
      img.onload = function () { res(img); };
      img.onerror = function () { rej(new Error('图片解码失败（格式可能不受支持）')); };
      img.src = url;
    });
  }

  function makeThumb(img, edge) {
    var scale = Math.min(1, edge / Math.max(img.naturalWidth, img.naturalHeight));
    var w = Math.max(1, Math.round(img.naturalWidth * scale));
    var h = Math.max(1, Math.round(img.naturalHeight * scale));
    var c = document.createElement('canvas');
    c.width = w; c.height = h;
    var ctx = c.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, w, h);
    return c.toDataURL('image/jpeg', 0.72);
  }

  /* 发送前降采样。原图 4000px、4MB 的 iPhone 照片 base64 后约 5.3MB，
   * 几张就会顶到 48MiB 请求体上限，而服务端反正会压到约 1300×1300。 */
  async function prepareImage(file) {
    var objUrl = URL.createObjectURL(file);
    try {
      var img = await loadImage(objUrl);
      var w0 = img.naturalWidth, h0 = img.naturalHeight;
      var scale = Math.min(1, MAX_EDGE / Math.max(w0, h0));
      var thumb = makeThumb(img, 160);

      // 小图且无需缩放，且是可直发格式 → 原样保留，避免二次压缩
      if (scale === 1 && file.size <= 2 * 1048576 && /^image\/(png|jpeg)$/.test(file.type)) {
        return {
          kind: 'image', name: file.name || 'image', mime: file.type,
          w: w0, h: h0, bytes: file.size, thumb: thumb, full: null, blob: file
        };
      }

      var tw = Math.max(1, Math.round(w0 * scale));
      var th = Math.max(1, Math.round(h0 * scale));
      var canvas = document.createElement('canvas');
      canvas.width = tw; canvas.height = th;
      var ctx = canvas.getContext('2d');
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, 0, 0, tw, th);

      // PNG 保留无损；其余（含 iPhone 的 HEIC）统一转 JPEG，因为服务端只认 JPEG/PNG/GIF/WebP
      var isPng = file.type === 'image/png';
      var dataUrl = canvas.toDataURL(isPng ? 'image/png' : 'image/jpeg', isPng ? undefined : 0.86);

      return {
        kind: 'image', name: file.name || 'image',
        mime: isPng ? 'image/png' : 'image/jpeg',
        w: tw, h: th, bytes: Math.round(dataUrl.length * 0.75),
        thumb: thumb, full: dataUrl, blob: null
      };
    } finally {
      URL.revokeObjectURL(objUrl);
    }
  }

  // 统一取出发送时用的 data URL（可能来自内存，也可能来自 IndexedDB）
  async function imageDataUrl(att) {
    if (att.full) return att.full;
    if (att.blob) return blobToDataUrl(att.blob);
    var rec = await store.get(att.id);
    return rec && rec.full ? rec.full : null;
  }

  function blobToDataUrl(blob) {
    return new Promise(function (res, rej) {
      var fr = new FileReader();
      fr.onload = function () { res(fr.result); };
      fr.onerror = function () { rej(fr.error); };
      fr.readAsDataURL(blob);
    });
  }

  /* ================= 文档解析（零外部依赖） ================= */

  var TEXT_EXT = ['txt', 'md', 'markdown', 'json', 'jsonl', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx',
    'py', 'rb', 'go', 'rs', 'java', 'kt', 'swift', 'c', 'h', 'cpp', 'hpp', 'cc', 'cs', 'php',
    'sh', 'bash', 'zsh', 'ps1', 'bat', 'sql', 'html', 'htm', 'css', 'scss', 'less', 'xml',
    'yml', 'yaml', 'toml', 'ini', 'cfg', 'conf', 'log', 'csv', 'tsv', 'srt', 'vtt', 'tex',
    'r', 'm', 'lua', 'dart', 'vue', 'svelte', 'gitignore', 'editorconfig'];

  function extOf(name) {
    var m = String(name || '').toLowerCase().match(/\.([a-z0-9]+)$/);
    return m ? m[1] : '';
  }

  async function looksBinary(file) {
    var head = new Uint8Array(await file.slice(0, 1024).arrayBuffer());
    for (var i = 0; i < head.length; i++) if (head[i] === 0) return true;
    return false;
  }

  async function inflateRaw(bytes) {
    if (typeof DecompressionStream === 'undefined') throw new Error('此浏览器不支持解压（需要 iOS 16.4+）');
    var stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  /* 最小 ZIP 读取器：只够从 docx 里取出一个成员。 */
  async function unzipEntry(buf, wantName) {
    var dv = new DataView(buf);
    var eocd = -1;
    var floor = Math.max(0, buf.byteLength - 66000);
    for (var i = buf.byteLength - 22; i >= floor; i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('不是有效的 docx/ZIP 文件');

    var count = dv.getUint16(eocd + 10, true);
    var p = dv.getUint32(eocd + 16, true);
    var dec = new TextDecoder('utf-8');

    for (var n = 0; n < count; n++) {
      if (p + 46 > buf.byteLength || dv.getUint32(p, true) !== 0x02014b50) break;
      var method = dv.getUint16(p + 10, true);
      var compSize = dv.getUint32(p + 20, true);
      var nameLen = dv.getUint16(p + 28, true);
      var extraLen = dv.getUint16(p + 30, true);
      var commentLen = dv.getUint16(p + 32, true);
      var lho = dv.getUint32(p + 42, true);
      var name = dec.decode(new Uint8Array(buf, p + 46, nameLen));

      if (name === wantName) {
        var lNameLen = dv.getUint16(lho + 26, true);
        var lExtraLen = dv.getUint16(lho + 28, true);
        var dataStart = lho + 30 + lNameLen + lExtraLen;
        var raw = new Uint8Array(buf, dataStart, compSize);
        if (method === 0) return raw;
        if (method === 8) return await inflateRaw(raw);
        throw new Error('docx 使用了不支持的压缩方式（' + method + '）');
      }
      p += 46 + nameLen + extraLen + commentLen;
    }
    throw new Error('docx 里找不到 ' + wantName);
  }

  function decodeXmlEntities(s) {
    return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
      .replace(/&#(\d+);/g, function (_, d) { return String.fromCodePoint(Number(d)); })
      .replace(/&amp;/g, '&');
  }

  async function docxText(file) {
    var buf = await file.arrayBuffer();
    var xml = new TextDecoder('utf-8').decode(await unzipEntry(buf, 'word/document.xml'));
    return decodeXmlEntities(
      xml.replace(/<w:tab\b[^>]*\/>/g, '\t')
        .replace(/<w:br\b[^>]*\/>/g, '\n')
        .replace(/<\/w:p>/g, '\n')
        .replace(/<[^>]+>/g, '')
    ).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  /* 简易 PDF 文本提取：解 FlateDecode 流，抓 Tj / TJ 里的字符串。
   * 对使用标准字体的简单 PDF 有效；中文 CID 字体的 PDF 常常提不出干净文本，
   * 所以调用方必须把结果先给用户看（预览），乱码一眼可见。 */
  async function pdfText(file) {
    var buf = await file.arrayBuffer();
    var bytes = new Uint8Array(buf);
    var latin = new TextDecoder('latin1').decode(bytes);
    var chunks = [];
    var re = /stream\r?\n?/g;
    var m;
    while ((m = re.exec(latin)) !== null) {
      var start = m.index + m[0].length;
      var end = latin.indexOf('endstream', start);
      if (end < 0) break;
      var raw = bytes.subarray(start, end);
      while (raw.length && (raw[raw.length - 1] === 0x0a || raw[raw.length - 1] === 0x0d)) {
        raw = raw.subarray(0, raw.length - 1);
      }
      if (raw.length < 2) continue;
      var data = null;
      if (raw[0] === 0x78) {                       // zlib 头，常见于 FlateDecode
        try { data = await inflateZlib(raw); } catch (e) { data = null; }
      }
      if (!data) { try { data = await inflateRaw(raw); } catch (e) { data = null; } }
      if (!data) continue;
      var content = new TextDecoder('latin1').decode(data);
      if (content.indexOf('Tj') < 0 && content.indexOf('TJ') < 0) continue;
      chunks.push(extractPdfStrings(content));
    }
    return chunks.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  async function inflateZlib(bytes) {
    var stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  function extractPdfStrings(content) {
    var out = [];
    var re = /\((?:\\.|[^\\()])*\)/g;
    var m;
    while ((m = re.exec(content)) !== null) {
      var s = m[0].slice(1, -1)
        .replace(/\\([nrtbf])/g, function (_, c) {
          return { n: '\n', r: '\r', t: '\t', b: '', f: '' }[c];
        })
        .replace(/\\([0-7]{1,3})/g, function (_, o) { return String.fromCharCode(parseInt(o, 8)); })
        .replace(/\\(.)/g, '$1');
      if (s.trim()) out.push(s);
    }
    // 粗略保留换行语义：TJ 数组里的负值常表示字距
    return out.join(' ').replace(/\s{2,}/g, ' ').trim();
  }

  /* 判断提取结果是否可信。宁可让用户看到"可能乱码"，
   * 也不要把一堆噪声悄悄发给模型当成文档内容。 */
  function textSanity(text) {
    if (!text || text.length < 20) return { ok: false, why: '几乎没提取到文字' };
    var good = 0;
    var sample = text.slice(0, 4000);
    for (var i = 0; i < sample.length; i++) {
      var c = sample.charCodeAt(i);
      if (c === 9 || c === 10 || c === 13) { good++; continue; }
      if (c >= 0x20 && c <= 0x7e) { good++; continue; }          // ASCII 可见
      if (c >= 0x4e00 && c <= 0x9fff) { good++; continue; }       // CJK
      if (c >= 0x3000 && c <= 0x30ff) { good++; continue; }       // CJK 标点/假名
    }
    var ratio = good / sample.length;
    if (ratio < 0.75) return { ok: false, why: '超过四分之一是乱码字符（' + Math.round((1 - ratio) * 100) + '%）' };
    return { ok: true, why: '' };
  }

  async function extractDoc(file) {
    var ext = extOf(file.name);
    var base = { name: file.name || 'document', bytes: file.size, mime: file.type || '' };

    if (ext === 'docx' || ext === 'docm') {
      return Object.assign(base, { kind: 'doc', text: await docxText(file) });
    }
    if (ext === 'pdf') {
      return Object.assign(base, { kind: 'doc', text: await pdfText(file) });
    }
    if (TEXT_EXT.indexOf(ext) >= 0 || /^text\//.test(file.type)) {
      return Object.assign(base, { kind: 'doc', text: await file.text() });
    }
    if (await looksBinary(file)) {
      throw new Error('不支持的文件类型（.' + (ext || '未知') + '）。可读：文本/代码、docx、pdf；其他格式请截图后用「拍照/相册」走图片输入。');
    }
    return Object.assign(base, { kind: 'doc', text: await file.text() });
  }

  /* ================= 渲染 ================= */

  function attachmentsHtml(list) {
    if (!list || !list.length) return '';
    return list.map(function (a) {
      if (a.kind === 'image') {
        return '<img class="bubble-img" alt="' + esc(a.name) + '" data-thumb="' + a.id + '">';
      }
      return '<div class="bubble-doc">' + DOC_ICON + '<span class="bd-copy"><b>' + esc(a.name) + '</b>' +
        '<small>' + fmtBytes(a.bytes) + ' · 已提取 ' + (a.chars || 0) + ' 字</small></span></div>';
    }).join('');
  }

  var MARK_SVG = '<svg viewBox="0 0 256 256"><rect width="256" height="256" rx="64" fill="#0b898d"/>' +
    '<path d="M91 133c0-27 17-47 40-47 22 0 34 14 34 32 0 23-17 35-38 35h-9v25h-27zm27-4h7c9 0 14-4 14-12 0-7-5-11-13-11h-8z" fill="#fff"/></svg>';

  var DOC_ICON = '<span class="bd-ico"><svg viewBox="0 0 24 24"><path d="M6 3h7l5 5v13H6z"/><path d="M13 3v5h5"/></svg></span>';

  function bubbleHtml(msg) {
    var inner = attachmentsHtml(msg.attachments);

    if (msg.role === 'assistant' && msg.reasoning) {
      inner += '<details class="think"><summary><span class="dots">已思考</span></summary>' +
        '<div class="think-body">' + esc(msg.reasoning) + '</div></details>';
    }

    var body = msg.content || msg.text || '';
    inner += '<div class="body">' + (body ? markdown(body) : '') + '</div>';
    if (msg.error) inner += '<div class="err">' + esc(msg.error) + '</div>';

    if (msg.role === 'assistant' && msg.content && !msg.streaming) {
      var hasCode = /```/.test(msg.content);
      inner += '<div class="msg-actions">' +
        '<button class="mini" data-copy="' + msg.id + '">复制</button>' +
        (hasCode ? '<button class="mini" data-save="' + msg.id + '">存为文件</button>' : '') +
        '</div>';
    }

    var avatar = msg.role === 'assistant'
      ? '<span class="avatar" aria-hidden="true">' + MARK_SVG + '</span>'
      : '';
    return '<div class="msg ' + msg.role + '">' + avatar +
      '<div class="bubble" data-bubble="' + msg.id + '">' + inner + '</div></div>';
  }

  // 图片缩略图存在 IndexedDB 里，渲染后异步回填，避免把 base64 塞进 localStorage
  async function hydrateThumbs(root) {
    var nodes = (root || document).querySelectorAll('[data-thumb]');
    for (var i = 0; i < nodes.length; i++) {
      (function (el) {
        var id = el.dataset.thumb;
        store.get(id).then(function (rec) {
          if (rec && rec.thumb) el.src = rec.thumb;
          else { el.alt = '图片已不在本地（已被清理）'; el.style.display = 'none'; }
        }).catch(function () { el.style.display = 'none'; });
      })(nodes[i]);
    }
  }

  var welcomeNode = null;
  function renderWelcome() {
    if (!welcomeNode) {
      welcomeNode = document.createElement('section');
      welcomeNode.className = 'welcome';
      var starters = [
        { ico: 'M12 3.2a6 6 0 0 1 3.7 10.7v3.1H8.3v-3.1A6 6 0 0 1 12 3.2zM9.6 20.2h4.8',
          b: '解释一个概念', s: '用三句话讲清，不用比喻',
          p: '用三句话解释量子纠缠，不要用比喻' },
        { ico: 'M3 5h18v14H3zM3.8 16.6l4.7-4.7 3.8 3.8 2.9-2.9 4.8 4.8',
          b: '看图 / 截图', s: '客观描述后再回答',
          p: '请看清我接下来发的图片，先客观描述内容，再回答我的问题。' },
        { ico: 'M9 8.5l-3.5 3.5L9 15.5M15 8.5l3.5 3.5L15 15.5',
          b: '改我的代码', s: '通读后给完整修改版',
          p: '我接下来会附上代码文件。请先通读，指出问题并给出完整的修改后代码。' },
        { ico: 'M6 3h7l5 5v13H6zM13 3v5h5M8.5 13h7M8.5 16.5h4.5',
          b: '读文档做总结', s: '提炼要点与结论',
          p: '我接下来会附上文档。请提炼要点，并列出关键结论。' }
      ];
      welcomeNode.innerHTML =
        '<div class="welcome-mark" aria-hidden="true">' + MARK_SVG + '</div>' +
        '<h1>DSH</h1><p class="sub" id="welcome-hint"></p>' +
        '<div class="starters" id="starters" hidden>' +
        starters.map(function (s) {
          return '<button class="starter" data-starter="' + esc(s.p) + '">' +
            '<span class="s-ico"><svg viewBox="0 0 24 24"><path d="' + s.ico + '"/></svg></span>' +
            '<b>' + esc(s.b) + '</b><small>' + esc(s.s) + '</small></button>';
        }).join('') + '</div>';
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
        if (m) copy(m.content || m.text || '');
      };
    });
    wrap.querySelectorAll('[data-save]').forEach(function (btn) {
      btn.onclick = function () {
        var m = c.messages.filter(function (x) { return x.id === btn.dataset.save; })[0];
        if (m) saveOutput(m.content || '', m);
      };
    });

    hydrateThumbs(wrap);
    scrollDown(forceScroll);
  }

  function paint(msg) {
    var el = document.querySelector('[data-bubble="' + msg.id + '"]');
    if (!el) { render(true); return; }
    var think = el.querySelector('.think');
    var openState = think ? think.open : false;

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

  /* ================= 把生成的代码交回手机 =================
   * 浏览器不能写文件系统。唯一的出口是分享面板（可存到"文件"App）或下载。 */

  var EXT_BY_LANG = {
    js: 'js', javascript: 'js', mjs: 'mjs', cjs: 'cjs', ts: 'ts', typescript: 'ts',
    jsx: 'jsx', tsx: 'tsx', py: 'py', python: 'py', rb: 'rb', ruby: 'rb', go: 'go',
    rust: 'rs', rs: 'rs', java: 'java', kotlin: 'kt', kt: 'kt', swift: 'swift',
    c: 'c', h: 'h', cpp: 'cpp', 'c++': 'cpp', cs: 'cs', csharp: 'cs', php: 'php',
    sh: 'sh', bash: 'sh', zsh: 'zsh', ps1: 'ps1', powershell: 'ps1', sql: 'sql',
    html: 'html', css: 'css', scss: 'scss', less: 'less', json: 'json', yaml: 'yml',
    yml: 'yml', toml: 'toml', xml: 'xml', md: 'md', markdown: 'md', csv: 'csv',
    ini: 'ini', conf: 'conf', lua: 'lua', dart: 'dart', r: 'r', tex: 'tex'
  };

  async function saveOutput(text, msg) {
    var blocks = [];
    var re = /```(\w*)\r?\n([\s\S]*?)```/g;
    var m;
    while ((m = re.exec(text)) !== null) blocks.push({ lang: (m[1] || '').toLowerCase(), code: m[2] });

    var content, lang;
    if (blocks.length === 0) {
      content = text;
      lang = '';
      toast('这条回复没有代码块，将整段存为 txt');
    } else if (blocks.length === 1) {
      content = blocks[0].code;
      lang = blocks[0].lang;
    } else {
      // 多个代码块：让用户选，避免猜错
      var names = blocks.map(function (b, i) { return (i + 1) + '. ' + (b.lang || '纯文本') + '（' + b.code.length + ' 字）'; });
      var pick = prompt('这条回复里有 ' + blocks.length + ' 个代码块，要保存哪一个？输入序号：\n\n' + names.join('\n'), '1');
      if (pick === null) return;
      var idx = parseInt(pick, 10) - 1;
      if (!(idx >= 0 && idx < blocks.length)) { toast('序号无效'); return; }
      content = blocks[idx].code;
      lang = blocks[idx].lang;
    }

    var ext = EXT_BY_LANG[lang] || (lang ? lang : 'txt');
    var stamp = new Date();
    var pad = function (n) { return String(n).padStart(2, '0'); };
    var name = 'dsh-' + stamp.getFullYear() + pad(stamp.getMonth() + 1) + pad(stamp.getDate()) +
      '-' + pad(stamp.getHours()) + pad(stamp.getMinutes()) + '.' + ext;

    var file;
    try {
      file = new File([content], name, { type: 'text/plain' });
    } catch (e) {
      downloadText(content, name);
      return;
    }

    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: name });
        toast('已交给系统分享面板');
        return;
      } catch (e) {
        if (e && e.name === 'AbortError') return;   // 用户取消，不算失败
      }
    }
    downloadText(content, name);
  }

  function downloadText(text, name) {
    try {
      var blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
      toast('已下载 ' + name);
    } catch (e) {
      toast('保存失败，已改为复制到剪贴板');
      copy(text);
    }
  }

  /* ================= 权限（真实的浏览器权限，不是假开关） ================= */

  var PERM_ITEMS = [
    { id: 'camera', label: '相机', why: '拍文档、拍代码、拍白板直接提问', name: 'camera' },
    { id: 'microphone', label: '麦克风', why: '录音输入（本应用暂未接入语音识别）', name: 'microphone' },
    { id: 'notifications', label: '通知', why: '添加到主屏后可发通知', name: 'notifications' },
    { id: 'storage', label: '持久存储', why: '防止浏览器自动清理本机会话与图片', name: null }
  ];

  function permLabel(state) {
    return {
      granted: '已授权', denied: '已拒绝', prompt: '未询问',
      unsupported: '不支持', unknown: '未知'
    }[state] || state;
  }

  async function permState(item) {
    if (item.id === 'storage') {
      if (!navigator.storage || !navigator.storage.persisted) return 'unsupported';
      return (await navigator.storage.persisted()) ? 'granted' : 'prompt';
    }
    if (item.id === 'notifications') {
      if (typeof Notification === 'undefined') return 'unsupported';
      return Notification.permission === 'default' ? 'prompt' : Notification.permission;
    }
    if (!navigator.permissions || !navigator.permissions.query) return 'unknown';
    try {
      var st = await navigator.permissions.query({ name: item.name });
      return st.state;
    } catch (e) {
      // Safari 对 camera/microphone 的 permissions.query 支持不全，只能靠实际调用得知
      return 'unknown';
    }
  }

  async function renderPerms() {
    var box = $('#perm-list');
    var rows = await Promise.all(PERM_ITEMS.map(async function (it) {
      var st = await permState(it);
      return '<div class="perm"><span class="perm-copy"><b>' + esc(it.label) + '</b>' +
        '<small>' + esc(it.why) + '</small></span>' +
        '<span class="perm-state ' + st + '">' + esc(permLabel(st)) + '</span>' +
        '<button class="perm-act" data-perm="' + it.id + '">' +
        (st === 'granted' ? '重测' : '申请') + '</button></div>';
    }));
    box.innerHTML = rows.join('');

    box.querySelectorAll('[data-perm]').forEach(function (btn) {
      btn.onclick = async function () {
        var id = btn.dataset.perm;
        btn.disabled = true;
        btn.textContent = '请求中…';
        try {
          if (id === 'camera' || id === 'microphone') {
            var stream = await navigator.mediaDevices.getUserMedia(
              id === 'camera' ? { video: true } : { audio: true }
            );
            stream.getTracks().forEach(function (t) { t.stop(); });
            toast(permLabel('granted'));
          } else if (id === 'notifications') {
            var r = await Notification.requestPermission();
            toast(r === 'granted' ? '通知已授权' : '通知被拒绝');
          } else if (id === 'storage') {
            var ok = navigator.storage && navigator.storage.persist ? await navigator.storage.persist() : false;
            toast(ok ? '已获得持久存储' : '浏览器未授予持久存储（Safari 通常要求先添加到主屏）');
          }
        } catch (e) {
          toast('请求失败：' + (e && e.name ? e.name : '未知错误'));
        }
        await renderPerms();
      };
    });
  }

  /* ================= API ================= */

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

  // 把会话历史转成 API 消息；带附件的用户消息要用内容块数组
  async function buildMessages(convo) {
    var out = [{ role: 'system', content: SYSTEM_PROMPT }];
    var live = convo.messages.filter(function (m) { return !m.error; });

    for (var i = 0; i < live.length; i++) {
      var m = live[i];
      var text = m.content || m.text || '';
      var atts = m.attachments || [];

      if (m.role === 'user' && atts.length) {
        var blocks = [];
        if (text) blocks.push({ type: 'text', text: text });
        for (var j = 0; j < atts.length; j++) {
          var a = atts[j];
          if (a.kind === 'image') {
            // 图片只允许出现在 user 消息里，放错位置 API 会返回 400
            var url = await imageDataUrl(a);
            if (url) blocks.push({ type: 'image_url', image_url: { url: url, detail: 'auto' } });
          } else {
            // 文档正文存在 IndexedDB（localStorage 装不下），必须回读，否则正文根本发不出去
            var rec = await store.get(a.id);
            var dt = (rec && rec.text) || a.text || '';
            if (dt) blocks.push({ type: 'text', text: '【附件 ' + a.name + '】\n```\n' + dt + '\n```' });
          }
        }
        if (!blocks.length) blocks.push({ type: 'text', text: text || '(附件已不可用)' });
        out.push({ role: 'user', content: blocks });
      } else if (text) {
        out.push({ role: m.role, content: text });
      }
    }
    return out;
  }

  async function ask(convo, assistantMsg, signal) {
    var messages;
    try {
      messages = await buildMessages(convo);
    } catch (e) {
      assistantMsg.error = '读取附件失败：' + e.message;
      return;
    }

    var payload = {
      model: settings.model,
      stream: true,
      messages: messages,
      thinking: { type: settings.thinking ? 'enabled' : 'disabled' }
    };
    // 思考模式不接受 temperature 等采样参数（发了会被静默忽略），故不发送。

    if (settings.thinking) payload.reasoning_effort = settings.effort;

    var res;
    try {
      res = await fetch(API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey },
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
      try { var j = await res.json(); detail = (j && j.error && j.error.message) || ''; } catch (e) {}
      if (res.status === 401) {
        apiKey = '';
        localStorage.removeItem(LS_KEY);
        fillSettings();
      }
      if (res.status === 400 && /image/i.test(detail)) {
        detail += '（注意：只有 deepseek-flash 支持图片输入）';
      }
      assistantMsg.error = describeError(res.status, detail);
      return;
    }

    if (!res.body || !res.body.getReader) { await readWhole(res, assistantMsg); return; }

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
        } catch (e) {}
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

  /* ================= 附件 UI ================= */

  function renderPending() {
    var box = $('#attachments');
    if (!pending.length) { box.hidden = true; box.innerHTML = ''; return; }
    box.hidden = false;
    box.innerHTML = pending.map(function (a, i) {
      var inner = a.kind === 'image'
        ? '<img src="' + a.thumb + '" alt="">'
        : '<div class="doc-icon">' + esc(a.name.length > 18 ? a.name.slice(0, 16) + '…' : a.name) + '</div>';
      var tag = a.kind === 'image' ? '图片' : fmtBytes(a.bytes);
      return '<div class="att">' + inner + '<span class="att-tag">' + esc(tag) + '</span>' +
        '<button class="kill" data-rm="' + i + '" aria-label="移除">✕</button></div>';
    }).join('');
    box.querySelectorAll('[data-rm]').forEach(function (b) {
      b.onclick = function () {
        pending.splice(Number(b.dataset.rm), 1);
        renderPending();
      };
    });
  }

  function addPending(att) {
    pending.push(att);
    renderPending();
  }

  async function addFiles(files, onlyImages) {
    var docs = [];
    for (var i = 0; i < files.length; i++) {
      var f = files[i];
      try {
        if (/^image\//.test(f.type)) {
          var att = await prepareImage(f);
          att.id = uid();
          addPending(att);
        } else if (onlyImages) {
          toast('已忽略非图片文件：' + f.name);
        } else {
          docs.push(f);
        }
      } catch (e) {
        toast((f.name || '文件') + '：' + (e.message || '处理失败'));
      }
    }
    // 文档走预览确认流程，一次一个（多个会静默丢弃，所以明确告知）
    if (docs.length) {
      if (docs.length > 1) toast('文档一次只能处理一个，已取用「' + docs[0].name + '」');
      try {
        var doc = await extractDoc(docs[0]);
        showDocPreview(doc, textSanity(doc.text || ''));
      } catch (e) {
        toast((docs[0].name || '文档') + '：' + (e.message || '解析失败'));
      }
    }
  }

  var pendingDoc = null;

  function showDocPreview(doc, sanity) {
    var chars = (doc.text || '').length;
    var meta = doc.name + ' · ' + fmtBytes(doc.bytes) + ' · 提取到 ' + chars + ' 字';
    if (chars > MAX_DOC_CHARS) {
      meta += '（过长，将只取前 ' + MAX_DOC_CHARS + ' 字）';
      doc.text = doc.text.slice(0, MAX_DOC_CHARS);
    }
    if (!sanity.ok) {
      meta = '⚠️ 提取结果可能不可用：' + sanity.why + ' —— ' + meta;
    }
    $('#doc-meta').textContent = meta;
    $('#doc-meta').className = sanity.ok ? 'status' : 'status bad';
    $('#doc-text').textContent = doc.text || '(空)';
    // 必须在这里登记，否则「确认添加」按钮拿不到待添加的文档
    pendingDoc = { att: doc, sanity: sanity };
    openSheet('sheet-doc');
  }

  $('#btn-doc-confirm').onclick = function () {
    if (!pendingDoc) return;
    var att = pendingDoc.att;
    att.id = uid();
    att.chars = (att.text || '').length;
    addPending(att);
    pendingDoc = null;
    closeSheet('sheet-doc');
  };
  $('#btn-doc-cancel').onclick = function () {
    pendingDoc = null;
    closeSheet('sheet-doc');
  };
  /* ================= 拍照 ================= */

  var camStream = null;
  var camFacing = 'environment';

  async function openCamera() {
    openSheet('sheet-camera');
    var status = $('#camera-status');
    status.className = 'status';
    status.textContent = '正在请求相机权限…';
    try {
      if (camStream) camStream.getTracks().forEach(function (t) { t.stop(); });
      camStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: camFacing }, width: { ideal: 1920 } },
        audio: false
      });
      var v = $('#camera-video');
      v.srcObject = camStream;
      await v.play().catch(function () {});
      status.textContent = '对准要拍的内容，点下方按钮。';
      status.className = 'status ok';
    } catch (e) {
      status.className = 'status bad';
      status.textContent = '无法打开相机：' + (e && e.name === 'NotAllowedError'
        ? '权限被拒绝。到 iOS「设置 → Safari → 相机」里允许后重试。'
        : (e && e.message) || '未知错误');
    }
  }

  function closeCamera() {
    if (camStream) { camStream.getTracks().forEach(function (t) { t.stop(); }); camStream = null; }
    var v = $('#camera-video');
    if (v) v.srcObject = null;
    closeSheet('sheet-camera');
  }

  $('#btn-shutter').onclick = async function () {
    var v = $('#camera-video');
    if (!v || !v.videoWidth) { toast('相机还没准备好'); return; }
    var c = document.createElement('canvas');
    var scale = Math.min(1, MAX_EDGE / Math.max(v.videoWidth, v.videoHeight));
    c.width = Math.round(v.videoWidth * scale);
    c.height = Math.round(v.videoHeight * scale);
    c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
    var dataUrl = c.toDataURL('image/jpeg', 0.86);
    var thumbCanvas = document.createElement('canvas');
    var ts = 160 / Math.max(c.width, c.height);
    thumbCanvas.width = Math.round(c.width * ts);
    thumbCanvas.height = Math.round(c.height * ts);
    thumbCanvas.getContext('2d').drawImage(c, 0, 0, thumbCanvas.width, thumbCanvas.height);

    addPending({
      id: uid(), kind: 'image', name: 'camera-' + Date.now() + '.jpg', mime: 'image/jpeg',
      w: c.width, h: c.height, bytes: Math.round(dataUrl.length * 0.75),
      thumb: thumbCanvas.toDataURL('image/jpeg', 0.72), full: dataUrl, blob: null
    });
    closeCamera();
    toast('已添加照片');
  };

  $('#btn-camera-flip').onclick = function () {
    camFacing = camFacing === 'environment' ? 'user' : 'environment';
    openCamera();
  };

  /* ================= 发送 ================= */

  function setBusy(state) {
    busy = state;
    $('#btn-send').hidden = state;
    $('#btn-stop').hidden = !state;
  }

  async function ensureVision() {
    var hasImage = pending.some(function (a) { return a.kind === 'image'; });
    if (!hasImage || settings.model === VISION_MODEL) return true;
    var yes = confirm('当前模型 ' + settings.model + ' 不支持图片输入。\n\n切换到 ' + VISION_MODEL + ' 并发送吗？');
    if (!yes) return false;
    settings.model = VISION_MODEL;
    persistSettings();
    fillSettings();
    return true;
  }

  async function send(text) {
    if (!apiKey) { openSheet('sheet-settings'); toast('请先填入 API Key'); return; }
    if (busy) return;
    if (!(await ensureVision())) return;

    var c = current() || newConvo();

    // 附件载荷落 IndexedDB，消息里只存引用，避免撑爆 localStorage
    var refs = [];
    for (var i = 0; i < pending.length; i++) {
      var a = pending[i];
      try {
        if (a.kind === 'image') {
          await store.put(a.id, { thumb: a.thumb, full: a.full || (a.blob ? await blobToDataUrl(a.blob) : null) });
          refs.push({ id: a.id, kind: 'image', name: a.name, mime: a.mime, w: a.w, h: a.h, bytes: a.bytes });
        } else {
          await store.put(a.id, { text: a.text });
          refs.push({ id: a.id, kind: 'doc', name: a.name, bytes: a.bytes, chars: a.chars || (a.text || '').length });
        }
      } catch (e) {
        toast('附件保存失败：' + e.message);
        return;
      }
    }

    var userMsg = { id: uid(), role: 'user', text: text, attachments: refs };
    var assistantMsg = { id: uid(), role: 'assistant', content: '', reasoning: '', streaming: true };

    c.messages.push(userMsg, assistantMsg);
    if (c.title === '新会话') c.title = (text || (refs.length ? refs[0].name : '新会话')).slice(0, 24);
    c.at = Date.now();
    persistConvos();

    pending = [];
    renderPending();
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

  /* ================= 设置面板 ================= */

  function fillSettings() {
    $('#key-input').value = apiKey;
    $('#model-select').value = settings.model;
    $('#model-label').textContent = settings.model;
    $('#thinking-toggle').checked = settings.thinking;
    $('#effort-select').value = settings.effort;
    $('#effort-field').style.display = settings.thinking ? '' : 'none';

    var hasImage = pending.some(function (a) { return a.kind === 'image'; });
    var note = $('#vision-note');
    note.textContent = settings.model === VISION_MODEL
      ? '当前模型支持看图。'
      : (hasImage ? '⚠️ 当前模型不支持看图，待发送的图片只有切到 deepseek-flash 才会生效。'
                  : '只有 deepseek-flash 能看图；它被选中时附件里的图片才会发送。');
    note.style.color = (settings.model !== VISION_MODEL && hasImage) ? '#ffb4b0' : '';
  }

  function openSheet(id) {
    fillSettings();
    $('#' + id).hidden = false;
    if (id === 'sheet-settings') renderPerms();
  }
  function closeSheet(id) { $('#' + id).hidden = true; }

  function renderHistory() {
    var list = $('#history-list');
    if (!convos.length) { list.innerHTML = '<p class="empty-note">还没有历史会话</p>'; return; }
    list.innerHTML = convos.map(function (c) {
      var n = c.messages.length;
      return '<div class="hist-item' + (c.id === currentId ? ' active' : '') + '" data-open="' + c.id + '">' +
        '<span class="hist-copy"><b>' + esc(c.title) + '</b>' +
        '<small>' + n + ' 条 · ' + new Date(c.at).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) + '</small></span>' +
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
        var gone = convos.filter(function (c) { return c.id === el.dataset.del; })[0];
        if (gone) {
          (gone.messages || []).forEach(function (m) {
            (m.attachments || []).forEach(function (a) { store.del(a.id).catch(function () {}); });
          });
        }
        convos = convos.filter(function (c) { return c.id !== el.dataset.del; });
        if (currentId === el.dataset.del) currentId = convos.length ? convos[0].id : null;
        if (currentId) localStorage.setItem(LS_CURRENT, currentId); else localStorage.removeItem(LS_CURRENT);
        persistConvos();
        renderHistory();
        render(true);
      };
    });
  }

  /* ================= 输入框 ================= */

  function autoGrow() {
    var ta = $('#input');
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, window.innerHeight * 0.34) + 'px';
    $('#btn-send').disabled = (!ta.value.trim() && !pending.length) || busy;
  }

  /* ================= 事件绑定 ================= */

  var input = $('#input');
  input.addEventListener('input', autoGrow);

  /* 顶栏与输入区是固定层（消息从它们下面滚过，玻璃才模糊得到东西），
   * 所以消息区需要按它们的实测高度留白。
   * 输入框会随文字长高、附件条会突然出现，所以必须用 ResizeObserver 实时回填，
   * 写死数值一定会错位。 */
  (function syncDockMetrics() {
    var bar = $('#topbar');
    var dock = $('#composer');
    function apply() {
      var root = document.documentElement.style;
      root.setProperty('--topbar-h', bar.offsetHeight + 'px');
      root.setProperty('--dock-h', dock.offsetHeight + 'px');
    }
    apply();
    if (window.ResizeObserver) {
      var ro = new ResizeObserver(apply);
      ro.observe(bar);
      ro.observe(dock);
    }
    window.addEventListener('resize', apply);
    window.addEventListener('orientationchange', function () { setTimeout(apply, 120); });
  })();

  // 代码块复制：用事件委托而不是逐个绑定，
  // 这样流式输出过程中已经渲染出来的代码块也能立刻复制。
  $('#messages').addEventListener('click', function (e) {
    var btn = e.target && e.target.closest ? e.target.closest('.code-copy') : null;
    if (!btn) return;
    var box = btn.closest('.code');
    var code = box && box.querySelector('code');
    if (code) copy(code.textContent);
  });

  // 消息区滚动后给顶栏加阴影，强化“内容在下面滚动”的层次
  (function () {
    var scroller = $('#messages');
    var bar = $('#topbar');
    scroller.addEventListener('scroll', function () {
      bar.classList.toggle('scrolled', scroller.scrollTop > 6);
    }, { passive: true });
  })();

  input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing &&
        window.matchMedia('(min-width: 820px)').matches) {
      e.preventDefault();
      $('#composer').requestSubmit();
    }
  });

  $('#composer').addEventListener('submit', function (e) {
    e.preventDefault();
    var text = input.value.trim();
    if ((!text && !pending.length) || busy) return;
    if (!apiKey) { openSheet('sheet-settings'); toast('请先填入 API Key'); return; }
    var keep = text;
    input.value = '';
    autoGrow();
    send(keep);
  });

  $('#btn-stop').onclick = function () { if (controller) controller.abort(); toast('已停止'); };
  $('#btn-new').onclick = function () {
    currentId = null;
    localStorage.removeItem(LS_CURRENT);
    pending = [];
    renderPending();
    render(true);
    toast('新会话');
  };
  $('#btn-history').onclick = function () { renderHistory(); openSheet('sheet-history'); };
  $('#btn-model').onclick = function () { openSheet('sheet-settings'); };
  $('#btn-settings').onclick = function () { openSheet('sheet-settings'); };

  // 附件菜单
  $('#btn-attach').onclick = function (e) {
    e.stopPropagation();
    var menu = $('#attach-menu');
    menu.hidden = !menu.hidden;
  };
  document.addEventListener('click', function (e) {
    var menu = $('#attach-menu');
    if (!menu.hidden && !menu.contains(e.target) && e.target !== $('#btn-attach')) menu.hidden = true;
  });
  $('#attach-menu').querySelectorAll('[data-attach]').forEach(function (b) {
    b.onclick = function () {
      $('#attach-menu').hidden = true;
      var kind = b.dataset.attach;
      if (kind === 'camera') openCamera();
      else if (kind === 'photo') $('#file-photo').click();
      else if (kind === 'doc') $('#file-doc').click();
    };
  });

  $('#file-photo').addEventListener('change', async function (e) {
    var files = Array.prototype.slice.call(e.target.files || []);
    e.target.value = '';
    if (files.length) await addFiles(files, true);
  });
  $('#file-doc').addEventListener('change', async function (e) {
    var files = Array.prototype.slice.call(e.target.files || []);
    e.target.value = '';
    if (files.length) await addFiles(files, false);
  });

  $$('[data-close]').forEach(function (b) {
    b.onclick = function () {
      if (b.dataset.close === 'sheet-camera') closeCamera();
      else closeSheet(b.dataset.close);
    };
  });
  $$('.sheet').forEach(function (s) {
    s.addEventListener('click', function (e) {
      if (e.target !== s) return;
      if (s.id === 'sheet-camera') closeCamera(); else s.hidden = true;
    });
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

  $('#btn-clear').onclick = async function () {
    if (!confirm('将删除本机保存的 API Key、全部会话、图片与设置，确定吗？')) return;
    [LS_KEY, LS_CONVOS, LS_SETTINGS, LS_CURRENT].forEach(function (k) { localStorage.removeItem(k); });
    try { await store.clear(); } catch (e) {}
    apiKey = '';
    convos = [];
    currentId = null;
    pending = [];
    pendingDoc = null;
    settings = { model: VISION_MODEL, thinking: true, effort: 'high' };
    renderPending();
    fillSettings();
    render(true);
    renderHistory();
    $('#settings-status').className = 'status';
    $('#settings-status').textContent = '已清空。';
  };

  /* ================= 启动 ================= */

  fillSettings();
  render(true);
  renderHistory();
  autoGrow();
  renderPending();

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('sw.js').catch(function () {});
    });
  }
})();
