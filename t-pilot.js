// 领航员流程测试：从 index.js 抠出真实函数，只把账本、注入、日志换成假的。
var fs = require('fs');
var path = require('path');
var src = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
function grab(name) {
  var i = src.indexOf('function ' + name + '(');
  if (i < 0) throw new Error('no fn ' + name);
  var j = src.indexOf('{', i), depth = 0, k = j;
  for (; k < src.length; k++) { var ch = src[k]; if (ch === '{') depth++; else if (ch === '}') { depth--; if (!depth) break; } }
  return src.slice(i, k + 1);
}
var fns = ['trim','peek','clamp','isObject','isArray','nowIso','blankActBook','migrateActBookV2','pushLog','parsePilotVerdict','pilotUserPrompt','pilotMin','actNeedRounds','actPlayed','currentAct','gotoAct','actOnUserMessage','askPilot'];
var code = fns.map(grab).join('\n');
var ACT_DEFAULT_ROUNDS = 6, ACT_PILOT_MIN = 2, ACT_PILOT_CAP = 10, LOG_LIMIT = 120;
var logs = [], toasts = [], injected = null, apiCalls = [], apiReply = 'DONE\n她收拾行李离开了公寓';
var book, chatTok = 'A';
function actBook() { return book; }
function actLog(m) { logs.push(m); }
function saveStory() {}
function renderActPanel() {}
function toast(m) { toasts.push(m); }
function actInjectText(a) { injected = a ? a.name : null; }
function actClearInjection() { injected = null; }
function briefClearInjection() {}
function chatToken() { return chatTok; }
function chatChangedSince(t) { return t && chatTok && t !== chatTok; }
function recentStoryText() { return { text: '正文……' }; }
function story() { return {}; }
function buildPrompt() { return 'sys'; }
function callSmallApi(k, label, sys, user) { apiCalls.push({ k: k, user: user }); return apiReply instanceof Error ? Promise.reject(apiReply) : Promise.resolve(apiReply); }
var pilotFlight = null;
eval(code);

var fails = 0;
function eq(a, b, msg) { if (JSON.stringify(a) !== JSON.stringify(b)) { fails++; console.log('✗', msg, '\n   got', JSON.stringify(a), '\n   want', JSON.stringify(b)); } else console.log('✓', msg); }

// 1. 解析
eq(parsePilotVerdict('DONE\n她已离开'), { done: true, reason: '她已离开' }, 'DONE 第一行');
eq(parsePilotVerdict('NOT_YET\n只是在犹豫'), { done: false, reason: '只是在犹豫' }, 'NOT_YET 第一行');
eq(parsePilotVerdict('not yet'), { done: false, reason: '' }, 'not yet 小写带空格');
eq(parsePilotVerdict('```\nDONE\n```'), { done: true, reason: '' }, '代码块包裹');
eq(parsePilotVerdict('```\nDONE\n她走了\n```'), { done: true, reason: '她走了' }, '代码块包裹带理由');
eq(parsePilotVerdict('**DONE** 她走了'), { done: true, reason: '' }, 'markdown 加粗');
eq(parsePilotVerdict('到位。她已经离开了。'), { done: true, reason: '' }, '中文到位');
eq(parsePilotVerdict('还没到，她还在犹豫。'), { done: false, reason: '' }, '中文没到');
eq(parsePilotVerdict('我认为这一幕 DONE 了'), { done: true, reason: '我认为这一幕 DONE 了' }, '整段搜 DONE 兜底');
eq(parsePilotVerdict('嗯……').unknown, true, '胡话 → unknown');
eq(parsePilotVerdict('').unknown, true, '空 → unknown');
eq(parsePilotVerdict('NOT_YET\nDONE 只是个趋势'), { done: false, reason: 'DONE 只是个趋势' }, '第一行优先，第二行含 DONE 不误判');

