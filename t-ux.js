// 使用感（v3.11）流程测试：从 index.js 抠出真实函数，只把账本、日志、面板换成假的。
// 管的是：引路条、分镜搬家、抄连接、撤销放回、报错上墙、浮标状态。
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
var fns = ['trim', 'clamp', 'isObject', 'isArray', 'uid', 'forbidLeakCheck', 'blankAct', 'blankStep',
  'guideSteps', 'putBack', 'packBoard', 'unpackBoard', 'importBoard', 'copyConnProfile',
  'noteAlert', 'liveAlert', 'floaterState'];
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
eq(/既没有幕也没有步骤/.test(throws(function () { unpackBoard(JSON.stringify({ luciole: BOARD_TAG, acts: [{ play: '没名字' }], steps: [{ name: '没正文' }] })); })), true, '空壳不认');
var many = { luciole: BOARD_TAG, acts: [], steps: [] };
for (var i = 0; i < 30; i++) { many.acts.push({ name: 'a' + i, rounds: 5000 }); many.steps.push({ text: 's' + i }); }
b = unpackBoard(JSON.stringify(many));
eq([b.acts.length, b.steps.length, b.acts[0].rounds], [ACT_MAX, STEP_MAX, 999], '超量截到上限，轮数夹住');

// 5. 分镜搬家：导入
function target() {
  ab = { locked: false, outline: '旧大纲', acts: [blankAct('旧幕', '', '', '', 'hand')], current_idx: 0, finished: true };
  sb = { on: false, wish: '旧愿望', steps: [blankStep('旧步', '旧事', 'hand')], cursor: 0, served: 1, used: true, finished: true };
  logs = []; toasts = []; renders = 0;
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
eq([/2 处/.test(logs[0]), toasts[0][1]], [true, 'warning'], '拦了几处说清楚，提示是警告不是成功');
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

Date.now = realNow;
console.log(fails ? ('\n' + fails + ' FAILED') : '\nALL PASS');
process.exit(fails ? 1 : 0);
