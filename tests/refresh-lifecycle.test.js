#!/usr/bin/env node
'use strict';
// Regression tests for the v6.6.7 refresh engine, timer generations, memory manager and
// differential equivalence of order selection against the v6.6.4 fixture.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const newSource = fs.readFileSync(path.join(root, 'frida-agent.js'), 'utf8');
const oldSource = fs.readFileSync(path.join(__dirname, 'fixtures', 'frida-agent.v6.6.4.js'), 'utf8');

// ---------- deterministic clock + timers ----------
function makeEnv(source) {
  const clock = { now: 1_000_000 };
  class FakeDate extends Date { static now() { return clock.now; } }
  const timers = new Map(); let nextId = 1;
  const events = [];
  const sent = [];
  const ctx = {
    send: (m) => events.push(m), recv: () => {},
    setTimeout: (fn, ms) => { const id = nextId++; timers.set(id, { fn, at: clock.now + (ms || 0), repeat: 0 }); return id; },
    clearTimeout: (id) => { timers.delete(id); },
    setInterval: (fn, ms) => { const id = nextId++; timers.set(id, { fn, at: clock.now + ms, repeat: ms }); return id; },
    clearInterval: (id) => { timers.delete(id); },
    Date: FakeDate, JSON, Math, String, Object, Array, parseInt, isNaN, isFinite, Number, RegExp, Error
  };
  vm.createContext(ctx);
  vm.runInContext(source, ctx, { filename: 'agent.js' });
  function advance(ms) {
    const end = clock.now + ms;
    for (;;) {
      let best = null, bestId = 0;
      for (const [id, t] of timers) if (t.at <= end && (!best || t.at < best.at)) { best = t; bestId = id; }
      if (!best) break;
      clock.now = Math.max(clock.now, best.at);
      if (best.repeat) best.at += best.repeat; else timers.delete(bestId);
      best.fn();
    }
    clock.now = end;
  }
  return { ctx, clock, timers, events, sent, advance };
}

function mockObjC(env) {
  function req(timeout) {
    return { timeout: timeout || 60, mutableCopy() { return req(this.timeout); },
      setTimeoutInterval_(v) { this.timeout = v; }, timeoutInterval() { return this.timeout; } };
  }
  env.ctx.ObjC = { available: true, mainQueue: {}, schedule: (_q, fn) => fn(), selector: (s) => s, classes: {} };
  env.ctx.refreshRequestHeaders = () => {};
  env.ctx.modifyRequestInPlace = () => true;
  env.ctx.globalBlocks = { empty: {} };
  env.ctx.STATE.networkingObj = {
    sendRequest_responseType_incrementalUpdates_responseSender_: (r) => env.sent.push({ req: r, at: env.clock.now })
  };
  env.ctx.STATE.savedRequest = req(60);
  env.ctx.CONFIG.refreshIntervalMs = 400;
  env.ctx.CONFIG.enabled = true; env.ctx.CONFIG.autoRefresh = true; env.ctx.CONFIG.autoPick = false;
  return {
    taskFor(sentEntry, handle) {
      return { handle: handle, respondsToSelector_: () => true, currentRequest: () => sentEntry.req };
    },
    foreignTask(handle) {
      return { handle, respondsToSelector_: () => true, currentRequest: () => req(60) };
    }
  };
}
const orderJson = (id, earn = 30000) => JSON.stringify({ code: 0, data: { orders: [{
  total_earnings_amount: earn, delivery_distance: 3000, pre_group_code: null,
  delivery_orders: [{ delivery_order_id: id, ref_order_category: 6, delivery_distance: 3000 }] }] } });
let passed = 0;
function test(name, fn) { fn(); passed++; console.log('  ok - ' + name); }

// 1. HTTP 200 -> normal processing, request completed once
test('HTTP 200 processes the order list and completes the request', () => {
  const env = makeEnv(newSource); const m = mockObjC(env);
  env.ctx.startRefreshLoop(0);
  assert.equal(env.sent.length, 1);
  const task = m.taskFor(env.sent[0], 'T1');
  env.ctx.processOrderListChunk(orderJson(111), 'https://x/free-pick/get-order-list', task);
  assert.ok(env.events.some((e) => e.type === 'match'), 'match event expected');
  assert.equal(env.ctx.STATE.refreshInFlight, false);
  assert.equal(env.ctx.STATE.refreshReq, null);
  assert.equal(env.ctx.STATS.refreshCompleted, 1);
});

