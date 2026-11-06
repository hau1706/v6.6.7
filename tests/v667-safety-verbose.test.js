#!/usr/bin/env node
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'frida-agent.js'), 'utf8');
const events = [];
const timers = new Map();
let nextTimer = 1;
let messageHandler = null;
const ctx = {
  send: m => events.push(m),
  recv: fn => { messageHandler = fn; },
  setTimeout: (fn, ms) => { const id = nextTimer++; timers.set(id, { fn, ms }); return id; },
  clearTimeout: id => timers.delete(id),
  setInterval: (fn, ms) => { const id = nextTimer++; timers.set(id, { fn, ms, interval: true }); return id; },
  clearInterval: id => timers.delete(id),
  Date, JSON, Math, String, Object, Array, parseInt, isNaN, isFinite, Number, RegExp, Error
};
vm.createContext(ctx);
vm.runInContext(source, ctx, { filename: 'frida-agent.js' });
let passed = 0;
function test(name, fn) { fn(); passed++; console.log('  ok - ' + name); }

function makeObjC(sendImpl, failBeforeHandoff) {
  function nsString(v) {
    const text = String(v);
    return {
      toString: () => text,
      dataUsingEncoding_: () => ({ length: () => ({ valueOf: () => text.length }) })
    };
  }
  function request() {
    return {
      mutableCopy: () => request(),
      setURL_: () => {}, setHTTPMethod_: () => {}, setTimeoutInterval_: () => {},
      setHTTPBody_: () => { if (failBeforeHandoff) throw new Error('prepare failed'); },
      setValue_forHTTPHeaderField_: () => {}
    };
  }
  ctx.ObjC = {
    available: true, mainQueue: {}, schedule: (_q, fn) => fn(), selector: s => s,
    classes: { NSString: { stringWithString_: nsString }, NSURL: { URLWithString_: v => v } }
  };
  ctx.refreshRequestHeaders = () => {};
  ctx.globalBlocks = { empty: {} };
  ctx.STATE.savedRequest = request();
  ctx.STATE.networkingObj = { sendRequest_responseType_incrementalUpdates_responseSender_: sendImpl };
}

// START can restart refresh but cannot erase de-duplication or outstanding PICK state.
test('START preserves pending/UNKNOWN pick state and picked IDs', () => {
  ctx.STATE.isBusy = true;
  ctx.STATE.pendingPickResponses = 1;
  ctx.STATE.pendingPickMeta = [{ info: 'Đơn #700', orderId: 700, status: 'UNKNOWN' }];
  ctx.STATE.activePickBatch = { ids: [700], total: 1 };
  ctx.STATE.pickedIds = { '700': 'sent' };
  ctx.STATE.notifiedIds = { '700': true };
  ctx.STATE.pickedCount = 4;
  assert.ok(messageHandler, 'agent message handler should be installed');
  messageHandler({ type: 'start' });
  assert.equal(ctx.STATE.pendingPickResponses, 1);
  assert.equal(ctx.STATE.pendingPickMeta.length, 1);
  assert.equal(ctx.STATE.pendingPickMeta[0].status, 'UNKNOWN');
  assert.ok(ctx.STATE.activePickBatch);
  assert.equal(ctx.STATE.pickedIds['700'], 'sent');
  assert.equal(ctx.STATE.notifiedIds['700'], true);
  assert.equal(ctx.STATE.pickedCount, 4);
  assert.equal(ctx.STATE.isBusy, true);
});

test('START preserves busy state while an explicit API test is awaiting response', () => {
  ctx.STATE.pendingPickResponses = 0;
  ctx.STATE.pendingPickMeta = [];
  ctx.STATE.activePickBatch = null;
  ctx.STATE.activeApiTestToken = 'api-test-1';
  ctx.STATE.pendingApiTests = { 'api-test-1': { kind: 'free_pick' } };
  ctx.STATE.isBusy = true;
  messageHandler({ type: 'start' });
  assert.equal(ctx.STATE.isBusy, true);
  assert.equal(ctx.STATE.activeApiTestToken, 'api-test-1');
  ctx.STATE.activeApiTestToken = null;
  ctx.STATE.pendingApiTests = {};
  ctx.STATE.isBusy = false;
});

