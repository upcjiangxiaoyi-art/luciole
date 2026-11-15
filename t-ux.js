// 使用感（v3.11）流程测试：从 index.js 抠出真实函数，只把账本、日志、面板换成假的。
// 管的是：引路条、搬家（三幕）、抄连接、撤销放回、报错上墙、浮标状态，
// 以及 v3.12 的：文字闸（演什么 / 幕名）、演员此刻耳边、记账、删楼提示、接着想下一段。
// 跑法：node t-ux.js
var fs = require('fs'), path = require('path');
var src = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
function grab(name) {
  var lines = src.split('\n');
  for (var i = 0; i < lines.length; i++) {
    if (lines[i].indexOf('    function ' + name + '(') === 0) {
      for (var k = i + 1; k < lines.length; k++) if (/^    }\s*$/.test(lines[k])) return lines.slice(i, k + 1).join('\n');
    }
  }
  throw new Error('no fn ' + name);
}
var fns = ['trim', 'clamp', 'isObject', 'isArray', 'uid', 'nowIso', 'forbidLeakCheck', 'actLeak', 'sceneLeak', 'blankAct', 'blankStep',
  'containsBanned', 'hasResidualMacro', 'overlapsSecret', 'vetClues', 'blankStory', 'blankVerdict',
  'guideSteps', 'putBack', 'strList', 'oneOf', 'packBoard', 'unpackBoard', 'importBoard', 'copyConnProfile',
  'noteAlert', 'liveAlert', 'floaterState',
  'onAirRows', 'tally', 'usageRole', 'usageRows', 'kchars', 'floorNoteFor', 'isRegenDelete', 'isContinueWish', 'stepContinueWish'];
var REGEN_WINDOW_MS = 5000;
var PROSE_LEAK_WINDOW = 8, SECRET_OVERLAP_WINDOW = 12, CONTINUE_MARK = '【续】';
var INJECT_KEY = 'k_clue', INJECT_KEY_ACT = 'k_act', INJECT_KEY_BRIEF = 'k_brief', INJECT_KEY_MIST = 'k_mist', INJECT_KEY_STEP = 'k_step';
var ONAIR_CHANNELS = [[INJECT_KEY_STEP, '剧情步骤', '第二幕 · 贴耳'], [INJECT_KEY, '线索', '第一幕'], [INJECT_KEY_BRIEF, '随身须知', '手动 · 一次性'],
  [INJECT_KEY_ACT, '幕本', '第二幕 · 常驻'], [INJECT_KEY_MIST, '此刻所在', '第三幕 · 常驻']];
var USAGE_ORDER = ['编译 / 习性单', '调度员', 'God（帷幕）', '切星 / 想步骤', '领航员', 'God（雾林）'];
var air = {}, mb = null, veilLogs = [], mistLogs = [], cleared = 0, chatTok = 'A';
function onAirNow(key) { return air[key] || { text: '', depth: null }; }
function mistBook() { return mb; }
function log(m) { veilLogs.push(m); }
function mistLog(m) { mistLogs.push(m); }
function clearInjection() { cleared++; }
function vetHabitLine(line) { return /狐狸/.test(line) ? '撞秘密' : ''; }
function chatToken() { return chatTok; }
function chatChangedSince(t) { return !!t && t !== chatTok; }
function renderUsageSoon() {}
var ACT_MAX = 12, ACT_FIELD_MAX = 600, STEP_MAX = 20, STEP_FIELD_MAX = 400;
var BOARD_TAG = 'luciole-storyboard';
var ALERT_TTL_MS = 15 * 60 * 1000;
var alerts = { veil: null, act: null, mist: null };
var compileState = { running: false }, habitsState = { running: false }, splitState = { running: false }, stepSplitState = { running: false };
var planFlight = null, pilotFlight = null, mistFlight = null;
var on = true, secret = '', ab, sb, st, logs = [], toasts = [], renders = 0;
function isOn() { return on; }
function story() { return st; }
function actBook() { return ab; }
function stepBook() { return sb; }
function saveStory() {}
function actLog(m) { logs.push(m); }
function toast(m, k) { toasts.push([m, k]); }
function renderActPanel() { renders++; }
function renderAlerts() {}
function syncFloater() {}
var now = 1000000; var realNow = Date.now; Date.now = function () { return now; };
eval(fns.map(grab).join('\n'));

