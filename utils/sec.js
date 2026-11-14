// UGC 内容检查（本地占位实现）。
// 注意：这只是演示级过滤。正式提审前必须接入微信官方内容安全检测
// security.msgSecCheck（需服务端或云函数调用，云端版接入后补齐），否则有被拒风险。
var BLOCKED_WORDS = [
  '赌博', '博彩', '代开发票', '枪支', '弹药', '毒品', '转账', '打款',
  '刷单', '兼职日结', '招嫖', '色情'
];

function checkText(text) {
  if (!text) {
    return { ok: true };
  }
  for (var i = 0; i < BLOCKED_WORDS.length; i++) {
    if (text.indexOf(BLOCKED_WORDS[i]) !== -1) {
      return { ok: false, msg: '内容含敏感词「' + BLOCKED_WORDS[i] + '」，请修改后提交' };
    }
  }
  return { ok: true };
}

module.exports = { checkText: checkText };
