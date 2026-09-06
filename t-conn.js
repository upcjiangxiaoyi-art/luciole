// 连接分家测试：三页各自的连接、一次性搬家、页内回退。跑法：node t-conn.js
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
var EXT_NAME = 'luciole_v2', DEFAULT_BATCH = 8;
var PROFILE_FALLBACK = { api2: 'api', api3: 'act_api' };
var store;
function ctx() { return { extensionSettings: store }; }
eval(['trim', 'isObject', 'isArray', 'defaultSettings', 'settings', 'resolveProfile'].map(grab).join('\n'));
var fails = 0;
function eq(a, b, msg) { if (JSON.stringify(a) !== JSON.stringify(b)) { fails++; console.log('✗', msg, '\n   got', JSON.stringify(a), '\n   want', JSON.stringify(b)); } else console.log('✓', msg); }

// 全新
store = {};
var s = settings();
eq([s.act_api.url, s.mist_api.url, s.act_api.use_tavern], ['', '', false], '全新账本三页连接都是空的');

// 老用户：只填了编译连接，切星靠它、雾林 God 靠它
store = { luciole_v2: { enabled: true, api: { url: 'https://a', key: 'k1', model: 'm1', timeout_s: 300, max_tokens: 6000, temperature: 0.7 }, use_tavern: false, api2: { url: '', key: '', model: '' }, api3: { url: '', key: '', model: '' } } };
s = settings();
eq([s.act_api.url, s.act_api.key, s.act_api.model, s.act_api.timeout_s, s.act_api.max_tokens], ['https://a', 'k1', 'm1', 300, 6000], '切星连接抄自编译连接');
eq([s.mist_api.url, s.mist_api.model], ['https://a', 'm1'], 'God 连接：调度员空 → 抄编译连接');
eq(resolveProfile('api3', '领航员').model, 'm1', '领航员回退到本页切星连接');
s.api.model = 'changed';
eq(resolveProfile('api3', '领航员').model, 'm1', '之后改编译连接，不再影响第二幕');

// 老用户：调度员填了便宜模型 → 雾林 God 抄的是当时实际生效的调度员连接
store = { luciole_v2: { api: { url: 'https://a', key: 'k1', model: 'strong' }, use_tavern: true, api2: { url: 'https://b', key: 'k2', model: 'cheap' } } };
s = settings();
eq([s.mist_api.url, s.mist_api.model], ['https://b', 'cheap'], 'God 连接抄自当时生效的调度员连接');
eq(s.act_api.use_tavern, true, '切星沿用「酒馆当前连接」勾选');

// 跨页不借
store = { luciole_v2: { api: { url: 'https://a', key: 'k', model: 'm' }, act_api: { url: '', key: '', model: '' }, api3: { url: '', key: '', model: '' }, mist_api: { url: '', key: '', model: '' } } };
s = settings();
var threw = null; try { resolveProfile('api3', '领航员'); } catch (e) { threw = e.message; }
eq(/领航员连接未配置/.test(threw) && /本页/.test(threw), true, '第二幕两项都空 → 报本页，不借帷幕沙漏的: ' + threw);
threw = null; try { resolveProfile('mist_api', 'God'); } catch (e) { threw = e.message; }
eq(/God连接未配置/.test(threw), true, '雾林 God 空 → 报错，不借别页');
eq(resolveProfile('api2', '小萤火').model, 'm', '帷幕沙漏页内：调度员空 → 回退编译连接');

console.log(fails ? ('\n' + fails + ' FAILED') : '\nALL PASS');
process.exit(fails ? 1 : 0);
