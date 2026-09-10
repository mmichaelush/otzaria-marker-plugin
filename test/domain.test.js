const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '..', 'js', 'marker-domain.js'), 'utf8');
const context = { console, crypto: undefined, globalThis: {} };
context.globalThis = context;
vm.runInNewContext(source, context, { filename: 'marker-domain.js' });
const D = context.MarkerDomain;

const plain = value => JSON.parse(JSON.stringify(value));

function anchor(start, end) {
  return {
    type: 'text-range-v1', schemaVersion: 1, layer: 'source',
    start: { utf16: start }, end: { utf16: end }
  };
}

// ── Settings normalization ──────────────────────────────────────────────────

test('normalizeSettings clamps every value into its supported range', () => {
  const settings = D.normalizeSettings({
    menuStyle: 'invalid',
    language: 'klingon',
    colors: [{ id: 'bad id!', hex: '#12345678', label: 'x'.repeat(80), enabled: 1, opacity: 9, borderRadius: -2 }],
    appearance: { fontSize: 100, lineHeight: 0.1, viewMode: 'unknown', fontFamily: 'Comic Sans' },
    exportTemplate: { format: 'unknown', includeDate: false }
  });
  assert.equal(settings.menuStyle, 'buttonRow');
  assert.equal(settings.language, 'auto');
  assert.equal(settings.colors[0].id, 'bad-id-');
  assert.equal(settings.colors[0].label.length, 24);
  assert.equal(settings.colors[0].opacity, 1);
  assert.equal(settings.colors[0].borderRadius, 0);
  assert.equal(settings.appearance.fontSize, 26);
  assert.equal(settings.appearance.lineHeight, 1.2);
  assert.equal(settings.appearance.viewMode, 'content');
  assert.equal(settings.appearance.fontFamily, 'app');
  assert.equal(settings.exportTemplate.format, 'markdown');
  assert.equal(settings.exportTemplate.includeDate, false);
  assert.equal(settings.schemaVersion, D.SETTINGS_SCHEMA_VERSION);
});

test('normalizeSettings is idempotent', () => {
  const once = D.normalizeSettings({ colors: [{ id: 'a', hex: '#112233', label: 'א', enabled: true }] });
  assert.deepEqual(plain(D.normalizeSettings(once)), plain(once));
});

test('a v1 settings object without the new fields gets working defaults', () => {
  const settings = D.normalizeSettings({
    colors: [{ id: 'yellow', hex: '#f1e784ff', label: 'צהוב', enabled: true }],
    defaultColorId: 'yellow',
    menuStyle: 'buttonRow'
  });
  assert.equal(settings.language, 'auto');
  assert.equal(settings.autoBackup, true);
  assert.equal(settings.colors[0].hex, '#F1E784', 'the 8-digit hex is trimmed for the host');
  assert.equal(settings.colors[0].markerMode, 'text-background');
});

test('duplicate color ids are made unique so storage keys cannot collide', () => {
  const settings = D.normalizeSettings({
    colors: [
      { id: 'dup', hex: '#111111', label: 'א', enabled: true },
      { id: 'dup', hex: '#222222', label: 'ב', enabled: true }
    ]
  });
  assert.equal(new Set(settings.colors.map(color => color.id)).size, 2);
});

test('defaultColorId always points at a color that exists', () => {
  const settings = D.normalizeSettings({
    colors: [{ id: 'only', hex: '#111111', label: 'א', enabled: true }],
    defaultColorId: 'deleted'
  });
  assert.equal(settings.defaultColorId, 'only');
});

test('colors are capped at the host color-row limit', () => {
  const many = Array.from({ length: 30 }, (_, index) => ({
    id: `c${index}`, hex: '#101010', label: `צ${index}`, enabled: true
  }));
  assert.equal(D.normalizeSettings({ colors: many }).colors.length, D.MAX_COLORS);
});

// ── Boot context ────────────────────────────────────────────────────────────

test('normalizeBootContext reads the host language and run mode', () => {
  const boot = D.normalizeBootContext({
    plugin: { id: 'com.otzaria-marker', version: '1.0.0' },
    app: { version: '0.9.97+769', platform: 'windows', locale: 'en', language: 'en', textDirection: 'ltr', runMode: 'background' },
    permissions: ['reader.highlight']
  });
  assert.equal(boot.appVersion, '0.9.97+769');
  assert.equal(boot.language, 'en');
  assert.equal(boot.textDirection, 'ltr');
  assert.equal(boot.runMode, 'background');
  assert.equal(boot.isDesktop, true);
  assert.deepEqual(plain(boot.permissions), ['reader.highlight']);
  assert.equal(boot.capabilities.selectionSections, true);
});

