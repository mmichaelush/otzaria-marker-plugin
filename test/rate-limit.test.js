const assert = require('node:assert/strict');
const test = require('node:test');

const { createHost, createWorld, selection } = require('./helpers/harness.js');

/**
 * The plugin under Otzaria's RPC throttle.
 *
 * `PluginBridgeHandler.RateLimiter` is a 50-token bucket that adds
 * `elapsed ~/ 10` tokens on every call and then moves its clock to now — the
 * leftover milliseconds are discarded. So a run of calls closer together than
 * 10ms refills *nothing*: fifty are served and everything after them is
 * refused, for as long as the run lasts. An awaited loop does it as readily as
 * `Promise.all`; a storage read answers far faster than 10ms.
 *
 * This is the bug behind "a little after the app starts, the plugin stops
 * responding to the right-click menu — it doesn't mark and it doesn't erase".
 * Nothing in it was visible: the refusals were swallowed as "no such record",
 * and the error toast that should have explained it was itself an RPC, refused
 * with everything else.
 *
 * The failure needs a real store to show itself — fifty is a number a user
 * passes in a month of reading, not a number a two-record test reaches.
 */

const PAGE_BOOT = { app: { runMode: 'foreground', version: '0.9.97' }, permissions: [] };

/** `count` stored marks, spread over sections so none replaces another. */
function storedHighlights(count) {
  return Array.from({ length: count }, (_, index) => ({
    highlightId: `marker-${index}`,
    bookId: 'בראשית',
    book: 'בראשית',
    sectionIndex: index,
    colorId: 'yellow',
    color: '#F1E784',
    text: `קטע ${index}`,
    ref: '',
    tags: [],
    note: '',
    sourceRange: { start: { utf16: 0 }, end: { utf16: 5 } },
    timestamp: index + 1
  }));
}

test('every stored mark survives a boot under the real throttle', async t => {
  // 90 marks is 90 reads and then 90 draws. Before the pacing this lost
  // the tail of the user's own list on the way in, and the reader showed
  // whichever fifty happened to win the race.
  const host = createHost({ highlights: storedHighlights(90), throttle: true });
  t.after(host.dispose);

  await host.emit('plugin.boot', PAGE_BOOT);

  assert.equal(host.core.getHighlights().length, 90, 'all of them were read');
  assert.equal(host.hostHighlights.size, 90, 'and all of them reached the book');
});

test('the plugin paces itself, so the host never has to refuse it', async t => {
  // Surviving by retrying is not the same as behaving. The retry is a
  // backstop for a bucket shared with another instance; on its own an
  // instance should stay inside the budget.
  const host = createHost({ highlights: storedHighlights(90), throttle: true });
  t.after(host.dispose);

  await host.emit('plugin.boot', PAGE_BOOT);

  assert.equal(host.refusals, 0);
});

test('marking still works once the bucket is drained', async t => {
  const host = createHost({ highlights: storedHighlights(60), throttle: true });
  t.after(host.dispose);
  await host.emit('plugin.boot', PAGE_BOOT);

  await host.emit('contextMenu.colorClicked', {
    colorId: 'mark-green', selection: selection({ sectionIndex: 500, currentIndex: 500 })
  });

  const marks = host.core.getHighlights();
  assert.equal(marks.length, 61, 'the click produced a mark');
  assert.ok(host.ownRecords().some(record => record.style.backgroundColor === '#8BCF8D'),
    'and the mark reached the reader, not only storage');
});

test('erasing still works once the bucket is drained', async t => {
  const host = createHost({ highlights: storedHighlights(60), throttle: true });
  t.after(host.dispose);
  await host.emit('plugin.boot', PAGE_BOOT);
  const doomed = host.core.getHighlights().find(item => item.highlightId === 'marker-7');

  await host.emit('contextMenu.itemClicked', {
    itemId: 'marker-remove',
    selection: {
      clickedHighlights: [{ highlightId: doomed.highlightId, pluginId: 'com.otzaria-marker' }]
    }
  });

  assert.equal(host.core.getHighlights().length, 59);
  assert.ok(!host.ownRecords().some(record => record.highlightId === 'marker-7'),
    'and it came off the page as well');
});

test('engine and page each get their own bucket, and agree on the whole store', async t => {
  // A bucket per WebView — PluginBridgeHandler is built per instance — so
  // two instances do not contend. What they must not do is disagree.
  const world = createWorld({ highlights: storedHighlights(60), throttle: true });
  t.after(world.dispose);

  await world.boot();
  await world.settle();

  assert.equal(world.engine.core.getHighlights().length, 60);
  assert.equal(world.page.core.getHighlights().length, 60);
  assert.equal(world.drawn().size, 60);
});

// ── A failed read is not an empty store ─────────────────────────────────────
//
// The throttle is fixed above, but any read can fail for its own reasons. The
// rule that has to hold whatever the cause: the plugin may only take a mark
// off the page when it knows the mark is gone from the store. It cannot tell
// "deleted elsewhere" from "I could not read it", and guessing wrong erases
// the user's work from in front of them.

