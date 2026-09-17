const assert = require('node:assert/strict');
const test = require('node:test');

const { createWindows, selection } = require('./helpers/harness.js');

/**
 * Two Otzaria windows on one profile.
 *
 * Otzaria opens a window as its own process (`main` → `secondaryWindowMain`),
 * so each one has its own `PluginHighlightRegistry`, its own
 * `ContextMenuRegistry` and its own background engine. **Nothing is shared
 * except the plugin's key-value store**, a SQLite file on disk — which is
 * exactly what the revision token rides on, and the reason the same design
 * that makes two instances agree makes four agree.
 *
 * The thing that would break here is any assumption that one instance draws
 * for everyone: a record drawn in one window's registry does not exist in the
 * other's, so every window has to draw for itself.
 */

const plain = value => JSON.parse(JSON.stringify(value));

/** The marks the reader paints in one window. */
const drawnIn = window => window.drawn();

test('a mark made in one window appears in the other', async t => {
  const app = createWindows(2);
  t.after(app.dispose);
  await app.boot();
  const [first, second] = app.windows;

  await first.engine.emit('contextMenu.colorClicked', {
    colorId: 'mark-green', selection: selection()
  });
  assert.equal(drawnIn(second).size, 0, 'not before the other window looks');

  await app.settle();

  assert.equal(drawnIn(first).size, 1);
  assert.equal(drawnIn(second).size, 1, 'the second window paints its own copy');
  assert.equal(second.page.core.getHighlights().length, 1);
});

test('each window draws into its own registry, never the other’s', async t => {
  // `PluginHighlightRegistry.instance` is a singleton per isolate, and a
  // window is a process. A design where only one instance draws would leave
  // every other window blank.
  const app = createWindows(2);
  t.after(app.dispose);
  await app.boot();
  const [first, second] = app.windows;
  await first.engine.emit('contextMenu.colorClicked', {
    colorId: 'mark-green', selection: selection()
  });
  await app.settle();

  assert.equal(first.world.hostHighlights.size, 2, 'engine and page of window one');
  assert.equal(second.world.hostHighlights.size, 2, 'and of window two');
  for (const record of second.world.hostHighlights.values()) {
    assert.equal(record.highlightId, first.engine.ownRecords()[0].highlightId,
      'the same mark, drawn independently');
  }
});

test('deleting in one window takes the mark off the other', async t => {
  const app = createWindows(2);
  t.after(app.dispose);
  await app.boot();
  const [first, second] = app.windows;
  await first.engine.emit('contextMenu.colorClicked', {
    colorId: 'mark-green', selection: selection()
  });
  await app.settle();
  assert.equal(drawnIn(second).size, 1);

  await second.page.core.deleteHighlights([second.page.core.getHighlights()[0]]);
  await app.settle();

  assert.equal(drawnIn(second).size, 0, 'the window that deleted it');
  assert.equal(drawnIn(first).size, 0, 'and the one that did not');
  assert.equal(first.page.core.getHighlights().length, 0);
});

test('a colour changed in one window repaints the mark in both', async t => {
  const app = createWindows(2);
  t.after(app.dispose);
  await app.boot();
  const [first, second] = app.windows;
  await first.engine.emit('contextMenu.colorClicked', {
    colorId: 'mark-green', selection: selection()
  });
  await app.settle();

  const item = second.page.core.getHighlights()[0];
  await second.page.core.updateHighlight(item, {
    color: { id: 'red', hex: '#F37E75', label: 'אדום' }
  });
  await app.settle();

  for (const window of app.windows) {
    for (const record of window.world.hostHighlights.values()) {
      assert.equal(record.style.backgroundColor, '#F37E75');
    }
  }
});

test('a palette edited in one window reaches the other window’s menu', async t => {
  const app = createWindows(2);
  t.after(app.dispose);
  await app.boot();
  const [first, second] = app.windows;

  await first.page.core.saveSettings(Object.assign({}, first.page.core.settings, {
    colors: first.page.core.settings.colors.map(color =>
      color.id === 'yellow' ? { ...color, label: 'דגש' } : color)
  }));
  await app.settle();

  const row = second.world.contextMenu.get('marker-colors');
  assert.equal(plain(row.colors).find(entry => entry.id === 'mark-yellow').label, 'דגש');
});

