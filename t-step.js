// 剧情步骤（导演椅）流程测试：从 index.js 抠出真实函数，只把账本、注入、日志、API、面板换成假的。
// 跑法：node t-step.js
var fs = require('fs'), path = require('path');
var src = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
function grab(name) {
  // 按缩进切：函数都在 IIFE 里以 4 空格缩进声明，收在第一个顶格 4 空格的 } 处。
  var lines = src.split('\n');
  for (var i = 0; i < lines.length; i++) {
    if (lines[i].indexOf('    function ' + name + '(') === 0) {
      for (var k = i + 1; k < lines.length; k++) if (/^    }\s*$/.test(lines[k])) return lines.slice(i, k + 1).join('\n');
    }
  }
  throw new Error('no fn ' + name);
}
var fns = ['trim', 'peek', 'clamp', 'isObject', 'isArray', 'uid', 'hasResidualMacro', 'recoverJsonObject', 'assertNotUpstreamRefusal', 'forbidLeakCheck',
  'blankStepBook', 'currentStep', 'stepPer', 'stepText', 'stepInjectCurrent', 'gotoStep', 'stepStart', 'stepStop', 'stepNext', 'stepBack',
  'stepOnUserMessage', 'stepOnAiMessage', 'stepOnChatChanged', 'blankStep', 'addStep', 'removeStep', 'moveStep',
  'stepAnalysisPart', 'parseStepsJson', 'stepGatherMaterials', 'stepUserPrompt', 'stepSplit'];
var code = fns.map(grab).join('\n');
var STEP_MIN = 2, STEP_MAX = 20, STEP_DEFAULT_N = 6, STEP_FIELD_MAX = 400, STEP_ANALYSIS_MAX = 4000;
var STEP_TRAILER = '只演到这一步为止。这一步之后发生什么你不知道。';
var logs = [], toasts = [], injected = '', apiCalls = [], apiReply, chatTok = 'A', on = true, secret = '';
var book, ui = [], stepSplitState = { running: false };
function stepBook() { return book; }
function story() { return { hidden_secret: secret, step_book: book }; }
function actBook() { return { locked: true, outline: '先相爱，再误会，最后和好', acts: [{ name: '相爱', play: '甜', forbid: '不准分手' }], current_idx: 0 }; }
var storyCalls = [];
function userPersonaText() { return '姓名：林知夏\n研究生，怕黑。'; }
function readCharacterWorldBooks() { return Promise.resolve({ text: '世界书：学院每年秋天有一场晚宴' }); }
function currentAct(ab) { return ab.acts[ab.current_idx]; }
function actLog(m) { logs.push(m); }
function saveStory() {}
function renderStepPanel() {}
function toast(m) { toasts.push(m); }
function stepInject(t) { injected = t; }
function stepClearInjection() { injected = ''; }
function isOn() { return on; }
function powerGate() { return !on; }
function chatToken() { return chatTok; }
function chatChangedSince(t) { return t && chatTok && t !== chatTok; }
function recentStoryText(n, chars) { storyCalls.push([n, chars]); return { text: '他们把车停在山脚，她背着画板。' }; }
function characterCardText() { return '角色卡'; }
function buildPrompt(slot) { return 'sys:' + slot; }
function setStepSplitUi(running, text, live) { ui.push({ running: running, text: text, live: live }); }
function log() {}
/* 假的编译连接：分块回调 onProgress，模拟真流式；最后整份 resolve */
function callCompilerApi(sys, user, onProgress, key) {
  apiCalls.push({ sys: sys, user: user, key: key });
  if (apiReply instanceof Error) return Promise.reject(apiReply);
  var full = typeof apiReply === 'function' ? apiReply() : apiReply;
  return new Promise(function (resolve) {
    var i = 0;
    (function tick() {
      i = Math.min(full.length, i + 37);
      onProgress(i, 0, full.slice(0, i));
      if (i < full.length) setTimeout(tick, 0); else resolve(full);
    })();
  });
}
var Date_now = Date.now; var fakeNow = 0; Date.now = function () { fakeNow += 200; return fakeNow; };   // 每次画都过了节流阈值
eval(code);