test('an older host reports its missing capabilities instead of pretending', () => {
  const boot = D.normalizeBootContext({ app: { version: '0.9.96+741', locale: 'he-IL' } });
  assert.equal(boot.language, 'he');
  assert.equal(boot.textDirection, 'rtl');
  assert.equal(boot.runMode, 'foreground');
  assert.equal(boot.capabilities.selectionSections, false);
  assert.equal(boot.capabilities.highlightContextMenu, false);
});

test('duplicate color ids are made unique without breaking the host cap', () => {
  const base = 'd'.repeat(80);
  const settings = D.normalizeSettings({
    colors: [
      { id: base, hex: '#111111', label: 'א', enabled: true },
      { id: base, hex: '#222222', label: 'ב', enabled: true },
      { id: base, hex: '#333333', label: 'ג', enabled: true }
    ]
  });

  const ids = settings.colors.map(color => color.id);
  assert.equal(new Set(ids).size, ids.length, 'ids must stay unique');
  for (const id of ids) {
    assert.ok(id.length <= D.MAX_COLOR_ID_LENGTH, `${id} is too long`);
  }
});

test('safeHighlightText keeps the line structure and drops the rest', () => {
  assert.equal(D.safeHighlightText('a\u0007b'), 'ab');
  assert.equal(D.safeHighlightText('a\nb\tc'), 'a\nb\tc');
});

test('safeMenuText collapses a menu label onto one line', () => {
  assert.equal(D.safeMenuText('a\nb'), 'a b');
  assert.equal(D.safeMenuText('  a\u0000b  '), 'a b');
});

test('a backup cannot replace the settings object prototype', () => {
  // JSON.parse creates __proto__ as an own property, and Object.assign then
  // feeds it to the setter. The result is an object that no longer inherits
  // from Object.prototype — and the plugin writes it straight back to storage.
  const key = '__pro' + 'to__';
  const hostile = JSON.parse(`{"colors":[],"${key}":{"polluted":true}}`);

  const settings = D.normalizeSettings(hostile);

  assert.equal(settings.polluted, undefined);
  assert.equal(typeof settings.hasOwnProperty, 'function');
});

test('a long selection of pointed Hebrew keeps its anchor', () => {
  // The host counts grapheme clusters. Vocalized Hebrew runs about three code
  // points per grapheme, so counting code points would reject a selection the
  // host accepts — and the user would lose the mark.
  const pointed = 'בְּ'.repeat(4000);
  assert.ok([...pointed].length > D.MAX_ANCHOR_EXACT_TEXT,
    'the fixture must exceed the cap in code points, or it proves nothing');

  const anchor = {
    type: 'text-range-v1', schemaVersion: 1, layer: 'source',
    start: { utf16: 0, grapheme: 0, codePoint: 0 },
    end: { utf16: pointed.length, grapheme: 4000, codePoint: [...pointed].length },
    exactText: pointed
  };

  assert.notEqual(D.normalizeSourceRange(anchor), null);
  assert.notEqual(D.normalizeHighlight({
    highlightId: 'marker-1', bookId: 'בראשית', sectionIndex: 0, sourceRange: anchor
  }), null);
});

test('a stored anchor is a copy, never the caller object', () => {
  const anchor = {
    start: { utf16: 0 }, end: { utf16: 4 }, exactText: 'שלום'
  };
  const stored = D.normalizeHighlight({
    highlightId: 'marker-2', bookId: 'בראשית', sectionIndex: 0, sourceRange: anchor
  }).sourceRange;

  assert.notEqual(stored, anchor, 'an imported anchor is untrusted input like any other');
  // A JSON round trip: the copy is built inside the sandbox realm, so a deep
  // comparison would be comparing prototypes rather than values.
  assert.deepEqual(JSON.parse(JSON.stringify(stored)), anchor);
});

test('a book identifier is cleaned like every other host string', () => {
  const record = D.normalizeHighlight({
    highlightId: 'marker-3',
    bookId: `בראשית${String.fromCharCode(7)}`,
    bookUid: `id:${String.fromCharCode(0)}183`,
    sectionIndex: 0,
    sourceRange: { start: { utf16: 0 }, end: { utf16: 4 }, exactText: 'שלום' }
  });

  // The host runs bookId through the same _optionalText as a note: one
  // control character fails every call for this record, forever.
  assert.equal(record.bookId, 'בראשית');
  assert.equal(record.bookUid, 'id:183');
  assert.ok(record.bookId.length <= 500);
});