// Pick timeout is an UNKNOWN outcome, not a rejection; do not release the single-flight gate.
test('PICK timeout keeps reservations and busy lock until a late response resolves it', () => {
  ctx.STATE.pendingPickResponses = 1;
  ctx.STATE.pendingPickMeta = [{ info: 'Đơn #701', orderId: 701, status: 'SUBMITTED' }];
  ctx.STATE.activePickBatch = null;
  ctx.STATE.isBusy = true;
  ctx.resetBusyAfterTimeout(12000);
  let timeoutEntry = null;
  for (const entry of timers.values()) if (entry.ms === 12000) timeoutEntry = entry;
  assert.ok(timeoutEntry, 'pick timeout must be scheduled');
  timeoutEntry.fn();
  assert.equal(ctx.STATE.pendingPickResponses, 1, 'unknown response slot must not be discarded');
  assert.equal(ctx.STATE.pendingPickMeta[0].status, 'UNKNOWN');
  assert.equal(ctx.STATE.isBusy, true, 'must fail closed rather than allow a duplicate pick');
  assert.equal(ctx.STATS.pickTimeouts, 1);
  ctx.handlePickResponse('{"code":1,"msg":"not accepted"}', null);
  assert.equal(ctx.STATE.pendingPickResponses, 0, 'late server response must resolve the unknown slot');
  assert.equal(ctx.STATE.isBusy, false, 'busy gate releases only after actual response');
  assert.equal(ctx.STATE.pendingPickMeta.length, 0);
});

// Exception before RCTNetworking handoff: safe to release reservation and retry later.
test('SINGLE PICK preparation failure releases only the definitely-unsent reservation', () => {
  makeObjC(() => { throw new Error('must not be called'); }, true);
  ctx.STATE.isBusy = false; ctx.STATE.pendingPickResponses = 0; ctx.STATE.pendingPickMeta = [];
  ctx.STATE.pickedIds = { '702': 'sent' };
  assert.equal(ctx.sendPickSingle(702, 25000), true, 'ObjC.schedule accepted callback');
  assert.equal(ctx.STATE.pendingPickResponses, 0);
  assert.equal(ctx.STATE.isBusy, false);
  assert.equal(ctx.STATE.pendingPickMeta.length, 0);
  assert.equal(ctx.STATE.pickedIds['702'], undefined, 'definitely unsent ID can be retried');
});

test('Assignment single-pick preparation failure emits a forced failure reason', () => {
  makeObjC(() => { throw new Error('must not be called'); }, true);
  ctx.STATE.isBusy = false; ctx.STATE.pendingPickResponses = 0; ctx.STATE.pendingPickMeta = [];
  ctx.STATE.pickedIds = { '704': 'sent' };
  const before = events.filter(e => e.type === 'pick_failed').length;
  assert.equal(ctx.sendPickSingle(704, 25000, { forceNotify: true, assignmentId: 'A704', source: 'assignment_popup' }), true);
  const emitted = events.filter(e => e.type === 'pick_failed').slice(before);
  assert.equal(emitted.length, 1, 'a definitely-unsent Assignment pick must display one failure');
  assert.equal(emitted[0].assignmentId, 'A704');
  assert.equal(emitted[0].forceNotify, true);
  assert.match(emitted[0].responseMessage, /Lỗi chuẩn bị request/);
});

test('batch with only pre-handoff failures releases all per-order and group reservations', () => {
  makeObjC(() => { throw new Error('must not be called'); }, true);
  ctx.STATE.isBusy = false; ctx.STATE.pendingPickResponses = 0; ctx.STATE.pendingPickMeta = [];
  ctx.STATE.pickedIds = { '708': 'sent', '709': 'sent', group708: 'sent' };
  assert.equal(ctx.sendPickBatch([708, 709], 40000, 'test batch', null, { reservationKey: 'group708' }), true);
  assert.equal(ctx.STATE.pendingPickResponses, 0);
  assert.equal(ctx.STATE.isBusy, false);
  assert.equal(ctx.STATE.pickedIds['708'], undefined);
  assert.equal(ctx.STATE.pickedIds['709'], undefined);
  assert.equal(ctx.STATE.pickedIds.group708, undefined);
});