// Adaptive 503 behavior: keep two transient failures on the user's cadence, then back off.
test('503 keeps first two refresh intervals, then applies bounded backoff after repeated overload', () => {
  const env = makeEnv(newSource); const m = mockObjC(env);
  env.ctx.startRefreshLoop(0);
  assert.equal(env.sent.length, 1);
  env.ctx.handleRefreshHTTPStatus(503, m.taskFor(env.sent[0], 'H0'));
  env.advance(400);
  assert.equal(env.sent.length, 2, 'first 503 preserves 400 ms cadence');
  env.ctx.handleRefreshHTTPStatus(503, m.taskFor(env.sent[1], 'H1'));
  env.advance(400);
  assert.equal(env.sent.length, 3, 'second 503 preserves 400 ms cadence');
  env.ctx.handleRefreshHTTPStatus(503, m.taskFor(env.sent[2], 'H2'));
  assert.equal(env.ctx.STATE.refreshBackoffMs, 500, 'third consecutive 503 applies 500 ms backoff');
  env.advance(400);
  assert.equal(env.sent.length, 3, 'must not dispatch before 500 ms backoff expires');
  env.advance(100);
  assert.equal(env.sent.length, 4, 'dispatches after the 500 ms backoff');
  assert.equal(env.sent[1].at - env.sent[0].at, 400);
  assert.equal(env.sent[2].at - env.sent[1].at, 400);
  assert.equal(env.sent[3].at - env.sent[2].at, 500);
  assert.equal(env.ctx.STATS.http503, 3);
  assert.ok(env.ctx.STATE.refreshReq, 'new refresh should be the only in-flight request');
});

// 4/5. 503 with multiple data chunks counts once; without any body the lifecycle still ends via the status call
test('503 delivered in several callbacks of the same task counts once', () => {
  const env = makeEnv(newSource); const m = mockObjC(env);
  env.ctx.startRefreshLoop(0);
  const task = m.taskFor(env.sent[0], 'TT');
  env.ctx.handleRefreshHTTPStatus(503, task);
  env.ctx.handleRefreshHTTPStatus(503, task);
  env.ctx.handleRefreshHTTPStatus(503, task);
  assert.equal(env.ctx.STATS.http503, 1);
  assert.equal(env.ctx.STATE.refreshReq, null, 'request is finished by the first status callback');
});

// 6/7. Timeout: no parallel loop, late response of the old request must not overwrite the new request
test('timeout releases in-flight only after the watchdog; late responses are dropped', () => {
  const env = makeEnv(newSource); const m = mockObjC(env);
  env.ctx.startRefreshLoop(0);
  assert.equal(env.sent.length, 1);
  const firstTask = m.taskFor(env.sent[0], 'OLD');
  env.advance(3000);
  assert.equal(env.sent.length, 1, 'no new request while the first is still within its timeout window');
  env.advance(800);                                        // > 3.6 s
  assert.equal(env.ctx.STATS.timeouts, 1);
  assert.equal(env.sent.length, 2, 'exactly one replacement request after timeout');
  const secondReq = env.ctx.STATE.refreshReq;
  assert.ok(secondReq && secondReq.id === 2 && secondReq.state === 'created');
  // old response arrives late: neither processed nor allowed to finish request #2
  const matchesBefore = env.events.filter((e) => e.type === 'match').length;
  env.ctx.processOrderListChunk(orderJson(222), 'https://x/free-pick/get-order-list', firstTask);
  assert.equal(env.events.filter((e) => e.type === 'match').length, matchesBefore, 'late payload must be ignored');
  assert.equal(env.ctx.STATE.refreshReq, secondReq, 'late response must not touch the new request');
  assert.equal(env.ctx.STATE.refreshInFlight, true);
  assert.ok(env.ctx.STATS.staleResponses >= 1);
  env.ctx.handleRefreshHTTPStatus(503, firstTask);
  assert.equal(env.ctx.STATE.refreshReq, secondReq, 'late 503 must not finish the new request either');
});

