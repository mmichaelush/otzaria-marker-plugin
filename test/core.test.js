const assert = require('node:assert/strict');
const test = require('node:test');

const { createHost, selection, multiSectionSelection } = require('./helpers/harness.js');

/**
 * Objects built inside the sandbox carry that realm's prototypes, so
 * `deepEqual` would compare identities rather than values. A JSON round trip
 * brings them back into this realm.
 */
const plain = value => JSON.parse(JSON.stringify(value));

/** The remove action now lives inside the highlight-actions submenu. */
const removeTitle = host => host.contextMenu.get('marker-highlight-actions')
  .children.find(child => child.id === 'marker-remove').title;

/**
 * A foreground page on an install where the background permission is off.
 *
 * With no background engine to defer to, the page owns the highlights — the
 * plugin's fallback behaviour, and the shape most of these tests exercise
 * because it is the one where a single instance both handles clicks and draws.
 */
const PAGE_BOOT = { app: { runMode: 'foreground', version: '0.9.97' }, permissions: [] };

/** The real deployment: a headless instance Otzaria keeps alive. */
const BACKGROUND_BOOT = {
  app: { runMode: 'background', version: '0.9.97' },
  permissions: ['app.run_on_startup', 'app.background_keep_alive']
};

/** A page opened while that background engine is running. */
const VIEWER_BOOT = {
  app: { runMode: 'foreground', version: '0.9.97' },
  permissions: ['app.run_on_startup', 'app.background_keep_alive']
};

async function bootEngine(options = {}) {
  const host = createHost(options);
  await host.emit('plugin.boot', options.boot || PAGE_BOOT);
  return host;
}

// ── Contributions ───────────────────────────────────────────────────────────

test('boot patches the declarative menu instead of registering a second item', async t => {
  const host = await bootEngine();
  t.after(host.dispose);

  assert.equal(host.callsTo('reader.addContextMenuItem').length, 0);
  const patches = host.callsTo('reader.updateContextMenuItem');
  assert.deepEqual(plain(patches.map(call => call.payload.id)).sort(),
    ['marker-colors', 'marker-highlight-actions']);
  assert.equal(host.contextMenu.size, 2);
});

test('the patched color row carries the user colors, not the manifest defaults', async t => {
  const host = await bootEngine({
    settings: {
      colors: [
        { id: 'sea', hex: '#123456', label: 'ים', enabled: true },
        { id: 'off', hex: '#654321', label: 'כבוי', enabled: false }
      ],
      defaultColorId: 'sea'
    }
  });
  t.after(host.dispose);

  const row = host.contextMenu.get('marker-colors');
  assert.equal(row.type, 'color-row');
  // No `selected`: the host paints it as a thick ring in the primary colour,
  // which users read as a glitch rather than as "your default".
  const swatches = plain(row.colors).map(({ id, color, label }) => ({ id, color, label }));
  assert.deepEqual(swatches, [
    { id: 'mark-sea', color: '#123456', label: 'ים' },
    { id: 'mark-clear', color: '#00000000', label: 'נקה סימון' }
  ]);
  assert.equal(plain(row.colors).every(entry => entry.selected === undefined), true);
});

test('the eraser closes the row, so removing needs no second menu', async t => {
  // The reader-highlight context only exists on a right-click that lands on a
  // mark with no selection, which is not the state the user is in right after
  // marking. Without this swatch, removing is effectively undiscoverable.
  const host = await bootEngine();
  t.after(host.dispose);

  const row = host.contextMenu.get('marker-colors');
  const eraser = row.colors.at(-1);
  assert.equal(eraser.id, 'mark-clear');
  assert.equal(eraser.icon, 'eraser_24_regular');
  assert.equal(eraser.color, '#00000000', 'an opaque value would paint a black swatch');
});

/** The eraser rule only engages where selections can actually be watched. */
const WATCHES_SELECTION = {
  app: { runMode: 'foreground', version: '0.9.97' },
  permissions: ['events.subscribe:reader.selection_changed']
};

const hasEraser = host => host.contextMenu.get('marker-colors')
  .colors.some(entry => entry.id === 'mark-clear');

/** The debounce is 120ms; this outlasts it without being a slow test. */
const afterSelection = () => new Promise(resolve => setTimeout(resolve, 220));

test('the eraser appears only over text that already carries a mark', async t => {
  const host = await bootEngine({ boot: WATCHES_SELECTION });
  t.after(host.dispose);

  // Nothing has been selected yet, so nothing can be erased.
  assert.equal(hasEraser(host), false);

  // Selecting clean text keeps it away.
  await host.emit('reader.selection_changed', selection());
  await afterSelection();
  assert.equal(hasEraser(host), false);

  // Marking that same text and selecting it again brings the swatch in.
  await host.emit('contextMenu.colorClicked', { colorId: 'mark-green', selection: selection() });
  await host.emit('reader.selection_changed', selection());
  await afterSelection();
  assert.equal(hasEraser(host), true);

  // …and it has to leave again. This is the half that was broken: the state
  // stuck on until the plugin was restarted.
  await host.emit('contextMenu.colorClicked', { colorId: 'mark-clear', selection: selection() });
  await host.emit('reader.selection_changed', selection());
  await afterSelection();
  assert.equal(hasEraser(host), false);
});

test('a viewer keeps the eraser in step, because the engine never sees a selection', async t => {
  // `reader.selection_changed` is a broadcast, and
  // `PluginRuntimeDispatcher._selectEventTargets` gives a broadcast to the
  // live foreground instances when there are any — the background engine gets
  // it only when no tab is open. Gating this on `isEngine` meant that with the
  // plugin tab open nobody updated the menu at all.
  const host = createHost();
  t.after(host.dispose);
  await host.emit('plugin.boot', {
    app: { runMode: 'foreground', version: '0.9.97' },
    permissions: ['app.run_on_startup', 'events.subscribe:reader.selection_changed']
  });
  assert.equal(host.core.isEngine, false, 'this instance draws nothing');

  await host.emit('reader.selection_changed', selection());
  await afterSelection();
  assert.equal(hasEraser(host), false, 'a viewer may still patch the menu');
});

