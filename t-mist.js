// 迷雾森林流程测试：从 index.js 抠出真实函数，只把账本、注入、日志、API 换成假的。
// 跑法：node t-mist.js
var fs = require('fs'), path = require('path');
var src = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
function grab(name) {
  // 按缩进切：函数都在 IIFE 里以 4 空格缩进声明，收在第一个顶格 4 空格的 } 处。
  // 不数花括号——正则与字符串里的 { } 会把计数器带偏。
  var lines = src.split('\n');
  for (var i = 0; i < lines.length; i++) {
    if (lines[i].indexOf('    function ' + name + '(') === 0) {
      for (var k = i + 1; k < lines.length; k++) if (/^    }\s*$/.test(lines[k])) return lines.slice(i, k + 1).join('\n');
    }
  }
  throw new Error('no fn ' + name);
}
var fns = ['trim','peek','clamp','isObject','isArray','uid','hasResidualMacro','recoverJsonObject','extractFromJsonText','assertNotUpstreamRefusal',
  'blankMistBook','currentScene','mistStayed','mistSceneText','mistInjectScene','mistUserPrompt','parseMistVerdict','enterScene','mistGatherMaterials','askMistGod',
  'mistEnter','mistNext','mistLeave','mistOnUserMessage','mistOnAiMessage','mistOnChatChanged'];
var code = fns.map(grab).join('\n');
var MIST_DEFAULT_INTERVAL = 4, MIST_MAX_SCENES = 60, MIST_FIELD_MAX = 1200, MIST_COOLDOWN = '这是此刻的环境，不是本回合的任务。';
var logs = [], toasts = [], injected = '', apiCalls = [], apiReply, chatTok = 'A', on = true;
var book, mistFlight = null;
function mistBook() { return book; }
function mistLog(m) { logs.push(m); }
function saveStory() {}
function renderMistPanel() {}
function toast(m) { toasts.push(m); }
function mistInject(t) { injected = t; }
function mistClearInjection() { injected = ''; }
function isOn() { return on; }
function chatToken() { return chatTok; }
function chatChangedSince(t) { return t && chatTok && t !== chatTok; }
function recentStoryText() { return { text: '正文……' }; }
function characterCardText() { return '角色卡'; }
function readCharacterWorldBooks() { return Promise.resolve({ text: '世界书' }); }
function story() { return { mist_book: book }; }
function buildPrompt() { return 'sys'; }
function powerGate() { return false; }
function readFormIntoSettings() {}
var $ = function () { return { val: function () { return ''; } }; };
function callSmallApi(k, label, sys, user) { apiCalls.push({ k: k, user: user }); return apiReply instanceof Error ? Promise.reject(apiReply) : Promise.resolve(typeof apiReply === 'function' ? apiReply() : apiReply); }
eval(code);

var fails = 0;
function eq(a, b, msg) { if (JSON.stringify(a) !== JSON.stringify(b)) { fails++; console.log('✗', msg, '\n   got', JSON.stringify(a), '\n   want', JSON.stringify(b)); } else console.log('✓', msg); }
function scene(n, extra) { return JSON.stringify({ recap: extra || '', scene: { name: n, env: '白墙，消毒水味', cast: '值班护士小周，在填表', rules: '不要走进 3 楼；熄灯后不要回应敲门', exit: '找到出口并离开' } }); }

// 1. 解析
var v = parseMistVerdict(scene('夜班医院'));
eq([!!v.scene, v.scene.name, v.recap], [true, '夜班医院', ''], 'JSON 出牌');
eq(parseMistVerdict('HOLD').hold, true, 'HOLD');
eq(parseMistVerdict('**HOLD**\n还没走完').hold, true, '加粗 HOLD');
eq(parseMistVerdict('```json\n' + scene('候车厅', '活着出来了') + '\n```').recap, '活着出来了', '代码块 + recap');
eq(parseMistVerdict('好的，这是下一处：' + scene('列车')).scene.name, '列车', '前言 + JSON 救援');
var threw = null; try { parseMistVerdict(JSON.stringify({ scene: { name: '', env: 'x' } })); } catch (e) { threw = e.message; }
eq(/缺「地方」/.test(threw), true, '缺 name 抛错');
threw = null; try { parseMistVerdict(JSON.stringify({ scene: { name: 'a', env: '{{user}} 在这', cast: '', rules: '', exit: '' } })); } catch (e) { threw = e.message; }
eq(/酒馆宏/.test(threw), true, '残留宏拦下');
threw = null; try { parseMistVerdict('嗯……'); } catch (e) { threw = e.message; }
eq(/不是 HOLD 也不是合法 JSON/.test(threw), true, '胡话抛错');
threw = null; try { parseMistVerdict('prompt could not be submitted'); } catch (e) { threw = e.message; }
eq(/上游拦截/.test(threw), true, '上游拦截识别');
// 出口条件不进注入
var txt = mistSceneText(v.scene);
eq(txt.indexOf('找到出口') < 0 && txt.indexOf('夜班医院') >= 0 && txt.indexOf('规矩：') >= 0, true, '注入含公开四栏、不含出口条件');
// God 提示词含出口条件与足迹
book = blankMistBook(); book.on = true;
book.scenes = [{ id: 'x', name: '候车厅', env: 'e', cast: 'c', rules: 'r', exit: '等到车来', recap: '休整了一夜', entered_round: 0, left_round: 3 }];
book.current_idx = 0; book.s_round = 5; book.entered_round = 3;
var up = mistUserPrompt(book, { card: '卡', world: '' }, currentScene(book), '正文', 'check');
eq(up.indexOf('出口条件（只有你看得到）：等到车来') > 0 && up.indexOf('已在此处 2 轮') > 0 && up.indexOf('HOLD') > 0, true, 'check 提示词含出口条件、在此轮数、HOLD 说明');
eq(mistUserPrompt(book, {}, null, '', 'first').indexOf('不可 HOLD') > 0, true, 'first 不可 HOLD');

