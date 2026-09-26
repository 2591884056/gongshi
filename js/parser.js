/*
 * 报工消息解析器 —— 纯函数，浏览器和 Node 通用
 *
 * 把从微信群复制出来的文字拆成一条条报工记录，例如：
 *
 *   9月  7号打钻13人
 *
 *   郑国栋，何文杰，程立平，……
 *
 *   13点  下班
 *
 *   → { date: '2026-09-07', type: '打钻', declared: 13, names: [13 个名字], end: '13:00' }
 *
 * 规则要点：
 *  - 以「X月X号 …… N人」开头的行是一条记录的开始，到「…… 下班」那一行结束；
 *  - 一次可以粘贴多条，中间夹着的「9月8日 01:54」、发送人这类行自动跳过；
 *  - 没用上的文字放进 ignored，界面上摆给用户看，不静默丢弃；
 *  - 人数对不上、名字重复、名单外的人等问题放进 warnings，由用户确认。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.WorkParser = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const pad = (n) => String(n).padStart(2, '0');

  /* ================= 文本规整 ================= */

  const CN_DIGIT = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  const CN_NUM = '[零〇一二两三四五六七八九十]{1,3}';

  // 「十三」→13、「两」→2、「零五」→5；认不出返回 NaN
  function cnToNum(s) {
    if (/^\d+$/.test(s)) return +s;
    if (/^[零〇][一二三四五六七八九]$/.test(s)) return CN_DIGIT[s[1]];
    const parts = s.split('十');
    if (parts.length === 1) return s.length === 1 ? CN_DIGIT[s] : NaN;
    if (parts.length > 2) return NaN;
    const tens = parts[0] === '' ? 1 : parts[0].length === 1 ? CN_DIGIT[parts[0]] : NaN;
    const ones = parts[1] === '' ? 0 : parts[1].length === 1 ? CN_DIGIT[parts[1]] : NaN;
    return tens * 10 + ones;
  }
  const cnConv = (s) => {
    const n = cnToNum(s);
    return isNaN(n) ? s : String(n);
  };

  // 只转换日期、人数、钟点里的中文数字（语音转文字常出这种），不碰名字里的字
  function convertCnNumbers(s) {
    return s
      .replace(
        new RegExp('(^|[^\\u3400-\\u9fff]|年)(\\d{1,2}|' + CN_NUM + ')\\s*月\\s*(\\d{1,2}|' + CN_NUM + ')\\s*([号號日])', 'gm'),
        (_, pre, mo, d, suf) => pre + cnConv(mo) + '月' + cnConv(d) + suf
      )
      .replace(new RegExp('(' + CN_NUM + ')(\\s*(?:个\\s*)?人)', 'g'), (_, n, rest) => cnConv(n) + rest)
      .replace(new RegExp('(' + CN_NUM + ')(\\s*[点點时時])', 'g'), (_, n, rest) => cnConv(n) + rest)
      .replace(new RegExp('([点點时時:]\\s*)(' + CN_NUM + ')(\\s*分)', 'g'), (_, pre, n, rest) => pre + cnConv(n) + rest);
  }

  // 这些正则用字符串里的 \u 转义构造，源码里不放不可见字符
  const LINE_BREAK_RE = new RegExp('\\r\\n?|[\\u2028\\u2029\\u0085]', 'g');
  const INVISIBLE_RE = new RegExp('[\\u200b-\\u200d\\u2060\\ufeff\\u200e\\u200f\\u202a-\\u202e]', 'g');
  const FULL_WIDTH_RE = new RegExp('[\\uff01-\\uff5e]', 'g');
  const SPACE_RE = new RegExp('[\\u00a0\\u3000\\t\\u2000-\\u200a\\u202f\\u205f]', 'g');

  // 统一换行、去掉零宽字符、全角转半角（，：（）０-９ → , : ( ) 0-9）
  function normalize(text) {
    const s = String(text == null ? '' : text)
      .replace(LINE_BREAK_RE, '\n')
      .replace(INVISIBLE_RE, '')
      .replace(FULL_WIDTH_RE, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
      .replace(SPACE_RE, ' ');
    return convertCnNumbers(s);
  }

  /* ================= 时间 ================= */

  const PERIOD = '(凌晨|半夜|深夜|清早|早上|早晨|上午|中午|下午|傍晚|晚上|夜里|夜间)?';
  // 13点 / 13点30分 / 13:30 / 1点半 / 13.30
  const CLOCK = '(\\d{1,2})\\s*[:点點时時.]\\s*(?:(\\d{1,2})\\s*分?|(半))?';
  const CLOCK_STRICT = '(\\d{1,2})\\s*[:点點时時]\\s*(?:(\\d{1,2})\\s*分?|(半))?';
  const END_WORD = '(?:下班|收工|完工|出洞)';
  const START_WORD = '(?:上班|开工|进洞)';
  const END_WORD_RE = /下班|收工|完工|出洞/;
  const TIME_WORD_RE = /下班|收工|完工|出洞|上班|开工|进洞/;

  const g = (src) => new RegExp(src, 'g');
  const END_BEFORE = g(PERIOD + '\\s*' + CLOCK + '\\s*钟?\\s*(?:左右|多)?\\s*' + END_WORD);
  const END_AFTER = g(END_WORD + '\\s*(?:时间)?\\s*:?\\s*(?:是|为|在)?\\s*' + PERIOD + '\\s*' + CLOCK);
  const START_BEFORE = g(PERIOD + '\\s*' + CLOCK + '\\s*钟?\\s*(?:左右|多)?\\s*' + START_WORD);
  const START_AFTER = g(START_WORD + '\\s*(?:时间)?\\s*:?\\s*(?:是|为|在)?\\s*' + PERIOD + '\\s*' + CLOCK);
  const RANGE = g(PERIOD + '\\s*' + CLOCK_STRICT + '\\s*(?:-|~|—|–|至|到)+\\s*' + PERIOD + '\\s*' + CLOCK_STRICT);

  // 把「下午1点」「晚上12点」这类说法换成 24 小时制 HH:MM
  function toTime(period, hs, ms, half) {
    let h = parseInt(hs, 10);
    const m = half ? 30 : ms ? parseInt(ms, 10) : 0;
    if (!(h >= 0 && h <= 24) || !(m >= 0 && m <= 59)) return null;
    switch (period) {
      case '下午':
      case '傍晚':
        if (h < 12) h += 12;
        break;
      case '晚上':
      case '夜里':
      case '夜间':
      case '深夜':
        if (h === 12) h = 0;
        else if (h >= 5 && h < 12) h += 12; // 晚上8点=20:00；晚上1点=01:00
        break;
      case '凌晨':
      case '半夜':
        if (h === 12) h = 0;
        break;
      case '中午':
        if (h <= 3) h += 12;
        break;
      default:
        break;
    }
    if (h === 24) h = 0;
    return pad(h) + ':' + pad(m);
  }

  // 从一段文字里找上班/下班时间，并把这些时间短语抹掉（免得被当成名字）
  function extractTimes(text) {
    const spans = [];
    const all = (rx) => {
      const out = [];
      rx.lastIndex = 0;
      let m;
      while ((m = rx.exec(text))) {
        out.push(m);
        spans.push([m.index, m.index + m[0].length]);
      }
      return out;
    };
    // 「明天7点上班」说的是明天，不算这一班
    const isTomorrow = (m) => /明天|明早|明日|明儿/.test(text.slice(Math.max(0, m.index - 4), m.index));
    const pick = (list) => {
      const m = list.find((x) => !isTomorrow(x));
      return m ? toTime(m[1], m[2], m[3], m[4]) : null;
    };
    const eb = all(END_BEFORE);
    const ea = all(END_AFTER);
    const sb = all(START_BEFORE);
    const sa = all(START_AFTER);
    const rg = all(RANGE);
    let end = pick(eb) || pick(ea);
    let start = pick(sb) || pick(sa);
    if (!start || !end) {
      const r = rg.find((x) => !isTomorrow(x));
      if (r) {
        start = start || toTime(r[1], r[2], r[3], r[4]);
        end = end || toTime(r[5], r[6], r[7], r[8]);
      }
    }
    const chars = text.split('');
    spans.forEach(([a, b]) => {
      for (let i = a; i < b; i++) chars[i] = ' ';
    });
    const cleaned = chars.join('').replace(/下班|收工|完工|出洞|上班|开工|进洞/g, ' ');
    return { start, end, cleaned };
  }

  /* ================= 行分类 ================= */

  // [可选「发送人:」] [年] 月 日 [剩余部分]
  const HEADER_RE = /^\s*(?:([^\s:,、]{1,20})\s*:\s*)?(?:(\d{4})\s*[年./-]\s*)?(\d{1,2})\s*([月./-])\s*(\d{1,2})\s*[日号號]?(.*)$/;
  // 只写了日：「7号打钻13人」；「3号洞」「2号钻机」这类是编号不是日期
  const DAY_HEADER_RE = /^\s*(?:([^\s:,、]{1,20})\s*:\s*)?(\d{1,2})\s*[号號日](?![洞井线机台楼车队组段区])(.*)$/;
  const COUNT_RE = /(?:共|合计|总共|一共|计)?\s*(\d{1,3})\s*(?:个\s*)?人(?![员次])/;
  const TIME_ONLY_RE = new RegExp('^\\s*(?:星期.|周.)?\\s*' + PERIOD + '\\s*\\d{1,2}:\\d{2}(?::\\d{2})?\\s*$');
  const WEEKDAY_RE = /[(\[【]?\s*(?:星期|礼拜|周)[一二三四五六日天1-7]\s*[)\]】]?/g;

  // 微信里的时间行：「9月8日 01:54」「昨天 14:07」「2026/9/8 01:54」「下午2:07」
  const TS_BODY =
    '(?:(?:\\d{4}\\s*[年/.-]\\s*)?\\d{1,2}\\s*[月/.-]\\s*\\d{1,2}\\s*[日号]?\\s*)?(?:星期.|周.|昨天|前天|今天)?\\s*' +
    PERIOD +
    '\\s*\\d{1,2}:\\d{2}(?::\\d{2})?';
  const TIMESTAMP_RE = new RegExp('^\\s*' + TS_BODY + '\\s*$');
  // 「郑国栋 9月8日 01:54」这种发送人和时间在同一行
  const SENDER_TS_RE = new RegExp('^\\s*[^\\s,、;。:][^,、;。]{0,24}?\\s+' + TS_BODY + '\\s*$');
  const NOISE_RE = /^\s*(?:\[(?:图片|语音|视频|表情|动画表情|文件|链接|位置|红包|转账|名片|小程序|聊天记录|视频号)\]|.{0,24}撤回了一条消息|[-—=\s]*以下是新消息[-—=\s]*|以上是打招呼的内容)\s*$/;
  // 「郑国栋：」「人员：」这种只有一个词加冒号的行：可能是发送人，也可能是名单前的标签，都跳过
  const LABEL_RE = /^[^\s,、;。:]{1,20}\s*:\s*$/;

  function matchHeader(raw) {
    // 去掉开头的「@全体成员 」和包住日期的「【」
    const t = raw.replace(/^\s*(?:@[^\s@]+\s+)+/, '').replace(/^\s*[\[【(]\s*(?=\d)/, '');
    let m = HEADER_RE.exec(t);
    if (m) {
      const month = +m[3];
      const day = +m[5];
      const rest = m[6] || '';
      const head = { sender: m[1] || '', year: m[2] ? +m[2] : null, month, day, rest };
      if (TIME_ONLY_RE.test(rest)) return null; // 是时间戳，不是表头
      const hasCount = COUNT_RE.test(rest);
      if (month < 1 || month > 12 || day < 1 || day > 31) {
        // 「9月77号打钻2人」明显是报工、只是日期打错了：留着让它报错给人看，别悄悄丢掉
        return m[4] === '月' && hasCount ? head : null;
      }
      if (m[4] !== '月' && !hasCount) return null; // 「9.7」这类写法必须带「N人」才算表头
      if (!hasCount && TIME_WORD_RE.test(rest)) return null; // 「9月8号 01点下班」是时间行
      return head;
    }
    m = DAY_HEADER_RE.exec(t);
    if (m && COUNT_RE.test(m[3]) && +m[2] >= 1 && +m[2] <= 31) {
      return { sender: m[1] || '', year: null, month: null, day: +m[2], rest: m[3] };
    }
    return null;
  }

  function classify(line) {
    const t = line.trim();
    if (!t) return { kind: 'blank' };
    const header = matchHeader(t);
    if (header) return { kind: 'header', header };
    if (TIMESTAMP_RE.test(t)) return { kind: 'meta', ts: true };
    if (SENDER_TS_RE.test(t) || NOISE_RE.test(t)) return { kind: 'meta' };
    if (LABEL_RE.test(t)) return { kind: 'label' };
    return { kind: 'text' };
  }

  // 紧挨着时间戳的短行是发送人（微信的排版是：时间、发送人、消息）
  function markSenders(lines, kinds) {
    const near = (i, step) => {
      for (let j = i + step; j >= 0 && j < lines.length; j += step) {
        if (kinds[j].kind !== 'blank') return kinds[j].kind === 'meta' && kinds[j].ts;
      }
      return false;
    };
    for (let i = 0; i < lines.length; i++) {
      if (kinds[i].kind !== 'text') continue;
      const t = lines[i].trim();
      if (t.length > 24 || /[,、;。]/.test(t) || TIME_WORD_RE.test(t)) continue;
      if (near(i, -1) || near(i, 1)) kinds[i] = { kind: 'meta', sender: true };
    }
  }

  /* ================= 名字 ================= */

  const CIRCLED_RE = new RegExp('[\\u2460-\\u2473\\u3251-\\u325f\\u32b1-\\u32bf\\u2776-\\u277f\\u2780-\\u2793\\u24ea\\u24f5-\\u24fe]', 'g'); // ①-⑳ ㉑-㊿ ❶-❿ 等圈号
  const SEP_CHAR_RE = /[\s,、;。.:|/\\+&「」『』《》"'“”‘’]/;
  const SEP_IN_TEXT = /[,、;。|/]/;
  const HAN_NAME_RE = /^\p{Script=Han}{2,5}[0-9A-Za-z]?$/u;
  const HAN_DOT_NAME_RE = /^\p{Script=Han}{1,10}[·•・]\p{Script=Han}{1,10}$/u;
  const isNameLike = (s) => HAN_NAME_RE.test(s) || HAN_DOT_NAME_RE.test(s);
  // 表情符号；老浏览器不认 \p{Extended_Pictographic} 时退回按代理对粗略去掉
  let EMOJI_RE;
  try {
    EMOJI_RE = new RegExp('[\\p{Extended_Pictographic}\\p{Emoji_Modifier}\\u{FE0F}\\u{20E3}]', 'gu');
  } catch (e) {
    EMOJI_RE = new RegExp('[\\uD83C-\\uDBFF][\\uDC00-\\uDFFF]|[\\u2600-\\u27BF\\uFE0F]', 'g');
  }
  const WX_EMOJI_RE = /\[([^\[\]\s]{1,6})\]/g; // 微信自带表情复制出来是「[强]」「[抱拳]」

  const LEAVE_WORDS = '请假|休息|休假|缺勤|未到|没来|没到|病假|事假|旷工|调休|轮休';
  const LEAVE_RE = new RegExp(LEAVE_WORDS);
  const LEAVE_WORD_RE = new RegExp('^(?:' + LEAVE_WORDS + ')(?:人员|名单|的)?$'); // 单独一个「请假」「请假人员」
  const NAME_THEN_LEAVE_RE = new RegExp('^(\\p{Script=Han}{2,5}?)(?:' + LEAVE_WORDS + ')$', 'u'); // 张三请假
  const LEAVE_THEN_NAME_RE = new RegExp('^(?:' + LEAVE_WORDS + ')(\\p{Script=Han}{2,5})$', 'u'); // 请假张三
  const ROLE_WORDS = '副班长|班长|带班|组长|领班|带队|队长|工长|技术员|安全员|负责人';
  const ROLE_RE = new RegExp(ROLE_WORDS);
  const ROLE_PREFIX_RE = new RegExp('^(?:' + ROLE_WORDS + ')(?=\\p{Script=Han}{2,})', 'u'); // 带班张三 → 张三
  const WORK_WORDS =
    '打钻|钻孔|打眼|风钻|出渣|出碴|装药|放炮|爆破|喷浆|喷锚|立架|立拱|挂网|注浆|支护|开挖|掘进|找顶|排险|清底|杂工|' +
    '衬砌|仰拱|二衬|初支|防水|钢筋|模板|浇筑|混凝土|运输';
  const WORK_RE = new RegExp(WORK_WORDS);
  const STOP_WORDS = new Set(
    (
      '下班 上班 收工 开工 完工 进洞 出洞 人员 名单 如下 以上 以下 合计 共计 总计 一共 今天 明天 昨天 今日 明日 ' +
      '白班 夜班 早班 中班 晚班 出勤 到岗 在岗 班组 全体 全员 全体成员 所有人 签到 报到 收到 好的 谢谢 辛苦 辛苦了 ' +
      '大家辛苦了 注意安全 其他 其余 等人 加班 小时 分钟 左右 下午 上午 中午 晚上 凌晨 早上 补报 补发 重发 更正 修改 修正 ' +
      [WORK_WORDS, LEAVE_WORDS, ROLE_WORDS].join('|').split('|').join(' ')
    ).split(' ')
  );
  const FILLER_ONE = new Set(['共', '等', '和', '及', '与', '人', '有', '是', '了', '的', '无', '补']);

  // 按分隔符切开，括号里的内容（备注）跟着前面的名字走。
  // 返回 [{ text, sep }]，sep 是和下一个词之间的分隔：' ' 只隔空格，'\n' 换行，',' ':' 等标点，'' 结尾
  function tokenize(text) {
    const out = [];
    let buf = '';
    let depth = 0;
    const cut = (ch) => {
      if (buf) out.push({ text: buf, sep: ch });
      else if (out.length && out[out.length - 1].sep === ' ' && ch !== ' ') out[out.length - 1].sep = ch;
      buf = '';
    };
    for (const ch of text) {
      if (ch === '(' || ch === '[' || ch === '【') {
        depth++;
        buf += '(';
      } else if (ch === ')' || ch === ']' || ch === '】') {
        if (depth > 0) depth--;
        buf += ')';
      } else if (depth === 0 && SEP_CHAR_RE.test(ch)) {
        cut(/\s/.test(ch) && ch !== '\n' ? ' ' : ch);
      } else {
        buf += ch;
      }
    }
    if (buf) out.push({ text: buf, sep: '' });
    return joinSpacedChars(out);
  }

  // 「王 五」「欧 阳 娜」这种名字中间多打了空格：同一行里只隔着空格的两三个单字，合成一个名字。
  // 连着四个以上（「王 五 张 三」）分不清怎么断，不动，交给人数校验去提醒
  const isLoneHan = (t) => /^\p{Script=Han}$/u.test(t) && !FILLER_ONE.has(t);
  function joinSpacedChars(tokens) {
    const out = [];
    for (let i = 0; i < tokens.length; ) {
      let j = i + 1;
      if (isLoneHan(tokens[i].text)) {
        while (j < tokens.length && tokens[j - 1].sep === ' ' && isLoneHan(tokens[j].text)) j++;
      }
      const run = tokens.slice(i, j);
      if (run.length === 2 || run.length === 3) {
        out.push({ text: run.map((t) => t.text).join(''), sep: run[run.length - 1].sep });
      } else {
        out.push.apply(out, run);
      }
      i = j;
    }
    return out;
  }

  // 「郑国栋何文杰」这种漏了逗号的，用已知名字拆开（取片数最少的拆法）
  function segmentByKnown(s, known) {
    const ch = Array.from(s);
    const n = ch.length;
    const best = new Array(n + 1).fill(null);
    best[0] = [];
    for (let i = 0; i < n; i++) {
      if (!best[i]) continue;
      for (let L = 2; L <= Math.min(12, n - i); L++) {
        const w = ch.slice(i, i + L).join('');
        if (known.has(w) && (!best[i + L] || best[i + L].length > best[i].length + 1)) best[i + L] = best[i].concat(w);
      }
    }
    return best[n];
  }

  function makeContext(opts) {
    opts = opts || {};
    const alias = new Map();
    const rosterSet = new Set();
    const known = new Set();
    (opts.roster || []).forEach((p) => {
      if (!p || !p.name) return;
      alias.set(p.name, p.name);
      rosterSet.add(p.name);
      known.add(p.name);
      (p.aliases || []).forEach((a) => {
        if (!a) return;
        alias.set(a, p.name);
        known.add(a);
      });
    });
    (opts.knownNames || []).forEach((n) => n && known.add(n));
    return { alias, rosterSet, known, ref: opts.refDate ? new Date(opts.refDate) : new Date() };
  }

  function cleanToken(tok) {
    return tok
      .replace(/[()]/g, '')
      .replace(CIRCLED_RE, '')
      .replace(EMOJI_RE, '')
      .replace(/^\d+(?=\D)/, '') // 「1郑国栋」这种编号
      .replace(/^[-*#@~_]+|[-*#@~_]+$/g, '')
      .trim();
  }

  function extractNames(text, type, ctx) {
    const names = [];
    const dups = [];
    const excluded = [];
    const unknown = [];
    const unrecognized = [];
    const splits = [];
    const remarks = [];
    const looseLeave = []; // 写了「请假」却看不出是谁
    const seen = new Set();
    const soft = new Set(); // 只在括号里提到的人（「(带班:张三)」）：名单里再写一次不算重复
    const push = (n, fromNote) => {
      if (seen.has(n)) {
        if (fromNote) return;
        if (soft.has(n)) return soft.delete(n);
        if (dups.indexOf(n) < 0) dups.push(n);
        return;
      }
      seen.add(n);
      if (fromNote) soft.add(n);
      names.push(n);
      if (ctx.rosterSet.size && !ctx.rosterSet.has(n)) unknown.push(n);
    };
    const exclude = (n, why) => {
      const i = names.indexOf(n);
      if (i >= 0) names.splice(i, 1);
      const u = unknown.indexOf(n);
      if (u >= 0) unknown.splice(u, 1);
      seen.delete(n);
      excluded.push(n + '（' + why + '）');
    };
    // 认名字：别名合并、漏逗号的拆开；不像名字返回 null
    const resolve = (tok) => {
      const canon = ctx.alias.get(tok);
      if (canon) return [canon];
      if (Array.from(tok).length >= 4 || !isNameLike(tok)) {
        const seg = ctx.known.size ? segmentByKnown(tok, ctx.known) : null;
        if (seg && seg.length > 1) {
          splits.push(tok + ' → ' + seg.join('、'));
          return seg.map((s) => ctx.alias.get(s) || s);
        }
      }
      return isNameLike(tok) ? [tok] : null;
    };

    let last = null; // 上一个认出的名字：后面只隔着空格的「请假」算它的（「李四 请假」）
    let atRun = []; // 连着的「@王五 @赵六」，后面跟「请假」时都算
    let leaveLine = ''; // 「请假：王五、赵六」这一行冒号后面的名字都不算
    const leaveOf = (prev, why) => {
      if (!prev) return looseLeave.push(why);
      (atRun.length && atRun[atRun.length - 1] === prev ? atRun : [prev]).forEach((n) => exclude(n, why));
      atRun = [];
    };

    const walk = (tokens, fromNote) => {
      tokens.forEach((token, i) => {
        const before = i > 0 ? tokens[i - 1].sep : '\n';
        if (before === '\n') leaveLine = '';
        const prev = before === ' ' ? last : null;
        if (!prev) atRun = [];
        last = null;
        const notes = [];
        const tok = cleanToken(
          token.text.replace(/\(([^()]*)\)?/g, (_, n) => {
            notes.push(n);
            return '';
          })
        );
        const note = notes.join(' ').trim();

        if (!tok) {
          if (!note) return;
          // 整个词都在括号里
          if (LEAVE_WORD_RE.test(note)) {
            leaveOf(prev, note); // 「李四 （请假）」
          } else if (LEAVE_RE.test(note) || ROLE_RE.test(note) || SEP_IN_TEXT.test(note)) {
            walk(tokenize(note.replace(new RegExp(ROLE_WORDS, 'g'), ' ')), true); // 「(带班张三)」「(张三、李四)」「(张三请假)」
          } else {
            remarks.push(note); // 「(补报)」这类备注
          }
          return;
        }
        if (/^\d+$/.test(tok) || /^(?:共|合计|总共|一共)?\d+个?人$/.test(tok) || /^\d{1,2}[点:时]/.test(tok)) return;
        if (LEAVE_WORD_RE.test(tok)) {
          if (token.sep === ':') leaveLine = tok.replace(/人员|名单|的/g, ''); // 「请假：王五」
          else leaveOf(prev, tok); // 「李四 请假」「@王五 @赵六 请假」
          return;
        }
        if (STOP_WORDS.has(tok) || tok === type || /(?:人员|名单)$/.test(tok)) return;
        if (Array.from(tok).length === 1) {
          if (!FILLER_ONE.has(tok)) unrecognized.push(tok);
          return;
        }
        if (note && LEAVE_RE.test(note)) {
          excluded.push(tok + '（' + note + '）'); // 「张三（请假）」
          return;
        }
        let m = NAME_THEN_LEAVE_RE.exec(tok);
        if (m) {
          excluded.push(m[1] + '（' + tok.slice(m[1].length) + '）'); // 「张三请假」
          return;
        }
        m = LEAVE_THEN_NAME_RE.exec(tok);
        if (m) {
          excluded.push(m[1] + '（' + tok.slice(0, tok.length - m[1].length) + '）'); // 「请假张三」
          return;
        }
        const got = resolve(tok.replace(ROLE_PREFIX_RE, '')); // 「带班张三」
        if (!got) {
          if (/\d/.test(tok)) remarks.push(tok); // 「进尺3米」这类备注
          else unrecognized.push(tok);
          return;
        }
        if (leaveLine) {
          got.forEach((n) => excluded.push(n + '（' + leaveLine + '）'));
          return;
        }
        got.forEach((n) => push(n, fromNote));
        last = got[got.length - 1];
        atRun = /^\s*@/.test(token.text) ? (prev && atRun.length ? atRun : []).concat(got) : [];
      });
    };

    const pre = text.replace(WX_EMOJI_RE, (all, c) => (LEAVE_RE.test(c) ? '(' + c + ')' : ' '));
    walk(tokenize(pre));
    return { names, dups, excluded, unknown, unrecognized, splits, remarks, looseLeave };
  }

  // 有没有像名字的词（用来判断「下班」行之前是否已经出现过名单）
  function hasNameTokens(text) {
    return tokenize(extractTimes(text).cleaned).some(({ text: t }) => {
      t = cleanToken(t.replace(/\([^()]*\)?/g, ''));
      return isNameLike(t) && !STOP_WORDS.has(t);
    });
  }

  /* ================= 表头拆分 ================= */

  function cleanType(t) {
    return t
      .replace(WEEKDAY_RE, ' ')
      .replace(/[()\[\]【】]/g, ' ')
      .replace(/^[\s,、;:。.~-]+|[\s,、;:。.~-]+$/g, '')
      .replace(/(?:人员名单|人员|名单)$/, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // 「打钻 张三，李四」「打钻，张三，李四」→ 工种 + 名单；第一段不像工种（「周一鸣，李四」）就整段当名单
  function splitTypeFromList(s) {
    const ws = /^\s*(\S+?)\s+(.*)$/.exec(s);
    if (ws && !SEP_IN_TEXT.test(ws[1])) return { type: ws[1], rest: ws[2] };
    const parts = s.split(/[,、;。|/]/);
    if (WORK_RE.test(parts[0])) return { type: parts[0], rest: parts.slice(1).join(',') };
    return { type: '', rest: s };
  }

  // 表头「9月7号」后面剩下的部分 → 工种、人数、同一行里的名字
  function splitHeaderRest(rest) {
    let type = '';
    let declared = null;
    let names = '';
    const cm = COUNT_RE.exec(rest);
    if (cm) {
      type = rest.slice(0, cm.index);
      declared = parseInt(cm[1], 10);
      names = rest.slice(cm.index + cm[0].length);
    } else {
      const colon = rest.indexOf(':');
      if (colon >= 0) {
        type = rest.slice(0, colon);
        names = rest.slice(colon + 1);
      } else {
        type = rest;
      }
    }
    if (SEP_IN_TEXT.test(type)) {
      const sp = splitTypeFromList(type);
      type = sp.type;
      names = sp.rest + ',' + names;
    }
    return { type: cleanType(type), declared, names };
  }

  /* ================= 主流程 ================= */

  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  // 按表头把文字切成一段段；「下班」行只有在已经出现名单之后才算结束
  function segment(lines, kinds) {
    const blocks = [];
    const ignored = [];
    let cur = null;
    const close = () => {
      if (cur) blocks.push(cur);
      cur = null;
    };
    const nextContent = (i) => {
      for (let j = i + 1; j < lines.length; j++) if (kinds[j].kind !== 'blank' && kinds[j].kind !== 'label') return j;
      return -1;
    };
    for (let i = 0; i < lines.length; i++) {
      const k = kinds[i];
      let line = lines[i];
      if (k.kind === 'header') {
        let header = k.header;
        const lineNo = i + 1;
        if (!header.rest.trim()) {
          // 只有日期的一行：后面紧跟「打钻13人」或名单才是一条记录的开头，否则是微信的日期分隔行
          const j = nextContent(i);
          const next = j >= 0 && kinds[j].kind === 'text' ? lines[j] : '';
          if (!(COUNT_RE.test(next) || SEP_IN_TEXT.test(next) || TIME_WORD_RE.test(next))) {
            close();
            if (next && next.trim().length <= 24) kinds[j] = { kind: 'meta' }; // 分隔行下面紧跟的发送人
            continue;
          }
          if (COUNT_RE.test(next)) {
            header = Object.assign({}, header, { rest: next }); // 「9月7号」换行「打钻13人」
            line = line + '\n' + next;
            i = j;
          }
        }
        close();
        cur = { header, lines: [line], lineNo, sender: header.sender };
        cur.hasNames = hasNameTokens(splitHeaderRest(header.rest).names);
        if (cur.hasNames && END_WORD_RE.test(line)) close();
        continue;
      }
      if (k.kind === 'meta') {
        close();
        continue;
      }
      if (k.kind === 'blank' || k.kind === 'label') continue;
      if (!cur) {
        ignored.push({ lineNo: i + 1, text: line.trim() });
        continue;
      }
      // 合并转发的聊天记录每行前面都带「发送人:」，去掉，免得发送人被算进名单
      if (cur.sender) line = line.replace(new RegExp('^\\s*' + escapeRe(cur.sender) + '\\s*:\\s*'), '');
      cur.lines.push(line);
      if (!cur.hasNames) cur.hasNames = hasNameTokens(line);
      if (cur.hasNames && END_WORD_RE.test(line)) close();
    }
    close();
    return { blocks, ignored };
  }

  function recordKey(r) {
    return [r.date, r.type || '', r.end || '', r.names.slice().sort().join(',')].join('|');
  }
  // 同一天、同一工种、同一下班时间 = 同一班；再贴一次视为更正
  function slotKey(r) {
    return r.end ? [r.date, r.type || '', r.end].join('|') : null;
  }

  function buildRecord(block, ctx) {
    const h = block.header;
    const warnings = [];
    const add = (level, text) => warnings.push({ level, text });

    let year = h.year;
    let month = h.month;
    if (month == null) {
      // 只写了日：按参考日期那个月算；日子比今天还大，就是上个月的
      year = ctx.ref.getFullYear();
      month = ctx.ref.getMonth() + 1;
      if (h.day > ctx.ref.getDate()) {
        month -= 1;
        if (month === 0) {
          month = 12;
          year -= 1;
        }
      }
      add('info', '没写月份，按 ' + month + ' 月算');
    } else if (!year) {
      // 没写年份：取参考日期那年；比参考日期还晚两个月以上，算去年的（1 月初贴 12 月底的消息）
      year = ctx.ref.getFullYear();
      if (new Date(year, month - 1, h.day) - ctx.ref > 60 * 864e5) year -= 1;
    }
    const d = new Date(year, month - 1, h.day);
    const date = d.getMonth() === month - 1 && d.getDate() === h.day ? year + '-' + pad(month) + '-' + pad(h.day) : null;
    if (!date) add('error', '日期不对：' + month + '月' + h.day + '日');

    const head = splitHeaderRest(h.rest);
    const body = [head.names].concat(block.lines.slice(1)).join('\n');
    const t = extractTimes(body);
    const nm = extractNames(t.cleaned, head.type, ctx);

    if (!nm.names.length) add('error', '没认出人员名单');
    else if (head.declared != null && head.declared !== nm.names.length)
      add(
        'warn',
        '人数对不上：写的 ' + head.declared + ' 人，认出 ' + nm.names.length + ' 个名字' +
          (nm.excluded.length ? '（另有 ' + nm.excluded.length + ' 人标了请假）' : '')
      );
    if (nm.dups.length) add('warn', '名字重复：' + nm.dups.join('、') + '（只算一次）');
    if (nm.unknown.length) add('warn', '不在人员名单里：' + nm.unknown.join('、'));
    if (nm.unrecognized.length) add('warn', '这些字没认出来：' + nm.unrecognized.join('、'));
    if (nm.looseLeave.length) add('warn', '写了「' + nm.looseLeave.join('、') + '」，但看不出是谁，请核对名单');
    if (nm.excluded.length) add('info', '标了请假/休息，没算进去：' + nm.excluded.join('、'));
    if (nm.remarks.length) add('info', '当备注跳过：' + nm.remarks.join('、'));
    if (nm.splits.length) add('info', '连在一起的名字已拆开：' + nm.splits.join('；'));
    if (!head.type) add('info', '没写工种');
    if (!t.end) add('info', '没认出下班时间');

    const rec = {
      date,
      type: head.type,
      declared: head.declared,
      names: nm.names,
      unknown: nm.unknown,
      start: t.start,
      end: t.end,
      raw: block.lines.join('\n').trim(),
      lineNo: block.lineNo,
      warnings,
    };
    rec.key = recordKey(rec);
    rec.slotKey = slotKey(rec);
    return rec;
  }

  /**
   * @param {string} text 粘贴进来的原文
   * @param {object} [opts]
   * @param {Array<{name:string, aliases?:string[]}>} [opts.roster] 人员名单（用于别名合并、名单外提醒）
   * @param {string[]} [opts.knownNames] 以前出现过的名字（用于拆开连写的名字）
   * @param {Date|string} [opts.refDate] 推断年份用的参考日期，默认今天
   * @returns {{records: object[], ignored: {lineNo:number, text:string}[]}}
   */
  function parse(text, opts) {
    const ctx = makeContext(opts);
    const lines = normalize(text).split('\n');
    const kinds = lines.map(classify);
    markSenders(lines, kinds);
    const { blocks, ignored } = segment(lines, kinds);
    const records = blocks.map((b) => buildRecord(b, ctx));
    const seen = new Set();
    records.forEach((r) => {
      if (seen.has(r.key)) r.dupInBatch = true;
      seen.add(r.key);
    });
    return { records, ignored };
  }

  // 编辑记录时，把输入框里的名字按同样规则切开
  function splitNames(text, opts) {
    return extractNames(normalize(text), '', makeContext(opts));
  }

  // 人员名单：每行一个；「正式名=别名=别名」；一行里用逗号隔开也行
  function parseRoster(text) {
    const out = [];
    const seen = new Set();
    normalize(text)
      .split('\n')
      .forEach((line) => {
        line = line.replace(CIRCLED_RE, '').replace(/^\s*\d+\s*[.、)]?\s*/, '').trim();
        if (!line) return;
        const items = line.indexOf('=') >= 0 ? [line] : line.split(/[\s,、;。]+/);
        items.forEach((item) => {
          const parts = item
            .split('=')
            .map((s) => s.trim())
            .filter(Boolean);
          if (!parts.length || seen.has(parts[0])) return;
          seen.add(parts[0]);
          out.push({ name: parts[0], aliases: parts.slice(1) });
        });
      });
    return out;
  }

  // 有几行是微信的发送时间（「2026年09月21日 20:50」「郑国栋 9月8日 01:54」）。
  // 单条消息「长按 → 复制」不带时间；「多选 → 复制」每条都带，界面用它判断是不是多选复制的
  function countTimeLines(text) {
    return normalize(text)
      .split('\n')
      .filter((l) => TIMESTAMP_RE.test(l.trim()) || SENDER_TS_RE.test(l.trim())).length;
  }

  return { parse, splitNames, parseRoster, recordKey, slotKey, normalize, extractTimes, toTime, countTimeLines };
});