test('without the selection permission the eraser stays in the row for good', async t => {
  // Otherwise the rule would read as "never": nothing would ever report a
  // selection, and removing a mark over a selection would be unreachable.
  const host = await bootEngine();
  t.after(host.dispose);

  assert.equal(hasEraser(host), true);
  await host.emit('reader.selection_changed', selection());
  await afterSelection();
  assert.equal(hasEraser(host), true);
});

test('the eraser removes every mark the selection touches', async t => {
  const host = await bootEngine();
  t.after(host.dispose);
  await host.emit('contextMenu.colorClicked', { colorId: 'mark-green', selection: selection() });
  assert.equal(host.hostHighlights.size, 1);

  await host.emit('contextMenu.colorClicked', { colorId: 'mark-clear', selection: selection() });

  assert.equal(host.core.getHighlights().length, 0);
  assert.equal(host.hostHighlights.size, 0, 'the mark must leave the reader too');
});

test('the eraser over clean text says so instead of doing nothing', async t => {
  const host = await bootEngine();
  t.after(host.dispose);

  await host.emit('contextMenu.colorClicked', { colorId: 'mark-clear', selection: selection() });

  assert.equal(host.callsTo('reader.setHighlight').length, 0, 'it must never mark');
  assert.ok(host.callsTo('ui.showMessage').length > 0, 'silence reads as a dead menu item');
});

test('submenu mode replaces the color row with named children', async t => {
  const host = await bootEngine({ settings: { menuStyle: 'submenu' } });
  t.after(host.dispose);

  const item = host.contextMenu.get('marker-colors');
  assert.equal(item.type, 'submenu');
  assert.ok(item.children.length > 0);
  assert.ok(item.children.every(child => child.id.startsWith('mark-')));
});

test('the highlight actions sit in one submenu, inside the reader-highlight context', async t => {
  const host = await bootEngine();
  t.after(host.dispose);

  // A plugin gets two top-level entries and the colour row owns one, so both
  // highlight actions have to share the second.
  const item = host.contextMenu.get('marker-highlight-actions');
  assert.equal(item.type, 'submenu');
  assert.deepEqual(plain(item.contexts), ['reader-highlight']);
  assert.deepEqual(plain(item.children.map(child => child.id)),
    ['marker-note', 'marker-remove']);
  assert.equal(item.children[0].openPlugin, true, 'the note action opens the page');
});

test('a missing declarative registration falls back to a fresh add', async t => {
  const host = await bootEngine({ declarativeMenu: false });
  t.after(host.dispose);

  const added = host.callsTo('reader.addContextMenuItem').map(call => call.payload.id);
  assert.deepEqual(plain(added).sort(), ['marker-colors', 'marker-highlight-actions']);
  assert.equal(host.contextMenu.size, 2);
});

test('legacy menu ids from older plugin versions are cleaned up once', async t => {
  const host = await bootEngine();
  t.after(host.dispose);

  const removed = host.callsTo('reader.removeContextMenuItem').map(call => call.payload.id);
  assert.deepEqual(plain(removed), ['marker-root', 'marker-page-shape']);
});

test('an unchanged menu is not re-sent to the host', async t => {
  const host = await bootEngine();
  t.after(host.dispose);
  const before = host.callsTo('reader.updateContextMenuItem').length;

  await host.core.syncContributions();
  assert.equal(host.callsTo('reader.updateContextMenuItem').length, before);

  await host.core.syncContributions({ force: true });
  assert.ok(host.callsTo('reader.updateContextMenuItem').length > before);
});

test('the page patches the declared menu with the user colors', async t => {
  const host = createHost({ settings: { colors: [{ id: 'sea', hex: '#123456', label: 'ים', enabled: true }] } });
  t.after(host.dispose);
  await host.emit('plugin.boot', PAGE_BOOT);

  assert.equal(host.core.isEngine, true);
  // The declarative item lives at plugin level, so the patch outlives the
  // page and the menu stays correct for the rest of the session.
  assert.ok(host.callsTo('reader.updateContextMenuItem').length > 0);
  assert.equal(host.contextMenu.get('marker-colors').colors[0].label, 'ים');
});

// ── Who draws ───────────────────────────────────────────────────────────────

test('the background instance is the engine, because it outlives every tab', async t => {
  const host = createHost();
  t.after(host.dispose);
  await host.emit('plugin.boot', BACKGROUND_BOOT);

  assert.equal(host.core.isEngine, true);
});

test('a page draws the stored marks too, because a copy costs nothing', async t => {
  // `PluginHighlightRegistry.getAllHighlights` de-duplicates on
  // (ownerPluginId, highlightId), so the same mark held by the page and by the
  // engine is painted once. Refusing to draw here bought nothing and cost
  // everything: when no engine was alive, nothing was painted at all.
  const host = createHost({
    highlights: [{
      highlightId: 'marker-kept', bookId: 'בראשית', sectionIndex: 4, colorId: 'green',
      color: '#8BCF8D', text: 'טקסט', sourceRange: {
        type: 'text-range-v1', layer: 'source',
        start: { grapheme: 0, utf16: 0 }, end: { grapheme: 5, utf16: 5 }
      }
    }]
  });
  t.after(host.dispose);
  await host.emit('plugin.boot', VIEWER_BOOT);

  assert.equal(host.core.isEngine, false, 'it is still not the engine');
  assert.equal(host.core.getHighlights().length, 1);
  assert.equal(host.hostHighlights.size, 1, 'and it still puts them on the page');
});

test('a viewer edit reaches storage and bumps the counter for the engine', async t => {
  const host = createHost();
  t.after(host.dispose);
  await host.emit('plugin.boot', PAGE_BOOT);
  await host.emit('contextMenu.colorClicked', { colorId: 'mark-green', selection: selection() });
  const item = host.core.getHighlights()[0];

  const before = host.storage.get('marker_revision');
  await host.core.updateHighlight(item, { note: 'לחזור על זה' });

  assert.equal(host.storage.get(`highlight:${item.highlightId}`).note, 'לחזור על זה');
  assert.notEqual(host.storage.get('marker_revision'), before,
    'without the bump the other instance never learns the record changed');
});