test('a failed listing leaves the drawn marks alone', async t => {
  const host = createHost({ highlights: storedHighlights(3) });
  t.after(host.dispose);
  await host.emit('plugin.boot', PAGE_BOOT);
  assert.equal(host.hostHighlights.size, 3);

  host.context.Otzaria.call = ((original) => async (method, payload) => {
    if (method === 'storage.list') {
      return {
        success: false, data: null,
        error: { schemaVersion: 1, code: 'error.internal', message: 'disk', retryable: false }
      };
    }
    return original(method, payload);
  })(host.context.Otzaria.call);

  await host.core.loadHighlights();
  await host.core.reconcileHighlights();

  assert.equal(host.core.getHighlights().length, 3, 'the list is kept, not emptied');
  assert.equal(host.hostHighlights.size, 3, 'and nothing is taken off the page');
});

test('a record that could not be read keeps the copy already in hand', async t => {
  const host = createHost({ highlights: storedHighlights(3) });
  t.after(host.dispose);
  await host.emit('plugin.boot', PAGE_BOOT);

  host.context.Otzaria.call = ((original) => async (method, payload) => {
    if (method === 'storage.get' && payload?.key === 'highlight:marker-1') {
      return {
        success: false, data: null,
        error: { schemaVersion: 1, code: 'error.internal', message: 'disk', retryable: false }
      };
    }
    return original(method, payload);
  })(host.context.Otzaria.call);

  await host.core.loadHighlights();

  assert.equal(host.core.getHighlights().length, 3);
  assert.ok(host.core.findHighlight('marker-1'), 'the unreadable one is still listed');

  await host.core.reconcileHighlights();
  assert.equal(host.hostHighlights.size, 3, 'and still drawn');
});

test('a deletion elsewhere still reaches the page once the store reads cleanly', async t => {
  // The guard above must not become an excuse never to erase anything.
  const world = createWorld({ highlights: storedHighlights(3) });
  t.after(world.dispose);
  await world.boot();

  await world.page.core.deleteHighlights([world.page.core.findHighlight('marker-1')]);
  await world.settle();

  assert.equal(world.drawn().size, 2);
  assert.equal(world.engine.core.getHighlights().length, 2);
});

test('an unreadable reader gives up the pass instead of redrawing everything', async t => {
  const host = createHost({ highlights: storedHighlights(3) });
  t.after(host.dispose);
  await host.emit('plugin.boot', PAGE_BOOT);

  host.context.Otzaria.call = ((original) => async (method, payload) => {
    if (method === 'reader.getHighlights') {
      return {
        success: false, data: null,
        error: { schemaVersion: 1, code: 'error.internal', message: 'busy', retryable: false }
      };
    }
    return original(method, payload);
  })(host.context.Otzaria.call);

  const before = host.callsTo('reader.setHighlight').length;
  const result = await host.core.reconcileHighlights();

  assert.equal(result.restored + result.updated + result.removed, 0);
  assert.equal(host.callsTo('reader.setHighlight').length, before,
    'it did not repaint the book on no evidence');
  assert.equal(host.hostHighlights.size, 3, 'and it did not clear it either');
});

test('a degraded read is retried on the next poll, not left for the session', async t => {
  // The refusal to erase on a partial read was only half the rule. Without
  // the other half the record stayed missing from the list and off the page
  // until the app was restarted, because the revision token had not moved and
  // the poll returned early on every tick.
  const host = createHost({ highlights: storedHighlights(3) });
  t.after(host.dispose);

  let failOnce = true;
  const original = host.context.Otzaria.call;
  host.context.Otzaria.call = async (method, payload) => {
    if (failOnce && method === 'storage.get' && payload?.key === 'highlight:marker-1') {
      failOnce = false;
      return {
        success: false, data: null,
        error: { schemaVersion: 1, code: 'error.internal', message: 'disk', retryable: false }
      };
    }
    return original(method, payload);
  };

  await host.emit('plugin.boot', PAGE_BOOT);
  assert.equal(host.core.getHighlights().length, 2, 'the failed read cost one record');

  assert.equal(await host.core.pollRevision(), true, 'the poll goes back for it');
  assert.equal(host.core.getHighlights().length, 3);
  assert.equal(host.hostHighlights.size, 3, 'and it reaches the book');

  assert.equal(await host.core.pollRevision(), false, 'and then it settles');
});

test('a wipe refuses to say "all deleted" over a partial read', async t => {
  const host = createHost({ highlights: storedHighlights(3) });
  t.after(host.dispose);
  await host.emit('plugin.boot', PAGE_BOOT);

  const original = host.context.Otzaria.call;
  host.context.Otzaria.call = async (method, payload) => {
    if (method === 'storage.get' && String(payload?.key || '').startsWith('highlight:')) {
      return {
        success: false, data: null,
        error: { schemaVersion: 1, code: 'error.internal', message: 'disk', retryable: false }
      };
    }
    return original(method, payload);
  };
  await host.core.loadHighlights();

  assert.equal(await host.core.deleteAllHighlights(), 0);
  assert.equal(host.callsTo('ui.showError').length, 1, 'and it says why');
  assert.equal([...host.storage.keys()].filter(k => k.startsWith('highlight:')).length, 3,
    'nothing was deleted');
});
