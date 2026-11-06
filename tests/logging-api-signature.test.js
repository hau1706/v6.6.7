'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');

const header = fs.readFileSync('Sources/APFLogManager.h', 'utf8');
const implementation = fs.readFileSync('Sources/APFLogManager.m', 'utf8');
const menu = fs.readFileSync('Sources/APFMenu.m', 'utf8');

assert.match(header, /source:\(NSString\s*\*\)source\s+correlationID:\(nullable NSString\s*\*\)correlationID\s+context:/,
  'APFLogManager public selector requires correlationID: between source: and context:');
assert.match(implementation, /source:\(NSString\s*\*\)source\s+correlationID:\(NSString\s*\*\)correlationID\s+context:/,
  'APFLogManager implementation must match the declared selector');
assert.match(menu, /message:body source:@"NOTIFY"\s+correlationID:\(assignmentId\.length \? assignmentId : nil\)\s+context:/,
  'forced Assignment result log must pass correlationID:');
assert.doesNotMatch(menu, /message:body source:@"NOTIFY"\s+context:/,
  'the obsolete selector call without correlationID: must not remain');

console.log('logging-api-signature.test.js: PASS');