// 8. STOP/START storms never leave more than one loop timer, stale generation callbacks do nothing
test('rapid STOP/START keeps exactly one loop and ignores old generation callbacks', () => {
  const env = makeEnv(newSource); const m = mockObjC(env);
  const timersBefore = env.timers.size;                  // sweeper + hook timer + config timer
  for (let i = 0; i < 50; i++) { env.ctx.startRefreshLoop(0); env.ctx.stopRefreshLoop(); }
  env.ctx.CONFIG.enabled = true; env.ctx.STATE.stopped = false;
  env.ctx.startRefreshLoop(0);
  env.ctx.startRefreshLoop(0);
  env.ctx.startRefreshLoop(0);
  const loopTimers = [...env.timers.values()].length - timersBefore;
  assert.ok(loopTimers <= 1, 'at most one loop timer, got ' + loopTimers);
  env.sent.length = 0;
  const staleGen = env.ctx.STATE.loopGen - 1;
  env.ctx.startRCTNetworkingAutoLoad(staleGen);
  assert.equal(env.sent.length, 0, 'stale generation must not send');
  env.ctx.stopRefreshLoop();
  env.advance(5000);
  assert.equal(env.sent.length, 0, 'STOP must prevent every further refresh');
});

// STOP while a callback is already queued on the main queue
test('callback queued before STOP is discarded', () => {
  const env = makeEnv(newSource); const m = mockObjC(env);
  let queued = null;
  env.ctx.ObjC.schedule = (_q, fn) => { queued = fn; };
  env.ctx.startRefreshLoop(0);
  assert.ok(queued);
  env.ctx.stopRefreshLoop();
  queued();
  assert.equal(env.sent.length, 0);
  assert.equal(env.ctx.STATE.refreshReq, null);
});

// 10. incomplete assignment buffers are released on TTL; total buffers bounded
test('incomplete assignment buffers expire and are bounded', () => {
  const env = makeEnv(newSource);
  const url = 'https://x/api/v6/assignment/get-assignment-info';
  for (let i = 0; i < 100; i++) env.ctx.processAssignmentChunk('{"code":0,"data":{', url, { handle: 'r' + i });
  assert.ok(Object.keys(env.ctx.STATE.assignmentBuffers).length <= 32, 'max 32 buffers');
  env.advance(15000);
  assert.equal(Object.keys(env.ctx.STATE.assignmentBuffers).length, 0, 'expired after 10 s');
  env.ctx.processAssignmentChunk('x'.repeat(262145), url, { handle: 'big' });
  assert.equal(Object.keys(env.ctx.STATE.assignmentBuffers).length, 0, 'oversized buffer dropped');
});

// 11. large JSON bounded
test('oversized order-list response is dropped and fails the request', () => {
  const env = makeEnv(newSource); const m = mockObjC(env);
  env.ctx.startRefreshLoop(0);
  const task = m.taskFor(env.sent[0], 'BIG');
  env.ctx.processOrderListChunk('{"a":"' + 'x'.repeat(1048577), 'https://x/free-pick/get-order-list', task);
  assert.equal(Object.keys(env.ctx.STATE.orderListBuffers).length, 0);
  assert.equal(env.ctx.STATE.refreshReq, null);
});

// 13. caches bounded and expiring
test('ID caches respect limits and TTL without evicting fresh entries', () => {
  const env = makeEnv(newSource);
  for (let i = 0; i < 5000; i++) env.ctx.memSet('pickedIds', 'o' + i, 'sent');
  assert.equal(Object.keys(env.ctx.STATE.pickedIds).length, 3000);
  assert.ok(env.ctx.STATE.pickedIds['o4999'], 'newest kept');
  assert.ok(!env.ctx.STATE.pickedIds['o0'], 'oldest evicted first');
  for (let i = 0; i < 1500; i++) env.ctx.memSet('notifiedIds', 'n' + i, true);
  assert.equal(Object.keys(env.ctx.STATE.notifiedIds).length, 1000);
  env.advance(306000);
  assert.equal(Object.keys(env.ctx.STATE.notifiedIds).length, 0, 'notifiedIds expire after 5 min');
  assert.ok(Object.keys(env.ctx.STATE.pickedIds).length === 3000, 'pickedIds survive 5 min (30 min TTL)');
  env.advance(1800000);
  assert.equal(Object.keys(env.ctx.STATE.pickedIds).length, 0, 'pickedIds expire after 30 min');
});