test('granting the background permission does not take the marks off the page', async t => {
  // Ownership decides who *registers* contributions, never who draws. An
  // earlier version cleared this instance's copies here, which is how a
  // permission change could empty the book.
  const host = await bootEngine();
  t.after(host.dispose);
  await host.emit('contextMenu.colorClicked', { colorId: 'mark-green', selection: selection() });
  assert.equal(host.hostHighlights.size, 1);

  await host.emit('plugin.permissions_changed', {
    permissions: ['reader.highlight', 'app.run_on_startup']
  });

  assert.equal(host.core.isEngine, false);
  assert.equal(host.hostHighlights.size, 1, 'the marks stay on the page');
});

// ── Applying highlights ─────────────────────────────────────────────────────

test('a color click marks the selection and stores it', async t => {
  const host = await bootEngine();
  t.after(host.dispose);

  await host.emit('contextMenu.colorClicked', {
    itemId: 'marker-colors', colorId: 'mark-green', selection: selection()
  });

  assert.equal(host.hostHighlights.size, 1);
  const stored = [...host.storage.entries()].filter(([key]) => key.startsWith('highlight:'));
  assert.equal(stored.length, 1);
  const record = stored[0][1];
  assert.equal(record.colorId, 'green');
  assert.equal(record.bookId, 'בראשית');
  assert.equal(record.bookUid, 'id:183');
  assert.equal(record.sectionIndex, 4);
  assert.equal(record.version, 1);
  assert.equal(record.ref, 'בראשית פרק א');
});

// Regression: `metadata.source` is a closed set in the host
// (manual/ai/import/sync). The plugin sent `'marker'`, so the host rejected
// *every* highlight with `error.invalid_params: unsupported highlight source`
// and nothing was ever marked. The harness now enforces the same contract,
// which is what makes this test able to fail.
test('the highlight metadata matches the host contract', async t => {
  const host = await bootEngine();
  t.after(host.dispose);

  await host.emit('contextMenu.colorClicked', { colorId: 'mark-green', selection: selection() });

  const payload = host.callsTo('reader.setHighlight')[0].payload;
  assert.equal(payload.metadata.source, 'manual');
  assert.ok(host.domain.HIGHLIGHT_SOURCES.includes(payload.metadata.source));
  assert.ok(payload.metadata.tags.every(tag => tag && tag.length <= 64));
  assert.ok(payload.metadata.tags.length <= 20);
  assert.equal(host.hostHighlights.size, 1, 'the host must have accepted it');
});

test('the harness rejects a bad metadata source, as the host does', async t => {
  const host = await bootEngine();
  t.after(host.dispose);

  const response = await host.context.Otzaria.call('reader.setHighlight', {
    highlightId: 'marker-x', bookId: 'ב', sectionIndex: 0,
    range: { start: { utf16: 0 }, end: { utf16: 3 } },
    style: { backgroundColor: '#112233' },
    metadata: { source: 'marker' }
  });

  assert.equal(response.success, false);
  assert.equal(response.error.code, 'error.invalid_params');
  assert.match(response.error.message, /unsupported highlight source/);
});

test('a control character in a note never reaches the host', async t => {
  // The host rejects the whole call over one of these, so a mark would simply
  // fail to appear — the same failure class as the old bad metadata.source.
  const host = await bootEngine();
  t.after(host.dispose);
  await host.emit('contextMenu.colorClicked', { colorId: 'mark-green', selection: selection() });
  const item = host.core.getHighlights()[0];

  await host.core.updateHighlight(item, {
    note: 'שורה\u0007ראשונה\nשורה שנייה',
    tags: ['תג\u0000רגיל']
  });

  const payload = host.callsTo('reader.updateHighlight').at(-1).payload;
  assert.equal(payload.metadata.note.includes('\u0007'), false);
  assert.ok(payload.metadata.note.includes('\n'), 'a newline is legal and must survive');
  assert.ok(payload.metadata.tags.every(tag => !tag.includes('\u0000')));
  assert.equal(host.hostHighlights.size, 1, 'the host must have accepted it');
});

test('a control character in a color label never reaches the menu', async t => {
  const host = await bootEngine({
    settings: { colors: [{ id: 'x', hex: '#123456', label: 'צהוב\u0007בהיר', enabled: true }] }
  });
  t.after(host.dispose);

  assert.equal(host.contextMenu.get('marker-colors').colors[0].label.includes('\u0007'), false);
});

test('a very long color id still fits the host cap once prefixed', async t => {
  const longId = 'c'.repeat(120);
  const host = await bootEngine({
    settings: { colors: [{ id: longId, hex: '#123456', label: 'ארוך', enabled: true }] }
  });
  t.after(host.dispose);

  // 'mark-' + id must stay within 64, or the entire color row is rejected and
  // the user loses every color, not just this one.
  const entry = host.contextMenu.get('marker-colors').colors[0];
  assert.ok(entry.id.length <= 64, `menu id is ${entry.id.length} characters`);
  assert.equal(entry.id.startsWith('mark-'), true);
});

test('a highlight carries the stable book id when the host provides one', async t => {
  const host = await bootEngine();
  t.after(host.dispose);

  await host.emit('contextMenu.colorClicked', { colorId: 'mark-green', selection: selection() });

  const payload = host.callsTo('reader.setHighlight')[0].payload;
  assert.equal(payload.bookUid, 'id:183');
});

test('a multi-paragraph selection becomes one highlight per section, sharing a group', async t => {
  const host = await bootEngine();
  t.after(host.dispose);

  await host.emit('contextMenu.colorClicked', {
    colorId: 'mark-blue', selection: multiSectionSelection()
  });

  assert.equal(host.hostHighlights.size, 3);
  const records = host.core.getHighlights();
  assert.deepEqual(plain(records.map(item => item.sectionIndex)).sort(), [4, 5, 6]);
  const groups = new Set(records.map(item => item.groupId));
  assert.equal(groups.size, 1);
  assert.notEqual([...groups][0], null);
});

test('a failed section rolls the whole multi-paragraph highlight back', async t => {
  let calls = 0;
  const host = await bootEngine({
    overrides: {
      'reader.setHighlight': payload => {
        calls++;
        if (calls === 3) return { success: false, data: null, error: { code: 'error.internal', message: 'boom' } };
        return { success: true, data: { highlightId: payload.highlightId, version: 1, etag: 'e1', status: 'active' }, error: null };
      }
    }
  });
  t.after(host.dispose);

  await host.emit('contextMenu.colorClicked', {
    colorId: 'mark-blue', selection: multiSectionSelection()
  });

  const stored = [...host.storage.keys()].filter(key => key.startsWith('highlight:'));
  assert.deepEqual(stored, [], 'no partial highlight may survive');
});

