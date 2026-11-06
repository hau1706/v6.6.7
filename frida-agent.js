'use strict';

var APF_LOG_EVENT_SEQ = 0;
function logEvent(level, code, message, context) {
    try {
        var event = {
            version: 1,
            event_id: 'agent-' + Date.now() + '-' + (++APF_LOG_EVENT_SEQ),
            timestamp: Date.now(),
            level: String(level || 'INFO').toUpperCase(),
            code: String(code || 'AGENT.EVENT_UNSPECIFIED'),
            source: 'FRIDA',
            message: String(message || ''),
            context: context && typeof context === 'object' ? context : {},
            correlation_id: context && (context.correlation_id || context.batch_id) ? String(context.correlation_id || context.batch_id) : null
        };
        send({ type: 'logs', lines: ['__APFLOG__' + JSON.stringify(event)] });
    } catch (e) {
        // Diagnostics are best-effort and must never affect AutoPick business state.
    }
}
function sendLog(msg) {
    var text = String(msg);
    try { send({ type: 'logs', lines: [text] }); } catch (e) {}
    var level = 'INFO', code = 'AGENT.MESSAGE';
    if (/\[PICK UNKNOWN\]|\[PICK\].*timeout/i.test(text)) { level = 'WARNING'; code = 'PICK.UNKNOWN_TIMEOUT'; }
    else if (/\[SUCCESS\]|PICK OK/i.test(text)) { level = 'SUCCESS'; code = 'PICK.RESPONSE_SUCCESS'; }
    else if (/\[FAIL\]|PICK thất bại/i.test(text)) { level = 'ERROR'; code = 'PICK.RESPONSE_FAILED'; }
    else if (/\[REFRESH\].*HTTP/i.test(text)) { level = 'WARNING'; code = 'REFRESH.HTTP_ERROR'; }
    else if (/\[FILTER\]/i.test(text)) { code = 'FILTER.DIAGNOSTIC'; }
    else if (/\[ASSIGNMENT\]/i.test(text)) { code = 'ASSIGNMENT.EVENT'; }
    else if (/\[JS ERROR\]|exception|uncaught/i.test(text)) { level = 'ERROR'; code = 'AGENT.JS_ERROR'; }
    logEvent(level, code, text, {});
}
function sendEvent(type, extra) {
    try {
        var p = { type: type };
        if (extra) for (var k in extra) p[k] = extra[k];
        send(p);
    } catch (e) {}
}

var AUTOPICK_AGENT_VERSION = '6.6.7';

var CONFIG = {
    enabled: true, autoRefresh: true, autoPick: true, stopAfterPick: false,
    verboseLog: false, notifyOnAssignment: true, refreshIntervalMs: 300,
    requestMaxDistance: 6000, minPrice: 0, maxPrice: 0,
    minDistance: 0, maxDistance: 50000, minCOD: 0, maxCOD: 0,
    maxOrdersPerSession: 5, cooldown: 0.5,
    preferredCategories: [6], preferredDistricts: [],
    districtFilterMode: 0,
    blockedURL: '',
    orderDataUploadEnabled: false,
    orderDataUploadToken: '',
    pickAllSinglesInGroup: false,
    pickAllSinglesInGroupMinDistance: 20000
};

var SETTINGS_KEY = 'FoodyAutoPickConfig_Permanent_V3';
var STATE = {
    installed: false, networkingObj: null, savedRequest: null, assignmentRequest: null,
    refreshCount: 0, pickedCount: 0, lastPickTime: 0,
    pickedIds: {}, notifiedIds: {}, stopped: false,
    autoLoopStarted: false, isBusy: false,
    lastPickedInfo: '', lastPickedPrice: 0,
    pendingPickResponses: 0, pendingPickMeta: [], pendingAssignments: {}, notifiedAssignmentIds: {}, assignmentBuffers: {},
    pendingGunzipCallbacks: {}, nextGunzipId: 1, refreshInFlight: false,
    loopGen: 0, loopTimer: null, refreshReq: null, refreshSeq: 0, abandonedTasks: {}, statusSeen: {},
    busyTimer: null, configTimer: null, hookTimer: null, sweepTimer: null, disposed: false,
    lastRefreshStartedAt: 0, refreshBackoffMs: 0, refreshBackoffUntil: 0, consecutive503: 0, liveTestPreviews: {}, pendingApiTests: {}, activeApiTestToken: null, nextApiTestId: 0, testResponseBuffers: {}, pickResponseBuffers: {}, orderListBuffers: {},
    activePickBatch: null, deliveryOrderListBuffers: {}, orderDataUploadInFlight: false, pendingOrderDataUpload: null,
    orderDataUploadBlocks: {}, nextOrderDataUploadId: 0, lastMissingUploadTokenLogAt: 0
};

var URLS = {
    pick: 'https://gpartner.deliverynow.vn/api/v6/free-pick/pick',
    mpick: 'https://gpartner.deliverynow.vn/api/v6/free-pick/mpick',
    orderDataUpload: 'https://phau.io.vn/receive-orders.php'
};

// ---------------------------------------------------------------------------
// Memory manager: một bộ dọn duy nhất (TTL + giới hạn số phần tử) cho mọi dictionary tạm.
// Dictionary vẫn là object thường (STATE.<name>[key]) để code/test hiện có đọc như cũ;
// thời điểm tạo được giữ trong MEM_TIMES. Chỉ dữ liệu quá hạn hoặc vượt giới hạn mới bị xóa
// (xóa phần tử CŨ NHẤT trước). Có thể chỉnh qua CONFIG.memLimits hoặc message 'mem_limits'.
// ---------------------------------------------------------------------------
var MEM_LIMITS = {
    notifiedIds:           { ttl: 300000,  max: 1000 },
    pickedIds:             { ttl: 1800000, max: 3000 },
    notifiedAssignmentIds: { ttl: 600000,  max: 1000 },
    pendingAssignments:    { ttl: 600000,  max: 100 },
    assignmentBuffers:     { ttl: 10000,   max: 32 },
    orderListBuffers:      { ttl: 5000,    max: 8 },
    deliveryOrderListBuffers: { ttl: 10000, max: 8 },
    pickResponseBuffers:   { ttl: 5000,    max: 32 },
    testResponseBuffers:   { ttl: 5000,    max: 4 },
    pendingGunzipCallbacks: { ttl: 7000,   max: 8, onExpire: 'gzip' },
    abandonedTasks:        { ttl: 30000,   max: 16 },
    statusSeen:            { ttl: 10000,   max: 32 }
};
var MEM_BUFFER_MAX_BYTES = { assignmentBuffers: 262144, orderListBuffers: 1048576,
    deliveryOrderListBuffers: 5242880, pickResponseBuffers: 131072, testResponseBuffers: 65536 };
// Global hard ceiling across all incomplete response streams. Values are UTF-16 code units;
// approximately twice this amount may be occupied by character storage, excluding object overhead.
var MEM_BUFFER_TOTAL_MAX_CODE_UNITS = 6 * 1024 * 1024;
var MEM_TIMES = {};
var STATS = { timeouts: 0, http503: 0, http429: 0, httpOther: 0, jsonParseErrors: 0,
    staleResponses: 0, evictions: 0, bufferEvictions: 0, bufferLimitRejects: 0,
    refreshSent: 0, refreshCompleted: 0, gzipFailures: 0, pickHandoffUnknown: 0, pickTimeouts: 0 };

function safeClearTimeout(h) { try { if (h && typeof clearTimeout === 'function') clearTimeout(h); } catch (e) {} }
function safeClearInterval(h) { try { if (h && typeof clearInterval === 'function') clearInterval(h); } catch (e) {} }

function memTimes(name) { return MEM_TIMES[name] || (MEM_TIMES[name] = {}); }
function memSet(name, key, value, keepTime) {
    var d = STATE[name]; if (!d) d = STATE[name] = {};
    var t = memTimes(name), k = String(key);
    if (!keepTime || t[k] === undefined) t[k] = Date.now();
    d[k] = value;
    var lim = MEM_LIMITS[name];
    if (lim && lim.max > 0) memEnforceMax(name, lim.max);
    return value;
}
function memDelete(name, key) {
    var d = STATE[name], k = String(key);
    if (d) delete d[k];
    var t = MEM_TIMES[name]; if (t) delete t[k];
}
function memClear(name) { STATE[name] = {}; MEM_TIMES[name] = {}; }
function memSize(name) { var d = STATE[name]; return d ? Object.keys(d).length : 0; }
function memEnforceMax(name, max) {
    var d = STATE[name], t = memTimes(name);
    var keys = Object.keys(d);
    if (keys.length <= max) return;
    keys.sort(function (a, b) { return (t[a] || 0) - (t[b] || 0); });
    var drop = keys.length - max;
    for (var i = 0; i < drop; i++) { memDelete(name, keys[i]); STATS.evictions++; }
}
function memSweep(now) {
    now = now || Date.now();
    for (var name in MEM_LIMITS) {
        var d = STATE[name]; if (!d) continue;
        var lim = MEM_LIMITS[name], t = memTimes(name);
        var keys = Object.keys(d);
        for (var i = 0; i < keys.length; i++) {
            var k = keys[i];
            if (t[k] === undefined) t[k] = now;            // phần tử gán trực tiếp: bắt đầu tính TTL từ giờ
            if (now - t[k] >= lim.ttl) {
                if (lim.onExpire === 'gzip') { STATS.gzipFailures++; sendLogThrottled('gzip-timeout', '⚠️ [GZIP] Hết thời gian giải nén response; chưa xử lý được payload.', 10000); }
                else if (/Buffers$/.test(name)) { STATS.jsonParseErrors++; if (CONFIG.verboseLog) sendLog('[MEM] Buffer ' + name + ' chưa hoàn chỉnh đã bị xóa sau ' + lim.ttl + 'ms.'); }
                memDelete(name, k);
            }
        }
        for (var tk in t) if (!(tk in d)) delete t[tk];     // dọn timestamp mồ côi
    }
}
function bufferEntryLength(entry) {
    if (!entry) return 0;
    if (Array.isArray(entry.chunks)) return Math.max(0, Number(entry.length) || 0);
    if (typeof entry.s === 'string') return entry.s.length;
    return typeof entry === 'string' ? entry.length : 0;
}
function memBufferBytes() {
    var total = 0;
    for (var name in MEM_BUFFER_MAX_BYTES) {
        var d = STATE[name]; if (!d) continue;
        for (var k in d) total += bufferEntryLength(d[k]);
    }
    return total;
}
function oldestBufferExcept(excludeName, excludeKey) {
    var oldest = null;
    for (var name in MEM_BUFFER_MAX_BYTES) {
        var d = STATE[name], times = MEM_TIMES[name] || {};
        if (!d) continue;
        for (var key in d) {
            if (name === excludeName && String(key) === String(excludeKey)) continue;
            var at = Number(times[key] || 0);
            if (!oldest || at < oldest.at) oldest = { name: name, key: key, at: at, length: bufferEntryLength(d[key]) };
        }
    }
    return oldest;
}
// Append chunk without repeatedly copying the accumulated response. A single join is done only
// when the stream is complete. Enforce both per-stream and aggregate buffer limits on every chunk.
function bufferAppend(name, key, chunk) {
    if (!MEM_BUFFER_MAX_BYTES[name] || typeof chunk !== 'string') return null;
    var cur = STATE[name] && STATE[name][key];
    // Reuse the existing chunk array; do not copy it on every callback.
    var chunks = cur && Array.isArray(cur.chunks) ? cur.chunks : [];
    if (chunks.length === 0 && cur) {
        if (typeof cur.s === 'string') chunks.push(cur.s);
        else if (typeof cur === 'string') chunks.push(cur);
    }
    var oldLength = bufferEntryLength(cur);
    var nextLength = oldLength + chunk.length;
    if (nextLength > MEM_BUFFER_MAX_BYTES[name] || chunks.length >= 2048) {
        memDelete(name, key); STATS.bufferLimitRejects++; return null;
    }
    var total = memBufferBytes();
    while (total + chunk.length > MEM_BUFFER_TOTAL_MAX_CODE_UNITS) {
        var victim = oldestBufferExcept(name, key);
        if (!victim) break;
        memDelete(victim.name, victim.key);
        total -= victim.length;
        STATS.bufferEvictions++;
    }
    if (total + chunk.length > MEM_BUFFER_TOTAL_MAX_CODE_UNITS) {
        memDelete(name, key); STATS.bufferLimitRejects++; return null;
    }
    chunks.push(chunk);
    var entry = { chunks: chunks, length: nextLength };
    memSet(name, key, entry, true);
    return entry;
}
function bufferText(entry) {
    if (!entry) return '';
    if (Array.isArray(entry.chunks)) return entry.chunks.join('');
    if (typeof entry.s === 'string') return entry.s;
    return typeof entry === 'string' ? entry : '';
}
function bufferLooksComplete(entry) {
    if (!entry) return false;
    var chunks = Array.isArray(entry.chunks) ? entry.chunks : [bufferText(entry)];
    for (var ci = chunks.length - 1; ci >= 0; ci--) {
        var part = chunks[ci] || '';
        for (var i = part.length - 1; i >= 0; i--) {
            var c = part.charCodeAt(i);
            if (c === 32 || c === 10 || c === 13 || c === 9) continue;
            return c === 125 || c === 93;
        }
    }
    return false;
}
function bufferStore(name, key, entry) { if (entry) memSet(name, key, entry, true); }
function looksComplete(s) {
    for (var i = s.length - 1; i >= 0; i--) {
        var c = s.charCodeAt(i);
        if (c === 32 || c === 10 || c === 13 || c === 9) continue;
        return c === 125 || c === 93;                       // '}' hoặc ']'
    }
    return false;
}
function memoryGuardSnapshot() {
    return {
        activeRefreshRequests: STATE.refreshReq ? 1 : 0,
        pendingPickResponses: STATE.pendingPickResponses,
        pendingAssignments: memSize('pendingAssignments'),
        buffers: memSize('assignmentBuffers') + memSize('orderListBuffers') + memSize('deliveryOrderListBuffers') +
                 memSize('pickResponseBuffers') + memSize('testResponseBuffers'),
        bufferBytes: memBufferBytes(), bufferLimitCodeUnits: MEM_BUFFER_TOTAL_MAX_CODE_UNITS,
        bufferEvictions: STATS.bufferEvictions, bufferLimitRejects: STATS.bufferLimitRejects,
        cachedIds: memSize('pickedIds') + memSize('notifiedIds') + memSize('notifiedAssignmentIds'),
        timeouts: STATS.timeouts, pickTimeouts: STATS.pickTimeouts,
        pickHandoffUnknown: STATS.pickHandoffUnknown,
        refreshBackoffMs: STATE.refreshBackoffMs || 0, consecutive503: STATE.consecutive503 || 0,
        http503: STATS.http503, http429: STATS.http429,
        jsonParseErrors: STATS.jsonParseErrors, staleResponses: STATS.staleResponses, evictions: STATS.evictions
    };
}
var memGuardTick = 0;
function memoryGuardTick() {
    memSweep(Date.now());
    memGuardTick++;
    // Chỉ cảnh báo khi vượt ngưỡng; KHÔNG tự xóa dữ liệu nghiệp vụ vì vượt ngưỡng.
    if (memGuardTick % 12 === 0) {                           // ~mỗi 60 giây
        var snap = memoryGuardSnapshot();
        if (snap.bufferBytes > 4194304 || snap.cachedIds > 6000) {
            sendLogThrottled('memguard', '⚠️ [MEM-GUARD] ' + JSON.stringify(snap), 60000);
        } else if (CONFIG.verboseLog) {
            sendLog('[MEM-GUARD] ' + JSON.stringify(snap));
        }
    }
}
function startMemorySweeper() {
    if (STATE.sweepTimer) return;
    try { STATE.sweepTimer = setInterval(memoryGuardTick, 5000); } catch (e) {}
}

// Gộp log lặp: cùng một key chỉ ghi một lần trong cửa sổ thời gian, kèm số lần bị gộp.
var LOG_THROTTLE = {};
function sendLogThrottled(key, msg, windowMs) {
    var now = Date.now(), e = LOG_THROTTLE[key];
    if (e && now - e.t < windowMs) { e.n++; return; }
    var suffix = e && e.n > 0 ? ' (+' + e.n + ' lần tương tự đã gộp)' : '';
    LOG_THROTTLE[key] = { t: now, n: 0 };
    // Keep the diagnostic throttle cache bounded during long-running sessions.
    var keys = Object.keys(LOG_THROTTLE);
    if (keys.length > 512) {
        keys.sort(function (a, b) { return (LOG_THROTTLE[a].t || 0) - (LOG_THROTTLE[b].t || 0); });
        for (var i = 0; i < keys.length - 384; i++) delete LOG_THROTTLE[keys[i]];
    }
    sendLog(msg + suffix);
}

// FIX: tạo Block trong try/catch — nếu ObjC bridge chưa sẵn sàng, script không bị chết ngay lúc load
var globalBlocks = { empty: null };
try {
    if (typeof ObjC !== 'undefined' && ObjC.available) {
        globalBlocks.empty = new ObjC.Block({
            retType: 'void', argTypes: ['object'], implementation: function (r) {}
        });
    }
} catch (e) {}

