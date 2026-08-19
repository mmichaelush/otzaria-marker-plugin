const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const scripts = ['marker-domain.js', 'marker-runtime.js', 'app.js'];

function createBackgroundHarness(storedSettings = null) {
  const handlers = new Map();
  const calls = [];
  const selection = {
    currentBookId: 'book-1',
    currentIndex: 0,
    renderedSelectedText: 'טקסט מסומן',
    sourceRange: { start: { utf16: 0 }, end: { utf16: 10 } }
  };
  const window = {
    setTimeout: () => 1,
    clearTimeout: () => {}
  };
  const Otzaria = {
    on: (eventName, handler) => handlers.set(eventName, handler),
    call: async (method, payload) => {
      calls.push({ method, payload });
      let data = true;
      if (method === 'storage.list') data = [];
      if (method === 'storage.get') data = payload.key === 'marker_settings' ? storedSettings : null;
      if (method === 'reader.getHighlights') data = [];
      if (method === 'reader.getSelection') data = null;
      return { success: true, data };
    }
  };
  const context = {
    console,
    Otzaria,
    window,
    setTimeout: window.setTimeout,
    clearTimeout: window.clearTimeout,
    crypto: undefined,
    globalThis: {}
  };
  context.globalThis = context;
  for (const script of scripts) {
    const source = fs.readFileSync(path.join(__dirname, '..', 'js', script), 'utf8');
    vm.runInNewContext(source, context, { filename: script });
  }
  return { handlers, calls, selection };
}

async function registerMenu(harness) {
  await harness.handlers.get('plugin.boot')({ app: { runMode: 'background' }, permissions: [] });
  await harness.handlers.get('reader.selection_changed')(harness.selection);
  return harness.calls.filter(call => call.method === 'reader.addContextMenuItem');
}

test('color-row menu is registered as one Marker root item', async () => {
  const registrations = await registerMenu(createBackgroundHarness());

  assert.equal(registrations.length, 1);
  assert.equal(registrations[0].payload.id, 'marker-root');
  assert.equal(registrations[0].payload.title, 'מרקר');
  assert.deepEqual(
    [...registrations[0].payload.contexts],
    ['reader-selection', 'reader-page-shape-selection']
  );
  assert.equal(registrations[0].payload.type, 'color-row');
  assert.ok(registrations[0].payload.colors.length > 0);
  assert.equal(registrations.some(call => call.payload.id === 'marker-page-shape'), false);
});

test('submenu mode uses one named menu for both reader contexts', async () => {
  const registrations = await registerMenu(createBackgroundHarness({ menuStyle: 'submenu' }));

  assert.equal(registrations.length, 1);
  assert.equal(registrations[0].payload.id, 'marker-root');
  assert.equal(registrations[0].payload.type, 'submenu');
  assert.equal(registrations[0].payload.title, 'מרקר');
  assert.ok(registrations[0].payload.children.length > 0);
});
