/*
 * Luciole 2.0 —— 小萤火 · 帷幕沙漏（均匀散落内核）
 * clean-room 重构 · Phase 1
 *
 * 产品宪法（不可违背）：
 *  1. 真相锁定，路径开放。
 *  2. 玩家输入是行动意图，不是既成事实。
 *  3. 上帝掌握真相，不掌握选择。
 *  4. 演员只有当下的演出权——完整秘密永不进入演员上下文。
 *  5. 受保护范围之外，故事仍能正常呼吸。
 *
 * 安全承诺（全部本地可验证）：
 *  - 结构安全：hidden_secret 只进编译请求，永不进注入文本；
 *  - 白名单安全：注入文本只来自已编译并通过安检的候选；
 *  - 字面安检：禁词表 + 残留酒馆宏拦截 + 秘密原文连续片段重合检查。
 *
 * 明确不做（Phase 1）：
 *  - 无 pending 锁、无探针、无两阶段事务、无 inverse diff、无版本迁移；
 *  - 无三层洋葱、无六档阶段；
 *  - 运行期 API 调用数 = 0（编译期才联网）。
 */
(function () {
    'use strict';

    /* ================================================================
     * 1. 常量与小工具
     * ================================================================ */

    /* 面板上显示的版本号。改版本时这里和 manifest.json 一起改——
     * 界面上看得见版本，才能一眼确认新文件到底装上没有。 */
    var VERSION = '3.4.1';

    var EXT_NAME = 'luciole_v2';
    var INJECT_KEY = 'luciole_v2_clue';
    /* 三条注入通道，各管各的，绝不合并——
     * 合并的话：正挂着幕本时按一下须知，就会把幕本冲掉。 */
    var INJECT_KEY_ACT = 'luciole_v2_act';     // 第二幕 · 幕本（常驻）
    var INJECT_KEY_BRIEF = 'luciole_v2_brief'; // 随身须知（一次性，手动）
    var WISH_OVERLAP_WINDOW = 6;               // 愿望原文指纹窗口（铁律1的机器实现）
    var PANEL_ID = 'lcl2_panel';
    var LOG_LIMIT = 120;
    var SECRET_OVERLAP_WINDOW = 12;   // 秘密原文连续重合检查窗口（字符）
    var DEFAULT_BATCH = 8;            // 编译分批：每批线索条数上限

    function ctx() { return SillyTavern.getContext(); }

    /* 聊天身份令牌：用于跨异步边界确认"还是刚才那个聊天"。
     * 依次尝试三种来源，全都拿不到就返回空串——空串 = 守卫自动失效，
     * 行为与打补丁前完全一致，绝不会因为取不到 id 就误杀编译。 */
    var chatTokenSource = '';
    function chatToken() {
        var c;
        try { c = ctx(); } catch (e) { return ''; }
        try {
            if (typeof c.getCurrentChatId === 'function') {
                var v = c.getCurrentChatId();
                if (v !== null && v !== undefined && v !== '') { chatTokenSource = 'getCurrentChatId'; return String(v); }
            }
        } catch (e) { }
        try {
            if (c.chatId !== null && c.chatId !== undefined && c.chatId !== '') { chatTokenSource = 'chatId'; return String(c.chatId); }
        } catch (e) { }
        try {
            var ch = (c.characterId === null || c.characterId === undefined) ? '' : c.characterId;
            var gr = (c.groupId === null || c.groupId === undefined) ? '' : c.groupId;
            if (ch !== '' || gr !== '') { chatTokenSource = 'character/group'; return 'ch:' + ch + '|gr:' + gr; }
        } catch (e) { }
        chatTokenSource = '';
        return '';
    }

    /* 守卫判据：只有"两头都拿得到令牌、且不一样"才算换了聊天。
     * 任何一头是空串都放行——宁可守卫失灵，不可误杀。 */
    function chatChangedSince(token) {
        if (!token) return false;
        var now = chatToken();
        if (!now) return false;
        return now !== token;
    }

    /* 把模型回话截成一行放进日志——查问题时「它到底说了什么」比什么都重要 */
    function peek(raw, n) {
        var t = String(raw == null ? '' : raw).replace(/\s+/g, ' ');
        t = t.replace(/^\s+|\s+$/g, '');
        if (!t) return '（空回复）';
        n = n || 80;
        return t.length > n ? (t.slice(0, n) + '…') : t;
    }

    function trim(v) { return String(v == null ? '' : v).replace(/^\s+|\s+$/g, ''); }
    function isArray(v) { return Object.prototype.toString.call(v) === '[object Array]'; }
    function isObject(v) { return !!v && typeof v === 'object' && !isArray(v); }
    function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }
    function clone(v) { try { return JSON.parse(JSON.stringify(v)); } catch (e) { return v; } }
    function nowIso() { return new Date().toISOString(); }

    function uid(prefix) {
        return (prefix || 'id') + '_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
    }

    function esc(str) {
        return String(str == null ? '' : str)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    function toast(msg, kind) {
        try {
            var t = window.toastr;
            if (!t) return;
            if (kind === 'error') t.error(msg, '小萤火');
            else if (kind === 'warning') t.warning(msg, '小萤火');
            else if (kind === 'success') t.success(msg, '小萤火');
            else t.info(msg, '小萤火');
        } catch (e) { }
    }

    /* 残留酒馆宏检测：注入文本里绝不允许出现 {{...}}，
     * 防止酒馆在插件安检之后二次展开内容（交接书 实机坑 #8）。 */
    function hasResidualMacro(text) {
        return /\{\{[^}]*\}\}/.test(String(text || ''));
    }

    /* 与秘密原文的连续片段重合检查：
     * 对秘密文本做长度 SECRET_OVERLAP_WINDOW 的滑动窗口，
     * 任一窗口若原样出现在线索里则判定泄漏。纯本地、可严格证明。 */
    function windowOverlap(textA, textB, win) {
        var a = String(textA || '').replace(/\s+/g, '');
        var b = String(textB || '').replace(/\s+/g, '');
        if (b.length < win) return false;
        for (var i = 0; i + win <= b.length; i++) {
            if (a.indexOf(b.substr(i, win)) >= 0) return true;
        }
        return false;
    }

    function overlapsSecret(clueText, secretText) {
        var clue = String(clueText || '');
        var secret = String(secretText || '').replace(/\s+/g, '');
        var flatClue = clue.replace(/\s+/g, '');
        if (secret.length < SECRET_OVERLAP_WINDOW) return false;
        for (var i = 0; i + SECRET_OVERLAP_WINDOW <= secret.length; i++) {
            var win = secret.substr(i, SECRET_OVERLAP_WINDOW);
            if (flatClue.indexOf(win) >= 0) return true;
        }
        return false;
    }

    function containsBanned(clueText, bannedList) {
        var text = String(clueText || '');
        for (var i = 0; i < (bannedList || []).length; i++) {
            var w = trim(bannedList[i]);
            if (w && text.indexOf(w) >= 0) return w;
        }
        return null;
    }

    /* ================================================================
     * 2. 存储层
     *  - 全局设置（extensionSettings）：连接配置、注入深度等跨聊天偏好
     *  - 故事账本（chatMetadata）：每个聊天独立，绝不串线
     * ================================================================ */

    function defaultSettings() {
        return {
            api: { url: '', key: '', model: '', timeout_s: 240, max_tokens: 4000, temperature: 0.8 },
            use_tavern: false,     // true = 用酒馆当前连接（raw/quiet 降级，非流式，可能超时）
            depth: 1,              // setExtensionPrompt 注入深度
            batch_size: DEFAULT_BATCH,
            show_floater: true,    // 萤火虫浮标（可停进避风塘）
            theme: 'night',        // night = 夜·萤火林 / day = 昼·呀哈哈林
            page: 'veil',          // 当前停在哪一幕的页：veil | act | mist
            api2: { url: '', key: '', model: '' },   // 调度员 / God
            api3: { url: '', key: '', model: '' },   // 星灯领航员（三项留空即复用编译连接）  // 调度员连接（智能调度用；留空复用编译连接）
            ctx_strip: 'thinking, think, cot, reasoning, thought, plan, 思考, 思维链',  // 读上下文时剔除的标签块
            ctx_prefer: '',         // 若填写：楼层中含任一此类标签块时，只取块内文本（如 正文, summary）
            // 提示词预设：全局共用。'builtin' 是保留名，永远等于代码默认值，改不动也删不掉——
            // 随时有个干净的参照可比对。用户改的都是副本。
            prompt_presets: { active: 'builtin', list: [] }
        };
    }

    function settings() {
        var c = ctx();
        var root = c.extensionSettings || (c.extensionSettings = {});
        if (!isObject(root[EXT_NAME])) root[EXT_NAME] = defaultSettings();
        var s = root[EXT_NAME];
        var d = defaultSettings();
        if (!isObject(s.api)) s.api = d.api;
        if (!isObject(s.api2)) s.api2 = d.api2;
        var k;
        for (k in d.api) if (s.api[k] === undefined) s.api[k] = d.api[k];
        for (k in d.api2) if (s.api2[k] === undefined) s.api2[k] = d.api2[k];
        for (k in d) if (s[k] === undefined) s[k] = d[k];
        if (!isObject(s.prompt_presets)) s.prompt_presets = d.prompt_presets;
        if (!isArray(s.prompt_presets.list)) s.prompt_presets.list = [];
        if (!s.prompt_presets.active) s.prompt_presets.active = 'builtin';
        return s;
    }

    function saveSettings() {
        try {
            var c = ctx();
            if (typeof c.saveSettingsDebounced === 'function') c.saveSettingsDebounced();
        } catch (e) { }
    }

    function blankStory() {
        return {
            v: 2,
            status: 'empty',           // empty | compiled | lit | finished
            hidden_secret: '',         // 完整秘密——只进编译请求，永不注入
            banned_words: [],
            config: {
                total_rounds: 100,
                interval: 10,
                clue_count: 10,
                intensity: 'standard', // gentle | standard | clear
                author_mode: true,
                run_mode: 'uniform',   // uniform | smart | supervise
                kind: 'secret',        // secret 藏一个秘密 | case 查一桩案子
                order_mode: 'sequential',  // sequential 顺序 | tiered 分层洗牌 | random 纯随机
                prompt_preset: ''      // '' = 跟随全局当前选中；填 id = 本故事固定用这套
            },
            clues: [],                 // { id, text, used, delivered_count }
            clock: {
                round: 0,              // 相对轮：点亮 = 第 0 轮，此后每条玩家消息 +1
                next_due: 1,           // 下一次投放的相对轮（点亮后第一条玩家消息即首个机会）
                last_fire: 0,          // 上一次上台的轮数（改间隔时据此重算 next_due）
                order: null,           // 发牌序（clue id 数组）。点亮时摇一次落盘——
                                       // 绝不能每次现摇：重抽、回拨都会让顺序漂移，很难查
                cursor: 0,             // 已送条数（派生自 used 计数）
                active_id: null,       // 台上线索 id
                planned: null,         // smart: {for_round, clue_id} / supervise: {for_round, god_text|hold}
                hold_streak: 0,        // AI 监督连续暂缓计数
                lit_at: null
            },
            draft: null,               // 编译中断续跑用：{ clues: [], batch_done: n }
            log: []
        };
    }

    function chatStoryContainer() {
        var c = ctx();
        var meta = c.chatMetadata;
        if (!isObject(meta)) return null;   // 没有打开聊天
        if (!isObject(meta[EXT_NAME])) meta[EXT_NAME] = blankStory();
        return meta[EXT_NAME];
    }

    function story() {
        var st = chatStoryContainer();
        if (!st) return null;
        // 结构自愈（只补缺失字段，不做版本迁移）
        var d = blankStory();
        if (!isObject(st.config)) st.config = d.config;
        if (!isObject(st.clock)) st.clock = d.clock;
        if (!isArray(st.clues)) st.clues = [];
        if (!isArray(st.log)) st.log = [];
        if (!isArray(st.banned_words)) st.banned_words = [];
        var k;
        for (k in d.config) if (st.config[k] === undefined) st.config[k] = d.config[k];
        for (k in d.clock) if (st.clock[k] === undefined) st.clock[k] = d.clock[k];
        return st;
    }

    function saveStory() {
        try {
            var c = ctx();
            if (typeof c.saveMetadataDebounced === 'function') c.saveMetadataDebounced();
            else if (typeof c.saveMetadata === 'function') c.saveMetadata();
        } catch (e) { }
    }

    function pushLog(arr, msg) {
        arr.push({ t: nowIso(), msg: String(msg) });
        if (arr.length > LOG_LIMIT) arr.splice(0, arr.length - LOG_LIMIT);
    }

    // 第一幕 + 通用
    function log(msg) {
        var st = story();
        if (!st) return;
        pushLog(st.log, msg);
        saveStory();
        renderLogSoon();
    }

    // 不属于任何一幕的系统消息：两边各写一条
    function sysLog(msg) {
        var st = story();
        if (!st) return;
        pushLog(st.log, msg);
        if (isObject(st.act_book)) {
            if (!isArray(st.act_book.ledger)) st.act_book.ledger = [];
            pushLog(st.act_book.ledger, msg);
        }
        saveStory();
        renderLogSoon();
    }

    /* ================================================================
     * 3. 能力自检（启动时一次，缺什么明说什么）
     * ================================================================ */

    function capabilityReport() {
        var c = ctx();
        var caps = {
            inject: typeof c.setExtensionPrompt === 'function',
            metadata: isObject(c.chatMetadata) || c.chatMetadata === undefined, // 未开聊天时 undefined 属正常
            events: !!(c.eventSource && c.eventTypes),
            worldinfo: typeof c.loadWorldInfo === 'function',
            tavern_gen: typeof c.generateRaw === 'function' || typeof c.generateQuietPrompt === 'function'
        };
        var missing = [];
        if (!caps.inject) missing.push('演员注入口（setExtensionPrompt）');
        if (!caps.events) missing.push('聊天事件监听（eventSource）');
        caps.core_ok = caps.inject && caps.events;
        caps.missing = missing;
        return caps;
    }

    /* ================================================================
     * 4. 素材读取（编译台专用；范围严格限定为：
     *    角色卡适用字段 + 角色主世界书 + 角色卡内嵌世界书）
     * ================================================================ */

    function boundedText(text, limit) {
        var t = trim(text);
        if (t.length <= limit) return t;
        return t.slice(0, limit) + '\n……（超长截断，仅供取材）';
    }

    function activeCharacterRecords() {
        try {
            var c = ctx();
            var characters = c.characters || [];
            var current = characters[c.characterId];
            if (c.groupId === null || c.groupId === undefined || c.groupId === '') {
                return current ? [current] : [];
            }
            var groups = c.groups || [];
            var group = null;
            for (var g = 0; g < groups.length; g++) {
                if (String(groups[g] && groups[g].id) === String(c.groupId)) group = groups[g];
            }
            var members = group && isArray(group.members) ? group.members.map(String) : [];
            var disabled = group && isArray(group.disabled_members) ? group.disabled_members.map(String) : [];
            var out = [];
            for (var i = 0; i < characters.length; i++) {
                var avatar = trim(characters[i] && characters[i].avatar);
                if (avatar && members.indexOf(avatar) >= 0 && disabled.indexOf(avatar) < 0) out.push(characters[i]);
            }
            return out.length ? out : (current ? [current] : []);
        } catch (e) { return []; }
    }

    function characterCardText(limit) {
        try {
            var records = activeCharacterRecords();
            var parts = [];
            for (var i = 0; i < records.length; i++) {
                var ch = records[i];
                var sub = [];
                if (ch.name) sub.push('姓名：' + ch.name);
                if (ch.description) sub.push(ch.description);
                if (ch.personality) sub.push('性格：' + ch.personality);
                if (ch.scenario) sub.push('场景：' + ch.scenario);
                if (sub.length) parts.push(sub.join('\n'));
            }
            return boundedText(parts.join('\n---\n'), limit);
        } catch (e) { return ''; }
    }

    function worldBookEntriesText(data) {
        var entries = data && data.entries;
        var rows = [];
        if (isArray(entries)) rows = entries;
        else if (isObject(entries)) {
            var keys = Object.keys(entries);
            for (var i = 0; i < keys.length; i++) rows.push(entries[keys[i]]);
        }
        var texts = [];
        for (var r = 0; r < rows.length; r++) {
            var row = rows[r];
            var disabled = row && (row.disable === true || row.disabled === true || row.enabled === false);
            var content = trim(row && row.content);
            if (content && !disabled) texts.push(content);
        }
        return texts.join('\n');
    }

    /* 楼层文本清洗：
     * 1) prefer 标签命中 → 只取块内文本（如你的预设把正文/摘要包在专属标签里）；
     * 2) 否则剥掉 strip 标签块（思维链等），其余原样保留。 */
    function tagList(csv) {
        return String(csv || '').split(/[,，]/).map(trim).filter(Boolean);
    }

    function escapeReg(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

    function cleanMessageText(raw) {
        var text = String(raw || '');
        var s = settings();
        var prefer = tagList(s.ctx_prefer);
        for (var p = 0; p < prefer.length; p++) {
            var tag = escapeReg(prefer[p]);
            var re = new RegExp('<' + tag + '[^>]*>([^]*?)</' + tag + '>', 'gi');
            var m, picked = [];
            while ((m = re.exec(text)) !== null) picked.push(trim(m[1]));
            if (picked.length) return picked.join('\n');
        }
        var strip = tagList(s.ctx_strip);
        for (var q = 0; q < strip.length; q++) {
            var tag2 = escapeReg(strip[q]);
            text = text.replace(new RegExp('<' + tag2 + '[^>]*>[^]*?</' + tag2 + '>', 'gi'), '');
        }
        // 顺手剥掉 HTML 注释块
        text = text.replace(/<!--[^]*?-->/g, '');
        return trim(text.replace(/\n{3,}/g, '\n\n'));
    }

    /* 已有正文窗口：从最新往前取，跳过系统消息，总量封顶。
     * 直接给原文片段，不做二次摘要调用——少一次 API 就少一个失败点。
     * 返回 { text, count } */
    function recentStoryText(msgLimit, charLimit) {
        try {
            var c = ctx();
            var chat = c.chat || [];
            var picked = [];
            var total = 0;
            for (var i = chat.length - 1; i >= 0 && picked.length < msgLimit; i--) {
                var m = chat[i];
                if (!m || m.is_system) continue;
                var body = cleanMessageText(m.mes);
                if (!body) continue;
                var line = (m.is_user ? '玩家' : (trim(m.name) || '角色')) + '：' + body;
                if (total + line.length > charLimit) {
                    // 装不下整条就停：只收整条消息，不切半句话
                    if (picked.length === 0) picked.unshift(line.slice(0, charLimit) + '……（本条超长截断）');
                    break;
                }
                picked.unshift(line);
                total += line.length;
            }
            return { text: picked.join('\n'), count: picked.length };
        } catch (e) { return { text: '', count: 0 }; }
    }

    /* 返回 Promise<{ text, sources: [名字], missed: [原因] }> */
    function readCharacterWorldBooks(limit) {
        var c = ctx();
        var records = activeCharacterRecords();
        var texts = [];
        var sources = [];
        var missed = [];
        var loaders = [];
        for (var a = 0; a < records.length; a++) {
            (function (ch) {
                var data = ch && ch.data || {};
                var ext = data.extensions || {};
                var mainName = trim(ext.world);
                if (mainName) {
                    if (typeof c.loadWorldInfo === 'function') {
                        loaders.push(Promise.resolve().then(function () {
                            return c.loadWorldInfo(mainName);
                        }).then(function (wb) {
                            var t = worldBookEntriesText(wb);
                            if (t) { texts.push(t); sources.push('角色主世界书「' + mainName + '」'); }
                        }).catch(function (err) {
                            missed.push('角色主世界书「' + mainName + '」读取失败：' + (trim(err && err.message) || '未知原因'));
                        }));
                    } else {
                        missed.push('本酒馆版本没有公开 loadWorldInfo，角色主世界书「' + mainName + '」未纳入取材');
                    }
                }
                if (data.character_book) {
                    var t2 = worldBookEntriesText(data.character_book);
                    if (t2) { texts.push(t2); sources.push('角色卡内嵌世界书'); }
                }
            }(records[a]));
        }
        return Promise.all(loaders).then(function () {
            // 去重：酒馆导入内嵌书时常会同时把它落成独立世界书并绑为角色主书，
            // 两个入口指向同一份内容。按归一化文本比对，重复的只保留第一份。
            var seen = {};
            var uniqueTexts = [];
            var uniqueSources = [];
            var dropped = [];
            for (var i = 0; i < texts.length; i++) {
                var norm = String(texts[i]).replace(/\s+/g, '');
                var key = simpleHash(norm) + '_' + norm.length;
                if (seen[key]) { dropped.push(sources[i]); continue; }
                seen[key] = true;
                uniqueTexts.push(texts[i]);
                uniqueSources.push(sources[i]);
            }
            return {
                text: boundedText(uniqueTexts.join('\n---\n'), limit),
                sources: uniqueSources,
                deduped: dropped,
                missed: missed
            };
        });
    }

    /* ================================================================
     * 5. API 层（仅编译期使用；运行期零联网）
     *  主航道：独立 API（OpenAI 兼容），真流式，抗反代 60s 超时；
     *  备航道：酒馆当前连接（generateRaw / generateQuietPrompt 降级），
     *          非流式，明确标注可能被中转切断。
     * ================================================================ */

    function normalizeApiUrl(url) {
        var u = trim(url).replace(/\/+$/, '');
        if (!u) return '';
        if (/\/chat\/completions$/.test(u)) return u;
        if (/\/v\d+$/.test(u)) return u + '/chat/completions';
        return u + '/v1/chat/completions';
    }

    /* 解析 OpenAI 风格 SSE 流；reasoning 与正文分流，只累积正文。
     * onProgress(receivedChars) 用于 UI 进度。 */
    function readOpenAiStream(res, onProgress) {
        if (!res.body || !res.body.getReader) {
            return res.text().then(function (raw) { return extractFromJsonText(raw); });
        }
        var reader = res.body.getReader();
        var decoder = new TextDecoder('utf-8');
        var buffer = '';
        var content = '';
        var reasoning = '';
        function pump() {
            return reader.read().then(function (step) {
                if (step.done) return finish();
                buffer += decoder.decode(step.value, { stream: true });
                var lines = buffer.split(/\r?\n/);
                buffer = lines.pop();
                for (var i = 0; i < lines.length; i++) {
                    var line = trim(lines[i]);
                    if (!line || line.indexOf('data:') !== 0) continue;
                    var payload = trim(line.slice(5));
                    if (payload === '[DONE]') continue;
                    try {
                        var obj = JSON.parse(payload);
                        var delta = obj.choices && obj.choices[0] && obj.choices[0].delta || {};
                        if (typeof delta.content === 'string') content += delta.content;
                        if (typeof delta.reasoning_content === 'string') reasoning += delta.reasoning_content;
                        if (typeof delta.reasoning === 'string') reasoning += delta.reasoning;
                    } catch (e) { /* 非 JSON 行忽略 */ }
                }
                if (onProgress) onProgress(content.length, reasoning.length);
                return pump();
            });
        }
        function finish() {
            if (trim(content)) return content;
            // 正文为空但 reasoning 里可能藏着完整 JSON（部分推理模型的怪癖）
            var recovered = recoverJsonObject(reasoning);
            if (recovered) return recovered;
            var err = new Error('模型返回了 ' + reasoning.length + ' 字思考过程，但正文为空。建议：换非推理模型，或在中转后台关闭 reasoning 输出。');
            err.code = 'EMPTY_CONTENT';
            throw err;
        }
        return pump().catch(function (error) {
            try { reader.cancel(); } catch (e) { }
            throw error;
        });
    }

    function extractFromJsonText(raw) {
        var data;
        try { data = JSON.parse(raw); }
        catch (e) {
            var err0 = new Error('接口返回的不是 JSON（前 120 字）：' + String(raw).slice(0, 120));
            throw err0;
        }
        if (data.error) {
            var msg = isObject(data.error) ? (data.error.message || JSON.stringify(data.error)) : String(data.error);
            var err = new Error('接口报错：' + msg);
            throw err;
        }
        var choice = data.choices && data.choices[0] || {};
        var content = choice.message && choice.message.content || '';
        if (trim(content)) return content;
        var reasoning = choice.message && (choice.message.reasoning_content || choice.message.reasoning) || '';
        var recovered = recoverJsonObject(reasoning);
        if (recovered) return recovered;
        var err2 = new Error('模型返回成功但正文为空。');
        err2.code = 'EMPTY_CONTENT';
        throw err2;
    }

    /* 从杂讯文本中恢复第一个配平的 JSON 对象（用于 ```json 包裹或 reasoning 混入的场合） */
    function recoverJsonObject(text) {
        var t = String(text || '');
        var start = t.indexOf('{');
        while (start >= 0) {
            var depth = 0;
            var inStr = false;
            var escNext = false;
            for (var i = start; i < t.length; i++) {
                var ch = t.charAt(i);
                if (escNext) { escNext = false; continue; }
                if (ch === '\\') { escNext = true; continue; }
                if (ch === '"') { inStr = !inStr; continue; }
                if (inStr) continue;
                if (ch === '{') depth++;
                else if (ch === '}') {
                    depth--;
                    if (depth === 0) {
                        var candidate = t.slice(start, i + 1);
                        try { JSON.parse(candidate); return candidate; } catch (e) { break; }
                    }
                }
            }
            start = t.indexOf('{', start + 1);
        }
        return '';
    }

    function withTimeout(promise, ms, onTimeout) {
        var timer = null;
        var guard = new Promise(function (resolve, reject) {
            timer = setTimeout(function () {
                if (onTimeout) { try { onTimeout(); } catch (e) { } }
                var err = new Error('请求超过 ' + Math.round(ms / 1000) + ' 秒未完成，已中止。建议：确认 API 地址支持流式，或调大超时。');
                err.code = 'TIMEOUT';
                reject(err);
            }, ms);
        });
        return Promise.race([promise, guard]).then(function (v) {
            clearTimeout(timer); return v;
        }, function (e) {
            clearTimeout(timer); throw e;
        });
    }

    /* 独立 API 调用（编译主航道，真流式） */
    function callStandaloneApi(systemPrompt, userPrompt, onProgress) {
        var s = settings();
        var api = s.api;
        if (!trim(api.url)) return Promise.reject(new Error('还没有填写 API 地址。请到「连接」一节配置。'));
        if (!trim(api.model)) return Promise.reject(new Error('还没有填写模型名。请到「连接」一节配置。'));
        var controller = typeof AbortController === 'function' ? new AbortController() : null;
        var request = fetch(normalizeApiUrl(api.url), {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + (api.key || '')
            },
            body: JSON.stringify({
                model: api.model,
                messages: [
                    { role: 'system', content: String(systemPrompt || '') },
                    { role: 'user', content: String(userPrompt || '') }
                ],
                max_tokens: clamp(parseInt(api.max_tokens, 10) || 4000, 500, 32000),
                temperature: api.temperature == null ? 0.8 : Number(api.temperature),
                stream: true
            }),
            signal: controller ? controller.signal : undefined
        }).then(function (res) {
            if (!res.ok) {
                return res.text().then(function (raw) {
                    var hint = '';
                    if (res.status === 401 || res.status === 403) hint = 'API 密钥不对或没有权限。';
                    else if (res.status === 404) hint = 'API 地址不对（检查是否需要 /v1 结尾）。';
                    else if (res.status === 429) hint = '限流了，稍等一会儿再试。';
                    else if (res.status >= 500) hint = '服务端出错，可能是中转不稳定。';
                    throw new Error('HTTP ' + res.status + '：' + hint + '（' + String(raw).slice(0, 150) + '）');
                });
            }
            var contentType = res.headers && res.headers.get ? String(res.headers.get('content-type') || '') : '';
            if (/application\/json/i.test(contentType)) {
                return res.text().then(extractFromJsonText);
            }
            return readOpenAiStream(res, onProgress);
        });
        var timeoutMs = clamp((parseInt(s.api.timeout_s, 10) || 240), 30, 900) * 1000;
        return withTimeout(request, timeoutMs, function () { if (controller) controller.abort(); });
    }

    /* 酒馆当前连接（备航道，非流式） */
    function callTavernApi(systemPrompt, userPrompt) {
        var c = ctx();
        var whole = String(systemPrompt || '') + '\n\n' + String(userPrompt || '');
        if (typeof c.generateRaw === 'function') {
            return Promise.resolve().then(function () {
                return c.generateRaw({ prompt: whole, quietToLoud: false });
            }).then(function (out) {
                if (trim(out)) return String(out);
                throw new Error('酒馆连接返回为空。');
            }).catch(function (e) { throw dressTavernError(e); });
        }
        if (typeof c.generateQuietPrompt === 'function') {
            return Promise.resolve().then(function () {
                var p;
                try { p = c.generateQuietPrompt({ quietPrompt: whole }); }
                catch (e) { p = c.generateQuietPrompt(whole, false, true); }
                return p;
            }).then(function (out) {
                if (trim(out)) return String(out);
                throw new Error('酒馆连接返回为空。');
            }).catch(function (e) { throw dressTavernError(e); });
        }
        return Promise.reject(new Error('当前酒馆版本没有 raw / quiet 生成能力，请改用独立 API。'));
    }

    /* 把酒馆航道的裸报错翻译成人话与自救指引 */
    function dressTavernError(e) {
        var msg = trim(e && e.message || e) || '未知错误';
        var hint = '';
        if (/504|timeout|timed out/i.test(msg)) {
            hint = '——这是上游等太久被网关掐断（酒馆连接是非流式的通病）。解法：④连接里取消勾选"使用酒馆当前连接"，改填独立 API 走流式。DS 官网填 https://api.deepseek.com + deepseek-chat（max_tokens ≤ 8192）。';
        } else if (/Internal Server Error|500/i.test(msg)) {
            hint = '——上游服务出错。若反复出现，建议改用独立 API 流式编译（DS 官网：https://api.deepseek.com + deepseek-chat）。';
        }
        return new Error(msg + hint);
    }

    /* GET /v1/models → 模型 id 列表（填充 datalist，既能选也能手输） */
    function fetchModelList(url, key) {
        var base = trim(url).replace(/\/+$/, '');
        if (!base) return Promise.reject(new Error('先填 API 地址。'));
        var modelsUrl = /\/v\d+$/.test(base) ? base + '/models' : base + '/v1/models';
        var controller = typeof AbortController === 'function' ? new AbortController() : null;
        var req = fetch(modelsUrl, {
            method: 'GET',
            headers: { 'Authorization': 'Bearer ' + (key || '') },
            signal: controller ? controller.signal : undefined
        }).then(function (res) {
            if (!res.ok) return res.text().then(function (raw) { throw new Error('HTTP ' + res.status + '（' + String(raw).slice(0, 80) + '）'); });
            return res.json();
        }).then(function (data) {
            var rows = isArray(data && data.data) ? data.data : (isArray(data) ? data : []);
            var ids = [];
            for (var i = 0; i < rows.length; i++) {
                var id = trim(rows[i] && (rows[i].id || rows[i].model || rows[i].name));
                if (id) ids.push(id);
            }
            if (!ids.length) throw new Error('接口通了，但没有返回模型列表。');
            ids.sort();
            return ids;
        });
        return withTimeout(req, 20000, function () { if (controller) controller.abort(); });
    }

    function callCompilerApi(systemPrompt, userPrompt, onProgress) {
        var s = settings();
        if (s.use_tavern) return callTavernApi(systemPrompt, userPrompt);
        return callStandaloneApi(systemPrompt, userPrompt, onProgress);
    }

    /* ================================================================
     * 6. 编译器（唯一看得到完整秘密的环节）
     *  输出 Schema 极简：{"clues":["...","..."]}
     *  —— 字符串数组是各家模型最不容易写错的形状。
     *  分批生成 + 草稿续跑 + 本地安检。
     * ================================================================ */

    /* ================================================================
     * 提示词：可编辑的「怎么写」 + 代码接管的「怎么交货」
     *
     *  分开的理由：格式契约是解析器的依赖（JSON 形状 / 编号行 / HOLD），
     *  被误删会导致静默失败，而报错长得像模型抽风，极难查。
     *  所以契约永远由代码追加，不进编辑框。
     *
     *  占位符：{{力度}} {{禁词}}（编译 / God）、{{线索}}（注入模板）
     * ================================================================ */

    var BUILTIN_PROMPTS = {
        compiler: [
            '你是这个故事的 God。用户交给你一件被藏起来的事，你要为它编好一整套迹象——它们将来会被一条一条掉落进故事里。',
            '',
            '三条硬规矩（机制要求，不能违反）：',
            '1. 迹象绝不说破这件事本身。它们只让人起疑，不给答案。',
            '2. 每条都要能独立演出来。它们会被打乱顺序、被跳过、或者几十轮之后才用到——不能依赖"看过上一条"。',
            '3. 不要绑死在当前这一场。写成换个场合也成立的样子。',
            '',
            '以下是默认写法（用户可在提示词设置里改）：',
            '· 长在这个故事里：用角色卡与世界书里真实存在的人、地点、物件、职业、习惯、关系做载体。凭空冒出卡里没有的东西会很假。',
            '· 铺得开：这些迹象要覆盖这个角色一生可能走到的各种场合，不能全挤在一处。合理延伸是允许的——人在北京，那出差、旅游、回老家、机场、外地的医院都算合理；不合理的是与这个人八竿子打不着的东西。',
            '· 有脉络：整批要像同一件事在慢慢浮出水面，而不是一堆互不相干的怪事。它们指向同一件事的不同侧面，越往后越难解释得通。',
            '· 载体轮换：物品、口误、生理反应、改不掉的习惯、文件、旁人一次不自然的反应、梦、气味……同一种不要用第二次。',
            '· 每条先说清要让人察觉到什么，再给一个可以怎么带出来的例子——例子只是例子，演的时候可以换成当下更自然的做法。',
            '· 每条 40～90 字。不要编号，不要解释，不出现"线索""秘密""真相"这些出戏的词。',
            '· 引用文字（招牌、登记簿、门牌、只言片语）一律用中文引号「」，绝不使用英文双引号 " ——它会破坏输出格式。',
            '· 力度要求——{{力度}}',
            '{{禁词}}'
        ].join('\n'),

        compiler_case: [
            '你是这个案子的出题人。用户交给你一桩案子的底牌——谁做的、怎么做的、为什么、表面证据指向谁。',
            '你要编好一整套证据，它们将来会被一条一条掉落进故事里，让玩家自己拼出真相。',
            '',
            '三条硬规矩（机制要求，不能违反）：',
            '1. 证据绝不直接说出答案。它们只提供可核对的事实。',
            '2. 每条都要能独立演出来。它们会被打乱顺序、被跳过、或者几十轮之后才用到——不能依赖"看过上一条"。',
            '3. 不要绑死在当前这一场。写成换个场合也成立的样子。',
            '',
            '以下是默认写法（用户可在提示词设置里改）：',
            '· 细节必须可核对、而且要复现。这是案件与普通秘密最大的不同：同一个编号、同一个时间、同一个人名、同一处地名，要在两条以上的证据里出现，玩家才拼得起来。只出现一次的细节等于没给。',
            '· 证据之间要能互相印证或互相矛盾。矛盾比印证更有用——两条对不上的记录，比十条都指向同一处更让人想查。',
            '· 按底牌里写的"表面证据指向谁"，安排若干条真实存在、但会把人引向错误方向的证据。它们必须是真的东西，只是容易被误读——不能是凭空捏造的假货。',
            '· 长在这个故事里：用角色卡与世界书里真实存在的人、地点、物件、职业、关系做载体。',
            '· 铺得开：证据要散落在这个案子可能牵涉的各个场合，不要全挤在一处。',
            '· 排列的轴是"可查范围逐渐收窄"：最早几条只让人觉得这事不对劲，最后几条已经指向具体的人和时间。',
            '· 每条先说清这条证据是什么、上面有什么可核对的细节，再给一个可以怎么被发现的例子——例子只是例子。',
            '· 每条 40～90 字。不要编号，不要解释，不出现"线索""证据""真相"这些出戏的词。',
            '· 引用文字（单据、编号、登记簿、只言片语）一律用中文引号「」，绝不使用英文双引号 " ——它会破坏输出格式。',
            '· 力度要求——{{力度}}',
            '{{禁词}}'
        ].join('\n'),

        scheduler: [
            '你是小萤火。你的工作只有一件：看一眼现在这场戏发生在什么场合，从清单里挑一条此刻演得出来的，把它的序号说出来。',
            '',
            '你不需要理解剧情走向，不需要判断哪条更重要，也不需要改写任何文字。',
            '判断标准只有一个：这一条放在此刻这个场合里，演得出来吗？',
            '',
            '例：现在在医院，那关于化验单的那条合适；关于老宅地下室那条此刻演不出来，就别挑它。',
            '同一个场合也要看细：在医院因为胃病，那孕检报告那条同样不合适。',
            '若没有一条特别贴，挑一条最不违和的即可——不合时宜的最多变成背景，不会出错。'
        ].join('\n'),

        god: [
            '你是一个角色扮演故事的隐藏叙事监督者。你知晓完整秘密，演员不知晓。',
            '你的职责：阅读近期剧情，判断此刻是否适合向"扮演角色的演员"递一条舞台指示，让剧情朝真相自然靠近一步。',
            '',
            '裁决要点：',
            '1. 若此刻剧情正紧、气氛不宜、或玩家正专注于别的事——判为暂缓。',
            '2. 若适合递光——写一条 40～90 字的舞台指示：先说清要让人察觉到什么，再给一个当下场景里自然的带出方式。',
            '2b. 换着载体来：物品、口误、生理反应、习惯、文件、旁人的反应、梦、气味——别老用同一种。',
            '3. 指示绝不能说破秘密本身，不出现"线索""秘密""真相"这类出戏的词。',
            '4. 力度要求——{{力度}}',
            '{{禁词}}'
        ].join('\n'),

        inject: [
            '【本回合场景中已存在】',
            '{{线索}}',
            '',
            '它就在那里。用当下场景里自然的方式让它出现——上面若举了例子而此刻不合适，换一种做法。',
            '不要为了它把场景拉回别处；此刻若确实用不上，它就只是背景。不要提及这段文字本身。'
        ].join('\n'),

        /* 第二幕 · 切星：大纲 → 幕 */
        splitter: [
            '你是一位坐在幕外的编剧。玩家写了一段她想玩的故事脉络，你把它切成几幕。演员每次只会拿到一幕，看不见前后，所以每幕必须自己站得住。',
            '',
            '每幕三样东西：',
            '1. 演什么：这一段发生什么、人物处在什么状态、想要什么戏。写给演员看，口吻是舞台提示，不是剧情梗概。',
            '2. 到位：演到什么程度算这一段演完了。一句话。',
            '3. 不准：这一段里绝对不能发生的事。每幕至少两条，这是拦住演员抢跑的唯一一道闸。',
            '   写法有一条铁律：**只写行为，不写事实**。因为这一栏会原样给演员看，你在里面提到的任何事实，等于当场告诉了它。',
            '   反例（绝对不要）：「不准男主发现孩子是他的」——这句话本身就把孩子是他的这件事说了。',
            '   正例：「这一段两人不能把话说破」「不准任何一方先低头」「不准出现和解」「这一段不能离开这座城」。',
            '   一律写成动作边界：谁不能做什么、什么不能发生、话不能说到哪一步。绝不出现具体的身世、关系、来历、物件的真相。',
            '',
            '伏笔不单独给演员。后面要用的东西，折成当前这幕里一两个不动声色的小动作写进「演什么」——演员照做，自己不知道那是伏笔。',
            '切段依据是戏的阶段，不是时间平均分。上一幕的「到位」就是下一幕的起点，过渡要自然。',
            '引用文字一律用中文引号「」，绝不使用英文双引号 " ——它会破坏输出格式。'
        ].join('\n'),

        /* 帷幕沙漏 · 习性单：底牌 → 她怎么活着 */
        habits: [
            '下面是一个角色不能说破的底牌。你要写的不是底牌，是这个人平时怎么活着——让一个不知道底牌的演员，照着演也能演对。',
            '',
            '三栏，每栏 3～5 条，每条一句短话，不解释原因：',
            '· 说话方式：用词、句式、会不会用成语反话、接不接得住客套',
            '· 说话语气：平还是起伏、高兴生气时的幅度、习惯性的停顿',
            '· 身上的习惯：对温度/气味/声音/食物/光的反应、睡姿、小动作、下意识回避的东西',
            '',
            '铁律：每一条只写「怎么样」，绝不写「为什么」。不能出现底牌里的任何名词、身份、来历。读完这张单子的人，应该觉得这个人有点怪，但说不出哪里怪。',
            '引用文字一律用中文引号「」，绝不使用英文双引号 "。'
        ].join('\n')
    };

    /* 习性单审查员：写死，不进编辑区——它是安检的一部分，不是腔调 */
    var HABITS_AUDIT_PROMPT = '下面是一张习性单和它背后的底牌。逐条检查：哪一条写了原因、或出现了能反推底牌的词？只输出要删掉的条目编号。没有就输出 {"drop":[]}。';
    var HABITS_BLANK_LINE = '这个人身上有些地方她自己也说不清，遇到的时候顺着演就好，不要往合理了圆。';
    var HABITS_OVERLAP_WINDOW = 8;   // 习性单会进角色栏，暴露面 100%，比线索的 12 字更严

    /* 代码永远追加的格式契约——解析器依赖它们，不开放编辑 */
    var PROMPT_CONTRACT = {
        compiler: [
            '',
            '输出格式：只输出一个 JSON 对象，形如 {"clues":["第一条","第二条"]}。',
            '不要输出任何其他文字、解释或 Markdown 代码块标记。'
        ].join('\n'),
        compiler_case: [
            '',
            '输出格式：只输出一个 JSON 对象，形如 {"clues":["第一条","第二条"]}。',
            '不要输出任何其他文字、解释或 Markdown 代码块标记。'
        ].join('\n'),
        scheduler: '只输出一个数字，就是你选中那条的序号。不要输出任何其他文字。',
        god: [
            '',
            '裁决格式：若判为暂缓，第一行只输出 HOLD，不输出其他任何字；否则直接输出指示文本本身。',
            '不要解释，不要 Markdown，不使用酒馆宏。'
        ].join('\n'),
        inject: '',
        splitter: [
            '',
            '只输出一个 JSON 对象：{"acts":[{"name":"","play":"","done":"","forbid":""}]}。',
            '幕数 3～12（若用户指定了幕数以用户为准）。不要任何前言后记，不要 Markdown 代码块标记。'
        ].join('\n'),
        habits: [
            '',
            '只输出一个 JSON 对象：{"speech":["..."],"tone":["..."],"habits":["..."]}。',
            '不要任何前言后记，不要 Markdown 代码块标记。'
        ].join('\n')
    };

    var PROMPT_SLOTS = ['compiler', 'compiler_case', 'scheduler', 'god', 'inject', 'splitter', 'habits'];

    /* 抽屉里四格的元信息：标题、可用占位符、代码接管了什么 */
    var PROMPT_SLOT_META = [
        { key: 'compiler',  title: '编译提示词 · 藏一个秘密',
          vars: '{{力度}}　{{禁词}}',
          owned: '输出 {"clues":[...]} 的格式要求由代码追加，不用写。玩法选「藏一个秘密」时用这格。',
          rows: 9 },
        { key: 'compiler_case', title: '编译提示词 · 查一桩案子',
          vars: '{{力度}}　{{禁词}}',
          owned: '同上。玩法选「查一桩案子」时用这格——它要求细节复现、证据互证，与上一格的「载体不重复」正好相反，所以必须分开。',
          rows: 9 },
        { key: 'scheduler', title: '小萤火提示词（选牌 · 只对场合）',
          vars: '（无）',
          owned: '「只输出一个数字」的规则由代码追加。它只对场合、回一个序号，不理解剧情。',
          rows: 4 },
        { key: 'god',       title: 'God 提示词',
          vars: '{{力度}}　{{禁词}}',
          owned: '「暂缓输出 HOLD」的裁决格式由代码追加。',
          rows: 8 },
        { key: 'inject',    title: '注入模板（唯一进聊天模型的内容）',
          vars: '{{线索}}　必填',
          owned: '这一格没有代码追加，你写什么就注入什么。',
          rows: 4 },
        { key: 'splitter',  title: '切星提示词（第二幕 · 大纲→幕）',
          vars: '（无）',
          owned: '输出 {"acts":[{name,play,done,forbid}]} 的格式与幕数范围由代码追加。',
          rows: 8 },
        { key: 'habits',    title: '习性单提示词（帷幕沙漏 · 底牌→习性）',
          vars: '（无）',
          owned: '输出 {speech,tone,habits} 的格式由代码追加；审查员与留白句写死在代码里。',
          rows: 8 }
    ];


    var INTENSITY_TEXT = {
        gentle: '轻柔：只投气味、光线、旧物、迟疑的语气这类环境迹象；绝不解释含义，让玩家自己起疑。',
        standard: '标准：具体可感的迹象——一件反常的小物、一句欲言又止的话、一处对不上的细节；可以引起注意，但不给出解释。',
        clear: '清晰：明确可追查的证据或直白的反常行为；玩家能据此提出具体疑问，但线索本身仍不说破真相。'
    };

    /* ---- 提示词预设：查找 / 解析 / 变量替换 ---- */

    function presetList() { return settings().prompt_presets.list; }

    function findPreset(id) {
        if (!id || id === 'builtin') return null;
        var list = presetList();
        for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
        return null;
    }

    /* 本次调用该用哪套：故事锁定优先，其次全局选中，都找不到就回内置。
     * 「找不到就回内置」很关键——用户删掉了某个故事正在用的预设时，
     * 故事不会因此跑不动，只是换回默认腔调。 */
    function activePresetFor(st) {
        var pinned = st && st.config && st.config.prompt_preset;
        return findPreset(pinned) || findPreset(settings().prompt_presets.active) || null;
    }

    function promptText(slot, st) {
        var preset = activePresetFor(st);
        var body = preset && typeof preset[slot] === 'string' && trim(preset[slot])
            ? preset[slot] : BUILTIN_PROMPTS[slot];
        return body;
    }

    /* 占位符替换。{{禁词}} 在没有禁词时展开为空串，
     * 随后把连续空行收成一个，免得留下突兀的空档。 */
    function fillPromptVars(text, st, extra) {
        var out = String(text || '');
        var intensity = INTENSITY_TEXT[st && st.config && st.config.intensity] || INTENSITY_TEXT.standard;
        var banned = (st && st.banned_words && st.banned_words.length)
            ? '禁词：以下词语绝对禁止出现——' + st.banned_words.join('、') : '';
        out = out.replace(/\{\{力度\}\}/g, intensity).replace(/\{\{禁词\}\}/g, banned);
        if (extra) {
            for (var k in extra) {
                out = out.split('{{' + k + '}}').join(extra[k]);
            }
        }
        return out.replace(/\n{3,}/g, '\n\n').replace(/[ \t]+$/gm, '');
    }

    /* 最终提示词 = 可编辑正文（变量已替换） + 代码接管的格式契约 */
    function buildPrompt(slot, st, extra) {
        var body = fillPromptVars(promptText(slot, st), st, extra);
        var contract = PROMPT_CONTRACT[slot] || '';
        return contract ? (trim(body) + '\n' + contract) : body;
    }

    function compilerSystemPrompt(st) {
        // 两套的要求是直接打架的：秘密要「载体不重复」，案件要「细节要复现」。
        // 一套凑不出来，所以按玩法分槽。
        return buildPrompt(st.config.kind === 'case' ? 'compiler_case' : 'compiler', st);
    }

    function compilerUserPrompt(st, materials, batchCount, existingClues, appendCtx) {
        var parts = [];
        parts.push('【完整秘密（绝密，仅你可见）】\n' + st.hidden_secret);
        if (materials.card) parts.push('【角色与开场设定（演员可见的公开信息）】\n' + materials.card);
        if (materials.world) parts.push('【世界环境素材（埋线索的土壤）】\n' + materials.world);
        if (materials.story) parts.push('【已有剧情（最近进展）】\n' + materials.story
            + '\n\n这段正文只用于两件事：① 了解世界、人物与已经发生的事实，别写出矛盾；② 知道玩家已经注意到了什么，别重复。'
            + '\n**不要据此锁定场景**——迹象会在之后几十上百轮里陆续用到，那时多半早已不在此处。绑死在当前这一场的迹象，到时候演不出来，或者会把故事硬拽回来。');
        // 追加模式：池子里已有的线索按「已送出 / 还在排队」分开报——
        // 已送出的玩家见过（绝不能重复），排队的玩家没见过（不能撞车），
        // 两者对模型的意义不同，混成一坨它就分不清了。
        if (appendCtx) {
            if (appendCtx.sent.length) {
                parts.push('【玩家已经见过的线索（这些迹象已经出现在故事里，绝不可重复）】\n' +
                    appendCtx.sent.map(function (c, i) { return (i + 1) + '. ' + c; }).join('\n'));
            }
            if (appendCtx.pending.length) {
                parts.push('【已备好但尚未投放的线索（玩家还没见过，新写的不要与它们撞意象、撞载体）】\n' +
                    appendCtx.pending.map(function (c, i) { return (i + 1) + '. ' + c; }).join('\n'));
            }
            parts.push('【本次追加的额外要求（用户亲写，优先于一切默认倾向）】\n' +
                (appendCtx.note || '（用户没有特别要求：请补写与现有线索同一层深度、可独立成立的新迹象，不要比现有最深的一条更接近真相。）'));
        }
        if (existingClues.length) {
            parts.push('【本次已写好的部分（同样不要重复）】\n' +
                existingClues.map(function (c, i) { return (i + 1) + '. ' + c; }).join('\n'));
            parts.push('本批请续写第 ' + (existingClues.length + 1) + ' 条起的 ' + batchCount + ' 条'
                + (appendCtx ? '。' : '，深度衔接前序、继续递进。'));
        } else {
            parts.push(appendCtx
                ? ('本批请写 ' + batchCount + ' 条新的。')
                : ('本批请生成最开始的 ' + batchCount + ' 条，从最浅的迹象起步。'));
        }
        parts.push(appendCtx
            ? ('本次共追加 ' + appendCtx.total + ' 条，本批只写 ' + batchCount + ' 条。输出 {"clues":[...]}。')
            : ('总计划共 ' + st.config.clue_count + ' 条，本批只写 ' + batchCount + ' 条。输出 {"clues":[...]}。'));
        return parts.join('\n\n');
    }

    /* 宽松兜底：模型在线索正文里写了未转义英文引号时，标准 JSON.parse 必炸。
     * 针对 {"clues":[...]} 这一种固定形状手工切分：
     * 取 clues 后的数组体，按 「引号,引号」 分隔模式切条，条内残留引号原样保留。 */
    function looseParseClues(raw) {
        var m = String(raw).match(/"clues"\s*:\s*\[/);
        if (!m) return null;
        var start = m.index + m[0].length;
        var end = String(raw).lastIndexOf(']');
        if (end <= start) return null;
        var body = String(raw).slice(start, end);
        var parts = body.split(/"\s*,\s*"/);
        var out = [];
        for (var i = 0; i < parts.length; i++) {
            var t = trim(parts[i]).replace(/^"+/, '').replace(/"+\s*$/, '');
            t = trim(t);
            if (t) out.push(t);
        }
        return out.length ? out : null;
    }

    function parseCluesJson(rawText) {
        var raw = trim(rawText).replace(/^```(?:json)?/i, '').replace(/```$/, '');
        var jsonText = recoverJsonObject(raw) || raw;
        var data;
        try { data = JSON.parse(jsonText); }
        catch (e) {
            var rescued = looseParseClues(raw);
            if (rescued) return rescued;
            throw new Error('模型输出无法解析为 JSON（前 100 字）：' + raw.slice(0, 100));
        }
        var list = data && data.clues;
        if (!isArray(list)) throw new Error('模型输出里没有 clues 数组。');
        var out = [];
        for (var i = 0; i < list.length; i++) {
            var t = trim(typeof list[i] === 'string' ? list[i] : (list[i] && list[i].text));
            if (t) out.push(t);
        }
        if (!out.length) throw new Error('模型输出的线索为空。');
        return out;
    }

    /* 本地安检：返回 { pass: [], rejected: [{text, reason}] } */
    function vetClues(candidates, st) {
        var pass = [];
        var rejected = [];
        for (var i = 0; i < candidates.length; i++) {
            var text = candidates[i];
            var banned = containsBanned(text, st.banned_words);
            if (banned) { rejected.push({ text: text, reason: '包含禁词「' + banned + '」' }); continue; }
            if (hasResidualMacro(text)) { rejected.push({ text: text, reason: '包含酒馆宏 {{...}}，有二次展开风险' }); continue; }
            if (overlapsSecret(text, st.hidden_secret)) { rejected.push({ text: text, reason: '与秘密原文有 ' + SECRET_OVERLAP_WINDOW + ' 字以上连续重合' }); continue; }
            if (text.length > 300) { rejected.push({ text: text, reason: '超长（' + text.length + ' 字），不像一条线索' }); continue; }
            pass.push(text);
        }
        return { pass: pass, rejected: rejected };
    }

    var compileState = { running: false, cancel: false };

    function compileStory(opts) {
        var st = story();
        var isAppend = !!(opts && opts.append);
        if (!st) return Promise.reject(new Error('请先打开一个聊天。'));
        if (compileState.running) return Promise.reject(new Error('编译正在进行中。'));
        if (!trim(st.hidden_secret)) return Promise.reject(new Error('隐藏脉络还是空的——先把秘密写给小萤火。'));
        if (st.config.run_mode === 'supervise') return Promise.reject(new Error('AI 监督模式不需要编译——写好秘密直接点亮即可。'));
        // 追加允许在点亮状态下进行——正玩着想补货是常态，不该逼人先熄灭
        if (!isAppend && st.status === 'lit') return Promise.reject(new Error('故事正在点亮中。请先熄灭，再重新编译。'));

        // 追加：只生成 addCount 条，现有的一条不动
        var addCount = clamp(parseInt($('#lcl2_append_n').val(), 10) || 10, 1, 200);
        var appendNote = trim($('#lcl2_append_note').val() || '');
        var target = isAppend ? addCount : clamp(parseInt(st.config.clue_count, 10) || 10, 1, 200);
        if (!isAppend) st.config.clue_count = target;
        var needRounds = target * clamp(parseInt(st.config.interval, 10) || 10, 1, 999);
        var planRounds = clamp(parseInt(st.config.total_rounds, 10) || 100, 1, 9999);
        if (!isAppend && needRounds > planRounds * 1.2) {
            log('提示：' + target + ' 条 × 每 ' + st.config.interval + ' 轮一条 ≈ ' + needRounds + ' 轮才能送完，超出预计 ' + planRounds + ' 轮。想在预计轮数内送完可减少条数或缩短间隔（不强制，按你的节奏来）。');
        }
        var batchSize = clamp(parseInt(settings().batch_size, 10) || DEFAULT_BATCH, 1, 20);

        // 续跑：草稿里已有的定稿线索直接继承
        var draftKey = isAppend ? 'draft_append' : 'draft';
        var doneClues = [];
        if (st[draftKey] && isArray(st[draftKey].clues) && st[draftKey].secret_hash === simpleHash(st.hidden_secret)) {
            doneClues = st[draftKey].clues.slice();
            log('发现上次未完成的' + (isAppend ? '追加' : '') + '草稿，从第 ' + (doneClues.length + 1) + ' 条继续。');
        }

        compileState.running = true;
        compileState.cancel = false;
        setCompileUi(true, '准备取材……');

        var materials = { card: '', world: '', story: '', missed: [] };
        var homeToken = chatToken();   // 编译全程锁定这个聊天

        function assertHome() {
            if (chatChangedSince(homeToken)) throw new Error('编译期间切换了聊天，本次作废（已保住的草稿留在原聊天里，回去再点编译即可续跑）。');
        }

        return Promise.resolve().then(function () {
            assertHome();
            materials.card = characterCardText(4000);
            var recent = recentStoryText(40, 8000);
            materials.story = recent.text;
            materials.story_count = recent.count;
            return readCharacterWorldBooks(6000);
        }).then(function (wb) {
            assertHome();
            materials.world = wb.text;
            materials.missed = wb.missed;
            var picked = ['角色卡'];
            if (wb.sources.length) picked = picked.concat(wb.sources);
            picked.push(materials.story_count > 0 ? ('最近正文 ' + materials.story_count + ' 条') : '正文（空聊天，跳过）');
            log('取材完成：' + picked.join(' + '));
            if (wb.deduped && wb.deduped.length) log('已去重：' + wb.deduped.join('、') + ' 与已读内容相同，只保留一份。');
            for (var m = 0; m < wb.missed.length; m++) log('⚠ ' + wb.missed[m]);
            return runBatches();
        }).then(function () {
            assertHome();
            var fresh = doneClues.map(function (text) {
                return { id: uid('clue'), text: text, used: false, delivered_count: 0 };
            });
            if (isAppend) {
                // 追加：现有线索、进度、轮钟一律不动，新的接到池子末尾
                for (var a = 0; a < fresh.length; a++) st.clues.push(fresh[a]);
                st.draft_append = null;
                st.config.clue_count = st.clues.length;
                appendToOrder(st, fresh);          // 随机/分层序要把新牌也收进去
                saveStory();
                log('追加完成：新增 ' + fresh.length + ' 条，池子现在共 ' + st.clues.length + ' 条（已送出的和进度都没动）。');
                toast('已追加 ' + fresh.length + ' 条', 'success');
            } else {
                st.clues = fresh;
                st.draft = null;
                st.status = 'compiled';
                st.clock = blankStory().clock;
                saveStory();
                log('编译完成：' + st.clues.length + ' 条线索已备好，等待你预览确认。');
                toast('编译完成，' + st.clues.length + ' 条线索已备好', 'success');
            }
            compileState.running = false;
            setCompileUi(false, '');
            renderPanel();
        }).catch(function (err) {
            compileState.running = false;
            setCompileUi(false, '');
            var msg = (err && err.message) || String(err);
            // 人已经不在原聊天了：只弹提示，绝不把日志写进别人的账本
            if (chatChangedSince(homeToken)) {
                toast('编译已中断：' + msg, 'error');
                renderPanel();
                throw err;
            }
            // 保草稿：已定稿部分不丢
            if (doneClues.length) {
                st[draftKey] = { clues: doneClues, secret_hash: simpleHash(st.hidden_secret) };
                saveStory();
                log((isAppend ? '追加' : '编译') + '中断，已保住 ' + doneClues.length + ' 条草稿。修好问题后再点一次即可续跑。');
            }
            log('✗ 编译失败：' + msg);
            toast('编译失败：' + msg, 'error');
            renderPanel();
            throw err;
        });

        function appendCtx() {
            if (!isAppend) return null;
            var sent = [], pending = [];
            for (var i = 0; i < st.clues.length; i++) {
                var c = st.clues[i];
                if (c.dropped) continue;                 // 弃掉的既没送出也不占位，不必报
                (c.used ? sent : pending).push(c.text);
            }
            return { sent: sent, pending: pending, note: appendNote, total: addCount };
        }

        function runBatches() {
            if (compileState.cancel) throw new Error('已手动停止。');
            assertHome();
            if (doneClues.length >= target) return Promise.resolve();
            var need = Math.min(batchSize, target - doneClues.length);
            var batchNo = Math.floor(doneClues.length / batchSize) + 1;
            setCompileUi(true, '正在生成第 ' + (doneClues.length + 1) + '～' + (doneClues.length + need) + ' 条（共 ' + target + ' 条）……');
            return callBatchWithRetry(need, 2).then(function (accepted) {
                assertHome();
                for (var i = 0; i < accepted.length && doneClues.length < target; i++) doneClues.push(accepted[i]);
                // 每批落草稿，随时断随时续
                st.draft = { clues: doneClues.slice(), secret_hash: simpleHash(st.hidden_secret) };
                saveStory();
                log('第 ' + batchNo + ' 批完成，累计 ' + doneClues.length + '/' + target + ' 条。');
                return runBatches();
            });
        }

        function callBatchWithRetry(need, retriesLeft) {
            return Promise.resolve().then(function () {
                return callCompilerApi(
                    compilerSystemPrompt(st),
                    compilerUserPrompt(st, materials, need, doneClues, appendCtx()),
                    function (chars) { setCompileUi(true, '模型书写中，已接收 ' + chars + ' 字……'); }
                );
            }).then(function (raw) {
                var candidates = parseCluesJson(raw);
                var vetted = vetClues(candidates, st);
                for (var r = 0; r < vetted.rejected.length; r++) {
                    log('安检拦下一条：' + vetted.rejected[r].reason);
                }
                if (!vetted.pass.length) throw new Error('本批线索全部被安检拦下。');
                return vetted.pass;
            }).catch(function (err) {
                if (retriesLeft > 0 && !compileState.cancel && !chatChangedSince(homeToken)) {
                    log('本批出错（' + (err && err.message || err) + '），重试一次……');
                    return callBatchWithRetry(need, retriesLeft - 1);
                }
                throw err;
            });
        }
    }

    function simpleHash(text) {
        var t = String(text || '');
        var h = 2166136261;
        for (var i = 0; i < t.length; i++) {
            h ^= t.charCodeAt(i);
            h = (h * 16777619) >>> 0;
        }
        return h.toString(36);
    }

    /* ================================================================
     * 6b. 🐾 习性单（帷幕沙漏 · 抢话悖论的解）
     *
     *  悖论：模型要替 user 演，不知道 user 是狐狸就 OOC；知道了三把就漏。
     *  解法：秘密拆两层。底牌（为什么）归沙漏管；习性单（她怎么活着）
     *  第一轮就给演员。行为是真相长出来的——演员不知道真相也能演出
     *  真相的影子，而那个「她自己也说不清」的怪，本身就是伏笔。
     *
     *  插件只管生成：三栏 + 留白 → 玩家复制粘进自己的角色栏。不注入。
     *  安检三层：模型审查员（删带原因的条）→ 本地 8 字滑窗 → 禁词表。
     * ================================================================ */

    var habitsState = { running: false };

    function blankHabits() { return { speech: [], tone: [], habits: [], at: null }; }

    function habitsOf(st) {
        if (!st) return null;
        if (!isObject(st.habits)) st.habits = blankHabits();
        var h = st.habits;
        if (!isArray(h.speech)) h.speech = [];
        if (!isArray(h.tone)) h.tone = [];
        if (!isArray(h.habits)) h.habits = [];
        return h;
    }

    function habitsEmpty(h) { return !h || !(h.speech.length + h.tone.length + h.habits.length); }

    function parseHabitsJson(rawText) {
        var raw = trim(rawText).replace(/^```(?:json)?/i, '').replace(/```$/, '');
        var jsonText = recoverJsonObject(raw) || raw;
        var data;
        try { data = JSON.parse(jsonText); }
        catch (e) { throw new Error('模型输出无法解析为 JSON（前 80 字）：' + raw.slice(0, 80)); }
        function arr(v) {
            if (!isArray(v)) return [];
            var out = [];
            for (var i = 0; i < v.length; i++) { var t = trim(v[i]); if (t) out.push(t.slice(0, 80)); }
            return out.slice(0, 6);
        }
        var h = { speech: arr(data.speech), tone: arr(data.tone), habits: arr(data.habits) };
        if (habitsEmpty(h)) throw new Error('模型没有写出任何条目（前 80 字）：' + raw.slice(0, 80));
        return h;
    }

    /* 本地安检：禁词 / 宏 / 与底牌 ≥8 字连续重合 */
    function vetHabitLine(text, st) {
        if (containsBanned(text, st.banned_words)) return '含禁词';
        if (hasResidualMacro(text)) return '含宏';
        var secret = String(st.hidden_secret || '').replace(/\s+/g, '');
        var flat = String(text).replace(/\s+/g, '');
        if (secret.length >= HABITS_OVERLAP_WINDOW) {
            for (var i = 0; i + HABITS_OVERLAP_WINDOW <= secret.length; i++) {
                if (flat.indexOf(secret.substr(i, HABITS_OVERLAP_WINDOW)) >= 0) return '与底牌 ' + HABITS_OVERLAP_WINDOW + ' 字连续重合';
            }
        }
        return null;
    }

    function habitsNumbered(h) {
        var lines = [];
        var cols = [['speech', '说话方式'], ['tone', '说话语气'], ['habits', '身上的习惯']];
        for (var c = 0; c < cols.length; c++) {
            var key = cols[c][0];
            for (var i = 0; i < h[key].length; i++) lines.push(key + '-' + (i + 1) + '：' + h[key][i]);
        }
        return lines.join('\n');
    }

    function generateHabits() {
        var st = readFormIntoStory();
        if (!st) return Promise.reject(new Error('请先打开一个聊天。'));
        if (habitsState.running) return Promise.reject(new Error('正在生成，稍等。'));
        if (!trim(st.hidden_secret)) return Promise.reject(new Error('隐藏脉络还是空的——习性单是从底牌长出来的。'));
        habitsState.running = true;
        setHabitsUi(true, '正在从底牌长习性……');
        var homeToken = chatToken();
        function assertHome() { if (chatChangedSince(homeToken)) throw new Error('生成期间切换了聊天，本次作废。'); }
        var draft = null;
        return Promise.resolve().then(function () {
            assertHome();
            var card = characterCardText(2500);
            var user = ['【底牌（绝密，仅你可见）】\n' + st.hidden_secret];
            if (card) user.push('【角色与开场设定】\n' + card);
            user.push('输出 {"speech":[...],"tone":[...],"habits":[...]}。');
            return callCompilerApi(buildPrompt('habits', st), user.join('\n\n'),
                function (chars) { setHabitsUi(true, '模型书写中，已接收 ' + chars + ' 字……'); });
        }).then(function (raw) {
            assertHome();
            draft = parseHabitsJson(raw);
            setHabitsUi(true, '审查员过一遍……');
            // 第二步：同一连接当审查员。审查失败不致命——本地滑窗还在
            return callCompilerApi(
                HABITS_AUDIT_PROMPT + '\n只输出 JSON：{"drop":["speech-2","habits-1"]}。不要任何其他文字。',
                '【底牌】\n' + st.hidden_secret + '\n\n【习性单】\n' + habitsNumbered(draft),
                null
            ).then(function (auditRaw) {
                var drop = [];
                try {
                    var j = JSON.parse(recoverJsonObject(trim(auditRaw).replace(/^```(?:json)?/i, '').replace(/```$/, '')) || '{}');
                    if (isArray(j.drop)) drop = j.drop;
                } catch (e) { log('习性单审查员回话看不懂（前 60 字）：' + String(auditRaw).slice(0, 60) + '——跳过，只走本地安检。'); }
                return drop;
            }).catch(function (err) {
                log('习性单审查员没回应（' + (err && err.message || err) + '）——跳过，只走本地安检。');
                return [];
            });
        }).then(function (drop) {
            assertHome();
            var dropped = 0, localDropped = 0;
            var cols = ['speech', 'tone', 'habits'];
            for (var c = 0; c < cols.length; c++) {
                var key = cols[c];
                var kept = [];
                for (var i = 0; i < draft[key].length; i++) {
                    var tag = key + '-' + (i + 1);
                    var hit = false;
                    for (var d = 0; d < drop.length; d++) if (String(drop[d]).indexOf(tag) === 0) { hit = true; break; }
                    if (hit) { dropped++; continue; }
                    var why = vetHabitLine(draft[key][i], st);
                    if (why) { localDropped++; continue; }
                    kept.push(draft[key][i]);
                }
                draft[key] = kept;
            }
            if (habitsEmpty(draft)) throw new Error('所有条目都被安检拦下了——底牌写得太具体或禁词太宽，试试重抽。');
            var empties = [];
            if (!draft.speech.length) empties.push('说话方式');
            if (!draft.tone.length) empties.push('说话语气');
            if (!draft.habits.length) empties.push('身上的习惯');
            draft.at = nowIso();
            st.habits = draft;
            saveStory();
            var note = '习性单已生成：' + (draft.speech.length + draft.tone.length + draft.habits.length) + ' 条';
            if (dropped) note += '，审查员删了 ' + dropped + ' 条带原因的';
            if (localDropped) note += '，本地安检拦下 ' + localDropped + ' 条';
            note += '。';
            if (empties.length) note += '「' + empties.join('」「') + '」被审查清空，建议重抽。';
            log(note);
            toast('习性单已生成', 'success');
            habitsState.running = false;
            setHabitsUi(false, '');
            renderHabits(true);
        }).catch(function (err) {
            habitsState.running = false;
            setHabitsUi(false, '');
            var msg = (err && err.message) || String(err);
            if (!chatChangedSince(homeToken)) log('✗ 习性单生成失败：' + msg);
            toast('习性单生成失败：' + msg, 'error');
            renderHabits(true);
            throw err;
        });
    }

    function setHabitsUi(running, text) {
        $('#lcl2_habits_gen, #lcl2_habits_retry').prop('disabled', running);
        $('#lcl2_habits_state').text(text || '');
    }

    /* 复制格式：纯文本，玩家直接粘进 persona / 角色栏 */
    function habitsClipboardText(h) {
        function block(title, arr) {
            if (!arr.length) return '';
            var out = '【' + title + '】\n';
            for (var i = 0; i < arr.length; i++) out += '- ' + arr[i] + '\n';
            return out;
        }
        return (block('说话方式', h.speech) + block('说话语气', h.tone) + block('身上的习惯', h.habits) + HABITS_BLANK_LINE).replace(/\n{3,}/g, '\n\n');
    }

    function copyText(text) {
        return new Promise(function (resolve, reject) {
            try {
                if (navigator.clipboard && navigator.clipboard.writeText) {
                    navigator.clipboard.writeText(text).then(resolve, function () { fallback(); });
                } else fallback();
            } catch (e) { fallback(); }
            function fallback() {
                try {
                    var ta = document.createElement('textarea');
                    ta.value = text;
                    ta.setAttribute('readonly', '');
                    ta.style.position = 'fixed'; ta.style.top = '-1000px';
                    document.body.appendChild(ta);
                    ta.select(); ta.setSelectionRange(0, text.length);
                    var ok = document.execCommand('copy');
                    document.body.removeChild(ta);
                    ok ? resolve() : reject(new Error('复制失败'));
                } catch (e2) { reject(e2); }
            }
        });
    }

    var habitsDirty = false;

    function renderHabits(force) {
        var $host = $('#lcl2_habits');
        if (!$host.length) return;
        var st = story();
        var h = habitsOf(st);
        $('#lcl2_habits_gen').prop('disabled', habitsState.running || !st);
        if (!st || habitsEmpty(h)) {
            $('#lcl2_habits_card').hide();
            return;
        }
        $('#lcl2_habits_card').show();
        if (!force && $host.find('textarea:focus').length) { habitsDirty = true; return; }
        habitsDirty = false;
        var cols = [['speech', '说话方式'], ['tone', '说话语气'], ['habits', '身上的习惯']];
        var html = '';
        for (var c = 0; c < cols.length; c++) {
            var key = cols[c][0];
            html += '<label class="lcl2-label">' + cols[c][1] + (h[key].length ? '' : '<small class="lcl2-dim">（被审查清空，建议重抽）</small>') + '</label>'
                + '<textarea class="lcl2-habits-col text_pole" data-col="' + key + '" rows="' + Math.max(2, h[key].length) + '" placeholder="一行一条">' + esc(h[key].join('\n')) + '</textarea>';
        }
        html += '<div class="lcl2-dim lcl2-habits-blank">' + esc(HABITS_BLANK_LINE) + '<br><small>（这句写死附在末尾——给演员的许可：碰到没覆盖的地方敢往怪了演，不往合理了圆。）</small></div>';
        $host.html(html);
    }

    /* ================================================================
     * 7. 运行时（纯本地，零 API）
     *  消费模型：一条线索占据一个完整"回复位"（含全部重抽）。
     *  MESSAGE_SENT   → 清算上一位 → 轮钟++ → 到点则下一条上台并注入
     *  MESSAGE_RECEIVED → 台上线索送达计数++（重抽自然复用，不重复消费）
     *  CHAT_CHANGED   → 现场还原
     * ================================================================ */

    function findClue(st, id) {
        for (var i = 0; i < st.clues.length; i++) if (st.clues[i].id === id) return st.clues[i];
        return null;
    }

    function activeClue(st) {
        return st.clock.active_id ? findClue(st, st.clock.active_id) : null;
    }

    function usedCount(st) {   // 语义：真正送出的条数（废弃不算送出）
        var n = 0;
        for (var i = 0; i < st.clues.length; i++) if (st.clues[i].used && !st.clues[i].dropped) n++;
        return n;
    }

    function unusedClues(st) {
        var out = [];
        for (var i = 0; i < st.clues.length; i++) if (!st.clues[i].used) out.push(st.clues[i]);
        return out;
    }

    /* 本轮该投哪条：
     * 均匀 → 未用池第一条（保持编译时的浅→深顺序）；
     * 智能 → 小萤火预选的那条（若仍有效），否则确定性回退到既定顺序的第一条。 */
    /* ---- 发牌顺序 ----
     * 顺序：编译时就是浅→深，直接按池子顺序发。
     * 分层洗牌：切成前/中/后三段，段内随机、段间保序——
     *           有意外感，又保住「越来越接近真相」的推进。
     * 纯随机：彻底盲撒。会打掉浅→深的设计，配「同层线索」的编译提示词预设才好用。
     */

    function shuffled(arr) {
        var a = arr.slice();
        for (var i = a.length - 1; i > 0; i--) {
            var j = Math.floor(Math.random() * (i + 1));
            var t = a[i]; a[i] = a[j]; a[j] = t;
        }
        return a;
    }

    function orderIdsFor(mode, clues) {
        var ids = clues.map(function (c) { return c.id; });
        if (mode === 'random') return shuffled(ids);
        if (mode === 'tiered') {
            var n = ids.length;
            if (n < 3) return shuffled(ids);
            var a = Math.ceil(n / 3), b = Math.ceil((n * 2) / 3);
            return shuffled(ids.slice(0, a))
                .concat(shuffled(ids.slice(a, b)))
                .concat(shuffled(ids.slice(b)));
        }
        return ids;
    }

    /* 点亮时定序。已经定过就不再动——中途改顺序模式不影响本局，
     * 否则玩到一半换模式会让剩下的牌整个重排，体感像出 bug。 */
    function buildOrder(st) {
        var mode = st.config.order_mode || 'sequential';
        st.clock.order = orderIdsFor(mode, st.clues);
        return mode;
    }

    /* 追加进来的新牌要收进已有的序里：顺序档直接接尾，
     * 随机/分层档在这批新牌内部洗一次再接尾——不重排老牌。 */
    function appendToOrder(st, freshClues) {
        if (!isArray(st.clock.order) || !st.clock.order.length) return;
        var mode = st.config.order_mode || 'sequential';
        var ids = freshClues.map(function (c) { return c.id; });
        st.clock.order = st.clock.order.concat(mode === 'sequential' ? ids : shuffled(ids));
    }

    /* 按序取第一张还没用过的。序里找不到（老账本 / 新追加没入序）就退回池子顺序。 */
    function firstByOrder(st, pool) {
        var order = st.clock.order;
        if (!isArray(order) || !order.length) return pool[0];
        for (var i = 0; i < order.length; i++) {
            for (var j = 0; j < pool.length; j++) {
                if (pool[j].id === order[i]) return pool[j];
            }
        }
        return pool[0];
    }

    function pickClueForRound(st) {
        var pool = unusedClues(st);
        if (!pool.length) return null;
        if (st.config.run_mode === 'smart') {
            var plan = st.clock.planned;
            if (plan && plan.for_round === st.clock.round) {
                var chosen = findClue(st, plan.clue_id);
                if (chosen && !chosen.used) return { clue: chosen, via: '小萤火选牌' };
            }
            var why = '顺序发牌';
            if (!plan) why = '调度未及完成，按既定顺序发牌';
            else if (plan.failed) why = '调度没成，按既定顺序发牌';
            return { clue: firstByOrder(st, pool), via: why };
        }
        return { clue: firstByOrder(st, pool), via: '' };
    }

    function injectText(clueText) {
        var st = story();
        var tpl = promptText('inject', st);
        // 模板里没有 {{线索}} 就等于空注入——保存时已拦，这里是最后一道保险
        if (tpl.indexOf('{{线索}}') < 0) {
            log('⚠ 注入模板里没有 {{线索}}，本条改用内置模板送出。');
            tpl = BUILTIN_PROMPTS.inject;
        }
        var text = fillPromptVars(tpl, st, { '线索': clueText });
        // 末道闸：替换之后仍有 {{...}} 说明模板里有写错的占位符，宁可空注入也不冒二次展开的险
        if (hasResidualMacro(text)) {
            log('⚠ 注入前发现残留宏，本条已拦下改为空注入。');
            text = '';
        }
        applyInjection(text);
    }

    function applyInjection(text) {
        var c = ctx();
        var depth = clamp(parseInt(settings().depth, 10) || 1, 0, 20);
        try { c.setExtensionPrompt(INJECT_KEY, text, 1, depth, false, 0); }
        catch (e) {
            try { c.setExtensionPrompt(INJECT_KEY, text, 1, depth); }
            catch (e2) { log('✗ 注入口调用失败：' + (e2 && e2.message || e2)); }
        }
    }

    function clearInjection() { applyInjection(''); }

    /* 玩家发出一条消息 */
    function onUserMessage() {
        var st = story();
        if (!st || st.status !== 'lit') return;

        // 1) 清算上一个回复位
        var current = activeClue(st);
        if (current) {
            if (current.delivered_count > 0) {
                current.used = true;
                st.clock.active_id = null;
                st.clock.cursor = usedCount(st);
                clearInjection();
                log('一条线索已完成使命，退场（累计已送 ' + st.clock.cursor + ' 条）。');
            } else {
                // 从未进入任何一次生成（玩家连发消息）——原地等待，不浪费
            }
        }

        // 2) 轮钟前进
        st.clock.round += 1;

        // 3) 到点且台上无人 → 上台（三档各走各的小内核）
        if (!st.clock.active_id && st.clock.round >= st.clock.next_due) {
            if (st.config.run_mode === 'supervise') {
                superviseDispatch(st);
            } else {
                var pool = unusedClues(st);
                if (pool.length) {
                    var picked = pickClueForRound(st);
                    var next = picked.clue;
                    st.clock.active_id = next.id;
                    st.clock.planned = null;   // 预选一经消费即作废
                    next.delivered_count = 0;
                    next.fired_round = st.clock.round;   // 复盘清单要按轮次列
                    injectText(next.text);
                    st.clock.last_fire = st.clock.round;
                    st.clock.next_due = st.clock.round + clamp(parseInt(st.config.interval, 10) || 10, 1, 999);
                    log('第 ' + st.clock.round + ' 轮：线索上台' + (picked.via ? '（' + picked.via + '）' : '') + '，将随下一次回复送出。');
                }
            }
        }

        // 4) 存货耗尽收尾（仅编译制模式；AI 监督没有"送完"概念，故事由 God 陪到最后）
        if (st.config.run_mode !== 'supervise' && !st.clock.active_id && !unusedClues(st).length && st.status !== 'finished') {
            st.status = 'finished';
            clearInjection();
            var dropped = 0;
            for (var di = 0; di < st.clues.length; di++) if (st.clues[di].dropped) dropped++;
            if (dropped) {
                log('线索池见底了：实际送出 ' + st.clock.cursor + ' 条，另有 ' + dropped + ' 条被剧情越过、安静退场。故事的真相，现在交给你们自己走完。');
                toast('小萤火的线索已用尽（送出 ' + st.clock.cursor + ' 条）', 'success');
            } else {
                log('所有线索都已送完。故事的真相，现在交给你们自己走完。');
                toast('小萤火的线索已全部送完', 'success');
            }
        }
        saveStory();
        renderPanel();
    }

    /* AI 监督：消费 God 在空档里给出的裁决 */
    function superviseDispatch(st) {
        var plan = st.clock.planned;
        st.clock.planned = null;
        if (plan && plan.for_round === st.clock.round && trim(plan.god_text)) {
            // God 设计的指示已过安检 → 入账本并上台（复用全部簿记）
            var clue = { id: uid('god'), text: trim(plan.god_text), used: false, delivered_count: 0, fired_round: st.clock.round };
            st.clues.push(clue);
            st.clock.active_id = clue.id;
            st.clock.hold_streak = 0;
            injectText(clue.text);
            st.clock.last_fire = st.clock.round;
            st.clock.next_due = st.clock.round + clamp(parseInt(st.config.interval, 10) || 10, 1, 999);
            log('第 ' + st.clock.round + ' 轮：God 递来一条现场设计的指示，将随下一次回复送出。');
        } else if (plan && plan.for_round === st.clock.round && plan.hold) {
            st.clock.hold_streak = (st.clock.hold_streak || 0) + 1;
            st.clock.next_due = st.clock.round + 1;   // 暂缓：下一轮再问
            log('第 ' + st.clock.round + ' 轮：God 判断此刻不宜递光，暂缓一轮。');
            if (st.clock.hold_streak >= 3) log('⚠ God 已连续暂缓 ' + st.clock.hold_streak + ' 轮。若嫌节奏慢，可检查秘密写法是否给了它可下手的素材，或调高线索力度。');
        } else {
            st.clock.next_due = st.clock.round + 1;   // 没来得及/失败：下一轮再试
            log('第 ' + st.clock.round + ' 轮：God 未及回应，本轮不投，下一轮再问。');
        }
    }

    /* AI 回复落地（含每一次重抽的落地） */
    function onAiMessage() {
        var st = story();
        if (!st || st.status !== 'lit') return;
        var current = activeClue(st);
        if (current) {
            current.delivered_count += 1;
            if (current.delivered_count === 1) {
                log('线索已随本次回复进入演出。（重抽会继续带着它，直到你再次发言）');
            }
        }
        saveStory();
        renderPanel();
        // 一轮流水线：智能调度在两轮之间的空档里后台选牌，
        // 注入仍在下一次玩家消息时同步发生——时序物理安全不变。
        maybePlanAhead(st);
    }

    /* ---- 智能调度：小萤火选牌（一轮流水线） ---- */

    var planFlight = null;   // 防重复起飞

    function maybePlanAhead(st) {
        if (st.status !== 'lit') return;
        var mode = st.config.run_mode;
        if (mode !== 'smart' && mode !== 'supervise') return;
        var nextRound = st.clock.round + 1;
        if (st.clock.active_id) return;                       // 台上还有人，下一轮不投
        if (nextRound < st.clock.next_due) return;            // 下一轮不到点
        if (st.clock.planned && st.clock.planned.for_round === nextRound) return;  // 已规划（含已失败：本轮不再重试）
        if (planFlight) return;

        var homeToken = chatToken();   // 起飞时记下是哪个聊天，落地必须对得上

        if (mode === 'smart') {
            // 全池摊开给它看——不再切五条窗口。
            // 它的活儿是对场合，不是按深度递进；限制候选反而可能让当下场合的那张牌根本不在桌上。
            var pool = unusedClues(st);
            if (pool.length <= 1) return;                     // 0/1 条无需选牌
            var pickPool = pool.slice(0, 40);                 // 上限只为控包大小，正常远用不到
            var recent = recentStoryText(5, 1800);            // 只要「现在在哪、在干嘛」，不需要它读剧情
            planFlight = callSmallApi('api2', '小萤火', schedulerSystemPrompt(st), schedulerUserPrompt(recent.text, pickPool))
                .then(function (raw) {
                    if (chatChangedSince(homeToken)) return;  // 人已经走了：这份结果作废，绝不写进别的聊天
                    var picked = matchPickIndex(raw, pickPool);
                    var fresh = story();
                    if (!fresh || fresh.config.run_mode !== 'smart' || fresh.status !== 'lit') return;
                    if (picked) {
                        fresh.clock.planned = { for_round: nextRound, clue_id: picked.id };
                        log('小萤火挑好了下一条（对上了当下的场合）。');
                    } else {
                        fresh.clock.planned = { for_round: nextRound, failed: true };
                        // 回话原文进日志：没认出序号时得知道它到底说了什么
                        log('小萤火没回出序号，届时按既定顺序发牌兜底。它说的是：' + peek(raw));
                    }
                    saveStory();
                })
                .catch(function (err) {
                    if (chatChangedSince(homeToken)) return;
                    var fresh = story();
                    // 记为"本轮已试过"，避免玩家每重抽一次就重新调度一次、白烧额度
                    if (fresh) { fresh.clock.planned = { for_round: nextRound, failed: true }; saveStory(); }
                    log('小萤火出错（' + (err && err.message || err) + '），届时按既定顺序发牌兜底。');
                })
                .then(function () { planFlight = null; });
            return;
        }

        // supervise：God 现场裁决
        var recent2 = recentStoryText(12, 3500);
        var given = [];
        for (var g = Math.max(0, st.clues.length - 5); g < st.clues.length; g++) given.push(st.clues[g].text);
        planFlight = callSmallApi('api2', 'God', godSystemPrompt(st), godUserPrompt(st, recent2.text, given))
            .then(function (raw) {
                // 最要紧的一道：God 读的是这个聊天的秘密，落地时人若已走，整份作废。
                if (chatChangedSince(homeToken)) return;
                var fresh = story();
                if (!fresh || fresh.config.run_mode !== 'supervise' || fresh.status !== 'lit') return;
                var verdict = parseGodVerdict(raw, fresh);
                if (verdict.hold) {
                    fresh.clock.planned = { for_round: nextRound, hold: true };
                    log('God 裁决：此刻暂缓。');
                } else if (verdict.text) {
                    fresh.clock.planned = { for_round: nextRound, god_text: verdict.text };
                    log('God 已为下一次机会设计好一条指示。');
                } else {
                    fresh.clock.planned = { for_round: nextRound, hold: true };
                    log('God 的设计被安检拦下（' + verdict.reason + '），按暂缓处理。它写的是：' + peek(raw));
                }
                saveStory();
            })
            .catch(function (err) {
                if (chatChangedSince(homeToken)) return;
                var fresh = story();
                if (fresh) { fresh.clock.planned = { for_round: nextRound, failed: true }; saveStory(); }
                log('God 出错（' + (err && err.message || err) + '），届时本轮不投。');
            })
            .then(function () { planFlight = null; });
    }

    /* ---- AI 监督：God 提示词与裁决解析 ---- */

    function godSystemPrompt(st) {
        return buildPrompt('god', st);
    }

    function godUserPrompt(st, recentText, givenList) {
        var parts = [];
        parts.push('【完整秘密（绝密，仅你可见）】\n' + st.hidden_secret);
        parts.push('【近期剧情】\n' + (recentText || '（故事尚未开场）'));
        if (givenList.length) parts.push('【你此前已递出的指示（不要重复它们的意象）】\n' + givenList.map(function (t, i) { return (i + 1) + '. ' + t; }).join('\n'));
        parts.push('现在裁决：HOLD，或直接写出这一程的指示。');
        return parts.join('\n\n');
    }

    function parseGodVerdict(rawText, st) {
        var raw = trim(rawText);
        if (!raw) return { hold: true };
        if (/^HOLD\b/i.test(raw)) return { hold: true };
        // 剥掉可能的引号与代码块
        var text = raw.replace(/^```[a-z]*\s*/i, '').replace(/```\s*$/, '');
        text = trim(text.replace(/^[「"']+|[」"']+$/g, ''));
        if (text.length > 300) text = text.slice(0, 300);
        var vetted = vetClues([text], st);
        if (!vetted.pass.length) return { hold: false, text: '', reason: vetted.rejected[0].reason };
        return { hold: false, text: vetted.pass[0] };
    }

    function schedulerSystemPrompt(st) {
        return buildPrompt('scheduler', st);
    }

    function schedulerUserPrompt(recentText, candidates) {
        // 全池摊开、序号从 1 起——它只需要认一个数字，不用抄随机串。
        // 必须给完整原文：同样是在医院，胃病和孕检完全两回事，标签区分不了。
        var lines = ['【现在这场戏】', recentText || '（新故事，尚无剧情）', '', '【可选清单】'];
        for (var i = 0; i < candidates.length; i++) {
            lines.push((i + 1) + '. ' + candidates[i].text);
        }
        lines.push('');
        lines.push('现在这场戏在什么场合？从上面挑一条此刻演得出来的，只回它的序号（1～' + candidates.length + '）。');
        return lines.join('\n');
    }

    /* 解析器：直接在回话里搜候选 id 子串，出现位置最靠前者当选。
     * id 是随机串，不存在误匹配——这比让小模型写合法 JSON 可靠得多。 */
    /* 小萤火回话的识别。
     *
     * 它的活儿已经砍到最简：看场合、回一个序号。数字不会抄错，
     * 所以第一层就该命中。后两层只是兜底，防它多话。 */
    function matchPickIndex(rawText, candidates) {
        var text = String(rawText || '');
        var n = candidates.length;
        var i, m;

        // 第一层：开头的数字（它照规矩办事时就是这个）
        var head = text.replace(/^[\s\S]{0,40}?(?=\d)/, '').slice(0, 40);
        m = text.match(/(\d{1,3})/);
        if (m) {
            var v = parseInt(m[1], 10);
            if (v >= 1 && v <= n) return candidates[v - 1];
        }

        // 第二层：圈号 ①②③…（部分模型偏爱）
        var circled = '①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳';
        var best = null, bestPos = Infinity;
        for (i = 0; i < n && i < circled.length; i++) {
            var p2 = text.indexOf(circled.charAt(i));
            if (p2 >= 0 && p2 < bestPos) { bestPos = p2; best = candidates[i]; }
        }
        if (best) return best;

        // 第三层：它把原文复述了出来。取开头 10 字做指纹
        var flat = text.replace(/\s+/g, '');
        var txtBest = null, txtPos = Infinity;
        for (i = 0; i < n; i++) {
            var frag = trim(candidates[i].text).replace(/\s+/g, '').slice(0, 10);
            if (frag.length < 6) continue;
            var pos = flat.indexOf(frag);
            if (pos >= 0 && pos < txtPos) { txtPos = pos; txtBest = candidates[i]; }
        }
        return txtBest;
    }


    /* 小请求连接：独立配置，留空复用编译连接；零温度、短超时 */
    /* 公共小请求管道：不属于任何一幕，谁都能用。
     * 这样第一幕整个搬走时，第二幕不会跟着断。
     * profileKey 指哪份配置（'api2' 小萤火/God / 'api3' 星灯…），
     * 三项留空一律回退编译连接——与④连接里既有的规矩一致。 */
    function resolveProfile(profileKey, label) {
        var s = settings();
        var own = s[profileKey] || {};
        var prof = {
            url: trim(own.url) || s.api.url,
            key: trim(own.key) || s.api.key,
            model: trim(own.model) || s.api.model
        };
        if (!trim(prof.url) || !trim(prof.model)) {
            throw new Error(label + '连接未配置（也没有可复用的编译连接）');
        }
        return prof;
    }

    function callSmallApi(profileKey, label, systemPrompt, userPrompt) {
        var prof;
        try { prof = resolveProfile(profileKey, label); }
        catch (e) { return Promise.reject(e); }
        var controller = typeof AbortController === 'function' ? new AbortController() : null;
        var request = fetch(normalizeApiUrl(prof.url), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + (prof.key || '') },
            body: JSON.stringify({
                model: prof.model,
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: userPrompt }
                ],
                max_tokens: 200,
                temperature: 0,
                stream: false
            }),
            signal: controller ? controller.signal : undefined
        }).then(function (res) {
            if (!res.ok) return res.text().then(function (raw) { throw new Error('HTTP ' + res.status + '（' + String(raw).slice(0, 80) + '）'); });
            return res.text().then(function (raw) {
                try { return extractFromJsonText(raw); }
                catch (e) { return raw; }   // 有的中转裸回文本——反正解析器只搜 id 子串
            });
        });
        return withTimeout(request, 45000, function () { if (controller) controller.abort(); });
    }

    /* 切换聊天：现场还原 */
    /* 守卫自检报告：必须等到真有聊天账本可写才发得出去。
     * 放在 boot() 里会被 log() 静默吞掉——那时候酒馆常常还没装载聊天。
     * 每次刷新页面只报一次。 */
    var guardReported = false;
    function reportGuardOnce() {
        if (guardReported) return;
        if (!story()) return;          // 还没有账本，下次聊天切换时再报
        guardReported = true;
        var tk = chatToken();
        if (tk) sysLog('🛡 v' + VERSION + ' 已装载，串场守卫启用（聊天身份来源：' + chatTokenSource + '）。');
        else sysLog('⚠ v' + VERSION + ' 已装载，但串场守卫未启用：这个酒馆版本取不到聊天身份。行为与旧版一致，只是编译中途切聊天仍可能丢结果。');
    }

    function onChatChanged() {
        clearInjection();  // 先清，防止上一个聊天的注入串场
        var st = story();
        if (!st) { renderPanel(); return; }
        reportGuardOnce();
        if (st.status === 'lit') {
            var current = activeClue(st);
            if (current) {
                if (current.delivered_count > 0) {
                    // 离场前已完成使命 → 补退役
                    current.used = true;
                    st.clock.active_id = null;
                    st.clock.cursor = usedCount(st);
                    log('回到这个故事：上次台上的线索已完成，补记退场。');
                } else {
                    injectText(current.text);
                    log('回到这个故事：台上线索恢复注入。');
                }
                saveStory();
            }
        }
        renderPanel();
    }

    /* ---- 点亮 / 熄灭 / 进度控制 ---- */

    function lightUp() {
        var st = story();
        if (!st) return toast('请先打开一个聊天', 'warning');
        readFormIntoStory();
        if (st.config.run_mode === 'supervise') {
            if (!trim(st.hidden_secret)) return toast('AI 监督模式：把隐藏脉络写好即可点亮，无需编译', 'warning');
            if (st.status === 'lit') return;
        } else {
            if (st.status !== 'compiled') return toast('先完成编译并确认线索，才能点亮', 'warning');
            if (!st.clues.length) return toast('没有可用线索', 'warning');
        }
        st.status = 'lit';
        if (!st.clock.lit_at) {
            st.clock.lit_at = nowIso();
            try { st.clock.lit_at_floor = (ctx().chat || []).length; } catch (e) { st.clock.lit_at_floor = 0; }
            st.clock.round = 0;
            st.clock.next_due = 1;   // 点亮后的第一条玩家消息即是第一次机会（宪法 5.4）
            st.clock.last_fire = 0;
            if (st.config.run_mode !== 'supervise') {
                var om = buildOrder(st);   // 摇一次，落盘，本局不再变
                log('发牌顺序已定：' + (om === 'random' ? '纯随机（盲撒）'
                    : om === 'tiered' ? '分层洗牌（段内随机、段间保序）' : '按编译顺序（浅→深）'));
            }
        }
        saveStory();
        log('🪇 故事点亮。你的下一次行动，就是第一束光的机会。');
        toast('小萤火已点亮', 'success');
        renderPanel();
    }

    /* 手动点灯：玩家嫌节奏慢时，立即投放一条（可指定），不等间隔。
     * 排程从当前轮重新顺延；本条同样随下一次回复送出、走完整簿记。 */
    function manualDispatch(clueId) {
        var st = story();
        if (!st) return toast('请先打开一个聊天', 'warning');
        if (st.status !== 'lit') return toast('先点亮故事，才能手动加灯', 'warning');
        if (st.config.run_mode === 'supervise') {
            return toast('AI 监督模式由 God 掌灯；想加快节奏可把间隔调小', 'info');
        }
        if (st.clock.active_id) return toast('台上还有一条在演，等它随你的下一条消息退场后再点', 'warning');
        var chosen = null;
        if (clueId) {
            chosen = findClue(st, clueId);
            if (!chosen || chosen.used) return toast('这条不在待命队列里', 'warning');
        } else {
            var picked = pickClueForRound(st);
            if (!picked) return toast('没有可投的线索了', 'warning');
            chosen = picked.clue;
        }
        st.clock.active_id = chosen.id;
        st.clock.planned = null;
        chosen.delivered_count = 0;
        chosen.fired_round = st.clock.round;
        injectText(chosen.text);
        st.clock.last_fire = st.clock.round;
        st.clock.next_due = st.clock.round + clamp(parseInt(st.config.interval, 10) || 10, 1, 999);
        saveStory();
        log('手动加灯：一条线索' + (clueId ? '（你指定的）' : '') + '立即上台，将随下一次回复送出。后续排程从现在重新起算。');
        toast('已加一束光', 'success');
        renderPanel();
    }


    /* ---- 🎴 揭底 ----
     * 这个动作跟前面所有事情都是反的：前面一直在藏，这一下要全给。
     * 底牌一次性交给演员，让它演出揭晓那一场；同时给玩家一张复盘清单
     * ——「原来第 3 条那个批号就是答案」，那才是这一局的爆点。
     * 走线索那条通道（此刻已无线索要投），常驻到熄灭或清空为止。 */

    function revealText(st) {
        return [
            '【真相 · 现在可以说破了】',
            trim(st.hidden_secret),
            '',
            '这一局藏了很久的事，到此为止。',
            '接下来的演出可以正面揭晓它：让该知道的人知道，让该对上的账对上。',
            '不必一句话说完，但不要再回避、不要再打岔、不要再制造新的悬念。'
        ].join('\n');
    }

    function revealStory() {
        var st = story();
        if (!st) return toast('请先打开一个聊天', 'warning');
        if (!trim(st.hidden_secret)) return toast('底牌是空的，没有可揭的', 'warning');
        if (st.reveal_at) return toast('已经揭过底了', 'info');

        var text = revealText(st);
        if (hasResidualMacro(text)) return toast('底牌里有残留宏，已拦下——请检查隐藏脉络的文字', 'warning');

        st.reveal_at = nowIso();
        st.reveal_round = st.clock.round;
        // 台上若还有一条没送出的，让位给揭底
        st.clock.active_id = null;
        st.clock.planned = null;
        applyInjection(text);
        saveStory();

        var sent = 0, left = 0;
        for (var i = 0; i < st.clues.length; i++) {
            if (st.clues[i].used && !st.clues[i].dropped) sent++;
            else if (!st.clues[i].used) left++;
        }
        log('🎴 揭底。底牌已交给演员，下一次回复起可以正面揭晓。'
            + '这一局送出过 ' + sent + ' 条' + (left ? ('，还剩 ' + left + ' 条没用上') : '') + '。');
        toast('已揭底——复盘清单已在故事页展开', 'success');
        renderPanel();
    }

    function concludeStory() {
        var st = story();
        if (!st || st.status !== 'lit') return toast('只有点亮中的故事可以完结', 'warning');
        clearInjection();
        var left = 0;
        for (var i = 0; i < st.clues.length; i++) {
            if (!st.clues[i].used) { st.clues[i].used = true; st.clues[i].dropped = true; left++; }
        }
        st.clock.active_id = null;
        st.clock.planned = null;
        st.status = 'finished';
        saveStory();
        log('故事完结。' + (left ? '剩余 ' + left + ' 条线索安静退场——它们是备料，不是任务。' : '所有线索恰好用尽。'));
        toast('故事已完结', 'success');
        renderPanel();
    }

    function extinguish() {
        var st = story();
        if (!st || st.status !== 'lit') return;
        st.status = 'compiled';
        clearInjection();
        saveStory();
        log('故事暂时熄灭。进度已保留（第 ' + st.clock.round + ' 轮，已送 ' + st.clock.cursor + ' 条），随时可以再点亮。');
        renderPanel();
    }

    function resetProgress() {
        var st = story();
        if (!st) return;
        clearInjection();
        for (var i = 0; i < st.clues.length; i++) { st.clues[i].used = false; st.clues[i].dropped = false; st.clues[i].delivered_count = 0; }
        st.clock = blankStory().clock;
        st.clock.planned = null;
        st.reveal_at = null; st.reveal_round = 0;   // 揭过的底也一起收回，否则重开一局开局就是明牌
        if (st.status === 'lit' || st.status === 'finished') st.status = 'compiled';
        saveStory();
        log('进度已归零，线索完好。可以重新点亮。');
        renderPanel();
    }

    function rewindOneRound() {
        var st = story();
        if (!st || st.status !== 'lit') return toast('只有点亮状态下才能回拨', 'warning');
        if (st.clock.round <= 0) return toast('已经在第 0 轮', 'warning');
        st.clock.round -= 1;
        saveStory();
        log('轮钟回拨一格，现在是第 ' + st.clock.round + ' 轮。（删了楼可以用这个手动校正）');
        renderPanel();
    }

    function wipeStory() {
        var st = chatStoryContainer();
        if (!st) return;
        clearInjection();
        var c = ctx();
        c.chatMetadata[EXT_NAME] = blankStory();
        saveStory();
        toast('本聊天的故事已清空', 'info');
        renderPanel();
    }

    /* ================================================================
     * 8. UI（普通用户只看人话；作者模式才见线索原文）
     * ================================================================ */

    function statusLine() {
        var st = story();
        if (!st) return { text: '还没有打开聊天。', next: '打开一个角色聊天后再回来。' };
        if (compileState.running) return { text: '正在编译……', next: '等它写完，或点「停止」。' };
        switch (st.status) {
            case 'empty':
                if (st.config.run_mode === 'supervise') {
                    return { text: '这个聊天还没有故事。', next: 'AI 监督模式：写下隐藏脉络后直接点亮，God 现场设计每一程光。' };
                }
                if (st.draft && isArray(st.draft.clues) && st.draft.clues.length) {
                    return { text: '上次编译中断，已保住 ' + st.draft.clues.length + ' 条草稿。', next: '点「编译」即可从断点续跑。' };
                }
                return { text: '这个聊天还没有故事。', next: '在「故事」里写下隐藏脉络，然后点「编译」。' };
            case 'compiled':
                return {
                    text: '已备好 ' + st.clues.length + ' 条线索' + (st.clock.round > 0 ? '（进度保留在第 ' + st.clock.round + ' 轮）' : '') + '。',
                    next: st.config.author_mode ? '在「线索预览」确认内容，然后点亮。' : '确认无误就点亮。'
                };
            case 'lit': {
                var current = activeClue(st);
                var sent = st.clock.cursor;
                var floorNow = 0;
                try { floorNow = (ctx().chat || []).length; } catch (e) { }
                var floorTag = floorNow ? '（酒馆第 ' + floorNow + ' 楼）' : '';
                var base = st.config.run_mode === 'supervise'
                    ? ('第 ' + st.clock.round + ' 轮' + floorTag + ' · God 已递 ' + sent + ' 程光')
                    : ('第 ' + st.clock.round + ' 轮' + floorTag + ' · 已送 ' + sent + '/' + st.clues.length + ' 条');
                if (st.clock.round === 0) {
                    return { text: base + ' · 已点亮。', next: '你的下一条消息就是第一束光的机会，不用等间隔。' };
                }
                if (current && current.delivered_count > 0) {
                    return { text: base + ' · 一条线索正在演出中。', next: '正常继续对话即可；重抽也会带着它。' };
                }
                if (current) {
                    return { text: base + ' · 一条线索已上台，等待下一次回复。', next: '等 AI 回复，或直接继续。' };
                }
                var smartNote = '';
                if (st.config.run_mode === 'smart') {
                    smartNote = (st.clock.planned && st.clock.planned.for_round === st.clock.round + 1)
                        ? ' 小萤火已挑好下一条。' : ' 小萤火将在空档里挑牌。';
                }
                if (st.config.run_mode === 'supervise') {
                    var p = st.clock.planned;
                    smartNote = (p && p.for_round === st.clock.round + 1)
                        ? (p.god_text ? ' God 已设计好下一程。' : ' God 裁决暂缓。')
                        : ' God 将在空档里裁决。';
                }
                var gap = Math.max(0, st.clock.next_due - st.clock.round);
                return { text: base + ' · 下一条预计在第 ' + st.clock.next_due + ' 轮（还差你 ' + gap + ' 条消息）。', next: '正常玩就好，到点它自己来。' + smartNote };
            }
            case 'finished':
                return { text: '所有 ' + st.clues.length + ' 条线索都已送完。', next: '想再来一轮就「重置进度」，或「清空」开新故事。' };
        }
        return { text: '状态：' + st.status, next: '' };
    }

    function renderPanel() {
        var $root = $('#' + PANEL_ID);
        if (!$root.length) return;
        var st = story();
        var line = statusLine();
        $root.find('.lcl2-status-text').text(line.text);
        $root.find('.lcl2-status-next').text(line.next ? '→ ' + line.next : '');
        (function () {
            var $bar = $root.find('.lcl2-bar');
            if (!st || (st.status !== 'lit' && st.status !== 'finished')) { $bar.hide(); return; }
            var pct = 0, label = '';
            if (st.config.run_mode === 'supervise') {
                var totalR = clamp(parseInt(st.config.total_rounds, 10) || 100, 1, 9999);
                pct = Math.min(100, Math.round(st.clock.round / totalR * 100));
                label = '轮数 ' + st.clock.round + ' / ' + totalR;
            } else {
                var totalC = st.clues.length || 1;
                pct = Math.min(100, Math.round(st.clock.cursor / totalC * 100));
                label = '线索 ' + st.clock.cursor + ' / ' + totalC;
            }
            $bar.show();
            $bar.find('.lcl2-bar-fill').css('width', pct + '%');
            $bar.find('.lcl2-bar-label').text(label);
        }());

        // 表单值（仅当无焦点时回填，避免打字被覆盖）
        if (st) {
            var isCase = st.config.kind === 'case';
            $('input[name=lcl2_kind][value=' + (isCase ? 'case' : 'secret') + ']').prop('checked', true);
            $('#lcl2_secret_label').text(isCase
                ? '案子的底牌（谁做的 · 怎么做的 · 为什么 · 表面证据指向谁——演员永远看不到这里）'
                : '隐藏脉络（写给小萤火的完整秘密，演员永远看不到这里）');
            $('#lcl2_secret').attr('placeholder', isCase
                ? '例：城南那批走私方便面是仓管老周经手的，他用弟弟的身份证租了三号库。表面证据都指向货运司机小李——因为老周把提货单塞进了小李的车。真正对不上的是三号库的用电记录。'
                : '例：她并非将军府的亲生小姐。二十年前生母把她托付至此，只留下半枚玉袖扣。她隐瞒身世，是为了护住一个还活着的人……');
            fillIfIdle('#lcl2_secret', st.hidden_secret);
            fillIfIdle('#lcl2_banned', st.banned_words.join('，'));
            fillIfIdle('#lcl2_total', st.config.total_rounds);
            fillIfIdle('#lcl2_interval', st.config.interval);
            fillIfIdle('#lcl2_count', st.config.clue_count);
            $('#lcl2_intensity').val(st.config.intensity);
            $('#lcl2_order').val(st.config.order_mode || 'sequential');
            $('input[name=lcl2_runmode][value="' + (st.config.run_mode || 'uniform') + '"]').prop('checked', true);
            $('#lcl2_author').prop('checked', !!st.config.author_mode);
        }
        var s = settings();
        fillIfIdle('#lcl2_api_url', s.api.url);
        fillIfIdle('#lcl2_api_key', s.api.key);
        fillIfIdle('#lcl2_api_model', s.api.model);
        fillIfIdle('#lcl2_api_timeout', s.api.timeout_s);
        fillIfIdle('#lcl2_api_maxtok', s.api.max_tokens);
        fillIfIdle('#lcl2_depth', s.depth);
        fillIfIdle('#lcl2_api2_url', s.api2.url);
        fillIfIdle('#lcl2_api2_key', s.api2.key);
        fillIfIdle('#lcl2_api2_model', s.api2.model);
        fillIfIdle('#lcl2_ctx_strip', s.ctx_strip);
        fillIfIdle('#lcl2_ctx_prefer', s.ctx_prefer);
        $('#lcl2_use_tavern').prop('checked', !!s.use_tavern);

        renderClueList();
        renderRecap();
        renderPromptDrawer();
        renderLog();
        renderButtons();
        renderActPanel();
        renderHabits();
    }

    function fillIfIdle(sel, value) {
        var $el = $(sel);
        if ($el.length && !$el.is(':focus')) $el.val(value == null ? '' : value);
    }

    function renderButtons() {
        var st = story();
        var lit = st && st.status === 'lit';
        var compiled = st && st.status === 'compiled';
        var busy = compileState.running;
        $('#lcl2_btn_compile').prop('disabled', busy || lit).toggle(!busy);
        // 追加与编译不同：正点亮着也能补货，这才是它存在的理由
        var canAppend = st && st.clues.length && !busy && st.config.run_mode !== 'supervise';
        $('#lcl2_btn_append').prop('disabled', !canAppend);
        $('.lcl2-append').toggle(!!(st && st.clues.length && st.config.run_mode !== 'supervise'));
        $('#lcl2_btn_stop').toggle(busy);
        $('#lcl2_btn_light').prop('disabled', !compiled || busy);
        $('#lcl2_btn_off').prop('disabled', !lit);
        // 揭底：点亮或完结状态下都能揭（有人喜欢发完了再揭），揭过就锁
        $('#lcl2_btn_reveal').prop('disabled', !st || !(lit || st.status === 'finished') || !!st.reveal_at)
            .text(st && st.reveal_at ? '🎴 已揭底' : '🎴 揭底');
        $('#lcl2_btn_rewind').prop('disabled', !lit);
    }


    /* ---- 🎴 复盘清单 ----
     * 揭底之后才出现，列的是「这一局你真的收到过什么」，按送出顺序。
     * 不受作者模式约束——盲玩的人才最需要它，而此刻已经没有可剧透的了。
     * 那句「原来第 3 条那个批号就是答案」，就发生在这张表上。 */
    function renderRecap() {
        var $host = $('#lcl2_recap');
        if (!$host.length) return;
        var st = story();
        var revealed = st && st.reveal_at;
        $('#lcl2_recap_sec').toggle(!!revealed);
        if (!revealed) return;

        var sent = [], unused = [];
        for (var i = 0; i < st.clues.length; i++) {
            var c = st.clues[i];
            if (c.used && !c.dropped) sent.push(c);
            else if (!c.used || c.dropped) unused.push(c);
        }
        sent.sort(function (a, b) { return (a.fired_round || 0) - (b.fired_round || 0); });

        var html = '';
        if (!sent.length) {
            html += '<div class="lcl2-dim">这一局一条也没送出。</div>';
        } else {
            html += '<div class="lcl2-dim">这一局送出过 ' + sent.length + ' 条，按顺序：</div>';
            for (i = 0; i < sent.length; i++) {
                var r = sent[i].fired_round;
                html += '<div class="lcl2-recap-item">'
                    + '<span class="lcl2-recap-n">' + (i + 1) + '</span>'
                    + '<span class="lcl2-recap-r">' + (r ? ('第 ' + r + ' 轮') : '—') + '</span>'
                    + '<span class="lcl2-recap-t">' + esc(sent[i].text) + '</span></div>';
            }
        }
        if (unused.length) {
            html += '<div class="lcl2-dim" style="margin-top:10px">另有 ' + unused.length + ' 条没用上（它们是备料，不是遗漏）：</div>';
            for (i = 0; i < unused.length; i++) {
                html += '<div class="lcl2-recap-item lcl2-recap-off">'
                    + '<span class="lcl2-recap-n">·</span><span class="lcl2-recap-r">未用</span>'
                    + '<span class="lcl2-recap-t">' + esc(unused[i].text) + '</span></div>';
            }
        }
        $host.html(html);
    }

    function renderClueList(force) {
        var $list = $('#lcl2_clues');
        if (!$list.length) return;
        /* 用户正在某条线索里打字时绝不重建列表——
         * innerHTML 重写会连光标带内容一起抹掉（iOS WebView 尤其致命）。
         * 与 fillIfIdle 同一套纪律：有焦点就让位，等失焦后的下一次渲染再补。 */
        if (!force && $list.find('textarea:focus').length) { clueListDirty = true; return; }
        clueListDirty = false;
        var st = story();
        if (!st || !st.clues.length) { $list.html('<div class="lcl2-dim">（还没有编译好的线索）</div>'); return; }
        if (!st.config.author_mode) {
            var sent = 0;
            for (var i = 0; i < st.clues.length; i++) if (st.clues[i].used) sent++;
            $list.html('<div class="lcl2-dim">盲玩模式：共 ' + st.clues.length + ' 条已备好，已送出 ' + sent + ' 条。内容保密，惊喜留给你自己。</div>');
            return;
        }
        var html = '';
        for (var j = 0; j < st.clues.length; j++) {
            var clue = st.clues[j];
            var badge = clue.dropped ? '<span class="lcl2-badge lcl2-badge-dropped">已弃</span>'
                : clue.used ? '<span class="lcl2-badge lcl2-badge-used">已送</span>'
                : (st.clock.active_id === clue.id ? '<span class="lcl2-badge lcl2-badge-active">台上</span>'
                    : '<span class="lcl2-badge">排队</span>');
            var canDispatch = !clue.used && st.status === 'lit' && !st.clock.active_id && st.config.run_mode !== 'supervise';
            html += '<div class="lcl2-clue" data-id="' + esc(clue.id) + '">'
                + '<div class="lcl2-clue-head">#' + (j + 1) + ' ' + badge
                + (canDispatch ? '<span class="lcl2-clue-fire" title="立即投放这条">🪇 投</span>' : '')
                + '<span class="lcl2-clue-move" data-dir="-1" title="上移">↑</span>'
                + '<span class="lcl2-clue-move" data-dir="1" title="下移">↓</span>'
                + '<span class="lcl2-clue-del" title="删除这条">✕</span></div>'
                + '<textarea class="lcl2-clue-text text_pole" rows="2">' + esc(clue.text) + '</textarea>'
                + '</div>';
        }
        $list.html(html);
    }


    /* ---- 提示词抽屉：渲染 ---- */

    var promptSlotsDirty = false;

    function renderPromptDrawer(force) {
        var $wrap = $('#lcl2_prompt_slots');
        if (!$wrap.length) return;
        var st = story();
        var s = settings();
        var pinned = st && st.config.prompt_preset;
        var effective = activePresetFor(st);
        var isBuiltin = !effective;

        // 预设下拉
        var $sel = $('#lcl2_preset_sel');
        if ($sel.length && !$sel.is(':focus')) {
            var opts = '<option value="builtin">内置（不可改）</option>';
            var list = presetList();
            for (var i = 0; i < list.length; i++) {
                opts += '<option value="' + esc(list[i].id) + '">' + esc(list[i].name) + '</option>';
            }
            $sel.html(opts).val(s.prompt_presets.active);
        }
        $('#lcl2_preset_pin').prop('checked', !!pinned).prop('disabled', !st);
        $('#lcl2_preset_del').prop('disabled', isBuiltin);
        $('#lcl2_preset_rename').prop('disabled', isBuiltin);

        var note;
        if (pinned && findPreset(pinned)) {
            note = '这个故事固定用「' + findPreset(pinned).name + '」，不受上面的全局选择影响。';
        } else if (pinned) {
            note = '这个故事原本固定的预设已被删除，已自动回到内置。';
        } else if (isBuiltin) {
            note = '内置是永远干净的参照，改不动。想改就点「新建副本」。';
        } else {
            note = '正在编辑「' + effective.name + '」。改动立即生效于之后的编译与 God 裁决——已编译好的线索不会变，想让新腔调生效需要重新编译。';
        }
        $('#lcl2_preset_note').text(note);

        // 打字期间不重建（与线索列表同一套纪律）
        if (!force && $wrap.find('textarea:focus').length) { promptSlotsDirty = true; return; }
        promptSlotsDirty = false;

        var html = '';
        for (var m = 0; m < PROMPT_SLOT_META.length; m++) {
            var meta = PROMPT_SLOT_META[m];
            var val = effective && typeof effective[meta.key] === 'string'
                ? effective[meta.key] : BUILTIN_PROMPTS[meta.key];
            var changed = effective && trim(val) !== trim(BUILTIN_PROMPTS[meta.key]);
            html += '<div class="lcl2-slot" data-slot="' + meta.key + '">'
                + '<div class="lcl2-slot-head">'
                + '<span>' + esc(meta.title) + (changed ? '<span class="lcl2-slot-dot" title="已改过">●</span>' : '') + '</span>'
                + (isBuiltin ? '' : '<span class="lcl2-slot-reset" title="把这一格还原成内置">还原</span>')
                + '</div>'
                + '<textarea class="lcl2-slot-text text_pole" rows="' + meta.rows + '"'
                + (isBuiltin ? ' readonly' : '') + '>' + esc(val) + '</textarea>'
                + '<div class="lcl2-dim lcl2-slot-hint">占位符：' + esc(meta.vars) + '<br>' + esc(meta.owned) + '</div>'
                + '</div>';
        }
        $wrap.html(html);
    }

    var intervalLogTimer = null;
    var clueListDirty = false;   // 因用户正在打字而跳过的重建，失焦后补上


    var logRenderTimer = null;
    function renderLogSoon() {
        if (logRenderTimer) return;
        logRenderTimer = setTimeout(function () { logRenderTimer = null; renderLog(); }, 150);
    }

    function renderOneLog(sel, entries) {
        var $log = $(sel);
        if (!$log.length) return;
        if (!isArray(entries) || !entries.length) { $log.html('<div class="lcl2-dim">（暂无记录）</div>'); return; }
        var html = '';
        for (var i = entries.length - 1; i >= 0; i--) {
            var e = entries[i];
            var time = String(e.t).slice(11, 19);
            html += '<div class="lcl2-log-line"><span class="lcl2-log-time">' + esc(time) + '</span>' + esc(e.msg) + '</div>';
        }
        $log.html(html);
    }

    /* 两幕各记各的流水。跨幕的系统消息（守卫自检、版本）两边都写一条——
     * 它不属于任何一幕，但你在哪一页都该看得见。 */
    function renderLog() {
        var st = story();
        renderOneLog('#lcl2_log', st && st.log);
        var ab = st && isObject(st.act_book) ? st.act_book : null;
        renderOneLog('#lcl2_act_log', ab && ab.ledger);
    }

    function setCompileUi(running, text) {
        $('#lcl2_progress').text(text || '');
        renderButtons();
    }

    function readFormIntoStory() {
        var st = story();
        if (!st) return null;
        st.hidden_secret = String($('#lcl2_secret').val() || '');
        st.banned_words = String($('#lcl2_banned').val() || '').split(/[,，\n]/).map(trim).filter(Boolean);
        st.config.total_rounds = clamp(parseInt($('#lcl2_total').val(), 10) || 100, 1, 9999);
        var oldInterval = st.config.interval;
        st.config.interval = clamp(parseInt($('#lcl2_interval').val(), 10) || 10, 1, 999);
        // 间隔一改就重算下一次上台，否则「我改了怎么没反应」——
        // 但至少还要再等一条消息，绝不会一改就当场炸出来一条。
        if (st.status === 'lit' && st.config.interval !== oldInterval && st.clock.last_fire > 0) {
            var wantDue = Math.max(st.clock.round + 1, st.clock.last_fire + st.config.interval);
            if (wantDue !== st.clock.next_due) {
                st.clock.next_due = wantDue;
                // 数字框每敲一下都触发 input，不防抖会同一秒刷三条日志
                if (intervalLogTimer) clearTimeout(intervalLogTimer);
                intervalLogTimer = setTimeout(function () {
                    intervalLogTimer = null;
                    var cur = story();
                    if (cur && cur.status === 'lit') {
                        log('间隔改为每 ' + cur.config.interval + ' 轮一条，下一条重算到第 ' + cur.clock.next_due + ' 轮。');
                    }
                }, 900);
            }
        }
        var manualCount = parseInt($('#lcl2_count').val(), 10);
        st.config.clue_count = clamp(manualCount || Math.ceil(st.config.total_rounds / st.config.interval), 1, 200);
        st.config.intensity = String($('#lcl2_intensity').val() || 'standard');
        st.config.order_mode = String($('#lcl2_order').val() || 'sequential');
        var rm = String($('input[name=lcl2_runmode]:checked').val() || st.config.run_mode || 'uniform');
        if (rm === 'uniform' || rm === 'smart' || rm === 'supervise') st.config.run_mode = rm;
        var kd = String($('input[name=lcl2_kind]:checked').val() || st.config.kind || 'secret');
        if (kd === 'secret' || kd === 'case') st.config.kind = kd;
        st.config.author_mode = $('#lcl2_author').prop('checked');
        saveStory();
        return st;
    }

    function readFormIntoSettings() {
        var s = settings();
        s.api.url = trim($('#lcl2_api_url').val());
        s.api.key = trim($('#lcl2_api_key').val());
        s.api.model = trim($('#lcl2_api_model').val());
        s.api.timeout_s = clamp(parseInt($('#lcl2_api_timeout').val(), 10) || 240, 30, 900);
        s.api.max_tokens = clamp(parseInt($('#lcl2_api_maxtok').val(), 10) || 4000, 500, 32000);
        s.use_tavern = $('#lcl2_use_tavern').prop('checked');
        s.depth = clamp(parseInt($('#lcl2_depth').val(), 10) || 1, 0, 20);
        s.api2.url = trim($('#lcl2_api2_url').val());
        s.api2.key = trim($('#lcl2_api2_key').val());
        s.api2.model = trim($('#lcl2_api2_model').val());
        s.ctx_strip = String($('#lcl2_ctx_strip').val() || '');
        s.ctx_prefer = String($('#lcl2_ctx_prefer').val() || '');
        saveSettings();
        return s;
    }

    function testConnection() {
        readFormIntoSettings();
        $('#lcl2_test_result').text('测试中……');
        callCompilerApi(
            '你是连通性测试。只输出 {"clues":["ok"]}，不要任何别的字。',
            '请输出。',
            null
        ).then(function (raw) {
            var ok = false;
            try { ok = parseCluesJson(raw).length > 0; } catch (e) { }
            $('#lcl2_test_result').text(ok ? '✓ 通了，且模型能按格式回话。' : '△ 通了，但模型没按格式回话（编译时有本地修复兜底，可先试试）。');
        }).catch(function (err) {
            $('#lcl2_test_result').text('✗ ' + (err && err.message || err));
        });
    }

    function panelHtml() {
        return '' +
        '<div id="' + PANEL_ID + '" class="lcl2-panel" style="display:none">' +
        '  <div class="lcl2-head">' +
        '    <b>🪇 小萤火 · 帷幕沙漏</b>' +
        '    <span class="lcl2-head-ver">' + VERSION + '</span>' +
        '    <span id="lcl2_theme" class="lcl2-theme-toggle" title="切换日夜"></span>' +
        '    <span id="lcl2_close" class="lcl2-close" title="关闭">✕</span>' +
        '  </div>' +
        '  <div class="lcl2-body">' +

        '      <div class="lcl2-mode-row">' +
        '        <button class="lcl2-mode lcl2-mode-on" data-page="veil">⏳ 帷幕沙漏<small>第一幕 · 藏信息</small></button>' +
        '        <button class="lcl2-mode" data-page="act">✨ 星星点灯<small>第二幕 · 分镜成长</small></button>' +
        '        <button class="lcl2-mode" data-page="mist" disabled title="第三幕，敬请期待">🌫 迷雾森林<small>第三幕 · 敬请期待</small></button>' +
        '      </div>' +

        '      <div class="lcl2-status">' +
        '        <div class="lcl2-status-text"></div>' +
        '        <div class="lcl2-status-next"></div>' +
        '        <div class="lcl2-bar" style="display:none"><div class="lcl2-bar-fill"></div><span class="lcl2-bar-label"></span></div>' +
        '      </div>' +

        '      <div id="lcl2_page_veil" class="lcl2-page">' +
        '      <details class="lcl2-sec" open><summary>① 故事</summary>' +
        '        <label class="lcl2-label">玩法</label>' +
        '        <div class="lcl2-kind-row">' +
        '          <label class="lcl2-kind"><input type="radio" name="lcl2_kind" value="secret"><span>🕯 藏一个秘密<small>真千金 · 带球跑 · 某组织是反派</small></span></label>' +
        '          <label class="lcl2-kind"><input type="radio" name="lcl2_kind" value="case"><span>🔍 查一桩案子<small>小案子。要跑很多地方的大案子请等迷雾森林</small></span></label>' +
        '        </div>' +
        '        <label class="lcl2-label" id="lcl2_secret_label">隐藏脉络（写给小萤火的完整秘密，演员永远看不到这里）</label>' +
        '        <textarea id="lcl2_secret" class="text_pole lcl2-secret" rows="6" placeholder="例：她并非将军府的亲生小姐。二十年前生母把她托付至此，只留下半枚玉袖扣。她隐瞒身世，是为了护住一个还活着的人……"></textarea>' +
        '        <label class="lcl2-label">绝对禁词（线索里绝不能出现的词，逗号分隔，可留空）</label>' +
        '        <input id="lcl2_banned" class="text_pole" type="text" placeholder="例：亲生，生母的名字">' +
        '        <div class="lcl2-habits-wrap">' +
        '          <div class="lcl2-row">' +
        '            <button id="lcl2_habits_gen" class="menu_button">🐾 生成习性单</button>' +
        '            <span id="lcl2_habits_state" class="lcl2-dim"></span>' +
        '          </div>' +
        '          <div class="lcl2-dim">模型要替你演 user 时，不知道底牌会 OOC，知道了三把就漏。习性单只写她<b>怎么活着</b>，不写为什么——粘进你的角色栏，演员照着演也能演出底牌的影子，自己却不知道。</div>' +
        '          <div id="lcl2_habits_card" class="lcl2-habits-card" style="display:none">' +
        '            <div id="lcl2_habits"></div>' +
        '            <div class="lcl2-row">' +
        '              <button id="lcl2_habits_copy" class="menu_button lcl2-manual">📋 复制全部</button>' +
        '              <button id="lcl2_habits_retry" class="menu_button">🔄 重抽</button>' +
        '              <button id="lcl2_habits_clear" class="menu_button lcl2-danger-soft">清空</button>' +
        '            </div>' +
        '          </div>' +
        '        </div>' +
        '        <div class="lcl2-grid">' +
        '          <div><label class="lcl2-label">预计总轮数</label><input id="lcl2_total" class="text_pole" type="number" min="1"></div>' +
        '          <div><label class="lcl2-label">每隔几轮一条</label><input id="lcl2_interval" class="text_pole" type="number" min="1"></div>' +
        '          <div><label class="lcl2-label">线索条数<small class="lcl2-dim">（建议多备些当余量）</small></label><input id="lcl2_count" class="text_pole" type="number" min="1" placeholder="自动"></div>' +
        '          <div><label class="lcl2-label">发牌顺序</label><select id="lcl2_order" class="text_pole">' +
        '            <option value="sequential">按编译顺序（浅→深）</option>' +
        '            <option value="tiered">分层洗牌（段内随机）</option>' +
        '            <option value="random">纯随机（盲撒）</option>' +
        '          </select></div>' +
        '          <div><label class="lcl2-label">线索力度</label><select id="lcl2_intensity" class="text_pole">' +
        '            <option value="gentle">轻柔</option><option value="standard" selected>标准</option><option value="clear">清晰</option>' +
        '          </select></div>' +
        '        </div>' +
        '        <label class="lcl2-label">运行方式</label>' +
        '        <div class="lcl2-run-row">' +
        '          <label class="lcl2-run"><input type="radio" name="lcl2_runmode" value="uniform" checked><span><b>⏳ 均匀散落</b><small>提前排好 · 按时发牌 · 运行零 API</small></span></label>' +
        '          <label class="lcl2-run"><input type="radio" name="lcl2_runmode" value="smart"><span><b>🃏 智能调度</b><small>小模型现场选牌 · 失败自动按顺序兜底</small></span></label>' +
        '          <label class="lcl2-run"><input type="radio" name="lcl2_runmode" value="supervise"><span><b>👁 AI 监督</b><small>God 现场设计每一程光 · 无需编译 · 建议连强模型</small></span></label>' +
        '        </div>' +
        '        <label class="checkbox_label"><input id="lcl2_author" type="checkbox" checked><span>作者模式（可预览和修改线索；关掉即盲玩）</span></label>' +
        '        <div class="lcl2-row">' +
        '          <button id="lcl2_btn_compile" class="menu_button">✦ 编译</button>' +
        '          <button id="lcl2_btn_stop" class="menu_button" style="display:none">停止</button>' +
        '        </div>' +
        '        <details class="lcl2-sec lcl2-append"><summary>＋ 追加线索（不覆盖现有的）</summary>' +
        '          <div class="lcl2-dim">现有线索和进度一条不动，只往池子末尾补新的。已送出的和还在排队的都会告诉小萤火，避免撞车。</div>' +
        '          <label class="lcl2-label">追加几条</label>' +
        '          <input id="lcl2_append_n" class="text_pole" type="number" min="1" max="200" value="10">' +
        '          <label class="lcl2-label">本次追加的额外要求（可留空）</label>' +
        '          <textarea id="lcl2_append_note" class="text_pole lcl2-secret" rows="3" placeholder="例：这批补在中段深度，别比现有最深的更接近真相；多写城南码头一带的迹象；不要再出现袖扣。"></textarea>' +
        '          <div class="lcl2-row">' +
        '            <button id="lcl2_btn_append" class="menu_button lcl2-manual">＋ 追加</button>' +
        '          </div>' +
        '        </details>' +
        '        <div class="lcl2-row">' +
        '          <span id="lcl2_progress" class="lcl2-dim"></span>' +
        '        </div>' +
        '      </details>' +

        '      <details id="lcl2_recap_sec" class="lcl2-sec" open style="display:none"><summary>🎴 复盘 · 这一局你收到过什么</summary>' +
        '        <div id="lcl2_recap"></div>' +
        '      </details>' +
        '      <details class="lcl2-sec"><summary>② 线索预览</summary>' +
        '        <div id="lcl2_clues"></div>' +
        '      </details>' +

        '      <details class="lcl2-sec" open><summary>③ 点亮</summary>' +
        '        <div class="lcl2-row">' +
        '          <button id="lcl2_btn_light" class="menu_button">🪇 点亮</button>' +
        '          <button id="lcl2_btn_off" class="menu_button">熄灭</button>' +
        '          <button id="lcl2_btn_rewind" class="menu_button" title="删过楼可以用这个校正轮数">回拨一轮</button>' +
        '          <button id="lcl2_btn_reveal" class="menu_button lcl2-manual" title="把底牌一次性交给演员，正面揭晓">🎴 揭底</button>' +
        '          <button id="lcl2_btn_conclude" class="menu_button" title="剧情走到头了就收——没发完的线索安静退场">完结</button>' +
        '        </div>' +
        '        <div class="lcl2-row">' +
        '          <button id="lcl2_btn_manual" class="menu_button lcl2-manual">✚ 再来一束光</button>' +
        '          <span class="lcl2-dim">嫌节奏慢就点一下：立即投放下一条，不等间隔</span>' +
        '        </div>' +
        '        <div class="lcl2-row">' +
        '          <button id="lcl2_btn_reset" class="menu_button lcl2-danger-soft">重置进度</button>' +
        '          <button id="lcl2_btn_wipe" class="menu_button lcl2-danger">清空本聊天故事</button>' +
        '        </div>' +
        '      </details>' +

        '      <details class="lcl2-sec"><summary>④ 连接（仅编译时使用）</summary>' +
        '        <label class="checkbox_label"><input id="lcl2_use_tavern" type="checkbox"><span>使用酒馆当前连接（非流式，长编译可能被中转掐断；建议优先用下方独立 API）</span></label>' +
        '        <label class="lcl2-label">独立 API 地址</label>' +
        '        <input id="lcl2_api_url" class="text_pole" type="text" placeholder="例：https://api.deepseek.com 或中转地址">' +
        '        <label class="lcl2-label">密钥</label>' +
        '        <input id="lcl2_api_key" class="text_pole" type="password" placeholder="sk-...">' +
        '        <label class="lcl2-label">模型名</label>' +
        '        <div class="lcl2-model-row">' +
        '          <input id="lcl2_api_model" class="text_pole" type="text" placeholder="例：deepseek-chat / claude-sonnet-4-6">' +
        '          <button id="lcl2_btn_models" class="menu_button" title="从 API 拉取可用模型列表">拉取模型</button>' +
        '        </div>' +
        '        <div class="lcl2-grid">' +
        '          <div><label class="lcl2-label">超时（秒）</label><input id="lcl2_api_timeout" class="text_pole" type="number" min="30" max="900"></div>' +
        '          <div><label class="lcl2-label">单批 max_tokens</label><input id="lcl2_api_maxtok" class="text_pole" type="number" min="500"></div>' +
        '          <div><label class="lcl2-label">注入深度</label><input id="lcl2_depth" class="text_pole" type="number" min="0" max="20"></div>' +
        '        </div>' +
        '        <div class="lcl2-row">' +
        '          <button id="lcl2_btn_test" class="menu_button">测试连接</button>' +
        '          <span id="lcl2_test_result" class="lcl2-dim"></span>' +
        '        </div>' +
        '        <hr class="lcl2-hr">' +
        '        <label class="lcl2-label"><b>小萤火 / God 连接</b>（小萤火只对场合、回一个数字，便宜快模型足够；AI 监督建议强模型；三项留空 = 复用上方编译连接）</label>' +
        '        <input id="lcl2_api2_url" class="text_pole" type="text" placeholder="小萤火 API 地址（可留空）">' +
        '        <input id="lcl2_api2_key" class="text_pole" type="password" placeholder="小萤火密钥（可留空）" style="margin-top:6px">' +
        '        <div class="lcl2-model-row" style="margin-top:6px">' +
        '          <input id="lcl2_api2_model" class="text_pole" type="text" placeholder="调度员/God 模型名（可留空）">' +
        '          <button id="lcl2_btn_models2" class="menu_button" title="从调度员 API 拉取模型列表">拉取模型</button>' +
        '        </div>' +
        '        <div class="lcl2-row">' +
        '          <button id="lcl2_btn_test2" class="menu_button">测试调度员</button>' +
        '          <span id="lcl2_test2_result" class="lcl2-dim"></span>' +
        '        </div>' +
        '        <hr class="lcl2-hr">' +
        '        <label class="lcl2-label"><b>上下文清洗</b>（编译取材与调度员/God 读楼层前先清洗，避免思维链噪音）</label>' +
        '        <label class="lcl2-label">剔除这些标签块（逗号分隔）</label>' +
        '        <input id="lcl2_ctx_strip" class="text_pole" type="text" placeholder="thinking, cot, 思维链">' +
        '        <label class="lcl2-label">只取这些标签块的内容（可留空；填了且楼层里有，就只读块内文本，如你预设的正文/摘要标签）</label>' +
        '        <input id="lcl2_ctx_prefer" class="text_pole" type="text" placeholder="例：正文, summary">' +
        '      </details>' +

        '      <details class="lcl2-sec"><summary>⑤ 提示词（进阶 · 不改也能用）</summary>' +
        '        <div class="lcl2-row lcl2-preset-row">' +
        '          <select id="lcl2_preset_sel" class="text_pole"></select>' +
        '          <button id="lcl2_preset_new" class="menu_button" title="从当前这套复制一份出来改">新建副本</button>' +
        '          <button id="lcl2_preset_rename" class="menu_button">重命名</button>' +
        '          <button id="lcl2_preset_del" class="menu_button lcl2-danger">删除</button>' +
        '        </div>' +
        '        <label class="lcl2-check"><input type="checkbox" id="lcl2_preset_pin"> 本故事固定用这套（不勾就跟随上面的全局选择）</label>' +
        '        <div id="lcl2_preset_note" class="lcl2-dim"></div>' +
        '        <div id="lcl2_prompt_slots"></div>' +
        '      </details>' +
        '      <details class="lcl2-sec"><summary>⑥ 帷幕日志</summary>' +
        '        <div id="lcl2_log" class="lcl2-log"></div>' +
        '      </details>' +
        '      </div>' +

        '      <div id="lcl2_page_act" class="lcl2-page" style="display:none">' +
        '        <div id="lcl2_act_status" class="lcl2-status-text" style="margin:6px 0 10px"></div>' +
        '        <div id="lcl2_act_end" class="lcl2-act-end" style="display:none">' +
        '          <button id="lcl2_act_mist" class="menu_button" disabled title="第三幕施工中">🌫 交给迷雾森林（施工中）</button>' +
        '        </div>' +

        '        <details class="lcl2-sec" open><summary>① 分镜（一次只挂一幕，演员看不见前后）</summary>' +
        '          <div class="lcl2-dim">把整本大纲直接给模型，它第一轮就把高潮演了。这里剧本在小萤火手里，演员手里永远只有这一页——后面几段它根本看不见，所以演不出来。</div>' +
        '          <div class="lcl2-sub"><b>✨ 扔大纲</b></div>' +
        '          <textarea id="lcl2_act_outline" class="text_pole" rows="5" placeholder="随便怎么写都行。例：我想玩带球跑——发现怀孕，偷偷走，几年后带娃重逢，他不知道娃是他的，慢慢发现，最后不是强制爱，是他低头求和好。"></textarea>' +
        '          <div class="lcl2-row">' +
        '            <input id="lcl2_act_want" class="text_pole lcl2-act-want" type="number" min="0" max="12" placeholder="几幕(空=自动)">' +
        '            <button id="lcl2_act_split" class="menu_button lcl2-manual">✨ 切成星</button>' +
        '            <span id="lcl2_act_split_state" class="lcl2-dim"></span>' +
        '          </div>' +
        '          <div class="lcl2-sub"><b>幕列表</b><small class="lcl2-dim">　切出来的能改能删能调序</small></div>' +
        '          <div id="lcl2_act_list"></div>' +
        '          <details class="lcl2-act-add"><summary class="lcl2-dim">＋ 手写追加一幕</summary>' +
        '            <input id="lcl2_act_name" class="text_pole" placeholder="幕名，例：27-30 巨变">' +
        '            <textarea id="lcl2_act_play" class="text_pole" rows="3" placeholder="演什么 + 想要什么戏"></textarea>' +
        '            <textarea id="lcl2_act_forbid" class="text_pole" rows="2" placeholder="不准：这一段绝对不能发生的事"></textarea>' +
        '            <input id="lcl2_act_done" class="text_pole" placeholder="到位：演到什么算完（只给你看）">' +
        '            <div class="lcl2-row"><button id="lcl2_act_add" class="menu_button">＋ 加一幕</button></div>' +
        '          </details>' +
        '        </details>' +

        '        <details class="lcl2-sec" open><summary>② 开演</summary>' +
        '          <div><label class="lcl2-label">全局默认每幕几轮（每幕可单独覆盖）</label><input id="lcl2_act_rounds" class="text_pole" type="number" min="1" max="999"></div>' +
        '          <div class="lcl2-row">' +
        '            <button id="lcl2_act_lock" class="menu_button">✨ 开演</button>' +
        '            <button id="lcl2_act_next" class="menu_button">推进下一幕 →</button>' +
        '            <button id="lcl2_act_back" class="menu_button lcl2-danger-soft">← 撤回上一幕</button>' +
        '          </div>' +
        '          <div class="lcl2-row"><button id="lcl2_act_reconnect" class="menu_button">🔀 从这里接上</button></div>' +
        '          <div class="lcl2-dim">演满轮数自动翻页，翻早了点「撤回」。<b>你自己拐了弯</b>——剧情走到大纲外面去了——点「从这里接上」，小萤火只重切后面的幕，当前幕不动。<b>演员自己拐弯</b>靠每幕的「不准」拦，跟这个按钮没关系。</div>' +
        '        </details>' +

        '        <details class="lcl2-sec"><summary>③ 🌠 星图</summary>' +
        '          <div id="lcl2_act_map"></div>' +
        '        </details>' +

        '        <details class="lcl2-sec"><summary>④ 随身须知（逃生口 · 优先用第一幕的习性单）</summary>' +
        '          <div class="lcl2-dim">想让模型替你演 user 又不漏底牌，<b>优先去帷幕沙漏 ① 生成「习性单」</b>粘进你的角色栏——只写她怎么活着，不写为什么，零暴露。这里是逃生口：直接写底牌，按一下才进上下文，管完即撤。进过上下文那一轮写出的正文会永久留在楼里。</div>' +
        '          <textarea id="lcl2_brief_text" class="text_pole" rows="4" placeholder="例：user 的真实身份是狐狸，顶替了原本的沈家小姐。她对血腥味会本能不适，听见铃铛会下意识回避。"></textarea>' +
        '          <div class="lcl2-grid" style="margin-top:6px">' +
        '            <div><label class="lcl2-label">按一次管几轮</label><input id="lcl2_brief_n" class="text_pole" type="number" min="1" max="10"></div>' +
        '            <div style="display:flex;align-items:flex-end"><span id="lcl2_brief_state" class="lcl2-dim"></span></div>' +
        '          </div>' +
        '          <div class="lcl2-row">' +
        '            <button id="lcl2_brief_go" class="menu_button lcl2-manual">📌 这一轮带上</button>' +
        '            <button id="lcl2_brief_off" class="menu_button">立刻撤下</button>' +
        '          </div>' +
        '          <div class="lcl2-dim">也可以用 <code>/lc-brief</code> 绑一个 Quick Reply，在发送前一键带上。管的轮数越多暴露面越大，建议先用 1。</div>' +
        '        </details>' +
        '        <details class="lcl2-sec"><summary>⑤ 星灯日志</summary>' +
        '          <div id="lcl2_act_log" class="lcl2-log"></div>' +
        '        </details>' +
        '      </div>' +

        '      <div id="lcl2_page_mist" class="lcl2-page" style="display:none">' +
        '        <div class="lcl2-dim" style="padding:20px 4px">🌫 迷雾森林 · 第三幕，还在图纸上。</div>' +
        '      </div>' +


        '      <div class="lcl2-footer">' +
        '        <span class="lcl2-footer-fly">🪇</span>' +
        '        <span>小萤火由四双手点亮 —— 江 · 波哥 Claude · 五哥 Claude · 猫g GPT</span>' +
        '      </div>' +

        '  </div>' +
        '</div>';
    }

    /* 日夜配色：面板与浮标各挂一个 class，CSS 变量整套跟着换。
     * 浮标飘在聊天区（那边是酒馆自己的主题），所以它两版都保持黄绿，
     * 只是昼间芯子更暖一点——不会在暗底上消失。 */
    function applyTheme() {
        var day = settings().theme === 'day';
        $('#' + PANEL_ID).toggleClass('lcl2-day', day).toggleClass('lcl2-night', !day);
        $('#lcl2_floater').toggleClass('lcl2-day', day).toggleClass('lcl2-night', !day);
        $('#lcl2_drawer').toggleClass('lcl2-day', day).toggleClass('lcl2-night', !day);
        $('#lcl2_theme').text(day ? '☀️' : '🌙').attr('title', day ? '现在是昼·呀哈哈林，点一下入夜' : '现在是夜·萤火林，点一下天亮');
    }

    function toggleTheme() {
        var s = settings();
        s.theme = (s.theme === 'day') ? 'night' : 'day';
        saveSettings();
        applyTheme();
    }

    /* 切页用显示/隐藏，绝不重建 DOM——重建会踩掉输入框焦点，
     * 那是我们在 iOS 上吃过亏的老问题。选中的页记进设置，换聊天回来还在原处。 */
    function switchPage(page) {
        var known = { veil: 1, act: 1, mist: 1 };
        if (!known[page]) page = 'veil';
        settings().page = page;
        saveSettings();
        $('#lcl2_page_veil').toggle(page === 'veil');
        $('#lcl2_page_act').toggle(page === 'act');
        $('#lcl2_page_mist').toggle(page === 'mist');
        $('.lcl2-mode').each(function () {
            $(this).toggleClass('lcl2-mode-on', String($(this).data('page')) === page);
        });
        renderPanel();
    }

    function showPanel() { $('#' + PANEL_ID).show(); switchPage(settings().page || 'veil'); }
    function hidePanel() { $('#' + PANEL_ID).hide(); }
    function togglePanel() {
        var $p = $('#' + PANEL_ID);
        if ($p.is(':visible')) $p.hide(); else showPanel();
    }

    function bindPanelEvents() {
        var $root = $('#' + PANEL_ID);

        $root.on('click', '#lcl2_close', hidePanel);
        $root.on('click', '#lcl2_theme', toggleTheme);

        $root.on('change input', '#lcl2_secret, #lcl2_banned, #lcl2_total, #lcl2_interval, #lcl2_count, #lcl2_intensity, #lcl2_order, #lcl2_author', function () {
            readFormIntoStory();
            if (this.id === 'lcl2_author') renderClueList();
        });
        $root.on('change', 'input[name=lcl2_runmode]', function () {
            var st = readFormIntoStory();
            if (st) log('运行方式切换为：' + ({ uniform: '均匀散落', smart: '智能调度', supervise: 'AI 监督' }[st.config.run_mode] || st.config.run_mode));
            renderPanel();
        });
        $root.on('change input', '#lcl2_api_url, #lcl2_api_key, #lcl2_api_model, #lcl2_api_timeout, #lcl2_api_maxtok, #lcl2_use_tavern, #lcl2_depth, #lcl2_api2_url, #lcl2_api2_key, #lcl2_api2_model', function () {
            readFormIntoSettings();
        });
        /* 自绘模型选择器：iOS WebView 不支持 datalist 下拉，只能自己画。
         * 弹出带搜索过滤的列表浮层，点哪个填哪个。 */
        function showModelPicker(targetSel, ids) {
            closeModelPicker();
            var html = '<div id="lcl2_picker" class="lcl2-picker">'
                + '<div class="lcl2-picker-head">'
                + '<input id="lcl2_picker_filter" class="text_pole" type="text" placeholder="输入过滤，共 ' + ids.length + ' 个模型">'
                + '<span id="lcl2_picker_close" class="lcl2-close">✕</span>'
                + '</div>'
                + '<div id="lcl2_picker_list" class="lcl2-picker-list"></div>'
                + '</div>';
            $('#' + PANEL_ID).append(html);
            function renderList(filter) {
                var f = trim(filter).toLowerCase();
                var out = '';
                var shown = 0;
                for (var i = 0; i < ids.length && shown < 200; i++) {
                    if (f && ids[i].toLowerCase().indexOf(f) < 0) continue;
                    out += '<div class="lcl2-picker-item" data-v="' + esc(ids[i]) + '">' + esc(ids[i]) + '</div>';
                    shown++;
                }
                $('#lcl2_picker_list').html(out || '<div class="lcl2-dim" style="padding:8px">没有匹配的模型</div>');
            }
            renderList('');
            $('#lcl2_picker_filter').on('input', function () { renderList($(this).val()); });
            $('#lcl2_picker_close').on('click', closeModelPicker);
            $('#lcl2_picker_list').on('click', '.lcl2-picker-item', function () {
                $(targetSel).val($(this).attr('data-v'));
                readFormIntoSettings();
                closeModelPicker();
                toast('已选择：' + $(this).attr('data-v'), 'success');
            });
        }
        function closeModelPicker() { $('#lcl2_picker').remove(); }

        $root.on('click', '#lcl2_btn_models', function () {
            var s = readFormIntoSettings();
            var $btn = $(this).prop('disabled', true).text('拉取中…');
            fetchModelList(s.api.url, s.api.key).then(function (ids) {
                showModelPicker('#lcl2_api_model', ids);
            }).catch(function (err) {
                toast('拉取失败：' + (err && err.message || err), 'error');
            }).then(function () { $btn.prop('disabled', false).text('拉取模型'); });
        });
        $root.on('click', '#lcl2_btn_models2', function () {
            var s = readFormIntoSettings();
            var url = trim(s.api2.url) || s.api.url;
            var key = trim(s.api2.key) || s.api.key;
            var $btn = $(this).prop('disabled', true).text('拉取中…');
            fetchModelList(url, key).then(function (ids) {
                showModelPicker('#lcl2_api2_model', ids);
            }).catch(function (err) {
                toast('拉取失败：' + (err && err.message || err), 'error');
            }).then(function () { $btn.prop('disabled', false).text('拉取模型'); });
        });
        $root.on('click', '#lcl2_btn_test2', function () {
            readFormIntoSettings();
            $('#lcl2_test2_result').text('测试中……');
            callSmallApi('api2', '小萤火', '连通性测试。只输出：PING_OK', '请输出。')
                .then(function (raw) {
                    $('#lcl2_test2_result').text(String(raw).indexOf('PING_OK') >= 0 ? '✓ 调度员在线。' : '△ 通了，但回话不规矩（选牌解析只搜编号，问题不大）。');
                })
                .catch(function (err) { $('#lcl2_test2_result').text('✗ ' + (err && err.message || err)); });
        });

        $root.on('click', '#lcl2_btn_compile', function () {
            var st = readFormIntoStory();
            if (!st) return toast('请先打开一个聊天', 'warning');
            // 覆盖是不可逆的：已有线索时必须确认，已经送出过的更要说清楚
            if (st.clues.length) {
                var sent = usedCount(st);
                var warn = '重新编译会用新线索【覆盖】现有的 ' + st.clues.length + ' 条';
                warn += sent ? ('（其中 ' + sent + ' 条已经送给玩家了，进度也会一起清零）') : '';
                warn += '。\n\n想保留现有的、只补一批新的，请点「追加」。\n\n确定要覆盖吗？';
                if (!window.confirm(warn)) return;
            }
            readFormIntoSettings();
            compileStory().catch(function () { });
        });

        /* ---- 🐾 习性单 ---- */
        $root.on('click', '#lcl2_habits_gen, #lcl2_habits_retry', function () {
            var st = story();
            if (!st) return toast('请先打开一个聊天', 'warning');
            var h = habitsOf(st);
            if (!habitsEmpty(h) && !window.confirm('会覆盖现有的习性单（你改过的也会没）。确定重抽？')) return;
            readFormIntoSettings();
            generateHabits().catch(function () { });
        });
        $root.on('click', '#lcl2_habits_copy', function () {
            var st = story(); if (!st) return;
            var h = habitsOf(st);
            if (habitsEmpty(h)) return toast('习性单是空的', 'warning');
            copyText(habitsClipboardText(h))
                .then(function () { toast('已复制，粘进你的角色栏就行', 'success'); })
                .catch(function () { toast('复制失败——长按文字手动选吧', 'warning'); });
        });
        $root.on('click', '#lcl2_habits_clear', function () {
            var st = story(); if (!st) return;
            if (!window.confirm('清空习性单？')) return;
            st.habits = blankHabits(); saveStory(); renderHabits(true);
        });
        $root.on('change', '.lcl2-habits-col', function () {
            var st = story(); if (!st) return;
            var h = habitsOf(st);
            var col = String($(this).data('col'));
            var lines = String($(this).val() || '').split(/\n+/);
            var out = [];
            for (var i = 0; i < lines.length; i++) { var t = trim(lines[i]).replace(/^[-·•]\s*/, ''); if (t) out.push(t.slice(0, 80)); }
            h[col] = out;
            saveStory();
        });
        $root.on('blur', '.lcl2-habits-col', function () {
            setTimeout(function () {
                if (habitsDirty && !$('#lcl2_habits').find('textarea:focus').length) renderHabits(true);
            }, 0);
        });

        $root.on('click', '#lcl2_btn_append', function () {
            var st = readFormIntoStory();
            if (!st) return toast('请先打开一个聊天', 'warning');
            if (!st.clues.length) return toast('还没有线索可追加，请先编译', 'warning');
            readFormIntoSettings();
            compileStory({ append: true }).catch(function () { });
        });
        $root.on('click', '#lcl2_btn_stop', function () {
            compileState.cancel = true;
            log('已请求停止，本批完成后停下（草稿会保住）。');
        });
        $root.on('click', '#lcl2_btn_light', lightUp);
        $root.on('click', '#lcl2_btn_off', extinguish);
        $root.on('click', '#lcl2_btn_reveal', function () {
            var st = story();
            if (!st) return toast('请先打开一个聊天', 'warning');
            var left = 0;
            for (var i = 0; i < st.clues.length; i++) if (!st.clues[i].used) left++;
            var warn = '揭底会把完整底牌一次性交给演员，从下一次回复起可以正面揭晓。\n\n这一步不可逆（除非重置进度）。';
            if (left) warn += '\n\n注意：还有 ' + left + ' 条线索没送出，揭底后它们就没有意义了。';
            if (window.confirm(warn + '\n\n确定现在揭底吗？')) revealStory();
        });
        $root.on('click', '#lcl2_btn_rewind', rewindOneRound);
        $root.on('click', '#lcl2_btn_manual', function () { manualDispatch(null); });

        // ✨ 星星点灯
        /* ---- 三幕切页 ---- */
        $root.on('click', '.lcl2-mode', function () {
            var pg = $(this).data('page');
            if (!pg || $(this).prop('disabled')) return;
            switchPage(String(pg));
        });

        /* ---- 第二幕 · 分镜 ---- */
        $root.on('click', '#lcl2_act_add', function () {
            addAct($('#lcl2_act_name').val(), $('#lcl2_act_play').val(), $('#lcl2_act_done').val(), $('#lcl2_act_forbid').val());
            $('#lcl2_act_name, #lcl2_act_play, #lcl2_act_done, #lcl2_act_forbid').val('');
        });
        $root.on('change input', '#lcl2_act_outline', function () {
            var ab = actBook();
            if (ab) { ab.outline = String($(this).val() || ''); saveStory(); }
        });
        $root.on('click', '#lcl2_act_split', function () {
            var ab = actBook();
            if (!ab) return toast('请先打开一个聊天', 'warning');
            ab.outline = String($('#lcl2_act_outline').val() || '');
            if (ab.acts.length) {
                var played = Math.max(0, ab.current_idx + 1);
                var warn = '切星会用新的幕【覆盖】现有的 ' + ab.acts.length + ' 幕';
                warn += played ? ('（其中 ' + played + ' 幕已经演过）') : '';
                warn += '。\n\n想保留现有的、只补几幕，请用下面的「手写追加」。\n\n确定要覆盖吗？';
                if (!window.confirm(warn)) return;
            }
            readFormIntoSettings();
            splitOutline().catch(function () { });
        });
        $root.on('click', '#lcl2_act_reconnect', function () {
            var ab = actBook();
            if (!ab) return;
            ab.outline = String($('#lcl2_act_outline').val() || '');
            var rest = ab.acts.length - (ab.current_idx + 1);
            if (!window.confirm('会重写当前幕之后的 ' + rest + ' 幕，当前幕不动。\n\n确定从这里接上吗？')) return;
            readFormIntoSettings();
            splitOutline({ reconnect: true }).catch(function () { });
        });
        $root.on('click', '.lcl2-act-del', function () {
            removeAct($(this).closest('.lcl2-act').data('id'));
        });
        $root.on('click', '.lcl2-act-move', function () {
            moveAct($(this).closest('.lcl2-act').data('id'), parseInt($(this).data('dir'), 10) || 0);
        });
        $root.on('change', '.lcl2-act-f', function () {
            var ab = actBook(); if (!ab) return;
            var id = $(this).closest('.lcl2-act').data('id');
            var f = String($(this).data('f'));
            // 轮数开演后也能改（临场调节奏是常态）；正文开演后锁死
            if (f !== 'rounds' && ab.locked) return;
            for (var i = 0; i < ab.acts.length; i++) {
                if (ab.acts[i].id === id) {
                    if (f === 'rounds') {
                        ab.acts[i].rounds = clamp(parseInt($(this).val(), 10) || 0, 0, 999);
                    } else {
                        var val = String($(this).val() || '').slice(0, ACT_FIELD_MAX);
                        // 「不准」是原样给演员看的：撞上第一幕的秘密就等于当场泄底
                        if (f === 'forbid') {
                            var hit = forbidLeakCheck(val);
                            if (hit) {
                                toast('这条「不准」里有和第一幕秘密重合的字（' + hit + '），会当场把秘密透给演员。请改成只写行为，例如「这一段两人不能把话说破」。', 'warning');
                                actLog('⚠ 第 ' + (i + 1) + ' 幕的「不准」撞上了第一幕的秘密（' + hit + '），已拦下未保存。');
                                $(this).val(ab.acts[i][f] || '');
                                return;
                            }
                        }
                        ab.acts[i][f] = val;
                        // 正挂着的这一幕被现场改文 → 立即刷新注入（开演前不会走到这，留着以防解锁态的 current_idx 残留）
                        if (i === ab.current_idx && ab.locked) actInjectText(ab.acts[i]);
                    }
                    saveStory();
                    renderActPanel();
                    return;
                }
            }
        });
        $root.on('blur', '.lcl2-act-f', function () {
            setTimeout(function () {
                if (actListDirty && !$('#lcl2_act_list').find('textarea:focus, input:focus').length) renderActPanel(true);
            }, 0);
        });
        $root.on('change input', '#lcl2_act_rounds', function () {
            var ab = actBook();
            if (ab) { ab.default_rounds = clamp(parseInt($(this).val(), 10) || ACT_DEFAULT_ROUNDS, 1, 999); saveStory(); renderActPanel(); }
        });
        $root.on('click', '#lcl2_act_lock', function () {
            var ab = actBook(); if (!ab) return;
            if (ab.locked && ab.finished) {
                if (!window.confirm('重新开演：幕本保留，轮数归零，从第一幕重来。确定？')) return;
                lockActBook(false);
                lockActBook(true);
                return;
            }
            lockActBook(!ab.locked);
        });
        $root.on('click', '#lcl2_act_next', actNext);
        $root.on('click', '#lcl2_act_back', actBack);

        /* ---- 随身须知 ---- */
        $root.on('change input', '#lcl2_brief_text', function () {
            var ab = actBook();
            if (ab) { ab.brief = String($(this).val() || ''); saveStory(); }
        });
        $root.on('change input', '#lcl2_brief_n', function () {
            var ab = actBook();
            if (ab) { ab.brief_rounds = clamp(parseInt($(this).val(), 10) || 1, 1, 10); saveStory(); }
        });
        $root.on('click', '#lcl2_brief_go', fireBrief);
        $root.on('click', '#lcl2_brief_off', function () { clearBrief(); });
        $root.on('click', '#lcl2_btn_conclude', function () {
            if (window.confirm('给这个故事收尾？没发完的线索会安静退场（不删除，作者模式仍可查看）。')) concludeStory();
        });
        $root.on('click', '#lcl2_btn_reset', function () {
            if (window.confirm('把进度归零？线索会完整保留。')) resetProgress();
        });
        $root.on('click', '#lcl2_btn_wipe', function () {
            if (window.confirm('清空本聊天的整个故事（秘密、线索、日志）？此操作不可恢复。')) wipeStory();
        });
        $root.on('click', '#lcl2_btn_test', testConnection);

        // 作者模式：线索编辑与删除
        $root.on('change', '.lcl2-clue-text', function () {
            var st = story();
            if (!st) return;
            var id = $(this).closest('.lcl2-clue').data('id');
            var clue = findClue(st, id);
            if (!clue) return;
            var newText = String($(this).val() || '');
            var vetted = vetClues([newText], st);
            if (!vetted.pass.length) {
                toast('这条改动被安检拦下：' + vetted.rejected[0].reason, 'warning');
                $(this).val(clue.text);
                return;
            }
            clue.text = newText;
            // 台上的线索被现场改文 → 立即刷新注入
            if (st.clock.active_id === id && st.status === 'lit') injectText(newText);
            saveStory();
        });
        // 打字期间被推迟的重建，在失焦后补上（此时抹掉输入框已无害）
        $root.on('blur', '.lcl2-clue-text', function () {
            setTimeout(function () {
                if (clueListDirty && !$('#lcl2_clues').find('textarea:focus').length) renderClueList(true);
            }, 0);
        });

        /* ---- 提示词预设 ---- */

        $root.on('change', '#lcl2_preset_sel', function () {
            settings().prompt_presets.active = String($(this).val() || 'builtin');
            saveSettings();
            renderPromptDrawer(true);
        });

        $root.on('click', '#lcl2_preset_new', function () {
            var st = story();
            var src = activePresetFor(st);
            var base = src ? src.name : '内置';
            var name = window.prompt('新预设叫什么？（从「' + base + '」复制一份）', base + ' 副本');
            if (name === null) return;
            name = trim(name) || (base + ' 副本');
            var fresh = { id: uid('pp'), name: name };
            for (var i = 0; i < PROMPT_SLOTS.length; i++) {
                var k = PROMPT_SLOTS[i];
                fresh[k] = (src && typeof src[k] === 'string') ? src[k] : BUILTIN_PROMPTS[k];
            }
            presetList().push(fresh);
            settings().prompt_presets.active = fresh.id;
            saveSettings();
            toast('已新建「' + name + '」，现在可以改了', 'success');
            renderPromptDrawer(true);
        });

        $root.on('click', '#lcl2_preset_rename', function () {
            var cur = activePresetFor(story());
            if (!cur) return;
            var name = window.prompt('改成什么名字？', cur.name);
            if (name === null) return;
            cur.name = trim(name) || cur.name;
            saveSettings();
            renderPromptDrawer(true);
        });

        $root.on('click', '#lcl2_preset_del', function () {
            var cur = activePresetFor(story());
            if (!cur) return;
            if (!window.confirm('删除预设「' + cur.name + '」？固定用它的故事会自动回到内置。')) return;
            var list = presetList();
            for (var i = 0; i < list.length; i++) {
                if (list[i].id === cur.id) { list.splice(i, 1); break; }
            }
            settings().prompt_presets.active = 'builtin';
            var st = story();
            if (st && st.config.prompt_preset === cur.id) { st.config.prompt_preset = ''; saveStory(); }
            saveSettings();
            toast('已删除', 'info');
            renderPromptDrawer(true);
        });

        $root.on('change', '#lcl2_preset_pin', function () {
            var st = story();
            if (!st) return;
            if ($(this).prop('checked')) {
                var cur = activePresetFor(st);
                if (!cur) {
                    $(this).prop('checked', false);
                    return toast('内置是默认腔调，不需要固定——想固定先新建一个副本', 'info');
                }
                st.config.prompt_preset = cur.id;
                log('本故事已固定使用提示词预设「' + cur.name + '」。');
            } else {
                st.config.prompt_preset = '';
                log('本故事的提示词预设改回跟随全局。');
            }
            saveStory();
            renderPromptDrawer(true);
        });

        $root.on('change', '.lcl2-slot-text', function () {
            var cur = activePresetFor(story());
            if (!cur) return;   // 内置只读
            var slot = $(this).closest('.lcl2-slot').data('slot');
            var val = String($(this).val() || '');
            // 注入模板缺 {{线索}} 等于空注入，故事照跑但一条都送不出去——这种坑必须拦
            if (slot === 'inject' && val.indexOf('{{线索}}') < 0) {
                toast('注入模板必须包含 {{线索}}，否则线索送不出去。已还原这一格。', 'warning');
                $(this).val(cur.inject || BUILTIN_PROMPTS.inject);
                return;
            }
            cur[slot] = val;
            saveSettings();
            if (slot === 'compiler' && val.indexOf('{{力度}}') < 0) {
                toast('这一格删掉了 {{力度}}，「线索力度」下拉框对编译将不再起作用', 'info');
            }
            renderPromptDrawer(true);
        });

        $root.on('click', '.lcl2-slot-reset', function () {
            var cur = activePresetFor(story());
            if (!cur) return;
            var slot = $(this).closest('.lcl2-slot').data('slot');
            cur[slot] = BUILTIN_PROMPTS[slot];
            saveSettings();
            renderPromptDrawer(true);
        });

        // 打字期间被推迟的重建，失焦后补上
        $root.on('blur', '.lcl2-slot-text', function () {
            setTimeout(function () {
                if (promptSlotsDirty && !$('#lcl2_prompt_slots').find('textarea:focus').length) renderPromptDrawer(true);
            }, 0);
        });

        /* 调序：池子顺序即发牌顺序（顺序档），也是分层洗牌的切段依据。
         * 已送出的不参与调序——它已经在故事里了，挪位置没有意义还会让人误会。 */
        $root.on('click', '.lcl2-clue-move', function () {
            var st = story();
            if (!st) return;
            var id = $(this).closest('.lcl2-clue').data('id');
            var dir = parseInt($(this).data('dir'), 10) || 0;
            var from = -1, i;
            for (i = 0; i < st.clues.length; i++) if (st.clues[i].id === id) { from = i; break; }
            if (from < 0) return;
            if (st.clues[from].used) return toast('已送出的线索不能挪位置', 'info');
            var to = from + dir;
            if (to < 0 || to >= st.clues.length) return;
            if (st.clues[to].used) return toast('不能挪到已送出的线索之前', 'info');
            var tmp = st.clues[from]; st.clues[from] = st.clues[to]; st.clues[to] = tmp;
            // 顺序档的发牌序就是池子顺序，跟着一起换；随机/分层档的序是独立的，不动
            if ((st.config.order_mode || 'sequential') === 'sequential' && isArray(st.clock.order)) {
                st.clock.order = st.clues.map(function (c) { return c.id; });
            }
            saveStory();
            renderClueList(true);
        });

        $root.on('click', '.lcl2-clue-fire', function () {
            var id = $(this).closest('.lcl2-clue').data('id');
            manualDispatch(id);
        });
        $root.on('click', '.lcl2-clue-del', function () {
            var st = story();
            if (!st) return;
            var id = $(this).closest('.lcl2-clue').data('id');
            if (st.clock.active_id === id) return toast('这条正在台上，先熄灭或等它退场再删', 'warning');
            for (var i = 0; i < st.clues.length; i++) {
                if (st.clues[i].id === id) { st.clues.splice(i, 1); break; }
            }
            st.clock.cursor = usedCount(st);
            saveStory();
            renderPanel();
        });
    }


    /* ================================================================
     * 10. ✨ 星星点灯（第二幕 · 分镜成长）
     *
     *  用户是编剧，把角色的一生切成几段「幕」，交给小萤火按顺序挂上去。
     *  小萤火每隔几轮抬一次头，读最近剧情，判断该不该进下一幕。
     *
     *  与第一幕的根本差别 —— 第一幕是「发」，这一幕是「挂」：
     *    线索一条条累积，送出去的还留在故事里；
     *    幕本同一时刻只有一块挂着，换下来的必须真的消失，
     *    不消失就等于把整条时间线一次性全给了模型，梯度当场塌掉。
     *
     *  为什么这样有效：角色卡是一整块塞给模型的，没有时间轴——
     *  写着「18-27 开朗，30 后心狠手辣」，模型读到的是一个
     *  「开朗过、变过、现在心狠手辣」的人，全部特质同时在线，
     *  开局第一句就带着狠劲。挂幕本时模型上下文里根本没有后面那几段，
     *  它演不出来，不是被压着不演，是真的不知道。这比任何
     *  「请循序渐进」的指令都硬。
     *
     *  四条规矩：
     *   1. 同一时刻只有一幕挂着（换幕 = 覆盖注入，旧的自动没）
     *   2. 只准前进不准后退（AI 判断一定会错；后退只能由人手动）
     *   3. 换幕必须留痕（哪一轮、从哪一幕到哪一幕、为什么）
     *   4. 注入末尾强制附降温语（防止模型拿到走向就当场兑现）
     * ================================================================ */

    var ACT_MAX = 12;           // 一条时间线切到 12 段已经很细了
    var ACT_FIELD_MAX = 600;
    var ACT_DEFAULT_ROUNDS = 6;

    /* 降温语：写死，不进用户可编辑区。
     * 模型刚拿到一个明确的戏剧目标（比如「这一段玩追妻火葬场」）
     * 天然想立刻兑现——第一句就让男主跪下。踩过一次就知道多疼。 */
    var ACT_COOLDOWN = '这是本段的走向，不是本回合的任务。让它自然长出来，不要急于兑现。';

    function blankActBook() {
        return {
            v: 3,                 // v1 愿望星图（废弃）；v2 分镜成长（手写+领航员预留）；v3 轮钟+切星
            locked: false,
            outline: '',          // 玩家扔进来的大纲原文——只进编译请求，永不注入
            default_rounds: ACT_DEFAULT_ROUNDS,   // 全局默认每幕几轮
            s_round: 0,
            current_idx: -1,      // 当前挂着第几幕（-1 = 还没开幕）
            act_entered_round: 0, // 当前幕是第几轮挂上的（算「本幕已演几轮」用）
            finished: false,      // 最后一幕演满 → 落幕态（幕本仍挂着，不撤）
            acts: [],
            brief: '',            // 随身须知正文（一次性注入用）
            brief_rounds: 1,      // 按一次管几轮
            brief_left: 0,        // 还剩几轮有效
            ledger: []            // 第二幕自己的流水，与第一幕分家
        };
    }

    /* v2 → v3 轻迁移：v3.0 用户可能已手写了幕本，不能零迁移。
     * 「进场条件」原是给领航员判的，现在没有领航员，语义并进上一幕的「到位」。 */
    function migrateActBookV2(ab) {
        var acts = isArray(ab.acts) ? ab.acts : [];
        for (var i = 0; i < acts.length; i++) {
            var a = acts[i];
            if (i > 0 && trim(a.enter) && !trim(acts[i - 1].done)) acts[i - 1].done = trim(a.enter);
            delete a.enter;
            if (typeof a.done !== 'string') a.done = '';
            if (typeof a.forbid !== 'string') a.forbid = '';
            if (typeof a.rounds !== 'number') a.rounds = 0;
            if (!a.source) a.source = 'hand';
        }
        var fresh = blankActBook();
        fresh.locked = !!ab.locked;
        fresh.default_rounds = clamp(parseInt(ab.interval, 10) || ACT_DEFAULT_ROUNDS, 1, 999);
        fresh.s_round = parseInt(ab.s_round, 10) || 0;
        fresh.current_idx = typeof ab.current_idx === 'number' ? ab.current_idx : -1;
        fresh.act_entered_round = fresh.s_round;
        fresh.acts = acts;
        fresh.brief = typeof ab.brief === 'string' ? ab.brief : '';
        fresh.brief_rounds = parseInt(ab.brief_rounds, 10) || 1;
        fresh.brief_left = parseInt(ab.brief_left, 10) || 0;
        fresh.ledger = isArray(ab.ledger) ? ab.ledger : [];
        pushLog(fresh.ledger, '幕本已升级到 v3：「进场条件」并入上一幕的「到位」，每幕新增「不准」与「本幕轮数」——请给每幕补上「不准」。');
        return fresh;
    }

    function actBook() {
        var st = story();
        if (!st) return null;
        if (isObject(st.act_book) && st.act_book.v === 2) {
            st.act_book = migrateActBookV2(st.act_book);
            saveStory();
        } else if (!isObject(st.act_book) || st.act_book.v !== 3) {
            // v1 愿望星图不做迁移：数据形状与心智模型都不同。旧数据原样留在账本里不动。
            st.act_book = blankActBook();
        }
        var ab = st.act_book;
        if (!isArray(ab.acts)) ab.acts = [];
        if (!isArray(ab.ledger)) ab.ledger = [];
        if (typeof ab.brief !== 'string') ab.brief = '';
        if (typeof ab.outline !== 'string') ab.outline = '';
        if (typeof ab.default_rounds !== 'number') ab.default_rounds = ACT_DEFAULT_ROUNDS;
        if (typeof ab.act_entered_round !== 'number') ab.act_entered_round = 0;
        return ab;
    }

    function currentAct(ab) {
        if (!ab || ab.current_idx < 0 || ab.current_idx >= ab.acts.length) return null;
        return ab.acts[ab.current_idx];
    }

    function actNeedRounds(ab, act) {
        var own = act && parseInt(act.rounds, 10);
        if (own > 0) return clamp(own, 1, 999);
        return clamp(parseInt(ab.default_rounds, 10) || ACT_DEFAULT_ROUNDS, 1, 999);
    }

    function actPlayed(ab) {
        return Math.max(0, (parseInt(ab.s_round, 10) || 0) - (parseInt(ab.act_entered_round, 10) || 0));
    }

    function actLog(msg) {
        var ab = actBook();
        if (!ab) return;
        pushLog(ab.ledger, msg);
        saveStory();
        renderLogSoon();
    }

    /* ---- 三条注入通道各管各的 ----
     * 线索（第一幕，一次性）／幕本（第二幕，常驻）／须知（一次性，手动）
     * 绝不能合并：正挂着「巨变」时按一下须知，如果共用通道就会把布景冲掉。 */

    function actInject(text) {
        var c = ctx();
        var depth = clamp(parseInt(settings().depth, 10) || 1, 0, 20);
        try { c.setExtensionPrompt(INJECT_KEY_ACT, text, 1, depth + 1, false, 0); }
        catch (e) {
            try { c.setExtensionPrompt(INJECT_KEY_ACT, text, 1, depth + 1); }
            catch (e2) { log('✗ 幕本注入口调用失败：' + (e2 && e2.message || e2)); }
        }
    }
    function actClearInjection() { actInject(''); }

    function briefInject(text) {
        var c = ctx();
        var depth = clamp(parseInt(settings().depth, 10) || 1, 0, 20);
        try { c.setExtensionPrompt(INJECT_KEY_BRIEF, text, 1, depth, false, 0); }
        catch (e) {
            try { c.setExtensionPrompt(INJECT_KEY_BRIEF, text, 1, depth); }
            catch (e2) { log('✗ 须知注入口调用失败：' + (e2 && e2.message || e2)); }
        }
    }
    function briefClearInjection() { briefInject(''); }

    /* 幕本注入正文。常驻——挂上去就一直在，直到被下一幕覆盖或手动撤下。
     * 演员只看当前这颗星：不给上一幕、不给下一幕、也不给「到位」——
     * 到位是给人看进度的，给演员看等于告诉它该翻页了。 */
    /* 两幕各写各的账本，谁也不知道谁在藏什么。
     * 这道闸让它们对上话：「不准」里若出现了第一幕秘密的原文片段，
     * 说明这一栏正在把秘密写给演员看——拦下，让用户改成行为句。 */
    function forbidLeakCheck(text) {
        var st = story();
        var secret = st && trim(st.hidden_secret);
        var body = trim(text);
        if (!secret || body.length < 6) return null;
        var flatS = secret.replace(/\s+/g, '');
        var flatB = body.replace(/\s+/g, '');
        var W = 6;   // 六字连续重合即判泄漏——「不准」是原样给演员看的，比线索严
        for (var i = 0; i + W <= flatB.length; i++) {
            var frag = flatB.substr(i, W);
            if (flatS.indexOf(frag) >= 0) return frag;
        }
        return null;
    }

    function actInjectText(act) {
        if (!act) return actClearInjection();
        var parts = ['【本段设定 · 常驻】'];
        if (trim(act.name)) parts.push('当前阶段：' + trim(act.name));
        if (trim(act.play)) parts.push(trim(act.play));
        if (trim(act.forbid)) {
            parts.push('');
            // 措辞用「边界」不用「不会发生」——后者是在陈述世界，前者是在划线。
            // 模型对否定句本来就弱，说「不准 X」反而让 X 更显眼，所以只放行为边界。
            parts.push('本段的边界（演到这里为止，不要越过）：');
            parts.push(trim(act.forbid));
        }
        parts.push('');
        parts.push(ACT_COOLDOWN);
        var text = parts.join('\n');
        if (hasResidualMacro(text)) {
            actLog('⚠ 幕本里有残留宏，已拦下改为空注入。请检查这一幕的文字。');
            return actClearInjection();
        }
        actInject(text);
    }

    /* 换幕。只准前进；后退必须显式 force（只有手动撤回会传） */
    function gotoAct(idx, why, force) {
        var ab = actBook();
        if (!ab) return false;
        if (idx < -1 || idx >= ab.acts.length) return false;
        if (!force && idx <= ab.current_idx) return false;   // 规矩 2
        var from = currentAct(ab);
        ab.current_idx = idx;
        ab.act_entered_round = ab.s_round;   // 本幕已演从 0 起算（手动推进/撤回同样重置）
        if (force) ab.finished = false;
        var to = currentAct(ab);
        actInjectText(to);
        // 规矩 3：换幕必须留痕
        actLog('第 ' + ab.s_round + ' 轮：'
            + (from ? ('撤下「' + from.name + '」，') : '')
            + (to ? ('挂上「' + to.name + '」') : '幕本已全部撤下')
            + (why ? ('——' + why) : '') + '。');
        saveStory();
        return true;
    }

    /* ---- 随身须知：一次性，手动，第三条通道 ---- */

    function briefText(body) {
        return ['【本回合内部须知 · 不得出现在正文】', body, '',
            '用途：仅用于把角色演准。禁止任何一方说破，禁止解释来由。',
            '本回合只需自然流露，不要制造揭示时刻。'].join('\n');
    }

    function fireBrief() {
        var ab = actBook();
        if (!ab) return toast('请先打开一个聊天', 'warning');
        var body = trim(ab.brief);
        if (!body) return toast('随身须知还是空的——先把内容写好', 'warning');
        var n = clamp(parseInt(ab.brief_rounds, 10) || 1, 1, 10);
        var text = briefText(body);
        if (hasResidualMacro(text)) return toast('须知里有残留宏，已拦下', 'warning');
        briefInject(text);
        ab.brief_left = n;
        saveStory();
        actLog('随身须知已就位，管 ' + n + ' 轮。');
        toast('须知已就位（管 ' + n + ' 轮）', 'success');
        renderActPanel();
    }

    function clearBrief(silent) {
        var ab = actBook();
        if (!ab) return;
        ab.brief_left = 0;
        briefClearInjection();
        saveStory();
        if (!silent) { actLog('随身须知已撤下。'); renderActPanel(); }
    }

    /* ---- 生命周期：轮钟翻页 ---- */

    function actOnUserMessage() {
        var ab = actBook();
        if (!ab || !ab.locked) return;

        ab.s_round += 1;

        // 须知按轮递减。注意是在轮钟前进之后算——
        // 「管 1 轮」= 按下之后的那一次回复，用完即撤。
        if (ab.brief_left > 0) {
            ab.brief_left -= 1;
            if (ab.brief_left <= 0) {
                briefClearInjection();
                actLog('随身须知已用完，自动撤下。');
            }
        }

        // 还没开幕 → 第一条消息就把第一幕挂上
        if (ab.current_idx < 0 && ab.acts.length) {
            gotoAct(0, '故事开场');
            renderActPanel();
            return;
        }

        // 轮钟：本幕演满 → 自动翻页；最后一幕演满 → 落幕（幕本仍挂着）
        var cur = currentAct(ab);
        if (cur) {
            var need = actNeedRounds(ab, cur);
            if (actPlayed(ab) >= need) {
                if (ab.current_idx + 1 < ab.acts.length) {
                    gotoAct(ab.current_idx + 1, '演满 ' + need + ' 轮，自动翻页');
                } else if (!ab.finished) {
                    ab.finished = true;
                    actLog('第 ' + ab.s_round + ' 轮：最后一幕演满，落幕。幕本仍挂着——撤了演员会掉回角色卡的全量态。');
                    toast('🌠 走完了最后一幕', 'info');
                }
            }
        }
        saveStory();
        renderActPanel();
    }

    function actOnAiMessage() { /* 幕本常驻，回复落地无需簿记；留桩以对齐三幕结构 */ }

    /* 切聊天后注入位会被清空，当前幕必须重新挂回去——
     * 这正是「常驻」与第一幕「一次性」最容易出岔子的地方。 */
    function actOnChatChanged() {
        actClearInjection();
        briefClearInjection();
        var ab = actBook();
        if (!ab || !ab.locked) return;
        var cur = currentAct(ab);
        if (cur) actInjectText(cur);
        if (ab.brief_left > 0 && trim(ab.brief)) briefInject(briefText(trim(ab.brief)));
    }

    /* ---- 幕本增删改 ---- */

    function blankAct(name, play, done, forbid, source) {
        return {
            id: uid('act'),
            name: trim(name).slice(0, 60),
            play: trim(play).slice(0, ACT_FIELD_MAX),
            done: trim(done).slice(0, 200),
            forbid: trim(forbid).slice(0, 300),
            rounds: 0,
            source: source || 'hand'
        };
    }

    function addAct(name, play, done, forbid) {
        var ab = actBook();
        if (!ab) return toast('请先打开一个聊天', 'warning');
        if (ab.locked) return toast('已开演，先收起才能改幕本', 'warning');
        name = trim(name).slice(0, 60);
        if (!name) return toast('给这一幕起个名字，比如「18-27 少年」', 'warning');
        if (ab.acts.length >= ACT_MAX) return toast('最多 ' + ACT_MAX + ' 幕，够细了', 'warning');
        ab.acts.push(blankAct(name, play, done, forbid, 'hand'));
        saveStory();
        actLog('新增一幕：' + name + '（共 ' + ab.acts.length + ' 幕）。');
        renderActPanel(true);
    }

    function removeAct(id) {
        var ab = actBook();
        if (!ab || ab.locked) return toast('已开演，先收起才能改幕本', 'warning');
        for (var i = 0; i < ab.acts.length; i++) {
            if (ab.acts[i].id === id) {
                var nm = ab.acts[i].name;
                ab.acts.splice(i, 1);
                if (ab.current_idx >= ab.acts.length) ab.current_idx = ab.acts.length - 1;
                saveStory();
                actLog('删除了一幕：' + nm + '。');
                renderActPanel(true);
                return;
            }
        }
    }

    function moveAct(id, dir) {
        var ab = actBook();
        if (!ab || ab.locked) return toast('已开演，先收起才能调整顺序', 'warning');
        var from = -1, i;
        for (i = 0; i < ab.acts.length; i++) if (ab.acts[i].id === id) { from = i; break; }
        if (from < 0) return;
        var to = from + dir;
        if (to < 0 || to >= ab.acts.length) return;
        var t = ab.acts[from]; ab.acts[from] = ab.acts[to]; ab.acts[to] = t;
        saveStory();
        renderActPanel(true);
    }

    function lockActBook(lock) {
        var ab = actBook();
        if (!ab) return toast('请先打开一个聊天', 'warning');
        if (lock && !ab.acts.length) return toast('至少有一幕才能开演', 'warning');
        ab.locked = !!lock;
        ab.s_round = 0;
        ab.act_entered_round = 0;
        ab.current_idx = -1;
        ab.finished = false;
        actClearInjection();
        if (lock) {
            actLog('分镜已开演，共 ' + ab.acts.length + ' 幕，默认每幕 ' + ab.default_rounds + ' 轮。你的下一次行动，第一幕就挂上。');
            toast('分镜已开演', 'success');
        } else {
            actLog('分镜已收起，幕本可以继续改。');
        }
        saveStory();
        renderActPanel(true);
    }

    function actNext() {
        var ab = actBook();
        if (!ab || !ab.locked) return toast('先开演才能推进', 'warning');
        if (ab.current_idx + 1 >= ab.acts.length) return toast('已经是最后一幕了', 'info');
        gotoAct(ab.current_idx + 1, '你手动推进');
        renderActPanel(true);
    }

    /* 撤回上一幕：轮钟一定会有翻早的时候，关键是错了能一秒钮回来。
     * 这是唯一允许后退的入口，且必须由人点。 */
    function actBack() {
        var ab = actBook();
        if (!ab || !ab.locked) return;
        if (ab.current_idx <= 0) return toast('已经是第一幕了', 'info');
        gotoAct(ab.current_idx - 1, '你手动撤回', true);
        renderActPanel(true);
    }

    /* ---- 切星：大纲 → 幕（编译连接）---- */

    var splitState = { running: false };

    function parseActsJson(rawText) {
        var raw = trim(rawText).replace(/^```(?:json)?/i, '').replace(/```$/, '');
        var jsonText = recoverJsonObject(raw) || raw;
        var data;
        try { data = JSON.parse(jsonText); }
        catch (e) { throw new Error('模型输出无法解析为 JSON（前 80 字）：' + raw.slice(0, 80)); }
        var list = data && data.acts;
        if (!isArray(list)) throw new Error('模型输出里没有 acts 数组（前 80 字）：' + raw.slice(0, 80));
        var out = [];
        var leaked = 0;
        for (var i = 0; i < list.length; i++) {
            var a = list[i] || {};
            var play = trim(a.play);
            if (!play) continue;
            var name = trim(a.name) || ('第 ' + (out.length + 1) + ' 幕');
            var act = blankAct(name, play, a.done, isArray(a.forbid) ? a.forbid.join('；') : a.forbid, 'compiled');
            if (hasResidualMacro(act.play + act.forbid + act.name)) continue;
            // 切星的模型未必听话：「不准」里若写进了第一幕的秘密，原样注给演员就是当场泄底。
            // 这里只摘掉那一栏，不废整幕——幕本还有用，用户补一条行为边界即可。
            var leak = forbidLeakCheck(act.forbid);
            if (leak) {
                act.forbid = '';
                leaked++;
            }
            out.push(act);
            if (out.length >= ACT_MAX) break;
        }
        if (out.length < 2) throw new Error('切出来的幕少于 2 幕，整批作废。');
        if (leaked) actLog('⚠ 有 ' + leaked + ' 幕的「不准」写进了第一幕的秘密，已清空那一栏——请自己补一条只写行为的边界（例：这一段两人不能把话说破）。');
        return out;
    }

    function splitterUserPrompt(ab, materials, wantCount, reconnectFrom) {
        var parts = [];
        if (reconnectFrom) {
            parts.push('故事已经演到下面这里，和原计划有了偏差。不要把它拽回原路。保留原大纲里还没演的目标，从当前现场重新切剩下的幕，让它自然接上。已经演过的幕不要重写。');
            var done = [];
            for (var i = 0; i <= ab.current_idx && i < ab.acts.length; i++) done.push((i + 1) + '. ' + ab.acts[i].name + '：' + ab.acts[i].play);
            if (done.length) parts.push('【已经演过的幕（不要重写，只作为来路）】\n' + done.join('\n'));
            var rest = [];
            for (var j = ab.current_idx + 1; j < ab.acts.length; j++) rest.push((j - ab.current_idx) + '. ' + ab.acts[j].name + '：' + ab.acts[j].play);
            if (rest.length) parts.push('【原计划剩下的幕（目标保留，切法可以全改）】\n' + rest.join('\n'));
        }
        parts.push('【玩家写的脉络】\n' + ab.outline);
        if (materials.card) parts.push('【角色与开场设定】\n' + materials.card);
        if (materials.story) parts.push('【最近正文】\n' + materials.story
            + '\n\n这段正文只用于了解已发生的事实和故事现在走到哪——不要据此锁定场景。');
        parts.push(wantCount > 0
            ? ('请切成 ' + wantCount + ' 幕。输出 {"acts":[...]}。')
            : '幕数由你定（3～12）。输出 {"acts":[...]}。');
        return parts.join('\n\n');
    }

    function splitOutline(opts) {
        var reconnect = !!(opts && opts.reconnect);
        var ab = actBook();
        var st = story();
        if (!ab || !st) return Promise.reject(new Error('请先打开一个聊天。'));
        if (splitState.running) return Promise.reject(new Error('正在切星，稍等。'));
        if (!trim(ab.outline)) return Promise.reject(new Error('大纲还是空的——先把你想玩的脉络扔进来。'));
        if (!reconnect && ab.locked) return Promise.reject(new Error('已开演。想重切请先收起分镜；想在现场接上请用「从这里接上」。'));
        if (reconnect && (!ab.locked || ab.current_idx < 0)) return Promise.reject(new Error('「从这里接上」要在开演并挂上第一幕之后用。'));
        var wantCount = clamp(parseInt($('#lcl2_act_want').val(), 10) || 0, 0, ACT_MAX);

        splitState.running = true;
        setSplitUi(true, reconnect ? '正在从现场重切后面的幕……' : '正在读大纲、切星……');
        var homeToken = chatToken();
        function assertHome() {
            if (chatChangedSince(homeToken)) throw new Error('切星期间切换了聊天，本次作废。');
        }
        var materials = { card: '', story: '' };
        return Promise.resolve().then(function () {
            assertHome();
            materials.card = characterCardText(3000);
            materials.story = recentStoryText(40, 8000).text;
            return callCompilerApi(
                buildPrompt('splitter', st),
                splitterUserPrompt(ab, materials, wantCount, reconnect),
                function (chars) { setSplitUi(true, '模型书写中，已接收 ' + chars + ' 字……'); }
            );
        }).then(function (raw) {
            assertHome();
            var acts = parseActsJson(raw);
            if (reconnect) {
                var keep = ab.acts.slice(0, ab.current_idx + 1);
                var room = ACT_MAX - keep.length;
                ab.acts = keep.concat(acts.slice(0, Math.max(0, room)));
                ab.finished = false;
                actLog('第 ' + ab.s_round + ' 轮：从这里接上，重切了后 ' + (ab.acts.length - keep.length) + ' 幕，当前幕不动。');
                toast('已从现场接上，后 ' + (ab.acts.length - keep.length) + ' 幕重切', 'success');
            } else {
                ab.acts = acts;
                ab.current_idx = -1;
                ab.finished = false;
                actLog('切星完成：大纲切成 ' + acts.length + ' 幕，每幕都带「不准」。过一眼再开演。');
                toast('切成 ' + acts.length + ' 幕', 'success');
            }
            saveStory();
            splitState.running = false;
            setSplitUi(false, '');
            renderActPanel(true);
        }).catch(function (err) {
            splitState.running = false;
            setSplitUi(false, '');
            var msg = (err && err.message) || String(err);
            if (!chatChangedSince(homeToken)) actLog('✗ 切星失败：' + msg);
            toast('切星失败：' + msg, 'error');
            renderActPanel(true);
            throw err;
        });
    }

    function setSplitUi(running, text) {
        $('#lcl2_act_split, #lcl2_act_reconnect').prop('disabled', running);
        $('#lcl2_act_split_state').text(text || '');
    }

    /* ---- 面板 ---- */

    var actListDirty = false;

    function renderActPanel(force) {
        var $host = $('#lcl2_act_list');
        if (!$host.length) return;
        var ab = actBook();
        if (!ab) { $host.html('<div class="lcl2-dim">（请先打开一个聊天）</div>'); $('#lcl2_act_map').html(''); return; }

        var cur = currentAct(ab);
        var statusText;
        if (!ab.locked) statusText = '还没开演 · 已有 ' + ab.acts.length + ' 幕';
        else if (ab.finished) statusText = '🌠 走完了。' + ab.acts.length + ' 幕，' + ab.s_round + ' 轮。幕本仍挂着最后一幕。';
        else if (cur) statusText = '第 ' + (ab.current_idx + 1) + '/' + ab.acts.length + ' 幕「' + cur.name + '」 · 本幕已演 ' + actPlayed(ab) + '/' + actNeedRounds(ab, cur) + ' 轮';
        else statusText = '已开演 · 你的下一次行动，第一幕就挂上';
        $('#lcl2_act_status').text(statusText);
        $('#lcl2_act_lock').text(ab.locked ? (ab.finished ? '✨ 重新开演' : '收起分镜') : '✨ 开演');
        $('#lcl2_act_next').prop('disabled', !ab.locked || ab.current_idx + 1 >= ab.acts.length);
        $('#lcl2_act_back').prop('disabled', !ab.locked || ab.current_idx <= 0);
        $('#lcl2_act_reconnect').prop('disabled', !ab.locked || ab.current_idx < 0 || splitState.running);
        $('#lcl2_act_split').prop('disabled', ab.locked || splitState.running);
        $('#lcl2_act_mist').prop('disabled', true);
        $('#lcl2_act_end').toggle(!!ab.finished);
        fillIfIdle('#lcl2_act_rounds', ab.default_rounds);
        fillIfIdle('#lcl2_act_outline', ab.outline);
        fillIfIdle('#lcl2_brief_text', ab.brief);
        fillIfIdle('#lcl2_brief_n', ab.brief_rounds);
        $('#lcl2_brief_state').text(ab.brief_left > 0
            ? ('须知生效中，还剩 ' + ab.brief_left + ' 轮')
            : '须知未挂载');
        $('#lcl2_brief_off').prop('disabled', ab.brief_left <= 0);

        renderActMap(ab);

        if (!force && $host.find('textarea:focus, input:focus').length) { actListDirty = true; return; }
        actListDirty = false;

        if (!ab.acts.length) {
            $host.html('<div class="lcl2-dim">（还没有幕。上面扔一段大纲点「切成星」，或者在下面自己一幕一幕写。同一时刻只有一幕会挂给模型，后面的它根本看不见。）</div>');
            return;
        }

        var html = '';
        for (var i = 0; i < ab.acts.length; i++) {
            var a = ab.acts[i];
            var isCur = (i === ab.current_idx);
            var isPast = (i < ab.current_idx);
            var badge = isCur ? '<span class="lcl2-badge lcl2-badge-active">挂着</span>'
                : isPast ? '<span class="lcl2-badge lcl2-badge-used">已过</span>'
                    : '<span class="lcl2-badge">待上</span>';
            var ro = ab.locked ? ' readonly' : '';
            html += '<div class="lcl2-act' + (isCur ? ' lcl2-act-on' : '') + '" data-id="' + esc(a.id) + '">'
                + '<div class="lcl2-clue-head">第 ' + (i + 1) + ' 幕 ' + badge
                + (a.source === 'compiled' ? '<span class="lcl2-dim" style="margin-left:6px">切星</span>' : '')
                + (ab.locked ? '' : '<span class="lcl2-act-move" data-dir="-1" title="上移">↑</span>'
                    + '<span class="lcl2-act-move" data-dir="1" title="下移">↓</span>'
                    + '<span class="lcl2-act-del" title="删除这一幕">✕</span>')
                + '</div>'
                + '<div class="lcl2-act-row">'
                + '<input class="lcl2-act-f text_pole" data-f="name" value="' + esc(a.name) + '" placeholder="幕名，例：27-30 巨变"' + ro + '>'
                + '<input class="lcl2-act-f text_pole lcl2-act-rounds" data-f="rounds" type="number" min="0" max="999" value="' + (a.rounds > 0 ? a.rounds : '') + '" placeholder="轮数(空=全局)" title="本幕轮数，空 = 跟全局默认">'
                + '</div>'
                + '<label class="lcl2-label">演什么 + 想要什么戏（演员只看得到这一格和「不准」）</label>'
                + '<textarea class="lcl2-act-f text_pole" data-f="play" rows="4" placeholder="例：硬壳还没长好——警觉，但还会露出旧的柔软，两种质地在打架。这一段开始铺追妻火葬场：他开始后悔，她不接。"' + ro + '>' + esc(a.play) + '</textarea>'
                + '<label class="lcl2-label">不准（这一段绝对不能发生的事，拦演员抢跑的闸）</label>'
                + '<textarea class="lcl2-act-f text_pole" data-f="forbid" rows="2" placeholder="例：不准男主发现孩子是他的；不准任何一方先低头"' + ro + '>' + esc(a.forbid) + '</textarea>'
                + '<label class="lcl2-label">到位（演到什么算完——只给你看进度，不给演员）</label>'
                + '<textarea class="lcl2-act-f text_pole" data-f="done" rows="1" placeholder="例：她做了离开的决定"' + ro + '>' + esc(a.done) + '</textarea>'
                + '</div>';
        }
        $host.html(html);
    }

    /* 🌠 星图：进度，不是剧本。每幕一行，轮次区间从流水里推。 */
    function renderActMap(ab) {
        var $map = $('#lcl2_act_map');
        if (!$map.length) return;
        if (!ab.acts.length) { $map.html('<div class="lcl2-dim">（还没有星）</div>'); return; }
        // 从 ledger 推每幕的进入轮：匹配「第 N 轮：…挂上「幕名」」
        var enterRound = {};
        for (var k = 0; k < ab.ledger.length; k++) {
            var line = String(ab.ledger[k] && ab.ledger[k].msg || ab.ledger[k] || '');
            var m = line.match(/第 (\d+) 轮：.*挂上「([^」]+)」/);
            if (m) enterRound[m[2]] = parseInt(m[1], 10);
        }
        var html = '<div class="lcl2-map">';
        for (var i = 0; i < ab.acts.length; i++) {
            var a = ab.acts[i];
            var mark = i < ab.current_idx ? '✓' : i === ab.current_idx ? '✦' : '·';
            var cls = i < ab.current_idx ? 'lcl2-map-past' : i === ab.current_idx ? 'lcl2-map-cur' : 'lcl2-map-todo';
            var from = enterRound[a.name];
            var to = null;
            if (from != null) {
                var next = ab.acts[i + 1];
                if (next && enterRound[next.name] != null) to = enterRound[next.name];
                else if (i === ab.current_idx) to = ab.s_round;
            }
            var span = from != null ? ('第 ' + from + (to != null && to !== from ? '～' + to : '') + ' 轮') : '';
            html += '<div class="lcl2-map-row ' + cls + '"><span class="lcl2-map-mark">' + mark + '</span>'
                + '<span class="lcl2-map-name">' + (i + 1) + ' · ' + esc(a.name) + '</span>'
                + '<span class="lcl2-map-span">' + esc(span) + '</span></div>';
        }
        html += '</div>';
        $map.html(html);
    }
    /* ================================================================
     * 9. 启动
     * ================================================================ */

    function mountPanel() {
        var $body = $('body');
        if (!$body.length) return false;
        if (!$('#' + PANEL_ID).length) {
            $body.append(panelHtml());
            bindPanelEvents();
        }
        makeFloater();
        makeSettingsEntry();
        makeWandEntry();
        applyTheme();
        renderPanel();
        return true;
    }

    /* 萤火虫浮标：默认停在 #sheld 右下，可拖动；
     * 结构与停泊属性兼容避风塘（Harbor Bar 会将其收进 #extensionHarborDock）。 */
    function makeFloater() {
        if ($('#lcl2_floater').length) return;
        var host = $('#sheld');
        var el = $('<div id="lcl2_floater" class="lcl2-floater" title="小萤火"></div>');
        if (!host.length) { host = $('body'); el.addClass('lcl2-floater-fixed'); }
        el.append('<span class="lcl2-firefly" aria-hidden="true"></span>');
        host.append(el);
        if (!settings().show_floater) el.hide();

        var dragging = false, moved = false, ox = 0, oy = 0;
        function start(x, y) { dragging = true; moved = false; var off = el.offset(); ox = x - off.left; oy = y - off.top; }
        function move(x, y) {
            if (!dragging) return;
            // 被避风塘停泊时不允许拖走
            if (el.closest('#extensionHarborDock').length) { dragging = false; return; }
            moved = true;
            el.css({ left: (x - ox) + 'px', top: (y - oy) + 'px', right: 'auto', bottom: 'auto' });
        }
        function end() { if (dragging && !moved) togglePanel(); dragging = false; }
        el.on('mousedown', function (e) { start(e.pageX, e.pageY); e.preventDefault(); });
        $(document).on('mousemove.lcl2', function (e) { move(e.pageX, e.pageY); }).on('mouseup.lcl2', end);
        el.on('touchstart', function (e) { var t = e.originalEvent.touches[0]; start(t.pageX, t.pageY); });
        el.on('touchmove', function (e) { var t = e.originalEvent.touches[0]; move(t.pageX, t.pageY); e.preventDefault(); });
        el.on('touchend', end);
    }

    /* 扩展设置区只留一个两行小入口，避免长内容与其他扩展叠版 */
    function makeSettingsEntry() {
        if ($('#lcl2_drawer').length) return;
        var $host = $('#extensions_settings2');
        if (!$host.length) $host = $('#extensions_settings');
        if (!$host.length) return;
        $host.append(
            '<div id="lcl2_drawer" class="inline-drawer">' +
            '  <div class="inline-drawer-toggle inline-drawer-header"><b>🪇 小萤火 ' + VERSION + '</b>' +
            '    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div></div>' +
            '  <div class="inline-drawer-content"><div class="lcl2-drawer-inner">' +
            '    <button id="lcl2_open_panel" class="menu_button">打开小萤火面板</button>' +
            '    <label class="checkbox_label"><input id="lcl2_show_floater" type="checkbox"><span>显示萤火虫浮标</span></label>' +
            '  </div></div>' +
            '</div>');
        $('#lcl2_open_panel').on('click', showPanel);
        $('#lcl2_show_floater').prop('checked', !!settings().show_floater).on('change', function () {
            var s = settings();
            s.show_floater = $(this).prop('checked');
            saveSettings();
            $('#lcl2_floater').toggle(s.show_floater);
        });
    }

    /* 魔杖菜单入口 */
    function makeWandEntry() {
        if ($('#lcl2_wand').length) return;
        var menu = $('#extensionsMenu');
        if (!menu.length) return;
        var item = $('<div id="lcl2_wand" class="list-group-item flex-container flexGap5 interactable" tabindex="0"><span class="lcl2-wand-dot"></span><span>小萤火</span></div>');
        item.on('click', showPanel);
        menu.append(item);
    }

    /* Slash command：让用户能把「随身须知」绑成 Quick Reply，
     * 在发送消息前一键带上——那正是她信息最全的时刻。
     * 注册失败不影响插件其余部分，面板上有等效按钮兜底。 */
    function registerSlashCommands() {
        var c;
        try { c = ctx(); } catch (e) { return; }
        try {
            if (typeof c.registerSlashCommand === 'function') {
                c.registerSlashCommand('lc-brief', function () { fireBrief(); return ''; },
                    [], '— 小萤火：把「随身须知」带进下一轮', true, true);
                c.registerSlashCommand('lc-brief-off', function () { clearBrief(); return ''; },
                    [], '— 小萤火：立刻撤下随身须知', true, true);
                log('已注册命令 /lc-brief 与 /lc-brief-off，可绑 Quick Reply。');
                return;
            }
        } catch (e) { }
        log('这个酒馆版本没有可用的命令注册口，随身须知请用面板上的按钮。');
    }

    function bindChatEvents() {
        var c = ctx();
        var ev = c.eventSource;
        var t = c.eventTypes || c.event_types;
        if (!ev || !t) return false;
        ev.on(t.MESSAGE_SENT, function () {
            try { onUserMessage(); } catch (e) { log('✗ 运行异常：' + (e && e.message)); }
            try { actOnUserMessage(); } catch (e) { log('✗ 星灯异常：' + (e && e.message)); }
        });
        ev.on(t.MESSAGE_RECEIVED, function () {
            try { onAiMessage(); } catch (e) { log('✗ 运行异常：' + (e && e.message)); }
            try { actOnAiMessage(); } catch (e) { log('✗ 星灯异常：' + (e && e.message)); }
        });
        ev.on(t.CHAT_CHANGED, function () {
            try { onChatChanged(); } catch (e) { }
            try { actOnChatChanged(); } catch (e) { }
        });
        return true;
    }

    function boot(attempt) {
        attempt = attempt || 0;
        var ready = false;
        try {
            ready = !!(window.SillyTavern && SillyTavern.getContext && ctx());
        } catch (e) { ready = false; }
        if (!ready || !mountPanel()) {
            if (attempt < 40) return void setTimeout(function () { boot(attempt + 1); }, 500);
            return;
        }
        var caps = capabilityReport();
        if (!caps.core_ok) {
            toast('小萤火无法启动：本酒馆版本缺少 ' + caps.missing.join('、'), 'error');
            return;
        }
        registerSlashCommands();
        bindChatEvents();
        clearInjection();     // 开机先清一次，防止上次会话残留
        onChatChanged();      // 用现场还原逻辑完成首次装载（内含守卫自检）
        reportGuardOnce();    // 若开机时已有聊天，这里就报了；没有则等首次切换
        console.log('[Luciole ' + VERSION + '] 小萤火已就位。守卫来源：' + (chatToken() ? chatTokenSource : '无'));
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function () { boot(0); });
    } else {
        boot(0);
    }
}());