// 2. 流程
function run() {
  book = blankMistBook(); logs = []; apiCalls = []; injected = '';
  apiReply = scene('夜班医院');
  mistEnter();
  eq(book.on, true, '入林置 on');
  return mistFlight.then(function () {
    eq([book.current_idx, book.scenes.length, apiCalls.length], [0, 1, 1], '入林发第一处');
    eq(apiCalls[0].k, 'mist_api', '走本页 God 连接');
    eq(injected.indexOf('夜班医院') > 0, true, '第一处当场挂上');
    // 例行巡视：interval 4，第 1~3 轮不问
    mistOnUserMessage(); mistOnAiMessage(); mistOnUserMessage(); mistOnAiMessage(); mistOnUserMessage(); mistOnAiMessage();
    eq(apiCalls.length, 1, '不到点不问');
    apiReply = 'HOLD';
    mistOnUserMessage(); mistOnAiMessage();
    eq(!!mistFlight, true, '第 4 轮起飞');
    return mistFlight;
  }).then(function () {
    eq(apiCalls.length, 2, '第 4 轮问了');
    eq(book.planned, null, 'HOLD 不备牌');
    eq(/还没走完/.test(logs[logs.length - 1]), true, 'HOLD 留痕');
    mistOnAiMessage();
    eq(apiCalls.length, 2, '同一轮重抽不重问');
    for (var i = 0; i < 3; i++) { mistOnUserMessage(); mistOnAiMessage(); }
    eq(apiCalls.length, 2, '第 5~7 轮不问');
    apiReply = scene('白色候车厅', '两人活着出来了');
    mistOnUserMessage(); mistOnAiMessage();
    eq(!!mistFlight, true, '第 8 轮起飞');
    return mistFlight;
  }).then(function () {
    eq(apiCalls.length, 3, '第 8 轮再问');
    eq(!!(book.planned && book.planned.scene), true, '出牌进 planned，不当场换');
    eq(book.current_idx, 0, '当场没换');
    eq(injected.indexOf('夜班医院') > 0, true, '注入还是旧的');
    mistOnAiMessage();
    eq(apiCalls.length, 3, '备好牌后不再问');
    mistOnUserMessage();
    eq([book.current_idx, book.scenes.length], [1, 2], '下一条玩家消息换处');
    eq(injected.indexOf('白色候车厅') > 0, true, '注入换成新的一处');
    eq(book.scenes[0].recap, '两人活着出来了', '上一处结账写 recap');
    eq(book.scenes[0].left_round, book.s_round, '上一处记离开轮');
    eq(book.planned, null, '换处后 planned 清空');
    eq(/离开「夜班医院」（两人活着出来了），点亮「白色候车厅」/.test(logs[logs.length - 1]), true, '换处留痕: ' + logs[logs.length - 1]);
    // 换一处（force）：当场换
    apiReply = scene('夜班列车', '候车厅里睡了一觉');
    mistNext();
    return mistFlight;
  }).then(function () {
    eq([book.current_idx, book.scenes[2].name], [2, '夜班列车'], '「换一处」当场换');
    eq(/不可 HOLD/.test(apiCalls[apiCalls.length - 1].user), true, 'force 提示词不可 HOLD');
    // 切聊天守卫
    apiReply = scene('不该出现的地方');
    var n = book.scenes.length;
    mistNext(); chatTok = 'B';
    return mistFlight;
  }).then(function () {
    eq(book.scenes.length, 3, '切聊天后 God 的牌作废');
    chatTok = 'A';
    // 巡视期间散雾：落地作废
    for (var i = 0; i < 4; i++) { mistOnUserMessage(); }
    apiReply = scene('也不该出现');
    mistOnAiMessage();
    mistLeave();
    return mistFlight;
  }).then(function () {
    eq([book.on, injected, book.scenes.length], [false, '', 3], '散雾：撤注入、God 的牌作废、足迹保留');
    // 切聊天还原
    on = true; book.on = true; injected = '';
    mistOnChatChanged();
    eq(injected.indexOf('夜班列车') > 0, true, '切聊天还原当前处');
    on = false; mistOnChatChanged();
    eq(injected, '', '总闸关着只清不挂');
    on = true;
    // 出错：日志，不崩
    apiReply = new Error('HTTP 500');
    mistNext();
    return mistFlight;
  }).then(function () {
    eq(/God 出牌失败：HTTP 500/.test(logs[logs.length - 1]), true, '出错留痕');
    eq(book.current_idx, 2, '出错不换处');
    // 重新入林：轮钟不归零
    book.on = false; var r = book.s_round;
    apiReply = scene('第四处');
    mistEnter();
    eq(book.s_round, r, '有足迹时重新入林轮钟接着数');
    eq(/重新入林/.test(logs[logs.length - 1]), true, '重新入林留痕');
    return mistFlight;
  }).then(function () {
    eq(book.scenes.length, 4, '重新入林发下一处');
    console.log(fails ? ('\n' + fails + ' FAILED') : '\nALL PASS');
    process.exit(fails ? 1 : 0);
  });
}
run().catch(function (e) { console.error(e); process.exit(2); });
