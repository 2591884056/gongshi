/*
 * 界面逻辑：录入（粘贴 → 识别 → 核对保存）、记录（查看 / 编辑 / 删除）、
 * 报表（筛选 / 导出 Excel / 打印 / 生成图片）、设置（班组、人员名单、备份）
 *
 * 数据只存在当前浏览器的 localStorage 里，不上传任何服务器。
 */
(function () {
  'use strict';

  const P = window.WorkParser;
  const R = window.WorkReport;
  const X = window.WorkExport;
  const S = window.WorkSample;

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
  const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ESC[c]);
  const uniq = (arr) => Array.from(new Set(arr));
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const num = (v) => (v ? String(Math.round(v * 100) / 100) : '');
  const todayYmd = () => R.ymd(new Date());

  const IS_WECHAT = /MicroMessenger/i.test(navigator.userAgent);
  const IS_TOUCH = !!(window.matchMedia && matchMedia('(pointer: coarse)').matches);
  const DEMO = new URLSearchParams(location.search).has('demo');
  const STORE_KEY = DEMO ? 'gongshi.demo.v1' : 'gongshi.v1';
  const EXCELJS_SRC = 'vendor/exceljs.min.js?v=4.4.0';
  const MAX_DAYS = 62;
  const APP_VERSION = document.documentElement.dataset.version || 'dev'; // 发布包里由 scripts/build.js 填入
  const IS_STANDALONE = !!((window.matchMedia && matchMedia('(display-mode: standalone)').matches) || navigator.standalone);
  // 新款 iPad 的 UA 和 Mac 一样，只能靠「Mac + 触屏」认出来；先排除安卓
  const IS_IOS =
    !/Android/i.test(navigator.userAgent) &&
    (/iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1));
  const IS_ANDROID = /Android/i.test(navigator.userAgent);
  const BACKUP_REMIND_DAYS = 30;
  const UNDO_SECONDS = 12;

  /* ================= 状态与存储 ================= */

  const state = {
    records: [],
    settings: { team: '', rosterText: '', printDetail: false, lastBackupAt: 0, typeColors: {} },
    parsed: null, // 当前识别结果（还没保存）
    lastSaved: null, // 刚保存完，显示「看报表」入口
    pasteHint: null, // 'android-multi'：安卓上多选复制只粘进来一条
    report: { period: '', from: '', to: '', type: '*', hideEmpty: false, showDetail: false },
    filter: { month: '*', type: '*', q: '' },
  };

  function load() {
    try {
      const data = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
      if (!data) return;
      if (Array.isArray(data.records)) state.records = data.records;
      if (data.settings) Object.assign(state.settings, data.settings);
    } catch (e) {
      console.warn('读取本地数据失败', e);
    }
  }
  function save() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({ v: 1, records: state.records, settings: state.settings }));
    } catch (e) {
      toast('保存失败：浏览器存储不可用（是不是无痕模式？）', 'error');
    }
  }
  let saveTimer = 0;
  function saveSoon() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flushSave, 300);
  }
  // 页面切到后台或关闭时，把还没落盘的设置立刻存掉
  function flushSave() {
    if (!saveTimer) return;
    clearTimeout(saveTimer);
    saveTimer = 0;
    save();
  }

  const roster = () => P.parseRoster(state.settings.rosterText || '');
  const knownNames = () => uniq(state.records.flatMap((r) => r.names));
  const parseOpts = () => ({ roster: roster(), knownNames: knownNames(), refDate: new Date() });
  const monthsOf = (records) => uniq(records.map((r) => r.date.slice(0, 7))).sort().reverse();

  // 存进 localStorage 的记录只留这些字段；导入备份时也走这里做清洗
  function toStored(r, prev) {
    const rec = {
      id: prev ? prev.id : uid(),
      date: /^\d{4}-\d{2}-\d{2}$/.test(r.date) ? r.date : null,
      type: String(r.type || '').trim(),
      declared: r.declared == null || r.declared === '' || isNaN(+r.declared) ? null : +r.declared,
      names: uniq((Array.isArray(r.names) ? r.names : []).map((n) => String(n).trim()).filter(Boolean)),
      start: /^\d{2}:\d{2}$/.test(r.start) ? r.start : null,
      end: /^\d{2}:\d{2}$/.test(r.end) ? r.end : null,
      raw: String(r.raw || ''),
      createdAt: prev ? prev.createdAt : Date.now(),
      updatedAt: Date.now(),
    };
    rec.key = P.recordKey(rec);
    rec.slotKey = P.slotKey(rec);
    return rec;
  }

  /* ================= 小工具 ================= */

  function fmtDate(s) {
    const d = R.parseYmd(s);
    return d.getMonth() + 1 + '月' + d.getDate() + '日';
  }
  const fmtDateW = (s) => fmtDate(s) + ' 周' + R.weekday(s);

  /* 工种标签的颜色：每个工种第一次出现时分一个颜色，记在设置里，以后一直是这个颜色。
   * 常见的几个固定颜色；其他工种先用没被固定的颜色，用完了再轮着用。红色留给报表里的「没上班」，不用 */
  const TYPE_PRESET = { 打钻: 0, 出渣: 1, 挂网: 2, 喷浆: 3 };
  const TYPE_ORDER = [4, 5, 6, 7, 8, 9, 0, 1, 2, 3]; // 对应 css 里的 .tc0 ~ .tc9
  function typeColor(type) {
    const map = state.settings.typeColors || (state.settings.typeColors = {});
    if (map[type] == null) {
      const used = new Set(Object.keys(map).map((k) => map[k]));
      let i = TYPE_PRESET[type];
      if (i == null || used.has(i)) i = TYPE_ORDER.find((c) => !used.has(c));
      if (i == null) i = TYPE_ORDER[Object.keys(map).length % TYPE_ORDER.length];
      map[type] = i;
      saveSoon();
    }
    return map[type];
  }
  const typeTag = (type) => '<span class="rec-type ' + (type ? 'tc' + typeColor(type) : 'tc-none') + '">' + esc(type || '未写工种') + '</span>';
  const monthLabel = (ym) => ym.slice(0, 4) + '年' + +ym.slice(5, 7) + '月';
  const timeText = (r) => (r.start && r.end ? r.start + '–' + r.end : r.end ? r.end + ' 下班' : '没写下班时间');
  const mismatch = (r) => r.declared != null && r.declared !== r.names.length;

  let toastTimer = 0;
  let toastAction = null;
  // action = { label, run }：提示条上带一个按钮（比如「撤销」），显示时间长一些
  function toast(msg, kind, action) {
    const t = $('#toast');
    t.textContent = msg;
    toastAction = action || null;
    if (action) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'toast-action';
      b.dataset.act = 'toast-action';
      b.textContent = action.label;
      t.appendChild(b);
    }
    t.className = 'toast' + (kind ? ' toast-' + kind : '');
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(hideToast, action ? UNDO_SECONDS * 1000 : 2800);
  }
  function hideToast() {
    clearTimeout(toastTimer);
    $('#toast').hidden = true;
    toastAction = null;
  }

  let pendingFile = null;
  let pendingImage = null;
  function openModal(html, cls) {
    const box = $('#modal-box');
    box.className = 'modal-box' + (cls ? ' ' + cls : '');
    box.innerHTML = html;
    $('#modal').hidden = false;
    document.body.classList.add('modal-open');
  }
  function closeModal() {
    $('#modal').hidden = true;
    $('#modal-box').innerHTML = '';
    document.body.classList.remove('modal-open');
    pendingFile = null;
    pendingImage = null;
  }

  function busy(btn, on, label) {
    if (!btn) return;
    if (on) {
      btn.dataset.label = btn.textContent;
      btn.textContent = label;
      btn.disabled = true;
    } else {
      btn.textContent = btn.dataset.label || btn.textContent;
      btn.disabled = false;
    }
  }

  function download(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  function wechatHint(what) {
    openModal(
      '<h3>微信里不能直接' + esc(what) + '</h3>' +
        '<ol class="steps"><li>点右上角「···」</li><li>选「在浏览器打开」（苹果手机是「在 Safari 中打开」）</li><li>在浏览器里再点一次「' + esc(what) + '」</li></ol>' +
        '<p class="muted">也可以点「生成图片」，长按图片发到群里。<br>注意：数据只存在当前这个浏览器里，换到别的浏览器打开要重新粘贴。建议以后都在手机浏览器里用这个页面，并「添加到主屏幕」。</p>' +
        '<div class="modal-actions"><button class="btn btn-primary" data-act="close-modal">知道了</button></div>'
    );
  }

  function updateBadge() {
    $('#rec-count').textContent = state.records.length || '';
  }
  function updateBrand() {
    $('#brand-team').textContent = state.settings.team || '';
  }

  /* ================= 路由 ================= */

  const VIEWS = ['input', 'records', 'report', 'settings'];
  function currentView() {
    const v = (location.hash || '').slice(1);
    return VIEWS.indexOf(v) < 0 ? 'input' : v;
  }
  // 记录增删以后，重画当前页面（录入页里已识别的状态也要跟着更新）
  function rerender() {
    const v = currentView();
    if (v === 'records') renderRecords();
    if (v === 'report') renderReport();
    if (v === 'settings') renderSettings();
    if (state.parsed) runParse();
  }
  function route() {
    const v = currentView();
    VIEWS.forEach((name) => ($('#view-' + name).hidden = name !== v));
    $$('#tabs a').forEach((a) => a.classList.toggle('active', a.dataset.view === v));
    if (v === 'input') renderParse();
    if (v === 'records') renderRecords();
    if (v === 'report') renderReport();
    if (v === 'settings') renderSettings();
    window.scrollTo(0, 0);
  }

  /* ================= 录入 ================= */

  const STATUS = {
    new: ['新记录', 'st-new'],
    replace: ['更正', 'st-replace'],
    dup: ['已保存过', 'st-dup'],
    superseded: ['被后面的更正代替', 'st-dup'],
    invalid: ['无法保存', 'st-invalid'],
  };
  const selectable = (r) => r._status === 'new' || r._status === 'replace';

  let parseTimer = 0;
  function scheduleParse() {
    clearTimeout(parseTimer);
    parseTimer = setTimeout(runParse, 350);
  }

  // uncheckedKeys：刷新页面前用户取消勾选的记录（见 reloadForUpdate），重新识别后保持不勾
  function runParse(uncheckedKeys) {
    clearTimeout(parseTimer);
    const text = $('#paste-box').value;
    state.lastSaved = null;
    if (!text.trim()) {
      state.parsed = null;
      renderParse();
      return;
    }
    const prevChecked = new Map(((state.parsed && state.parsed.records) || []).map((r) => [r.key, r._checked]));
    if (Array.isArray(uncheckedKeys)) uncheckedKeys.forEach((k) => prevChecked.set(k, false));
    const res = P.parse(text, parseOpts());
    const savedKeys = new Set(state.records.map((r) => r.key));
    const savedSlots = new Map(state.records.filter((r) => r.slotKey).map((r) => [r.slotKey, r]));
    // 同一次粘贴里同一班出现两次（原消息 + 更正），以后面的为准
    const lastOfSlot = new Map();
    res.records.forEach((r, i) => !r.dupInBatch && r.slotKey && lastOfSlot.set(r.slotKey, i));
    res.records.forEach((r, i) => {
      if (!r.date || !r.names.length) r._status = 'invalid';
      else if (r.dupInBatch || savedKeys.has(r.key)) r._status = 'dup';
      else if (r.slotKey && lastOfSlot.get(r.slotKey) !== i) r._status = 'superseded';
      else if (r.slotKey && savedSlots.has(r.slotKey)) {
        r._status = 'replace';
        r._old = savedSlots.get(r.slotKey);
      } else r._status = 'new';
      r._checked = selectable(r) && (prevChecked.has(r.key) ? prevChecked.get(r.key) : true);
    });
    state.parsed = res;
    renderParse();
  }

  function previewCard(r, i) {
    const st = STATUS[r._status];
    const unknown = new Set(r.unknown || []);
    const names = r.names.map((n) => '<span class="chip' + (unknown.has(n) ? ' chip-warn' : '') + '">' + esc(n) + '</span>').join('');
    const warns = r.warnings.map((w) => '<li class="lv-' + w.level + '">' + esc(w.text) + '</li>').join('');
    const meta = [];
    if (r.declared != null) meta.push('报 ' + r.declared + ' 人');
    meta.push('认出 ' + r.names.length + ' 人');
    if (r.end) meta.push(timeText(r));
    return (
      '<label class="rec-card' + (selectable(r) ? '' : ' is-off') + '">' +
      '<input type="checkbox" data-act="toggle" data-i="' + i + '"' + (r._checked ? ' checked' : '') + (selectable(r) ? '' : ' disabled') + '>' +
      '<div class="rec-body"><div class="rec-title">' +
      '<b>' + esc(r.date ? fmtDateW(r.date) : '日期不对') + '</b>' +
      typeTag(r.type) +
      '<span class="rec-meta">' + esc(meta.join(' · ')) + '</span>' +
      '<span class="status ' + st[1] + '">' + st[0] + '</span></div>' +
      (r._status === 'replace' ? '<div class="rec-note">同一班已经存过一条（' + r._old.names.length + ' 人），保存后用这条替换</div>' : '') +
      (names ? '<div class="chips">' + names + '</div>' : '') +
      (warns ? '<ul class="warns">' + warns + '</ul>' : '') +
      '</div></label>'
    );
  }

  function renderParse() {
    const box = $('#parse-result');
    if (state.lastSaved) {
      const s = state.lastSaved;
      box.innerHTML =
        '<div class="card saved-card"><div class="saved-icon">✓</div><div><b>已保存 ' + (s.added + s.replaced) + ' 条</b>' +
        (s.replaced ? '<span class="muted">（其中更正 ' + s.replaced + ' 条）</span>' : '') +
        '<div class="muted">现在一共 ' + state.records.length + ' 条记录</div></div>' +
        '<div class="saved-actions"><a class="btn" href="#records">看记录</a><a class="btn btn-primary" href="#report">看报表</a></div></div>';
      return;
    }
    const res = state.parsed;
    if (!res) {
      box.innerHTML = '';
      return;
    }
    const recs = res.records;
    let html = '<div class="card">';
    if (state.pasteHint === 'android-multi') {
      html +=
        '<div class="notice paste-hint"><b>只粘贴进来 1 条？</b>在微信里「多选 → 复制」的消息，安卓手机的浏览器只能读到第一条（系统限制，网页绕不过去）。可以这样：' +
        '<ol><li>打开手机自带的「便签」或「备忘录」，粘贴进去，再「全选 → 复制」，回到这里点「粘贴」</li>' +
        '<li>或者在微信里一条一条长按复制，回来点「粘贴」（会接在后面）</li>' +
        '<li>或者用电脑版微信多选复制，电脑上没有这个限制</li></ol></div>';
    }
    if (!recs.length) {
      html += '<div class="empty">没认出报工消息。<br><span class="muted">消息要以「X月X号 …… N人」开头，比如「9月7号打钻13人」。</span></div>';
    } else {
      const count = (st) => recs.filter((r) => r._status === st).length;
      const parts = ['new', 'replace', 'dup', 'superseded', 'invalid']
        .filter((st) => count(st))
        .map((st) => STATUS[st][0] + ' ' + count(st));
      html += '<div class="result-head"><b>认出 ' + recs.length + ' 条</b><span class="muted">' + esc(parts.join(' · ')) + '</span></div>';
      html += recs.map(previewCard).join('');
    }
    if (res.ignored.length) {
      html +=
        '<details class="ignored"><summary>有 ' + res.ignored.length + ' 行文字没用上（点开看看有没有漏的）</summary><ol>' +
        res.ignored.map((x) => '<li>' + esc(x.text) + '</li>').join('') +
        '</ol></details>';
    }
    html += '</div>';
    const checked = recs.filter((r) => r._checked);
    if (recs.length) {
      const warned = checked.filter((r) => r.warnings.some((w) => w.level !== 'info')).length;
      html +=
        '<div class="save-bar"><span>' +
        (warned ? '<span class="warn-text">有 ' + warned + ' 条带提醒，保存前看一眼</span>' : checked.length ? '核对无误就保存' : '<span class="muted">没有要保存的</span>') +
        '</span><button class="btn btn-primary btn-lg" data-act="save-parsed"' + (checked.length ? '' : ' disabled') + '>保存 ' + checked.length + ' 条</button></div>';
    }
    box.innerHTML = html;
  }

  function saveParsed() {
    const res = state.parsed;
    if (!res) return;
    let added = 0;
    let replaced = 0;
    let latest = '';
    res.records.forEach((r) => {
      if (!r._checked || !selectable(r)) return;
      const i = r.slotKey ? state.records.findIndex((x) => x.slotKey === r.slotKey) : -1;
      if (i >= 0) {
        state.records[i] = toStored(r, state.records[i]);
        replaced++;
      } else {
        state.records.push(toStored(r));
        added++;
      }
      if (r.date > latest) latest = r.date;
    });
    save();
    askPersist();
    if (latest) state.report.period = latest.slice(0, 7); // 报表直接跳到刚存的月份
    state.parsed = null;
    state.pasteHint = null;
    state.lastSaved = { added, replaced };
    $('#paste-box').value = '';
    updateBadge();
    renderParse();
  }

  /* ---- 读剪贴板 ----
   * 手机微信「多选 → 复制」时，剪贴板里每条消息是单独的一项，浏览器默认只取第一项，
   * 所以用户会觉得「粘贴不全」。实测（2026-09）：
   *  - 苹果手机：navigator.clipboard.read() 能读到所有项；长按粘贴时在 paste 事件里调用也不会再弹确认；
   *  - 安卓手机：Chrome 等浏览器无论怎么读都只给第一项，网页绕不过去，只能提示用户换个复制方法。
   */
  async function readClipboard() {
    const cb = navigator.clipboard;
    if (cb && cb.read) {
      let items = null;
      try {
        items = await cb.read(); // 必须在点击 / 粘贴事件里同步发起，这一句之前不能有 await
      } catch (e) {
        if (e && e.name === 'NotAllowedError') throw e; // 用户没点系统的「粘贴」或没给权限：别再弹第二次
      }
      if (items) {
        const texts = [];
        for (const item of items) {
          const t = await clipItemText(item);
          if (t.trim()) texts.push(t.replace(/\s+$/, ''));
        }
        return { text: texts.join('\n\n'), items: texts.length };
      }
    }
    if (cb && cb.readText) return { text: await cb.readText(), items: 1 };
    throw new Error('unsupported');
  }

  async function clipItemText(item) {
    try {
      if (item.types.indexOf('text/plain') >= 0) return await (await item.getType('text/plain')).text();
      if (item.types.indexOf('text/html') >= 0) return htmlToText(await (await item.getType('text/html')).text());
    } catch (e) {
      /* 这一项读不出来就跳过 */
    }
    return '';
  }

  function htmlToText(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    doc.querySelectorAll('br').forEach((el) => el.replaceWith('\n'));
    doc.querySelectorAll('p, div, li, tr').forEach((el) => el.append('\n'));
    return doc.body ? doc.body.textContent : '';
  }

  // 粘贴之后识别。安卓上如果看起来是「多选 → 复制」的（带发送时间），却只进来 1 条，提示换个办法
  function afterPaste(text, items) {
    state.pasteHint = null;
    if (IS_ANDROID && items <= 1 && P.countTimeLines(text) > 0 && P.parse(text, parseOpts()).records.length <= 1) {
      state.pasteHint = 'android-multi';
    }
    runParse();
  }

  let pasteSeq = 0;
  async function pasteFromClipboard() {
    const box = $('#paste-box');
    const seq = ++pasteSeq;
    let clip;
    try {
      clip = await readClipboard();
    } catch (e) {
      if (seq !== pasteSeq) return; // 用户又点了一次，这次作废
      // 用户在系统的「粘贴」气泡外点了一下，或者浏览器根本不给读：都改成让用户自己在输入框里粘贴
      box.focus();
      toast('没读到剪贴板：请在输入框里点一下，选「粘贴」');
      return;
    }
    if (seq !== pasteSeq) return;
    if (!clip.text.trim()) {
      box.focus();
      toast('剪贴板是空的：先去微信里长按消息 →「复制」');
      return;
    }
    box.value = box.value.trim() ? box.value.replace(/\s*$/, '') + '\n\n' + clip.text : clip.text;
    afterPaste(clip.text, clip.items);
  }

  // 在输入框里长按粘贴 / Ctrl+V。苹果手机上改用 readClipboard() 把所有项都读出来
  function onNativePaste(e) {
    const box = e.target;
    const cd = e.clipboardData;
    const first = cd ? cd.getData('text/plain') : '';
    if (!IS_IOS || !cd || !navigator.clipboard || !navigator.clipboard.read) {
      setTimeout(() => afterPaste(first, 1), 0);
      return;
    }
    const start = box.selectionStart;
    const end = box.selectionEnd;
    const reading = readClipboard(); // 要在事件里同步发起
    e.preventDefault();
    reading
      .catch(() => null)
      .then((clip) => {
        // 只有一项时，和系统默认的粘贴结果完全一样
        const text = clip && clip.items > 1 ? clip.text : first || (clip ? clip.text : '');
        if (!text) return toast('剪贴板里没有文字');
        box.setRangeText(text, start, end, 'end');
        afterPaste(text, clip ? clip.items : 1);
      });
  }

  /* ================= 记录 ================= */

  function renderRecords() {
    const f = state.filter;
    const months = monthsOf(state.records);
    const types = uniq(state.records.map((r) => r.type || '')).sort();
    if (f.month !== '*' && months.indexOf(f.month) < 0) f.month = '*';
    if (f.type !== '*' && types.indexOf(f.type) < 0) f.type = '*';
    const opt = (v, label, cur) => '<option value="' + esc(v) + '"' + (v === cur ? ' selected' : '') + '>' + esc(label) + '</option>';
    $('#records-toolbar').innerHTML =
      '<select data-bind="filter.month" aria-label="月份">' + opt('*', '全部月份', f.month) + months.map((m) => opt(m, monthLabel(m), f.month)).join('') + '</select>' +
      '<select data-bind="filter.type" aria-label="工种">' + opt('*', '全部工种', f.type) + types.map((t) => opt(t, t || '未写工种', f.type)).join('') + '</select>' +
      '<input type="search" data-bind="filter.q" placeholder="按名字找" value="' + esc(f.q) + '">' +
      '<button class="btn" data-act="new-record">+ 手动添加</button>' +
      (state.records.length ? '<button class="btn btn-danger-ghost" data-act="clear-records">清空</button>' : '');
    renderRecordList();
  }

  // 记录页当前筛选条件下显示的记录
  function filteredRecords() {
    const f = state.filter;
    const q = f.q.trim();
    return state.records.filter(
      (r) => (f.month === '*' || r.date.slice(0, 7) === f.month) && (f.type === '*' || (r.type || '') === f.type) && (!q || r.names.some((n) => n.indexOf(q) >= 0))
    );
  }

  function renderRecordList() {
    const q = state.filter.q.trim();
    const box = $('#records-list');
    if (!state.records.length) {
      box.innerHTML = '<div class="card empty">还没有记录。<br><a href="#input">去「录入」粘贴群消息</a></div>';
      return;
    }
    const list = filteredRecords().sort((a, b) => {
        // 新的在上：日期倒序，同一天按下班时间倒序
        const ka = a.date + ' ' + (a.end || '');
        const kb = b.date + ' ' + (b.end || '');
        return ka < kb ? 1 : ka > kb ? -1 : 0;
      });
    if (!list.length) {
      box.innerHTML = '<div class="card empty">没有符合条件的记录</div>';
      return;
    }
    const groups = [];
    list.forEach((r) => {
      const g = groups[groups.length - 1];
      if (g && g.date === r.date) g.items.push(r);
      else groups.push({ date: r.date, items: [r] });
    });
    const personTimes = list.reduce((s, r) => s + r.names.length, 0);
    let html =
      '<div class="summary-line">' +
      (q ? '「' + esc(q) + '」出现在 ' + list.length + ' 条记录里' : '共 ' + list.length + ' 条，' + personTimes + ' 人次') +
      '</div>';
    groups.forEach((g) => {
      html +=
        '<div class="day-group"><div class="day-head"><b>' + esc(fmtDateW(g.date)) + '</b><span class="muted">' + g.items.length + ' 条 · ' +
        g.items.reduce((s, r) => s + r.names.length, 0) + ' 人次</span></div>';
      g.items.forEach((r) => {
        const names = r.names.map((n) => (q && n.indexOf(q) >= 0 ? '<mark>' + esc(n) + '</mark>' : esc(n))).join('、');
        html +=
          '<div class="rec-card stored"><div class="rec-body"><div class="rec-title">' +
          typeTag(r.type) +
          '<span class="rec-meta">' + r.names.length + ' 人 · ' + esc(timeText(r)) + '</span>' +
          (mismatch(r) ? '<span class="status st-warn">人数对不上：写的 ' + r.declared + ' 人</span>' : '') +
          '</div><div class="rec-names">' + names + '</div></div>' +
          '<div class="rec-actions"><button class="btn btn-sm" data-act="edit" data-id="' + esc(r.id) + '">编辑</button>' +
          '<button class="btn btn-sm btn-danger-ghost" data-act="delete" data-id="' + esc(r.id) + '">删除</button></div></div>';
      });
      html += '</div>';
    });
    box.innerHTML = html;
  }

  function openEditor(rec) {
    const isNew = !rec;
    const last = state.records[state.records.length - 1];
    const r = rec || { date: todayYmd(), type: last ? last.type : '', declared: null, names: [], start: null, end: null, raw: '' };
    const types = uniq(state.records.map((x) => x.type).filter(Boolean));
    openModal(
      '<h3>' + (isNew ? '手动添加记录' : '编辑记录') + '</h3>' +
        '<form id="edit-form" class="form" novalidate><div class="form-grid">' +
        '<label>日期<input type="date" name="date" required value="' + esc(r.date) + '"></label>' +
        '<label>工种<input name="type" list="type-list" value="' + esc(r.type) + '" placeholder="如：打钻"></label>' +
        '<label>上报人数<input type="number" name="declared" min="0" inputmode="numeric" value="' + (r.declared == null ? '' : r.declared) + '" placeholder="可不填"></label>' +
        '<label>上班时间<input type="time" name="start" value="' + esc(r.start || '') + '"></label>' +
        '<label>下班时间<input type="time" name="end" value="' + esc(r.end || '') + '"></label>' +
        '</div><datalist id="type-list">' + types.map((t) => '<option value="' + esc(t) + '">').join('') + '</datalist>' +
        '<label class="block">人员（逗号、顿号、空格隔开都行）<textarea name="names" rows="4">' + esc(r.names.join('、')) + '</textarea></label>' +
        '<div class="names-preview muted" id="names-preview"></div>' +
        (r.raw ? '<details class="raw"><summary>原始消息</summary><pre>' + esc(r.raw) + '</pre></details>' : '') +
        '<div class="modal-actions"><button type="button" class="btn btn-ghost" data-act="close-modal">取消</button>' +
        '<button type="submit" class="btn btn-primary">保存</button></div></form>'
    );
    const form = $('#edit-form');
    const F = form.elements;
    const preview = () => {
      const res = P.splitNames(F.names.value, parseOpts());
      let t = '认出 ' + res.names.length + ' 人';
      if (res.dups.length) t += '；重复：' + res.dups.join('、');
      if (res.unrecognized.length) t += '；没认出：' + res.unrecognized.join('、');
      $('#names-preview').textContent = t;
    };
    F.names.addEventListener('input', preview);
    preview();
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const names = P.splitNames(F.names.value, parseOpts()).names;
      if (!F.date.value) return toast('请填日期');
      if (!names.length) return toast('请填人员');
      const next = toStored(
        { date: F.date.value, type: F.type.value, declared: F.declared.value, names, start: F.start.value, end: F.end.value, raw: r.raw },
        rec
      );
      if (isNew) state.records.push(next);
      else state.records[state.records.findIndex((x) => x.id === rec.id)] = next;
      save();
      closeModal();
      updateBadge();
      renderRecords();
      toast(isNew ? '已添加' : '已保存');
    });
  }

  function deleteRecord(id) {
    const r = state.records.find((x) => x.id === id);
    if (!r) return;
    if (!confirm('删除 ' + fmtDate(r.date) + ' ' + (r.type || '') + '（' + r.names.length + ' 人）这条记录？')) return;
    state.records = state.records.filter((x) => x.id !== id);
    save();
    updateBadge();
    renderRecords();
    toast('已删除');
  }

  /* ================= 报表 ================= */

  function ensurePeriod() {
    const rp = state.report;
    if (rp.period === 'custom') {
      if (!rp.from || !rp.to) Object.assign(rp, R.monthRange(todayYmd().slice(0, 7)));
      return;
    }
    if (!rp.period) rp.period = monthsOf(state.records)[0] || todayYmd().slice(0, 7);
    Object.assign(rp, R.monthRange(rp.period));
  }

  function currentReport() {
    ensurePeriod();
    const rp = state.report;
    const from = rp.from <= rp.to ? rp.from : rp.to;
    const to = rp.from <= rp.to ? rp.to : rp.from;
    // 统计口径固定为「出勤次数」（客户确认）；report.js 里保留了按工时统计的能力，需要时再开
    return R.build(state.records, {
      from,
      to,
      type: rp.type === '*' ? null : rp.type,
      roster: roster(),
      hideEmpty: rp.hideEmpty,
      today: todayYmd(), // 标出每个人没上班的日子
    });
  }

  function controlsHtml(rep) {
    const rp = state.report;
    const months = uniq(monthsOf(state.records).concat([todayYmd().slice(0, 7)], rp.period && rp.period !== 'custom' ? [rp.period] : []))
      .sort()
      .reverse();
    const opt = (v, label, cur) => '<option value="' + esc(v) + '"' + (v === cur ? ' selected' : '') + '>' + esc(label) + '</option>';
    return (
      '<div class="ctl-row">' +
      '<label class="ctl"><span>月份</span><select data-bind="report.period">' +
      months.map((m) => opt(m, monthLabel(m), rp.period)).join('') +
      opt('custom', '自定义区间…', rp.period) +
      '</select></label>' +
      (rp.period === 'custom'
        ? '<label class="ctl"><span>从</span><input type="date" data-bind="report.from" value="' + esc(rp.from) + '"></label>' +
          '<label class="ctl"><span>到</span><input type="date" data-bind="report.to" value="' + esc(rp.to) + '"></label>'
        : '') +
      '<label class="ctl"><span>工种</span><select data-bind="report.type">' +
      opt('*', '全部', rp.type) +
      rep.types.map((t) => opt(t, t || '未写工种', rp.type)).join('') +
      '</select></label>' +
      (roster().length ? '<label class="check"><input type="checkbox" data-bind="report.hideEmpty"' + (rp.hideEmpty ? ' checked' : '') + '>隐藏没记录的人</label>' : '') +
      '</div><div class="ctl-row actions">' +
      '<button class="btn btn-primary" data-act="export-xlsx">导出 Excel</button>' +
      '<button class="btn" data-act="print">打印</button>' +
      '<button class="btn" data-act="image">生成图片</button>' +
      '<label class="check"><input type="checkbox" data-bind="settings.printDetail"' + (state.settings.printDetail ? ' checked' : '') + '>打印时附上明细</label>' +
      '</div>'
    );
  }

  function tableHtml(rep) {
    const rosterOn = roster().length > 0;
    let h =
      '<div class="table-wrap"><table class="rpt' + (rep.dates.length > 16 ? ' dense' : '') + '">' +
      '<colgroup><col class="c-no"><col class="c-name">' + rep.dates.map(() => '<col class="c-day">').join('') + '<col class="c-total"><col class="c-days"></colgroup>' +
      '<thead><tr><th class="c-no">序号</th><th class="c-name">姓名</th>';
    rep.dates.forEach((d, i) => (h += '<th class="c-day">' + R.dayLabel(d, i) + '<small>' + R.weekday(d) + '</small></th>'));
    h += '<th class="c-total">合计<small>次</small></th><th class="c-days">出勤<small>天数</small></th></tr></thead><tbody>';
    rep.rows.forEach((row) => {
      h += '<tr' + (row.count ? '' : ' class="empty-row"') + '><td class="c-no">' + row.no + '</td><td class="c-name">' + esc(row.name) +
        (rosterOn && !row.inRoster ? '<i class="tag-out" title="不在人员名单里">名单外</i>' : '') + '</td>';
      rep.dates.forEach((d) => {
        const v = row.cells[d];
        h += row.absent[d]
          ? '<td class="c-day absent" title="没上班"></td>'
          : '<td class="c-day">' + (v ? num(v) : row.missing[d] ? '<span class="miss">?</span>' : '') + '</td>';
      });
      // 出勤天数留空，打印出来手写（客户要求）；report.js 仍然算出 row.days，需要时再显示
      h += '<td class="c-total">' + num(row.total) + '</td><td class="c-days"></td></tr>';
    });
    h += '</tbody><tfoot><tr><td class="c-no"></td><td class="c-name">合计</td>';
    rep.dates.forEach((d) => (h += '<td class="c-day">' + num(rep.colTotals[d]) + '</td>'));
    h += '<td class="c-total">' + num(rep.grand) + '</td><td class="c-days"></td></tr></tfoot></table></div>';
    return h;
  }

  function sheetHtml(rep, info) {
    if (rep.dates.length > MAX_DAYS) return '<div class="empty">区间太长了（' + rep.dates.length + ' 天）。一张表最多 ' + MAX_DAYS + ' 天，请缩短。</div>';
    const sub = info.subtitle.split('　').map((s) => '<span>' + esc(s) + '</span>').join('');
    let h = '<div class="sheet-title">' + esc(info.title) + '</div><div class="sheet-sub">' + sub + '</div>';
    if (!rep.rows.length) {
      return h + '<div class="empty">这段时间还没有记录。<br><a href="#input">去「录入」粘贴群消息</a></div>';
    }
    h += tableHtml(rep);
    h += '<div class="legend">' + esc(info.legend) + '</div>';
    const notes = [];
    if (rep.mismatched) notes.push('有 ' + rep.mismatched + ' 条记录写的人数和名单对不上，建议核对。<a href="#records">去看记录</a>');
    if (rep.outsiders.length)
      notes.push('名单外的人：' + esc(rep.outsiders.join('、')) + '。如果是错别字，可以在设置的人员名单里写成「正确名=错写名」合并。');
    if (backupDue())
      notes.push('数据只存在这台手机上，记得每月导出一次备份，换手机时能导回来。<a href="#settings">去备份</a>');
    if (notes.length) h += '<div class="notices">' + notes.map((n) => '<div class="notice">' + n + '</div>').join('') + '</div>';
    h += '<div class="sign"><span>制表人：<i></i></span><span>审核：<i></i></span><span>日期：<i></i></span></div>';
    return h;
  }

  function detailHtml(rep, info) {
    if (!rep.records.length || rep.dates.length > MAX_DAYS) return '';
    const open = state.report.showDetail;
    let h =
      '<div class="detail-head"><button class="btn btn-link" data-act="toggle-detail">' + (open ? '收起明细' : '查看明细（' + rep.records.length + ' 条报工消息）') + '</button></div>' +
      '<div class="detail-body' + (open ? '' : ' collapsed') + '"><div class="sheet-title print-only">' + esc(info.title.replace('考勤统计表', '报工明细')) + '</div>' +
      '<div class="sheet-sub print-only">' + esc(info.subtitle) + '</div>' +
      '<div class="table-wrap"><table class="dtl"><thead><tr><th>序号</th><th>日期</th><th>工种</th><th>人数</th><th>时间</th><th>人员</th></tr></thead><tbody>';
    rep.records.forEach((r, i) => {
      h +=
        '<tr><td>' + (i + 1) + '</td><td>' + esc(fmtDateW(r.date)) + '</td><td>' + typeTag(r.type) + '</td><td>' + r.names.length +
        (mismatch(r) ? '<span class="miss">（写的 ' + r.declared + '）</span>' : '') + '</td><td>' + esc(timeText(r)) + '</td><td class="names">' + esc(r.names.join('、')) + '</td></tr>';
    });
    return h + '</tbody></table></div></div>';
  }

  function renderReport() {
    ensurePeriod();
    const rep = currentReport();
    if (state.report.type !== '*' && rep.types.indexOf(state.report.type) < 0) {
      state.report.type = '*'; // 换了月份后原来的工种可能不存在了
      return renderReport();
    }
    const info = R.describe(rep, state.settings.team);
    $('#report-controls').innerHTML = controlsHtml(rep);
    $('#report-sheet').innerHTML = sheetHtml(rep, info);
    $('#detail-sheet').innerHTML = detailHtml(rep, info);
    document.body.classList.toggle('print-detail', !!state.settings.printDetail);
  }

  function reportReady() {
    const rep = currentReport();
    if (rep.dates.length > MAX_DAYS) {
      toast('区间太长了，请缩短到 ' + MAX_DAYS + ' 天以内');
      return null;
    }
    return { rep, info: R.describe(rep, state.settings.team) };
  }

  let excelPromise = null;
  function loadExcelJS() {
    if (window.ExcelJS) return Promise.resolve(window.ExcelJS);
    if (!excelPromise) {
      excelPromise = new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = EXCELJS_SRC;
        s.onload = () => (window.ExcelJS ? resolve(window.ExcelJS) : reject(new Error('Excel 组件没加载好')));
        s.onerror = () => {
          excelPromise = null;
          reject(new Error('Excel 组件加载失败，检查网络后再试'));
        };
        document.head.appendChild(s);
      });
    }
    return excelPromise;
  }

  async function exportExcel(btn) {
    if (IS_WECHAT) return wechatHint('导出 Excel');
    const ready = reportReady();
    if (!ready) return;
    busy(btn, true, '生成中…');
    try {
      const ExcelJS = await loadExcelJS();
      const buf = await X.buildWorkbook(ExcelJS, ready.rep, ready.info).xlsx.writeBuffer();
      const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      deliverFile(blob, ready.info.fileBase + '.xlsx', 'Excel 已生成');
    } catch (e) {
      console.error(e);
      toast(e.message || '导出失败', 'error');
    } finally {
      busy(btn, false);
    }
  }

  // 电脑上直接下载；手机上多给一个「分享」（发给微信好友、存到文件），分享必须由一次新的点击触发
  function deliverFile(blob, filename, title) {
    let file = null;
    try {
      file = new File([blob], filename, { type: blob.type });
    } catch (e) {
      file = null;
    }
    const canShare = IS_TOUCH && file && navigator.canShare && navigator.canShare({ files: [file] });
    if (!canShare) {
      download(blob, filename);
      toast('已导出：' + filename);
      return;
    }
    openModal(
      '<h3>' + esc(title || '文件已生成') + '</h3><p class="muted">' + esc(filename) + '</p>' +
        '<div class="modal-actions stack"><button class="btn btn-primary btn-lg" data-act="share-file">分享 / 存到文件</button>' +
        '<button class="btn btn-lg" data-act="download-file">下载</button><button class="btn btn-ghost" data-act="close-modal">关闭</button></div>'
    );
    pendingFile = { blob, file, filename };
  }

  async function shareFile() {
    const f = pendingFile;
    if (!f) return;
    try {
      await navigator.share({ files: [f.file] }); // 别带 title：苹果会把它当成第二个文件一起存
      closeModal();
    } catch (e) {
      if (e && e.name === 'AbortError') return;
      download(f.blob, f.filename);
      closeModal();
    }
  }

  function printReport() {
    if (IS_WECHAT) return wechatHint('打印');
    if (!reportReady()) return;
    if (IS_TOUCH) {
      // 手机浏览器不认页面里设的「A4 横向」，默认竖着打，表格会很小
      openModal(
        '<h3>打印前设置一下</h3>' +
          '<ol class="steps"><li>打印设置里把「方向」选成「横向」</li><li>纸张选「A4」</li></ol>' +
          '<p class="muted">没有这些选项也能打，会自动缩到一页。也可以「导出 Excel」，用 WPS 打开再打印。</p>' +
          '<div class="modal-actions"><button class="btn btn-ghost" data-act="close-modal">取消</button>' +
          '<button class="btn btn-primary" data-act="print-now">去打印</button></div>'
      );
      return;
    }
    printNow();
  }

  function printNow() {
    closeModal();
    renderReport();
    setTimeout(() => window.print(), 60);
  }

  function makeImage() {
    const ready = reportReady();
    if (!ready) return;
    if (!ready.rep.rows.length) return toast('这段时间没有记录');
    let url;
    try {
      url = X.drawReportImage(ready.rep, ready.info).toDataURL('image/png');
    } catch (e) {
      console.error(e);
      return toast('生成图片失败', 'error');
    }
    openModal(
      '<h3>报表图片</h3><p class="muted">' + (IS_TOUCH ? '长按图片，可以保存到相册或发给微信好友、群' : '可以右键复制图片，或下载后发送') + '</p>' +
        '<div class="img-wrap"><img src="' + url + '" alt="' + esc(ready.info.title) + '"></div>' +
        '<div class="modal-actions">' + (IS_WECHAT ? '' : '<button class="btn" data-act="download-image">下载图片</button>') +
        '<button class="btn btn-primary" data-act="close-modal">完成</button></div>',
      'wide'
    );
    pendingImage = { url, filename: ready.info.fileBase + '.png' };
  }

  async function downloadImage() {
    if (!pendingImage) return;
    const blob = await (await fetch(pendingImage.url)).blob();
    download(blob, pendingImage.filename);
  }

  /* ================= 设置 ================= */

  function rosterSummary() {
    const rs = roster();
    const aliases = rs.reduce((s, p) => s + p.aliases.length, 0);
    return rs.length ? '已填 ' + rs.length + ' 人' + (aliases ? '，' + aliases + ' 个别名' : '') : '没填也能用';
  }

  function renderSettings() {
    const s = state.settings;
    const dates = state.records.map((r) => r.date).sort();
    $('#view-settings').innerHTML =
      '<div class="card"><div class="card-head"><h2>班组名称</h2><span class="muted">写在报表标题上</span></div>' +
      '<input class="input" data-bind="settings.team" value="' + esc(s.team) + '" placeholder="例如：一号斜井开挖班"></div>' +
      '<div class="card"><div class="card-head"><h2>人员名单</h2><span class="muted" id="roster-count">' + rosterSummary() + '</span></div>' +
      '<p class="tip" style="margin:0 0 10px">一行一个人，报表按这个顺序排。错别字、小名可以写成「正确名=错写名」，统计时自动合并；群里出现了名单外的人会提醒。不填也能用，按出现的先后排。</p>' +
      '<textarea class="input" rows="8" data-bind="settings.rosterText" placeholder="郑国栋&#10;何文杰&#10;曹海峰=曹海峯">' + esc(s.rosterText) + '</textarea>' +
      '<div class="btn-row"><button class="btn" data-act="roster-from-records">从已保存的记录里补全名字</button></div></div>' +
      '<div class="card"><div class="card-head"><h2>数据</h2></div>' +
      '<p class="muted" style="margin:0">共 ' + state.records.length + ' 条记录' + (dates.length ? '（' + dates[0] + ' 至 ' + dates[dates.length - 1] + '）' : '') +
      '。数据只存在这个浏览器里，不会上传。' + backupText() + '</p>' +
      '<div class="btn-row"><button class="btn" data-act="backup-export">导出备份</button>' +
      '<label class="btn">导入备份<input type="file" accept=".json,application/json" data-act="backup-import" class="visually-hidden"></label>' +
      '<span class="spacer"></span><button class="btn btn-danger-ghost" data-act="clear-all">清空全部记录</button></div></div>' +
      '<div class="card about"><div class="card-head"><h2>怎么用</h2></div><ol>' +
      '<li>在微信群里长按报工消息 →「复制」（电脑版微信也行，一次可以复制好几条）。</li>' +
      '<li>打开「录入」，粘贴后自动识别；核对人数、名字，点「保存」。每天贴一次，月底直接出表。</li>' +
      '<li>「报表」里选月份，可以导出 Excel、直接打印，或生成图片发到群里。</li>' +
      '<li>装到手机桌面：安卓在浏览器菜单里选「添加到桌面 / 安装应用」；苹果在 Safari 里点「分享 / 共享」（新版在右下角「···」里）→「添加到主屏幕」。装好后点图标就能打开，没网也能用。</li>' +
      '<li>数据只存在这台手机的浏览器里：每月点一次「导出备份」，换手机时在新手机上「导入备份」。</li>' +
      '<li>认得出的写法：<code>9月7号打钻13人</code>、<code>9.7 打钻 13人</code>、<code>九月七号打钻十三人</code>；下班时间 <code>13点下班</code>、<code>00点30分下班</code>、<code>下午1点半下班</code>、<code>13:30下班</code>；名字用逗号、顿号、空格或换行隔开都行。</li>' +
      '</ol></div>' +
      '<p class="app-version" id="app-version">' + esc(versionText()) + '</p>';
  }

  // 设置页最底下一行：版本号、能不能离线用、是不是从桌面图标打开的。排查问题时让用户报这一行
  function versionText() {
    if (APP_VERSION === 'dev') return '开发版（没有离线缓存）';
    const ready = !!(navigator.serviceWorker && navigator.serviceWorker.controller);
    return (
      '版本 ' + APP_VERSION + ' · ' + (ready ? '已可离线使用' : '离线缓存还没就绪，联网打开一次即可') + (IS_STANDALONE ? ' · 桌面模式' : '')
    );
  }

  function rosterFromRecords() {
    const have = new Set();
    roster().forEach((p) => {
      have.add(p.name);
      p.aliases.forEach((a) => have.add(a));
    });
    const add = [];
    state.records
      .slice()
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
      .forEach((r) => r.names.forEach((n) => !have.has(n) && (have.add(n), add.push(n))));
    if (!add.length) return toast('记录里的人都已经在名单里了');
    const cur = (state.settings.rosterText || '').replace(/\s+$/, '');
    state.settings.rosterText = (cur ? cur + '\n' : '') + add.join('\n');
    save();
    renderSettings();
    toast('补了 ' + add.length + ' 个名字');
  }

  function backupExport() {
    if (IS_WECHAT) return wechatHint('导出备份');
    const data = { app: 'gongshi', v: 1, exportedAt: new Date().toISOString(), records: state.records, settings: state.settings };
    deliverFile(new Blob([JSON.stringify(data)], { type: 'application/json' }), '工时统计备份_' + todayYmd() + '.json', '备份已生成');
    state.settings.lastBackupAt = Date.now();
    save();
    renderSettings();
  }

  function backupText() {
    const t = state.settings.lastBackupAt;
    if (!t) return '还没备份过。';
    const d = new Date(t);
    return '上次备份：' + (d.getMonth() + 1) + '月' + d.getDate() + '日。';
  }

  // 记录够多、而且超过一个月没备份，才提醒
  function backupDue() {
    if (state.records.length < 10) return false;
    return Date.now() - (state.settings.lastBackupAt || 0) > BACKUP_REMIND_DAYS * 864e5;
  }

  function backupImport(file) {
    const reader = new FileReader();
    reader.onload = () => {
      let data;
      try {
        data = JSON.parse(reader.result);
        if (!data || !Array.isArray(data.records)) throw new Error('bad');
      } catch (e) {
        return toast('这个文件不是有效的备份', 'error');
      }
      const keys = new Set(state.records.map((r) => r.key));
      let added = 0;
      let skipped = 0;
      data.records.forEach((raw) => {
        const rec = raw && toStored(raw);
        if (!rec || !rec.date || !rec.names.length || keys.has(rec.key)) return skipped++;
        keys.add(rec.key);
        state.records.push(rec);
        added++;
      });
      // 本机还没填的设置，顺带用备份里的
      const s = data.settings || {};
      if (!state.settings.team && s.team) state.settings.team = String(s.team);
      if (!state.settings.rosterText && s.rosterText) state.settings.rosterText = String(s.rosterText);
      save();
      updateBadge();
      updateBrand();
      renderSettings();
      toast('导入 ' + added + ' 条' + (skipped ? '，跳过 ' + skipped + ' 条（重复或无效）' : ''));
    };
    reader.readAsText(file);
  }

  // 一键清空。记录页上有筛选条件时，可以只清空当前显示的那些；清空后几秒内可以撤销
  function openClearDialog(allowShown) {
    const total = state.records.length;
    if (!total) return toast('没有记录');
    const shown = allowShown ? filteredRecords().length : total;
    const partial = shown > 0 && shown < total;
    openModal(
      '<h3>清空记录</h3>' +
        '<p class="muted">清空后 ' + UNDO_SECONDS + ' 秒内可以撤销。想长期留底，先去「设置」导出备份。人员名单和设置不受影响。</p>' +
        '<div class="modal-actions stack">' +
        (partial ? '<button class="btn btn-danger btn-lg" data-act="clear-shown">只清空当前显示的 ' + shown + ' 条</button>' : '') +
        '<button class="btn btn-lg ' + (partial ? 'btn-danger-outline' : 'btn-danger') + '" data-act="clear-everything">清空全部 ' + total + ' 条</button>' +
        '<button class="btn btn-ghost" data-act="close-modal">取消</button></div>'
    );
  }

  function clearRecords(onlyShown) {
    const ids = new Set((onlyShown ? filteredRecords() : state.records).map((r) => r.id));
    const removed = state.records.filter((r) => ids.has(r.id));
    state.records = state.records.filter((r) => !ids.has(r.id));
    save();
    closeModal();
    updateBadge();
    rerender();
    toast('已清空 ' + removed.length + ' 条', null, {
      label: '撤销',
      run() {
        const have = new Set(state.records.map((r) => r.id));
        state.records = state.records.concat(removed.filter((r) => !have.has(r.id)));
        save();
        updateBadge();
        rerender();
        toast('已恢复 ' + removed.length + ' 条');
      },
    });
  }

  /* ================= 事件 ================= */

  function bindValue(el) {
    const [scope, key] = el.dataset.bind.split('.');
    const v = el.type === 'checkbox' ? el.checked : el.value;
    state[scope][key] = v;
    if (scope === 'settings') {
      saveSoon();
      if (key === 'team') updateBrand();
      if (key === 'rosterText' && $('#roster-count')) $('#roster-count').textContent = rosterSummary();
      if (key === 'printDetail') document.body.classList.toggle('print-detail', v);
    }
    if (scope === 'report') renderReport();
    if (scope === 'filter') renderRecordList();
  }

  function onClick(e) {
    const el = e.target.closest('[data-act]');
    if (!el) return;
    switch (el.dataset.act) {
      case 'save-parsed':
        return saveParsed();
      case 'new-record':
        return openEditor(null);
      case 'edit':
        return openEditor(state.records.find((r) => r.id === el.dataset.id));
      case 'delete':
        return deleteRecord(el.dataset.id);
      case 'toggle-detail':
        state.report.showDetail = !state.report.showDetail;
        return renderReport();
      case 'export-xlsx':
        return exportExcel(el);
      case 'print':
        return printReport();
      case 'print-now':
        return printNow();
      case 'image':
        return makeImage();
      case 'share-file':
        return shareFile();
      case 'download-file':
        if (pendingFile) download(pendingFile.blob, pendingFile.filename);
        return closeModal();
      case 'download-image':
        return downloadImage();
      case 'close-modal':
        return closeModal();
      case 'close-banner':
        el.closest('.banner').hidden = true;
        if (el.closest('#install-tip')) safeSet('gongshi.installTipClosed', '1');
        return;
      case 'install':
        return promptInstall();
      case 'reload-update':
        return reloadForUpdate();
      case 'roster-from-records':
        return rosterFromRecords();
      case 'backup-export':
        return backupExport();
      case 'clear-all':
        return openClearDialog(false);
      case 'clear-records':
        return openClearDialog(true);
      case 'clear-shown':
        return clearRecords(true);
      case 'clear-everything':
        return clearRecords(false);
      case 'toast-action': {
        const action = toastAction;
        hideToast();
        return action && action.run();
      }
      default:
    }
  }

  function onChange(e) {
    const el = e.target;
    if (el.dataset.act === 'toggle') {
      const r = state.parsed && state.parsed.records[+el.dataset.i];
      if (r) r._checked = el.checked;
      return renderParse();
    }
    if (el.dataset.act === 'backup-import') {
      if (el.files && el.files[0]) backupImport(el.files[0]);
      el.value = '';
      return;
    }
    if (el.dataset.bind && el.dataset.bind !== 'filter.q') bindValue(el);
  }

  function onInput(e) {
    const el = e.target;
    const b = el.dataset.bind;
    if (b === 'filter.q' || b === 'settings.team' || b === 'settings.rosterText') bindValue(el);
  }

  function bindEvents() {
    const box = $('#paste-box');
    box.addEventListener('input', scheduleParse);
    box.addEventListener('paste', onNativePaste);
    $('#btn-clip').addEventListener('click', pasteFromClipboard);
    $('#btn-parse').addEventListener('click', () => {
      runParse();
      if (state.parsed) $('#parse-result').scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    $('#btn-clear').addEventListener('click', () => {
      box.value = '';
      state.parsed = null;
      state.lastSaved = null;
      state.pasteHint = null;
      renderParse();
      box.focus();
    });
    $('#btn-sample').addEventListener('click', () => {
      box.value = S.sampleText();
      runParse();
    });
    document.addEventListener('click', onClick);
    document.addEventListener('change', onChange);
    document.addEventListener('input', onInput);
    document.addEventListener('keydown', (e) => e.key === 'Escape' && !$('#modal').hidden && closeModal());
    window.addEventListener('hashchange', route);
    window.addEventListener('pagehide', flushSave);
    document.addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && flushSave());
    // 用浏览器菜单或 Ctrl+P 打印时，也保证打出来的是最新报表
    window.addEventListener('beforeprint', renderReport);
  }

  /* ================= 演示模式 ================= */

  function seedDemo() {
    const now = new Date();
    let y = now.getFullYear();
    let m = now.getMonth() + 1;
    let last = now.getDate() - 1;
    if (last < 7) {
      const prev = new Date(y, m - 2, 1);
      y = prev.getFullYear();
      m = prev.getMonth() + 1;
      last = new Date(y, m, 0).getDate();
    }
    const res = P.parse(S.demoText(m, last), { refDate: new Date(y, m - 1, last) });
    state.records = res.records.filter((r) => r.date && r.names.length).map((r) => toStored(r));
    state.settings = { team: '示例开挖班', rosterText: S.NAMES.join('\n'), printDetail: false, lastBackupAt: 0, typeColors: {} };
    save();
  }

  /* ================= 装到手机桌面、离线使用 ================= */

  function safeGet(k) {
    try {
      return localStorage.getItem(k);
    } catch (e) {
      return null;
    }
  }
  function safeSet(k, v) {
    try {
      localStorage.setItem(k, v);
    } catch (e) {
      /* 存不了就算了，只是个提示开关 */
    }
  }

  // 只在发布包里开离线缓存；开发时（版本是 dev）改了文件刷新就能看到
  function registerSW() {
    if (APP_VERSION === 'dev' || !('serviceWorker' in navigator) || location.protocol === 'file:') return;
    const hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.register('sw.js').catch((e) => console.warn('离线缓存没开起来', e));
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (hadController) $('#update-tip').hidden = false; // 第一次装好时不提示，那时用的已经是最新的
      const v = $('#app-version');
      if (v) v.textContent = versionText();
    });
  }

  // 「立即刷新」：输入框里还没保存的内容、以及用户取消勾选了哪几条，先暂存，刷新后放回去
  const DRAFT_KEY = 'gongshi.pasteDraft';
  function reloadForUpdate() {
    const text = $('#paste-box').value;
    try {
      if (text.trim()) {
        const unchecked = ((state.parsed && state.parsed.records) || []).filter((r) => selectable(r) && !r._checked).map((r) => r.key);
        sessionStorage.setItem(DRAFT_KEY, JSON.stringify({ text, unchecked }));
      }
    } catch (e) {
      /* 存不了也照样刷新 */
    }
    flushSave();
    location.reload();
  }
  function restoreDraft() {
    let draft = null;
    try {
      const raw = sessionStorage.getItem(DRAFT_KEY);
      sessionStorage.removeItem(DRAFT_KEY); // 先删掉，坏了的数据也不会一直留着
      draft = JSON.parse(raw || 'null');
    } catch (e) {
      return;
    }
    if (!draft || typeof draft.text !== 'string' || !draft.text.trim()) return;
    $('#paste-box').value = draft.text;
    runParse(draft.unchecked);
  }

  // 请浏览器把数据标成「持久」，不在空间紧张时自动清掉。只在保存记录后调用：有的浏览器会弹窗询问，得是用户操作之后
  function askPersist() {
    if (!navigator.storage || !navigator.storage.persist) return;
    navigator.storage
      .persisted()
      .then((yes) => yes || navigator.storage.persist())
      .catch(() => {});
  }

  let installEvent = null;
  function renderInstallTip() {
    const el = $('#install-tip');
    const show = APP_VERSION !== 'dev' && IS_TOUCH && !IS_STANDALONE && !IS_WECHAT && !safeGet('gongshi.installTipClosed');
    el.hidden = !show;
    if (!show) return;
    let how;
    if (installEvent) how = '点右边的按钮就能装到手机桌面。';
    else if (IS_IOS) how = '在 Safari 里点「分享 / 共享」按钮（新版在右下角「···」里），选「添加到主屏幕」。';
    else how = '点浏览器菜单（右上角「⋮」或底部「≡」），选「添加到桌面」或「安装应用」。';
    el.innerHTML =
      '<span><b>装到手机桌面</b>，以后点图标直接打开，没网也能用。' + how + '</span>' +
      (installEvent ? '<button class="btn btn-primary btn-sm" data-act="install">装到桌面</button>' : '') +
      '<button class="banner-close" type="button" data-act="close-banner" aria-label="关闭">×</button>';
  }

  async function promptInstall() {
    if (!installEvent) return;
    const evt = installEvent;
    installEvent = null;
    evt.prompt();
    try {
      await evt.userChoice;
    } catch (e) {
      /* 用户取消 */
    }
    renderInstallTip();
  }

  // 录入页输入框下面的说明，按手机类型说
  function pasteTip() {
    if (IS_IOS) return '在微信里长按消息 →「复制」（也可以多选好几条再点「复制」），回到这里点「粘贴」；手机会再弹一个「粘贴」，点一下。';
    if (IS_ANDROID)
      return '在微信里长按消息 →「复制」，回到这里点「粘贴」。注意：微信里「多选 → 复制」的消息，安卓浏览器只能读到第一条，要先粘贴到手机自带的「便签」里，全选复制后再粘贴到这里。';
    return '在电脑版微信里复制（也可以多选好几条再复制），这里按 Ctrl+V（Mac 按 ⌘V）或点「粘贴」。';
  }

  function init() {
    load();
    if (DEMO && !state.records.length) seedDemo();
    $('#wechat-tip').hidden = !IS_WECHAT;
    $('#paste-tip').textContent = pasteTip();
    $('#demo-bar').hidden = !DEMO;
    updateBadge();
    updateBrand();
    bindEvents();
    route();
    restoreDraft();
    registerSW();
    renderInstallTip();
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault(); // 不弹浏览器自带的横条，改成我们自己的提示
      installEvent = e;
      renderInstallTip();
    });
    window.addEventListener('appinstalled', () => {
      installEvent = null;
      safeSet('gongshi.installTipClosed', '1');
      renderInstallTip();
      toast('已装到桌面');
    });
  }

  init();
})();