// Exception after entering RCTNetworking: request outcome is ambiguous; never auto-retry.
test('SINGLE PICK ambiguous handoff preserves metadata, reservation and busy lock', () => {
  makeObjC(() => { throw new Error('handoff exception'); }, false);
  ctx.STATE.isBusy = false; ctx.STATE.pendingPickResponses = 0; ctx.STATE.pendingPickMeta = [];
  ctx.STATE.pickedIds = { '703': 'sent' };
  assert.equal(ctx.sendPickSingle(703, 30000), true);
  assert.equal(ctx.STATE.pendingPickResponses, 1);
  assert.equal(ctx.STATE.isBusy, true);
  assert.equal(ctx.STATE.pendingPickMeta.length, 1);
  assert.equal(ctx.STATE.pendingPickMeta[0].status, 'UNKNOWN');
  assert.equal(ctx.STATE.pickedIds['703'], 'sent');
});

test('MPICK preparation failure releases its group reservation', () => {
  makeObjC(() => { throw new Error('must not be called'); }, true);
  ctx.STATE.isBusy = false; ctx.STATE.pendingPickResponses = 0; ctx.STATE.pendingPickMeta = [];
  ctx.STATE.pickedIds = { 'group-prep': 'sent' };
  assert.equal(ctx.sendPickGroup('group-prep', [710, 711], 50000, 2, { reservationKey: 'group-prep' }), true);
  assert.equal(ctx.STATE.pendingPickResponses, 0);
  assert.equal(ctx.STATE.isBusy, false);
  assert.equal(ctx.STATE.pendingPickMeta.length, 0);
  assert.equal(ctx.STATE.pickedIds['group-prep'], undefined);
});

// Same guarantee for group MPICK handoff.
test('MPICK ambiguous handoff preserves its metadata and blocks duplicate MPICK', () => {
  makeObjC(() => { throw new Error('mpick handoff exception'); }, false);
  ctx.STATE.isBusy = false; ctx.STATE.pendingPickResponses = 0; ctx.STATE.pendingPickMeta = [];
  assert.equal(ctx.sendPickGroup('group-1', [704, 705], 50000, 2), true);
  assert.equal(ctx.STATE.pendingPickResponses, 1);
  assert.equal(ctx.STATE.isBusy, true);
  assert.equal(ctx.STATE.pendingPickMeta.length, 1);
  assert.equal(ctx.STATE.pendingPickMeta[0].status, 'UNKNOWN');
});

// Numeric Retry-After is honored for rate limiting / server overload.
test('429 Retry-After header overrides the client backoff floor', () => {
  makeObjC(() => {}, false);
  const response = {
    respondsToSelector_: () => true,
    valueForHTTPHeaderField_: () => ({ toString: () => '2' })
  };
  const task = { handle: 'retry-after', respondsToSelector_: () => true, response: () => response };
  ctx.STATE.refreshBackoffMs = 0;
  ctx.STATE.refreshBackoffUntil = 0;
  ctx.STATE.consecutive503 = 0;
  ctx.handleRefreshHTTPStatus(429, task);
  assert.equal(ctx.STATE.refreshBackoffMs, 2000);
  assert.ok(ctx.STATE.refreshBackoffUntil >= Date.now() + 1990);
});

test('refresh backoff clears only after a valid list response is parsed', () => {
  ctx.STATE.refreshBackoffMs = 1500;
  ctx.STATE.refreshBackoffUntil = Date.now() + 1500;
  ctx.STATE.consecutive503 = 3;
  ctx.processOrderList({ code: 503, data: { orders: [] } });
  assert.equal(ctx.STATE.refreshBackoffMs, 1500, 'non-success API response must not clear backoff');
  ctx.processOrderList({ code: 0, data: { orders: [] } });
  assert.equal(ctx.STATE.refreshBackoffMs, 0, 'valid API response clears backoff');
  assert.equal(ctx.STATE.consecutive503, 0);
});

