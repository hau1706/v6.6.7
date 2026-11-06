#!/usr/bin/env node
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'frida-agent.js'), 'utf8');
const events = [];
const context = {
  send: (message) => events.push(message),
  recv: () => {},
  setTimeout: () => 0,
  setInterval: () => 0,
  clearInterval: () => {},
  Date, JSON, Math, String, Object, Array, parseInt, isNaN, RegExp, Error
};
vm.createContext(context);
vm.runInContext(source, context, { filename: 'frida-agent.js' });

const endpoint = 'https://gpartner.deliverynow.vn/api/v6/assignment/get-assignment-info';
// Assignment popup must ignore price/distance/category filters: it is driven by assignment-info,
// not the free-pick candidate filter.
context.CONFIG.minPrice = 999999999;
context.CONFIG.maxDistance = 1;
context.CONFIG.preferredCategories = [999];
const groupResponse = {
  code: 0,
  data: {
    assignment_id: 4444,
    total_earnings_amount: 65000,
    delivery_distance: 18000,
    deliveries: [
      { delivery_order_id: 70001, delivery_distance: 11000, shipping_fee: 41000 },
      { delivery_order_id: 70002, delivery_distance: 7000, shipping_fee: 39000 }
    ]
  }
};
context.processAssignmentPayload(JSON.stringify(groupResponse), endpoint);
let item = context.STATE.pendingAssignments['4444'];
assert.ok(item, 'assignment should be detected');
assert.deepEqual(Array.from(item.orderIds), [70001, 70002], 'IDs should be sorted far-to-near');
assert.equal(item.isGroup, true);
assert.equal(item.incompleteGroup, false);
assert.equal(item.price, 65000);
assert.equal(events.filter((e) => e.type === 'assignment_detected').length, 1,
  'assignment must prompt regardless of the free-pick filter settings');

context.CONFIG.notifyOnAssignment = false;
const disabledPrompt = { code: 0, data: { assignment_id: 8008, deliveries: [{ delivery_order_id: 80081 }] } };
context.processAssignmentPayload(JSON.stringify(disabledPrompt), endpoint);
assert.equal(context.STATE.pendingAssignments['8008'], undefined, 'assignment toggle off should suppress popup');
assert.equal(events.filter((e) => e.type === 'assignment_detected').length, 1);
context.CONFIG.notifyOnAssignment = true;
context.CONFIG.minPrice = 0;
context.CONFIG.maxDistance = 50000;
context.CONFIG.preferredCategories = [6];

context.processAssignmentPayload(JSON.stringify(groupResponse), 'https://gpartner.deliverynow.vn/api/v6/free-pick/get-order-list');
assert.equal(events.filter((e) => e.type === 'assignment_detected').length, 1, 'unrelated URL must not trigger prompt');

context.STATE.networkingObj = {};
context.STATE.savedRequest = {};
const actualSendPickSingle = context.sendPickSingle;
let called = '';
let singleOptions = null;
let splitOptions = null;
context.sendPickSingle = (_id, _price, options) => { called = 'single'; singleOptions = options; return true; };
context.sendPickBatch = (_ids, _price, _label, _priceMap, options) => { called = 'split'; splitOptions = options; return true; };
context.resolveAssignmentAction('4444', 'single');
assert.equal(called, '', 'single action must be rejected for group');
assert.ok(context.STATE.pendingAssignments['4444'], 'wrong action should preserve assignment');
context.resolveAssignmentAction('4444', 'split');
assert.equal(called, 'split');
assert.equal(splitOptions.splitAllCodeOnlySuccess, true, 'manual Assignment popup SPLIT ALL must enable code-only response aggregation');
assert.equal(splitOptions.forceNotify, true, 'manual Assignment popup must always show the server result');
assert.equal(splitOptions.assignmentId, '4444');
assert.equal(splitOptions.source, 'assignment_popup');
assert.equal(context.STATE.pendingAssignments['4444'], undefined, 'queued split should remove pending item');

