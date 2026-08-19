const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

function loadRuntime(otzaria) {
  const context = { console, Otzaria: otzaria, globalThis: {} };
  context.globalThis = context;
  const source = fs.readFileSync(path.join(__dirname, '..', 'js', 'marker-runtime.js'), 'utf8');
  vm.runInNewContext(source, context, { filename: 'marker-runtime.js' });
  return context.MarkerRuntime;
}

test('call exposes structured SDK failures', async () => {
  const runtime = loadRuntime({ call: async () => ({ success: false, error: { code: 'reader.busy', category: 'transient', retryable: true, message: 'Busy' } }) });
  await assert.rejects(runtime.call('reader.open', {}), error => {
    assert.equal(error.name, 'MarkerSdkError');
    assert.equal(error.code, 'reader.busy');
    assert.equal(error.category, 'transient');
    assert.equal(error.retryable, true);
    return true;
  });
});

test('protectEvent contains asynchronous handler failures', async () => {
  const runtime = loadRuntime({ call: async () => ({ success: true, data: null }) });
  const errors = [];
  const logger = { error: (...args) => errors.push(args) };
  const callback = runtime.protectEvent('reader.selection_changed', async () => { throw new Error('boom'); }, logger);
  await callback({});
  assert.equal(errors.length, 1);
  assert.equal(errors[0][0], 'Event failed: reader.selection_changed');
  assert.equal(errors[0][1].message, 'boom');
});

test('protectEvent contains synchronous handler failures', async () => {
  const runtime = loadRuntime({ call: async () => ({ success: true, data: null }) });
  const errors = [];
  const logger = { error: (...args) => errors.push(args) };
  const callback = runtime.protectEvent('theme.changed', () => { throw new Error('sync boom'); }, logger);
  await callback({});
  assert.equal(errors.length, 1);
  assert.equal(errors[0][0], 'Event failed: theme.changed');
  assert.equal(errors[0][1].message, 'sync boom');
});