var fails = 0;
function eq(a, b, msg) { if (JSON.stringify(a) !== JSON.stringify(b)) { fails++; console.log('✗', msg, '\n   got', JSON.stringify(a), '\n   want', JSON.stringify(b)); } else console.log('✓', msg); }

var SIX = [
  { name: '上山', text: '两人沿着石阶往上走，她指着路边的野莓，他弯腰去摘。' },
  { name: '采摘', text: '他们在半山的灌木丛里摘了一捧野莓，她的指尖被染红。' },
  { name: '写生', text: '她在一块平石上摊开画板，画对面的山脊，他坐在旁边看。' },
  { name: '突降大雨', text: '天色骤暗，暴雨倾盆，画纸被打湿，两人慌忙收拾。' },
  { name: '护林站', text: '他把外套罩在她头上，拉着她跑进半山废弃的护林站。' },
  { name: '雨声里', text: '屋里只有雨声，他们挨着坐在门槛上，谁也没先开口。' }
];
function reply(steps, analysis, wrap) {
  var body = '【分析】\n' + (analysis || '登山这段戏的场地是山路、半山平石、护林站……') + '\n【步骤】\n' + JSON.stringify({ steps: steps });
  return wrap ? ('```json\n' + body + '\n```') : body;
}

// 1. 解析
var r = parseStepsJson(reply(SIX, '分析正文'), 6);
eq([r.steps.length, r.steps[3].name, r.analysis], [6, '突降大雨', '分析正文'], '标准形状：6 步 + 分析段');
eq(parseStepsJson(reply(SIX), 6, true).steps.length, 6, '代码块包裹');
eq(parseStepsJson('好的，我先想一想。\n' + JSON.stringify({ steps: SIX }), 6).steps.length, 6, '没有【分析】【步骤】标题也能救');
r = parseStepsJson(reply(SIX, '分析里有个 {花括号} 不该带偏'), 6);
eq([r.steps.length, /花括号/.test(r.analysis)], [6, true], '分析段里的花括号不带偏 JSON 定位');
r = parseStepsJson(reply(SIX), 4);
eq([r.steps.length, /截到 4 步/.test(r.warnings[0])], [4, true], '多给了截到 want');
r = parseStepsJson(reply(SIX.slice(0, 3)), 6);
eq([r.steps.length, /只给了 3 步/.test(r.warnings[0])], [3, true], '少给了只警告不废');
eq(parseStepsJson(JSON.stringify({ steps: ['纯字符串一步', '纯字符串两步'] }), 2).steps[1].text, '纯字符串两步', '字符串数组也认');
secret = '她其实是狐狸精，顶替了沈家小姐';
r = parseStepsJson(reply([{ name: 'a', text: '他忽然发现她其实是狐狸精' }, { name: 'b', text: '正常的一步' }]), 2);
eq([r.steps[0].text, r.steps[1].text, /写进了第一幕的秘密/.test(r.warnings[0])], ['', '正常的一步', true], '撞秘密：只清那一步正文，整批不废，有警告');
secret = '';
eq(parseStepsJson(reply([{ name: 'a', text: '{{user}} 走过来' }, { name: 'b', text: '正常' }]), 2).steps.length, 1, '残留宏那一步跳过');
var threw = null; try { parseStepsJson('prompt could not be submitted', 6); } catch (e) { threw = e.message; }
eq(/上游拦截/.test(threw), true, '上游拦截识别');
threw = null; try { parseStepsJson('嗯……我想想', 6); } catch (e) { threw = e.message; }
eq(/没有可解析/.test(threw), true, '胡话抛错');
threw = null; try { parseStepsJson(JSON.stringify({ steps: [] }), 6); } catch (e) { threw = e.message; }
eq(/一步都没切出来/.test(threw), true, '空数组抛错');

// 2. 流式分析切片
eq(stepAnalysisPart('【分析】\n山路、雨、护林站'), '山路、雨、护林站', '去掉【分析】标题');
eq(stepAnalysisPart('【分析】\n山路\n【步骤】\n{"steps":[{"na'), '山路', '【步骤】之后不给看');
eq(stepAnalysisPart('山路\n{ "steps": [{"name":"x"'), '山路', '没标题时 JSON 一开始就截住');
eq(stepAnalysisPart('```\n【分析】\n山'), '山', '代码块前缀去掉');