function loadConfigFromDisk() {
    try {
        if (typeof ObjC === 'undefined' || !ObjC.available) return;
        var def = ObjC.classes.NSUserDefaults.standardUserDefaults();
        var o = def.objectForKey_(SETTINGS_KEY);
        if (o) {
            var parsed = JSON.parse(o.toString());
            if (parsed.pickAllSinglesInGroup === undefined && parsed.pickSingleInGroup !== undefined) parsed.pickAllSinglesInGroup = parsed.pickSingleInGroup;
            if (parsed.pickAllSinglesInGroupMinDistance === undefined && parsed.pickSingleInGroupMinDistance !== undefined) parsed.pickAllSinglesInGroupMinDistance = parsed.pickSingleInGroupMinDistance;
            for (var k in parsed) CONFIG[k] = parsed[k];
            sendLog('[CONFIG] Da khoi phuc Setting');
        }
    } catch (e) {}
}
STATE.configTimer = setTimeout(function () { STATE.configTimer = null; loadConfigFromDisk(); }, 500);

// Bảng bỏ dấu tiếng Việt — KHÔNG phụ thuộc String.prototype.normalize (QuickJS có thể thiếu)
var VN_MAP = (function () {
    var groups = {
        a: 'àáạảãâầấậẩẫăằắặẳẵ', e: 'èéẹẻẽêềếệểễ', i: 'ìíịỉĩ',
        o: 'òóọỏõôồốộổỗơờớợởỡ', u: 'ùúụủũưừứựửữ', y: 'ỳýỵỷỹ', d: 'đ'
    };
    var m = {};
    for (var base in groups)
        for (var i = 0; i < groups[base].length; i++) m[groups[base].charAt(i)] = base;
    return m;
})();

// "Quận 1", "quan 1", "QUẬN 1", "Quận1" -> "quan 1"
function normalizeStr(str) {
    if (str === null || str === undefined || str === '') return '';
    try {
        var s = String(str).toLowerCase();
        try { if (typeof s.normalize === 'function') s = s.normalize('NFC'); } catch (e0) {}
        var out = '';
        for (var i = 0; i < s.length; i++) {
            var c = s.charAt(i);
            out += (VN_MAP[c] !== undefined) ? VN_MAP[c] : c;
        }
        out = out.replace(/[\u0300-\u036f]/g, '');          // dấu rời (chuỗi decomposed)
        out = out.replace(/([a-z])(\d)/g, '$1 $2')            // quan1 -> quan 1
                 .replace(/(\d)([a-z])/g, '$1 $2');
        return out.replace(/\s+/g, ' ').trim();
    } catch (e) { return String(str).toLowerCase().trim(); }
}