const singleResponse = { code: 0, data: { assignment_id: 222, total_earnings_amount: 12000,
  delivery_distance: 3000, deliveries: [{ delivery_order_id: 999, delivery_distance: 3000, shipping_fee: 12000 }] } };
context.processAssignmentPayload(JSON.stringify(singleResponse), endpoint);
item = context.STATE.pendingAssignments['222'];
assert.equal(item.isGroup, false, 'one delivery must be treated as a single order');
context.resolveAssignmentAction('222', 'split');
assert.ok(context.STATE.pendingAssignments['222'], 'split action must be rejected for single order');
context.resolveAssignmentAction('222', 'single');
assert.equal(called, 'single');
assert.equal(singleOptions.forceNotify, true, 'manual Assignment single-pick should always show its server response');
assert.equal(singleOptions.assignmentId, '222');

const incompleteResponse = { code: 0, data: { assignment_id: 333, total_earnings_amount: 3000,
  delivery_distance: 5000, deliveries: [{ delivery_order_id: 111 }, { delivery_order_id: 0 }] } };
context.processAssignmentPayload(JSON.stringify(incompleteResponse), endpoint);
item = context.STATE.pendingAssignments['333'];
assert.equal(item.isGroup, true);
assert.equal(item.incompleteGroup, true);
context.resolveAssignmentAction('333', 'split');
assert.ok(context.STATE.pendingAssignments['333'], 'incomplete group must not be queued for pick');

const chunkedResponse = JSON.stringify({ code: 0, data: { assignment_id: 444, total_earnings_amount: 1,
  delivery_distance: 1, deliveries: [{ delivery_order_id: 777, delivery_distance: 1, shipping_fee: 1 }] } });
const fakeRequest = { handle: { toString: () => 'request-444' } };
context.processAssignmentChunk(chunkedResponse.slice(0, 40), endpoint, fakeRequest);
assert.equal(context.STATE.pendingAssignments['444'], undefined, 'incomplete first chunk should not parse');
context.processAssignmentChunk(chunkedResponse.slice(40), endpoint, fakeRequest);
assert.ok(context.STATE.pendingAssignments['444'], 'joined response chunks should parse');


// Missing request context should not silently lose the assignment; the next response may prompt again.
const retryResponse = { code: 0, data: { assignment_id: 555, total_earnings_amount: 5000,
  delivery_distance: 2000, deliveries: [{ delivery_order_id: 5551, delivery_distance: 2000 }] } };
context.STATE.networkingObj = null;
context.STATE.savedRequest = null;
context.STATE.assignmentRequest = null;
context.processAssignmentPayload(JSON.stringify(retryResponse), endpoint);
const beforeRetryPrompt = events.filter((e) => e.type === 'assignment_detected').length;
context.resolveAssignmentAction('555', 'single');
assert.ok(context.STATE.pendingAssignments['555'], 'assignment should remain available after missing request context');
assert.equal(context.STATE.notifiedAssignmentIds['555'], undefined, 'failed context should allow the next response to re-prompt');
context.STATE.networkingObj = {};
context.STATE.assignmentRequest = {};
context.processAssignmentPayload(JSON.stringify(retryResponse), endpoint);
assert.equal(events.filter((e) => e.type === 'assignment_detected').length, beforeRetryPrompt + 1);
context.resolveAssignmentAction('555', 'skip');
assert.equal(context.STATE.pendingAssignments['555'], undefined);
const afterSkipPrompt = events.filter((e) => e.type === 'assignment_detected').length;
context.processAssignmentPayload(JSON.stringify(retryResponse), endpoint);
assert.equal(context.STATE.pendingAssignments['555'], undefined, 'skipped assignment must not be resurrected');
assert.equal(events.filter((e) => e.type === 'assignment_detected').length, afterSkipPrompt, 'skipped assignment must not prompt repeatedly');