test('marking over an existing highlight replaces it', async t => {
  const host = await bootEngine();
  t.after(host.dispose);

  await host.emit('contextMenu.colorClicked', { colorId: 'mark-green', selection: selection() });
  const first = host.core.getHighlights()[0].highlightId;

  await host.emit('contextMenu.colorClicked', { colorId: 'mark-red', selection: selection() });
  const records = host.core.getHighlights();
  assert.equal(records.length, 1);
  assert.equal(records[0].colorId, 'red');
  assert.notEqual(records[0].highlightId, first);
  assert.equal(host.hostHighlights.size, 1);
});

test('a selection without an anchor is reported, not silently dropped', async t => {
  const host = await bootEngine();
  t.after(host.dispose);

  await host.emit('contextMenu.colorClicked', {
    colorId: 'mark-green', selection: selection({ sourceRange: undefined })
  });

  assert.equal(host.hostHighlights.size, 0);
  assert.equal(host.callsTo('ui.showMessage').length, 1);
  assert.equal(host.callsTo('reader.getHighlightCapabilities').length, 1);
});

test('a selection the host could not anchor says so, not "select some text"', async t => {
  const host = await bootEngine();
  t.after(host.dispose);

  await host.emit('contextMenu.colorClicked', {
    colorId: 'mark-green',
    selection: selection({ sourceRange: undefined, sourceSelectedText: 'טקסט שנבחר' })
  });

  const message = host.callsTo('ui.showMessage')[0].payload.message;
  assert.match(message, /לקבע/, 'the user did select text; the anchor is what failed');
});

test('a PDF surface explains why marking is unavailable', async t => {
  const host = await bootEngine({
    overrides: {
      'reader.getHighlightCapabilities': () => ({
        success: true,
        data: { surface: 'pdf', highlights: false, selection: false, contextMenu: [] },
        error: null
      })
    }
  });
  t.after(host.dispose);

  await host.emit('contextMenu.colorClicked', {
    colorId: 'mark-green', selection: selection({ sourceRange: undefined })
  });
  const message = host.callsTo('ui.showMessage')[0].payload.message;
  assert.match(message, /PDF/);
});

// Regression: the host delivers a menu click to exactly one instance. Gating
// the handler on engine ownership meant that with the plugin tab open and the
// background instance already shut down, the click landed on the page — which
// ignored it. Clicking a colour did nothing at all, with no error anywhere.
test('a click that arrives before any menu sync still marks', async t => {
  const host = createHost();
  t.after(host.dispose);
  await host.emit('plugin.boot', PAGE_BOOT);

  await host.emit('contextMenu.colorClicked', {
    colorId: 'mark-green', selection: selection()
  });

  assert.equal(host.hostHighlights.size, 1, 'the click must not be dropped');
  assert.equal(host.core.getHighlights()[0].colorId, 'green');
});

test('a click that arrives before boot finishes waits for the settings', async t => {
  const host = createHost({
    settings: { colors: [{ id: 'sea', hex: '#123456', label: 'ים', enabled: true }] }
  });
  t.after(host.dispose);

  // The host queues the click and delivers it right after dispatching boot,
  // while the boot handler is still reading storage. Acting on the default
  // colours then would mark in a colour the user does not have.
  const booting = host.emit('plugin.boot', PAGE_BOOT);
  const clicking = host.emit('contextMenu.colorClicked', {
    colorId: 'mark-sea', selection: selection()
  });
  await Promise.all([booting, clicking]);

  assert.equal(host.hostHighlights.size, 1);
  assert.equal(host.core.getHighlights()[0].colorId, 'sea');
});

test('an unknown color id is ignored rather than marked with a fallback color', async t => {
  const host = await bootEngine();
  t.after(host.dispose);

  await host.emit('contextMenu.colorClicked', { colorId: 'mark-nope', selection: selection() });
  assert.equal(host.hostHighlights.size, 0);
});

test('...but it says so, and puts the colour row right', async t => {
  // Otzaria re-registers the manifest's own colour row whenever the plugin's
  // last instance goes away, so the row on screen can name a colour the user
  // has since renamed or switched off. Answering that click with silence is
  // indistinguishable from a plugin that has stopped working — which is
  // exactly what it was reported as.
  const host = await bootEngine();
  t.after(host.dispose);
  const before = host.callsTo('reader.updateContextMenuItem').length;

  await host.emit('contextMenu.colorClicked', { colorId: 'mark-nope', selection: selection() });

  assert.equal(host.callsTo('ui.showMessage').length, 1, 'the user is told');
  assert.ok(host.callsTo('reader.updateContextMenuItem').length > before,
    'and the row is refreshed so the next click works');
});

// ── Removing highlights ─────────────────────────────────────────────────────

test('right-clicking a highlight removes exactly the clicked one', async t => {
  const host = await bootEngine();
  t.after(host.dispose);
  await host.emit('contextMenu.colorClicked', { colorId: 'mark-green', selection: selection() });
  await host.emit('contextMenu.colorClicked', {
    colorId: 'mark-red', selection: selection({ sectionIndex: 9, currentIndex: 9 })
  });
  const target = host.core.getHighlights().find(item => item.sectionIndex === 4);

  await host.emit('contextMenu.itemClicked', {
    itemId: 'marker-remove',
    selection: { clickedHighlights: [{ highlightId: target.highlightId, pluginId: 'com.otzaria-marker' }] }
  });

  const remaining = host.core.getHighlights();
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].sectionIndex, 9);
  assert.equal(host.hostHighlights.size, 1);
});

test('removing one part of a multi-paragraph highlight removes the whole group', async t => {
  const host = await bootEngine();
  t.after(host.dispose);
  await host.emit('contextMenu.colorClicked', {
    colorId: 'mark-blue', selection: multiSectionSelection()
  });
  const part = host.core.getHighlights()[0];

  await host.emit('contextMenu.itemClicked', {
    itemId: 'marker-remove',
    selection: { clickedHighlights: [{ highlightId: part.highlightId, pluginId: 'com.otzaria-marker' }] }
  });

  assert.equal(host.core.getHighlights().length, 0);
  assert.equal(host.hostHighlights.size, 0);
});

