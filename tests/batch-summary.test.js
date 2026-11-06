#!/usr/bin/env node
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '..', 'frida-agent.js'), 'utf8');
assert.match(source, /splitAllCodeOnlySuccess:\s*true/, 'only the Pick lẻ ALL selection path enables code-only batch confirmation');
const events = [];
const ctx = {
  send: message => events.push(message), recv: () => {},
  setTimeout: () => 1, clearTimeout: () => {}, setInterval: () => 2, clearInterval: () => {},
  Date, JSON, Math, String, Object, Array, parseInt, isNaN, isFinite, Number, RegExp, Error
};
vm.createContext(ctx); vm.runInContext(source, ctx, { filename: 'frida-agent.js' });
function seedBatch(ids) {
  ctx.STATE.pendingPickMeta = ids.map(id => ({ info: `Đơn #${id}`, orderId: id, price: 10000, status: 'SUBMITTED' }));
  ctx.STATE.pendingPickResponses = ids.length;
  ctx.STATE.isBusy = true;
  ctx.STATE.activePickBatch = {
    batchId: 'batch-test-' + ids.join('-'), ids: ids.slice(), total: ids.length, label: `Chùm ${ids.length} đơn`, price: ids.length * 10000,
    successCount: 0, failureCount: 0, unknownSuccessCount: 0, unmappedFailureCount: 0, unmappedUnknownCount: 0, responseSuccessCount: 0,
    submittedCount: ids.length, ambiguousCount: 0, knownSuccessIds: [], failureReasons: [], unmappedLogged: false,
    summaryEmitted: false, startedAt: Date.now(), items: ids.map(id => ({ orderId: id, price: 10000, status: 'SUBMITTED', detail: '' }))
  };
}
function taskFor(id) {
  ctx.ObjC = { selector: s => s, classes: { NSString: { alloc: () => ({ initWithData_encoding_: data => ({ toString: () => String(data) }) }) } } };
  return {
    respondsToSelector_: () => true,
    currentRequest: () => ({ HTTPBody: () => JSON.stringify({ delivery_order_id: id }) })
  };
}
function lastSummary() { return events.filter(x => x.type === 'pick_batch_summary').at(-1); }

// Four split singles: correlate every response to its own ID; aggregate into one summary event.
seedBatch([41004, 41002, 41001, 41003]);
ctx.handlePickResponse('{"code":0,"msg":"ok"}', taskFor(41004));
ctx.handlePickResponse('{"code":1,"msg":"not accepted"}', taskFor(41002));
ctx.handlePickResponse('{"code":0,"msg":"ok"}', taskFor(41001));
ctx.handlePickResponse('{"code":0,"msg":"ok"}', taskFor(41003));
let summary = lastSummary();
assert.equal(summary.totalCount, 4);
assert.equal(summary.successCount, 3);
assert.equal(summary.failureCount, 1);
assert.equal(summary.unknownCount, 0);
assert.equal(summary.notSentCount, 0);
assert.deepEqual(Array.from(summary.items, x => [x.orderId, x.status]), [
  [41004, 'SUCCESS'], [41002, 'FAILED'], [41001, 'SUCCESS'], [41003, 'SUCCESS']
]);
assert.equal(events.filter(x => x.type === 'pick_batch_summary').length, 1, 'only one batch summary event');
assert.equal(ctx.STATE.activePickBatch, null, 'fully correlated batch releases active tracking');

// SPLIT ALL: the backend returns one code-only response per individual request.
// Three code:0 responses confirm the whole group even though delivery_order_id is absent.
seedBatch([42001, 42002, 42003]);
ctx.STATE.activePickBatch.responseMode = 'SPLIT_ALL_CODE_ONLY';
ctx.handlePickResponse('{"code":0,"msg":"success","data":null}', {});
ctx.handlePickResponse('{"code":0,"msg":"success","data":null}', {});
ctx.handlePickResponse('{"code":0,"msg":"success","data":null}', {});
summary = lastSummary();
assert.equal(summary.totalCount, 3);
assert.equal(summary.successCount, 3, 'all code:0 responses confirm all SPLIT ALL orders');
assert.equal(summary.failureCount, 0);
assert.equal(summary.unknownCount, 0, 'code-only success must not become UNKNOWN');
assert.equal(summary.unmappedSuccessCount, 0, 'SPLIT ALL code-only success is not an unmapped warning');
assert.equal(summary.codeOnlySuccessCount, 3, 'summary records the count of code-only confirmations');
assert.deepEqual(Array.from(summary.items, x => [x.orderId, x.status]), [
  [42001, 'SUCCESS'], [42002, 'SUCCESS'], [42003, 'SUCCESS']
]);
assert.equal(ctx.STATE.isBusy, false, 'fully code:0 SPLIT ALL batch releases the gate');
assert.equal(ctx.STATE.activePickBatch, null);
assert.ok(events.some(x => x.type === 'log' && x.code === 'PICK.SPLIT_ALL.CODE_ONLY_CONFIRMED') ||
  events.some(x => x.type === 'pick_batch_summary'), 'SPLIT ALL aggregate confirmation is emitted');