var fails = 0;
function eq(a, b, msg) { if (JSON.stringify(a) !== JSON.stringify(b)) { fails++; console.log('✗', msg, '\n   got', JSON.stringify(a), '\n   want', JSON.stringify(b)); } else console.log('✓', msg); }
function freshStory() {
  return { status: 'empty', hidden_secret: secret, clues: [], config: { run_mode: 'uniform' } };
}
function freshSettings() {
  return { use_tavern: false, api: { url: '', key: '', model: '', timeout_s: 240, max_tokens: 4000 },
    act_api: { url: '', key: '', model: '', timeout_s: 240, max_tokens: 4000, use_tavern: false },
    mist_api: { url: '', key: '', model: '' } };
}
function shape(steps) { return steps && steps.map(function (x) { return x.label + (x.done ? '✓' : '') + (x.cur ? '←' : ''); }).join(' '); }

// 1. 引路条
st = freshStory(); var s = freshSettings();
eq(guideSteps('veil', null, s), null, '没开聊天：不出引路条');
eq(shape(guideSteps('veil', st, s)), '接连接← 写秘密 编译 点亮', '空白故事：从接连接开始');
s.api.url = 'https://x';
eq(shape(guideSteps('veil', st, s)), '接连接✓ 写秘密← 编译 点亮', '填了地址：轮到写秘密');
s.api.url = ''; s.use_tavern = true;
eq(shape(guideSteps('veil', st, s)), '接连接✓ 写秘密← 编译 点亮', '用酒馆连接也算接上');
st.hidden_secret = '她不是亲生的';
eq(shape(guideSteps('veil', st, s)), '接连接✓ 写秘密✓ 编译← 点亮', '写了秘密：轮到编译');
st.clues = [{ id: 'c1' }]; st.status = 'compiled';
eq(shape(guideSteps('veil', st, s)), '接连接✓ 写秘密✓ 编译✓ 点亮←', '编译好了：轮到点亮');
st.config.run_mode = 'supervise'; st.clues = []; st.status = 'empty';
eq(shape(guideSteps('veil', st, s)), '接连接✓ 写秘密✓ 点亮←', 'AI 监督：没有编译这一步');
st.status = 'lit';
eq(guideSteps('veil', st, s), null, '点亮之后引路条退场');
st.status = 'finished';
eq(guideSteps('veil', st, s), null, '送完了也不出');

st = freshStory(); s = freshSettings();
eq(shape(guideSteps('act', st, s)), '接连接← 备幕本 开演', '第二幕：账本都还没建也能出');
st.act_book = { locked: false, acts: [{ name: 'a' }] };
eq(shape(guideSteps('act', st, s)), '接连接✓ 备幕本✓ 开演←', '手写了幕：不用连接也算过，轮到开演');
st.act_book.locked = true;
eq(guideSteps('act', st, s), null, '开演之后退场');
st.act_book = { locked: false, acts: [] }; st.step_book = { steps: [{ name: 'x', text: 'y' }] };
eq(guideSteps('act', st, s), null, '只玩剧情步骤的人不被催着备幕本');

st = freshStory(); s = freshSettings();
eq(shape(guideSteps('mist', st, s)), '接连接← 写底稿 入林', '第三幕：从接连接开始');
s.mist_api.url = 'https://g'; st.mist_book = { on: false, premise: '无限流' };
eq(shape(guideSteps('mist', st, s)), '接连接✓ 写底稿✓ 入林←', '底稿写了：轮到入林');
st.mist_book.on = true;
eq(guideSteps('mist', st, s), null, '入林之后退场');
eq(guideSteps('nope', st, s), null, '不认识的页不出');

// 2. 撤销放回
var arr = ['a', 'b', 'd'];
putBack(arr, 2, 'c'); eq(arr, ['a', 'b', 'c', 'd'], '放回原位');
putBack(arr, 99, 'z'); eq(arr[arr.length - 1], 'z', '原位已经超出长度：放到末尾');
putBack(arr, -3, '0'); eq(arr[0], '0', '负数位置：放到开头');

