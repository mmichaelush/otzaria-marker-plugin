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

const failing = (code, extra = {}) => ({
  call: async () => ({
    success: false,
    data: null,
    error: Object.assign({ schemaVersion: 1, code, message: code, retryable: false, category: 'internal' }, extra)
  })
});

test('call exposes the structured SDK failure', async () => {
  const runtime = loadRuntime(failing('reader.busy', { category: 'transient', retryable: true, message: 'Busy' }));
  await assert.rejects(runtime.call('reader.open', {}), error => {
    assert.equal(error.name, 'MarkerSdkError');
    assert.equal(error.method, 'reader.open');
    assert.equal(error.code, 'reader.busy');
    assert.equal(error.category, 'transient');
    assert.equal(error.retryable, true);
    assert.equal(error.hostMessage, 'Busy');
    return true;
  });
});

test('a missing SDK is reported as unavailable rather than a TypeError', async () => {
  const runtime = loadRuntime(undefined);
  await assert.rejects(runtime.call('app.getInfo'), error => {
    assert.equal(error.code, 'error.unavailable');
    assert.equal(error.isUnsupported, true);
    return true;
  });
});

test('isUnsupported distinguishes a missing capability from a real failure', async () => {
  const soft = ['error.unknown_method', 'error.unavailable', 'error.unsupported_context', 'permission_denied'];
  for (const code of soft) {
    const runtime = loadRuntime(failing(code));
    await runtime.call('x').catch(error => assert.equal(error.isUnsupported, true, code));
  }
  const runtime = loadRuntime(failing('error.internal'));
  await runtime.call('x').catch(error => assert.equal(error.isUnsupported, false));
});

test('callSoft swallows the failure and returns the fallback', async () => {
  const runtime = loadRuntime(failing('error.unknown_method'));
  assert.equal(await runtime.callSoft('reader.addToolbarItem', {}), null);
  assert.deepEqual(await runtime.callSoft('storage.list', {}, []), []);
});

test('callSoft returns the data when the call succeeds', async () => {
  const runtime = loadRuntime({ call: async () => ({ success: true, data: 42, error: null }) });
  assert.equal(await runtime.callSoft('anything'), 42);
});

test('notify.confirm reads the host dialog result and defaults to no', async () => {
  const yes = loadRuntime({ call: async () => ({ success: true, data: { confirmed: true }, error: null }) });
  assert.equal(await yes.notify.confirm('כותרת', 'תוכן'), true);

  const no = loadRuntime({ call: async () => ({ success: true, data: { confirmed: false }, error: null }) });
  assert.equal(await no.notify.confirm('כותרת', 'תוכן'), false);

  const broken = loadRuntime(failing('error.internal'));
  assert.equal(await broken.notify.confirm('כותרת', 'תוכן'), false);
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
  assert.equal(errors[0][1].message, 'sync boom');
});

test('on registers a protected handler and returns an unsubscribe', async () => {
  const handlers = new Map();
  const runtime = loadRuntime({
    call: async () => ({ success: true, data: null }),
    on: (event, handler) => handlers.set(event, handler),
    off: event => handlers.delete(event)
  });
  const off = runtime.on('plugin.boot', () => {});
  assert.equal(handlers.has('plugin.boot'), true);
  off();
  assert.equal(handlers.has('plugin.boot'), false);
});

test('createQueue runs tasks strictly one after another', async () => {
  const runtime = loadRuntime({ call: async () => ({ success: true, data: null }) });
  const enqueue = runtime.createQueue();
  const order = [];
  const task = (name, delay) => () => new Promise(resolve => setTimeout(() => {
    order.push(name);
    resolve(name);
  }, delay));

  const results = await Promise.all([
    enqueue(task('slow', 20)),
    enqueue(task('fast', 1)),
    enqueue(task('last', 1))
  ]);
  assert.deepEqual(order, ['slow', 'fast', 'last']);
  assert.deepEqual(results, ['slow', 'fast', 'last']);
});

test('a rejected task does not stall the queue', async () => {
  const runtime = loadRuntime({ call: async () => ({ success: true, data: null }) });
  const enqueue = runtime.createQueue();
  const failed = enqueue(async () => { throw new Error('nope'); });
  await assert.rejects(failed);
  assert.equal(await enqueue(async () => 'still running'), 'still running');
});