test('highlights owned by another plugin are left alone', async t => {
  const host = await bootEngine();
  t.after(host.dispose);
  await host.emit('contextMenu.colorClicked', { colorId: 'mark-green', selection: selection() });
  const mine = host.core.getHighlights()[0];

  await host.emit('contextMenu.itemClicked', {
    itemId: 'marker-remove',
    selection: {
      clickedHighlights: [
        { highlightId: 'other-plugin-1', pluginId: 'com.someone.else' },
        { highlightId: mine.highlightId, pluginId: 'com.otzaria-marker' }
      ]
    }
  });

  assert.equal(host.core.getHighlights().length, 0);
  const cleared = host.callsTo('reader.clearHighlight').map(call => call.payload.highlightId);
  assert.equal(cleared.includes('other-plugin-1'), false);
});

// ── Rich notes ──────────────────────────────────────────────────────────────

test('a note is stored as markup and as its plain-text mirror', async t => {
  const host = await bootEngine();
  t.after(host.dispose);
  await host.emit('contextMenu.colorClicked', { colorId: 'mark-green', selection: selection() });
  const item = host.core.getHighlights()[0];

  await host.core.updateHighlight(item, {
    noteHtml: '<p>שורה <b>מודגשת</b></p>',
    note: 'שורה מודגשת'
  });

  const stored = host.storage.get(item.key);
  assert.equal(stored.noteHtml, '<p>שורה <b>מודגשת</b></p>');
  assert.equal(stored.note, 'שורה מודגשת');
  // The plain mirror is what search reads.
  assert.equal(host.domain.filterHighlights(host.core.getHighlights(),
    { query: 'מודגשת' }, () => '').length, 1);
});

test('a note survives a backup round trip', async t => {
  const host = await bootEngine();
  t.after(host.dispose);
  await host.emit('contextMenu.colorClicked', { colorId: 'mark-green', selection: selection() });
  await host.core.updateHighlight(host.core.getHighlights()[0], {
    noteHtml: '<h2>כותרת</h2><ul><li>פריט</li></ul>',
    note: 'כותרת\nפריט'
  });

  const backup = host.domain.parseBackup(host.core.buildBackup());
  await host.core.deleteAllHighlights();
  await host.core.importBackup(backup, { replace: true });

  assert.equal(host.core.getHighlights()[0].noteHtml, '<h2>כותרת</h2><ul><li>פריט</li></ul>');
});

test('an oversized note is cut to the storage limit rather than rejected', async t => {
  const host = await bootEngine();
  t.after(host.dispose);
  await host.emit('contextMenu.colorClicked', { colorId: 'mark-green', selection: selection() });

  await host.core.updateHighlight(host.core.getHighlights()[0], {
    noteHtml: `<p>${'א'.repeat(50000)}</p>`
  });

  const stored = host.core.getHighlights()[0];
  assert.equal(stored.noteHtml.length, host.domain.MAX_NOTE_HTML_LENGTH);
});

test('"edit note" asks the page to open the editor', async t => {
  const host = createHost();
  t.after(host.dispose);
  await host.emit('plugin.boot', PAGE_BOOT);

  const requested = [];
  host.core.on('edit-highlight', id => requested.push(id));
  await host.emit('contextMenu.itemClicked', {
    itemId: 'marker-note',
    selection: {
      clickedHighlights: [{ highlightId: 'marker-abc', pluginId: 'com.otzaria-marker' }]
    }
  });

  assert.deepEqual(requested, ['marker-abc']);
});

test('"edit note" ignores a highlight owned by another plugin', async t => {
  const host = await bootEngine();
  t.after(host.dispose);
  const requested = [];
  host.core.on('edit-highlight', id => requested.push(id));

  await host.emit('contextMenu.itemClicked', {
    itemId: 'marker-note',
    selection: { clickedHighlights: [{ highlightId: 'other-1', pluginId: 'com.someone.else' }] }
  });

  assert.deepEqual(requested, []);
});

test('"remove" from the submenu still clears the clicked highlight', async t => {
  const host = await bootEngine();
  t.after(host.dispose);
  await host.emit('contextMenu.colorClicked', { colorId: 'mark-green', selection: selection() });
  const item = host.core.getHighlights()[0];

  await host.emit('contextMenu.itemClicked', {
    itemId: 'marker-remove',
    selection: { clickedHighlights: [{ highlightId: item.highlightId, pluginId: 'com.otzaria-marker' }] }
  });

  assert.equal(host.core.getHighlights().length, 0);
});

// ── Restore & reconciliation ────────────────────────────────────────────────

test('boot redraws stored highlights that the host lost on restart', async t => {
  const stored = {
    highlightId: 'marker-abc', bookId: 'בראשית', book: 'בראשית', sectionIndex: 3,
    colorId: 'yellow', color: '#F1E784', text: 'טקסט', ref: '', tags: [], note: '',
    sourceRange: { start: { utf16: 0 }, end: { utf16: 5 } }, timestamp: 1
  };
  const host = await bootEngine({ highlights: [stored] });
  t.after(host.dispose);

  assert.equal(host.hostHighlights.size, 1);
  assert.equal(host.ownRecords()[0].bookId, 'בראשית');
  assert.equal(host.core.getHighlights()[0].version, 1);
});

test('the boot event already carries the stored state', async t => {
  const stored = {
    highlightId: 'marker-abc', bookId: 'בראשית', sectionIndex: 3,
    colorId: 'yellow', tags: [], sourceRange: { start: { utf16: 0 }, end: { utf16: 5 } }, timestamp: 1
  };
  const host = createHost({ highlights: [stored], settings: { menuStyle: 'submenu' } });
  t.after(host.dispose);

  // The page renders on this event; if the data is not loaded yet it would
  // paint an empty list first and then flash to the real one.
  let seen = null;
  host.core.on('boot', () => {
    seen = { highlights: host.core.getHighlights().length, menuStyle: host.core.settings.menuStyle };
  });
  await host.emit('plugin.boot', PAGE_BOOT);

  assert.deepEqual(seen, { highlights: 1, menuStyle: 'submenu' });
});