test('an oversized anchor is dropped instead of stored', () => {
  const anchor = extra => ({
    type: 'text-range-v1', schemaVersion: 1, layer: 'source',
    start: { utf16: 0, grapheme: 0, codePoint: 0 },
    end: { utf16: 5, grapheme: 5, codePoint: 5 },
    exactText: 'שלום!',
    ...extra
  });

  assert.ok(D.normalizeSourceRange(anchor()), 'a well-formed anchor must survive');
  assert.equal(D.normalizeSourceRange(anchor({ exactText: 'א'.repeat(D.MAX_ANCHOR_EXACT_TEXT + 1) })), null);
  assert.equal(D.normalizeSourceRange(anchor({ beforeText: { raw: 'ב'.repeat(D.MAX_ANCHOR_CONTEXT + 1) } })), null);
  assert.equal(D.normalizeSourceRange(anchor({ padding: 'ג'.repeat(D.MAX_ANCHOR_BYTES) })), null);
  assert.equal(D.normalizeSourceRange(anchor({ type: 'something-else' })), null);
  assert.equal(D.normalizeSourceRange(null), null);
});

test('a highlight with an unusable anchor is rejected on load', () => {
  const record = {
    highlightId: 'marker-1', bookId: 'בראשית', sectionIndex: 0,
    sourceRange: {
      start: { utf16: 0 }, end: { utf16: 4 },
      exactText: 'א'.repeat(D.MAX_ANCHOR_EXACT_TEXT + 1)
    }
  };
  assert.equal(D.normalizeHighlight(record), null);
});

