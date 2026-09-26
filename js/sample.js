/*
 * 示例数据（名字都是虚构的）
 *  - sampleText：「填入示例」按钮用，模拟从群里复制出来的几条消息，包含一条人数对不上的
 *  - demoText：演示模式（?demo=1）用，生成一整个月的消息，方便看报表效果
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.WorkSample = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const NAMES = ['张建国', '李志强', '王海涛', '刘德明', '陈小兵', '杨光辉', '赵永福', '黄大伟', '周文斌', '吴国庆', '徐长青', '孙立新', '马俊杰'];

  function sampleText(ref) {
    ref = ref ? new Date(ref) : new Date();
    const d1 = new Date(ref.getFullYear(), ref.getMonth(), ref.getDate() - 2);
    const d2 = new Date(ref.getFullYear(), ref.getMonth(), ref.getDate() - 1);
    const m = (d) => d.getMonth() + 1;
    return [
      m(d1) + '月' + d1.getDate() + '日 14:07',
      NAMES[0],
      m(d1) + '月  ' + d1.getDate() + '号打钻13人',
      '',
      NAMES.join('，'),
      '',
      '13点  下班',
      '',
      m(d2) + '月' + d2.getDate() + '日 01:54',
      NAMES[0],
      m(d2) + '月  ' + d2.getDate() + '号打钻13人',
      '',
      NAMES.slice(0, 12).join('，'),
      '',
      '01点  下班',
      '',
      m(d2) + '月' + d2.getDate() + '号出渣5人：刘德明、陈小兵、杨光辉、赵永福、黄大伟  下午3点半下班',
    ].join('\n');
  }

  // 每天两班打钻（01 点、13 点左右下班），偶尔一班出渣；每班随机少一两个人
  function demoText(month, lastDay) {
    let seed = 20260907;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const out = [];
    for (let d = 1; d <= lastDay; d++) {
      ['01', '13'].forEach((h) => {
        const crew = NAMES.filter(() => rnd() > 0.1);
        const half = rnd() < 0.25 ? '30分' : '';
        out.push(month + '月  ' + d + '号打钻' + crew.length + '人\n\n' + crew.join('，') + '\n\n' + h + '点' + half + '  下班');
      });
      if (rnd() < 0.3) {
        const crew = NAMES.filter(() => rnd() > 0.6);
        if (crew.length) out.push(month + '月' + d + '号出渣' + crew.length + '人：' + crew.join('、') + ' 18点下班');
      }
    }
    return out.join('\n\n');
  }

  return { NAMES, sampleText, demoText };
});