test('importing a backup that changes the language re-translates the page', async t => {
  const host = await bootEngine();
  t.after(host.dispose);
  const languages = [];
  host.core.on('language', language => languages.push(language));

  const backup = host.domain.parseBackup(host.core.buildBackup());
  backup.settings.language = 'en';
  await host.core.importBackup(backup, { replace: true });

  assert.deepEqual(languages, ['en']);
  assert.equal(removeTitle(host), 'Remove mark');
});

test('a warm wake does not redraw highlights the host still holds', async t => {
  const stored = {
    highlightId: 'marker-abc', bookId: 'בראשית', book: 'בראשית', sectionIndex: 3,
    colorId: 'yellow', color: '#F1E784', text: 'טקסט', tags: [],
    sourceRange: { start: { utf16: 0 }, end: { utf16: 5 } }, timestamp: 1
  };
  const host = await bootEngine({ highlights: [stored] });
  t.after(host.dispose);
  const drawnOnBoot = host.callsTo('reader.setHighlight').length;

  await host.core.reconcileHighlights();
  assert.equal(host.callsTo('reader.setHighlight').length, drawnOnBoot);
});

test('a corrupt stored record is skipped instead of breaking the load', async t => {
  const host = await bootEngine({
    highlights: [
      { highlightId: 'marker-ok', bookId: 'בראשית', sectionIndex: 1, colorId: 'yellow', tags: [], sourceRange: { start: { utf16: 0 }, end: { utf16: 3 } }, timestamp: 1 },
      { highlightId: 'marker-bad', bookId: '', sectionIndex: -1, sourceRange: null }
    ]
  });
  t.after(host.dispose);

  assert.deepEqual(plain(host.core.getHighlights().map(item => item.highlightId)), ['marker-ok']);
});

test('a re-anchored section is read back from the host rather than guessed', async t => {
  const host = await bootEngine();
  t.after(host.dispose);
  await host.emit('contextMenu.colorClicked', { colorId: 'mark-green', selection: selection() });
  const record = host.core.getHighlights()[0];
  const moved = { start: { utf16: 99 }, end: { utf16: 120 } };
  const drawn = host.ownRecords().find(entry => entry.highlightId === record.highlightId);
  drawn.range = moved;
  drawn.status = 'stale';

  await host.emit('reader.sectionContentChanged', {
    changeType: 'source-content', bookId: 'בראשית', sectionIndex: 4
  });

  const updated = host.core.getHighlights()[0];
  assert.equal(updated.status, 'stale');
  assert.deepEqual(plain(updated.sourceRange), moved);
  assert.deepEqual(plain(host.storage.get(updated.key).sourceRange), moved);
});

// ── Settings ────────────────────────────────────────────────────────────────

test('changing a color style restyles highlights already drawn', async t => {
  const host = await bootEngine();
  t.after(host.dispose);
  await host.emit('contextMenu.colorClicked', { colorId: 'mark-green', selection: selection() });
  const before = host.core.getHighlights()[0].style.backgroundColor;

  const next = host.domain.structuredCloneSafe(host.core.settings);
  next.colors.find(color => color.id === 'green').hex = '#00FF00';
  await host.core.saveSettings(next);

  const after = host.core.getHighlights()[0].style.backgroundColor;
  assert.notEqual(after, before);
  assert.equal(after, '#00FF00');
});

test('saving unrelated settings does not touch existing highlights', async t => {
  const host = await bootEngine();
  t.after(host.dispose);
  await host.emit('contextMenu.colorClicked', { colorId: 'mark-green', selection: selection() });
  const updatesBefore = host.callsTo('reader.updateHighlight').length;

  await host.core.saveSettings(Object.assign({}, host.core.settings, {
    appearance: Object.assign({}, host.core.settings.appearance, { fontSize: 22 })
  }));

  assert.equal(host.callsTo('reader.updateHighlight').length, updatesBefore);
});

test('switching the plugin language retitles the context menu', async t => {
  const host = await bootEngine();
  t.after(host.dispose);
  assert.equal(removeTitle(host), 'הסר סימון');

  await host.core.saveSettings(Object.assign({}, host.core.settings, { language: 'en' }));

  assert.equal(host.i18n.language, 'en');
  assert.equal(removeTitle(host), 'Remove mark');
  assert.equal(host.contextMenu.get('marker-colors').title, 'Marker');
});

test('following the host language reacts to settings.changed', async t => {
  const host = await bootEngine();
  t.after(host.dispose);

  await host.emit('settings.changed', { key: 'key-settings-language', newValue: 'en' });

  assert.equal(host.i18n.language, 'en');
  assert.equal(removeTitle(host), 'Remove mark');
});

test('an explicit language choice ignores the host language', async t => {
  const host = await bootEngine({ settings: { language: 'he' } });
  t.after(host.dispose);

  await host.emit('settings.changed', { key: 'key-settings-language', newValue: 'en' });
  assert.equal(host.i18n.language, 'he');
});

// ── Commands ────────────────────────────────────────────────────────────────

test('the default-color shortcut marks the live selection', async t => {
  const host = await bootEngine({
    overrides: { 'reader.getSelection': () => ({ success: true, data: selection(), error: null }) }
  });
  t.after(host.dispose);

  await host.emit('app.command', { command: 'marker.highlightDefault', shortcutId: 'marker-highlight-default' });

  assert.equal(host.hostHighlights.size, 1);
  assert.equal(host.core.getHighlights()[0].colorId, host.core.settings.defaultColorId);
});

test('the reader toolbar button hides and shows the marks in the open book', async t => {
  const host = await bootEngine();
  t.after(host.dispose);
  await host.emit('contextMenu.colorClicked', { colorId: 'mark-green', selection: selection() });
  assert.equal(host.hostHighlights.size, 1);
  const views = [];
  host.core.on('page-opened', param => views.push(param));

  await host.emit('reader.toolbar_item_clicked', {
    itemId: 'marker-toolbar', context: 'reader-text', currentBookId: 'בראשית'
  });

  // It must not open the plugin — the whole point is to act where the user is.
  assert.deepEqual(views, []);
  assert.equal(host.hostHighlights.size, 0, 'the colours come off the page');
  assert.equal(host.core.getHighlights().length, 1, 'but nothing is deleted');
  assert.deepEqual(plain(host.core.mutedBooks), ['בראשית']);

  await host.emit('reader.toolbar_item_clicked', {
    itemId: 'marker-toolbar', context: 'reader-text', currentBookId: 'בראשית'
  });
  assert.equal(host.hostHighlights.size, 1, 'a second click puts them back');
  assert.deepEqual(plain(host.core.mutedBooks), []);
});