test('an export cannot be restructured through a note', () => {
  const forged = D.escapeMarkdownBlocks('## כותרת מזויפת\n---\nטקסט');
  assert.equal(forged.includes('\n---\n'), false, 'the record separator must not be forgeable');
  assert.equal(/^## /m.test(forged), false, 'a heading must not be forgeable');
  assert.equal(D.escapeMarkdownBlocks('טקסט רגיל'), 'טקסט רגיל', 'ordinary prose is left alone');
});

test('only the page may draw highlights, never a background instance', () => {
  // Host highlights are owned per instance and erased on teardown, so an
  // ephemeral background instance must never become the drawer.
  const background = D.normalizeBootContext({ app: { runMode: 'background' } });
  const page = D.normalizeBootContext({ app: { runMode: 'foreground' } });
  assert.equal(D.ownsEngine(background), false);
  assert.equal(D.ownsEngine(page), true);
  assert.equal(D.ownsEngine(undefined), true);
});

// ── Context menu payloads ───────────────────────────────────────────────────

test('the color row only carries enabled colors, in list order', () => {
  const settings = D.normalizeSettings({
    colors: [
      { id: 'a', hex: '#111111', label: 'א', enabled: false },
      { id: 'b', hex: '#222222', label: 'ב', enabled: true },
      { id: 'c', hex: '#333333', label: 'ג', enabled: true }
    ],
    defaultColorId: 'c'
  });
  const payload = D.buildColorMenuPayload(settings);
  assert.equal(payload.id, D.MENU_COLORS_ID);
  assert.equal(payload.type, 'color-row');
  assert.deepEqual(plain(payload.colors), [
    { id: 'mark-b', color: '#222222', label: 'ב' },
    { id: 'mark-c', color: '#333333', label: 'ג' }
  ]);
  assert.deepEqual(plain(payload.contexts), ['reader-selection', 'reader-page-shape-selection']);
});

test('the color row never sends `selected`', () => {
  // The host renders it as a 3px ring in the primary colour — users read that
  // as a rendering glitch, not as "this is your default colour".
  const settings = D.normalizeSettings({});
  const payload = D.buildColorMenuPayload(settings);
  assert.equal(payload.colors.every(color => !('selected' in color)), true);
});

test('no enabled color yields no payload, so an empty menu is never registered', () => {
  const settings = D.normalizeSettings({ colors: [{ id: 'a', hex: '#111111', label: 'א', enabled: false }] });
  assert.equal(D.buildColorMenuPayload(settings), null);
});

test('the menu payload is translated through the injected translator', () => {
  const settings = D.normalizeSettings({});
  const translate = value => (value === 'מרקר' ? 'Marker' : value);
  assert.equal(D.buildColorMenuPayload(settings, translate).title, 'Marker');
  const actions = D.buildHighlightMenuPayload(value => value.toUpperCase());
  assert.equal(actions.title, 'מרקר'.toUpperCase());
  assert.deepEqual(plain(actions.children.map(child => child.title)),
    ['ערוך הערה'.toUpperCase(), 'הסר סימון'.toUpperCase()]);
});

test('the highlight submenu keeps both actions in one top-level slot', () => {
  const actions = D.buildHighlightMenuPayload();
  assert.equal(actions.id, D.MENU_HIGHLIGHT_ID);
  assert.equal(actions.type, 'submenu');
  assert.deepEqual(plain(actions.contexts), ['reader-highlight']);
  assert.deepEqual(plain(actions.children.map(child => child.id)),
    [D.MENU_NOTE_ID, D.MENU_REMOVE_ID]);
  // Only the note action needs the page; removing works headlessly.
  assert.equal(actions.children[0].openPlugin, true);
  assert.equal(actions.children[1].openPlugin, undefined);
});

test('the menu signature ignores changes that the menu cannot show', () => {
  const base = D.normalizeSettings({});
  const sameMenu = D.normalizeSettings(Object.assign({}, base, {
    appearance: Object.assign({}, base.appearance, { fontSize: 25 })
  }));
  const differentMenu = D.normalizeSettings(Object.assign({}, base, { menuStyle: 'submenu' }));
  assert.equal(D.menuSignature(base, 'he'), D.menuSignature(sameMenu, 'he'));
  assert.notEqual(D.menuSignature(base, 'he'), D.menuSignature(differentMenu, 'he'));
  assert.notEqual(D.menuSignature(base, 'he'), D.menuSignature(base, 'en'));
});

test('color item ids round-trip through the menu id prefix', () => {
  assert.equal(D.colorItemId('yellow'), 'mark-yellow');
  assert.equal(D.colorIdFromItemId('mark-yellow'), 'yellow');
  assert.equal(D.colorIdFromItemId('marker-remove'), '');
  assert.equal(D.colorIdFromItemId(undefined), '');
});

// ── Selection anchoring ─────────────────────────────────────────────────────

test('a single-paragraph selection yields one target', () => {
  const targets = D.selectionTargets({
    bookId: 'בראשית', sectionIndex: 4, sourceRange: anchor(0, 10), sourceSelectedText: 'טקסט'
  });
  assert.equal(targets.length, 1);
  assert.equal(targets[0].sectionIndex, 4);
  assert.equal(targets[0].text, 'טקסט');
});

test('a multi-paragraph selection yields one target per host-anchored section', () => {
  const targets = D.selectionTargets({
    bookId: 'בראשית',
    currentIndex: 4,
    sections: [
      { sectionIndex: 4, sourceRange: anchor(5, 20), sourceSelectedText: 'א' },
      { sectionIndex: 5, sourceRange: anchor(0, 12), sourceSelectedText: 'ב' }
    ]
  });
  assert.deepEqual(plain(targets.map(target => target.sectionIndex)), [4, 5]);
});

test('sections the host could not anchor are dropped, never guessed', () => {
  const targets = D.selectionTargets({
    sections: [
      { sectionIndex: 4, sourceRange: anchor(0, 5) },
      { sectionIndex: 5, sourceRange: null },
      { sectionIndex: 6, sourceRange: { start: { utf16: 9 }, end: { utf16: 9 } } }
    ]
  });
  assert.deepEqual(plain(targets.map(target => target.sectionIndex)), [4]);
});

test('hasUsableSelection needs both a book and an anchor', () => {
  assert.equal(D.hasUsableSelection({ bookId: 'ב', sectionIndex: 0, sourceRange: anchor(0, 3) }), true);
  assert.equal(D.hasUsableSelection({ bookId: 'ב', sectionIndex: 0 }), false);
  assert.equal(D.hasUsableSelection({ sectionIndex: 0, sourceRange: anchor(0, 3) }), false);
  assert.equal(D.hasUsableSelection(null), false);
});

test('clickedHighlightIds keeps only this plugin, and only safe ids', () => {
  const ids = D.clickedHighlightIds({
    clickedHighlights: [
      { highlightId: 'marker-1', pluginId: 'com.otzaria-marker' },
      { highlightId: 'other-1', pluginId: 'com.someone.else' },
      { highlightId: '../escape', pluginId: 'com.otzaria-marker' },
      { highlightId: 'marker-2' }
    ]
  }, 'com.otzaria-marker');
  assert.deepEqual(plain(ids), ['marker-1', 'marker-2']);
});

// ── Ranges & records ────────────────────────────────────────────────────────

test('range helpers prefer utf16 and treat ranges as half-open', () => {
  assert.deepEqual(plain(D.rangeBounds(anchor(2, 5))), { start: 2, end: 5 });
  assert.equal(D.rangeBounds({ start: { utf16: 5 }, end: { utf16: 5 } }), null);
  assert.equal(D.rangesOverlap(anchor(0, 3), anchor(3, 6)), false);
  assert.equal(D.rangesOverlap(anchor(0, 3), anchor(2, 6)), true);
});

test('normalizeHighlight rejects records that cannot be re-anchored', () => {
  const valid = { highlightId: 'marker-1', bookId: 'ב', sectionIndex: 0, sourceRange: anchor(0, 3) };
  assert.notEqual(D.normalizeHighlight(valid), null);
  assert.equal(D.normalizeHighlight(Object.assign({}, valid, { sourceRange: null })), null);
  assert.equal(D.normalizeHighlight(Object.assign({}, valid, { bookId: '' })), null);
  assert.equal(D.normalizeHighlight(Object.assign({}, valid, { sectionIndex: -1 })), null);
  assert.equal(D.normalizeHighlight(Object.assign({}, valid, { highlightId: '../x' })), null);
  assert.equal(D.normalizeHighlight(null), null);
});

test('normalizeHighlight drops unknown fields so a bad import cannot spread', () => {
  const record = D.normalizeHighlight({
    highlightId: 'marker-1', bookId: 'ב', sectionIndex: 0, sourceRange: anchor(0, 3),
    evil: '<script>', __proto__: { polluted: true }
  });
  assert.equal('evil' in record, false);
  assert.equal(record.key, 'highlight:marker-1');
  assert.equal(record.status, 'active');
});

test('highlight ids are restricted to safe storage-key characters', () => {
  assert.equal(D.isSafeHighlightId('marker-book-1-yellow'), true);
  assert.equal(D.isSafeHighlightId(''), false);
  assert.equal(D.isSafeHighlightId('marker/../../settings'), false);
  assert.equal(D.isSafeHighlightId('x'.repeat(129)), false);
});

test('buildHighlightStyle keeps the host contract of #RRGGBB plus opacity', () => {
  // opacity 0 is a real request, so it clamps to the visible minimum rather
  // than falling back to the default the way a plain `|| 0.65` would.
  assert.deepEqual(plain(D.buildHighlightStyle({ hex: '#123456ff', opacity: 0, markerMode: 'underline' })), {
    backgroundColor: '#123456', opacity: 0.15, underline: true,
    borderRadius: 0, markerMode: 'underline', priority: 10
  });
  assert.equal(D.buildHighlightStyle({ hex: 'not a color' }).backgroundColor, '#FFF176');
  assert.equal(D.buildHighlightStyle({ hex: '#123456' }).opacity, 0.65, 'a missing opacity uses the default');
});

test('overlap detection pulls in every part of a grouped highlight', () => {
  const all = [
    D.normalizeHighlight({ highlightId: 'a', groupId: 'g1', bookId: 'ב', sectionIndex: 1, sourceRange: anchor(0, 5) }),
    D.normalizeHighlight({ highlightId: 'b', groupId: 'g1', bookId: 'ב', sectionIndex: 2, sourceRange: anchor(0, 5) }),
    D.normalizeHighlight({ highlightId: 'c', bookId: 'ב', sectionIndex: 9, sourceRange: anchor(0, 5) })
  ];
  const hit = D.highlightsOverlappingTargets(all, 'ב', [{ sectionIndex: 1, range: anchor(2, 4) }]);
  assert.deepEqual(plain(hit.map(item => item.highlightId)).sort(), ['a', 'b']);
});

test('a non-overlapping range in the same section is left alone', () => {
  const all = [D.normalizeHighlight({ highlightId: 'a', bookId: 'ב', sectionIndex: 1, sourceRange: anchor(0, 5) })];
  assert.equal(D.highlightsOverlappingTargets(all, 'ב', [{ sectionIndex: 1, range: anchor(6, 9) }]).length, 0);
});

// ── Tags & search ───────────────────────────────────────────────────────────

test('normalizeTags removes duplicates using Hebrew-aware normalization', () => {
  assert.deepEqual(plain(D.normalizeTags('הלכה, הַלָכָה; מוסר')), ['הלכה', 'מוסר']);
  assert.equal(D.normalizeTags(Array.from({ length: 40 }, (_, i) => `t${i}`)).length, D.MAX_TAGS_PER_HIGHLIGHT);
});

test('filtering matches nikud-insensitively across every searchable field', () => {
  const items = [
    D.normalizeHighlight({ highlightId: 'a', bookId: 'בראשית', sectionIndex: 0, sourceRange: anchor(0, 3), text: 'וַיֹּאמֶר', tags: ['אמונה'] }),
    D.normalizeHighlight({ highlightId: 'b', bookId: 'שמות', sectionIndex: 0, sourceRange: anchor(0, 3), note: 'הערה חשובה' })
  ];
  const label = () => 'צהוב';
  assert.equal(D.filterHighlights(items, { query: 'ויאמר' }, label).length, 1);
  assert.equal(D.filterHighlights(items, { query: 'חשובה' }, label).length, 1);
  assert.equal(D.filterHighlights(items, { tag: 'אמונה' }, label).length, 1);
  assert.equal(D.filterHighlights(items, { bookId: 'שמות' }, label).length, 1);
  assert.equal(D.filterHighlights(items, { status: 'favorites' }, label).length, 0);
});

test('sorting by location groups by book then section', () => {
  const make = (id, book, section, timestamp) => D.normalizeHighlight({
    highlightId: id, bookId: book, book, sectionIndex: section, sourceRange: anchor(0, 3), timestamp
  });
  const items = [make('a', 'שמות', 2, 3), make('b', 'בראשית', 5, 1), make('c', 'בראשית', 1, 2)];
  assert.deepEqual(plain(D.sortHighlights(items, 'location', () => '').map(i => i.highlightId)), ['c', 'b', 'a']);
  assert.deepEqual(plain(D.sortHighlights(items, 'newest', () => '').map(i => i.highlightId)), ['a', 'c', 'b']);
});

// ── Note sanitizing policy ──────────────────────────────────────────────────
//
// Note markup can arrive from an imported backup file, so this policy is a
// security boundary, not a formatting preference.

test('only the formatting tags are allowed through', () => {
  for (const [source, expected] of [
    ['b', 'b'], ['STRONG', 'b'], ['em', 'i'], ['i', 'i'], ['u', 'u'],
    ['s', 's'], ['strike', 's'], ['del', 's'], ['mark', 'mark'],
    ['h2', 'h2'], ['p', 'p'], ['div', 'p'], ['br', 'br'],
    ['ul', 'ul'], ['ol', 'ol'], ['li', 'li'], ['blockquote', 'blockquote'],
    ['a', 'a'], ['span', 'span'], ['font', 'span']
  ]) {
    assert.equal(D.noteTagFor(source), expected, `${source} should map to ${expected}`);
  }
});

test('every tag that could execute or embed is rejected', () => {
  const dangerous = [
    'script', 'style', 'iframe', 'object', 'embed', 'link', 'meta', 'base',
    'form', 'input', 'button', 'textarea', 'select', 'img', 'svg', 'math',
    'video', 'audio', 'source', 'template', 'noscript', 'frame', 'frameset',
    'applet', 'portal', 'marquee'
  ];
  for (const tag of dangerous) {
    assert.equal(D.noteTagFor(tag), '', `${tag} must not be allowed`);
    assert.equal(D.noteTagFor(tag.toUpperCase()), '', `${tag} must not be allowed`);
  }
  assert.equal(D.noteTagFor(''), '');
  assert.equal(D.noteTagFor(null), '');
  assert.equal(D.noteTagFor(undefined), '');
});

test('a tag name cannot smuggle itself in through the prototype chain', () => {
  // NOTE_TAGS is a plain object, so `constructor` and `toString` are lookups
  // that must not resolve to a function.
  for (const key of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
    assert.equal(D.noteTagFor(key), '');
  }
});

test('only absolute http and https links survive', () => {
  assert.equal(D.safeNoteHref('https://example.com/a'), 'https://example.com/a');
  assert.equal(D.safeNoteHref('  http://example.com  '), 'http://example.com');
  assert.equal(D.safeNoteHref('HTTPS://Example.com'), 'HTTPS://Example.com');
});

test('every scheme that could run code or leave the page is rejected', () => {
  const rejected = [
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    'java\tscript:alert(1)',
    'java\nscript:alert(1)',
    ' javascript:alert(1)',
    ' javascript:alert(1)',
    'data:text/html;base64,PHNjcmlwdD4=',
    'vbscript:msgbox(1)',
    'file:///etc/passwd',
    'otzaria://open/plugin/x',
    '//example.com',
    '/relative/path',
    'relative.html',
    '#anchor',
    'mailto:a@b.c',
    '',
    '   ',
    `https://example.com/${'a'.repeat(3000)}`
  ];
  for (const href of rejected) {
    assert.equal(D.safeNoteHref(href), '', `${JSON.stringify(href)} must be rejected`);
  }
  assert.equal(D.safeNoteHref(null), '');
  assert.equal(D.safeNoteHref({ toString: () => 'javascript:1' }), '');
});

test('only keyword font sizes survive, from either shape execCommand emits', () => {
  assert.equal(D.safeNoteFontSize('font-size: large', null), 'large');
  assert.equal(D.safeNoteFontSize('FONT-SIZE:X-LARGE;', null), 'x-large');
  assert.equal(D.safeNoteFontSize(null, '5'), 'large');
  assert.equal(D.safeNoteFontSize(null, '1'), 'xx-small');
  // A style string wins over the legacy attribute when both are present.
  assert.equal(D.safeNoteFontSize('font-size: small', '7'), 'small');
});

test('anything but a size keyword is dropped from the style attribute', () => {
  const rejected = [
    'font-size: 400px',
    'font-size: 99em',
    'position: fixed; inset: 0',
    'background: url(javascript:alert(1))',
    'behavior: url(x.htc)',
    '-moz-binding: url(x.xml)',
    'font-size: expression(alert(1))',
    ''
  ];
  for (const style of rejected) {
    assert.equal(D.safeNoteFontSize(style, null), '', `${style} must be dropped`);
  }
  assert.equal(D.safeNoteFontSize(null, '0'), '');
  assert.equal(D.safeNoteFontSize(null, '8'), '');
  assert.equal(D.safeNoteFontSize(null, 'large'), '');
});

test('a highlight keeps both the markup and its plain-text mirror', () => {
  const record = D.normalizeHighlight({
    highlightId: 'marker-1', bookId: 'ב', sectionIndex: 0, sourceRange: anchor(0, 3),
    note: 'טקסט רגיל', noteHtml: '<p>טקסט <b>מודגש</b></p>'
  });
  assert.equal(record.note, 'טקסט רגיל');
  assert.equal(record.noteHtml, '<p>טקסט <b>מודגש</b></p>');
  assert.equal(D.hasNote(record), true);
  assert.equal(D.hasNote(D.normalizeHighlight({
    highlightId: 'marker-2', bookId: 'ב', sectionIndex: 0, sourceRange: anchor(0, 3)
  })), false);
});

test('a record from before rich notes still reports as noted', () => {
  const legacy = D.normalizeHighlight({
    highlightId: 'marker-1', bookId: 'ב', sectionIndex: 0, sourceRange: anchor(0, 3),
    note: 'הערה ישנה'
  });
  assert.equal(legacy.noteHtml, '');
  assert.equal(D.hasNote(legacy), true);
});

// ── Quick filters and counts ────────────────────────────────────────────────

test('the status filters cover notes, tags, favorites and stale anchors', () => {
  const make = (id, extra) => D.normalizeHighlight(Object.assign({
    highlightId: id, bookId: 'ב', sectionIndex: 0, sourceRange: anchor(0, 3)
  }, extra));
  const items = [
    make('a', { note: 'הערה' }),
    make('b', { tags: ['אמונה'] }),
    make('c', { favorite: true }),
    make('d', { status: 'stale' }),
    make('e', {})
  ];
  const label = () => '';
  assert.equal(D.filterHighlights(items, { status: 'noted' }, label).length, 1);
  assert.equal(D.filterHighlights(items, { status: 'tagged' }, label).length, 1);
  assert.equal(D.filterHighlights(items, { status: 'favorites' }, label).length, 1);
  assert.equal(D.filterHighlights(items, { status: 'stale' }, label).length, 1);
  assert.equal(D.filterHighlights(items, { status: 'all' }, label).length, 5);
  assert.equal(D.filterHighlights(items, {}, label).length, 5);
});

test('summarize counts each cut of the data once', () => {
  const make = (id, book, extra) => D.normalizeHighlight(Object.assign({
    highlightId: id, bookId: book, sectionIndex: 0, sourceRange: anchor(0, 3), colorId: 'yellow'
  }, extra));
  const stats = D.summarize([
    make('a', 'בראשית', { note: 'x', favorite: true }),
    make('b', 'בראשית', { tags: ['t'], colorId: 'green' }),
    make('c', 'שמות', { status: 'failed_to_anchor' })
  ]);
  assert.equal(stats.total, 3);
  assert.equal(stats.books, 2);
  assert.equal(stats.noted, 1);
  assert.equal(stats.tagged, 1);
  assert.equal(stats.favorites, 1);
  assert.equal(stats.stale, 1);
  assert.equal(stats.byColor.get('yellow'), 2);
  assert.equal(stats.byColor.get('green'), 1);
});

test('the remembered view state is validated like every other setting', () => {
  const settings = D.normalizeSettings({ view: { sort: 'nonsense', group: 42, tab: 'evil' } });
  assert.deepEqual(plain(settings.view), { sort: 'newest', group: 'none', tab: 'highlights' });

  const kept = D.normalizeSettings({ view: { sort: 'color', group: 'book', tab: 'settings' } });
  assert.deepEqual(plain(kept.view), { sort: 'color', group: 'book', tab: 'settings' });
});

// ── Backup ──────────────────────────────────────────────────────────────────

test('parseBackup accepts a v1 file written by the previous plugin release', () => {
  const backup = D.parseBackup({
    format: 'otzaria-marker-backup',
    schemaVersion: 1,
    highlights: [{
      highlightId: 'marker-1', bookId: 'בראשית', sectionIndex: 3, colorId: 'yellow',
      color: '#F1E784', text: 'טקסט', sourceRange: anchor(0, 4), timestamp: 5
    }],
    settings: { menuStyle: 'submenu' }
  });
  assert.equal(backup.highlights.length, 1);
  assert.equal(backup.settings.menuStyle, 'submenu');
  assert.equal('key' in backup.highlights[0], false);
});

test('parseBackup rejects a file that is not a marker backup', () => {
  assert.throws(() => D.parseBackup({ format: 'something-else' }), /MarkerBackupError|גיבוי/);
  assert.throws(() => D.parseBackup(null), context.MarkerDomain.MarkerBackupError);
});

test('parseBackup skips broken records but keeps the good ones', () => {
  const backup = D.parseBackup({
    format: 'otzaria-marker-backup',
    schemaVersion: 2,
    highlights: [
      { highlightId: 'marker-ok', bookId: 'ב', sectionIndex: 0, sourceRange: anchor(0, 2) },
      { highlightId: 'marker-ok', bookId: 'ב', sectionIndex: 0, sourceRange: anchor(0, 2) },
      { highlightId: '', bookId: '', sectionIndex: -5 }
    ]
  });
  assert.equal(backup.highlights.length, 1);
  assert.equal(backup.skipped, 2);
});

test('planImport separates new, changed and identical records', () => {
  const existing = D.normalizeHighlight({ highlightId: 'a', bookId: 'ב', sectionIndex: 0, sourceRange: anchor(0, 3), note: 'ישן' });
  const identical = D.normalizeHighlight({ highlightId: 'a', bookId: 'ב', sectionIndex: 0, sourceRange: anchor(0, 3), note: 'ישן' });
  const changed = D.normalizeHighlight({ highlightId: 'a', bookId: 'ב', sectionIndex: 0, sourceRange: anchor(0, 3), note: 'חדש' });
  const added = D.normalizeHighlight({ highlightId: 'b', bookId: 'ב', sectionIndex: 1, sourceRange: anchor(0, 3) });

  assert.equal(D.planImport([existing], [identical]).identical.length, 1);
  assert.equal(D.planImport([existing], [changed]).updated.length, 1);
  assert.equal(D.planImport([existing], [added]).added.length, 1);
});

// ── Escaping ────────────────────────────────────────────────────────────────

test('escapeHtml neutralizes every character that could break out of markup', () => {
  assert.equal(D.escapeHtml('<img src=x onerror="alert(1)">'),
    '&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
  assert.equal(D.escapeHtml("it's"), 'it&#39;s');
  assert.equal(D.escapeHtml(null), '');
});
