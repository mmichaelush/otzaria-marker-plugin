const assert = require('node:assert/strict');
const test = require('node:test');

const { createWorld, selection } = require('./helpers/harness.js');

/**
 * The deployment as it actually runs: one Otzaria, the plugin loaded twice.
 *
 * `background.html` outlives every reading session; `index.html` shows and
 * edits. They share storage and nothing else — the host keeps their highlight
 * records apart and gives them no way to call each other.
 *
 * **Both of them draw, and that is the point.** `getAllHighlights`
 * de-duplicates on `(ownerPluginId, highlightId)`, so a mark held by both is
 * painted once, and the copy owned by the instance the user can see wins.
 * Electing a single owner instead produced the worst bug this plugin has had:
 * whenever the guess was wrong — the engine shut down after three idle
 * minutes, the permission was refused, the click was routed elsewhere —
 * *nothing* was painted, and nothing said why.
 */

const plain = value => JSON.parse(JSON.stringify(value));

/** Otzaria erases the records of an instance that goes away, and nothing else. */
function closeInstance(world, instanceId) {
  for (const [key, record] of world.world.hostHighlights) {
    if (record.ownerInstanceId === instanceId) world.world.hostHighlights.delete(key);
  }
}

test('a mark is painted once, no matter how many instances hold it', async t => {
  const world = createWorld();
  t.after(world.dispose);
  await world.boot();

  await world.engine.emit('contextMenu.colorClicked', {
    colorId: 'mark-green', selection: selection()
  });
  await world.settle();

  assert.equal(world.drawn().size, 1, 'the reader shows one mark');
  assert.equal(world.engine.ownRecords().length, 1);
  // The page holds none of its own. It cannot: Otzaria freezes a plugin tab
  // whenever the user is in the book, and a frozen instance that holds drawn
  // records can neither update nor release them — which is exactly how hiding
  // a book came to work on some marks and not others.
  assert.equal(world.page.ownRecords().length, 0, 'the page leaves the drawing to the engine');
});

test('a click the engine never saw is still painted by the page', async t => {
  // Without `app.background_keep_alive` Otzaria shuts the engine down after
  // three idle minutes, and the host then routes the click to the open plugin
  // tab. This is the report: the mark was stored, listed, and never drawn,
  // until the app was restarted.
  const world = createWorld();
  t.after(world.dispose);
  await world.boot();

  await world.page.emit('contextMenu.colorClicked', {
    colorId: 'mark-green', selection: selection()
  });

  assert.equal(world.drawn().size, 1, 'the mark has to reach the book');
  assert.equal(world.page.ownRecords().length, 1);
});

test('closing the page leaves the engine’s copy on the book', async t => {
  const world = createWorld();
  t.after(world.dispose);
  await world.boot();
  await world.engine.emit('contextMenu.colorClicked', {
    colorId: 'mark-green', selection: selection()
  });
  await world.settle();
  assert.equal(world.drawn().size, 1);

  closeInstance(world, 'foreground');
  assert.equal(world.drawn().size, 1, 'the engine still holds it');
});

test('a colour clicked right after the page changed the palette still marks', async t => {
  const world = createWorld();
  t.after(world.dispose);
  await world.boot();

  await world.page.core.saveSettings(Object.assign({}, world.page.core.settings, {
    colors: [
      ...world.page.core.settings.colors,
      { id: 'teal', hex: '#2E8B8B', label: 'טורקיז', enabled: true }
    ]
  }));
  await world.settle();

  await world.engine.emit('contextMenu.colorClicked', {
    colorId: 'mark-teal', selection: selection()
  });

  assert.equal(world.engine.core.getHighlights().length, 1,
    'the engine did not know the colour the page had just added');
  assert.equal(world.drawn().size, 1, 'and nothing was drawn');
});

test('a colour renamed in the page reaches the menu the engine registered', async t => {
  const world = createWorld();
  t.after(world.dispose);
  await world.boot();

  await world.page.core.saveSettings(Object.assign({}, world.page.core.settings, {
    colors: world.page.core.settings.colors.map(color =>
      color.id === 'yellow' ? { ...color, label: 'דגש' } : color)
  }));
  await world.settle();

  const row = world.world.contextMenu.get('marker-colors');
  assert.equal(plain(row.colors).find(entry => entry.id === 'mark-yellow').label, 'דגש');
});

test('an instance that never drew a mark still scrolls to its exact line', async t => {
  // `reader.revealHighlight` is looked up under `(pluginId, instanceId)`, so an
  // instance without its own copy cannot use it — and `openBookAtRef` lands on
  // the *chapter*. `scrollToSection` is what gets to the line.
  const world = createWorld();
  t.after(world.dispose);
  await world.boot();
  await world.engine.emit('contextMenu.colorClicked', {
    colorId: 'mark-green', selection: selection()
  });
  await world.settle();
  const item = world.page.core.getHighlights()[0];
  closeInstance(world, 'foreground');

  await world.page.core.revealHighlight(item);

  const scrolls = world.page.callsTo('reader.scrollToSection');
  assert.equal(scrolls.length, 1, 'the line is the precision the user asked for');
  assert.equal(scrolls[0].payload.sectionIndex, item.sectionIndex);
  // Never the host's own section highlight. It is not a flash — it washes the
  // whole navigation target in yellow and leaves it there, which at chapter
  // level buries the very mark the user was navigating to. `false` also clears
  // one already painted, so a reveal now cleans up after an older build.
  assert.equal(scrolls[0].payload.highlight, false);
  for (const call of world.page.callsTo('reader.openBookAtRef')) {
    assert.equal(call.payload.highlight, false);
  }
});

