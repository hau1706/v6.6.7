#!/usr/bin/env node
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const native = fs.readFileSync(path.join(root, 'Sources', 'FridaController.m'));
const agent = fs.readFileSync(path.join(root, 'frida-agent.js'));
const bundle = fs.readFileSync(path.join(root, 'Sources', 'frida-agent-bundle.js'));
const plist = fs.readFileSync(path.join(root, 'Sources', 'Info.plist'), 'utf8');
const source = agent.toString('utf8');
const nativeText = native.toString('utf8');
for (const token of ['frida_device_spawn_sync', 'frida_device_attach_sync',
  'frida_session_create_script_sync', 'frida_script_load_sync', 'frida_device_resume_sync'])
  assert.ok(nativeText.includes(token), 'Spawn/Attach path must include ' + token);
const spawnAt = nativeText.indexOf('frida_device_spawn_sync');
const attachAt = nativeText.indexOf('frida_device_attach_sync');
const createScriptAt = nativeText.indexOf('frida_session_create_script_sync');
const loadScriptAt = nativeText.indexOf('frida_script_load_sync');
const resumeAfterLoadAt = nativeText.lastIndexOf('frida_device_resume_sync');
assert.ok(spawnAt < attachAt && attachAt < createScriptAt && createScriptAt < loadScriptAt && loadScriptAt < resumeAfterLoadAt,
  'Spawn/Attach/Script load/Resume order must remain intact');
assert.ok(!nativeText.includes('lifecycleQueue') && !nativeText.includes('requestAgentDisposeForScript'),
  'do not reintroduce the lifecycle rewrite that was present in the previous broken build');
assert.match(nativeText, /FRIDA\.SPAWN\.SUCCESS/);
assert.match(nativeText, /FRIDA\.ATTACH\.SUCCESS/);
assert.match(nativeText, /FRIDA\.HOOK\.SCRIPT_READY/);
assert.deepEqual(bundle, agent, 'embedded and source agents must be byte-for-byte identical');
assert.match(source, /AUTOPICK_AGENT_VERSION\s*=\s*'6\.6\.7'/);
assert.match(plist, /<key>CFBundleShortVersionString<\/key>\s*<string>6\.6\.7<\/string>/);
assert.match(plist, /<key>CFBundleVersion<\/key>\s*<string>76<\/string>/);
assert.match(source, /MEM_BUFFER_TOTAL_MAX_CODE_UNITS/);
assert.match(source, /bufferLooksComplete/);
assert.match(source, /stopDispatch = false/);
for (const file of ['Sources/TestViewController.m', 'Sources/APFMenu.m']) {
  const ui = fs.readFileSync(path.join(root, file), 'utf8');
  assert.ok(ui.includes('AutoPick Pro v6.6.7'), file + ' must show v6.6.7');
  assert.ok(!ui.includes('AutoPick Pro v6.6.6'), file + ' must not show old v6.6.6 title');
}
console.log('PASS rebase-integrity: v6.6.4 native Spawn/Attach baseline, v6.6.7 agent parity and metadata');