test('exponential backoff continues growing after the previous wait window expires', () => {
  ctx.STATE.refreshBackoffMs = 500;
  ctx.STATE.refreshBackoffUntil = Date.now() - 1;
  ctx.STATE.consecutive503 = 3;
  assert.equal(ctx.nextRefreshBackoff(503, null), 1000, '503 backoff should double after the prior wait elapsed');
  ctx.STATE.refreshBackoffMs = 8000;
  ctx.STATE.refreshBackoffUntil = Date.now() - 1;
  assert.equal(ctx.nextRefreshBackoff(503, null), 8000, '503 backoff should respect the 8 second cap');
  ctx.STATE.refreshBackoffMs = 1000;
  assert.equal(ctx.nextRefreshBackoff(429, null), 2000, '429 backoff should also preserve its exponent');
  ctx.STATE.refreshBackoffMs = 0;
  ctx.STATE.refreshBackoffUntil = 0;
  ctx.STATE.consecutive503 = 0;
});

// Verbose non-match logs must include order ID, distance, and earnings, with throttling.
test('verbose filter logs show km and price for non-matching orders and are throttled', () => {
  ctx.STATE.isBusy = false;
  ctx.STATE.pendingPickResponses = 0;
  ctx.STATE.activePickBatch = null;
  ctx.STATE.pendingPickMeta = [];
  ctx.STATE.stopped = false;
  ctx.CONFIG.enabled = true;
  ctx.CONFIG.autoPick = false;
  ctx.CONFIG.verboseLog = true;
  ctx.CONFIG.minPrice = 50000;
  ctx.CONFIG.maxPrice = 0;
  ctx.CONFIG.minDistance = 0;
  ctx.CONFIG.maxDistance = 50000;
  ctx.CONFIG.minCOD = 0; ctx.CONFIG.maxCOD = 0;
  ctx.CONFIG.preferredCategories = [6];
  ctx.CONFIG.districtFilterMode = 0;
  const rejected = { code: 0, data: { orders: [
    { total_earnings_amount: 42000, delivery_distance: 12500, delivery_orders: [{ delivery_order_id: 706, ref_order_category: 6 }] },
    { total_earnings_amount: 61000, delivery_distance: 68000, delivery_orders: [{ delivery_order_id: 707, ref_order_category: 6 }] }
  ] } };
  const before = events.filter(e => e.type === 'logs').flatMap(e => e.lines).length;
  ctx.processOrderList(rejected);
  const logs = events.filter(e => e.type === 'logs').flatMap(e => e.lines).slice(before);
  assert.ok(logs.some(line => line.includes('#706') && line.includes('12.5 km') && line.includes('42.000đ') && line.includes('Gia thap')),
    'low-price rejection should log ID, distance, price and reason');
  assert.ok(logs.some(line => line.includes('#707') && line.includes('68.0 km') && line.includes('61.000đ') && line.includes('Xa qua')),
    'too-far rejection should log ID, distance, price and reason');
  const countBeforeRepeat = events.filter(e => e.type === 'logs').flatMap(e => e.lines).length;
  ctx.processOrderList(rejected);
  const countAfterRepeat = events.filter(e => e.type === 'logs').flatMap(e => e.lines).length;
  assert.equal(countAfterRepeat, countBeforeRepeat, 'same non-match logs should be throttled');
});

// Chunk array is mutated in place to avoid O(n) array copies on every small callback.
test('response chunk append reuses the original chunk array', () => {
  const first = ctx.bufferAppend('assignmentBuffers', 'reuse-test', '{"data":');
  const reference = first.chunks;
  const second = ctx.bufferAppend('assignmentBuffers', 'reuse-test', '{}');
  assert.equal(second.chunks, reference);
  assert.equal(ctx.bufferText(second), '{"data":{}');
});

test('chunk count ceiling rejects streams with excessive tiny callbacks', () => {
  let current = null;
  for (let i = 0; i < 2048; i++) current = ctx.bufferAppend('testResponseBuffers', 'many-chunks', 'x');
  assert.ok(current && current.chunks.length === 2048);
  const rejected = ctx.bufferAppend('testResponseBuffers', 'many-chunks', 'x');
  assert.equal(rejected, null);
  assert.equal(ctx.STATE.testResponseBuffers['many-chunks'], undefined);
});

console.log('PASS: ' + passed + ' v6.6.7 safety/verbose regression tests');