// 3. 抄连接
s = freshSettings();
eq(copyConnProfile(s, 'api', 'act_api'), false, '源头没填地址：不抄');
s.api = { url: 'https://a', key: 'sk-a', model: 'm-a', timeout_s: 300, max_tokens: 8000, temperature: 0.8 };
s.act_api.use_tavern = true;
eq(copyConnProfile(s, 'api', 'act_api'), true, '抄到切星');
eq([s.act_api.url, s.act_api.key, s.act_api.model, s.act_api.timeout_s, s.act_api.max_tokens, s.act_api.use_tavern],
  ['https://a', 'sk-a', 'm-a', 300, 8000, true], '地址密钥模型超时上限都抄了，「用酒馆连接」不动');
eq(copyConnProfile(s, 'api', 'mist_api'), true, '抄到 God');
eq([s.mist_api.url, s.mist_api.timeout_s], ['https://a', undefined], 'God 那格没有超时字段就不硬塞');
s.act_api.url = 'https://changed';
eq(s.api.url, 'https://a', '抄完各改各的：改这页不动那页');
eq(copyConnProfile(s, 'api', 'api'), false, '自己抄自己：不动');
eq(copyConnProfile(s, 'nope', 'api'), false, '不认识的槽：不动');

// 4. 分镜搬家：打包 → 解包
ab = { outline: '先相爱，再误会', acts: [blankAct('相爱', '甜', '牵手', '不准分手', 'compiled'), blankAct('误会', '虐', '摔门', '不准和好', 'hand')] };
ab.acts[1].rounds = 8;
sb = { wish: '去登山', steps: [blankStep('山脚', '野莓熟了', 'compiled'), blankStep('大雨', '雨砸下来', 'compiled')] };
var packed = packBoard(ab, sb);
var b = unpackBoard(packed);
eq([b.outline, b.acts.length, b.acts[1].name, b.acts[1].rounds, b.acts[0].forbid, b.wish, b.steps.length, b.steps[1].text],
  ['先相爱，再误会', 2, '误会', 8, '不准分手', '去登山', 2, '雨砸下来'], '打包再解包：原样回来');
eq(packed.indexOf('"id"') < 0 && packed.indexOf('fired_round') < 0, true, '不带 id 和进度');
eq(unpackBoard('你看这个：\n```json\n' + packed + '\n```\n谢谢').acts.length, 2, '前后带了别的字、包了代码块也认');
function throws(fn) { try { fn(); return null; } catch (e) { return e.message; } }
eq(/没找到/.test(throws(function () { unpackBoard('随便一段话'); })), true, '不是那段东西：说人话');
eq(/读不出来/.test(throws(function () { unpackBoard('{"luciole":"luciole-storyboard",'); })), true, '被截断：说人话');
eq(/不是小萤火/.test(throws(function () { unpackBoard('{"acts":[{"name":"a"}]}'); })), true, '别的 JSON 不认');
eq(/是空的/.test(throws(function () { unpackBoard(JSON.stringify({ luciole: BOARD_TAG, acts: [{ play: '没名字' }], steps: [{ name: '没正文' }], veil: { secret: '  ' }, mist: { premise: '' } })); })), true, '空壳不认');
var many = { luciole: BOARD_TAG, acts: [], steps: [] };
for (var i = 0; i < 30; i++) { many.acts.push({ name: 'a' + i, rounds: 5000 }); many.steps.push({ text: 's' + i }); }
b = unpackBoard(JSON.stringify(many));
eq([b.acts.length, b.steps.length, b.acts[0].rounds], [ACT_MAX, STEP_MAX, 999], '超量截到上限，轮数夹住');

// 5. 分镜搬家：导入
function target() {
  ab = { locked: false, outline: '旧大纲', acts: [blankAct('旧幕', '', '', '', 'hand')], current_idx: 0, finished: true };
  sb = { on: false, wish: '旧愿望', steps: [blankStep('旧步', '旧事', 'hand')], cursor: 0, served: 1, used: true, finished: true };
  mb = { on: false, premise: '旧底稿', interval: 4, scenes: [{ name: '走过的一处' }] };
  logs = []; veilLogs = []; mistLogs = []; toasts = []; renders = 0; cleared = 0;
}
target(); secret = ''; st = freshStory();
eq(importBoard(unpackBoard(packed)), true, '导入成功');
eq([ab.acts.length, ab.acts[1].name, ab.acts[1].rounds, ab.acts[0].source, ab.current_idx, ab.finished, ab.outline],
  [2, '误会', 8, 'hand', -1, false, '先相爱，再误会'], '幕本换掉，进度归零，大纲跟着来');