test('an edit in the page reaches the book, and a deletion takes it off', async t => {
  const world = createWorld();
  t.after(world.dispose);
  await world.boot();
  await world.engine.emit('contextMenu.colorClicked', {
    colorId: 'mark-green', selection: selection()
  });
  await world.settle();

  const item = world.page.core.getHighlights()[0];
  await world.page.core.updateHighlight(item, {
    color: { id: 'red', hex: '#F37E75', label: 'אדום' }
  });
  await world.settle();
  assert.equal(world.drawn().size, 1, 'still one mark, not two');
  for (const record of world.world.hostHighlights.values()) {
    assert.equal(record.style.backgroundColor, '#F37E75', 'both copies follow the new colour');
  }

  await world.page.core.deleteHighlights([world.page.core.getHighlights()[0]]);
  await world.settle();
  assert.equal(world.drawn().size, 0, 'a deletion in the page clears every copy');
});

test('a mark made in the book shows up in the open page', async t => {
  const world = createWorld();
  t.after(world.dispose);
  await world.boot();

  await world.engine.emit('contextMenu.colorClicked', {
    colorId: 'mark-green', selection: selection()
  });
  assert.equal(world.page.core.getHighlights().length, 0, 'not until it syncs');

  await world.settle();
  assert.equal(world.page.core.getHighlights().length, 1);
});

test('the eraser follows the selection even though only the page is told about it', async t => {
  // `reader.selection_changed` is a broadcast, and the host gives a broadcast
  // to the live foreground instance — the engine is not told at all while the
  // plugin tab is open.
  const world = createWorld();
  t.after(world.dispose);
  await world.boot();
  const hasEraser = () => world.world.contextMenu.get('marker-colors')
    .colors.some(entry => entry.id === 'mark-clear');
  const settleSelection = () => new Promise(resolve => setTimeout(resolve, 220));

  await world.engine.emit('contextMenu.colorClicked', {
    colorId: 'mark-green', selection: selection()
  });
  await world.settle();

  await world.page.emit('reader.selection_changed', readerSelectionEvent());
  await settleSelection();
  assert.equal(hasEraser(), true);

  await world.page.emit('reader.selection_changed', readerSelectionEvent({ currentIndex: 99 }));
  await settleSelection();
  assert.equal(hasEraser(), false);
});

/**
 * The real `reader.selection_changed` payload, which is **not** the one the
 * context menu delivers: it carries the text and the location, and no anchor
 * at all. Anything that reasons about ranges here finds nothing to reason
 * about — which is exactly why the eraser never appeared.
 */
function readerSelectionEvent(overrides = {}) {
  return Object.assign({
    text: 'ויאמר אלהים יהי אור',
    currentRef: 'בראשית פרק א',
    currentBook: 'בראשית',
    currentBookId: 'בראשית',
    currentIndex: 4,
    id: 183,
    type: 'text',
    source: 'library'
  }, overrides);
}

test('hiding a book takes off marks made in an earlier session, not just new ones', async t => {
  // The report: the toolbar button hid and restored only the marks made in
  // this session, never the older ones.
  //
  // `reader.clearAllHighlights` is scoped to the calling instance. The click
  // goes to the engine (`preferBackground: true`), so the engine cleared its
  // own copies — and the page, which had drawn the whole store at boot and was
  // then frozen by `controller.pause()` the moment the user went back to the
  // book, kept holding its own. Those stayed on the page.
  //
  // A mark made during that same session was held by the engine alone, because
  // the page had been frozen since before it existed. Hence "only the new ones
  // hide", and the same for restoring them.
  const world = createWorld({
    highlights: [{
      highlightId: 'marker-old', bookId: 'בראשית', book: 'בראשית', sectionIndex: 2,
      colorId: 'yellow', color: '#F1E784', text: 'ישן', ref: '', tags: [], note: '',
      sourceRange: { start: { utf16: 0 }, end: { utf16: 5 } }, timestamp: 1
    }]
  });
  t.after(world.dispose);
  await world.boot();
  assert.equal(world.drawn().size, 1, 'the old mark is on the page');

  // A fresh one alongside it, which is the half that always worked.
  await world.engine.emit('contextMenu.colorClicked', {
    colorId: 'mark-green', selection: selection()
  });
  await world.settle();
  assert.equal(world.drawn().size, 2);

  // The page is frozen from here on: no polling, no reconcile, no cleanup.
  await world.engine.emit('reader.toolbar_item_clicked', {
    itemId: 'marker-toolbar', context: 'reader-text', currentBookId: 'בראשית'
  });

  assert.equal(world.drawn().size, 0,
    'both marks go, without the page having to do anything');

  await world.engine.emit('reader.toolbar_item_clicked', {
    itemId: 'marker-toolbar', context: 'reader-text', currentBookId: 'בראשית'
  });
  assert.equal(world.drawn().size, 2, 'and both come back');
});

test('a page hands its drawn marks back when it wakes up', async t => {
  // A page still draws what it marks itself — a click reaching it is proof no
  // engine took it. That copy is the one that would go stale the next time the
  // tab is frozen, so it goes back at the first moment the page is running and
  // the engine has caught up.
  const world = createWorld();
  t.after(world.dispose);
  await world.boot();

  await world.page.emit('contextMenu.colorClicked', {
    colorId: 'mark-green', selection: selection()
  });
  assert.equal(world.page.ownRecords().length, 1, 'the page painted its own click');

  await world.settle();
  assert.equal(world.engine.ownRecords().length, 1, 'the engine has it now');

  await world.page.emit('plugin.resumed', {});
  assert.equal(world.page.ownRecords().length, 0, 'so the page lets go');
  assert.equal(world.drawn().size, 1, 'and the mark is still on the page');
});
