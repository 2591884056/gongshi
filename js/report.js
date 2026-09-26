/*
 * 报表计算 —— 纯函数，浏览器和 Node 通用
 *
 * 输入保存下来的报工记录，输出「人 × 日期」的考勤矩阵（和手写的那种表一样：
 * 一行一个人，一列一天，格子里是当天出勤次数或工时），外加明细和个人汇总。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.WorkReport = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const pad = (n) => String(n).padStart(2, '0');
  const WEEK = '日一二三四五六';
  const round2 = (x) => Math.round(x * 100) / 100;
  const uniq = (arr) => Array.from(new Set(arr));

  function parseYmd(s) {
    const p = s.split('-').map(Number);
    return new Date(p[0], p[1] - 1, p[2]);
  }
  function ymd(d) {
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }
  function addDays(s, n) {
    const d = parseYmd(s);
    d.setDate(d.getDate() + n);
    return ymd(d);
  }
  function enumerateDates(from, to) {
    const out = [];
    for (let s = from; s <= to && out.length < 366; s = addDays(s, 1)) out.push(s);
    return out;
  }
  const weekday = (s) => WEEK[parseYmd(s).getDay()];
  const isWeekend = (s) => {
    const d = parseYmd(s).getDay();
    return d === 0 || d === 6;
  };
  function monthRange(ym) {
    const [y, m] = ym.split('-').map(Number);
    return { from: y + '-' + pad(m) + '-01', to: y + '-' + pad(m) + '-' + pad(new Date(y, m, 0).getDate()) };
  }
  function isFullMonth(from, to) {
    return from.slice(0, 7) === to.slice(0, 7) && monthRange(from.slice(0, 7)).to === to && from.slice(8) === '01';
  }
  // 表头里的日期：一般只写「7」，跨月时在每月第一列写「10/1」
  function dayLabel(s, i) {
    const d = +s.slice(8);
    return i === 0 || d === 1 ? +s.slice(5, 7) + '/' + d : String(d);
  }
  const toMin = (t) => {
    const [h, m] = t.split(':').map(Number);
    return h * 60 + m;
  };

  // 一条记录的工时：有上下班时间按实际算（跨零点加 24 小时）；否则用「设置」里该工种的每次工时
  function recordHours(r, hoursByType) {
    if (r.start && r.end) {
      let d = toMin(r.end) - toMin(r.start);
      if (d <= 0) d += 1440;
      return round2(d / 60);
    }
    const n = parseFloat(hoursByType ? hoursByType[r.type || ''] : NaN);
    return n > 0 ? n : null;
  }

  function aliasMap(roster) {
    const m = new Map();
    (roster || []).forEach((p) => {
      if (!p || !p.name) return;
      m.set(p.name, p.name);
      (p.aliases || []).forEach((a) => a && m.set(a, p.name));
    });
    return m;
  }

  /**
   * @param {object[]} records 保存的记录
   * @param {object} opts
   * @param {string} opts.from / opts.to  'YYYY-MM-DD'，含首尾
   * @param {string|null} [opts.type]     只看某个工种；null = 全部
   * @param {'count'|'hours'} [opts.metric] 格子里放出勤次数还是工时
   * @param {object} [opts.hoursByType]   { 打钻: 6 } 没有上班时间时每次按几小时算
   * @param {Array} [opts.roster]         人员名单（决定排序、别名合并）
   * @param {boolean} [opts.hideEmpty]    隐藏区间内没有记录的名单人员
   */
  function build(records, opts) {
    opts = opts || {};
    const from = opts.from;
    const to = opts.to;
    const metric = opts.metric === 'hours' ? 'hours' : 'count';
    const type = opts.type == null ? null : opts.type;
    const roster = opts.roster || [];
    const alias = aliasMap(roster);
    const canon = (n) => alias.get(n) || n;
    const dates = enumerateDates(from, to);

    const inRange = records.filter((r) => r.date && r.date >= from && r.date <= to);
    const types = uniq(inRange.map((r) => r.type || '')).sort();
    const list = inRange
      .filter((r) => type === null || (r.type || '') === type)
      .map((r) => Object.assign({}, r, { names: uniq(r.names.map(canon)), hours: recordHours(r, opts.hoursByType) }))
      .sort((a, b) => {
        if (a.date !== b.date) return a.date < b.date ? -1 : 1;
        const ea = a.end || '99:99';
        const eb = b.end || '99:99';
        return ea < eb ? -1 : ea > eb ? 1 : 0;
      });

    const rows = [];
    const index = new Map();
    const addRow = (name, inRoster) => {
      index.set(name, rows.length);
      rows.push({ name, inRoster, cells: {}, missing: {}, count: 0, hours: 0, days: 0, byType: {} });
    };
    roster.forEach((p) => p && p.name && !index.has(p.name) && addRow(p.name, true));
    list.forEach((r) => r.names.forEach((n) => !index.has(n) && addRow(n, false)));

    const colTotals = {};
    dates.forEach((d) => (colTotals[d] = 0));
    let missingHours = 0;
    list.forEach((r) => {
      if (r.hours == null) missingHours++;
      const v = metric === 'hours' ? r.hours || 0 : 1;
      r.names.forEach((n) => {
        const row = rows[index.get(n)];
        row.cells[r.date] = round2((row.cells[r.date] || 0) + v);
        if (metric === 'hours' && r.hours == null) row.missing[r.date] = true;
        row.count += 1;
        row.hours = round2(row.hours + (r.hours || 0));
        row.byType[r.type || ''] = (row.byType[r.type || ''] || 0) + 1;
        colTotals[r.date] = round2(colTotals[r.date] + v);
      });
    });

    rows.forEach((row) => {
      // 出勤天数按「有没有来」算，和口径无关
      row.days = dates.filter((d) => row.cells[d] !== undefined).length;
      row.total = metric === 'hours' ? row.hours : row.count;
    });
    const shown = opts.hideEmpty ? rows.filter((r) => r.count > 0) : rows;
    shown.forEach((r, i) => (r.no = i + 1));

    return {
      from,
      to,
      dates,
      metric,
      type,
      types, // 区间内出现过的工种（给筛选下拉框用）
      listTypes: uniq(list.map((r) => r.type || '')).sort(), // 当前筛选后出现的工种（个人汇总分列用）
      rows: shown,
      colTotals,
      grand: round2(shown.reduce((s, r) => s + r.total, 0)),
      totalCount: shown.reduce((s, r) => s + r.count, 0),
      totalHours: round2(shown.reduce((s, r) => s + r.hours, 0)),
      records: list,
      missingHours,
      mismatched: list.filter((r) => r.declared != null && r.declared !== r.names.length).length,
      outsiders: roster.length ? rows.filter((r) => !r.inRoster).map((r) => r.name) : [],
    };
  }

  // 报表标题和说明行（页面、打印、Excel、图片共用）
  function describe(rep, team) {
    const [y, m] = rep.from.split('-').map(Number);
    const full = isFullMonth(rep.from, rep.to);
    const prefix = team ? team + ' ' : '';
    const title = prefix + (full ? y + '年' + m + '月 考勤统计表' : '考勤统计表');
    const typeLabel = rep.type === null ? '全部' : rep.type || '未注明';
    const metricLabel = rep.metric === 'hours' ? '工时（小时）' : '出勤次数';
    const subtitle = '统计区间：' + rep.from + ' 至 ' + rep.to + '　工种：' + typeLabel + '　口径：' + metricLabel;
    const legend =
      rep.metric === 'hours'
        ? '表中数字 = 当天工时（小时）。有上下班时间的按实际计算，只有下班时间的按「设置」里的每次工时计算。'
        : '表中数字 = 当天出勤次数（群里一条报工消息算一次）。';
    const fileBase = (team ? team + '_' : '') + (full ? y + '年' + m + '月' : rep.from + '至' + rep.to) + '_考勤统计';
    return { title, subtitle, typeLabel, metricLabel, legend, fileBase };
  }

  return {
    build,
    describe,
    recordHours,
    enumerateDates,
    monthRange,
    isFullMonth,
    weekday,
    isWeekend,
    dayLabel,
    parseYmd,
    ymd,
    addDays,
  };
});
