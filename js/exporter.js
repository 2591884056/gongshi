/*
 * 导出：Excel（ExcelJS，带边框、横向 A4、缩放到一页宽，拿去直接打印）和报表图片（canvas，微信里长按保存/转发）
 *
 * buildWorkbook 不碰 DOM，Node 里也能跑（测试用）；drawReportImage 只在浏览器里用。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./report.js'));
  else root.WorkExport = factory(root.WorkReport);
})(typeof self !== 'undefined' ? self : this, function (R) {
  'use strict';

  const thin = { style: 'thin', color: { argb: 'FF808080' } };
  const BORDER = { top: thin, left: thin, bottom: thin, right: thin };
  const CENTER = { horizontal: 'center', vertical: 'middle' };
  const fill = (argb) => ({ type: 'pattern', pattern: 'solid', fgColor: { argb } });
  const HEAD_FILL = fill('FFEFF2F6');
  const WEEKEND_FILL = fill('FFFFF4E0');
  const NUM_FMT = 'General;-General;;@'; // 0 显示为空白，和手写表一样干净

  function eachCell(ws, r1, c1, r2, c2, fn) {
    for (let r = r1; r <= r2; r++) for (let c = c1; c <= c2; c++) fn(ws.getCell(r, c), r, c);
  }

  function titleRows(ws, info, lastCol) {
    ws.mergeCells(1, 1, 1, lastCol);
    const t = ws.getCell(1, 1);
    t.value = info.title;
    t.font = { size: 16, bold: true };
    t.alignment = CENTER;
    ws.getRow(1).height = 30;
    ws.mergeCells(2, 1, 2, lastCol);
    const s = ws.getCell(2, 1);
    s.value = info.subtitle;
    s.font = { size: 10, color: { argb: 'FF555555' } };
    s.alignment = CENTER;
    ws.getRow(2).height = 18;
  }

  const pageSetup = (orientation, titleRowsRef) => ({
    paperSize: 9, // A4
    orientation,
    fitToPage: true,
    fitToWidth: 1,
    fitToHeight: 0, // 高度不限，按需分页
    horizontalCentered: true,
    margins: { left: 0.25, right: 0.25, top: 0.4, bottom: 0.45, header: 0.2, footer: 0.2 },
    printTitlesRow: titleRowsRef,
  });

  // ---------- 考勤表（人 × 日期） ----------
  function addMatrixSheet(wb, rep, info) {
    const n = rep.dates.length;
    const HEAD = 3;
    const WEEK = 4;
    const FIRST = 5;
    const C_DAY0 = 3;
    const C_TOTAL = C_DAY0 + n;
    const C_DAYS = C_TOTAL + 1;
    const LAST_ROW = FIRST + rep.rows.length - 1;
    const TOTAL_ROW = FIRST + rep.rows.length;
    const ws = wb.addWorksheet('考勤表', { views: [{ state: 'frozen', xSplit: 2, ySplit: WEEK }] });
    ws.columns = [{ width: 5 }, { width: 10 }].concat(
      rep.dates.map(() => ({ width: rep.metric === 'hours' ? 4.6 : 3.8 })),
      [{ width: 7.5 }, { width: 7.5 }]
    );
    const L = (c) => ws.getColumn(c).letter;
    titleRows(ws, info, C_DAYS);

    ws.getCell(HEAD, 1).value = '序号';
    ws.getCell(HEAD, 2).value = '姓名';
    rep.dates.forEach((d, i) => {
      ws.getCell(HEAD, C_DAY0 + i).value = R.dayLabel(d, i);
      ws.getCell(WEEK, C_DAY0 + i).value = R.weekday(d);
    });
    ws.getCell(HEAD, C_TOTAL).value = rep.metric === 'hours' ? '合计(时)' : '合计';
    ws.getCell(HEAD, C_DAYS).value = '出勤天数';
    [1, 2, C_TOTAL, C_DAYS].forEach((c) => ws.mergeCells(HEAD, c, WEEK, c));

    rep.rows.forEach((row, i) => {
      const r = FIRST + i;
      ws.getCell(r, 1).value = row.no;
      ws.getCell(r, 2).value = row.name;
      rep.dates.forEach((d, j) => {
        const v = row.cells[d];
        if (v) ws.getCell(r, C_DAY0 + j).value = v;
        else if (row.missing[d]) ws.getCell(r, C_DAY0 + j).value = '?'; // 来了但缺工时
      });
      const range = L(C_DAY0) + r + ':' + L(C_TOTAL - 1) + r;
      // 用公式，现场在 Excel 里改了格子，合计会跟着变
      ws.getCell(r, C_TOTAL).value = { formula: 'SUM(' + range + ')', result: row.total };
      ws.getCell(r, C_DAYS).value = { formula: 'COUNTA(' + range + ')', result: row.days };
    });

    ws.getCell(TOTAL_ROW, 1).value = '合计';
    ws.mergeCells(TOTAL_ROW, 1, TOTAL_ROW, 2);
    if (rep.rows.length) {
      const sumCol = (c, result) => ({ formula: 'SUM(' + L(c) + FIRST + ':' + L(c) + LAST_ROW + ')', result });
      rep.dates.forEach((d, j) => (ws.getCell(TOTAL_ROW, C_DAY0 + j).value = sumCol(C_DAY0 + j, rep.colTotals[d])));
      ws.getCell(TOTAL_ROW, C_TOTAL).value = sumCol(C_TOTAL, rep.grand);
      ws.getCell(TOTAL_ROW, C_DAYS).value = sumCol(C_DAYS, rep.rows.reduce((s, x) => s + x.days, 0));
    }

    eachCell(ws, HEAD, 1, TOTAL_ROW, C_DAYS, (cell, r, c) => {
      cell.border = BORDER;
      cell.alignment = c === 2 && r >= FIRST && r < TOTAL_ROW ? { horizontal: 'left', vertical: 'middle', indent: 1 } : CENTER;
      cell.font = { size: 10, bold: r <= WEEK || r === TOTAL_ROW };
      if (r >= FIRST) cell.numFmt = NUM_FMT;
      const d = c >= C_DAY0 && c < C_TOTAL ? rep.dates[c - C_DAY0] : null;
      if (r <= WEEK || r === TOTAL_ROW) cell.fill = HEAD_FILL;
      else if (d && R.isWeekend(d)) cell.fill = WEEKEND_FILL;
    });
    ws.getRow(HEAD).height = 18;
    ws.getRow(WEEK).height = 16;

    const note = TOTAL_ROW + 2;
    ws.mergeCells(note, 1, note, C_DAYS);
    ws.getCell(note, 1).value = info.legend + (rep.metric === 'hours' && rep.missingHours ? '「?」表示当天出勤但缺工时。' : '');
    ws.getCell(note, 1).font = { size: 9, color: { argb: 'FF666666' } };
    ws.mergeCells(note + 1, 1, note + 1, C_DAYS);
    ws.getCell(note + 1, 1).value = '制表人：______________        审核：______________        日期：______________';
    ws.getCell(note + 1, 1).font = { size: 11 };
    ws.getRow(note + 1).height = 26;
    ws.getCell(note + 1, 1).alignment = { vertical: 'bottom' };

    ws.pageSetup = pageSetup('landscape', HEAD + ':' + WEEK);
    ws.headerFooter = { oddFooter: '&C第 &P 页 / 共 &N 页' };
  }

  // ---------- 明细（每条报工消息一行，方便对账） ----------
  function addDetailSheet(wb, rep, info) {
    const hours = rep.metric === 'hours';
    // [表头, 列宽, 取值]；「工时」列只在按工时统计时出现
    const cols = [
      ['序号', 5, (r, i) => i + 1],
      ['日期', 11, (r) => r.date],
      ['星期', 5, (r) => R.weekday(r.date)],
      ['工种', 9, (r) => r.type || '（未注明）'],
      ['上报人数', 8, (r) => (r.declared == null ? '' : r.declared)],
      ['实际人数', 8, (r) => r.names.length],
      ['上班', 7, (r) => r.start || ''],
      ['下班', 7, (r) => r.end || ''],
    ]
      .concat(hours ? [['工时', 6, (r) => (r.hours == null ? '' : r.hours)]] : [])
      .concat([
        ['人员名单', 64, (r) => r.names.join('、')],
        ['备注', 20, (r) => (r.declared != null && r.declared !== r.names.length ? '人数对不上' : '')],
      ]);
    const C_NAMES = cols.length - 1;
    const C_NOTE = cols.length;
    const ws = wb.addWorksheet('明细', { views: [{ state: 'frozen', ySplit: 3 }] });
    ws.columns = cols.map((c) => ({ width: c[1] }));
    titleRows(ws, Object.assign({}, info, { title: info.title.replace('考勤统计表', '报工明细') }), cols.length);
    cols.forEach((c, i) => (ws.getCell(3, i + 1).value = c[0]));
    rep.records.forEach((r, i) => (ws.getRow(4 + i).values = cols.map((c) => c[2](r, i))));
    const last = 3 + rep.records.length;
    eachCell(ws, 3, 1, last, cols.length, (cell, r, c) => {
      cell.border = BORDER;
      cell.font = { size: 10, bold: r === 3, color: c === C_NOTE && r > 3 ? { argb: 'FFB42318' } : undefined };
      cell.alignment = c === C_NAMES && r > 3 ? { vertical: 'middle', wrapText: true } : Object.assign({ wrapText: true }, CENTER);
      if (r === 3) cell.fill = HEAD_FILL;
    });
    ws.pageSetup = pageSetup('landscape', '3:3');
    ws.headerFooter = { oddFooter: '&C第 &P 页 / 共 &N 页' };
  }

  // ---------- 个人汇总 ----------
  function addSummarySheet(wb, rep, info) {
    const types = rep.listTypes.length > 1 ? rep.listTypes : [];
    const hours = rep.metric === 'hours';
    const head = ['序号', '姓名', '出勤天数', '出勤次数']
      .concat(types.map((t) => (t || '未注明') + '(次)'))
      .concat(hours ? ['工时(小时)'] : []);
    const ws = wb.addWorksheet('个人汇总', { views: [{ state: 'frozen', ySplit: 3 }] });
    ws.columns = head.map((h, i) => ({ width: i === 0 ? 6 : i === 1 ? 12 : 11 }));
    titleRows(ws, Object.assign({}, info, { title: info.title.replace('考勤统计表', '个人汇总') }), head.length);
    head.forEach((h, i) => (ws.getCell(3, i + 1).value = h));
    const values = rep.rows.map((row) =>
      [row.days, row.count].concat(
        types.map((t) => row.byType[t] || 0),
        hours ? [row.hours] : []
      )
    );
    rep.rows.forEach((row, i) => (ws.getRow(4 + i).values = [row.no, row.name].concat(values[i])));
    const totalRow = 4 + rep.rows.length;
    ws.getCell(totalRow, 1).value = '合计';
    ws.mergeCells(totalRow, 1, totalRow, 2);
    for (let c = 3; c <= head.length; c++) {
      const col = ws.getColumn(c).letter;
      const result = Math.round(values.reduce((s, v) => s + v[c - 3], 0) * 100) / 100;
      ws.getCell(totalRow, c).value = rep.rows.length
        ? { formula: 'SUM(' + col + '4:' + col + (totalRow - 1) + ')', result }
        : 0;
    }
    eachCell(ws, 3, 1, totalRow, head.length, (cell, r, c) => {
      cell.border = BORDER;
      cell.font = { size: 10, bold: r === 3 || r === totalRow };
      cell.alignment = c === 2 && r > 3 && r < totalRow ? { horizontal: 'left', vertical: 'middle', indent: 1 } : CENTER;
      if (r > 3) cell.numFmt = NUM_FMT;
      if (r === 3 || r === totalRow) cell.fill = HEAD_FILL;
    });
    ws.pageSetup = pageSetup('portrait', '3:3');
  }

  function buildWorkbook(ExcelJS, rep, info) {
    const wb = new ExcelJS.Workbook();
    wb.creator = '工时统计';
    wb.created = new Date();
    addMatrixSheet(wb, rep, info);
    addDetailSheet(wb, rep, info);
    addSummarySheet(wb, rep, info);
    return wb;
  }

  // ---------- 报表图片（微信里长按图片可保存或发给群） ----------
  function drawReportImage(rep, info) {
    const FONT = '-apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif';
    const probe = document.createElement('canvas').getContext('2d');
    probe.font = '14px ' + FONT;
    const nameW = Math.max(64, ...rep.rows.map((r) => Math.ceil(probe.measureText(r.name).width) + 20));
    const dayW = rep.metric === 'hours' ? 36 : 30;
    const widths = [36, nameW].concat(
      rep.dates.map(() => dayW),
      [56, 48]
    );
    const tableW = widths.reduce((s, w) => s + w, 0);
    const PAD = 24;
    const TITLE_H = 34;
    const SUB_H = 22;
    const HEAD_H = 42;
    const ROW_H = 28;
    const FOOT_H = 40;
    const W = tableW + PAD * 2;
    const H = PAD + TITLE_H + SUB_H + 12 + HEAD_H + ROW_H * (rep.rows.length + 1) + FOOT_H + PAD;
    const scale = Math.min(2, Math.sqrt(16e6 / (W * H))); // iOS 对画布像素数有上限
    const cv = document.createElement('canvas');
    cv.width = Math.round(W * scale);
    cv.height = Math.round(H * scale);
    const g = cv.getContext('2d');
    g.scale(scale, scale);
    g.fillStyle = '#fff';
    g.fillRect(0, 0, W, H);
    g.textAlign = 'center';
    g.textBaseline = 'middle';

    g.fillStyle = '#111';
    g.font = 'bold 20px ' + FONT;
    g.fillText(info.title, W / 2, PAD + TITLE_H / 2);
    g.fillStyle = '#666';
    g.font = '12px ' + FONT;
    g.fillText(info.subtitle, W / 2, PAD + TITLE_H + SUB_H / 2);

    const x = [PAD];
    widths.forEach((w, i) => x.push(x[i] + w));
    const top = PAD + TITLE_H + SUB_H + 12;
    const bodyTop = top + HEAD_H;
    const bottom = bodyTop + ROW_H * (rep.rows.length + 1);
    const nDay = rep.dates.length;
    const fmt = (v) => (v ? String(Math.round(v * 100) / 100) : '');

    // 底色：表头、周末列、斑马纹、合计行
    g.fillStyle = '#eff2f6';
    g.fillRect(x[0], top, tableW, HEAD_H);
    rep.dates.forEach((d, i) => {
      if (!R.isWeekend(d)) return;
      g.fillStyle = '#fff4e0';
      g.fillRect(x[2 + i], bodyTop, dayW, ROW_H * rep.rows.length);
    });
    rep.rows.forEach((row, i) => {
      if (i % 2 === 0) return;
      g.fillStyle = 'rgba(0,0,0,0.025)';
      g.fillRect(x[0], bodyTop + i * ROW_H, tableW, ROW_H);
    });
    g.fillStyle = '#eff2f6';
    g.fillRect(x[0], bottom - ROW_H, tableW, ROW_H);

    // 表头文字
    g.fillStyle = '#222';
    g.font = 'bold 13px ' + FONT;
    const mid = (i) => (x[i] + x[i + 1]) / 2;
    g.fillText('序号', mid(0), top + HEAD_H / 2);
    g.fillText('姓名', mid(1), top + HEAD_H / 2);
    rep.dates.forEach((d, i) => {
      g.font = 'bold 13px ' + FONT;
      g.fillStyle = '#222';
      g.fillText(R.dayLabel(d, i), mid(2 + i), top + 15);
      g.font = '11px ' + FONT;
      g.fillStyle = R.isWeekend(d) ? '#b45309' : '#777';
      g.fillText(R.weekday(d), mid(2 + i), top + 31);
    });
    g.font = 'bold 13px ' + FONT;
    g.fillStyle = '#222';
    g.fillText(rep.metric === 'hours' ? '合计(时)' : '合计', mid(2 + nDay), top + HEAD_H / 2);
    g.fillText('天数', mid(3 + nDay), top + HEAD_H / 2);

    // 数据
    rep.rows.forEach((row, i) => {
      const cy = bodyTop + i * ROW_H + ROW_H / 2;
      g.font = '13px ' + FONT;
      g.fillStyle = '#555';
      g.fillText(String(row.no), mid(0), cy);
      g.fillStyle = '#111';
      g.textAlign = 'left';
      g.font = '14px ' + FONT;
      g.fillText(row.name, x[1] + 10, cy);
      g.textAlign = 'center';
      g.font = '13px ' + FONT;
      rep.dates.forEach((d, j) => {
        const v = row.cells[d];
        const s = v ? fmt(v) : row.missing[d] ? '?' : '';
        if (s) g.fillText(s, mid(2 + j), cy);
      });
      g.font = 'bold 13px ' + FONT;
      g.fillText(fmt(row.total), mid(2 + nDay), cy);
      g.fillText(fmt(row.days), mid(3 + nDay), cy);
    });
    const ty = bottom - ROW_H / 2;
    g.font = 'bold 13px ' + FONT;
    g.fillStyle = '#111';
    g.fillText('合计', (x[0] + x[2]) / 2, ty);
    rep.dates.forEach((d, j) => g.fillText(fmt(rep.colTotals[d]), mid(2 + j), ty));
    g.fillText(fmt(rep.grand), mid(2 + nDay), ty);
    g.fillText(fmt(rep.rows.reduce((s, r) => s + r.days, 0)), mid(3 + nDay), ty);

    // 网格线
    g.strokeStyle = '#b9bec6';
    g.lineWidth = 1;
    g.beginPath();
    for (let y = top; y <= bottom + 0.5; y += y < bodyTop ? HEAD_H : ROW_H) {
      g.moveTo(x[0], y);
      g.lineTo(x[x.length - 1], y);
    }
    x.forEach((xx, i) => {
      if (i === 1) {
        // 合计行里序号和姓名是合并的
        g.moveTo(xx, top);
        g.lineTo(xx, bottom - ROW_H);
      } else {
        g.moveTo(xx, top);
        g.lineTo(xx, bottom);
      }
    });
    g.stroke();

    g.fillStyle = '#888';
    g.font = '12px ' + FONT;
    g.textAlign = 'left';
    g.fillText(info.legend, x[0], bottom + FOOT_H / 2);
    return cv;
  }

  return { buildWorkbook, drawReportImage };
});