function escapeRegExp(t) { return t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// Khớp NGUYÊN CỤM: "quan 1" khớp "quan 1" nhưng KHÔNG khớp "quan 10"/"quan 12"
function addressMatchesDistricts(addr, districts) {
    if (!addr || !Array.isArray(districts) || districts.length === 0) return false;
    var normAddr = normalizeStr(addr);
    if (!normAddr) return false;
    for (var i = 0; i < districts.length; i++) {
        var nd = normalizeStr(districts[i]);
        if (!nd) continue;
        try {
            var re = new RegExp('(^|[^a-z0-9])' + escapeRegExp(nd) + '($|[^a-z0-9])');
            if (re.test(normAddr)) return true;
        } catch (e) {}
    }
    return false;
}

function getVietnamTimestamp() {
    var now = new Date(Date.now() + 7 * 3600 * 1000);
    var p2 = function (n) { return n < 10 ? '0' + n : String(n); };
    return now.getUTCFullYear() + '-' + p2(now.getUTCMonth()+1) + '-' +
           p2(now.getUTCDate()) + ' ' + p2(now.getUTCHours()) + ':' +
           p2(now.getUTCMinutes()) + ':' + p2(now.getUTCSeconds());
}

function refreshRequestHeaders(mutableReq, templateReq) {
    try {
        var orig = templateReq.allHTTPHeaderFields();
        if (!orig) return;
        var mh = orig.mutableCopy();
        var loc = mh.objectForKey_('x-foody-location');
        if (loc) {
            var parts = loc.toString().split(',');
            if (parts.length >= 4) {
                var nl = parts[0]+','+parts[1]+','+parts[2]+','+getVietnamTimestamp();
                mh.setObject_forKey_(nl, 'x-foody-location');
            }
        }
        mutableReq.setAllHTTPHeaderFields_(mh);
    } catch (e) {}
}

function modifyRequestInPlace(req) {
    try {
        if (!req.isKindOfClass_(ObjC.classes.NSMutableURLRequest)) return false;
        var body = req.HTTPBody();
        if (!body || body.length().valueOf() < 5) return false;
        var er = Memory.alloc(Process.pointerSize); er.writePointer(NULL);
        var jd = ObjC.classes.NSJSONSerialization
            .JSONObjectWithData_options_error_(body, 0, er);
        if (!jd) return false;
        var md = jd.mutableCopy();
        md.setObject_forKey_(
            ObjC.classes.NSNumber.numberWithInteger_(CONFIG.requestMaxDistance),
            'max_distance');
        var er2 = Memory.alloc(Process.pointerSize); er2.writePointer(NULL);
        var nd = ObjC.classes.NSJSONSerialization
            .dataWithJSONObject_options_error_(md, 0, er2);
        if (!nd) return false;
        req.setHTTPBody_(nd);
        req.setValue_forHTTPHeaderField_(
            String(nd.length().valueOf()), 'Content-Length');
        return true;
    } catch (e) { return false; }
}

function decodeDataToString(nsData, cb) {
    try {
        if (!nsData || nsData.length().valueOf() < 2 || typeof cb !== 'function') return;
        // NSURLSession / custom React Native networking can expose the compressed
        // response body on some builds. Detect the GZIP magic bytes and ask the host
        // app's zlib helper to inflate it instead of silently dropping the assignment.
        var gzip = false;
        try {
            var bytes = nsData.bytes();
            gzip = !!bytes && bytes.readU8() === 0x1f && bytes.add(1).readU8() === 0x8b;
        } catch (e0) {}
        if (gzip) {
            // Giới hạn dữ liệu nén gửi sang host để không tạo bản sao Base64 quá lớn.
            if (nsData.length().valueOf() > 524288) {
                STATS.gzipFailures++;
                sendLogThrottled('gzip-big', '⚠️ [GZIP] Response nén lớn hơn 512 KB; bỏ qua payload.', 10000);
                return;
            }
            var gunzipId = STATE.nextGunzipId++;
            memSet('pendingGunzipCallbacks', String(gunzipId), cb);   // TTL 7s do bộ dọn chung xử lý
            send({ type: 'gunzip', id: gunzipId, data: nsData.base64EncodedStringWithOptions_(0).toString() });
            return;
        }
        var s = ObjC.classes.NSString.alloc().initWithData_encoding_(nsData, 4);
        if (s) { cb(s.toString()); return; }
        var b64 = nsData.base64EncodedStringWithOptions_(0).toString();
        var dd = ObjC.classes.NSData.alloc().initWithBase64EncodedString_options_(b64, 0);
        if (dd) {
            var s2 = ObjC.classes.NSString.alloc().initWithData_encoding_(dd, 4);
            if (s2) cb(s2.toString());
        }
    } catch (e) {
        if (CONFIG.verboseLog) sendLog('[DECODE] Không giải mã được response: ' + String(e));
    }
}

function handleGunzipReply(message) {
    var id = String(message && message.id !== undefined ? message.id : '');
    var cb = STATE.pendingGunzipCallbacks[id];
    if (!cb) return;                                   // đã hết hạn / đã xử lý: bỏ qua reply muộn
    memDelete('pendingGunzipCallbacks', id);
    try {
        if (!message.data) {
            STATS.gzipFailures++;
            throw new Error(message.error === 'too_large' ? 'response vượt giới hạn giải nén' :
                            message.error === 'corrupt' ? 'dữ liệu GZIP hỏng' : 'empty gunzip data');
        }
        var decodedData = ObjC.classes.NSData.alloc().initWithBase64EncodedString_options_(String(message.data), 0);
        var decodedText = decodedData ? ObjC.classes.NSString.alloc().initWithData_encoding_(decodedData, 4) : null;
        if (!decodedText) throw new Error('inflated response is not UTF-8 text');
        sendLog('[GZIP] Giải nén response thành công (' + decodedText.toString().length + ' ký tự).');
        cb(decodedText.toString());
    } catch (e) {
        sendLog('⚠️ [GZIP] Giải nén response thất bại: ' + String(e));
    }
}

function reportTestResult(kind, payload, sent, message, extra) {
    var isMpick = String(kind || '').toLowerCase() === 'mpick';
    var event = {
        liveTest: true,
        title: (sent ? '📡 TEST REQUEST THẬT' : '⚠️ Test chưa hoàn tất') + ' · ' + (isMpick ? 'MPICK' : 'Free-Pick'),
        message: String(message || ''),
        endpoint: isMpick ? URLS.mpick : URLS.pick,
        method: 'POST', payload: payload || {}, networkSent: !!sent,
        kind: isMpick ? 'mpick' : 'free_pick'
    };
    if (extra && typeof extra === 'object') for (var k in extra) event[k] = extra[k];
    sendEvent('test_result', event);
}

// This is an intentionally real POST to the production route, using fixed dummy IDs.
// The server is expected to reject these IDs, but the client cannot guarantee that.
function previewLiveApiTest(kind) {
    var k = String(kind || '').toLowerCase() === 'mpick' ? 'mpick' : 'free_pick';
    var isMpick = k === 'mpick';
    var endpoint = isMpick ? URLS.mpick : URLS.pick;
    if (!STATE.networkingObj || !getPickRequestTemplate()) {
        reportTestResult(k, {}, false, 'Chưa có request context xác thực. Mở màn hình Free-Pick trong ứng dụng tài xế rồi thử lại.');
        return;
    }
    if (CONFIG.autoPick) {
        reportTestResult(k, {}, false, 'Hãy tạm tắt Auto Pick trước khi test request thật. Có thể giữ Auto Refresh bật.');
        return;
    }
    if (STATE.isBusy || STATE.activeApiTestToken) {
        reportTestResult(k, {}, false, 'Đang có request pick/test chưa kết thúc. Chờ kết quả rồi thử lại.');
        return;
    }
    var payload = isMpick
        ? { pre_group_code: 'AUTOPICK_TEST_INVALID_' + Date.now(), delivery_order_ids: [999999991, 999999992] }
        : { delivery_order_id: 999999991 };
    STATE.nextApiTestId = (parseInt(STATE.nextApiTestId || 0, 10) + 1);
    var token = 'APT-' + Date.now() + '-' + STATE.nextApiTestId;
    STATE.liveTestPreviews = {};
    STATE.liveTestPreviews[token] = { kind: k, payload: payload, endpoint: endpoint, createdAt: Date.now() };
    var message = isMpick
        ? 'Sẽ gửi POST thật tới endpoint MPICK bằng mã chùm và hai delivery_order_id giả: ' + payload.delivery_order_ids.join(', ') + '. Server thường sẽ từ chối vì dữ liệu không tồn tại. Tuy nhiên app không thể bảo đảm backend sẽ luôn từ chối, nên hãy chỉ thử trên tài khoản test và không chạy đồng thời với Auto Pick.'
        : 'Sẽ gửi POST thật tới endpoint Free-Pick bằng delivery_order_id giả ' + payload.delivery_order_id + '. Server thường sẽ từ chối vì ID không tồn tại. Tuy nhiên app không thể bảo đảm backend sẽ luôn từ chối, nên hãy chỉ thử trên tài khoản test và không chạy đồng thời với Auto Pick.';
    sendEvent('live_test_preview', { token: token, kind: k,
        title: isMpick ? 'Xác nhận MPICK thật · ID giả' : 'Xác nhận Free-Pick thật · ID giả',
        message: message, endpoint: endpoint, method: 'POST', payload: payload });
}

function currentRequestForTask(task) {
    try {
        if (task && task.respondsToSelector_ && task.respondsToSelector_(ObjC.selector('currentRequest'))) {
            var current = task.currentRequest();
            if (current) return current;
        }
        if (task && task.respondsToSelector_ && task.respondsToSelector_(ObjC.selector('originalRequest'))) {
            var original = task.originalRequest();
            if (original) return original;
        }
    } catch (e) {}
    return null;
}

function parseRequestBody(req) {
    try {
        if (!req || !req.HTTPBody()) return null;
        var ns = ObjC.classes.NSString.alloc().initWithData_encoding_(req.HTTPBody(), 4);
        return ns ? JSON.parse(ns.toString()) : null;
    } catch (e) { return null; }
}

function findPendingApiTestToken(task) {
    var req = currentRequestForTask(task);
    if (!req) return null;
    try {
        var marker = req.valueForHTTPHeaderField_('X-AutoPick-Test-ID');
        if (marker) {
            var markerToken = marker.toString();
            if (STATE.pendingApiTests[markerToken]) return markerToken;
        }
    } catch (e) {}
    var body = parseRequestBody(req);
    if (!body) return null;
    var tokens = Object.keys(STATE.pendingApiTests);
    for (var i = 0; i < tokens.length; i++) {
        var test = STATE.pendingApiTests[tokens[i]];
        if (!test) continue;
        if (test.kind === 'free_pick' && parseInt(body.delivery_order_id || 0, 10) === 999999991) return tokens[i];
        if (test.kind === 'mpick' && String(body.pre_group_code || '') === String(test.payload.pre_group_code || '') &&
            Array.isArray(body.delivery_order_ids) && body.delivery_order_ids.length === 2 &&
            parseInt(body.delivery_order_ids[0], 10) === 999999991 && parseInt(body.delivery_order_ids[1], 10) === 999999992) return tokens[i];
    }
    return null;
}

function httpStatusForTask(task) {
    try {
        if (task && task.respondsToSelector_ && task.respondsToSelector_(ObjC.selector('response'))) {
            var response = task.response();
            if (response && response.isKindOfClass_(ObjC.classes.NSHTTPURLResponse)) return response.statusCode().valueOf();
        }
    } catch (e) {}
    return 0;
}

function finishFakeApiTest(token, responseText, task, timedOut) {
    var test = STATE.pendingApiTests[token];
    if (!test) return;
    delete STATE.pendingApiTests[token];
    memDelete('testResponseBuffers', token);
    if (STATE.activeApiTestToken === token) STATE.activeApiTestToken = null;
    if (test.timeoutHandle) { try { clearTimeout(test.timeoutHandle); } catch (e) {} }
    STATE.isBusy = STATE.pendingPickResponses > 0;
    var status = httpStatusForTask(task);
    var parsed = null;
    try { parsed = responseText ? JSON.parse(responseText) : null; } catch (e) {}
    var code = parsed && parsed.code !== undefined ? String(parsed.code) : '';
    var serverMessage = parsed && (parsed.msg || parsed.message) ? String(parsed.msg || parsed.message) : '';
    var message;
    if (timedOut) {
        message = 'Đã gửi request thật nhưng chưa nhận được response trong thời gian chờ. Trạng thái phía server chưa rõ; không tự gửi lại để tránh lặp request.';
    } else if (code === '0') {
        message = '⚠️ Server trả code 0 cho ID test giả. Không ghi vào lịch sử pick thành công; hãy kiểm tra ứng dụng tài xế và tài khoản test ngay. Không thử lại tự động.';
    } else if (code !== '') {
        message = 'Đã nhận response từ server. Mã code=' + code + (serverMessage ? ' · ' + serverMessage : '') + '. Đây là kết quả của request test ID giả, không phải một đơn pick thành công.';
    } else {
        message = 'Đã nhận response nhưng không nhận diện được trường code. Hãy xem JSON thô bên dưới; không tự gửi lại request.';
    }
    sendLog('[API-TEST] ' + test.kind + (timedOut ? ' timeout; kết quả chưa rõ.' : ' response HTTP ' + (status || '?') + ' · code=' + (code || '?')));
    reportTestResult(test.kind, test.payload, true, message, {
        responseRaw: responseText || '', httpStatus: status, responseCode: code,
        responseMessage: serverMessage, timedOut: !!timedOut, testOnly: true
    });
}

function processFakeApiTestResponseChunk(chunk, url, task, token) {
    if (!chunk || typeof chunk !== 'string' || !token || !STATE.pendingApiTests[token]) return false;
    var test = STATE.pendingApiTests[token];
    var bufferEntry = bufferAppend('testResponseBuffers', token, chunk);
    if (!bufferEntry) {
        finishFakeApiTest(token, '', task, true);
        sendLog('[API-TEST] Response vượt giới hạn buffer; đã dừng đọc để bảo vệ bộ nhớ.');
        return true;
    }
    if (!bufferLooksComplete(bufferEntry)) { bufferStore('testResponseBuffers', token, bufferEntry); return true; }
    var combined = bufferText(bufferEntry);
    try {
        JSON.parse(combined);
        finishFakeApiTest(token, combined, task, false);
    } catch (e) {
        bufferStore('testResponseBuffers', token, bufferEntry);
    }
    return true;
}

function sendFakeApiTestRequest(token) {
    var test = STATE.liveTestPreviews[token];
    if (!test) return false;
    var template = getPickRequestTemplate();
    if (!STATE.networkingObj || !template) {
        reportTestResult(test.kind, test.payload, false, 'Request context đã mất. Không gửi request.');
        return false;
    }
    if (STATE.isBusy || STATE.activeApiTestToken) {
        reportTestResult(test.kind, test.payload, false, 'Một request khác đang chạy. Không gửi request test để tránh chồng lệnh.');
        return false;
    }
    STATE.pendingApiTests[token] = {
        kind: test.kind, payload: test.payload, endpoint: test.endpoint,
        sentAt: Date.now(), timeoutHandle: null
    };
    STATE.activeApiTestToken = token;
    STATE.isBusy = true;
    sendLog('🧪 [API-TEST] Gửi POST thật bằng ID giả: ' + JSON.stringify(test.payload));
    try {
        ObjC.schedule(ObjC.mainQueue, function () {
            try {
                if (!STATE.networkingObj || !getPickRequestTemplate()) throw new Error('request context không còn hợp lệ');
                var currentTemplate = getPickRequestTemplate();
                var req = currentTemplate.mutableCopy();
                req.setURL_(ObjC.classes.NSURL.URLWithString_(ObjC.classes.NSString.stringWithString_(test.endpoint)));
                req.setHTTPMethod_(ObjC.classes.NSString.stringWithString_('POST'));
                req.setTimeoutInterval_(8.0);
                refreshRequestHeaders(req, currentTemplate);
                var body = ObjC.classes.NSString.stringWithString_(JSON.stringify(test.payload));
                var data = body.dataUsingEncoding_(4);
                req.setHTTPBody_(data);
                req.setValue_forHTTPHeaderField_(ObjC.classes.NSString.stringWithString_(String(data.length().valueOf())), ObjC.classes.NSString.stringWithString_('Content-Length'));
                STATE.networkingObj.sendRequest_responseType_incrementalUpdates_responseSender_(req, 'text', false, globalBlocks.empty);
                sendLog('[API-TEST] Đã chuyển request tới RCTNetworking; đang đợi phản hồi server.');
                var pending = STATE.pendingApiTests[token];
                if (pending) pending.timeoutHandle = setTimeout(function () {
                    if (STATE.pendingApiTests[token]) finishFakeApiTest(token, '', null, true);
                }, 12000);
            } catch (e) {
                if (STATE.pendingApiTests[token]) {
                    delete STATE.pendingApiTests[token];
                    if (STATE.activeApiTestToken === token) STATE.activeApiTestToken = null;
                    STATE.isBusy = STATE.pendingPickResponses > 0;
                }
                reportTestResult(test.kind, test.payload, false, 'Không thể gửi request test: ' + String(e));
                sendLog('[API-TEST] Lỗi gửi request test: ' + String(e));
            }
        });
    } catch (e) {
        delete STATE.pendingApiTests[token];
        STATE.activeApiTestToken = null;
        STATE.isBusy = STATE.pendingPickResponses > 0;
        reportTestResult(test.kind, test.payload, false, 'Không thể lên lịch request test: ' + String(e));
        return false;
    }
    return true;
}

function confirmLiveApiTest(token, kind) {
    var key = String(token || '');
    var preview = STATE.liveTestPreviews[key];
    var k = String(kind || '').toLowerCase() === 'mpick' ? 'mpick' : 'free_pick';
    if (!preview || preview.kind !== k || Date.now() - preview.createdAt > 20000) {
        reportTestResult(k, {}, false, 'Bản xác nhận đã hết hạn. Mở test lại để tạo một request mới.');
        return;
    }
    if (!STATE.networkingObj || !getPickRequestTemplate()) {
        reportTestResult(k, preview.payload, false, 'Không còn request context hợp lệ. Không gửi request.');
        return;
    }
    if (CONFIG.autoPick) {
        reportTestResult(k, preview.payload, false, 'Auto Pick đã được bật lại. Hãy tắt Auto Pick rồi mở lại màn hình test.');
        return;
    }
    if (STATE.isBusy || STATE.activeApiTestToken) {
        reportTestResult(k, preview.payload, false, 'AutoPick đang bận. Chưa gửi request để tránh chồng lệnh.');
        return;
    }
    sendFakeApiTestRequest(key);
    delete STATE.liveTestPreviews[key];
}

function checkOrder(order) {
    try {
        var e = parseInt(order.total_earnings_amount || 0, 10);
        var d = parseInt(order.delivery_distance || 0, 10);
        if (e < CONFIG.minPrice) return 'Gia thap';
        if (CONFIG.maxPrice > 0 && e > CONFIG.maxPrice) return 'Gia cao';
        if (d < CONFIG.minDistance) return 'Qua gan';
        if (CONFIG.maxDistance > 0 && d > CONFIG.maxDistance) return 'Xa qua';

        var cod = 0;
        if (Array.isArray(order.orders))
            for (var i = 0; i < order.orders.length; i++)
                cod += parseInt(order.orders[i].cod_amount || 0, 10);
        if (cod < CONFIG.minCOD) return 'COD thap';
        if (CONFIG.maxCOD > 0 && cod > CONFIG.maxCOD) return 'COD cao';

        var dos = order.delivery_orders;
        if (Array.isArray(CONFIG.preferredCategories) && CONFIG.preferredCategories.length > 0) {
            var cat = (Array.isArray(dos) && dos.length > 0)
                ? parseInt(dos[0].ref_order_category || 0, 10) : 0;
            var found = false;
            for (var j = 0; j < CONFIG.preferredCategories.length; j++)
                if (parseInt(CONFIG.preferredCategories[j], 10) === cat) { found = true; break; }
            if (!found) return 'Loai ' + cat;
        }

        if (CONFIG.districtFilterMode > 0 &&
            Array.isArray(CONFIG.preferredDistricts) &&
            CONFIG.preferredDistricts.length > 0 &&
            Array.isArray(dos) && dos.length > 0) {

            var pu = dos[0].pickup_address_info;
            var puAddr = pu ? pu.address : null;
            var last = dos[dos.length - 1];
            var doInfo = last ? last.dropoff_address_info : null;
            var doAddr = doInfo ? doInfo.address : null;

            var puM = addressMatchesDistricts(puAddr, CONFIG.preferredDistricts);
            var doM = addressMatchesDistricts(doAddr, CONFIG.preferredDistricts);
            var pass = false;
            if (CONFIG.districtFilterMode === 1) pass = puM;
            else if (CONFIG.districtFilterMode === 2) pass = doM;
            else if (CONFIG.districtFilterMode === 3) pass = (puM || doM);
            if (!pass) return 'Quan khac';
        }
        return null;
    } catch (e) { return 'Loi'; }
}

// ---------------------------------------------------------------------------
// Refresh request lifecycle: created -> running -> completed | failed | timeout | cancelled
// Mỗi refresh có id riêng, được mã hóa vào timeoutInterval (3.000xx giây, không đổi nội dung
// gửi lên mạng) để nhận lại request trong callback. Nếu không đọc được thì dùng handle của task.
// LƯU Ý: chưa kiểm chứng được API hủy request của RCTNetworking; KHÔNG giả định hủy được.
// In-flight chỉ được giải phóng khi (a) có response hoàn tất/lỗi, hoặc (b) NSURLRequest timeout
// (3s, do chính NSURLSession thực thi) + biên 0.6s đã qua; response đến muộn bị loại theo id/handle.
// ---------------------------------------------------------------------------
var REFRESH_BASE_TIMEOUT_S = 3.0;
var REFRESH_WATCHDOG_MS = 3600;

function refreshTimeoutFor(id) { return REFRESH_BASE_TIMEOUT_S + ((id % 1000) / 100000); }
function refreshTagOf(task) {
    // Trả về id (0-999) nếu request mang tag của AutoPick, -1 nếu là request khác, null nếu không đọc được.
    try {
        var rq = currentRequestForTask(task);
        if (!rq || typeof rq.timeoutInterval !== 'function') return null;
        var t = Number(rq.timeoutInterval());
        if (!isFinite(t)) return null;
        var d = t - REFRESH_BASE_TIMEOUT_S;
        if (d < -0.000001 || d > 0.0100001) return -1;
        return Math.round(d * 100000);
    } catch (e) { return null; }
}
function refreshTaskKey(task) {
    try { return task && task.handle ? String(task.handle) : ''; } catch (e) { return ''; }
}
function isRefreshActive(r) { return !!r && (r.state === 'created' || r.state === 'running'); }

function createRefreshRequest(gen) {
    STATE.refreshSeq++;
    var r = { id: STATE.refreshSeq, tag: STATE.refreshSeq % 1000, state: 'created', gen: gen,
              startedAt: Date.now(), taskKey: '', statusHandled: false };
    STATE.refreshReq = r;
    STATE.refreshInFlight = true;
    STATE.lastRefreshStartedAt = r.startedAt;
    sendLogThrottled('refresh-start', '[REFRESH] Bắt đầu request refresh #' + r.id + '.', 5000);
    return r;
}
// Chuyển request sang trạng thái kết thúc đúng một lần. Trả về true nếu lần gọi này là lần kết thúc.
function finishRefreshRequest(r, state) {
    if (!r || !isRefreshActive(r)) return false;
    r.state = state;
    if (STATE.refreshReq === r) { STATE.refreshReq = null; STATE.refreshInFlight = false; }
    if (state === 'timeout' || state === 'cancelled') {
        // Response đến muộn của request này phải bị loại bỏ, không được ghi đè trạng thái request mới.
        memSet('abandonedTasks', 'tag:' + r.tag, r.id);
        if (r.taskKey) memSet('abandonedTasks', r.taskKey, r.id);
    }
    return true;
}
// Gắn response với request refresh đang chạy. Trả về:
//   { own: req }   response thuộc request hiện tại
//   { stale: true } response của request đã timeout/hoàn tất (phải bỏ)
//   { foreign: true } request do chính app đích gửi (vẫn xử lý đơn, không đụng vòng đời refresh)
function classifyRefreshResponse(task) {
    var key = refreshTaskKey(task);
    var tag = refreshTagOf(task);
    var r = STATE.refreshReq;
    if (tag !== null && tag >= 0) {
        if (r && isRefreshActive(r) && tag === r.tag) {
            if (key && !r.taskKey) r.taskKey = key;
            if (r.state === 'created') r.state = 'running';
            return { own: r };
        }
        return { stale: true };                              // tag của AutoPick nhưng không còn là request hiện tại
    }
    if (tag === -1) return { foreign: true };
    // Không đọc được tag: dựa vào handle của task.
    if (key && STATE.abandonedTasks[key]) return { stale: true };
    if (r && isRefreshActive(r)) {
        if (r.taskKey && key && r.taskKey !== key) return { foreign: true };
        if (key && !r.taskKey) r.taskKey = key;
        if (r.state === 'created') r.state = 'running';
        return { own: r };
    }
    return { foreign: true };
}

function retryAfterMsForTask(task) {
    try {
        if (!task || !task.respondsToSelector_ || !task.respondsToSelector_(ObjC.selector('response'))) return 0;
        var response = task.response();
        if (!response || !response.respondsToSelector_(ObjC.selector('valueForHTTPHeaderField:'))) return 0;
        var header = response.valueForHTTPHeaderField_(ObjC.classes.NSString.stringWithString_('Retry-After'));
        if (!header) return 0;
        var value = header.toString().trim();
        if (/^\d+(?:\.\d+)?$/.test(value)) return Math.min(60000, Math.max(0, Math.round(parseFloat(value) * 1000)));
        var dateMs = Date.parse(value);
        return isFinite(dateMs) ? Math.min(60000, Math.max(0, dateMs - Date.now())) : 0;
    } catch (e) { return 0; }
}

function nextRefreshBackoff(code, task) {
    var retryAfter = retryAfterMsForTask(task);
    // Keep the exponent across elapsed wait windows. It is reset only after a valid
    // list response, otherwise repeated failures would remain stuck at the first delay.
    var previous = parseInt(STATE.refreshBackoffMs || 0, 10);
    var base;
    if (code === 503) {
        // Keep the first two transient 503 responses at the configured cadence;
        // only slow down after a sustained run of server-overload responses.
        if ((STATE.consecutive503 || 0) < 3 && retryAfter <= 0) return 0;
        base = previous > 0 ? Math.min(8000, previous * 2) : 500;
    } else {
        base = previous > 0 ? Math.min(15000, previous * 2) : 1000;
    }
    if (retryAfter > 0) return Math.max(base, retryAfter);
    return Math.max(250, base);
}

function handleRefreshHTTPStatus(status, task) {
    var code = parseInt(status || 0, 10);
    var key = refreshTaskKey(task);
    // Each task/status pair is counted once, even when several data callbacks arrive.
    if (key) {
        if (STATE.statusSeen[key] === code) return false;
        memSet('statusSeen', key, code);
    }
    var cls = classifyRefreshResponse(task);
    if (cls.stale) { STATS.staleResponses++; return false; }
    if (cls.own && !cls.own.statusHandled) {
        cls.own.statusHandled = true;
        finishRefreshRequest(cls.own, 'failed');
    }
    if (code === 503) {
        STATS.http503++;
        STATE.consecutive503 = (STATE.consecutive503 || 0) + 1;
        var wait503 = nextRefreshBackoff(503, task);
        if (wait503 > 0) {
            STATE.refreshBackoffMs = wait503;
            STATE.refreshBackoffUntil = Date.now() + wait503;
            sendLogThrottled('http503-backoff', '[REFRESH] HTTP 503 lặp lại (' + STATE.consecutive503 + ' lần); nghỉ ' + wait503 + 'ms rồi thử lại.', 5000);
        } else {
            sendLogThrottled('http503', '[REFRESH] HTTP 503 tạm thời; giữ chu kỳ refresh cấu hình.', 5000);
        }
    } else if (code === 429 || code >= 500) {
        STATE.consecutive503 = 0;
        if (code === 429) STATS.http429++; else STATS.httpOther++;
        STATE.refreshBackoffMs = nextRefreshBackoff(code, task);
        STATE.refreshBackoffUntil = Date.now() + STATE.refreshBackoffMs;
        sendLogThrottled('http' + code, '[REFRESH] HTTP ' + code + '; backoff ' + STATE.refreshBackoffMs + 'ms' + (retryAfterMsForTask(task) > 0 ? ' (Retry-After)' : '') + '.', 5000);
    } else {
        STATE.consecutive503 = 0;
        STATS.httpOther++;
        sendLogThrottled('http' + code, '[REFRESH] HTTP ' + code + ' khi lấy danh sách đơn.', 5000);
    }
    return true;
}

function clearRefreshBackoff() {
    if ((STATE.refreshBackoffMs > 0 || STATE.consecutive503 > 0) && CONFIG.verboseLog) {
        sendLog('[REFRESH] Response JSON hợp lệ; xóa backoff và quay lại chu kỳ cấu hình.');
    }
    STATE.refreshBackoffMs = 0;
    STATE.refreshBackoffUntil = 0;
    STATE.consecutive503 = 0;
}

function processOrderListChunk(chunk, url, requestObject) {
    if (!chunk || typeof chunk !== 'string') return;
    var cls = classifyRefreshResponse(requestObject);
    if (cls.stale) { STATS.staleResponses++; return; }
    var own = cls.own || null;
    var key = String(url || 'order-list');
    var tk = refreshTaskKey(requestObject);
    if (tk) key += '#' + tk;
    var bufferEntry = bufferAppend('orderListBuffers', key, chunk);
    if (!bufferEntry) {
        if (own) finishRefreshRequest(own, 'failed');
        STATS.jsonParseErrors++;
        sendLogThrottled('orderlist-big', '⚠️ Order-list response vượt quá 1 MB; bỏ qua payload để bảo vệ bộ nhớ.', 10000);
        return;
    }
    if (!bufferLooksComplete(bufferEntry)) { bufferStore('orderListBuffers', key, bufferEntry); return; }
    var combined = bufferText(bufferEntry);
    var parsed;
    try { parsed = JSON.parse(combined); }                  // parse DUY NHẤT một lần cho mỗi response
    catch (e) { bufferStore('orderListBuffers', key, bufferEntry); return; }
    memDelete('orderListBuffers', key);
    combined = null;
    processOrderList(parsed, own);
}

function isPickedOrderListURL(url) {
    return String(url || '').indexOf('https://gpartner.deliverynow.vn/api/v6/delivery/get-order-list') === 0;
}

function processDeliveryOrderListChunk(chunk, url, requestObject) {
    if (!chunk || typeof chunk !== 'string') return;
    var key = String(url || 'delivery-order-list');
    var tk = refreshTaskKey(requestObject);
    if (tk) key += '#' + tk;
    var bufferEntry = bufferAppend('deliveryOrderListBuffers', key, chunk);
    if (!bufferEntry) {
        sendLogThrottled('delivery-big', '⚠️ [ORDER DATA] Response get-order-list vượt 5 MB; bỏ qua để bảo vệ bộ nhớ.', 10000);
        return;
    }
    if (!bufferLooksComplete(bufferEntry)) { bufferStore('deliveryOrderListBuffers', key, bufferEntry); return; }
    var combined = bufferText(bufferEntry);
    var parsed;
    try { parsed = JSON.parse(combined); }
    catch (e) { bufferStore('deliveryOrderListBuffers', key, bufferEntry); return; }
    memDelete('deliveryOrderListBuffers', key);
    processDeliveryOrderListResponse(combined, parsed);
}

function processDeliveryOrderListResponse(jsonStr, parsedJson) {
    // Deliberately require the feature toggle, successful API code, and a non-empty orders array.
    if (!CONFIG.orderDataUploadEnabled) return false;
    var json = parsedJson;
    if (json === undefined) { try { json = JSON.parse(jsonStr || '{}'); } catch (e) { return false; } }
    if (!json || String(json.code) !== '0' || !json.data || !Array.isArray(json.data.orders) || json.data.orders.length === 0) {
        return false;
    }
    STATE.pendingOrderDataUpload = {
        raw: jsonStr,
        orderCount: json.data.orders.length,
        capturedAt: Date.now()
    };
    drainOrderDataUpload();
    return true;
}

function drainOrderDataUpload() {
    if (STATE.orderDataUploadInFlight || !STATE.pendingOrderDataUpload) return;
    if (!CONFIG.orderDataUploadEnabled) {
        STATE.pendingOrderDataUpload = null;
        return;
    }
    var token = String(CONFIG.orderDataUploadToken || '').trim();
    if (!token) {
        STATE.pendingOrderDataUpload = null;
        var now = Date.now();
        if (now - (STATE.lastMissingUploadTokenLogAt || 0) > 60000) {
            STATE.lastMissingUploadTokenLogAt = now;
            sendLog('⚠️ [ORDER DATA] Chưa có token upload; đã bỏ qua gửi host. Nhập token khớp với receive-orders.php trong Cấu hình.');
        }
        return;
    }
    if (typeof ObjC === 'undefined' || !ObjC.available) {
        STATE.pendingOrderDataUpload = null;
        sendLog('⚠️ [ORDER DATA] Objective-C bridge chưa sẵn sàng; chưa thể gửi dữ liệu lên host.');
        return;
    }

    var snapshot = STATE.pendingOrderDataUpload;
    STATE.pendingOrderDataUpload = null;      // snapshot.raw được giải phóng sau khi request hoàn tất (xem block bên dưới)
    var uploadId = ++STATE.nextOrderDataUploadId;
    STATE.orderDataUploadInFlight = true;
    try {
        var NSString = ObjC.classes.NSString;
        var NSURL = ObjC.classes.NSURL;
        var NSMutableURLRequest = ObjC.classes.NSMutableURLRequest;
        var url = NSURL.URLWithString_(NSString.stringWithString_(URLS.orderDataUpload));
        var req = NSMutableURLRequest.alloc().initWithURL_(url);
        req.setHTTPMethod_(NSString.stringWithString_('POST'));
        req.setTimeoutInterval_(15.0);
        var body = NSString.stringWithString_(snapshot.raw).dataUsingEncoding_(4);
        req.setHTTPBody_(body);
        req.setValue_forHTTPHeaderField_(NSString.stringWithString_('application/json; charset=utf-8'), NSString.stringWithString_('Content-Type'));
        req.setValue_forHTTPHeaderField_(NSString.stringWithString_(token), NSString.stringWithString_('X-AutoPick-Token'));
        req.setValue_forHTTPHeaderField_(NSString.stringWithString_('no-store'), NSString.stringWithString_('Cache-Control'));
        try { req.setHTTPShouldHandleCookies_(false); } catch (cookieErr) {}

        var block = new ObjC.Block({
            retType: 'void',
            argTypes: ['object', 'object', 'object'],
            implementation: function (data, response, error) {
                var status = 0;
                try { if (response) status = response.statusCode().valueOf(); } catch (statusErr) {}
                try {
                    if (error) {
                        var msg = '';
                        try { msg = new ObjC.Object(error).localizedDescription().toString(); } catch (messageErr) {}
                        sendLog('[ORDER DATA] Gửi host thất bại' + (msg ? ': ' + msg : '') + '.');
                    } else if (status >= 200 && status < 300) {
                        sendLog('✅ [ORDER DATA] Đã gửi response có ' + snapshot.orderCount + ' đơn lên host; dữ liệu cũ đã được thay thế. HTTP ' + status + '.');
                    } else {
                        sendLog('⚠️ [ORDER DATA] Host trả HTTP ' + status + '; dữ liệu chưa được xác nhận đã lưu.');
                    }
                } catch (logErr) {}
                delete STATE.orderDataUploadBlocks[String(uploadId)];
                snapshot.raw = null;
                STATE.orderDataUploadInFlight = false;
                drainOrderDataUpload();
            }
        });
        STATE.orderDataUploadBlocks[String(uploadId)] = block;
        var session = ObjC.classes.NSURLSession.sharedSession();
        var task = session.dataTaskWithRequest_completionHandler_(req, block);
        task.resume();
    } catch (e) {
        delete STATE.orderDataUploadBlocks[String(uploadId)];
        STATE.orderDataUploadInFlight = false;
        sendLog('[ORDER DATA] Không thể tạo request upload: ' + String(e));
        // Keep only the newest response for a single retry on the next valid response,
        // rather than looping repeatedly and loading the app/server.
        STATE.pendingOrderDataUpload = null;
    }
}

function formatPriceVND(value) {
    var n = parseInt(value || 0, 10);
    if (!isFinite(n)) n = 0;
    var sign = n < 0 ? '-' : '';
    var digits = String(Math.abs(n));
    return sign + digits.replace(/\B(?=(\d{3})+(?!\d))/g, '.') + 'đ';
}

function verboseOrderReject(order, dos, reason, key) {
    if (!CONFIG.verboseLog) return;
    var first = Array.isArray(dos) && dos.length ? dos[0] : null;
    var oid = first && first.delivery_order_id ? String(first.delivery_order_id) : 'không rõ';
    var distance = parseInt(order && order.delivery_distance || 0, 10);
    var price = parseInt(order && order.total_earnings_amount || 0, 10);
    var kmText = distance > 0 ? (distance / 1000).toFixed(1) + ' km' : 'không rõ km';
    var msg = '[FILTER] Bỏ qua #' + oid + ' · ' + kmText + ' · ' + formatPriceVND(price) + ' · ' + reason;
    sendLogThrottled('filter:' + String(key || oid) + ':' + String(reason), msg, 10000);
}

function processOrderList(input, own) {
    // `input` là object đã parse (đường chính) hoặc chuỗi JSON (tương thích ngược). Không parse lại nếu đã là object.
    if (own) { if (finishRefreshRequest(own, 'completed')) STATS.refreshCompleted++; }
    try {
        var json = (typeof input === 'string') ? JSON.parse(input) : input;
        input = null;
        if (!json) return;
        if (json.code === undefined || String(json.code) === '0') clearRefreshBackoff();
        else STATE.consecutive503 = 0; // a valid HTTP response breaks a consecutive-503 streak
        var orders = json.data && json.data.orders;
        if (json.code !== undefined && String(json.code) !== '0') orders = [];
        if (!Array.isArray(orders) || orders.length === 0) {
            sendLogThrottled('refresh-empty', '[REFRESH] Response hợp lệ nhưng không có đơn hàng.', 10000);
            return;
        }
        sendLogThrottled('refresh-parsed', '[REFRESH] Đã parse danh sách đơn từ response.', 5000);
        if (!CONFIG.enabled || STATE.stopped) return;

        // 1+2. LỌC và CHỌN ĐƠN/CHÙM CÓ GIÁ CAO NHẤT trong một lần duyệt (đồng nhất kết quả với bản cũ:
        // đơn đầu tiên đạt điều kiện làm mốc, chỉ thay thế khi điểm LỚN HƠN hẳn).
        var bestOrder = null, bestScore = 0;
        for (var i = 0; i < orders.length; i++) {
            var o = orders[i];
            var dos = o.delivery_orders;
            if (!Array.isArray(dos) || dos.length === 0) {
                verboseOrderReject(o, dos, 'Không có delivery_orders', 'missing:' + i);
                continue;
            }

            var reason = checkOrder(o);
            if (reason) {
                verboseOrderReject(o, dos, reason, dos[0].delivery_order_id || ('idx:' + i));
                continue;
            }

            var isGroupCand = (o.pre_group_code != null && dos.length > 1);

            // Nếu đang bật Pick lẻ trong chùm -> Bỏ qua đơn lẻ ngay từ vòng lọc
            if (CONFIG.pickAllSinglesInGroup && !isGroupCand) {
                verboseOrderReject(o, dos, 'Đang bật chế độ chỉ Pick chùm', dos[0].delivery_order_id || ('idx:' + i));
                continue;
            }

            // Nếu là chùm, kiểm tra Min Km
            if (CONFIG.pickAllSinglesInGroup && isGroupCand) {
                var dist = parseInt(o.delivery_distance || 0, 10);
                if (CONFIG.pickAllSinglesInGroupMinDistance > 0 && dist < CONFIG.pickAllSinglesInGroupMinDistance) {
                    verboseOrderReject(o, dos, 'Chùm ngắn hơn MinDistance ' + (CONFIG.pickAllSinglesInGroupMinDistance / 1000).toFixed(1) + ' km', dos[0].delivery_order_id || ('idx:' + i));
                    continue;
                }
            }

            if (CONFIG.verboseLog) sendLogThrottled('filter-pass:' + String(dos[0].delivery_order_id), '[FILTER] Đạt điều kiện #' + dos[0].delivery_order_id + ' · ' + ((parseInt(o.delivery_distance || 0, 10) / 1000).toFixed(1)) + ' km · ' + formatPriceVND(o.total_earnings_amount || 0), 10000);
            var sc = parseInt(o.total_earnings_amount || 0, 10);
            if (bestOrder === null || sc > bestScore) { bestOrder = o; bestScore = sc; }
        }
        if (bestOrder === null) {
            sendLogThrottled('filter-no-match', '[FILTER] Không có đơn/chùm nào vượt qua bộ lọc.', 10000);
            return;
        }

        var bDos = bestOrder.delivery_orders;
        logEvent('SUCCESS', 'FILTER.MATCH_SELECTED', 'Đã chọn đơn/chùm tốt nhất sau lọc', {
            order_count: bDos.length,
            order_ids: bDos.map(function (d) { return parseInt(d.delivery_order_id || 0, 10); }).filter(function (id) { return id > 0; }),
            earnings: parseInt(bestOrder.total_earnings_amount || 0, 10),
            distance_m: parseInt(bestOrder.delivery_distance || 0, 10)
        });
        var isGroup = (bestOrder.pre_group_code != null && bDos.length > 1);
        var firstOid = parseInt(bDos[0].delivery_order_id || 0, 10);
        var key = isGroup ? String(bestOrder.pre_group_code) : String(firstOid);

        if (!STATE.notifiedIds[key]) {
            memSet('notifiedIds', key, true);
            sendEvent('match', { order: bestOrder });
        }

        if (!CONFIG.autoPick || STATE.isBusy || STATE.pendingPickResponses > 0) return;
        if (CONFIG.maxOrdersPerSession > 0 && STATE.pickedCount >= CONFIG.maxOrdersPerSession) {
            STATE.stopped = true; return;
        }
        var nowSec = Date.now() / 1000.0;
        if (CONFIG.cooldown > 0 && (nowSec - STATE.lastPickTime) < CONFIG.cooldown) return;
        if (STATE.pickedIds[key]) return;
        memSet('pickedIds', key, 'sent');
        STATE.lastPickTime = nowSec;

        // 3. TIẾN HÀNH XỬ LÝ (PICK LẺ HOẶC MPICK)
        if (CONFIG.pickAllSinglesInGroup) {
            // Chế độ này chỉ nhận chùm (đơn lẻ đã bị lọc ở vòng trên), gửi từng đơn xa -> gần.
            var totalGroupDistance = parseInt(bestOrder.delivery_distance || 0, 10);
            var sortedDos = bDos.map(function (d, idx) { return { d: d, idx: idx }; })
                .sort(function (a, b) {
                    var diff = parseInt(b.d.delivery_distance || 0, 10) - parseInt(a.d.delivery_distance || 0, 10);
                    return diff !== 0 ? diff : a.idx - b.idx;
                }).map(function (x) { return x.d; });
            var singleIds = [];
            for (var s2 = 0; s2 < sortedDos.length; s2++) {
                var oid2 = parseInt(sortedDos[s2].delivery_order_id, 10);
                if (!(oid2 > 0)) continue;
                singleIds.push(oid2);
                memSet('pickedIds', String(oid2), 'sent');
                sendLog('   #' + (s2 + 1) + ': ' + oid2 + ' (' + (parseInt(sortedDos[s2].delivery_distance || 0, 10) / 1000).toFixed(1) + 'km)');
            }
            if (singleIds.length > 0) {
                if (CONFIG.maxOrdersPerSession > 0 && STATE.pickedCount + singleIds.length > CONFIG.maxOrdersPerSession) {
                    STATE.stopped = true;
                    stopRefreshLoop();
                    sendEvent('auto_stopped', { reason: 'Chùm ' + singleIds.length + ' đơn vượt số lượt còn lại trong phiên; không gửi một phần chùm.' });
                    sendLog('⏹ [AUTO STOP] Bỏ qua toàn bộ chùm để không vượt giới hạn phiên hoặc chỉ lấy một phần chùm.');
                    return;
                }
                logEvent('INFO', 'PICK.SPLIT_ALL.SELECTED', 'Đã chọn chế độ Pick lẻ ALL cho chùm', { order_ids: singleIds.slice(), total_distance_m: totalGroupDistance, sort: 'distance_desc' });
                sendLog('🔀 [SPLIT ALL] Chùm ' + bDos.length + ' đơn (Tổng: ' + (totalGroupDistance / 1000).toFixed(1) + 'km) -> pick lẻ xa → gần');
                if (!sendPickBatch(singleIds, bestScore, 'Chùm ' + bDos.length + ' đơn', null, {
                    reservationKey: key,
                    // In SPLIT ALL, the API confirms each per-order request with code only;
                    // the response may omit delivery_order_id. Aggregate code:0 responses
                    // are accepted as success only when every submitted request replied code:0.
                    splitAllCodeOnlySuccess: true
                })) {
                    for (var sr = 0; sr < singleIds.length; sr++) memDelete('pickedIds', String(singleIds[sr]));
                    memDelete('pickedIds', key);
                }
            }
        } else {
            if (isGroup) {
                sendLog('📦 Chùm ' + bDos.length + ' đơn (Không bật Pick lẻ) -> Dùng MPICK');
                var ids = [];
                for (var j = 0; j < bDos.length; j++) ids.push(parseInt(bDos[j].delivery_order_id, 10));
                if (!sendPickGroup(bestOrder.pre_group_code, ids, bestScore, bDos.length, { reservationKey: key })) memDelete('pickedIds', key);
            } else {
                if (!sendPickSingle(firstOid, bestScore)) memDelete('pickedIds', key);
            }
        }
    } catch (e) { if (CONFIG.verboseLog) sendLog('[ORDER] Loi xu ly: ' + String(e)); }
}

// ---------------------------------------------------------------------------
// Refresh loop có "generation": START tạo generation mới, STOP hủy timer đang chờ và vô hiệu hóa
// mọi callback cũ (kể cả callback đã xếp hàng trên main queue). Luôn chỉ có tối đa một timer loop.
// ---------------------------------------------------------------------------
function clearLoopTimer() {
    if (STATE.loopTimer) { safeClearTimeout(STATE.loopTimer); STATE.loopTimer = null; }
}
function scheduleLoop(gen, delay) {
    if (gen !== STATE.loopGen || STATE.disposed) return;
    clearLoopTimer();
    STATE.loopTimer = setTimeout(function () {
        STATE.loopTimer = null;
        startRCTNetworkingAutoLoad(gen);
    }, delay);
}
function stopRefreshLoop() {
    STATE.loopGen++;                                  // vô hiệu hóa mọi callback thuộc generation cũ
    clearLoopTimer();
    STATE.autoLoopStarted = false;
    if (STATE.refreshReq) finishRefreshRequest(STATE.refreshReq, 'cancelled');
    STATE.refreshInFlight = false;
}
function startRefreshLoop(initialDelayMs) {
    clearLoopTimer();
    var gen = ++STATE.loopGen;
    STATE.autoLoopStarted = true;
    if (initialDelayMs > 0) scheduleLoop(gen, initialDelayMs);
    else startRCTNetworkingAutoLoad(gen);
    return gen;
}

function startRCTNetworkingAutoLoad(gen) {
    if (gen === undefined) gen = STATE.loopGen;
    if (gen !== STATE.loopGen || STATE.disposed) return;          // callback của generation cũ: không làm gì
    if (!CONFIG.enabled || STATE.stopped) {
        STATE.autoLoopStarted = false;
        STATE.refreshInFlight = false;
        return;
    }
    var delay = Math.max(100, parseInt(CONFIG.refreshIntervalMs || 300, 10));
    if (!CONFIG.autoRefresh) { scheduleLoop(gen, 1000); return; }
    if (!STATE.networkingObj || !STATE.savedRequest) {
        scheduleLoop(gen, 300); return;
    }
    var now = Date.now();
    var backoffRemaining = (STATE.refreshBackoffUntil || 0) - now;      // backoff sau 429/5xx và 503 kéo dài
    if (backoffRemaining > 0) {
        scheduleLoop(gen, Math.max(100, Math.min(backoffRemaining, delay)));
        return;
    }
    var active = STATE.refreshReq;
    if (active && isRefreshActive(active)) {
        if (now - active.startedAt < REFRESH_WATCHDOG_MS) {
            scheduleLoop(gen, delay);                // request trước chưa xong: KHÔNG gửi chồng
            return;
        }
        // Quá hạn: NSURLRequest đã có timeout 3s do NSURLSession thực thi, nên request thực tế đã kết thúc.
        // Đánh dấu timeout, ghi nhớ để loại response muộn, rồi mới cho phép request kế tiếp.
        if (finishRefreshRequest(active, 'timeout')) {
            STATS.timeouts++;
            sendLogThrottled('refresh-timeout', '⚠️ Refresh #' + active.id + ' không nhận phản hồi trong ' + (REFRESH_WATCHDOG_MS / 1000) + ' giây; đánh dấu timeout, response muộn (nếu có) sẽ bị bỏ.', 10000);
        }
    }
    ObjC.schedule(ObjC.mainQueue, function () {
        try {
            if (gen !== STATE.loopGen || STATE.disposed) return;      // đã STOP/START lại trong lúc chờ main queue
            if (CONFIG.enabled && !STATE.stopped &&
                STATE.networkingObj && STATE.savedRequest && !isRefreshActive(STATE.refreshReq)) {
                var r = createRefreshRequest(gen);
                try {
                    var cp = STATE.savedRequest.mutableCopy();
                    refreshRequestHeaders(cp, STATE.savedRequest);
                    modifyRequestInPlace(cp);
                    try { cp.setTimeoutInterval_(refreshTimeoutFor(r.id)); } catch (te) {}
                    STATE.networkingObj.sendRequest_responseType_incrementalUpdates_responseSender_(
                        cp, 'text', false, globalBlocks.empty);
                    sendLogThrottled('refresh-submitted', '[REFRESH] Request đã được chuyển tới RCTNetworking.', 5000);
                    STATE.refreshCount++;
                    STATS.refreshSent++;
                } catch (e) {
                    finishRefreshRequest(r, 'failed');
                    sendLogThrottled('refresh-send', '[REFRESH] Không thể gửi request refresh: ' + String(e), 10000);
                }
            }
        } catch (outer) {
            if (STATE.refreshReq) finishRefreshRequest(STATE.refreshReq, 'failed');
        }
        scheduleLoop(gen, delay);                                      // no-op nếu generation đã đổi
    });
}

function getPickRequestTemplate() {
    // Prefer the Free-Pick request. If the user only opened an assignment screen,
    // use its authenticated request as a header/context template without auto-refreshing it.
    return STATE.savedRequest || STATE.assignmentRequest || null;
}

// This hook is called after the request has already been handed to RCTNetworking.
// It must never throw: throwing here makes the outer send-request catch falsely
// report a send failure, remove pending metadata, and release the busy lock early.
function sendLiveTestSentEvent(options) {
    if (!options || !options.liveTest) return;
    try {
        sendEvent('live_test_sent', {
            kind: String(options.kind || 'free_pick'),
            endpoint: String(options.endpoint || URLS.pick),
            payload: options.payload || {},
            message: 'Request đã được chuyển tới RCTNetworking; đang chờ phản hồi máy chủ.',
            requestSubmitted: true
        });
        sendLog('[API-TEST] Request đã được chuyển tới RCTNetworking; đang chờ phản hồi máy chủ.');
    } catch (e) {
        // Logging/reporting trouble must not change the result of the network send.
        try { sendLog('[API-TEST] Không cập nhật được trạng thái gửi test: ' + String(e)); } catch (ignored) {}
    }
}

function sendPickSingle(oid, price, options) {
    oid = parseInt(oid, 10);
    if (!(oid > 0)) return false;
    var template = getPickRequestTemplate();
    if (!STATE.networkingObj || !template) {
        memDelete('pickedIds', String(oid));
        sendLog('❌ Chưa có request context hợp lệ để gửi pick');
        return false;
    }
    if (STATE.isBusy || STATE.pendingPickResponses > 0) return false;
    STATE.isBusy = true;
    STATE.pendingPickResponses = 1;
    STATE.lastPickedInfo = 'Đơn #' + oid;
    STATE.lastPickedPrice = price || 0;
    addPickMeta(STATE.lastPickedInfo, price, oid, options);
    logEvent('INFO', 'PICK.REQUEST.QUEUED', 'Đã chuẩn bị request PICK đơn lẻ', { order_id: oid, price: price || 0 });
    sendLog('📤 [PICK] ' + STATE.lastPickedInfo);
    try { ObjC.schedule(ObjC.mainQueue, function () {
        var networkingCallStarted = false;
        try {
            var req = template.mutableCopy();
            req.setURL_(ObjC.classes.NSURL.URLWithString_(ObjC.classes.NSString.stringWithString_(URLS.pick)));
            req.setHTTPMethod_(ObjC.classes.NSString.stringWithString_('POST'));
            req.setTimeoutInterval_(10.0);
            refreshRequestHeaders(req, template);
            var body = ObjC.classes.NSString.stringWithString_(JSON.stringify({ delivery_order_id: oid }));
            var bd = body.dataUsingEncoding_(4);
            req.setHTTPBody_(bd);
            req.setValue_forHTTPHeaderField_(ObjC.classes.NSString.stringWithString_(String(bd.length().valueOf())), ObjC.classes.NSString.stringWithString_('Content-Length'));
            networkingCallStarted = true;
            setPickMetaStatus(oid, null, 'HANDOFF');
            logEvent('INFO', 'PICK.REQUEST.HANDOFF', 'Đang chuyển request PICK tới RCTNetworking', { order_id: oid });
            STATE.networkingObj.sendRequest_responseType_incrementalUpdates_responseSender_(req, 'text', false, globalBlocks.empty);
            setPickMetaStatus(oid, null, 'SUBMITTED');
            logEvent('INFO', 'PICK.REQUEST.SUBMITTED', 'Request PICK đã được handoff', { order_id: oid });
            sendLiveTestSentEvent(options);
        } catch (e) {
            if (networkingCallStarted) {
                setPickMetaStatus(oid, null, 'UNKNOWN', e);
                logEvent('WARNING', 'PICK.REQUEST.HANDOFF_UNKNOWN', 'Exception sau khi bắt đầu handoff; kết quả chưa xác định', { order_id: oid, error: String(e) });
                sendLog('[PICK UNKNOWN] Exception sau khi bắt đầu handoff đơn #' + oid + '; giữ trạng thái chờ, không gửi lại: ' + String(e));
            } else {
                STATE.pendingPickResponses = Math.max(0, STATE.pendingPickResponses - 1);
                STATE.isBusy = STATE.pendingPickResponses > 0;
                removePickMeta(oid, 'Đơn #' + oid);
                memDelete('pickedIds', String(oid));
                if (options && options.liveTest) reportTestResult(options.kind, options.payload, false, 'Lỗi chuẩn bị request: ' + String(e));
                if (options && options.forceNotify) {
                    var preHandoffReason = 'Lỗi chuẩn bị request: ' + String(e);
                    sendEvent('pick_failed', { reason: preHandoffReason, responseMessage: preHandoffReason,
                        info: 'Đơn #' + oid, orderId: oid, forceNotify: true,
                        assignmentId: options.assignmentId ? String(options.assignmentId) : '' });
                }
                sendLog('[PICK] Không gửi request do lỗi trước handoff: ' + String(e));
            }
        }
        if (STATE.pendingPickResponses > 0) resetBusyAfterTimeout(12000);
    }); } catch (scheduleError) {
        STATE.pendingPickResponses = Math.max(0, STATE.pendingPickResponses - 1);
        STATE.isBusy = STATE.pendingPickResponses > 0;
        removePickMeta(oid, 'Đơn #' + oid);
        memDelete('pickedIds', String(oid));
        if (options && options.liveTest) reportTestResult(options.kind, options.payload, false, 'Không thể lên lịch gửi request: ' + String(scheduleError));
        sendLog('[PICK] Không thể lên lịch gửi request: ' + String(scheduleError));
        return false;
    }
    return true;
}

function addPickMeta(info, price, orderId, options) {
    STATE.pendingPickMeta.push({ info: info || 'Đơn', price: price || 0, orderId: orderId || 0,
        source: options && options.source ? String(options.source) : (options && options.liveTest ? 'live_test' : 'auto'),
        forceNotify: !!(options && options.forceNotify),
        assignmentId: options && options.assignmentId ? String(options.assignmentId) : '',
        status: 'PREPARING', createdAt: Date.now() });
}

function setPickMetaStatus(orderId, info, status, detail) {
    var changed = false;
    for (var i = 0; i < STATE.pendingPickMeta.length; i++) {
        var entry = STATE.pendingPickMeta[i];
        var idMatch = orderId > 0 && parseInt(entry.orderId || 0, 10) === orderId;
        var infoMatch = !orderId && info && entry.info === info;
        if (idMatch || infoMatch) {
            entry.status = status;
            if (detail) entry.statusDetail = String(detail);
            if (status === 'UNKNOWN') entry.unknownAt = Date.now();
            changed = true;
        }
    }
    if (changed && status === 'UNKNOWN') STATS.pickHandoffUnknown++;
    return changed;
}

function markPendingPicksUnknown(reason) {
    for (var i = 0; i < STATE.pendingPickMeta.length; i++) {
        var entry = STATE.pendingPickMeta[i];
        if (entry.status !== 'RESOLVED') {
            entry.status = 'UNKNOWN';
            entry.statusDetail = String(reason || 'Chưa nhận được response');
            entry.unknownAt = Date.now();
        }
    }
}

function hasPendingPickWork() {
    return (parseInt(STATE.pendingPickResponses || 0, 10) > 0) ||
        (Array.isArray(STATE.pendingPickMeta) && STATE.pendingPickMeta.length > 0) || !!STATE.activePickBatch;
}

function removePickMeta(orderId, info) {
    for (var i = STATE.pendingPickMeta.length - 1; i >= 0; i--) {
        var entry = STATE.pendingPickMeta[i];
        if ((orderId > 0 && parseInt(entry.orderId || 0, 10) === orderId) ||
            (info && entry.info === info)) {
            STATE.pendingPickMeta.splice(i, 1);
            return;
        }
    }
}

function setBatchItemStatus(orderId, status, detail) {
    var batch = STATE.activePickBatch;
    if (!batch || !Array.isArray(batch.items)) return false;
    var id = parseInt(orderId || 0, 10);
    for (var i = 0; i < batch.items.length; i++) {
        var item = batch.items[i];
        if (id > 0 && parseInt(item.orderId || 0, 10) === id) {
            var previous = item.status;
            item.status = status;
            if (detail) item.detail = String(detail);
            item.updatedAt = Date.now();
            if (previous !== status) {
                var level = status === 'SUCCESS' ? 'SUCCESS' : (status === 'FAILED' ? 'ERROR' : (status === 'UNKNOWN' ? 'WARNING' : 'INFO'));
                logEvent(level, 'PICK.ITEM.' + status, 'Đơn #' + id + ' chuyển trạng thái ' + previous + ' → ' + status, {
                    order_id: id, batch_id: batch.batchId, previous_status: previous, status: status, detail: detail || ''
                });
            }
            return true;
        }
    }
    return false;
}

function batchStatusCounts(batch) {
    var counts = { SUCCESS: 0, FAILED: 0, UNKNOWN: 0, NOT_SENT: 0, SUBMITTED: 0, HANDOFF: 0, QUEUED: 0 };
    var items = batch && Array.isArray(batch.items) ? batch.items : [];
    for (var i = 0; i < items.length; i++) {
        var status = String(items[i].status || 'UNKNOWN');
        if (counts[status] === undefined) counts[status] = 0;
        counts[status]++;
    }
    return counts;
}

function resetBusyAfterTimeout(delay) {
    // A timeout is not proof that the server rejected a request. Keep its reservations and
    // single-flight gate until a late response resolves it or the runtime is deliberately reset.
    if (STATE.busyTimer) { safeClearTimeout(STATE.busyTimer); STATE.busyTimer = null; }
    STATE.busyTimer = setTimeout(function () {
        STATE.busyTimer = null;
        if (STATE.pendingPickResponses > 0) {
            var unanswered = STATE.pendingPickResponses;
            STATS.pickTimeouts++;
            markPendingPicksUnknown('Timeout: không rõ server đã xử lý request hay chưa');
            if (STATE.activePickBatch) finishPickBatch(true, unanswered);
            STATE.isBusy = true;
            logEvent('WARNING', 'PICK.BATCH.TIMEOUT', 'Batch có request chưa nhận response; giữ reservation và khóa PICK', {
                pending_responses: unanswered, batch_id: STATE.activePickBatch ? STATE.activePickBatch.batchId : null
            });
            sendLog('⚠️ [PICK UNKNOWN] Hết thời gian chờ ' + unanswered + ' response. Giữ reservation và khóa PICK để tránh gửi trùng; refresh vẫn tiếp tục. Chỉ mở khóa khi response đến; nếu agent bị unload/reload, phải đối chiếu trạng thái đơn trên app tài xế trước khi bật lại.');
        }
    }, Math.max(2500, delay || 12000));
}

function sendPickBatch(ids, price, label, perOrderPriceMap, options) {
    if (STATE.isBusy || STATE.pendingPickResponses > 0) return false;
    var template = getPickRequestTemplate();
    if (!STATE.networkingObj || !template) {
        sendLog('❌ Chưa có request context hợp lệ để gửi pick');
        return false;
    }
    var safeIds = [];
    var seen = {};
    for (var i = 0; i < (ids || []).length; i++) {
        var oid = parseInt(ids[i], 10);
        if (oid > 0 && !seen[String(oid)]) { seen[String(oid)] = true; safeIds.push(oid); }
    }
    if (safeIds.length === 0) return false;
    STATE.isBusy = true;
    STATE.pendingPickResponses = safeIds.length;
    STATE.lastPickedInfo = label || ('Pick lẻ ' + safeIds.length + ' đơn');
    STATE.lastPickedPrice = price || 0;
    for (var m = 0; m < safeIds.length; m++) {
        var individualPrice = perOrderPriceMap && perOrderPriceMap[String(safeIds[m])] !== undefined
            ? parseInt(perOrderPriceMap[String(safeIds[m])] || 0, 10) : 0;
        addPickMeta('Đơn #' + safeIds[m] + (label ? ' · ' + label : ''), individualPrice, safeIds[m]);
    }
    var batchId = 'batch-' + Date.now() + '-' + Math.floor(Math.random() * 1000000);
    STATE.activePickBatch = {
        batchId: batchId, ids: safeIds.slice(), total: safeIds.length, label: label || ('Pick lẻ ' + safeIds.length + ' đơn'),
        price: price || 0, successCount: 0, failureCount: 0, unknownSuccessCount: 0,
        unmappedFailureCount: 0, unmappedUnknownCount: 0, responseSuccessCount: 0, submittedCount: 0, ambiguousCount: 0,
        reservationKey: options && options.reservationKey ? String(options.reservationKey) : '',
        responseMode: options && options.splitAllCodeOnlySuccess ? 'SPLIT_ALL_CODE_ONLY' : 'CORRELATED',
        assignmentId: options && options.assignmentId ? String(options.assignmentId) : '',
        source: options && options.source ? String(options.source) : 'auto',
        forceNotify: !!(options && options.forceNotify),
        codeOnlySuccessCount: 0, codeOnlyFailureCount: 0,
        responseDetails: [],
        knownSuccessIds: [], failureReasons: [], unmappedLogged: false, summaryEmitted: false, startedAt: Date.now(),
        items: safeIds.map(function (id) {
            var itemPrice = perOrderPriceMap && perOrderPriceMap[String(id)] !== undefined ? parseInt(perOrderPriceMap[String(id)] || 0, 10) : 0;
            return { orderId: id, price: itemPrice, status: 'QUEUED', detail: '', createdAt: Date.now() };
        })
    };
    logEvent('INFO', 'PICK.BATCH.STARTED', 'Bắt đầu batch PICK lẻ', {
        batch_id: batchId, order_ids: safeIds.slice(), total_count: safeIds.length, total_price: price || 0,
        assignment_id: STATE.activePickBatch.assignmentId || '', source: STATE.activePickBatch.source,
        response_mode: STATE.activePickBatch.responseMode, force_notify: STATE.activePickBatch.forceNotify
    });
    sendLog('📤 [PICK-BATCH] ' + safeIds.join(' → '));
    try { ObjC.schedule(ObjC.mainQueue, function () {
        var stopDispatch = false;
        for (var j = 0; j < safeIds.length; j++) {
            var orderKey = String(safeIds[j]);
            if (stopDispatch) {
                // This order was never handed to RCTNetworking. Release its reservation/meta.
                memDelete('pickedIds', orderKey);
                removePickMeta(safeIds[j], 'Đơn #' + safeIds[j]);
                STATE.pendingPickResponses = Math.max(0, STATE.pendingPickResponses - 1);
                if (STATE.activePickBatch) {
                    STATE.activePickBatch.failureReasons.push('Đơn #' + orderKey + ' chưa gửi do request trước có kết quả handoff không xác định');
                }
                setBatchItemStatus(safeIds[j], 'NOT_SENT', 'Không gửi vì request trước có handoff không xác định');
                continue;
            }
            var networkingCallStarted = false;
            try {
                var req = template.mutableCopy();
                req.setURL_(ObjC.classes.NSURL.URLWithString_(ObjC.classes.NSString.stringWithString_(URLS.pick)));
                req.setHTTPMethod_(ObjC.classes.NSString.stringWithString_('POST'));
                req.setTimeoutInterval_(10.0);
                refreshRequestHeaders(req, template);
                var body = ObjC.classes.NSString.stringWithString_(JSON.stringify({ delivery_order_id: safeIds[j] }));
                var bd = body.dataUsingEncoding_(4);
                req.setHTTPBody_(bd);
                req.setValue_forHTTPHeaderField_(ObjC.classes.NSString.stringWithString_(String(bd.length().valueOf())), ObjC.classes.NSString.stringWithString_('Content-Length'));
                networkingCallStarted = true;
                setPickMetaStatus(safeIds[j], null, 'HANDOFF');
                setBatchItemStatus(safeIds[j], 'HANDOFF', 'Đang chuyển request tới RCTNetworking');
                STATE.networkingObj.sendRequest_responseType_incrementalUpdates_responseSender_(req, 'text', false, globalBlocks.empty);
                setPickMetaStatus(safeIds[j], null, 'SUBMITTED');
                setBatchItemStatus(safeIds[j], 'SUBMITTED', 'Request đã được chuyển tới RCTNetworking');
                if (STATE.activePickBatch) STATE.activePickBatch.submittedCount++;
            } catch (e) {
                var sendError = 'Lỗi gửi request cho đơn #' + safeIds[j] + ': ' + String(e);
                if (networkingCallStarted) {
                    // A synchronous exception after entering the networking call is ambiguous:
                    // the native layer may already have accepted the task. Keep its metadata and
                    // busy reservation; stop later sends so we never amplify an uncertain result.
                    stopDispatch = true;
                    setPickMetaStatus(safeIds[j], null, 'UNKNOWN', sendError);
                    setBatchItemStatus(safeIds[j], 'UNKNOWN', sendError + ' (handoff không xác định)');
                    if (STATE.activePickBatch) {
                        STATE.activePickBatch.ambiguousCount++;
                        STATE.activePickBatch.failureReasons.push(sendError + ' (kết quả chưa xác định)');
                    }
                    sendLog('[PICK-BATCH] Handoff không xác định #' + safeIds[j] + '; dừng các đơn tiếp theo.');
                } else {
                    STATE.pendingPickResponses = Math.max(0, STATE.pendingPickResponses - 1);
                    removePickMeta(safeIds[j], 'Đơn #' + safeIds[j]);
                    memDelete('pickedIds', orderKey); // definitely not submitted; allow a later retry
                    setBatchItemStatus(safeIds[j], 'NOT_SENT', sendError + ' (lỗi trước handoff)');
                    if (STATE.activePickBatch) {
                        STATE.activePickBatch.failureReasons.push(sendError);
                    } else {
                        sendEvent('pick_failed', { reason: sendError, info: 'Đơn #' + safeIds[j], orderId: safeIds[j] });
                    }
                    sendLog('[PICK-BATCH] Không thể chuẩn bị request #' + safeIds[j] + ': ' + String(e));
                }
            }
        }
        STATE.isBusy = STATE.pendingPickResponses > 0;
        if (STATE.pendingPickResponses === 0 && STATE.activePickBatch) finishPickBatch(false, 0);
        if (STATE.pendingPickResponses > 0) resetBusyAfterTimeout(12000);
    }); } catch (scheduleError) {
        // ObjC.schedule failed before any request was submitted: all reservations are safe to release.
        for (var si = 0; si < safeIds.length; si++) memDelete('pickedIds', String(safeIds[si]));
        if (options && options.reservationKey) memDelete('pickedIds', String(options.reservationKey));
        STATE.pendingPickResponses = 0;
        STATE.isBusy = false;
        for (var si2 = 0; si2 < safeIds.length; si2++) setBatchItemStatus(safeIds[si2], 'NOT_SENT', 'Không thể lên lịch batch: ' + String(scheduleError));
        finishPickBatch(false, 0);
        STATE.pendingPickMeta = [];
        STATE.activePickBatch = null;
        sendLog('[PICK-BATCH] Không thể lên lịch batch: ' + String(scheduleError));
        return false;
    }
    return true;
}

function sendPickGroup(preGroupCode, ids, price, count, options) {
    if (preGroupCode === null || preGroupCode === undefined || String(preGroupCode).trim().length === 0) return false;
    if (!Array.isArray(ids) || ids.length < 2) return false;
    var cleanIds = [], seenIds = {};
    for (var x = 0; x < ids.length; x++) {
        var cleanId = parseInt(ids[x], 10);
        if (!(cleanId > 0) || seenIds[String(cleanId)]) return false;
        seenIds[String(cleanId)] = true;
        cleanIds.push(cleanId);
    }
    ids = cleanIds;
    var template = getPickRequestTemplate();
    if (!STATE.networkingObj || !template || STATE.isBusy || STATE.pendingPickResponses > 0) return false;
    STATE.isBusy = true;
    STATE.pendingPickResponses = 1;
    STATE.lastPickedInfo = 'Chùm ' + count + ' đơn';
    STATE.lastPickedPrice = price || 0;
    addPickMeta(STATE.lastPickedInfo, price, 0, options);
    logEvent('INFO', 'MPICK.REQUEST.QUEUED', 'Đã chuẩn bị request MPICK', { pre_group_code: String(preGroupCode), order_ids: ids.slice(), total_price: price || 0 });
    sendLog('📤 [MPICK] ' + STATE.lastPickedInfo);
    try { ObjC.schedule(ObjC.mainQueue, function () {
        var networkingCallStarted = false;
        try {
            var req = template.mutableCopy();
            req.setURL_(ObjC.classes.NSURL.URLWithString_(ObjC.classes.NSString.stringWithString_(URLS.mpick)));
            req.setHTTPMethod_(ObjC.classes.NSString.stringWithString_('POST'));
            req.setTimeoutInterval_(10.0);
            refreshRequestHeaders(req, template);
            var body = ObjC.classes.NSString.stringWithString_(JSON.stringify({ pre_group_code: preGroupCode, delivery_order_ids: ids }));
            var bd = body.dataUsingEncoding_(4);
            req.setHTTPBody_(bd);
            req.setValue_forHTTPHeaderField_(ObjC.classes.NSString.stringWithString_(String(bd.length().valueOf())), ObjC.classes.NSString.stringWithString_('Content-Length'));
            networkingCallStarted = true;
            setPickMetaStatus(0, 'Chùm ' + count + ' đơn', 'HANDOFF');
            logEvent('INFO', 'MPICK.REQUEST.HANDOFF', 'Đang chuyển request MPICK tới RCTNetworking', { pre_group_code: String(preGroupCode), order_ids: ids.slice() });
            STATE.networkingObj.sendRequest_responseType_incrementalUpdates_responseSender_(req, 'text', false, globalBlocks.empty);
            setPickMetaStatus(0, 'Chùm ' + count + ' đơn', 'SUBMITTED');
            logEvent('INFO', 'MPICK.REQUEST.SUBMITTED', 'Request MPICK đã được handoff', { pre_group_code: String(preGroupCode), order_ids: ids.slice() });
            sendLiveTestSentEvent(options);
        } catch (e) {
            if (networkingCallStarted) {
                setPickMetaStatus(0, 'Chùm ' + count + ' đơn', 'UNKNOWN', e);
                sendLog('[MPICK UNKNOWN] Exception sau khi bắt đầu handoff; giữ trạng thái chờ, không tự gửi lại: ' + String(e));
            } else {
                STATE.pendingPickResponses = Math.max(0, STATE.pendingPickResponses - 1);
                STATE.isBusy = STATE.pendingPickResponses > 0;
                removePickMeta(0, 'Chùm ' + count + ' đơn');
                if (options && options.reservationKey) memDelete('pickedIds', String(options.reservationKey));
                if (options && options.liveTest) reportTestResult(options.kind, options.payload, false, 'Lỗi chuẩn bị MPICK: ' + String(e));
                sendLog('[MPICK] Không gửi request do lỗi trước handoff: ' + String(e));
            }
        }
        if (STATE.pendingPickResponses > 0) resetBusyAfterTimeout(12000);
    }); } catch (scheduleError) {
        STATE.pendingPickResponses = Math.max(0, STATE.pendingPickResponses - 1);
        STATE.isBusy = STATE.pendingPickResponses > 0;
        removePickMeta(0, 'Chùm ' + count + ' đơn');
        if (options && options.reservationKey) memDelete('pickedIds', String(options.reservationKey));
        if (options && options.liveTest) reportTestResult(options.kind, options.payload, false, 'Không thể lên lịch gửi MPICK: ' + String(scheduleError));
        sendLog('[MPICK] Không thể lên lịch request: ' + String(scheduleError));
        return false;
    }
    return true;
}

function extractOrderIdFromTask(task) {
    try {
        var req = null;
        if (task.respondsToSelector_(ObjC.selector('currentRequest'))) req = task.currentRequest();
        if (!req && task.respondsToSelector_(ObjC.selector('originalRequest'))) req = task.originalRequest();
        if (!req || !req.HTTPBody()) return 0;
        var ns = ObjC.classes.NSString.alloc().initWithData_encoding_(req.HTTPBody(), 4);
        if (!ns) return 0;
        var body = JSON.parse(ns.toString());
        return parseInt(body.delivery_order_id || 0, 10) || 0;
    } catch (e) { return 0; }
}

function takePickMeta(task) {
    var oid = extractOrderIdFromTask(task);
    if (oid > 0) {
        for (var i = 0; i < STATE.pendingPickMeta.length; i++) {
            if (parseInt(STATE.pendingPickMeta[i].orderId || 0, 10) === oid) {
                return STATE.pendingPickMeta.splice(i, 1)[0];
            }
        }
    }
    // Never attach an uncorrelated response to an arbitrary order in a concurrent batch.
    if (STATE.pendingPickMeta.length > 1) {
        if (STATE.activePickBatch) {
            if (!STATE.activePickBatch.unmappedLogged) {
                STATE.activePickBatch.unmappedLogged = true;
                sendLog('⚠️ [PICK RESPONSE] Batch response không có delivery_order_id; kết quả sẽ để UNKNOWN thay vì gán nhầm cho một đơn.');
            }
        } else {
            sendLog('⚠️ [PICK RESPONSE] Không tìm được delivery_order_id của response; không gắn kết quả vào một đơn bất kỳ.');
        }
        // Consume one response slot in the batch counters, but retain per-order metadata.
        // A response without an ID must never be assigned to the first/oldest order by guess.
        return { info: 'Không xác định mã đơn (response batch)', price: 0, orderId: 0, unmapped: true, status: 'RESOLVED' };
    }
    return STATE.pendingPickMeta.length ? STATE.pendingPickMeta.shift() : {
        info: STATE.lastPickedInfo || 'Đơn đã pick', price: STATE.lastPickedPrice || 0, orderId: 0
    };
}

function finishPickBatch(timedOut, timedOutCount) {
    var batch = STATE.activePickBatch;
    if (!batch) return;
    var unanswered = Math.max(0, timedOutCount || (timedOut ? STATE.pendingPickResponses : 0));
    var items = Array.isArray(batch.items) ? batch.items : [];

    // SPLIT ALL is a fan-out of one independent request per order. Some API
    // responses contain only {code, msg} and omit delivery_order_id. We can safely
    // summarize the number of explicit success/failure responses, but must not assign
    // an individual response to an arbitrary order ID.
    var splitAllMode = batch.responseMode === 'SPLIT_ALL_CODE_ONLY';
    var splitAllExplicitResponseCount = (batch.responseSuccessCount || 0) +
        (batch.codeOnlyFailureCount || 0) + (batch.failureCount || 0);
    var splitAllFullyResolved = splitAllMode && !timedOut && STATE.pendingPickResponses === 0 &&
        batch.submittedCount === batch.total && splitAllExplicitResponseCount === batch.total &&
        batch.unmappedUnknownCount === 0 && batch.ambiguousCount === 0 &&
        batch.unmappedFailureCount === 0;
    if (splitAllFullyResolved) {
        var aggregateFailureCount = (batch.codeOnlyFailureCount || 0) + (batch.failureCount || 0);
        var aggregateDetail = 'Pick lẻ ALL đã nhận đủ response rõ ràng: ' +
            (batch.responseSuccessCount || 0) + ' thành công, ' + aggregateFailureCount +
            ' thất bại. Server không trả delivery_order_id riêng; kết quả được tổng kết theo số response.';
        var allResponsesSucceeded = batch.responseSuccessCount === batch.total && aggregateFailureCount === 0;
        var allResponsesFailed = aggregateFailureCount === batch.total && (batch.responseSuccessCount || 0) === 0;
        for (var sc = 0; sc < items.length; sc++) {
            if (items[sc].status === 'SUBMITTED' || items[sc].status === 'HANDOFF') {
                if (allResponsesSucceeded) {
                    setBatchItemStatus(items[sc].orderId, 'SUCCESS',
                        'Pick lẻ ALL: tất cả request đã nhận code 0; response không trả delivery_order_id.');
                } else if (allResponsesFailed) {
                    setBatchItemStatus(items[sc].orderId, 'FAILED',
                        'Pick lẻ ALL: tất cả request đều bị server từ chối; xem responseReasons để biết mã lỗi.');
                } else {
                    setBatchItemStatus(items[sc].orderId, 'RESULT_RECEIVED', aggregateDetail);
                }
            }
        }
        if (allResponsesSucceeded) {
            logEvent('SUCCESS', 'PICK.SPLIT_ALL.CODE_ONLY_CONFIRMED',
                'Toàn bộ đơn Pick lẻ ALL thành công theo phản hồi code 0', {
                    batch_id: batch.batchId, total_count: batch.total,
                    response_success_count: batch.responseSuccessCount
                });
        } else if (allResponsesFailed) {
            logEvent('ERROR', 'PICK.SPLIT_ALL.ALL_FAILED', 'Toàn bộ request Pick lẻ ALL bị server từ chối', {
                batch_id: batch.batchId, total_count: batch.total,
                response_failure_count: aggregateFailureCount, response_details: batch.responseDetails || []
            });
        } else {
            logEvent('WARNING', 'PICK.SPLIT_ALL.RESPONSES_RESOLVED',
                'Pick lẻ ALL đã nhận đủ phản hồi thành công/thất bại từ server', {
                    batch_id: batch.batchId, total_count: batch.total,
                    response_success_count: batch.responseSuccessCount,
                    response_failure_count: (batch.codeOnlyFailureCount || 0) + batch.failureCount,
                    response_details: batch.responseDetails || []
                });
        }
    }

    // Finalize only what is provable. Submitted requests with no correlatable response remain UNKNOWN.
    for (var i = 0; i < items.length; i++) {
        var item = items[i];
        if (item.status === 'QUEUED' || item.status === 'PREPARING') {
            setBatchItemStatus(item.orderId, 'NOT_SENT', item.detail || 'Request chưa được handoff tới networking');
        } else if ((item.status === 'SUBMITTED' || item.status === 'HANDOFF') && (timedOut || STATE.pendingPickResponses === 0)) {
            setBatchItemStatus(item.orderId, 'UNKNOWN', unanswered > 0
                ? 'Chưa nhận response; không thể kết luận server đã xử lý hay chưa'
                : 'Response đã nhận nhưng không thể đối chiếu chính xác mã đơn');
        }
    }

    var counts = batchStatusCounts(batch);
    var hasUnknown = counts.UNKNOWN > 0 || batch.unknownSuccessCount > 0 || batch.unmappedFailureCount > 0 || batch.unmappedUnknownCount > 0;
    if (!batch.summaryEmitted) {
        batch.summaryEmitted = true;
        var splitAllSummary = splitAllMode;
        var aggregateSuccessCount = splitAllSummary ? (batch.responseSuccessCount || 0) : counts.SUCCESS;
        var aggregateFailureCount = splitAllSummary ? ((batch.codeOnlyFailureCount || 0) + batch.failureCount) : counts.FAILED;
        var aggregateNotSentCount = counts.NOT_SENT;
        var aggregateUnknownCount = splitAllSummary
            ? Math.max(0, (batch.total || items.length) - aggregateSuccessCount - aggregateFailureCount - aggregateNotSentCount)
            : counts.UNKNOWN;
        var summary = {
            batchId: batch.batchId,
            assignmentId: batch.assignmentId || '',
            source: batch.source || 'auto',
            forceNotify: !!batch.forceNotify,
            label: batch.label,
            totalCount: batch.total || items.length,
            successCount: aggregateSuccessCount,
            failureCount: aggregateFailureCount,
            unknownCount: aggregateUnknownCount,
            notSentCount: aggregateNotSentCount,
            responseSuccessCount: batch.responseSuccessCount || 0,
            codeOnlySuccessCount: batch.codeOnlySuccessCount || 0,
            codeOnlyFailureCount: batch.codeOnlyFailureCount || 0,
            responseDetails: Array.isArray(batch.responseDetails) ? batch.responseDetails.slice(0, 100) : [],
            failureReasons: Array.isArray(batch.failureReasons) ? batch.failureReasons.slice(0, 100) : [],
            unmappedSuccessCount: batch.unknownSuccessCount || 0,
            unmappedFailureCount: batch.unmappedFailureCount || 0,
            unmappedUnknownCount: batch.unmappedUnknownCount || 0,
            pendingResponseCount: STATE.pendingPickResponses,
            timedOut: !!timedOut,
            totalPrice: batch.price || 0,
            durationMs: Math.max(0, Date.now() - (batch.startedAt || Date.now())),
            items: items.map(function (x) { return {
                orderId: x.orderId, price: x.price || 0, status: x.status,
                detail: x.detail || ''
            }; })
        };
        sendEvent('pick_batch_summary', summary);
        var summaryLevel = hasUnknown || counts.FAILED > 0 || counts.NOT_SENT > 0 || (batch.codeOnlyFailureCount || 0) > 0 ? 'WARNING' : 'SUCCESS';
        logEvent(summaryLevel, 'PICK.BATCH.SUMMARY', 'Batch PICK đã có bản tổng kết', {
            batch_id: batch.batchId, total_count: summary.totalCount,
            success_count: summary.successCount, failure_count: summary.failureCount,
            unknown_count: summary.unknownCount, not_sent_count: summary.notSentCount,
            code_only_success_count: summary.codeOnlySuccessCount,
            unmapped_success_count: summary.unmappedSuccessCount,
            unmapped_failure_count: summary.unmappedFailureCount, unmapped_unknown_count: summary.unmappedUnknownCount,
            assignment_id: summary.assignmentId, source: summary.source,
            code_only_failure_count: summary.codeOnlyFailureCount, response_details: summary.responseDetails
        });
        sendLog('[PICK-BATCH SUMMARY] ' + summary.successCount + '/' + summary.totalCount + ' SUCCESS · ' +
            summary.failureCount + ' FAILED · ' + summary.unknownCount + ' UNKNOWN · ' + summary.notSentCount + ' NOT_SENT');
    }

    if (batch.reservationKey && batch.submittedCount === 0 && batch.ambiguousCount === 0) {
        memDelete('pickedIds', batch.reservationKey);
        sendLog('[PICK-BATCH] Đã giải phóng reservation vì không request nào được bàn giao cho RCTNetworking.');
    }

    counts = batchStatusCounts(batch);
    hasUnknown = counts.UNKNOWN > 0;
    // Keep the single-flight gate closed while any submitted order is still UNKNOWN.
    // A late, correlated response can still resolve the item; otherwise the operator must reconcile it.
    if (STATE.pendingPickResponses > 0 || hasUnknown) {
        STATE.isBusy = true;
        return;
    }

    STATE.isBusy = false;
    STATE.activePickBatch = null;
    if (STATE.pendingPickMeta.length > 0) {
        sendLog('ℹ️ [PICK RESPONSE] Dọn ' + STATE.pendingPickMeta.length + ' metadata batch sau khi đã có kết quả cuối.');
        STATE.pendingPickMeta = [];
    }

    var effectiveSuccessCount = splitAllMode ? (batch.responseSuccessCount || 0) : counts.SUCCESS;
    if (effectiveSuccessCount > 0 && (CONFIG.stopAfterPick ||
        (CONFIG.maxOrdersPerSession > 0 && STATE.pickedCount >= CONFIG.maxOrdersPerSession))) {
        STATE.stopped = true;
        stopRefreshLoop();
        sendEvent('auto_stopped', { reason: 'Đã hoàn thành batch và đạt điều kiện dừng Auto Pick' });
        sendLog('⏹ [AUTO STOP] Đã đạt điều kiện dừng Auto Pick');
    }
}

function handlePickResponse(jsonStr, task) {
    try {
        var json = JSON.parse(jsonStr || '{}');
        var batch = STATE.activePickBatch;
        var meta = takePickMeta(task);
        if (meta) meta.status = 'RESOLVED';
        if (STATE.pendingPickResponses > 0) STATE.pendingPickResponses--;
        STATE.isBusy = STATE.pendingPickResponses > 0 || !!STATE.activePickBatch;
        var responseCodeText = json && json.code !== undefined && json.code !== null ? String(json.code).trim() : '';
        var hasExplicitResponseCode = /^-?\d+$/.test(responseCodeText);
        var responseCode = hasExplicitResponseCode ? parseInt(responseCodeText, 10) : NaN;
        if (hasExplicitResponseCode && responseCode === 0) {
            STATE.pickedCount++;
            if (batch) {
                batch.responseSuccessCount++;
                batch.responseDetails = batch.responseDetails || [];
                batch.responseDetails.push({ code: responseCode, msg: String(json.msg || json.message || 'success'), outcome: 'SUCCESS' });
                if (meta.unmapped || !(parseInt(meta.orderId || 0, 10) > 0)) {
                    if (batch.responseMode === 'SPLIT_ALL_CODE_ONLY') {
                        batch.codeOnlySuccessCount = (batch.codeOnlySuccessCount || 0) + 1;
                        logEvent('SUCCESS', 'PICK.SPLIT_ALL.CODE_ONLY_RESPONSE',
                            'Pick lẻ ALL nhận code 0; ghi nhận một response thành công', {
                                batch_id: batch.batchId,
                                response_success_count: batch.responseSuccessCount,
                                submitted_count: batch.submittedCount
                            });
                        sendLog('✅ [SPLIT ALL] Server xác nhận code 0 (' +
                            batch.responseSuccessCount + '/' + batch.total + ').');
                    } else {
                        batch.unknownSuccessCount++;
                        sendLog('⚠️ [PICK RESPONSE] Server trả code 0 nhưng response không có mã đơn để đối chiếu; không gán SUCCESS cho đơn bất kỳ.');
                        logEvent('WARNING', 'PICK.RESPONSE.UNMAPPED_SUCCESS', 'Server trả code 0 nhưng không xác định được mã đơn', { batch_id: batch.batchId });
                    }
                } else {
                    var successId = parseInt(meta.orderId, 10);
                    batch.successCount++;
                    batch.knownSuccessIds.push(successId);
                    setBatchItemStatus(successId, 'SUCCESS', 'Server trả code 0 và đối chiếu được delivery_order_id');
                }
                sendLog('[SUCCESS] Server xác nhận response batch (' + batch.responseSuccessCount + '/' + batch.total + ').');
            } else {
                if (meta.unmapped) {
                    // A success code without a correlatable order is not enough to emit a per-order notification.
                    sendLog('⚠️ [SUCCESS?] API trả code 0 nhưng không xác định được đơn tương ứng; không gán kết quả cho đơn bất kỳ.');
                } else {
                    var successMessage = String(json.msg || json.message || 'success');
                    logEvent('SUCCESS', 'PICK.RESPONSE.SUCCESS', 'Server xác nhận PICK thành công', {
                        order_id: meta.orderId || 0, price: meta.price || 0, response_code: responseCode, response_message: successMessage
                    });
                    sendEvent('pick_success', { info: meta.info, price: meta.price, orderId: meta.orderId || 0,
                        responseCode: responseCode, responseMessage: successMessage, forceNotify: !!meta.forceNotify, assignmentId: meta.assignmentId || '' });
                    sendLog('[SUCCESS] Pick OK: ' + meta.info + ' · code ' + responseCode + ' · ' + successMessage);
                }
                if (!meta.unmapped && (CONFIG.stopAfterPick || (CONFIG.maxOrdersPerSession > 0 && STATE.pickedCount >= CONFIG.maxOrdersPerSession))) {
                    STATE.stopped = true;
                    stopRefreshLoop();
                    sendEvent('auto_stopped', { reason: 'Đã đạt giới hạn pick hoặc cài đặt dừng sau pick' });
                    sendLog('⏹ [AUTO STOP] Đã đạt điều kiện dừng Auto Pick');
                }
            }
        } else if (!hasExplicitResponseCode) {
            var unknownReason = 'Response JSON không có trường code rõ ràng; không thể kết luận thành công hay thất bại';
            if (batch) {
                if (meta.unmapped || !(parseInt(meta.orderId || 0, 10) > 0)) {
                    batch.unmappedUnknownCount = (batch.unmappedUnknownCount || 0) + 1;
                } else {
                    var unknownId = parseInt(meta.orderId, 10);
                    setBatchItemStatus(unknownId, 'UNKNOWN', unknownReason);
                    // Keep the metadata/reservation so a later correlated response can still resolve it.
                    STATE.pendingPickMeta.push(meta);
                    setPickMetaStatus(unknownId, null, 'UNKNOWN', unknownReason);
                }
                logEvent('WARNING', 'PICK.RESPONSE.UNKNOWN_CODE', unknownReason, { batch_id: batch.batchId, order_id: meta.orderId || 0 });
                sendLog('⚠️ [PICK UNKNOWN] Response không có code rõ ràng; giữ trạng thái UNKNOWN, không tự xem là FAILED.');
            } else {
                if (meta && parseInt(meta.orderId || 0, 10) > 0) {
                    meta.status = 'UNKNOWN';
                    meta.statusDetail = unknownReason;
                    STATE.pendingPickMeta.push(meta);
                }
                STATE.isBusy = true;
                logEvent('WARNING', 'PICK.RESPONSE.UNKNOWN_CODE', unknownReason, { order_id: meta.orderId || 0 });
                sendLog('⚠️ [PICK UNKNOWN] Response không có code rõ ràng; giữ khóa PICK để đối chiếu, không tự xem là FAILED.');
            }
        } else {
            var r = json.msg || json.message || ('Code ' + json.code);
            if (batch) {
                if (batch.responseMode === 'SPLIT_ALL_CODE_ONLY' && (meta.unmapped || !(parseInt(meta.orderId || 0, 10) > 0))) {
                    batch.codeOnlyFailureCount = (batch.codeOnlyFailureCount || 0) + 1;
                    batch.responseDetails = batch.responseDetails || [];
                    batch.responseDetails.push({ code: responseCode, msg: String(r), outcome: 'FAILED' });
                    batch.failureReasons.push('Server từ chối một request Pick lẻ ALL: code ' + responseCode + ' · ' + String(r));
                    logEvent('ERROR', 'PICK.SPLIT_ALL.CODE_ONLY_FAILURE', 'Server từ chối request Pick lẻ ALL', {
                        batch_id: batch.batchId, response_failure_count: batch.codeOnlyFailureCount,
                        total_count: batch.total, response_code: responseCode, reason: String(r)
                    });
                    sendLog('❌ [SPLIT ALL] Server từ chối request (code ' + responseCode + '): ' + String(r) +
                        ' (' + ((batch.responseSuccessCount || 0) + batch.codeOnlyFailureCount) + '/' + batch.total + ' response).');
                } else if (meta.unmapped || !(parseInt(meta.orderId || 0, 10) > 0)) {
                    batch.unmappedFailureCount++;
                    batch.failureReasons.push('Response thất bại nhưng không xác định được mã đơn: ' + String(r));
                    logEvent('WARNING', 'PICK.RESPONSE.UNMAPPED_FAILURE', 'Server trả lỗi nhưng response không xác định được mã đơn', { batch_id: batch.batchId, reason: String(r) });
                } else {
                    var failedId = parseInt(meta.orderId, 10);
                    batch.failureCount++;
                    batch.failureReasons.push('Đơn #' + failedId + ': ' + String(r));
                    setBatchItemStatus(failedId, 'FAILED', String(r));
                    batch.responseDetails = batch.responseDetails || [];
                    batch.responseDetails.push({ code: responseCode, msg: String(r), outcome: 'FAILED', orderId: failedId });
                }
                sendLog('[FAIL] Một response trong batch thất bại: ' + String(r));
            } else {
                logEvent('ERROR', 'PICK.RESPONSE.FAILED', 'Server từ chối PICK', {
                    order_id: meta.orderId || 0, reason: String(r), response_code: responseCode
                });
                sendEvent('pick_failed', { reason: r, info: meta.info, orderId: meta.orderId || 0,
                    responseCode: responseCode, responseMessage: String(r), forceNotify: !!meta.forceNotify, assignmentId: meta.assignmentId || '' });
                sendLog('[FAIL] ' + meta.info + ' — code ' + responseCode + ' · ' + r);
            }
        }
        if (batch && (STATE.pendingPickResponses === 0 || batch.summaryEmitted)) {
            finishPickBatch(false, 0);
        } else if (!batch && STATE.pendingPickResponses === 0 && STATE.pendingPickMeta.length > 0) {
            var unresolvedMeta = STATE.pendingPickMeta.filter(function (entry) { return entry.status === 'UNKNOWN'; });
            if (unresolvedMeta.length > 0) {
                STATE.isBusy = true;
                sendLog('⚠️ [PICK UNKNOWN] Giữ ' + unresolvedMeta.length + ' metadata UNKNOWN; không mở khóa PICK tự động.');
            } else {
                sendLog('⚠️ [PICK RESPONSE] Dọn ' + STATE.pendingPickMeta.length + ' metadata còn sót sau khi batch kết thúc.');
                STATE.pendingPickMeta = [];
            }
        }
    } catch (e) { sendLog('[PICK RESPONSE] Parse lỗi: ' + String(e)); }
}

function processPickResponseChunk(chunk, url, task) {
    if (!chunk || typeof chunk !== 'string') return;
    var key = String(url || 'pick');
    try { if (task && task.handle) key += '#' + task.handle.toString(); } catch (e) {}
    var bufferEntry = bufferAppend('pickResponseBuffers', key, chunk);
    if (!bufferEntry) {
        sendLog('⚠️ Pick response vượt giới hạn buffer; bỏ qua payload để bảo vệ bộ nhớ.');
        return;
    }
    if (!bufferLooksComplete(bufferEntry)) { bufferStore('pickResponseBuffers', key, bufferEntry); return; }
    var combined = bufferText(bufferEntry);
    try {
        JSON.parse(combined);
        memDelete('pickResponseBuffers', key);
        var testToken = findPendingApiTestToken(task);
        if (!testToken && STATE.activeApiTestToken && STATE.pendingApiTests[STATE.activeApiTestToken] && STATE.pendingPickResponses === 0) {
            // While a dummy-ID test is the only pick request allowed in flight, correlate by endpoint.
            var pendingTest = STATE.pendingApiTests[STATE.activeApiTestToken];
            if (pendingTest && pendingTest.endpoint === url) testToken = STATE.activeApiTestToken;
        }
        if (testToken) processFakeApiTestResponseChunk(combined, url, task, testToken);
        else handlePickResponse(combined, task);
    } catch (e) {
        bufferStore('pickResponseBuffers', key, bufferEntry);
        if (CONFIG.verboseLog) sendLog('[PICK RESPONSE] JSON response chưa hợp lệ; giữ buffer trong TTL để nhận phần tiếp theo.');
    }
}

function assignmentOrderSource(data) {
    // Prefer the actual deliveries array from the confirmed API response when populated.
    if (data && Array.isArray(data.deliveries) && data.deliveries.length > 0) return data.deliveries;
    // Compatibility fallback for older/partially populated response shapes.
    if (data && Array.isArray(data.old_divisions) && data.old_divisions.length > 0) return data.old_divisions;
    return data && Array.isArray(data.deliveries) ? data.deliveries : [];
}

function processAssignmentChunk(chunk, url, requestObject) {
    if (!chunk || typeof chunk !== 'string') return;
    var key = String(url || 'assignment');
    try {
        if (requestObject && requestObject.handle) key += '#' + requestObject.handle.toString();
    } catch (e) {}
    var bufferEntry = bufferAppend('assignmentBuffers', key, chunk);
    // A malformed/incomplete response must never grow without limit.
    if (!bufferEntry) {
        sendLog('⚠️ Assignment payload vượt quá giới hạn đọc; bỏ qua response.');
        return;
    }
    if (!bufferLooksComplete(bufferEntry)) { bufferStore('assignmentBuffers', key, bufferEntry); return; }
    var combined = bufferText(bufferEntry);
    var parsed;
    try { parsed = JSON.parse(combined); }
    catch (e) { bufferStore('assignmentBuffers', key, bufferEntry); return; }
    memDelete('assignmentBuffers', key);
    processAssignmentPayload(parsed, url);
}

function processAssignmentPayload(jsonStr, url) {
    try {
        // Assignment notifications are independent of price/category/distance filters.
        if (CONFIG.notifyOnAssignment === false) return;
        // Never infer an assignment from an unrelated response.
        if (!url || url.indexOf('/api/v6/assignment/get-assignment-info') < 0) return;
        if (!jsonStr) return;
        var response;
        if (typeof jsonStr === 'string') {
            if (jsonStr.indexOf('"assignment_id"') < 0 && jsonStr.indexOf('"assignmentId"') < 0) return;
            response = JSON.parse(jsonStr);
        } else {
            response = jsonStr;                           // object đã parse từ processAssignmentChunk
        }
        if (!response || parseInt(response.code, 10) !== 0 || !response.data) return;
        var data = response.data;
        var rawAid = data.assignment_id !== undefined ? data.assignment_id : data.assignmentId;
        if (rawAid === undefined || rawAid === null || String(rawAid).length === 0) return;
        var assignmentId = String(rawAid);
        var deliveries = assignmentOrderSource(data);
        var ids = [];
        var distances = {};
        for (var i = 0; i < deliveries.length; i++) {
            var d = deliveries[i] || {};
            var rawId = d.delivery_order_id || d.deliveryOrderId;
            var id = parseInt(rawId || 0, 10);
            if (!(id > 0)) continue;
            var key = String(id);
            if (ids.indexOf(id) < 0) ids.push(id);
            var dist = parseInt(d.delivery_distance || 0, 10);
            if (dist > 0) distances[key] = dist;
        }
        ids.sort(function (a, b) {
            return (distances[String(b)] || 0) - (distances[String(a)] || 0);
        });
        var expectedCount = deliveries.length;
        var isGroup = expectedCount > 1 || ids.length > 1;
        var item = {
            assignmentId: assignmentId,
            orderIds: ids,
            expectedOrderCount: expectedCount,
            isGroup: isGroup,
            incompleteGroup: isGroup && ids.length < expectedCount,
            preGroupCode: data.pre_group_code || data.preGroupCode || null,
            price: parseInt(data.total_earnings_amount || data.earnings_amount || data.price || 0, 10) || 0,
            distance: parseInt(data.delivery_distance || 0, 10) || 0,
            canPickRequest: !!(STATE.networkingObj && getPickRequestTemplate()),
            sourceURL: String(url)
        };
        // Refresh only an assignment that is still pending. Never resurrect one already skipped/queued.
        if (STATE.notifiedAssignmentIds[assignmentId]) {
            if (STATE.pendingAssignments[assignmentId]) memSet('pendingAssignments', assignmentId, item, true);
            return;
        }
        memSet('pendingAssignments', assignmentId, item);
        memSet('notifiedAssignmentIds', assignmentId, true);
        sendEvent('assignment_detected', item);
        logEvent('INFO', 'ASSIGNMENT.DETECTED', 'Đã nhận assignment từ API', { assignment_id: assignmentId, order_ids: ids, expected_count: expectedCount, is_group: isGroup });
        sendLog('🔔 [ASSIGNMENT] ID=' + assignmentId + ', đơn=' + ids.length + '/' + expectedCount +
            (item.incompleteGroup ? ' (thiếu delivery_order_id)' : ''));
    } catch (e) {
        if (CONFIG.verboseLog) sendLog('[ASSIGNMENT] Không đọc được payload: ' + String(e));
    }
}

function resolveAssignmentAction(assignmentId, action, retries, actionOptions) {
    actionOptions = actionOptions || {};
    var key = String(assignmentId || '');
    function reportAssignmentFailure(reason) {
        var text = String(reason || 'Không thể Pick Assignment.');
        if (actionOptions.source === 'assignment_history') {
            sendEvent('assignment_repick_failed', { assignmentId: key, reason: text });
        }
        sendEvent('pick_failed', { reason: text, info: 'Assignment ' + key,
            forceNotify: true, assignmentId: key });
    }
    var item = STATE.pendingAssignments[key];
    if (!item) { var missingReason = 'Assignment không còn trong bộ nhớ phiên hiện tại.'; reportAssignmentFailure(missingReason); sendLog('⚠️ Assignment đã hết hạn hoặc không còn trong bộ nhớ: ' + assignmentId); return; }
    if (action === 'skip') {
        memDelete('pendingAssignments', key);
        sendLog('⏭ Bỏ qua assignment ' + assignmentId);
        return;
    }
    var ids = Array.isArray(item.orderIds) ? item.orderIds : [];
    if (item.incompleteGroup || ids.length === 0) {
        reportAssignmentFailure('Dữ liệu assignment thiếu delivery_order_id; chưa gửi lệnh pick.');
        sendLog('❌ Từ chối pick assignment thiếu mã đơn: ' + assignmentId);
        return;
    }
    if (action === 'single' && (item.isGroup || ids.length !== 1)) {
        reportAssignmentFailure('Assignment có nhiều đơn; không dùng được thao tác Pick 1 đơn.');
        sendLog('🛡 Chặn thao tác single trên assignment chùm ' + assignmentId);
        return;
    }
    if (action === 'split' && ids.length < 2) {
        reportAssignmentFailure('Assignment chỉ có một đơn; hãy dùng Pick lẻ 1 đơn.');
        sendLog('🛡 Chặn thao tác split trên assignment đơn lẻ ' + assignmentId);
        return;
    }
    // Don't discard the assignment if the request context isn't ready yet.
    if (!STATE.networkingObj || !getPickRequestTemplate()) {
        reportAssignmentFailure('Chưa ghi nhận request context; hãy mở lại màn hình đơn/assignment rồi thử lại.');
        // Allow the next assignment-info response to show the prompt again.
        memDelete('notifiedAssignmentIds', key);
        sendLog('⚠️ Chưa có request context; sẽ cho phép hiện lại popup khi nhận response assignment kế tiếp.');
        return;
    }
    retries = retries || 0;
    if (STATE.isBusy) {
        if (retries < 20) {
            setTimeout(function () { if (!STATE.disposed) resolveAssignmentAction(assignmentId, action, retries + 1, actionOptions); }, 300);
            return;
        }
        reportAssignmentFailure('AutoPick vẫn đang xử lý request khác; chưa gửi Pick lại.');
        memDelete('notifiedAssignmentIds', key);
        sendLog('⚠️ Đang bận quá lâu; cho phép nhắc lại assignment ' + assignmentId);
        return;
    }
    var queued = false;
    var pickSource = actionOptions.source || 'assignment_popup';
    if (action === 'single') {
        queued = sendPickSingle(ids[0], item.price || 0, {
            forceNotify: true, assignmentId: key, source: pickSource
        });
    } else if (action === 'split') {
        queued = sendPickBatch(ids, item.price || 0, 'Assignment ' + assignmentId, null, {
            splitAllCodeOnlySuccess: true,
            forceNotify: true,
            assignmentId: key,
            source: pickSource
        });
    }
    if (queued) {
        memDelete('pendingAssignments', key);
        if (actionOptions.source === 'assignment_history') {
            sendEvent('assignment_repick_started', { assignmentId: key, orderIds: ids.slice() });
        }
        sendLog('📤 Đã đưa thao tác assignment ' + assignmentId + ' vào hàng gửi. Đang chờ phản hồi server.');
    } else {
        var queueReason = 'Không thể khởi tạo request pick. Assignment vẫn được giữ lại.';
        reportAssignmentFailure(queueReason);
    }
}

function installHooks() {
    if (STATE.installed) return true;
    if (typeof ObjC === 'undefined' || !ObjC.available) {
        if (!STATE.hookUnavailableLogged) { STATE.hookUnavailableLogged = true; logEvent('WARNING', 'HOOK.OBJC_UNAVAILABLE', 'Objective-C runtime chưa sẵn sàng để cài hook', {}); }
        return false;
    }

    var NC = ObjC.classes.RCTNetworking;
    if (!NC) {
        if (!STATE.hookUnavailableLogged) { STATE.hookUnavailableLogged = true; logEvent('WARNING', 'HOOK.RCTNETWORKING_MISSING', 'Không tìm thấy RCTNetworking; sẽ tiếp tục thử lại', {}); }
        return false;
    }
    var m = NC['- sendRequest:responseType:incrementalUpdates:responseSender:'];
    if (m) {
        Interceptor.attach(m.implementation, {
            onEnter: function (args) {
                try {
                    if (!STATE.networkingObj) STATE.networkingObj = new ObjC.Object(args[0]);
                    var req = new ObjC.Object(args[2]);
                    if (!req.isKindOfClass_(ObjC.classes.NSURLRequest)) return;
                    var url = req.URL().absoluteString().toString();
                    // Exact full-URL block only: never match a hostname/domain or URL prefix.
                    var blockedURL = String(CONFIG.blockedURL || '').trim();
                    if (blockedURL && url === blockedURL) {
                        try {
                            var blockedReq = req.mutableCopy();
                            var blockedNSURL = ObjC.classes.NSURL.URLWithString_(ObjC.classes.NSString.stringWithString_('autopick-blocked://exact-url'));
                            blockedReq.setURL_(blockedNSURL);
                            args[2] = blockedReq.handle;
                            sendLog('[URL BLOCK] Đã chặn đúng URL được cấu hình: ' + url);
                        } catch (blockErr) {
                            sendLog('[URL BLOCK] Không thể áp dụng chặn URL: ' + String(blockErr));
                        }
                        return;
                    }
                    if (url.indexOf('/api/v6/assignment/get-assignment-info') >= 0) {
                        STATE.assignmentRequest = req.mutableCopy();
                        if (CONFIG.verboseLog) sendLog('[ASSIGNMENT] Đã thấy request get-assignment-info.');
                    }
                    if (url.indexOf('free-pick/get-order-list') >= 0) {
                        modifyRequestInPlace(req);
                        if (!STATE.savedRequest || !STATE.savedRequest.handle.equals(req.handle)) {
                            STATE.savedRequest = req.mutableCopy();
                            if (!STATE.autoLoopStarted && CONFIG.enabled && !STATE.stopped) {
                                startRefreshLoop(1500);
                                sendLog('[START] Auto Load & Pick Active!');
                            }
                        }
                    }
                } catch (e) {}
            }
        });
    }

    var H = ObjC.classes.RCTHTTPRequestHandler;
    if (H) {
        var m2 = H['- shpNetworkingModule:shpRequest:didReceiveData:'];
        if (m2) {
            Interceptor.attach(m2.implementation, {
                onEnter: function (args) {
                    try {
                        var req = new ObjC.Object(args[3]);
                        var url = '', st = 0;
                        if (req && req.respondsToSelector_(ObjC.selector('response'))) {
                            var r = req.response();
                            if (r && r.isKindOfClass_(ObjC.classes.NSHTTPURLResponse)) {
                                url = r.URL().absoluteString().toString();
                                st = r.statusCode().valueOf();
                            }
                        }
                        if (!url) return;
                        var data = null, len = 0;
                        if (!args[4].isNull()) { data = new ObjC.Object(args[4]); len = data.length().valueOf(); }
                        var isDeliveryList = isPickedOrderListURL(url);
                        var isRefreshList = !isDeliveryList && url.indexOf('free-pick/get-order-list') >= 0;
                        // Callback nhận dữ liệu khác callback hoàn tất: với refresh lỗi, status được ghi nhận
                        // đúng một lần cho mỗi task (xem handleRefreshHTTPStatus), kể cả khi body rỗng/nhiều chunk.
                        if (isRefreshList && st !== 200) { handleRefreshHTTPStatus(st, req); return; }
                        if (len < 1) return;
                        if (isDeliveryList) {
                            if (st === 200) {
                                if (CONFIG.orderDataUploadEnabled) {
                                    decodeDataToString(data, function (s) { processDeliveryOrderListChunk(s, url, req); });
                                }
                            } else if (CONFIG.orderDataUploadEnabled) {
                                sendLogThrottled('delivery-http', '[ORDER DATA] HTTP ' + st + '; không upload response lỗi.', 10000);
                            }
                        } else if (isRefreshList) {
                            decodeDataToString(data, function (s) { processOrderListChunk(s, url, req); });
                        } else if (url.indexOf('free-pick/pick') >= 0 ||
                                   url.indexOf('free-pick/mpick') >= 0) {
                            decodeDataToString(data, function (s) {
                                sendLog('📥 [SERVER]: ' + s);
                                processPickResponseChunk(s, url, req);
                            });
                        } else if (url.indexOf('/api/v6/assignment/get-assignment-info') >= 0) {
                            if (st !== 200) {
                                sendLog('[ASSIGNMENT] Response HTTP ' + st + '; chưa tạo popup.');
                            } else if (len > 262144) {
                                sendLog('[ASSIGNMENT] Response lớn hơn giới hạn 256 KB; bỏ qua payload.');
                            } else {
                                if (CONFIG.verboseLog) sendLog('[ASSIGNMENT] Đã bắt response · ' + len + ' bytes; đang đọc assignment.');
                                decodeDataToString(data, function (s) { processAssignmentChunk(s, url, req); });
                            }
                        }
                    } catch (e) {}
                }
            });
        }
    }
    STATE.installed = true;
    STATE.hookUnavailableLogged = false;
    logEvent('SUCCESS', 'HOOK.INSTALLED', 'Đã cài đặt hook RCTNetworking thành công', { hook: 'RCTNetworking.sendRequest' });
    sendLog('[HOOK] Cai dat thanh cong');
    return true;
}

recv(function onMessage(message) {
    try {
        var type = message.type;
        if (type === 'gunzip_reply') {
            handleGunzipReply(message);
        } else if (type === 'test_free_pick') {
            previewLiveApiTest('free_pick');
        } else if (type === 'test_mpick') {
            previewLiveApiTest('mpick');
        } else if (type === 'test_live_preview') {
            previewLiveApiTest(message.kind);
        } else if (type === 'test_live_confirm') {
            confirmLiveApiTest(message.token, message.kind);
        } else if (type === 'prefs' && message.data) {
            for (var k in message.data) CONFIG[k] = message.data[k];
            if (!CONFIG.orderDataUploadEnabled) STATE.pendingOrderDataUpload = null;
            if (CONFIG.enabled && !STATE.stopped && !STATE.autoLoopStarted && STATE.savedRequest) {
                startRefreshLoop(0);
            }
        } else if (type === 'start') {
            CONFIG.enabled = true;
            STATE.stopped = false;
            // START must never erase in-flight/unknown pick reservations or the de-duplication cache.
            // Only reset the session counter when no request is awaiting a server result.
            var pickStillPending = hasPendingPickWork();
            var testStillPending = !!STATE.activeApiTestToken || Object.keys(STATE.pendingApiTests || {}).length > 0;
            STATE.isBusy = pickStillPending || testStillPending;
            if (!pickStillPending) STATE.pickedCount = 0;
            if (pickStillPending) sendLog('[START] Còn request PICK đang chờ hoặc UNKNOWN; tiếp tục refresh nhưng giữ khóa chống pick trùng.');
            else if (testStillPending) sendLog('[START] Request API test vẫn đang chờ response; giữ khóa đến khi có kết quả.');
            if (STATE.refreshReq) finishRefreshRequest(STATE.refreshReq, 'cancelled');
            STATE.refreshInFlight = false;
            // START luôn tạo generation mới; không bao giờ có hai vòng refresh độc lập.
            startRefreshLoop(0);
            sendLog('[START] BAT AUTO');
        } else if (type === 'stop') {
            CONFIG.enabled = false; STATE.stopped = true;
            stopRefreshLoop();
            clearTransientData();
            sendLog('[STOP] TAT AUTO');
        } else if (type === 'memory_stats') {
            sendEvent('memory_stats', memoryGuardSnapshot());
        } else if (type === 'mem_limits' && message.data) {
            for (var mk in message.data) if (MEM_LIMITS[mk] && message.data[mk]) {
                if (message.data[mk].ttl > 0) MEM_LIMITS[mk].ttl = message.data[mk].ttl;
                if (message.data[mk].max > 0) MEM_LIMITS[mk].max = message.data[mk].max;
            }
        } else if (type === 'assignment_action') {
            resolveAssignmentAction(message.assignmentId, message.action);
        } else if (type === 'assignment_repick') {
            var saved = message.assignment && typeof message.assignment === 'object' ? message.assignment : {};
            var savedId = String(saved.assignmentId || saved.assignment_id || '');
            var savedIds = Array.isArray(saved.orderIds) ? saved.orderIds.map(function (x) { return parseInt(x, 10); }).filter(function (x) { return x > 0; }) : [];
            if (!savedId || savedIds.length === 0) {
                sendEvent('assignment_repick_failed', { assignmentId: savedId, reason: 'Dữ liệu Assignment đã lưu không có mã đơn hợp lệ.' });
            } else {
                var restored = {
                    assignmentId: savedId,
                    orderIds: savedIds,
                    expectedOrderCount: parseInt(saved.expectedOrderCount || saved.expected_order_count || savedIds.length, 10) || savedIds.length,
                    isGroup: savedIds.length > 1 || !!saved.isGroup,
                    incompleteGroup: !!saved.incompleteGroup,
                    price: parseInt(saved.price || 0, 10) || 0,
                    distance: parseInt(saved.distance || 0, 10) || 0,
                    preGroupCode: saved.preGroupCode || null,
                    canPickRequest: true
                };
                STATE.pendingAssignments[savedId] = restored;
                resolveAssignmentAction(savedId, savedIds.length > 1 ? 'split' : 'single', 0, { source: 'assignment_history' });
            }
        }
    } catch (e) {}
    recv(onMessage);
});

// Dọn dữ liệu tạm khi STOP: buffer chưa hoàn chỉnh, callback gunzip, request refresh đang chờ.
// KHÔNG xóa pickedIds/notifiedIds/pendingAssignments (dữ liệu nghiệp vụ, tránh pick trùng).
function clearTransientData() {
    memClear('assignmentBuffers'); memClear('orderListBuffers'); memClear('deliveryOrderListBuffers');
    memClear('pickResponseBuffers'); memClear('testResponseBuffers'); memClear('pendingGunzipCallbacks');
    memClear('abandonedTasks'); memClear('statusSeen');
    STATE.pendingOrderDataUpload = null;
}

// Gọi khi agent bị unload: dọn toàn bộ timer và dữ liệu còn sót.
function disposeAgent() {
    if (hasPendingPickWork()) sendLog('[DISPOSE] Agent unload khi còn PICK pending/UNKNOWN; trạng thái runtime sẽ mất, hãy đối chiếu app tài xế trước khi bật lại để tránh gửi trùng.');
    STATE.disposed = true;
    stopRefreshLoop();
    safeClearTimeout(STATE.busyTimer); STATE.busyTimer = null;
    safeClearTimeout(STATE.configTimer); STATE.configTimer = null;
    safeClearInterval(STATE.hookTimer); STATE.hookTimer = null;
    safeClearInterval(STATE.sweepTimer); STATE.sweepTimer = null;
    for (var tk in STATE.pendingApiTests) { try { safeClearTimeout(STATE.pendingApiTests[tk].timeoutHandle); } catch (e) {} }
    STATE.pendingApiTests = {}; STATE.activeApiTestToken = null; STATE.liveTestPreviews = {};
    clearTransientData();
    memClear('pendingAssignments'); memClear('notifiedAssignmentIds');
    memClear('pickedIds'); memClear('notifiedIds');
    STATE.pendingPickMeta = []; STATE.activePickBatch = null;
    STATE.savedRequest = null; STATE.assignmentRequest = null; STATE.networkingObj = null;
}
try { if (typeof rpc !== 'undefined') rpc.exports = { dispose: disposeAgent }; } catch (e) {}

startMemorySweeper();
var tries = 0;
STATE.hookTimer = setInterval(function () {
    if (STATE.disposed) { safeClearInterval(STATE.hookTimer); STATE.hookTimer = null; return; }
    if (installHooks()) { safeClearInterval(STATE.hookTimer); STATE.hookTimer = null; return; }
    if (++tries > 60) { safeClearInterval(STATE.hookTimer); STATE.hookTimer = null; }
}, 1000);