// A manual Assignment popup Pick-lẻ ALL is the same code-only fan-out. Explicit code:1
// responses must be visible as FAILED with the server message, not hidden as UNKNOWN.
seedBatch([43001, 43002, 43003]);
ctx.STATE.activePickBatch.responseMode = 'SPLIT_ALL_CODE_ONLY';
ctx.STATE.activePickBatch.assignmentId = '1792469759';
ctx.STATE.activePickBatch.source = 'assignment_popup';
ctx.STATE.activePickBatch.forceNotify = true;
ctx.handlePickResponse('{"msg":"error_driver_location_not_found","code":1,"data":null}', {});
ctx.handlePickResponse('{"msg":"error_driver_location_not_found","code":1,"data":null}', {});
ctx.handlePickResponse('{"msg":"error_driver_location_not_found","code":1,"data":null}', {});
summary = lastSummary();
assert.equal(summary.assignmentId, '1792469759');
assert.equal(summary.forceNotify, true, 'manual Assignment pick must force a visible result notification');
assert.equal(summary.successCount, 0);
assert.equal(summary.failureCount, 3, 'three explicit code:1 responses are three failed requests');
assert.equal(summary.unknownCount, 0, 'explicit failure responses are not UNKNOWN');
assert.equal(summary.responseDetails.length, 3);
assert.equal(summary.responseDetails[0].msg, 'error_driver_location_not_found');
assert.deepEqual(Array.from(summary.items, x => x.status), ['FAILED', 'FAILED', 'FAILED']);

// Mixed code-only replies produce aggregate counts and preserve failure reasons without
// inventing which order ID belongs to the uncorrelated response.
seedBatch([44001, 44002, 44003]);
ctx.STATE.activePickBatch.responseMode = 'SPLIT_ALL_CODE_ONLY';
ctx.STATE.activePickBatch.assignmentId = 'MIXED-1';
ctx.STATE.activePickBatch.forceNotify = true;
ctx.handlePickResponse('{"msg":"success","code":0}', {});
ctx.handlePickResponse('{"msg":"not_available","code":1}', {});
ctx.handlePickResponse('{"msg":"success","code":0}', {});
summary = lastSummary();
assert.equal(summary.successCount, 2);
assert.equal(summary.failureCount, 1);
assert.equal(summary.unknownCount, 0);
assert.ok(summary.items.every(x => x.status === 'RESULT_RECEIVED'), 'mixed uncorrelated replies are not assigned to arbitrary order IDs');
assert.equal(summary.responseDetails.filter(x => x.outcome === 'FAILED')[0].msg, 'not_available');

// Uncorrelated response in other batch modes: do not assign the response to a random order; preserve UNKNOWN lock.
seedBatch([51001, 51002]);
ctx.handlePickResponse('{"code":0,"msg":"ok"}', {});
ctx.handlePickResponse('{"code":0,"msg":"ok"}', taskFor(51002));
summary = lastSummary();
assert.equal(summary.successCount, 1);
assert.equal(summary.unknownCount, 1);
assert.equal(summary.unmappedSuccessCount, 1);
assert.deepEqual(Array.from(summary.items, x => [x.orderId, x.status]), [[51001, 'UNKNOWN'], [51002, 'SUCCESS']]);
assert.equal(ctx.STATE.isBusy, true, 'unmapped item keeps the gate closed');
assert.ok(ctx.STATE.activePickBatch, 'unresolved batch retained for possible late response');

// Timeout summary is emitted once; late correlated responses can resolve UNKNOWN without replaying requests.
seedBatch([61001, 61002]);
ctx.markPendingPicksUnknown('test timeout');
ctx.finishPickBatch(true, 2);
summary = lastSummary();
assert.equal(summary.unknownCount, 2);
assert.equal(summary.pendingResponseCount, 2);
const summaryCount = events.filter(x => x.type === 'pick_batch_summary').length;
ctx.handlePickResponse('{"code":0,"msg":"late ok"}', taskFor(61001));
ctx.handlePickResponse('{"code":0,"msg":"late ok"}', taskFor(61002));
assert.equal(events.filter(x => x.type === 'pick_batch_summary').length, summaryCount, 'late resolution does not produce a duplicate popup');
assert.equal(ctx.STATE.activePickBatch, null, 'late correlated responses resolve the batch lock');
assert.equal(ctx.STATE.isBusy, false);

// A syntactically valid JSON response without an explicit API code is UNKNOWN, never FAILED.
ctx.STATE.activePickBatch = null;
ctx.STATE.pendingPickMeta = [{ info: 'Đơn #71001', orderId: 71001, price: 10000, status: 'SUBMITTED' }];
ctx.STATE.pendingPickResponses = 1;
ctx.STATE.isBusy = true;
const failedBeforeUnknownCode = events.filter(x => x.type === 'pick_failed').length;
ctx.handlePickResponse('{"msg":"response shape changed"}', taskFor(71001));
assert.equal(ctx.STATE.isBusy, true, 'missing response code keeps the single-pick gate closed');
assert.equal(ctx.STATE.pendingPickMeta[0].status, 'UNKNOWN', 'missing response code must retain UNKNOWN metadata');
assert.equal(events.filter(x => x.type === 'pick_failed').length, failedBeforeUnknownCode, 'missing code must not create a FAILED event');

console.log('PASS batch-summary: per-order SUCCESS/FAILED/UNKNOWN, single summary, timeout, late resolution and malformed-code safety');