// 3. 注入正文
book = blankStepBook(); book.steps = SIX.map(function (s) { return blankStep(s.name, s.text, 'compiled'); }); book.on = true; book.cursor = 3;
var txt = stepText(book, 3);
eq(txt.indexOf('第 4/6 步 · 突降大雨') > 0 && txt.indexOf('上一步已经演过：写生') > 0 && txt.indexOf('护林站') < 0 && txt.indexOf(STEP_TRAILER) > 0, true, '注入含本步与上一步名，不含后面的步，含贴耳语');
eq(stepText(book, 0).indexOf('上一步') < 0, true, '第一步没有「上一步」行');

// 4. 提示词
book = blankStepBook(); book.wish = '男女主去登山'; book.want = 6;
var up = stepUserPrompt(book, { card: '卡', story: '正文' }, currentAct(actBook()));
eq(up.indexOf('严格 6 步') > 0 && up.indexOf('阶段：相爱') > 0 && up.indexOf('不准分手') > 0 && up.indexOf('已经演过的事不要再演一遍') > 0, true, '提示词含步数、当前幕与边界、接现场');

eq(up.indexOf('不写任何一方的反应') > 0, true, '提示词要求只给事件不给反应');
eq(/【怎么接】\n接着现场/.test(up) && /第一步从这里长出来/.test(up), true, '默认接着现场');
book.link = 'fresh';
up = stepUserPrompt(book, { card: '卡', story: '正文' }, currentAct(actBook()));
eq(/【怎么接】\n另起一段/.test(up) && /第一步就是转场本身/.test(up) && /不是这一段的素材/.test(up) && !/第一步从这里长出来/.test(up), true, '另起一段：转场、正文只是尾巴');
eq(/上一段戏演过的事不是这一段的素材/.test(src) && !/第一步必须接得上此刻的处境/.test(src), true, '内置提示词：上一段不是素材，删掉了强行缝合那句');
// 提示词与贴耳语的铁律直接查源码（它们是 var，不是函数）
eq(/只给事件，不给反应/.test(src) && /没给反应/.test(src), true, '内置提示词与贴耳语都写了「只给事件，不给反应」');

