'use strict';

function sendLog(msg) {
    try { send({ type: 'logs', lines: [String(msg)] }); } catch (e) {}
}
function sendEvent(type, extra) {
    try {
        var p = { type: type };
        if (extra) for (var k in extra) p[k] = extra[k];
        send(p);
    } catch (e) {}
}

var CONFIG = {
    enabled: true, autoRefresh: true, autoPick: true, stopAfterPick: false,
    verboseLog: false, notifyOnAssignment: true, refreshIntervalMs: 300, maxRequestAge: 25,
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
    pendingGunzipCallbacks: {}, nextGunzipId: 1,
    lastFreePickSnapshot: [], lastFreePickSnapshotAt: 0, refreshInFlight: false,
    lastRefreshStartedAt: 0, refreshBackoffMs: 0, refreshBackoffUntil: 0, liveTestPreviews: {}, pendingApiTests: {}, activeApiTestToken: null, nextApiTestId: 0, testResponseBuffers: {}, pickResponseBuffers: {}, orderListBuffers: {},
    activePickBatch: null, deliveryOrderListBuffers: {}, orderDataUploadInFlight: false, pendingOrderDataUpload: null,
    orderDataUploadBlocks: {}, nextOrderDataUploadId: 0, lastMissingUploadTokenLogAt: 0
};