// 13b. 60-minute soak: only bounded state remains
test('60 minute soak keeps every store bounded and only one sweeper timer exists', () => {
  const env = makeEnv(newSource); const m = mockObjC(env);
  env.ctx.startRefreshLoop(0);
  let seq = 0;
  for (let sec = 0; sec < 3600; sec++) {
    env.advance(1000);
    for (let k = env.sent.length - 1; k >= 0 && k >= env.sent.length - 3; k--) {
      const t = m.taskFor(env.sent[k], 'S' + k);
      if (sec % 7 === 0) env.ctx.handleRefreshHTTPStatus(503, t);
      else env.ctx.processOrderListChunk(orderJson(500000 + (seq++ % 20000)), 'https://x/free-pick/get-order-list', t);
    }
    env.ctx.processAssignmentChunk('{"code":0,', 'https://x/api/v6/assignment/get-assignment-info', { handle: 'a' + sec });
  }
  const snap = env.ctx.memoryGuardSnapshot();
  assert.ok(snap.buffers <= 32 + 8 + 8 + 32 + 4);
  assert.ok(snap.cachedIds <= 5000);
  assert.ok(Object.keys(env.ctx.STATE.statusSeen).length <= 32);
  assert.ok(Object.keys(env.ctx.STATE.abandonedTasks).length <= 16);
  assert.ok(snap.activeRefreshRequests <= 1);
  const intervals = [...env.timers.values()].filter((t) => t.repeat).length;
  assert.ok(intervals <= 2, 'sweeper (+ optional hook installer) only, got ' + intervals);
});

// unload cleans everything
test('dispose clears timers and data', () => {
  const env = makeEnv(newSource); const m = mockObjC(env);
  env.ctx.startRefreshLoop(0);
  env.ctx.memSet('pickedIds', 'a', 'sent');
  env.ctx.processAssignmentChunk('{"code":0,', 'https://x/api/v6/assignment/get-assignment-info', { handle: 'z' });
  env.ctx.disposeAgent();
  assert.equal(env.timers.size, 0, 'no timers left after dispose');
  assert.equal(Object.keys(env.ctx.STATE.pickedIds).length, 0);
  assert.equal(Object.keys(env.ctx.STATE.assignmentBuffers).length, 0);
  env.sent.length = 0;
  env.advance(10000);
  assert.equal(env.sent.length, 0);
});

// parse-once: the order-list path hands the parsed object over, JSON.parse is invoked once per response
test('order list JSON is parsed exactly once per response', () => {
  const env = makeEnv(newSource); const m = mockObjC(env);
  env.ctx.startRefreshLoop(0);
  let parses = 0; const realParse = env.ctx.JSON.parse;
  env.ctx.JSON = { parse: (x) => { parses++; return realParse(x); }, stringify: JSON.stringify };
  const body = orderJson(901);
  env.ctx.processOrderListChunk(body.slice(0, 40), 'https://x/free-pick/get-order-list', m.taskFor(env.sent[0], 'P1'));
  env.ctx.processOrderListChunk(body.slice(40), 'https://x/free-pick/get-order-list', m.taskFor(env.sent[0], 'P1'));
  assert.equal(parses, 1, 'partial chunk must not trigger a failing parse; complete response parses once');
});