// 5. 流程
function fresh() {
  book = blankStepBook(); book.steps = SIX.map(function (s) { return blankStep(s.name, s.text, 'compiled'); });
  logs = []; toasts = []; injected = ''; on = true;
}
fresh();
stepOnUserMessage(); stepOnAiMessage();
eq([book.on, injected], [false, ''], '没开始：事件不动账本、不注入');
stepStart();
eq([book.on, book.cursor, injected.indexOf('第 1/6 步 · 上山') > 0, book.steps[0].fired_round], [true, 0, true, 0], '开始推进：第一步当场贴上');
stepOnUserMessage();
eq([book.cursor, book.s_round, book.used, book.served], [0, 1, false, 0], '第一条消息：还没被生成用过，不换步');
stepOnAiMessage(); stepOnAiMessage();
eq([book.used, book.served], [true, 0], '回复落地置 used；重抽再落地不多算');
stepOnUserMessage();
eq([book.cursor, injected.indexOf('第 2/6 步 · 采摘') > 0, book.steps[1].fired_round], [1, true, 2], '用过之后你再发言：换第二步');
eq(/贴上第 2\/6 步「采摘」/.test(logs[logs.length - 1]), true, '换步留痕: ' + logs[logs.length - 1]);
stepOnUserMessage(); stepOnUserMessage();
eq(book.cursor, 1, '连发两条（没回复）不吞步');
// 每步 2 轮
book.per_step = 2;
stepOnAiMessage(); stepOnUserMessage();
eq([book.cursor, book.served], [1, 1], '每步 2 轮：服务 1 个回复位还不换');
stepOnAiMessage(); stepOnUserMessage();
eq([book.cursor, /演满 2 轮/.test(logs[logs.length - 1])], [2, true], '服务满 2 个回复位换步并留痕');
book.per_step = 1;
// 手动
stepNext();
eq([book.cursor, injected.indexOf('突降大雨') > 0], [3, true], '手动下一步');
stepBack();
eq([book.cursor, injected.indexOf('写生') > 0], [2, true], '手动上一步');
eq(gotoStep(1, 'x'), false, '不带 force 不许后退');
// 现场改词重贴
book.steps[2].text = '她在平石上摊开画板，画对面的山脊；风把纸角掀起来。';
stepInjectCurrent();
eq(injected.indexOf('风把纸角掀起来') > 0, true, '正贴着的步改了字立刻重贴');
// 走完
stepNext(); stepNext(); stepNext();
eq([book.cursor, book.on, book.finished], [5, true, false], '推到最后一步');
stepOnAiMessage(); stepOnUserMessage();
eq([book.on, book.finished, injected], [false, true, ''], '最后一步演过再发言：走完，撤下注入');
eq(/导演退场/.test(logs[logs.length - 1]), true, '走完留痕');
stepOnUserMessage(); stepOnAiMessage();
eq([book.on, injected], [false, ''], '走完之后事件不再动');
// 再走一遍
stepStart();
eq([book.cursor, book.s_round, book.finished, injected.indexOf('第 1/6 步') > 0], [0, 0, false, true], '再走一遍从头来、轮数归零');
// 停
stepStop(false);
eq([book.on, injected, book.steps.length, /停在第 1 步/.test(logs[logs.length - 1])], [false, '', 6, true], '停：撤下、步骤保留、留痕');
// 切聊天还原
stepStart(); stepOnAiMessage(); stepOnUserMessage(); injected = '';
stepOnChatChanged();
eq(injected.indexOf('第 2/6 步') > 0, true, '切聊天还原当前步');
on = false; stepOnChatChanged();
eq(injected, '', '总闸关着只清不挂');
stepNext();
eq(book.cursor, 1, '总闸关着手动推进被拦（状态不变）');
on = true;
// 增删改序
fresh();
addStep('', '');
eq(book.steps.length, 6, '空步不加');
addStep('', '他们在山顶合了一张影。');
eq([book.steps.length, book.steps[6].name, book.steps[6].source], [7, '第 7 步', 'hand'], '手写追加自动起名');
secret = '她其实是狐狸精';
addStep('x', '他发现她其实是狐狸精');
eq([book.steps.length, /秘密重合/.test(toasts[toasts.length - 1])], [7, true], '追加撞秘密拦下');
secret = '';
moveStep(book.steps[6].id, -1);
eq(book.steps[5].name, '第 7 步', '上移');
removeStep(book.steps[5].id);
eq(book.steps.length, 6, '删一步');
book.on = true; book.cursor = 0;
removeStep(book.steps[0].id); moveStep(book.steps[1].id, 1);
eq([book.steps.length, book.steps[1].name], [6, '采摘'], '推进中不许删、不许调序');
book.on = false;
var before = book.steps.length;
for (var i = book.steps.length; i < STEP_MAX; i++) book.steps.push(blankStep('p' + i, 't' + i));
addStep('', '再来一步');
eq(book.steps.length, STEP_MAX, '上限 ' + STEP_MAX + ' 步');
stepStart();
eq(book.on, true, '前置：推进中');
stepStop(true);