test('hiding a book hides it in every window, and marking there brings it back', async t => {
  const app = createWindows(2);
  t.after(app.dispose);
  await app.boot();
  const [first, second] = app.windows;
  await first.engine.emit('contextMenu.colorClicked', {
    colorId: 'mark-green', selection: selection()
  });
  await app.settle();

  await first.engine.emit('reader.toolbar_item_clicked', {
    itemId: 'marker-toolbar', context: 'reader-text', currentBookId: 'בראשית'
  });
  await app.settle();
  assert.equal(drawnIn(first).size, 0);
  assert.equal(drawnIn(second).size, 0, 'the book is hidden, not the window');

  // Marking in the hidden book is the clearest request to see marks again.
  // A different line, or it would simply replace the mark already there.
  await second.engine.emit('contextMenu.colorClicked', {
    colorId: 'mark-blue', selection: selection({ sectionIndex: 9, currentIndex: 9 })
  });
  await app.settle();
  assert.deepEqual(plain(second.engine.core.mutedBooks), []);
  assert.equal(drawnIn(second).size, 2);
  assert.equal(drawnIn(first).size, 2, 'and the first window follows');
});

test('closing a window leaves every other window untouched', async t => {
  const app = createWindows(2);
  t.after(app.dispose);
  await app.boot();
  const [first, second] = app.windows;
  await first.engine.emit('contextMenu.colorClicked', {
    colorId: 'mark-green', selection: selection()
  });
  await app.settle();

  // Otzaria tears the window's registries down with the process.
  first.world.hostHighlights.clear();
  first.world.contextMenu.clear();

  assert.equal(drawnIn(second).size, 1, 'the surviving window keeps its marks');
  await second.page.core.reconcileHighlights();
  assert.equal(drawnIn(second).size, 1, 'and does not mistake them for orphans');
});

test('two windows marking at once keep both marks', async t => {
  // Both write the change token; neither may conclude from its own token that
  // nothing happened elsewhere.
  const app = createWindows(2);
  t.after(app.dispose);
  await app.boot();
  const [first, second] = app.windows;

  await first.engine.emit('contextMenu.colorClicked', {
    colorId: 'mark-green', selection: selection()
  });
  await second.engine.emit('contextMenu.colorClicked', {
    colorId: 'mark-blue', selection: selection({ sectionIndex: 9, currentIndex: 9 })
  });
  await app.settle();
  await app.settle();

  assert.equal(first.page.core.getHighlights().length, 2);
  assert.equal(second.page.core.getHighlights().length, 2);
  assert.equal(drawnIn(first).size, 2);
  assert.equal(drawnIn(second).size, 2);
});

test('a reconcile in one window never clears another window’s records', async t => {
  // The orphan sweep removes what this instance drew and no longer has stored.
  // Reaching past that — to a record belonging to another window — would wipe
  // the marks of a window the user is actively reading in.
  const app = createWindows(2);
  t.after(app.dispose);
  await app.boot();
  const [first, second] = app.windows;
  await first.engine.emit('contextMenu.colorClicked', {
    colorId: 'mark-green', selection: selection()
  });
  await app.settle();

  // Window one loses its storage view entirely — the harshest case there is.
  for (const key of [...first.world.storage.keys()]) {
    if (key.startsWith('highlight:')) first.world.storage.delete(key);
  }
  await first.engine.core.loadHighlights();
  await first.engine.core.reconcileHighlights();

  assert.equal(drawnIn(second).size, 1, 'window two is untouched');
  assert.equal(second.page.core.getHighlights().length, 1);
});

test('turning the toolbar icon off reaches every window’s own gate', async t => {
  // `when: { storage: … }` is evaluated from `PluginConditionEvaluator`, an
  // in-memory snapshot per isolate that only the writing window refreshes. A
  // window that learned about the change from the shared store has to write
  // the value it just read, or its toolbar keeps the icon until a restart.
  const app = createWindows(2);
  t.after(app.dispose);
  await app.boot();
  const [first, second] = app.windows;
  const writesIn = window => window.page.callsTo('storage.set')
    .concat(window.engine.callsTo('storage.set'))
    .filter(call => call.payload.key === 'marker_toolbar_button');
  const before = writesIn(second).length;

  await first.page.core.saveSettings(Object.assign({}, first.page.core.settings, {
    toolbarButton: false
  }));
  await app.settle();

  assert.equal(app.storage.get('marker_toolbar_button'), false);
  const after = writesIn(second);
  assert.ok(after.length > before, 'the second window must refresh its own gate');
  assert.equal(after.at(-1).payload.value, false);
});

test('an unchanged toolbar flag is not rewritten on every sync', async t => {
  // Two windows rewriting each other's value on every poll would be a loop.
  const app = createWindows(2);
  t.after(app.dispose);
  await app.boot();
  const [first, second] = app.windows;
  const writes = () => [...app.windows].reduce((total, window) =>
    total + window.page.callsTo('storage.set')
      .concat(window.engine.callsTo('storage.set'))
      .filter(call => call.payload.key === 'marker_toolbar_button').length, 0);

  await first.engine.emit('contextMenu.colorClicked', {
    colorId: 'mark-green', selection: selection()
  });
  const settled = writes();
  await app.settle();
  await app.settle();
  await app.settle();

  assert.equal(writes(), settled, 'nothing changed, so nothing is written');
  assert.ok(second.world.toolbar.has('marker-toolbar'));
});