var URLS = {
    pick: 'https://gpartner.deliverynow.vn/api/v6/free-pick/pick',
    mpick: 'https://gpartner.deliverynow.vn/api/v6/free-pick/mpick',
    orderDataUpload: 'https://phau.io.vn/receive-orders.php'
};

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
setTimeout(loadConfigFromDisk, 500);

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
            var gunzipId = STATE.nextGunzipId++;
            STATE.pendingGunzipCallbacks[String(gunzipId)] = cb;
            var compressedB64 = nsData.base64EncodedStringWithOptions_(0).toString();
            send({ type: 'gunzip', id: gunzipId, data: compressedB64 });
            setTimeout(function () {
                if (STATE.pendingGunzipCallbacks[String(gunzipId)]) {
                    delete STATE.pendingGunzipCallbacks[String(gunzipId)];
                    sendLog('⚠️ [GZIP] Hết thời gian giải nén response; chưa xử lý được payload.');
                }
            }, 7000);
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
    if (!cb) return;
    delete STATE.pendingGunzipCallbacks[id];
    try {
        if (!message.data) throw new Error('empty gunzip data');
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
    delete STATE.testResponseBuffers[token];
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
    var combined = (STATE.testResponseBuffers[token] || '') + chunk;
    if (combined.length > 65536) {
        finishFakeApiTest(token, '', task, true);
        sendLog('[API-TEST] Response vượt 64 KB; đã dừng đọc để bảo vệ bộ nhớ.');
        return true;
    }
    try {
        JSON.parse(combined);
        finishFakeApiTest(token, combined, task, false);
    } catch (e) {
        STATE.testResponseBuffers[token] = combined;
        setTimeout(function () {
            if (STATE.testResponseBuffers[token] === combined) delete STATE.testResponseBuffers[token];
        }, 5000);
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

function handleRefreshHTTPStatus(status) {
    var code = parseInt(status || 0, 10);
    STATE.refreshInFlight = false;
    if (code === 429 || code === 503 || code >= 500) {
        var previous = parseInt(STATE.refreshBackoffMs || 0, 10);
        STATE.refreshBackoffMs = previous > 0 ? Math.min(15000, previous * 2) : 1000;
        STATE.refreshBackoffUntil = Date.now() + STATE.refreshBackoffMs;
        sendLog('[REFRESH] HTTP ' + code + '; backoff ' + STATE.refreshBackoffMs + 'ms để giảm request khi server quá tải.');
    } else {
        sendLog('[REFRESH] HTTP ' + code + ' khi lấy danh sách đơn.');
    }
}

function clearRefreshBackoff() {
    if (STATE.refreshBackoffMs > 0 && CONFIG.verboseLog) {
        sendLog('[REFRESH] API phản hồi OK; xóa backoff và quay lại chu kỳ cấu hình.');
    }
    STATE.refreshBackoffMs = 0;
    STATE.refreshBackoffUntil = 0;
}

function processOrderListChunk(chunk, url, requestObject) {
    if (!chunk || typeof chunk !== 'string') return;
    var key = String(url || 'order-list');
    try { if (requestObject && requestObject.handle) key += '#' + requestObject.handle.toString(); } catch (e) {}
    var combined = (STATE.orderListBuffers[key] || '') + chunk;
    if (combined.length > 1048576) {
        delete STATE.orderListBuffers[key];
        STATE.refreshInFlight = false;
        sendLog('⚠️ Order-list response vượt quá 1 MB; bỏ qua payload để bảo vệ bộ nhớ.');
        return;
    }
    try {
        JSON.parse(combined);
        delete STATE.orderListBuffers[key];
        processOrderList(combined);
    } catch (e) {
        STATE.orderListBuffers[key] = combined;
        setTimeout(function () {
            if (STATE.orderListBuffers[key] === combined) delete STATE.orderListBuffers[key];
        }, 5000);
    }
}

function isPickedOrderListURL(url) {
    return String(url || '').indexOf('https://gpartner.deliverynow.vn/api/v6/delivery/get-order-list') === 0;
}

function processDeliveryOrderListChunk(chunk, url, requestObject) {
    if (!chunk || typeof chunk !== 'string') return;
    var key = String(url || 'delivery-order-list');
    try { if (requestObject && requestObject.handle) key += '#' + requestObject.handle.toString(); } catch (e) {}
    var combined = (STATE.deliveryOrderListBuffers[key] || '') + chunk;
    if (combined.length > 5242880) {
        delete STATE.deliveryOrderListBuffers[key];
        sendLog('⚠️ [ORDER DATA] Response get-order-list vượt 5 MB; bỏ qua để bảo vệ bộ nhớ.');
        return;
    }
    try {
        JSON.parse(combined);
        delete STATE.deliveryOrderListBuffers[key];
        processDeliveryOrderListResponse(combined);
    } catch (e) {
        STATE.deliveryOrderListBuffers[key] = combined;
        setTimeout(function () {
            if (STATE.deliveryOrderListBuffers[key] === combined) delete STATE.deliveryOrderListBuffers[key];
        }, 10000);
    }
}

function processDeliveryOrderListResponse(jsonStr) {
    // Deliberately require the feature toggle, successful API code, and a non-empty orders array.
    if (!CONFIG.orderDataUploadEnabled) return false;
    var json;
    try { json = JSON.parse(jsonStr || '{}'); } catch (e) { return false; }
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
    STATE.pendingOrderDataUpload = null;
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

function processOrderList(jsonStr) {
    STATE.refreshInFlight = false;
    clearRefreshBackoff();
    try {
        var json = JSON.parse(jsonStr);
        var orders = json.data && json.data.orders;
        if (json.code !== undefined && String(json.code) !== '0') orders = [];
        if (!Array.isArray(orders)) orders = [];
        // Keep only recent real candidates for explicitly confirmed live API tests.
        // This snapshot is collected even when auto-pick is disabled or busy.
        STATE.lastFreePickSnapshot = orders.slice(0, 100);
        STATE.lastFreePickSnapshotAt = Date.now();
        if (orders.length === 0) return;
        if (!CONFIG.enabled || STATE.stopped || STATE.isBusy) return;

        var validOrders = [];

        // 1. LỌC TẤT CẢ CÁC ĐƠN THỎA MÃN BỘ LỌC CƠ BẢN & MIN KM
        for (var i = 0; i < orders.length; i++) {
            var o = orders[i];
            var dos = o.delivery_orders;
            if (!Array.isArray(dos) || dos.length === 0) continue;
            
            var reason = checkOrder(o);
            if (reason) {
                if (CONFIG.verboseLog) sendLog('  [X] #' + dos[0].delivery_order_id + ' - ' + reason);
                continue;
            }
            
            var isGroup = (o.pre_group_code != null && dos.length > 1);

            // Nếu đang bật Pick lẻ trong chùm -> Bỏ qua đơn lẻ ngay từ vòng lọc
            if (CONFIG.pickAllSinglesInGroup && !isGroup) {
                if (CONFIG.verboseLog) sendLog('  [X] Bỏ qua đơn lẻ (Đang bật chế độ chỉ Pick chùm)');
                continue;
            }

            // Nếu là chùm, kiểm tra Min Km
            if (CONFIG.pickAllSinglesInGroup && isGroup) {
                var dist = parseInt(o.delivery_distance || 0, 10);
                if (CONFIG.pickAllSinglesInGroupMinDistance > 0 && dist < CONFIG.pickAllSinglesInGroupMinDistance) {
                    if (CONFIG.verboseLog) sendLog('  [X] Bỏ qua chùm ' + (dist/1000).toFixed(1) + 'km < MinDistance');
                    continue; 
                }
            }

            validOrders.push(o);
            if (CONFIG.verboseLog) sendLog('  [OK] PASS: #' + dos[0].delivery_order_id);
        }

        if (validOrders.length === 0) return;

        // 2. CHỌN ĐƠN/CHÙM CÓ GIÁ CAO NHẤT TRONG SỐ CÁC ĐƠN HỢP LỆ
        var bestOrder = validOrders[0];
        var bestScore = parseInt(bestOrder.total_earnings_amount || 0, 10);

        for (var k = 1; k < validOrders.length; k++) {
            var sc = parseInt(validOrders[k].total_earnings_amount || 0, 10);
            if (sc > bestScore) {
                bestScore = sc;
                bestOrder = validOrders[k];
            }
        }

        var bDos = bestOrder.delivery_orders;
        var isGroup = (bestOrder.pre_group_code != null && bDos.length > 1);
        var firstOid = parseInt(bDos[0].delivery_order_id || 0, 10);
        var key = isGroup ? String(bestOrder.pre_group_code) : String(firstOid);

        if (!STATE.notifiedIds[key]) {
            STATE.notifiedIds[key] = true;
            sendEvent('match', { order: bestOrder });
        }

        if (!CONFIG.autoPick) return;
        if (CONFIG.maxOrdersPerSession > 0 && STATE.pickedCount >= CONFIG.maxOrdersPerSession) {
            STATE.stopped = true; return;
        }
        var nowSec = Date.now() / 1000.0;
        if (CONFIG.cooldown > 0 && (nowSec - STATE.lastPickTime) < CONFIG.cooldown) return;
        if (STATE.pickedIds[key]) return;
        STATE.pickedIds[key] = true;
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
                STATE.pickedIds[String(oid2)] = true;
                sendLog('   #' + (s2 + 1) + ': ' + oid2 + ' (' + (parseInt(sortedDos[s2].delivery_distance || 0, 10) / 1000).toFixed(1) + 'km)');
            }
            if (singleIds.length > 0) {
                if (CONFIG.maxOrdersPerSession > 0 && STATE.pickedCount + singleIds.length > CONFIG.maxOrdersPerSession) {
                    STATE.stopped = true;
                    STATE.autoLoopStarted = false;
                    sendEvent('auto_stopped', { reason: 'Chùm ' + singleIds.length + ' đơn vượt số lượt còn lại trong phiên; không gửi một phần chùm.' });
                    sendLog('⏹ [AUTO STOP] Bỏ qua toàn bộ chùm để không vượt giới hạn phiên hoặc chỉ lấy một phần chùm.');
                    return;
                }
                sendLog('🔀 [SPLIT ALL] Chùm ' + bDos.length + ' đơn (Tổng: ' + (totalGroupDistance / 1000).toFixed(1) + 'km) -> pick lẻ xa → gần');
                sendPickBatch(singleIds, bestScore, 'Chùm ' + bDos.length + ' đơn');
            }
        } else {
            if (isGroup) {
                sendLog('📦 Chùm ' + bDos.length + ' đơn (Không bật Pick lẻ) -> Dùng MPICK');
                var ids = [];
                for (var j = 0; j < bDos.length; j++) ids.push(parseInt(bDos[j].delivery_order_id, 10));
                sendPickGroup(bestOrder.pre_group_code, ids, bestScore, bDos.length);
            } else {
                sendPickSingle(firstOid, bestScore);
            }
        }
    } catch (e) { if (CONFIG.verboseLog) sendLog('[ORDER] Loi xu ly: ' + String(e)); }
}

function startRCTNetworkingAutoLoad() {
    if (!CONFIG.enabled || STATE.stopped) {
        STATE.autoLoopStarted = false;
        STATE.refreshInFlight = false;
        return;
    }
    var delay = Math.max(100, parseInt(CONFIG.refreshIntervalMs || 300, 10));
    if (!CONFIG.autoRefresh) { setTimeout(startRCTNetworkingAutoLoad, 1000); return; }
    if (STATE.isBusy || !STATE.networkingObj || !STATE.savedRequest) {
        setTimeout(startRCTNetworkingAutoLoad, 300); return;
    }
    var now = Date.now();
    var backoffRemaining = (STATE.refreshBackoffUntil || 0) - now;
    if (backoffRemaining > 0) {
        setTimeout(startRCTNetworkingAutoLoad, Math.max(100, Math.min(backoffRemaining, delay)));
        return;
    }
    if (STATE.refreshInFlight) {
        if (now - (STATE.lastRefreshStartedAt || now) < 3500) {
            setTimeout(startRCTNetworkingAutoLoad, delay);
            return;
        }
        // Recover if the app never delivered a completion callback.
        STATE.refreshInFlight = false;
        sendLog('⚠️ Refresh timeout; khôi phục vòng lấy đơn để tránh treo.');
    }
    ObjC.schedule(ObjC.mainQueue, function () {
        var startedAt = Date.now();
        try {
            if (CONFIG.enabled && !STATE.stopped && !STATE.isBusy &&
                STATE.networkingObj && STATE.savedRequest && !STATE.refreshInFlight) {
                var cp = STATE.savedRequest.mutableCopy();
                refreshRequestHeaders(cp, STATE.savedRequest);
                modifyRequestInPlace(cp);
                STATE.refreshInFlight = true;
                STATE.lastRefreshStartedAt = startedAt;
                STATE.networkingObj.sendRequest_responseType_incrementalUpdates_responseSender_(
                    cp, 'text', false, globalBlocks.empty);
                STATE.refreshCount++;
                setTimeout(function () {
                    if (STATE.refreshInFlight && STATE.lastRefreshStartedAt === startedAt) {
                        STATE.refreshInFlight = false;
                        sendLog('⚠️ Refresh không nhận phản hồi trong 3.5 giây; sẽ thử lượt kế tiếp.');
                    }
                }, 3600);
            }
        } catch (e) {
            STATE.refreshInFlight = false;
            sendLog('[REFRESH] Không thể gửi request refresh: ' + String(e));
        }
        setTimeout(startRCTNetworkingAutoLoad, delay);
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
    if (!(parseInt(oid, 10) > 0)) return false;
    var template = getPickRequestTemplate();
    if (!STATE.networkingObj || !template) {
        sendLog('❌ Chưa có request context hợp lệ để gửi pick');
        return false;
    }
    STATE.isBusy = true;
    STATE.pendingPickResponses = 1;
    STATE.lastPickedInfo = 'Đơn #' + oid;
    STATE.lastPickedPrice = price || 0;
    addPickMeta(STATE.lastPickedInfo, price, oid, options);
    sendLog('📤 [PICK] ' + STATE.lastPickedInfo);
    try { ObjC.schedule(ObjC.mainQueue, function () {
        try {
            var req = template.mutableCopy();
            req.setURL_(ObjC.classes.NSURL.URLWithString_(
                ObjC.classes.NSString.stringWithString_(URLS.pick)));
            req.setHTTPMethod_(ObjC.classes.NSString.stringWithString_('POST'));
            req.setTimeoutInterval_(10.0);
            refreshRequestHeaders(req, template);
            var body = ObjC.classes.NSString.stringWithString_(
                JSON.stringify({ delivery_order_id: oid }));
            var bd = body.dataUsingEncoding_(4);
            req.setHTTPBody_(bd);
            req.setValue_forHTTPHeaderField_(
                ObjC.classes.NSString.stringWithString_(String(bd.length().valueOf())),
                ObjC.classes.NSString.stringWithString_('Content-Length'));
            STATE.networkingObj.sendRequest_responseType_incrementalUpdates_responseSender_(
                req, 'text', false, globalBlocks.empty);
            sendLiveTestSentEvent(options);
        } catch (e) {
            STATE.pendingPickResponses = Math.max(0, STATE.pendingPickResponses - 1);
            STATE.isBusy = STATE.pendingPickResponses > 0;
            removePickMeta(parseInt(oid, 10), 'Đơn #' + oid);
            if (options && options.liveTest) reportTestResult(options.kind, options.payload, false, 'Lỗi gửi request: ' + String(e));
            sendLog('[PICK] Lỗi gửi request: ' + String(e));
        }
        resetBusyAfterTimeout(12000);
    }); } catch (scheduleError) {
        STATE.pendingPickResponses = Math.max(0, STATE.pendingPickResponses - 1);
        STATE.isBusy = STATE.pendingPickResponses > 0;
        removePickMeta(parseInt(oid, 10), 'Đơn #' + oid);
        if (options && options.liveTest) reportTestResult(options.kind, options.payload, false, 'Không thể lên lịch gửi request: ' + String(scheduleError));
        sendLog('[PICK] Không thể lên lịch gửi request: ' + String(scheduleError));
        return false;
    }
    return true;
}

function addPickMeta(info, price, orderId, options) {
    STATE.pendingPickMeta.push({ info: info || 'Đơn', price: price || 0, orderId: orderId || 0,
        source: options && options.liveTest ? 'live_test' : 'auto' });
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

function resetBusyAfterTimeout(delay) {
    setTimeout(function () {
        if (STATE.pendingPickResponses > 0) {
            var unanswered = STATE.pendingPickResponses;
            if (STATE.activePickBatch) finishPickBatch(true, unanswered);
            sendLog('⚠️ Hết thời gian chờ phản hồi pick; trạng thái busy được giải phóng. Hãy đối chiếu app tài xế trước khi thử lại để tránh gửi trùng.');
            STATE.pendingPickResponses = 0;
            STATE.isBusy = false;
            STATE.pendingPickMeta = [];
        }
    }, Math.max(2500, delay || 12000));
}

function sendPickBatch(ids, price, label, perOrderPriceMap) {
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
    STATE.activePickBatch = {
        ids: safeIds.slice(), total: safeIds.length, label: label || ('Pick lẻ ' + safeIds.length + ' đơn'),
        price: price || 0, successCount: 0, failureCount: 0, unknownSuccessCount: 0,
        knownSuccessIds: [], failureReasons: [], unmappedLogged: false, startedAt: Date.now()
    };
    sendLog('📤 [PICK-BATCH] ' + safeIds.join(' → '));
    try { ObjC.schedule(ObjC.mainQueue, function () {
        for (var j = 0; j < safeIds.length; j++) {
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
                STATE.networkingObj.sendRequest_responseType_incrementalUpdates_responseSender_(req, 'text', false, globalBlocks.empty);
            } catch (e) {
                STATE.pendingPickResponses = Math.max(0, STATE.pendingPickResponses - 1);
                STATE.isBusy = STATE.pendingPickResponses > 0;
                removePickMeta(safeIds[j], 'Đơn #' + safeIds[j]);
                var sendError = 'Lỗi gửi request cho đơn #' + safeIds[j] + ': ' + String(e);
                if (STATE.activePickBatch) {
                    STATE.activePickBatch.failureCount++;
                    STATE.activePickBatch.failureReasons.push(sendError);
                } else {
                    sendEvent('pick_failed', { reason: sendError, info: 'Đơn #' + safeIds[j], orderId: safeIds[j] });
                }
                sendLog('[PICK-BATCH] Lỗi gửi #' + safeIds[j] + ': ' + String(e));
            }
        }
        if (STATE.pendingPickResponses === 0 && STATE.activePickBatch) finishPickBatch(false, 0);
        resetBusyAfterTimeout(12000);
    }); } catch (scheduleError) {
        STATE.pendingPickResponses = 0;
        STATE.isBusy = false;
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
    if (!STATE.networkingObj || !template) return false;
    STATE.isBusy = true;
    STATE.pendingPickResponses = 1;
    STATE.lastPickedInfo = 'Chùm ' + count + ' đơn';
    STATE.lastPickedPrice = price || 0;
    addPickMeta(STATE.lastPickedInfo, price, 0, options);
    sendLog('📤 [MPICK] ' + STATE.lastPickedInfo);
    try { ObjC.schedule(ObjC.mainQueue, function () {
        try {
            var req = template.mutableCopy();
            req.setURL_(ObjC.classes.NSURL.URLWithString_(
                ObjC.classes.NSString.stringWithString_(URLS.mpick)));
            req.setHTTPMethod_(ObjC.classes.NSString.stringWithString_('POST'));
            req.setTimeoutInterval_(10.0);
            refreshRequestHeaders(req, template);
            var body = ObjC.classes.NSString.stringWithString_(
                JSON.stringify({ pre_group_code: preGroupCode, delivery_order_ids: ids }));
            var bd = body.dataUsingEncoding_(4);
            req.setHTTPBody_(bd);
            req.setValue_forHTTPHeaderField_(
                ObjC.classes.NSString.stringWithString_(String(bd.length().valueOf())),
                ObjC.classes.NSString.stringWithString_('Content-Length'));
            STATE.networkingObj.sendRequest_responseType_incrementalUpdates_responseSender_(
                req, 'text', false, globalBlocks.empty);
            sendLiveTestSentEvent(options);
        } catch (e) {
            STATE.pendingPickResponses = Math.max(0, STATE.pendingPickResponses - 1);
            STATE.isBusy = STATE.pendingPickResponses > 0;
            removePickMeta(0, 'Chùm ' + count + ' đơn');
            if (options && options.liveTest) reportTestResult(options.kind, options.payload, false, 'Lỗi gửi MPICK: ' + String(e));
            sendLog('[MPICK] Lỗi gửi request: ' + String(e));
        }
        resetBusyAfterTimeout(12000);
    }); } catch (scheduleError) {
        STATE.pendingPickResponses = Math.max(0, STATE.pendingPickResponses - 1);
        STATE.isBusy = STATE.pendingPickResponses > 0;
        removePickMeta(0, 'Chùm ' + count + ' đơn');
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
                sendLog('⚠️ [PICK RESPONSE] Batch response không có delivery_order_id; sẽ tổng kết thành công theo số response, không gán nhầm từng đơn.');
            }
        } else {
            sendLog('⚠️ [PICK RESPONSE] Không tìm được delivery_order_id của response; không gắn kết quả vào một đơn bất kỳ.');
        }
        return { info: 'Không xác định mã đơn (response batch)', price: 0, orderId: 0, unmapped: true };
    }
    return STATE.pendingPickMeta.length ? STATE.pendingPickMeta.shift() : {
        info: STATE.lastPickedInfo || 'Đơn đã pick', price: STATE.lastPickedPrice || 0, orderId: 0
    };
}

function finishPickBatch(timedOut, timedOutCount) {
    var batch = STATE.activePickBatch;
    if (!batch) return;
    STATE.activePickBatch = null;
    var unanswered = Math.max(0, timedOutCount || (timedOut ? STATE.pendingPickResponses : 0));
    var total = batch.total || batch.ids.length;

    if (batch.successCount > 0) {
        var info = batch.label + ': máy chủ xác nhận ' + batch.successCount + '/' + total + ' request thành công';
        if (batch.knownSuccessIds.length > 0) {
            info += '. Mã xác định: ' + batch.knownSuccessIds.join(', ');
        }
        if (batch.unknownSuccessCount > 0) {
            info += '. ' + batch.unknownSuccessCount + ' response không trả mã đơn cụ thể';
        }
        if (unanswered > 0) info += '. ' + unanswered + ' request chưa có response';
        info += '. Hãy đối chiếu danh sách đơn trong app tài xế.';
        sendEvent('pick_success', {
            info: info, price: batch.price || 0, orderId: 0, batch: true,
            successCount: batch.successCount, totalCount: total, unknownSuccessCount: batch.unknownSuccessCount,
            timedOut: !!timedOut
        });
        sendLog('✅ [PICK-BATCH SUCCESS] ' + info);
    }
    if (batch.failureCount > 0 || (batch.successCount === 0 && unanswered > 0)) {
        var reason = batch.label + ': ' + batch.failureCount + '/' + total + ' request thất bại';
        if (batch.failureReasons.length) reason += ' (' + batch.failureReasons.slice(0, 3).join('; ') + ')';
        if (unanswered > 0) reason += '; ' + unanswered + ' request chưa có response, kết quả chưa xác định';
        if (batch.successCount > 0) reason = 'Batch có ' + batch.successCount + '/' + total + ' request thành công và ' + batch.failureCount + ' request thất bại. ' + reason;
        sendEvent('pick_failed', { reason: reason, info: batch.label, batch: true });
        sendLog('⚠️ [PICK-BATCH RESULT] ' + reason);
    }

    if (batch.successCount > 0 && (CONFIG.stopAfterPick ||
        (CONFIG.maxOrdersPerSession > 0 && STATE.pickedCount >= CONFIG.maxOrdersPerSession))) {
        STATE.stopped = true;
        STATE.autoLoopStarted = false;
        sendEvent('auto_stopped', { reason: 'Đã hoàn thành batch và đạt điều kiện dừng Auto Pick' });
        sendLog('⏹ [AUTO STOP] Đã đạt điều kiện dừng Auto Pick');
    }

    if (STATE.pendingPickMeta.length > 0) {
        sendLog('ℹ️ [PICK RESPONSE] Dọn ' + STATE.pendingPickMeta.length + ' metadata batch không ghép được với response cụ thể.');
        STATE.pendingPickMeta = [];
    }
}

function handlePickResponse(jsonStr, task) {
    try {
        var json = JSON.parse(jsonStr || '{}');
        var batch = STATE.activePickBatch;
        var meta = takePickMeta(task);
        if (STATE.pendingPickResponses > 0) STATE.pendingPickResponses--;
        STATE.isBusy = STATE.pendingPickResponses > 0;
        if (String(json.code) === '0') {
            STATE.pickedCount++;
            if (batch) {
                batch.successCount++;
                if (meta.unmapped || !(parseInt(meta.orderId || 0, 10) > 0)) batch.unknownSuccessCount++;
                else batch.knownSuccessIds.push(parseInt(meta.orderId, 10));
                sendLog('[SUCCESS] Server xác nhận một request trong batch (' + batch.successCount + '/' + batch.total + ').');
            } else {
                if (meta.unmapped) {
                    // A success code without a correlatable order is not enough to emit a per-order notification.
                    sendLog('⚠️ [SUCCESS?] API trả code 0 nhưng không xác định được đơn tương ứng; không gán kết quả cho đơn bất kỳ.');
                } else {
                    sendEvent('pick_success', { info: meta.info, price: meta.price, orderId: meta.orderId || 0 });
                    sendLog('[SUCCESS] Pick OK: ' + meta.info);
                }
                if (!meta.unmapped && (CONFIG.stopAfterPick || (CONFIG.maxOrdersPerSession > 0 && STATE.pickedCount >= CONFIG.maxOrdersPerSession))) {
                    STATE.stopped = true;
                    STATE.autoLoopStarted = false;
                    sendEvent('auto_stopped', { reason: 'Đã đạt giới hạn pick hoặc cài đặt dừng sau pick' });
                    sendLog('⏹ [AUTO STOP] Đã đạt điều kiện dừng Auto Pick');
                }
            }
        } else {
            var r = json.msg || json.message || ('Code ' + json.code);
            if (batch) {
                batch.failureCount++;
                batch.failureReasons.push(String(r));
                sendLog('[FAIL] Một request trong batch thất bại: ' + String(r));
            } else {
                sendEvent('pick_failed', { reason: r, info: meta.info, orderId: meta.orderId || 0 });
                sendLog('[FAIL] ' + meta.info + ' — ' + r);
            }
        }
        if (batch && STATE.pendingPickResponses === 0) {
            finishPickBatch(false, 0);
        } else if (!batch && STATE.pendingPickResponses === 0 && STATE.pendingPickMeta.length > 0) {
            sendLog('⚠️ [PICK RESPONSE] Dọn ' + STATE.pendingPickMeta.length + ' metadata còn sót sau khi batch kết thúc.');
            STATE.pendingPickMeta = [];
        }
    } catch (e) { sendLog('[PICK RESPONSE] Parse lỗi: ' + String(e)); }
}

function processPickResponseChunk(chunk, url, task) {
    if (!chunk || typeof chunk !== 'string') return;
    var key = String(url || 'pick');
    try { if (task && task.handle) key += '#' + task.handle.toString(); } catch (e) {}
    var combined = (STATE.pickResponseBuffers[key] || '') + chunk;
    if (combined.length > 131072) {
        delete STATE.pickResponseBuffers[key];
        sendLog('⚠️ Pick response vượt quá giới hạn 128 KB; bỏ qua payload để tránh treo bộ nhớ.');
        return;
    }
    try {
        JSON.parse(combined);
        delete STATE.pickResponseBuffers[key];
        var testToken = findPendingApiTestToken(task);
        if (!testToken && STATE.activeApiTestToken && STATE.pendingApiTests[STATE.activeApiTestToken] && STATE.pendingPickResponses === 0) {
            // While a dummy-ID test is the only pick request allowed in flight, correlate by endpoint.
            var pendingTest = STATE.pendingApiTests[STATE.activeApiTestToken];
            if (pendingTest && pendingTest.endpoint === url) testToken = STATE.activeApiTestToken;
        }
        if (testToken) processFakeApiTestResponseChunk(combined, url, task, testToken);
        else handlePickResponse(combined, task);
    } catch (e) {
        STATE.pickResponseBuffers[key] = combined;
        setTimeout(function () {
            if (STATE.pickResponseBuffers[key] === combined) delete STATE.pickResponseBuffers[key];
        }, 5000);
        if (CONFIG.verboseLog) sendLog('[PICK RESPONSE] Đang ghép response nhiều chunk.');
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
    var combined = (STATE.assignmentBuffers[key] || '') + chunk;
    // A malformed/incomplete response must never grow without limit.
    if (combined.length > 262144) {
        delete STATE.assignmentBuffers[key];
        sendLog('⚠️ Assignment payload vượt quá giới hạn đọc; bỏ qua response.');
        return;
    }
    try {
        JSON.parse(combined);
        delete STATE.assignmentBuffers[key];
        processAssignmentPayload(combined, url);
    } catch (e) {
        STATE.assignmentBuffers[key] = combined;
    }
}

function processAssignmentPayload(jsonStr, url) {
    try {
        // Assignment notifications are independent of price/category/distance filters.
        if (CONFIG.notifyOnAssignment === false) return;
        // Never infer an assignment from an unrelated response.
        if (!url || url.indexOf('/api/v6/assignment/get-assignment-info') < 0) return;
        if (!jsonStr || jsonStr.indexOf('"assignment_id"') < 0 && jsonStr.indexOf('"assignmentId"') < 0) return;
        var response = JSON.parse(jsonStr);
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
            if (STATE.pendingAssignments[assignmentId]) STATE.pendingAssignments[assignmentId] = item;
            return;
        }
        STATE.pendingAssignments[assignmentId] = item;
        STATE.notifiedAssignmentIds[assignmentId] = true;
        sendEvent('assignment_detected', item);
        sendLog('🔔 [ASSIGNMENT] ID=' + assignmentId + ', đơn=' + ids.length + '/' + expectedCount +
            (item.incompleteGroup ? ' (thiếu delivery_order_id)' : ''));
    } catch (e) {
        if (CONFIG.verboseLog) sendLog('[ASSIGNMENT] Không đọc được payload: ' + String(e));
    }
}

function resolveAssignmentAction(assignmentId, action, retries) {
    var key = String(assignmentId || '');
    var item = STATE.pendingAssignments[key];
    if (!item) { sendLog('⚠️ Assignment đã hết hạn hoặc không còn trong bộ nhớ: ' + assignmentId); return; }
    if (action === 'skip') {
        delete STATE.pendingAssignments[key];
        sendLog('⏭ Bỏ qua assignment ' + assignmentId);
        return;
    }
    var ids = Array.isArray(item.orderIds) ? item.orderIds : [];
    if (item.incompleteGroup || ids.length === 0) {
        sendEvent('pick_failed', { reason: 'Dữ liệu assignment thiếu delivery_order_id; chưa gửi lệnh pick.', info: 'Assignment ' + assignmentId });
        sendLog('❌ Từ chối pick assignment thiếu mã đơn: ' + assignmentId);
        return;
    }
    if (action === 'single' && (item.isGroup || ids.length !== 1)) {
        sendEvent('pick_failed', { reason: 'Assignment có nhiều đơn; không cho phép dùng thao tác pick lẻ 1 đơn.', info: 'Assignment ' + assignmentId });
        sendLog('🛡 Chặn thao tác single trên assignment chùm ' + assignmentId);
        return;
    }
    if (action === 'split' && ids.length < 2) {
        sendEvent('pick_failed', { reason: 'Assignment chỉ có một đơn; hãy dùng Pick lẻ 1 đơn.', info: 'Assignment ' + assignmentId });
        sendLog('🛡 Chặn thao tác split trên assignment đơn lẻ ' + assignmentId);
        return;
    }
    // Don't discard the assignment if the request context isn't ready yet.
    if (!STATE.networkingObj || !getPickRequestTemplate()) {
        sendEvent('pick_failed', { reason: 'Chưa ghi nhận request context từ ứng dụng; hãy mở lại màn hình đơn/assignment rồi thử lại.', info: 'Assignment ' + assignmentId });
        // Allow the next assignment-info response to show the prompt again.
        delete STATE.notifiedAssignmentIds[key];
        sendLog('⚠️ Chưa có request context; sẽ cho phép hiện lại popup khi nhận response assignment kế tiếp.');
        return;
    }
    retries = retries || 0;
    if (STATE.isBusy) {
        if (retries < 20) {
            setTimeout(function () { resolveAssignmentAction(assignmentId, action, retries + 1); }, 300);
            return;
        }
        sendEvent('pick_failed', { reason: 'AutoPick vẫn đang xử lý request khác. Đơn sẽ được nhắc lại khi API assignment trả dữ liệu lần tới.', info: 'Assignment ' + assignmentId });
        delete STATE.notifiedAssignmentIds[key];
        sendLog('⚠️ Đang bận quá lâu; cho phép nhắc lại assignment ' + assignmentId);
        return;
    }
    var queued = false;
    if (action === 'single') {
        queued = sendPickSingle(ids[0], item.price || 0);
    } else if (action === 'split') {
        queued = sendPickBatch(ids, item.price || 0, 'Assignment ' + assignmentId);
    }
    if (queued) {
        delete STATE.pendingAssignments[key];
        sendLog('📤 Đã đưa thao tác assignment ' + assignmentId + ' vào hàng gửi. Đang chờ phản hồi server.');
    } else {
        sendEvent('pick_failed', { reason: 'Không thể khởi tạo request pick. Assignment vẫn được giữ lại.', info: 'Assignment ' + assignmentId });
    }
}

function installHooks() {
    if (STATE.installed) return true;
    if (typeof ObjC === 'undefined' || !ObjC.available) return false;

    var NC = ObjC.classes.RCTNetworking;
    if (!NC) return false;
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
                                STATE.autoLoopStarted = true;
                                setTimeout(startRCTNetworkingAutoLoad, 1500);
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
                        var data = new ObjC.Object(args[4]);
                        if (!data || data.length().valueOf() < 1) return;
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
                        if (isPickedOrderListURL(url) && st === 200) {
                            if (CONFIG.orderDataUploadEnabled) {
                                decodeDataToString(data, function (s) { processDeliveryOrderListChunk(s, url, req); });
                            }
                        } else if (isPickedOrderListURL(url)) {
                            if (CONFIG.orderDataUploadEnabled) sendLog('[ORDER DATA] HTTP ' + st + '; không upload response lỗi.');
                        } else if (url.indexOf('free-pick/get-order-list') >= 0 && st === 200) {
                            decodeDataToString(data, function (s) { processOrderListChunk(s, url, req); });
                        } else if (url.indexOf('free-pick/get-order-list') >= 0) {
                            handleRefreshHTTPStatus(st);
                        } else if (url.indexOf('free-pick/pick') >= 0 ||
                                   url.indexOf('free-pick/mpick') >= 0) {
                            decodeDataToString(data, function (s) {
                                sendLog('📥 [SERVER]: ' + s);
                                processPickResponseChunk(s, url, req);
                            });
                        } else if (url.indexOf('/api/v6/assignment/get-assignment-info') >= 0) {
                            if (st !== 200) {
                                sendLog('[ASSIGNMENT] Response HTTP ' + st + '; chưa tạo popup.');
                            } else if (data.length().valueOf() > 262144) {
                                sendLog('[ASSIGNMENT] Response lớn hơn giới hạn 256 KB; bỏ qua payload.');
                            } else {
                                sendLog('[ASSIGNMENT] Đã bắt response · ' + data.length().valueOf() + ' bytes; đang đọc assignment.');
                                decodeDataToString(data, function (s) { processAssignmentChunk(s, url, req); });
                            }
                        }
                    } catch (e) {}
                }
            });
        }
    }
    STATE.installed = true;
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
                STATE.autoLoopStarted = true;
                startRCTNetworkingAutoLoad();
            }
        } else if (type === 'start') {
            CONFIG.enabled = true;
            STATE.stopped = false; STATE.isBusy = false;
            STATE.pickedCount = 0; STATE.pickedIds = {}; STATE.notifiedIds = {}; STATE.pendingPickMeta = []; STATE.pendingPickResponses = 0; STATE.refreshInFlight = false; STATE.activePickBatch = null;
            if (!STATE.autoLoopStarted) {
                STATE.autoLoopStarted = true;
                startRCTNetworkingAutoLoad();
            }
            sendLog('[START] BAT AUTO');
        } else if (type === 'stop') {
            CONFIG.enabled = false; STATE.stopped = true;
            STATE.autoLoopStarted = false; STATE.refreshInFlight = false;
            sendLog('[STOP] TAT AUTO');
        } else if (type === 'assignment_action') {
            resolveAssignmentAction(message.assignmentId, message.action);
        }
    } catch (e) {}
    recv(onMessage);
});

var tries = 0;
var iv = setInterval(function () {
    if (installHooks()) { clearInterval(iv); return; }
    if (++tries > 60) clearInterval(iv);
}, 1000);