eq([sb.steps.length, sb.steps[0].name, sb.cursor, sb.served, sb.used, sb.finished, sb.wish],
  [2, '山脚', -1, 0, false, false, '去登山'], '步骤换掉，进度归零');
eq(ab.acts[0].id !== b.acts[0].id && /^act_/.test(ab.acts[0].id), true, '导入的幕拿到新 id');
eq([renders, /2 幕、2 步/.test(logs[0]), toasts[0][1]], [1, true, 'success'], '重画一次，留日志，报成功');

target();
eq(importBoard(unpackBoard(JSON.stringify({ luciole: BOARD_TAG, steps: [{ name: '', text: '只有步骤' }] }))), true, '只带步骤的包');
eq([ab.acts[0].name, ab.outline, sb.steps[0].name, sb.steps[0].text], ['旧幕', '旧大纲', '第 1 步', '只有步骤'], '没带的那一半不动；没名字的步骤补上名字');

target(); ab.locked = true;
eq(importBoard(unpackBoard(packed)), false, '已开演：不让导幕本');
eq([ab.acts[0].name, sb.steps[0].name], ['旧幕', '旧步'], '拒掉时一样都不动');
target(); sb.on = true;
eq(importBoard(unpackBoard(packed)), false, '步骤正在推进：不让导');
target(); ab.locked = true;
eq(importBoard(unpackBoard(JSON.stringify({ luciole: BOARD_TAG, steps: [{ text: '一步' }] }))), true, '已开演但包里只有步骤：可以导');

// 导入的「不准」和步骤正文是原样给演员看的：撞上本聊天的秘密要拦
target(); secret = '她其实是狐狸精，顶替了沈家小姐'; st = freshStory();
var leaky = { luciole: BOARD_TAG,
  acts: [{ name: '一', forbid: '不准发现她其实是狐狸精' }, { name: '二', forbid: '不准先低头' }],
  steps: [{ name: 'a', text: '有人说她其实是狐狸精顶替的' }, { name: 'b', text: '下雨了' }] };
eq(importBoard(unpackBoard(JSON.stringify(leaky))), true, '撞秘密的包：照样导入');
eq([ab.acts.length, ab.acts[0].forbid, ab.acts[1].forbid], [2, '', '不准先低头'], '撞了的「不准」清空，幕留着');
eq([sb.steps.length, sb.steps[0].text], [1, '下雨了'], '撞了的步骤整步跳过');
eq([/2 处/.test(logs.join('|')), toasts[0][1]], [true, 'warning'], '拦了几处说清楚，提示是警告不是成功');
secret = '';

// 5b. 文字闸：「演什么」和幕名也是原样给演员看的（v3.12 之前只查「不准」）
secret = '她其实是狐狸精，顶替了沈家小姐的身份'; st = freshStory();
eq(actLeak({ name: '重逢', play: '他们在庙会上重逢', forbid: '不准先低头' }), null, '干净的一幕：放行');
eq(!!actLeak({ name: '重逢', play: '这一段她其实是狐狸精，顶替了沈家小姐这件事开始露馅', forbid: '' }), true, '「演什么」把秘密那句话抄进来：拦');
eq(!!actLeak({ name: '她其实是狐狸精，顶替者', play: '甜', forbid: '' }), true, '写进幕名：拦');
eq(actLeak({ name: '重逢', play: '沈家小姐的身份文书被翻了出来', forbid: '' }), null, '正文只对上七个字（公开设定里的词）：不拦');
eq(!!actLeak({ name: '重逢', play: '甜', forbid: '不准说她是狐狸精，顶替的' }), true, '「不准」是短句，六个字对上就拦');
eq(sceneLeak({ name: '庙', env: '香火很旺', cast: '', rules: '' }), null, '干净的环境卡：放行');
eq(!!sceneLeak({ name: '庙', env: '', cast: '有人在议论她其实是狐狸精，顶替了谁', rules: '' }), true, '环境卡「在场」带了秘密：拦');
target();
eq(importBoard(unpackBoard(JSON.stringify({ luciole: BOARD_TAG, acts: [{ name: '她其实是狐狸精，顶替者', play: '这一段她其实是狐狸精，顶替了沈家小姐', forbid: '不准先低头' }] }))), true, '导入的幕也过这道闸');
eq([ab.acts[0].name, ab.acts[0].play, ab.acts[0].forbid], ['第 1 幕', '', '不准先低头'], '撞了的幕名换成序号、「演什么」清空，干净的那栏留着');
secret = '';

