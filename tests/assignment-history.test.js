#!/usr/bin/env node
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const menu = fs.readFileSync(path.join(root, 'Sources', 'APFMenu.m'), 'utf8');
const menuHeader = fs.readFileSync(path.join(root, 'Sources', 'APFMenu.h'), 'utf8');
const controller = fs.readFileSync(path.join(root, 'Sources', 'FridaController.m'), 'utf8');
const controllerHeader = fs.readFileSync(path.join(root, 'Sources', 'FridaController.h'), 'utf8');
const agent = fs.readFileSync(path.join(root, 'frida-agent.js'), 'utf8');

assert.match(menu, /APFSkippedAssignmentHistory/);
assert.match(menu, /NSUserDefaults standardUserDefaults/);
assert.match(menu, /saveSkippedAssignment:/);
assert.match(menu, /updateAssignmentHistory:/);
assert.match(menu, /record\[@"status"\]\s*=\s*@"SKIPPED"/);
assert.match(menu, /orderIds/);
assert.match(menu, /expectedOrderCount/);
assert.match(menu, /records\.count > 50/, 'history is bounded to 50 entries');
assert.match(menu, /showSkippedAssignmentHistoryFromOffset:/);
assert.match(menu, /Assignment cũ hơn →/);
assert.match(menu, /← Trang trước/);
assert.match(menu, /\[self repickAssignment:assignment\]|repickAssignment:assignment/);
assert.match(menu, /\[status isEqualToString:@"SKIPPED"\] \|\| \[status isEqualToString:@"FAILED"\]/,
  'only skipped or confirmed failed assignments can be retried');
assert.match(menuHeader, /saveSkippedAssignment:/);
assert.match(menuHeader, /showSkippedAssignmentHistoryWithPickHandler:/);
assert.match(controllerHeader, /repickAssignment:/);
assert.match(controller, /if \(\[action isEqualToString:@"skip"\]\) \[APFMenu saveSkippedAssignment:payload\]/,
  'skip action persists its assignment before the agent removes it from session memory');
assert.match(controller, /type\": @\"assignment_repick\"/);
assert.match(agent, /type === 'assignment_repick'/);
assert.match(agent, /source: 'assignment_history'/);
assert.match(agent, /assignment_repick_started/);
assert.match(agent, /assignment_repick_failed/);

// Exercise the actual agent message path used by the native history screen.
const vm = require('node:vm');
const events = [];
let receiveHandler = null;
const ctx = {
  send: message => events.push(message),
  recv: callback => { receiveHandler = callback; },
  setTimeout: () => 1, clearTimeout: () => {}, setInterval: () => 2, clearInterval: () => {},
  Date, JSON, Math, String, Object, Array, parseInt, isNaN, isFinite, Number, RegExp, Error
};
vm.createContext(ctx);
vm.runInContext(agent, ctx, { filename: 'frida-agent.js' });
ctx.STATE.isBusy = false;
ctx.STATE.pendingPickResponses = 0;
ctx.STATE.networkingObj = {};
ctx.STATE.savedRequest = {};
let queued = null;
ctx.sendPickBatch = (ids, price, label, priceMap, options) => {
  queued = { ids: Array.from(ids), price, label, priceMap, options };
  return true;
};
assert.equal(typeof receiveHandler, 'function', 'agent message handler is installed');
receiveHandler({ type: 'assignment_repick', assignment: {
  assignmentId: 'HIST-RETRY-1', orderIds: [81001, 81002, 81003], expectedOrderCount: 3,
  isGroup: true, incompleteGroup: false, price: 72000, distance: 8500
} });
assert.deepEqual(queued.ids, [81001, 81002, 81003]);
assert.equal(queued.options.splitAllCodeOnlySuccess, true);
assert.equal(queued.options.forceNotify, true);
assert.equal(queued.options.assignmentId, 'HIST-RETRY-1');
assert.equal(queued.options.source, 'assignment_history');
assert.ok(events.some(e => e.type === 'assignment_repick_started'), 'history entry transitions to PICKING after queue succeeds');

console.log('PASS assignment-history: persistent skip records, paginated history, guarded repick flow and status updates');