// The user-facing API test now previews real production routes with dummy IDs; it no longer has a bridge-only menu test.
context.CONFIG.autoPick = false;
context.STATE.isBusy = false;
context.STATE.networkingObj = {};
context.STATE.savedRequest = {};
context.getPickRequestTemplate = () => ({});
const actualSendFakeApiTestRequest = context.sendFakeApiTestRequest;
const sentTestRequests = [];
context.sendFakeApiTestRequest = (token) => {
  const preview = context.STATE.liveTestPreviews[token];
  sentTestRequests.push({ token, kind: preview.kind, payload: preview.payload, endpoint: preview.endpoint });
  return true;
};
context.previewLiveApiTest('free_pick');
let previewEvent = events.filter((e) => e.type === 'live_test_preview').at(-1);
assert.equal(previewEvent.endpoint, 'https://gpartner.deliverynow.vn/api/v6/free-pick/pick');
assert.equal(previewEvent.payload.delivery_order_id, 999999991, 'Free-Pick test must use the fixed dummy ID');
assert.match(previewEvent.message, /giả/);
context.confirmLiveApiTest(previewEvent.token, 'free_pick');
assert.equal(sentTestRequests.length, 1, 'confirmed Free-Pick test should queue a real-request path');
assert.equal(sentTestRequests[0].payload.delivery_order_id, 999999991);

context.previewLiveApiTest('mpick');
previewEvent = events.filter((e) => e.type === 'live_test_preview').at(-1);
assert.equal(previewEvent.endpoint, 'https://gpartner.deliverynow.vn/api/v6/free-pick/mpick');
assert.deepEqual(Array.from(previewEvent.payload.delivery_order_ids), [999999991, 999999992]);
assert.match(previewEvent.payload.pre_group_code, /^AUTOPICK_TEST_INVALID_/);
context.confirmLiveApiTest(previewEvent.token, 'mpick');
assert.equal(sentTestRequests.length, 2, 'confirmed MPICK test should queue a real-request path');
assert.equal(sentTestRequests[1].kind, 'mpick');