// 5c. 搬家：第一幕和第三幕
secret = '她并非将军府的亲生小姐，二十年前生母把她托付至此';
var src = { status: 'lit', hidden_secret: secret, banned_words: ['亲生', '生母'],
  config: { kind: 'case', run_mode: 'smart', order_mode: 'tiered', intensity: 'clear', interval: 7, total_rounds: 80, clue_count: 3, author_mode: true },
  clues: [{ id: 'c1', text: '旧账里有一笔没写用途的银子', used: true, delivered_count: 2, fired_round: 3 }, { id: 'c2', text: '她的袖口多缝了一道暗线', used: false, delivered_count: 0 }],
  clock: { round: 24, cursor: 1, active_id: 'c2' }, verdict: { answer: '是老周', oneline: '用电记录对不上', made_at: 'x' },
  habits: { speech: ['话说一半会停'], tone: ['对长辈客气得过分'], habits: ['进屋先看门'], at: 'x' } };
var srcMist = { on: true, premise: '无限流，每处一张规则表', interval: 6, scenes: [{ name: 'x' }] };
packed = packBoard(null, null, src, srcMist);
eq(packed.indexOf('"used"') < 0 && packed.indexOf('fired_round') < 0 && packed.indexOf('"round"') < 0 && packed.indexOf('scenes') < 0, true, '第一、三幕的包同样不带进度和足迹');
b = unpackBoard(packed);
eq([b.veil.secret === secret, b.veil.banned, b.veil.kind, b.veil.run_mode, b.veil.order_mode, b.veil.intensity, b.veil.interval, b.veil.total_rounds, b.veil.clues.length, b.veil.answer, b.veil.habits.habits[0], b.mist.premise, b.mist.interval, b.acts.length],
  [true, ['亲生', '生母'], 'case', 'smart', 'tiered', 'clear', 7, 80, 2, '是老周', '进屋先看门', '无限流，每处一张规则表', 6, 0], '秘密、禁词、玩法配置、线索、谜底、习性单、世界底稿都在');
src.config.run_mode = 'supervise';
eq(unpackBoard(packBoard(null, null, src, null)).veil.clues.length, 0, 'AI 监督的线索是 God 现场写的，不当备料搬走');
src.config.run_mode = 'smart';
b = unpackBoard(JSON.stringify({ luciole: BOARD_TAG, veil: { secret: 'x', kind: '乱写', run_mode: 'hack', order_mode: 1, intensity: null, interval: -5, total_rounds: 1e9, clues: ['a', 3, '', ' b '], banned: 'no', habits: { speech: [null, '好'] } } }));
eq([b.veil.kind, b.veil.run_mode, b.veil.order_mode, b.veil.intensity, b.veil.interval, b.veil.total_rounds, b.veil.clues, b.veil.banned, b.veil.habits.speech, b.veil.habits.tone],
  ['secret', 'uniform', 'sequential', 'standard', 1, 9999, ['a', 'b'], [], ['好'], []], '包里乱写的配置夹回合法值，不是字符串的条目丢掉');

target(); secret = ''; st = freshStory(); st.clock = { round: 9 }; st.reveal_at = 'x';
eq(importBoard(unpackBoard(packed)), true, '导入第一幕 + 第三幕');
eq([st.hidden_secret === src.hidden_secret, st.banned_words, st.status, st.config.kind, st.config.run_mode, st.config.interval, st.config.clue_count, st.clues.length, st.clues[0].used, st.clues[0].delivered_count, /^clue_/.test(st.clues[0].id), st.clock.round, st.clock.active_id, st.reveal_at, st.verdict.answer, st.habits.tone[0], cleared],
  [true, ['亲生', '生母'], 'compiled', 'case', 'smart', 7, 2, 2, false, 0, true, 0, null, null, '是老周', '对长辈客气得过分', 1], '第一幕落账：线索回到没发过，轮钟归零，注入清掉，状态是「已备好」');
