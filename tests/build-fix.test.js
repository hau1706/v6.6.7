'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');

const source = fs.readFileSync('Sources/TestViewController.m', 'utf8');
const deallocs = source.match(/^\s*-\s*\(void\)dealloc\b/gm) || [];
assert.equal(deallocs.length, 1, 'TestViewController must implement dealloc exactly once');
const deallocStart = source.lastIndexOf('- (void)dealloc {');
const deallocEnd = source.indexOf('\n}', deallocStart);
assert.ok(deallocStart >= 0 && deallocEnd > deallocStart, 'The remaining dealloc implementation must exist');
const deallocBody = source.slice(deallocStart, deallocEnd);
assert.match(deallocBody, /prefsSyncTimer invalidate/);
assert.match(deallocBody, /logReloadTimer invalidate/);
assert.match(deallocBody, /statusCheckTimer invalidate/);
assert.match(deallocBody, /removeObserver:self/);
assert.doesNotMatch(source, /UI_USER_INTERFACE_IDIOM\s*\(/, 'Deprecated idiom macro must not remain');
assert.match(source, /UIDevice\.currentDevice\.userInterfaceIdiom == UIUserInterfaceIdiomPad/,
  'Use UIDevice.currentDevice.userInterfaceIdiom for iPad detection');
console.log('build-fix.test.js: PASS');