test('marking in a hidden book un-hides it instead of swallowing the click', async t => {
  // Hiding is sticky, and a user who hid a book days ago and then marks in it
  // gets a colour click that does nothing visible and explains nothing. Asking
  // to mark is as clear a statement as there is that the marks should show.
  const host = await bootEngine();
  t.after(host.dispose);
  await host.core.toggleMutedBook('בראשית');
  assert.deepEqual(plain(host.core.mutedBooks), ['בראשית']);

  await host.emit('contextMenu.colorClicked', { colorId: 'mark-green', selection: selection() });

  assert.equal(host.core.getHighlights().length, 1);
  assert.equal(host.hostHighlights.size, 1, 'the new mark is on the page');
  assert.deepEqual(plain(host.core.mutedBooks), []);
});

test('the toolbar label says what the next click will do', async t => {
  const host = await bootEngine();
  t.after(host.dispose);
  await host.emit('reader.current_ref_changed', { currentBookId: 'בראשית' });

  assert.match(host.toolbar.get('marker-toolbar').title, /הסתרת/);
  await host.core.toggleMutedBook('בראשית');
  assert.match(host.toolbar.get('marker-toolbar').title, /הצגת/);
});

test('the open-panel shortcut navigates to the plugin page', async t => {
  const host = await bootEngine();
  t.after(host.dispose);

  await host.emit('app.command', { command: 'marker.openPanel' });
  assert.equal(host.callsTo('plugin.openSelf').length, 1);
});

// ── Backup ──────────────────────────────────────────────────────────────────

test('the private-space backup captures settings and highlights', async t => {
  const host = await bootEngine();
  t.after(host.dispose);
  await host.emit('contextMenu.colorClicked', { colorId: 'mark-green', selection: selection() });

  await host.core.writeAutoBackup();
  const backup = JSON.parse(host.files.get('backups/latest.json'));
  assert.equal(backup.format, 'otzaria-marker-backup');
  assert.equal(backup.highlights.length, 1);
  assert.equal(backup.settings.colors.length > 0, true);
  assert.equal([...host.files.keys()].some(key => key.startsWith('backups/daily-')), true);
});

test('importing a backup replaces the store and redraws every highlight', async t => {
  const host = await bootEngine();
  t.after(host.dispose);
  await host.emit('contextMenu.colorClicked', { colorId: 'mark-green', selection: selection() });
  const backup = host.core.buildBackup();

  await host.core.deleteAllHighlights();
  assert.equal(host.core.getHighlights().length, 0);

  await host.core.importBackup(host.domain.parseBackup(backup), { replace: true });
  assert.equal(host.core.getHighlights().length, 1);
  assert.equal(host.hostHighlights.size, 1);
});

test('a failed import rolls back to the previous state', async t => {
  const host = await bootEngine();
  t.after(host.dispose);
  await host.emit('contextMenu.colorClicked', { colorId: 'mark-green', selection: selection() });
  const original = host.core.getHighlights()[0].highlightId;

  const backup = host.domain.parseBackup(host.core.buildBackup());
  backup.highlights.push(Object.assign({}, backup.highlights[0], { highlightId: 'marker-second' }));

  let failOnSecond = 0;
  host.context.Otzaria.call = new Proxy(host.context.Otzaria.call, {
    apply(target, thisArg, args) {
      if (args[0] === 'storage.set' && String(args[1]?.key).startsWith('highlight:')) {
        failOnSecond++;
        if (failOnSecond === 2) throw new Error('disk full');
      }
      return Reflect.apply(target, thisArg, args);
    }
  });

  await assert.rejects(() => host.core.importBackup(backup, { replace: true }));
  assert.deepEqual(plain(host.core.getHighlights().map(item => item.highlightId)), [original]);
});

// ── Permissions ─────────────────────────────────────────────────────────────

test('a permission change re-registers the contributions and redraws', async t => {
  const host = await bootEngine();
  t.after(host.dispose);
  await host.emit('contextMenu.colorClicked', { colorId: 'mark-green', selection: selection() });
  const patchesBefore = host.callsTo('reader.updateContextMenuItem').length;
  host.hostHighlights.clear();

  // Regaining reader.highlight or reader.context_menu means the marks and the
  // menu have to be put back; ownership itself can no longer change.
  await host.emit('plugin.permissions_changed', { permissions: ['reader.highlight'] });

  assert.ok(host.callsTo('reader.updateContextMenuItem').length > patchesBefore);
  assert.equal(host.hostHighlights.size, 1, 'the marks were redrawn');
});

// ── Reporting ───────────────────────────────────────────────────────────────

test('a report carries the environment the developer needs', async t => {
  const host = await bootEngine();
  t.after(host.dispose);

  const outcome = await host.core.sendReport({ details: 'התוסף לא מסמן', reportType: 'bug' });
  assert.equal(outcome, 'sent');
  const payload = host.callsTo('feedback.report')[0].payload;
  assert.equal(payload.reportType, 'bug');
  assert.match(payload.details, /התוסף לא מסמן/);
  assert.match(payload.details, /0\.9\.97/);
  assert.ok(payload.details.length <= 5000);
});

test('a report without a reply address does not send an empty one', async t => {
  const host = await bootEngine();
  t.after(host.dispose);

  await host.core.sendReport({ details: 'בדיקה', reporterEmail: '' });
  assert.equal('reporterEmail' in host.callsTo('feedback.report')[0].payload, false);
});