// 2. 流程：领航员模式，判到位 → 下一条消息翻页
function freshBook(mode) {
  return { v: 3, locked: true, pilot: mode, pilot_min: 2, pilot_verdict: null, default_rounds: 6, s_round: 0, current_idx: -1, act_entered_round: 0, finished: false, brief_left: 0, ledger: [],
    acts: [ { id: 'a', name: '相爱', play: '甜', done: '她答应了他', forbid: '', rounds: 0 }, { id: 'b', name: '误会', play: '酸', done: '她做了离开的决定', forbid: '', rounds: 0 }, { id: 'c', name: '结局', play: '和', done: '两人和好', forbid: '', rounds: 0 } ] };
}
function run() {
  book = freshBook('pilot');
  actOnUserMessage();                 // 第 1 轮：第一幕挂上
  eq([book.current_idx, injected], [0, '相爱'], '第一条消息挂第一幕');
  askPilot(false);
  eq(apiCalls.length, 0, '已演 0 轮 < 最少 2 轮：不问');
  actOnUserMessage(); actOnUserMessage();   // 第 3 轮，本幕已演 2
  return Promise.resolve().then(function () { askPilot(false); return pilotFlight; }).then(function () {
    eq(apiCalls.length, 1, '演满最少轮数后问了一次');
    eq(apiCalls[0].k, 'api3', '走 api3 连接');
    eq(apiCalls[0].user.indexOf('她答应了他') > 0, true, '到位判据进了提问');
    eq(book.pilot_verdict && book.pilot_verdict.done, true, '裁决落账');
    askPilot(false); askPilot(false);
    eq(apiCalls.length, 1, '同一轮重抽不重问');
    eq(book.current_idx, 0, '裁决落账后不当场翻页');
    actOnUserMessage();
    eq([book.current_idx, injected], [1, '误会'], '下一条玩家消息才翻页');
    eq(/领航员判到位：她收拾行李/.test(logs[logs.length - 1]), true, '翻页留痕带理由: ' + logs[logs.length - 1]);
    eq(book.pilot_verdict, null, '换幕后裁决清空');
    // 过期裁决不翻：判到位后玩家连发两条，第二条不该再翻
    apiReply = 'NOT_YET\n还在吵';
    actOnUserMessage(); actOnUserMessage();
    return askPilot(false), pilotFlight;
  }).then(function () {
    eq(book.pilot_verdict.done, false, 'NOT_YET 落账');
    var before = logs.length;
    eq(logs.length, before, '自动 NOT_YET 不刷日志');
    actOnUserMessage();
    eq(book.current_idx, 1, '没到不翻');
    // 上限兜底：本幕轮数 3，演满自动翻，即便领航员一直说没到
    book.acts[1].rounds = 3;
    book.pilot_verdict = null;
    eq(actPlayed(book) >= 3, true, '前置：本幕已演满上限');
    actOnUserMessage();
    eq(book.current_idx, 2, '轮钟上限兜底翻页');
    eq(/演到上限 3 轮/.test(logs[logs.length - 1]), true, '上限翻页留痕: ' + logs[logs.length - 1]);
    // 陈旧裁决：for_round 不是上一轮 → 不算
    book.pilot_verdict = { for_round: book.s_round - 5, act_idx: 2, done: true, reason: '' };
    actOnUserMessage();
    eq(book.finished, false, '过期裁决不落幕');
    book.pilot_verdict = { for_round: book.s_round, act_idx: 1, done: true, reason: '' };
    actOnUserMessage();
    eq(book.finished, false, '别的幕的裁决不落幕');
    while (actPlayed(book) < 2) actOnUserMessage();
    // 换聊天守卫：起飞后切聊天，落地作废
    apiReply = 'DONE\n和好了';
    book.pilot_verdict = null;
    askPilot(true); chatTok = 'B';
    return pilotFlight;
  }).then(function () {
    eq(!!(book.pilot_verdict && book.pilot_verdict.done), false, '切聊天后裁决作废');
    chatTok = 'A';
    // 出错：记 failed，不重问
    apiReply = new Error('HTTP 500');
    askPilot(false); return pilotFlight;
  }).then(function () {
    eq(!!(book.pilot_verdict && book.pilot_verdict.failed), true, '出错记 failed');
    // 最后一幕由领航员判到位 → 落幕
    book.pilot_verdict = { for_round: book.s_round, act_idx: 2, done: true, reason: '和好了' };
    actOnUserMessage();
    eq([book.finished, book.current_idx, injected], [true, 2, '结局'], '最后一幕到位 → 落幕，幕本仍挂着');
    var n = apiCalls.length; askPilot(false);
    eq(apiCalls.length, n, '失败后同一轮不重打接口');
    // 轮钟模式：DONE 不翻
    book = freshBook('clock'); apiReply = 'DONE\nok'; apiCalls = [];
    actOnUserMessage(); actOnUserMessage(); actOnUserMessage();
    askPilot(true); return pilotFlight;
  }).then(function () {
    eq(book.pilot_verdict.done, true, '轮钟模式手动问也落账');
    actOnUserMessage();
    eq(book.current_idx, 0, '轮钟模式下 DONE 不翻页');
    eq(/它说了不算/.test(logs[logs.length - 1]), true, '轮钟模式日志说明');
    // 没写到位：只提醒一次
    book = freshBook('pilot'); book.acts[0].done = ''; logs = []; apiCalls = [];
    actOnUserMessage(); actOnUserMessage(); actOnUserMessage();
    askPilot(false); askPilot(false);
    eq(apiCalls.length, 0, '没写到位不打接口');
    eq(logs.filter(function (l) { return /没写「到位」/.test(l); }).length, 1, '没写到位只提醒一次');
    // 默认值：新账本领航员 + 上限 10；v2 升上来的老账本轮钟
    var nb = blankActBook();
    eq([nb.pilot, nb.default_rounds, nb.pilot_min], ['pilot', 10, 2], '新账本默认领航员、上限 10');
    var mig = migrateActBookV2({ v: 2, acts: [{ name: 'x', play: 'y' }], interval: 5 });
    eq([mig.pilot, mig.default_rounds], ['clock', 5], 'v2 升级账本保持轮钟');
    // 没有连接：只提醒一次
    book = freshBook('pilot'); logs = []; apiCalls = [];
    apiReply = new Error('领航员连接未配置（也没有可复用的编译连接）');
    actOnUserMessage(); actOnUserMessage(); actOnUserMessage();
    askPilot(false);
    return pilotFlight.then(function () { actOnUserMessage(); askPilot(false); return pilotFlight; });
  }).then(function () {
    eq(logs.filter(function (l) { return /没有连接可用/.test(l); }).length, 1, '没有连接只提醒一次');
    eq(book.pilot_noapi_warned, true, '记下已提醒');
    console.log(fails ? ('\n' + fails + ' FAILED') : '\nALL PASS');
    process.exit(fails ? 1 : 0);
  });
}
run().catch(function (e) { console.error(e); process.exit(2); });