// 14. differential: selection/pick calls identical to v6.6.4 on randomized inputs
test('order selection is identical to v6.6.4 (randomized differential test)', () => {
  function harness(src) {
    const env = makeEnv(src); const calls = [];
    const c = env.ctx;
    c.sendPickSingle = (oid, price) => { calls.push(['single', oid, price]); return true; };
    c.sendPickBatch = (ids, price, label) => { calls.push(['batch', Array.from(ids), price, label]); return true; };
    c.sendPickGroup = (code, ids, price, count) => { calls.push(['group', String(code), Array.from(ids), price, count]); return true; };
    return { env, calls };
  }
  let seed = 12345;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const addrs = ['12 Nguyễn Huệ, Quận 1', '5 Lê Lợi, Quận 10', 'Quận 12', 'Thủ Đức', ''];
  function genOrders() {
    const n = Math.floor(rnd() * 7), out = [];
    for (let i = 0; i < n; i++) {
      const k = pick([1, 1, 2, 3]); const dos = [];
      for (let j = 0; j < k; j++) dos.push({ delivery_order_id: 1000 + Math.floor(rnd() * 40), ref_order_category: pick([6, 6, 1, 3]),
        delivery_distance: Math.floor(rnd() * 9000), pickup_address_info: { address: pick(addrs) }, dropoff_address_info: { address: pick(addrs) } });
      out.push({ total_earnings_amount: pick([0, 10000, 25000, 25000, 40000, String(33000)]), delivery_distance: Math.floor(rnd() * 30000),
        pre_group_code: k > 1 ? pick(['G1', 'G2', null]) : null, orders: [{ cod_amount: pick([0, 0, 50000]) }], delivery_orders: dos });
    }
    return out;
  }
  const A = harness(oldSource), B = harness(newSource);
  for (let iter = 0; iter < 3000; iter++) {
    const cfg = { autoPick: pick([true, false]), pickAllSinglesInGroup: pick([true, false, false]), pickAllSinglesInGroupMinDistance: pick([0, 8000, 20000]),
      minPrice: pick([0, 20000]), maxPrice: pick([0, 35000]), minDistance: pick([0, 2000]), maxDistance: pick([50000, 15000]),
      minCOD: 0, maxCOD: pick([0, 10]), preferredCategories: pick([[6], [], [1, 6]]), districtFilterMode: pick([0, 1, 2, 3]),
      preferredDistricts: pick([[], ['Quận 1'], ['quan 10', 'Thủ Đức']]), cooldown: 0, maxOrdersPerSession: pick([0, 0, 3]), enabled: true, stopAfterPick: false };
    const orders = genOrders();
    const json = JSON.stringify({ code: pick([0, 0, 0, '0', 1]), data: { orders } });
    for (const h of [A, B]) {
      Object.assign(h.env.ctx.CONFIG, JSON.parse(JSON.stringify(cfg)));
      h.env.ctx.STATE.stopped = false; h.env.ctx.STATE.isBusy = false; h.env.ctx.STATE.pickedCount = iter % 4; h.env.ctx.STATE.lastPickTime = 0;
      if (h.env.ctx.memClear) { h.env.ctx.memClear('pickedIds'); h.env.ctx.memClear('notifiedIds'); }
      else { h.env.ctx.STATE.pickedIds = {}; h.env.ctx.STATE.notifiedIds = {}; }
      h.calls.length = 0; h.env.events.length = 0;
      h.env.ctx.processOrderList(h.env.ctx.processOrderList.length === 2 ? JSON.parse(json) : json);
    }
    const ev = (h) => h.env.events.filter((e) => e.type === 'match' || e.type === 'auto_stopped').map((e) => JSON.stringify(e));
    globalThis.__diffCalls = (globalThis.__diffCalls||0) + A.calls.length;
    assert.deepEqual(B.calls, A.calls, 'pick calls differ at iteration ' + iter + ' cfg=' + JSON.stringify(cfg));
    assert.deepEqual(ev(B), ev(A), 'events differ at iteration ' + iter);
    assert.equal(B.env.ctx.STATE.stopped, A.env.ctx.STATE.stopped, 'stopped flag differs at ' + iter);
    assert.deepEqual(Object.keys(B.env.ctx.STATE.pickedIds).sort(), Object.keys(A.env.ctx.STATE.pickedIds).sort(), 'pickedIds differ at ' + iter);
  }
});


// 15. Refresh is independent of the pick-response lock, but refresh remains single-flight.
test('refresh continues while a pick response is pending without overlapping refresh tasks', () => {
  const env = makeEnv(newSource); const m = mockObjC(env);
  env.ctx.startRefreshLoop(0);
  assert.equal(env.sent.length, 1);
  env.ctx.STATE.isBusy = true; // simulate an in-flight PICK request
  env.ctx.handleRefreshHTTPStatus(503, m.taskFor(env.sent[0], 'BUSY-REFRESH-1'));
  env.advance(400);
  assert.equal(env.sent.length, 2, 'refresh should not wait for the pick-response lock');
  assert.equal(env.ctx.STATE.isBusy, true, 'refresh must not clear the pick busy flag');
  env.advance(400);
  assert.equal(env.sent.length, 2, 'second refresh must not overlap the first refresh');
});