test('a colour changed in the page reaches the reader through the engine', async t => {
  // The page cannot touch the engine's host records, so the only path from
  // "the user picked a different colour" to "the mark changed on the page" is
  // the engine noticing that what is drawn no longer matches what is stored.
  const host = await bootEngine();
  t.after(host.dispose);
  await host.emit('contextMenu.colorClicked', { colorId: 'mark-green', selection: selection() });
  const item = host.core.getHighlights()[0];
  const drawn = () => plain([...host.hostHighlights.values()])[0].style.backgroundColor;
  assert.equal(drawn(), '#8BCF8D');

  // Exactly what a viewer leaves behind: a stored record with a new colour.
  const stored = host.storage.get(`highlight:${item.highlightId}`);
  stored.colorId = 'red';
  stored.color = '#F37E75';
  stored.style = Object.assign({}, stored.style, { backgroundColor: '#F37E75' });
  await host.core.loadHighlights();

  await host.core.reconcileHighlights();
  assert.equal(drawn(), '#F37E75');
});

test('the Divine Name follows Otzaria unless the plugin is told otherwise', async t => {
  const host = await bootEngine({ hostSettings: { 'key-replace-holy-names': true } });
  t.after(host.dispose);

  assert.equal(host.core.displayText('ויאמר יהוה'), 'ויאמר יקוק');

  // The book display is unfiltered, but the list still is not.
  const strict = await bootEngine({ settings: { holyNames: 'always' } });
  t.after(strict.dispose);
  assert.equal(strict.core.displayText('ויאמר יהוה'), 'ויאמר יקוק');

  const off = await bootEngine();
  t.after(off.dispose);
  assert.equal(off.core.displayText('ויאמר יהוה'), 'ויאמר יהוה');
});

test('the toolbar flag is mirrored to the key the manifest gates on', async t => {
  // `when: { storage: { key: 'marker_toolbar_button' } }` is evaluated by the
  // host with no plugin code running, so it can only read a whole stored
  // value — the flag has to live in its own key, not inside the settings.
  const host = await bootEngine();
  t.after(host.dispose);
  assert.equal(host.storage.get('marker_toolbar_button'), true);

  await host.core.saveSettings(Object.assign({}, host.core.settings, { toolbarButton: false }));
  assert.equal(host.storage.get('marker_toolbar_button'), false);
});

test('the stored text is what the reader saw, not the remapped source', async t => {
  // The bug this guards: Otzaria maps the selection back onto the canonical
  // text through an interpolating mapping, and the highlights list showed a
  // passage starting several letters before the one the user marked.
  const host = await bootEngine();
  t.after(host.dispose);

  await host.emit('contextMenu.colorClicked', {
    colorId: 'mark-green',
    selection: selection({
      renderedSelectedText: 'וא"ת מ"ש שאלה ושכירות',
      sourceSelectedText: 'נו בשניהם וא"ת מ"ש שא'
    })
  });

  assert.equal(host.core.getHighlights()[0].text, 'וא"ת מ"ש שאלה ושכירות');
});

test('a deletion made in the page takes the mark off the book too', async t => {
  // The page cannot call `reader.clearHighlight` on a record it does not own,
  // so a delete there would have left the colour on the text until Otzaria
  // restarted. The engine has to notice the record is gone from storage.
  const host = await bootEngine();
  t.after(host.dispose);
  await host.emit('contextMenu.colorClicked', { colorId: 'mark-green', selection: selection() });
  const item = host.core.getHighlights()[0];
  assert.equal(host.hostHighlights.size, 1);

  // Exactly what a viewer leaves behind: the record is simply gone.
  host.storage.delete(`highlight:${item.highlightId}`);
  await host.core.loadHighlights();

  const outcome = await host.core.reconcileHighlights();
  assert.equal(outcome.removed, 1);
  assert.equal(host.hostHighlights.size, 0);
});

test('hiding a book leaves its records alone but takes them off the page', async t => {
  const host = await bootEngine();
  t.after(host.dispose);
  await host.emit('contextMenu.colorClicked', { colorId: 'mark-green', selection: selection() });
  await host.core.toggleMutedBook('בראשית');
  assert.equal(host.hostHighlights.size, 0);

  // A later reconcile must not treat "hidden" as "deleted" and draw it back.
  await host.core.reconcileHighlights();
  assert.equal(host.hostHighlights.size, 0);
  assert.equal(host.core.getHighlights().length, 1);
});

test('the eraser works in the submenu layout too, not only in the colour row', async t => {
  // `menuStyle: 'submenu'` turns every entry, the eraser included, into an
  // `item` — so the click arrives as `contextMenu.itemClicked`, not
  // `contextMenu.colorClicked`. Without a branch for it there, "נקה סימון"
  // was simply dead for anyone who preferred names to swatches.
  const host = createHost({ settings: { menuStyle: 'submenu' } });
  t.after(host.dispose);
  await host.emit('plugin.boot', PAGE_BOOT);
  await host.emit('contextMenu.colorClicked', { colorId: 'mark-green', selection: selection() });
  assert.equal(host.hostHighlights.size, 1);

  await host.emit('contextMenu.itemClicked', {
    itemId: 'mark-clear', selection: selection()
  });

  assert.equal(host.core.getHighlights().length, 0, 'the mark is gone from the store');
  assert.equal(host.hostHighlights.size, 0, 'and off the page');
});

test('a removal that removed nothing does not report success', async t => {
  const host = await bootEngine();
  t.after(host.dispose);
  await host.emit('contextMenu.colorClicked', { colorId: 'mark-green', selection: selection() });
  const item = host.core.getHighlights()[0];

  // The mark itself was reported as saved; only what follows is at issue.
  const successes = host.callsTo('ui.showSuccess').length;
  const original = host.context.Otzaria.call;
  host.context.Otzaria.call = async (method, payload) => {
    if (method === 'reader.clearHighlight') {
      return {
        success: false, data: null,
        error: { schemaVersion: 1, code: 'error.internal', message: 'busy', retryable: false }
      };
    }
    return original(method, payload);
  };

  await host.emit('contextMenu.itemClicked', {
    itemId: 'marker-remove',
    selection: { clickedHighlights: [{ highlightId: item.highlightId, pluginId: 'com.otzaria-marker' }] }
  });

  assert.equal(host.callsTo('ui.showSuccess').length, successes,
    'nothing was removed, so nothing new succeeded');
  assert.equal(host.callsTo('ui.showError').length, 1);
});