eq([mb.premise, mb.interval, mb.scenes.length, ab.acts[0].name, sb.steps[0].name], ['无限流，每处一张规则表', 6, 1, '旧幕', '旧步'], '世界底稿换掉、足迹不动；包里没带第二幕，第二幕不动');
eq([/导入第一幕/.test(veilLogs[0]), /导入世界底稿/.test(mistLogs[0])], [true, true], '各记各的日志');

// 包是文本，谁都能改：导入的线索和手写的过同一道安检
target(); st = freshStory();
var dirty = JSON.parse(packed);
dirty.veil.clues = ['干净的一条', '这条带了禁词：她的生母来过', '这条有残留宏 {{user}}', '这条抄了秘密：她并非将军府的亲生小姐，二十年前生母把她托付至此'];
dirty.veil.habits.habits = ['进屋先看门', '像狐狸一样警觉'];
eq(importBoard(unpackBoard(JSON.stringify(dirty))), true, '被改过的包：照样导入');
eq([st.clues.length, st.clues[0].text, st.habits.habits, toasts[0][1], /4 处/.test(veilLogs.join('|'))], [1, '干净的一条', ['进屋先看门'], 'warning', true], '带禁词、带宏、抄秘密的线索和没过审的习性都拦在外面，并说清拦了几处');

// 现在不能导：要么全进，要么一样都不动
target(); st = freshStory(); st.status = 'lit'; st.hidden_secret = '原来的秘密';
eq(importBoard(unpackBoard(packed)), false, '线索正点亮着：不让导第一幕');
eq([st.hidden_secret, mb.premise], ['原来的秘密', '旧底稿'], '拒掉时同一个包里的第三幕也不动');
target(); st = freshStory(); mb.on = true;
eq(importBoard(unpackBoard(packed)), false, '人还在林中：不让导世界底稿');
eq(st.hidden_secret, '', '拒掉时同一个包里的第一幕也不动');
target(); st = freshStory(); compileState.running = true;
eq(importBoard(unpackBoard(packed)), false, '正在编译：不让导第一幕'); compileState.running = false;
target(); st = freshStory(); ab.locked = true;
var both = JSON.parse(packed); both.acts = [{ name: '新幕', play: 'x' }];
eq(importBoard(unpackBoard(JSON.stringify(both))), false, '包里有幕但已开演：整包拒掉');
eq(st.hidden_secret, '', '第一幕没有被先写进去一半');
secret = '';

// 6. 报错上墙
alerts = { veil: null, act: null, mist: null };
noteAlert('veil', '第 3 轮：线索上台'); eq(liveAlert('veil'), null, '普通日志不上墙');
noteAlert('veil', '⚠ 撞了秘密，已拦下'); eq(liveAlert('veil'), null, '警告不上墙（当场已经弹过提示）');
noteAlert('act', '✗ 切星失败：上游超时'); eq(liveAlert('act').msg, '切星失败：上游超时', '✗ 开头的上墙，去掉前缀');
eq([liveAlert('veil'), liveAlert('mist')], [null, null], '只记在它自己那一页');
noteAlert('act', '✗ 又失败了'); eq(liveAlert('act').msg, '又失败了', '只留最近一条');
now += ALERT_TTL_MS + 1; eq([liveAlert('act'), alerts.act], [null, null], '过一刻钟自动撤');