// 16. Chunk arrays are joined only once on completion; aggregate cap evicts oldest temporary data.
test('chunk buffers avoid repeated string concatenation and enforce a global hard cap', () => {
  const env = makeEnv(newSource);
  const c = env.ctx;
  const first = c.bufferAppend('assignmentBuffers', 'chunked', '{"code":');
  assert.ok(first && Array.isArray(first.chunks));
  assert.equal(c.bufferLooksComplete(first), false);
  const chunksRef = first.chunks;
  const second = c.bufferAppend('assignmentBuffers', 'chunked', '0}');
  assert.equal(second.chunks, chunksRef, 'chunk array should be reused without slice/copy');
  assert.equal(c.bufferText(second), '{"code":0}');
  assert.equal(c.bufferLooksComplete(second), true);

  c.bufferAppend('deliveryOrderListBuffers', 'large-old', 'x'.repeat(5 * 1024 * 1024));
  c.bufferAppend('orderListBuffers', 'new-order', 'y'.repeat(1024 * 1024));
  assert.ok(c.memoryGuardSnapshot().bufferBytes <= c.MEM_BUFFER_TOTAL_MAX_CODE_UNITS,
    'aggregate buffer units must not exceed configured hard cap');
  assert.ok(c.STATS.bufferEvictions > 0, 'oldest buffer should be evicted to admit a new stream');
  assert.ok(c.MEM_BUFFER_TOTAL_MAX_CODE_UNITS <= 6 * 1024 * 1024);
});

// 17. Once a batch handoff becomes ambiguous, later IDs are not dispatched.
test('batch stops after ambiguous handoff and releases reservations for IDs never submitted', () => {
  const env = makeEnv(newSource); const c = env.ctx;
  const wrap = v => ({ toString: () => String(v), dataUsingEncoding_: () => ({ length: () => ({ valueOf: () => String(v).length }) }) });
  const request = () => ({ mutableCopy() { return request(); }, setURL_() {}, setHTTPMethod_() {},
    setTimeoutInterval_() {}, setHTTPBody_() {}, setValue_forHTTPHeaderField_() {} });
  c.ObjC = { available: true, mainQueue: {}, schedule: (_q, fn) => fn(),
    classes: { NSString: { stringWithString_: wrap }, NSURL: { URLWithString_: v => v } } };
  c.refreshRequestHeaders = () => {};
  c.globalBlocks = { empty: {} };
  c.STATE.savedRequest = request();
  c.STATE.networkingObj = { sendRequest_responseType_incrementalUpdates_responseSender_: () => {
    c.__batchCalls = (c.__batchCalls || 0) + 1;
    if (c.__batchCalls === 2) throw new Error('ambiguous bridge handoff');
  } };
  c.STATE.pickedIds = {}; c.STATE.pendingPickMeta = [];
  for (const id of [701, 702, 703]) c.memSet('pickedIds', String(id), 'sent');
  assert.equal(c.sendPickBatch([701, 702, 703], 10000, 'test batch'), true);
  assert.equal(c.__batchCalls, 2, 'third ID must not be dispatched after ambiguous second handoff');
  assert.ok(c.STATE.isBusy, 'unresolved handoff must retain busy protection');
  assert.equal(c.STATE.pendingPickResponses, 2, 'first and ambiguous requests remain pending');
  assert.equal(c.STATE.pickedIds['703'], undefined, 'never-submitted ID is released for a later retry');
  assert.ok(c.STATE.pendingPickMeta.some(m => Number(m.orderId) === 702), 'ambiguous ID metadata stays to correlate a late response');
  assert.ok(!c.STATE.pendingPickMeta.some(m => Number(m.orderId) === 703), 'unsent ID metadata is removed');
});

console.log('  (differential pick calls compared: ' + (globalThis.__diffCalls||0) + ')');
console.log('PASS: ' + passed + ' refresh-lifecycle / memory / differential tests');
