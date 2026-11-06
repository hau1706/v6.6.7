'use strict';
const assert = require('node:assert/strict');

const ALLOWED_LEVELS = new Set(['INFO', 'SUCCESS', 'WARNING', 'ERROR']);
const CODE = /^[A-Z][A-Z0-9_]*(\.[A-Z0-9_]+)+$/;

function validateEvent(event) {
  assert.equal(event.version, 1, 'version must be 1');
  assert.equal(typeof event.event_id, 'string');
  assert.ok(event.event_id.length > 0, 'event_id is required');
  assert.equal(typeof event.timestamp, 'string');
  assert.ok(Number.isFinite(Date.parse(event.timestamp)), 'timestamp must be ISO-8601');
  assert.ok(ALLOWED_LEVELS.has(event.level), 'unsupported log level');
  assert.ok(CODE.test(event.code), 'code must be a namespaced event code');
  assert.equal(typeof event.source, 'string');
  assert.equal(typeof event.message, 'string');
  assert.ok(event.context && typeof event.context === 'object' && !Array.isArray(event.context));
  assert.ok(event.correlation_id === null || typeof event.correlation_id === 'string');
  return true;
}

const sample = {
  version: 1,
  event_id: 'evt-0001',
  timestamp: '2026-11-03T16:15:20.125Z',
  level: 'WARNING',
  code: 'PICK.UNKNOWN_TIMEOUT',
  source: 'FRIDA',
  message: 'Server response not received before timeout',
  context: { order_id: '123456', reservation: 'HELD' },
  correlation_id: 'pick-0001'
};

assert.equal(validateEvent(sample), true);
assert.throws(() => validateEvent({ ...sample, level: 'DEBUG' }));
assert.throws(() => validateEvent({ ...sample, code: 'invalid' }));
assert.throws(() => validateEvent({ ...sample, timestamp: 'not-a-date' }));
console.log('logging-schema.test.js: PASS');