// 7. 浮标状态
function calm() {
  on = true; alerts = { veil: null, act: null, mist: null };
  compileState.running = habitsState.running = splitState.running = stepSplitState.running = false;
  planFlight = pilotFlight = mistFlight = null; st = freshStory();
}
calm(); eq(floaterState(), 'idle', '什么都没挂：灯灭着');
st = null; eq(floaterState(), 'idle', '没开聊天：灯灭着');
calm(); st.status = 'lit'; eq(floaterState(), 'lit', '线索点亮：灯亮');
calm(); st.act_book = { locked: true, finished: false }; eq(floaterState(), 'lit', '幕本开演：灯亮');
st.act_book.finished = true; eq(floaterState(), 'idle', '幕本走完：灯灭');
calm(); st.step_book = { on: true }; eq(floaterState(), 'lit', '步骤推进：灯亮');
calm(); st.mist_book = { on: true }; eq(floaterState(), 'lit', '人在林中：灯亮');
calm(); st.status = 'lit'; compileState.running = true; eq(floaterState(), 'busy', '干活压过亮灯');
calm(); pilotFlight = {}; eq(floaterState(), 'busy', '领航员在路上也算干活');
calm(); mistFlight = {}; noteAlert('mist', '✗ God 没回来'); eq(floaterState(), 'alert', '报错压过干活');
on = false; eq(floaterState(), 'off', '拉闸压过一切');

// 8. 演员此刻耳边
st = freshStory(); st.config.author_mode = true; air = {};
var rows = onAirRows(st);
eq([rows.length, rows.map(function (r) { return r.name; }).join(' '), rows.filter(function (r) { return r.on; }).length], [5, '剧情步骤 线索 随身须知 幕本 此刻所在', 0], '五条通道按离回复的远近排，什么都没挂时全空');
air[INJECT_KEY] = { text: '【线索】旧账里有一笔银子', depth: 1 }; air[INJECT_KEY_ACT] = { text: '【本段设定】重逢', depth: 2 }; air[INJECT_KEY_STEP] = { text: '   ', depth: 0 };
rows = onAirRows(st);
eq([rows[0].on, rows[1].on, rows[1].text, rows[1].depth, rows[3].on, rows[3].depth], [false, true, '【线索】旧账里有一笔银子', 1, true, 2], '挂着的原样列出来；只有空白的算空');
st.config.author_mode = false; rows = onAirRows(st);
eq([rows[1].on, rows[1].hidden, rows[1].text.indexOf('银子') < 0, /盲玩/.test(rows[1].text), rows[3].text], [true, true, true, true, '【本段设定】重逢'], '盲玩模式：线索那一格只说「有一条」，不露原文；别的通道照常');
eq(onAirRows(null).length, 5, '没开聊天也不炸');

// 9. 删楼之后问不问
st = freshStory(); eq(floorNoteFor(st), null, '什么都没跑：删楼不打扰');
eq(floorNoteFor(null), null, '没开聊天：不打扰');
st.status = 'lit'; st.clock = { round: 0 }; eq(floorNoteFor(st), null, '刚点亮还在第 0 轮：没什么可退');
st.clock.round = 5; eq(floorNoteFor(st), { veil: true, step: false }, '线索在走：问要不要回拨');
st.step_book = { on: true, cursor: 0 }; eq(floorNoteFor(st), { veil: true, step: false }, '步骤还在第一步：没有上一步可退');
st.step_book.cursor = 2; eq(floorNoteFor(st), { veil: true, step: true }, '两样都在走：两个都问');
st.status = 'compiled'; eq(floorNoteFor(st), { veil: false, step: true }, '只有步骤在走：只问步骤');
st.step_book.on = false; eq(floorNoteFor(st), null, '步骤停了：不问');
st.act_book = { locked: true }; st.mist_book = { on: true }; eq(floorNoteFor(st), null, '幕本和雾林只是轮数多记一轮，不丢东西：不打扰');

// 酒馆的「重新生成」也会发删楼事件（先删上一条回复再重写）——那不是玩家在删楼
eq([isRegenDelete(1000, 1000), isRegenDelete(1000, 1400), isRegenDelete(1000, 5999)], [true, true, true], '重新生成起飞后紧跟着的删楼：算它自己的');
eq([isRegenDelete(0, 1400), isRegenDelete(1000, 6000), isRegenDelete(1000, 999999), isRegenDelete(2000, 1000)], [false, false, false, false], '没重新生成过、或者早过期了：是玩家真删楼');