// 6. 想成步骤（流式）
function run() {
  fresh(); book.steps = []; book.wish = '男女主去登山'; book.want = 6; ui = []; apiCalls = [];
  var LONG = '第一段分析：山路很长，石阶湿滑，半山有一块平石可以写生，再往上是废弃的护林站。\n第二段分析：两人的张力在于谁先开口；采摘让它松，暴雨让它紧，护林站让它靠近一步。\n第三段分析：雨要放在正中间，前面铺日常，后面留余味。';
  apiReply = reply(SIX, LONG);
  return stepSplit().then(function () {
    eq(apiCalls.length, 1, '打了一次编译接口');
    eq(apiCalls[0].key, 'act_api', '走本页切星连接');
    eq(apiCalls[0].sys, 'sys:steps', '用 steps 提示词槽');
    var u = apiCalls[0].user;
    eq([/【总脉络/.test(u) && /先相爱，再误会/.test(u), /【user 的人设】\n姓名：林知夏/.test(u), /【世界书/.test(u) && /秋天有一场晚宴/.test(u), /阶段：相爱/.test(u), /画板/.test(u)], [true, true, true, true, true], '料齐：总脉络、user 人设、世界书、当前幕、正文');
    eq(storyCalls[storyCalls.length - 1], [24, 5000], '接着现场：正文取 24 层');
    eq(book.steps.length, 6, '6 步落账');
    eq(book.steps.map(function (s) { return s.name; }).join('→'), '上山→采摘→写生→突降大雨→护林站→雨声里', '顺序对');
    eq(book.analysis, LONG, '分析留档');
    // 流式：中途画过分析、且画的从来不含 JSON
    var lives = ui.filter(function (u) { return u.running && typeof u.live === 'string' && u.live; });
    eq(lives.length > 1, true, '流式期间画了多次分析（' + lives.length + ' 次）');
    eq(lives.some(function (u) { return /"steps"|【步骤】/.test(u.live); }), false, '流式画面里从不出现 JSON');
    eq(lives.some(function (u) { return u.live.length < lives[lives.length - 1].live.length; }), true, '分析是逐渐长出来的');
    eq(ui.some(function (u) { return u.running && /正在切步/.test(u.text); }), true, 'JSON 开始出现后状态变「正在切步」');
    eq(ui.some(function (u) { return u.running && u.live && /模型在想/.test(u.text); }), true, 'JSON 出现前状态是「模型在想」');
    var firstCut = -1; for (var q = 0; q < ui.length; q++) if (/正在切步/.test(ui[q].text)) { firstCut = q; break; }
    eq(firstCut > 0 && ui.slice(0, firstCut).every(function (u) { return !/正在切步/.test(u.text); }), true, '「正在切步」不会提前出现');
    eq([ui[ui.length - 1].running, ui[ui.length - 1].live], [false, book.analysis], '收尾：分析区定格为留档');
    eq(/想成 6 步：上山 → 采摘/.test(logs[logs.length - 1]), true, '想成留痕: ' + logs[logs.length - 1]);
    // 少给了：警告；另起一段：正文只取一小截
    book.link = 'fresh';
    apiReply = reply(SIX.slice(0, 4));
    return stepSplit();
  }).then(function () {
    eq([book.steps.length, /只给了 4 步/.test(logs[logs.length - 1])], [4, true], '少给：落 4 步 + 警告');
    eq(storyCalls[storyCalls.length - 1], [8, 1500], '另起一段：正文只取 8 层');
    eq(/另起一段/.test(apiCalls[apiCalls.length - 1].user), true, '另起一段进了提示词');
    book.link = 'follow';
    // 切聊天守卫
    apiReply = reply(SIX);
    var p = stepSplit(); chatTok = 'B';
    return p.then(function () { eq(true, false, '切聊天后不该成功'); }, function (e) {
      eq(/切换了聊天/.test(e.message), true, '切聊天：本次作废');
      eq(book.steps.length, 4, '切聊天后账本不动');
      chatTok = 'A';
    });
  }).then(function () {
    // 推进中不许重想
    book.on = true;
    return stepSplit().then(function () { eq(true, false, '推进中不该能想'); }, function (e) { eq(/先「停」/.test(e.message), true, '推进中不许重想'); book.on = false; });
  }).then(function () {
    // 没说想玩什么
    book.wish = '';
    return stepSplit().then(function () { eq(true, false, '空愿望不该能想'); }, function (e) { eq(/还没说想玩什么/.test(e.message), true, '空愿望拦下'); book.wish = '登山'; });
  }).then(function () {
    // 出错留痕
    apiReply = new Error('HTTP 500');
    return stepSplit().then(function () { eq(true, false, '出错不该成功'); }, function () {
      eq(/想步骤失败：HTTP 500/.test(logs[logs.length - 1]), true, '出错留痕');
      eq(stepSplitState.running, false, '出错后解锁');
    });
  }).then(function () {
    // want 越界夹回
    book.want = 99; apiReply = reply(SIX);
    return stepSplit();
  }).then(function () {
    eq(book.want, STEP_MAX, 'want 夹到上限');
    eq(/严格 20 步/.test(apiCalls[apiCalls.length - 1].user), true, '提示词用夹后的数');
    console.log(fails ? ('\n' + fails + ' FAILED') : '\nALL PASS');
    process.exit(fails ? 1 : 0);
  });
}
run().catch(function (e) { console.error(e); process.exit(2); });