// Exercise the actual request builder against a mocked RCTNetworking/Objective-C bridge.
context.sendFakeApiTestRequest = actualSendFakeApiTestRequest;
const dispatched = [];
function fakeNSString(v) {
  const str = String(v);
  return {
    toString: () => str,
    dataUsingEncoding_: () => ({ text: str, length: () => ({ valueOf: () => Buffer.byteLength(str) }) })
  };
}
function makeMockRequest() {
  return {
    url: '', method: '', timeout: 0, body: '', headers: {},
    mutableCopy() { return makeMockRequest(); },
    setURL_(v) { this.url = String(v); },
    setHTTPMethod_(v) { this.method = String(v); },
    setTimeoutInterval_(v) { this.timeout = v; },
    setHTTPBody_(v) { this.body = v.text; },
    setValue_forHTTPHeaderField_(v, k) { this.headers[String(k)] = String(v); }
  };
}
context.ObjC = {
  available: true, mainQueue: {},
  schedule: (_q, fn) => fn(),
  selector: (s) => s,
  classes: {
    NSString: { stringWithString_: fakeNSString, alloc: () => ({ initWithData_encoding_: (d) => ({ toString: () => d.text }) }) },
    NSURL: { URLWithString_: fakeNSString },
    NSHTTPURLResponse: {}
  }
};
context.refreshRequestHeaders = () => {};
context.globalBlocks = { empty: {} };
context.getPickRequestTemplate = () => ({ mutableCopy: () => makeMockRequest() });
context.STATE.networkingObj = {
  sendRequest_responseType_incrementalUpdates_responseSender_: (req) => dispatched.push(req)
};
context.STATE.isBusy = false;
context.STATE.pendingPickResponses = 0;
context.STATE.pendingApiTests = {};
context.STATE.activeApiTestToken = null;
context.STATE.liveTestPreviews = {
  'mock-live-free': { kind: 'free_pick', endpoint: context.URLS.pick, payload: { delivery_order_id: 999999991 } },
  'mock-live-mpick': { kind: 'mpick', endpoint: context.URLS.mpick, payload: { pre_group_code: 'AUTOPICK_TEST_INVALID_123', delivery_order_ids: [999999991, 999999992] } }
};
assert.equal(context.sendFakeApiTestRequest('mock-live-free'), true);
assert.equal(dispatched.length, 1, 'Free-Pick test should call RCTNetworking with a real POST request object');
assert.equal(dispatched[0].method, 'POST');
assert.equal(dispatched[0].url, context.URLS.pick);
assert.deepEqual(JSON.parse(dispatched[0].body), { delivery_order_id: 999999991 });
context.finishFakeApiTest('mock-live-free', '{"code":1,"msg":"invalid test id"}', {}, false);
context.STATE.isBusy = false;
context.STATE.activeApiTestToken = null;
assert.equal(context.sendFakeApiTestRequest('mock-live-mpick'), true);
assert.equal(dispatched.length, 2, 'MPICK test should call RCTNetworking with a real POST request object');
assert.equal(dispatched[1].url, context.URLS.mpick);
assert.deepEqual(JSON.parse(dispatched[1].body), { pre_group_code: 'AUTOPICK_TEST_INVALID_123', delivery_order_ids: [999999991, 999999992] });
context.finishFakeApiTest('mock-live-mpick', '{"code":1,"msg":"invalid test ids"}', {}, false);
context.STATE.isBusy = false;
context.STATE.activeApiTestToken = null;
assert.match(source, /function\s+sendLiveTestSentEvent\s*\(/, 'sendLiveTestSentEvent must be defined before pick request paths use it');

// Regression for the reported ReferenceError: after handing a normal pick request
// to RCTNetworking, no missing helper may trigger the send-failure catch/clear metadata.
context.sendPickSingle = actualSendPickSingle;
context.STATE.pendingPickMeta = [];
context.STATE.pendingPickResponses = 0;
context.STATE.isBusy = false;
const oldPickLogCount = events.filter((e) => e.type === 'logs' && (e.lines || []).some((line) => String(line).includes('[PICK] Lỗi gửi request'))).length;
assert.equal(context.sendPickSingle(123456789, 12000), true);
assert.equal(dispatched.length, 3, 'normal pick should be handed to RCTNetworking');
assert.equal(context.STATE.pendingPickResponses, 1, 'pending response must remain tracked after request dispatch');
assert.equal(context.STATE.pendingPickMeta.length, 1, 'pick metadata must remain until the matching response arrives');
assert.equal(context.STATE.isBusy, true, 'busy lock must remain until response/timeout');
assert.equal(events.filter((e) => e.type === 'logs' && (e.lines || []).some((line) => String(line).includes('[PICK] Lỗi gửi request'))).length, oldPickLogCount,
  'successful handoff must not be mislabeled as a send failure');
// Clean the mocked pending request so unrelated tests start from a neutral state.
context.STATE.pendingPickMeta = [];
context.STATE.pendingPickResponses = 0;
context.STATE.isBusy = false;

// The same missing-symbol regression must be fixed for MPICK, too.
const oldMpickLogCount = events.filter((e) => e.type === 'logs' && (e.lines || []).some((line) => String(line).includes('[MPICK] Lỗi gửi request'))).length;
assert.equal(context.sendPickGroup('TEST_GROUP_FOR_UNIT_TEST', [123456791, 123456792], 24000, 2), true);
assert.equal(dispatched.length, 4, 'normal MPICK should be handed to RCTNetworking');
assert.equal(dispatched[3].method, 'POST');
assert.equal(dispatched[3].url, context.URLS.mpick);
assert.deepEqual(JSON.parse(dispatched[3].body), { pre_group_code: 'TEST_GROUP_FOR_UNIT_TEST', delivery_order_ids: [123456791, 123456792] });
assert.equal(context.STATE.pendingPickResponses, 1, 'MPICK response must remain tracked after request dispatch');
assert.equal(context.STATE.pendingPickMeta.length, 1, 'MPICK metadata must remain until the response arrives');
assert.equal(context.STATE.isBusy, true, 'MPICK busy lock must remain until response/timeout');
assert.equal(events.filter((e) => e.type === 'logs' && (e.lines || []).some((line) => String(line).includes('[MPICK] Lỗi gửi request'))).length, oldMpickLogCount,
  'successful MPICK handoff must not be mislabeled as a send failure');
context.STATE.pendingPickMeta = [];
context.STATE.pendingPickResponses = 0;
context.STATE.isBusy = false;
assert.match(source, /Math\.max\(100, parseInt\(CONFIG\.refreshIntervalMs/);

// A dummy-ID response is shown as a test result, never as a real pick success/history event.
context.STATE.pendingApiTests = { 'dummy-token': { kind: 'free_pick', payload: { delivery_order_id: 999999991 }, endpoint: 'https://gpartner.deliverynow.vn/api/v6/free-pick/pick' } };
context.STATE.activeApiTestToken = 'dummy-token';
context.STATE.isBusy = true;
context.STATE.pendingPickResponses = 0;
// Use the active-test endpoint fallback as NSURLSession task bodies can be unavailable on some RN versions.
context.processPickResponseChunk('{"code":1,"msg":"invalid test ID"}', 'https://gpartner.deliverynow.vn/api/v6/free-pick/pick', {});
assert.ok(events.some((e) => e.type === 'test_result' && e.responseCode === '1'), 'fake-ID server response should be surfaced to the UI');
assert.equal(events.filter((e) => e.type === 'pick_success').length, 0, 'fake-ID test must not be added to successful pick history');

// Concurrent batch responses without a correlatable ID must not be assigned to a random order.
context.STATE.activePickBatch = null;
context.STATE.pendingPickMeta = [{ info: 'Đơn #A', orderId: 101, price: 100 }, { info: 'Đơn #B', orderId: 102, price: 200 }];
context.STATE.pendingPickResponses = 2;
context.STATE.isBusy = true;
context.handlePickResponse('{"code":0}', {});
assert.ok(events.some((e) => e.type === 'logs' && (e.lines || []).some((line) => String(line).includes('Không tìm được delivery_order_id'))), 'uncorrelated response should be logged instead of assigned randomly');
assert.equal(events.filter((e) => e.type === 'pick_success').length, 0, 'uncorrelated standalone response must not be attached to an arbitrary order');
context.STATE.pendingPickResponses = 0;
context.STATE.pendingPickMeta = [];
context.STATE.isBusy = false;
assert.match(source, /0x1f[\s\S]{0,120}0x8b/, 'gzip magic detection should be present');
assert.match(source, /handleGunzipReply/, 'gzip reply handler should be present');

// Pick endpoint responses may arrive in multiple data chunks. Do not notify success/failure until JSON is complete.
let completedPickResponse = '';
const realHandlePickResponse = context.handlePickResponse;
context.handlePickResponse = (value) => { completedPickResponse = value; };
const splitPickJson = '{"code":0,"msg":"ok"}';
context.processPickResponseChunk(splitPickJson.slice(0, 8), 'https://gpartner.deliverynow.vn/api/v6/free-pick/pick', { handle: { toString: () => 'task-pick-1' } });
assert.equal(completedPickResponse, '', 'partial pick response must not be processed early');
context.processPickResponseChunk(splitPickJson.slice(8), 'https://gpartner.deliverynow.vn/api/v6/free-pick/pick', { handle: { toString: () => 'task-pick-1' } });
assert.equal(completedPickResponse, splitPickJson, 'pick response should be processed after the JSON is complete');

// Exercise the host-to-agent gzip reply hand-off with a minimal Objective-C bridge mock.
let inflated = '';
context.ObjC = { classes: {
  NSData: { alloc: () => ({ initWithBase64EncodedString_options_: (b64) => ({ text: Buffer.from(b64, 'base64').toString('utf8') }) }) },
  NSString: { alloc: () => ({ initWithData_encoding_: (data) => ({ toString: () => data.text }) }) }
} };
context.STATE.pendingGunzipCallbacks['77'] = (value) => { inflated = value; };
context.handleGunzipReply({ id: 77, data: Buffer.from('{\"code\":0}', 'utf8').toString('base64') });
assert.equal(inflated, '{\"code\":0}', 'gunzip reply should feed decompressed JSON to the original parser callback');
assert.equal(context.STATE.pendingGunzipCallbacks['77'], undefined, 'gunzip callback should be removed after completion');


assert.ok(!fs.readFileSync(path.join(root, 'Sources/APFMenu.m'), 'utf8').includes('Test cầu nối'), 'bridge-only test menu entry should be removed');
assert.match(source, /Math\.max\(100, parseInt\(CONFIG\.refreshIntervalMs/);

// Batch code:0 responses without per-order IDs should produce one summary success notification, never fabricate an ID.
context.handlePickResponse = realHandlePickResponse;
context.CONFIG.stopAfterPick = false;
context.CONFIG.maxOrdersPerSession = 0;
context.STATE.pickedCount = 0;
context.STATE.pendingPickMeta = [
  { info: 'Đơn #101', orderId: 101, price: 100 },
  { info: 'Đơn #102', orderId: 102, price: 200 },
  { info: 'Đơn #103', orderId: 103, price: 300 }
];
context.STATE.pendingPickResponses = 3;
context.STATE.isBusy = true;
context.STATE.activePickBatch = {
  batchId: 'batch-unmapped-test', ids: [101, 102, 103], total: 3, label: 'Chùm 3 đơn', price: 600,
  successCount: 0, failureCount: 0, unknownSuccessCount: 0, unmappedFailureCount: 0, responseSuccessCount: 0,
  knownSuccessIds: [], failureReasons: [], unmappedLogged: false, summaryEmitted: false, startedAt: Date.now(),
  items: [101, 102, 103].map(orderId => ({ orderId, price: 100, status: 'SUBMITTED', detail: '' }))
};
const batchEventsBefore = events.filter((e) => e.type === 'pick_batch_summary').length;
context.handlePickResponse('{"msg":"success","code":0,"data":null}', {});
context.handlePickResponse('{"msg":"success","code":0,"data":null}', {});
context.handlePickResponse('{"msg":"success","code":0,"data":null}', {});
const batchEvents = events.filter((e) => e.type === 'pick_batch_summary').slice(batchEventsBefore);
assert.equal(batchEvents.length, 1, 'batch should produce one combined summary event');
assert.equal(batchEvents[0].successCount, 0, 'unmapped responses must not be credited to a specific order');
assert.equal(batchEvents[0].unknownCount, 3, 'all uncorrelated order IDs remain UNKNOWN');
assert.equal(batchEvents[0].unmappedSuccessCount, 3, 'server code 0 responses without IDs are counted separately');
assert.equal(context.STATE.activePickBatch.summaryEmitted, true, 'summary is emitted once');
assert.equal(context.STATE.isBusy, true, 'unmapped per-order outcomes keep the duplicate-pick gate closed');
assert.equal(context.STATE.pendingPickMeta.length, 3, 'unmapped metadata is retained for possible late correlation');

// Order data upload requires the toggle, successful API code, and a non-empty data.orders array.
context.CONFIG.orderDataUploadEnabled = false;
context.CONFIG.orderDataUploadToken = 'test-token';
context.STATE.pendingOrderDataUpload = null;
const savedDrainUpload = context.drainOrderDataUpload;
let drainCalled = 0;
context.drainOrderDataUpload = () => { drainCalled++; };
const orderResponse = JSON.stringify({ msg: 'success', code: 0, data: { orders: [{ delivery_order_id: 1 }, { delivery_order_id: 2 }] } });
assert.equal(context.processDeliveryOrderListResponse(orderResponse), false, 'disabled upload toggle must skip upload');
assert.equal(drainCalled, 0);
context.CONFIG.orderDataUploadEnabled = true;
assert.equal(context.processDeliveryOrderListResponse(JSON.stringify({ code: 0, data: { orders: [] } })), false, 'empty orders must not upload');
assert.equal(context.processDeliveryOrderListResponse(JSON.stringify({ code: 1, data: { orders: [{ id: 1 }] } })), false, 'nonzero API code must not upload');
assert.equal(context.processDeliveryOrderListResponse(orderResponse), true, 'enabled toggle with non-empty orders should queue upload');
assert.equal(drainCalled, 1);
assert.equal(context.STATE.pendingOrderDataUpload.orderCount, 2);
assert.equal(context.STATE.pendingOrderDataUpload.raw, orderResponse, 'upload should preserve the complete original response JSON');
context.drainOrderDataUpload = savedDrainUpload;
context.STATE.pendingOrderDataUpload = { raw: orderResponse, orderCount: 2, capturedAt: Date.now() };
context.CONFIG.orderDataUploadEnabled = true;
context.CONFIG.orderDataUploadToken = '';
context.STATE.orderDataUploadInFlight = false;
context.drainOrderDataUpload();
assert.equal(context.STATE.pendingOrderDataUpload, null, 'missing token must drop queued payload without making a network request');
assert.equal(context.STATE.orderDataUploadInFlight, false, 'missing token must not start an upload');
context.CONFIG.orderDataUploadEnabled = false;

// Adaptive 503 backoff: preserve the configured cadence for two transient responses,
// then reduce pressure on a persistently overloaded server. 429 backs off immediately.
context.STATE.refreshBackoffMs = 0;
context.STATE.refreshBackoffUntil = 0;
context.STATE.consecutive503 = 0;
context.handleRefreshHTTPStatus(503);
context.handleRefreshHTTPStatus(503);
assert.equal(context.STATE.refreshBackoffMs, 0, 'first two 503 responses keep the fast cadence');
context.handleRefreshHTTPStatus(503);
assert.equal(context.STATE.refreshBackoffMs, 500, 'third consecutive 503 starts bounded backoff');
context.clearRefreshBackoff();
context.handleRefreshHTTPStatus(429);
assert.equal(context.STATE.refreshBackoffMs, 1000, '429 backs off immediately');
context.clearRefreshBackoff();
assert.equal(context.STATE.refreshBackoffMs, 0, 'valid list response can clear backoff');

const menuSource = fs.readFileSync(path.join(root, 'Sources/APFMenu.m'), 'utf8');
assert.ok(!menuSource.includes('pickHistoryMenu'), 'local pick history UI must be removed');
assert.ok(!menuSource.includes('setObject:history forKey:@\"APFPickSuccessHistory\"'), 'local history writes must be removed');
assert.match(menuSource, /orderDataUploadEnabled/);
assert.match(menuSource, /orderDataUploadToken/);
assert.match(source, /\/api\/v6\/delivery\/get-order-list/);
assert.equal(context.isPickedOrderListURL('https://gpartner.deliverynow.vn/api/v6/delivery/get-order-list?page=1'), true, 'target order-list URL with query should match');
assert.equal(context.isPickedOrderListURL('https://example.com/api/v6/delivery/get-order-list'), false, 'other hosts must not trigger upload');
assert.match(source, /X-AutoPick-Token/);

console.log('PASS: assignment, PICK/MPICK request handling, single batch-success summary for unmapped code:0 responses, no local pick history, upload gating by toggle/code/non-empty orders, response chunking and gzip hand-off');