// 10. 接着想下一段
sb = { wish: '男女主去登山', steps: [{ name: '山脚' }, { name: '' }, { name: '突降大雨' }] };
var w = stepContinueWish(sb);
eq([isContinueWish(w), w.indexOf('「男女主去登山」') > 0, w.indexOf('山脚 → 突降大雨') > 0, /别重演/.test(w), /从现场此刻/.test(w)], [true, true, true, true, true], '替玩家写好：接着哪段、哪些演过别重演、从现场往下长');
sb.wish_base = '男女主去登山'; sb.wish = w; sb.steps = [{ name: '下山' }, { name: '客栈' }];
var w2 = stepContinueWish(sb);
eq([w2.indexOf('【续】', 1) < 0, w2.indexOf('「男女主去登山」') > 0, w2.indexOf('下山 → 客栈') > 0, w2.indexOf('山脚') < 0], [true, true, true, true], '一续再续：不把上一句「续」套进去，只列刚演完的这一段');
eq(isContinueWish(stepContinueWish({ wish: '【续】上一句', steps: [] })) && stepContinueWish({ wish: '【续】上一句', steps: [] }).indexOf('上一段戏') > 0, true, '找不到亲手写的那句：就说「上一段戏」');
eq([isContinueWish('男女主去登山'), isContinueWish(''), isContinueWish(null)], [false, false, false], '普通愿望不被认成续写');

// 11. 记账
eq([usageRole('api', ''), usageRole(undefined, ''), usageRole('act_api', '切星'), usageRole('api2', '小萤火'), usageRole('api2', 'God'), usageRole('api3', '领航员'), usageRole('mist_api', 'God')],
  ['编译 / 习性单', '编译 / 习性单', '切星 / 想步骤', '调度员', 'God（帷幕）', '领航员', 'God（雾林）'], '角色名按走哪条连接定：同一条连接上的活记在同一行');
eq([kchars(0), kchars(999), kchars(1000), kchars(12345)], ['0 字', '999 字', '1 千字', '12.3 千字'], '字数的读法');
st = freshStory(); chatTok = 'A';
eq(usageRows(st), [], '没调过：空');
var passthrough = tally('调度员', 'sys', 'usr!', Promise.resolve('回话'));
eq([st.usage['调度员'].n, st.usage['调度员'].sent, st.usage['调度员'].got], [1, 7, 0], '起飞就记一次、记发出多少字');
st = null; eq(tally('调度员', 'a', 'b', Promise.resolve('x')) instanceof Promise, true, '没开聊天：不记账，原样放行');
st = freshStory();
var chain = passthrough.then(function (r) {
  eq(r, '回话', '记账不改回话');
  return tally('领航员', 's', 'u', Promise.resolve('DONE 她上了车'));
}).then(function () {
  eq([st.usage['领航员'].n, st.usage['领航员'].got, st.usage['领航员'].fail], [1, 9, 0], '落地记收回多少字');
  return tally('领航员', 's', 'u', Promise.reject(new Error('HTTP 502'))).then(function () { return 'no'; }, function (e) { return e.message; });
}).then(function (msg) {
  eq([msg, st.usage['领航员'].n, st.usage['领航员'].fail], ['HTTP 502', 2, 1], '失败记一笔失败，错误原样抛出去');
  var other = freshStory(), mine = st;
  var p = tally('God（雾林）', 's', 'u', new Promise(function (res) { setTimeout(function () { res('一整张环境卡'); }, 5); }));
  chatTok = 'B'; st = other;                       // 起飞后换了聊天
  return p.then(function () { eq([mine.usage['God（雾林）'].n, mine.usage['God（雾林）'].got, other.usage], [1, 0, undefined], '中途换了聊天：落地那一半不记，也不写到新聊天的账上'); st = mine; chatTok = 'A'; });
}).then(function () {
  st.usage['编译 / 习性单'] = { n: 3, fail: 0, sent: 9000, got: 4000 }; st.usage['自定义角色'] = { n: 1, fail: 0, sent: 1, got: 1 }; st.usage['空的'] = { n: 0 };
  eq(usageRows(st).map(function (r) { return r.role + '×' + r.n; }), ['编译 / 习性单×3', '领航员×2', 'God（雾林）×1', '自定义角色×1'], '按固定顺序列，没见过的角色排后面，零次的不列');
});

chain.then(function () {
  Date.now = realNow;
  console.log(fails ? ('\n' + fails + ' FAILED') : '\nALL PASS');
  process.exit(fails ? 1 : 0);
}).catch(function (e) { console.error(e); process.exit(2); });
