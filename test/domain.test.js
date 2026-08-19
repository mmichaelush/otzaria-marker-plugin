const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '..', 'js', 'marker-domain.js'), 'utf8');
const context = { console, crypto: undefined, globalThis: {} };
context.globalThis = context;
vm.runInNewContext(source, context, { filename: 'marker-domain.js' });
const domain = context.MarkerDomain;

test('normalizeSettings clamps values and preserves supported shape', () => {
  const settings = domain.normalizeSettings({
    menuStyle: 'invalid',
    colors: [{ id: 'bad id!', hex: '#12345678', label: 'x'.repeat(80), enabled: 1, opacity: 9, borderRadius: -2 }],
    appearance: { fontSize: 100, lineHeight: 0.1, viewMode: 'unknown' },
    exportTemplate: { format: 'unknown', includeDate: false }
  });
  assert.equal(settings.menuStyle, 'buttonRow');
  assert.equal(settings.colors[0].id, 'bad-id-');
  assert.equal(settings.colors[0].label.length, 24);
  assert.equal(settings.colors[0].opacity, 1);
  assert.equal(settings.colors[0].borderRadius, 0);
  assert.equal(settings.appearance.fontSize, 26);
  assert.equal(settings.appearance.lineHeight, 1.2);
  assert.equal(settings.exportTemplate.includeDate, false);
  assert.equal(domain.normalizeSettings({ colors: [{ id: 'square', borderRadius: 0 }] }).colors[0].borderRadius, 0);
});

test('normalizeTags removes duplicates using Hebrew-aware normalization', () => {
  assert.equal(JSON.stringify(domain.normalizeTags('הלכה, הַלָכָה; מוסר')), JSON.stringify(['הלכה', 'מוסר']));
});

test('range helpers use utf16 first and detect half-open overlap', () => {
  assert.equal(JSON.stringify(domain.rangeBounds({ start: { utf16: 2 }, end: { utf16: 5 } })), JSON.stringify({ start: 2, end: 5 }));
  assert.equal(domain.rangesOverlap({ start: { utf16: 0 }, end: { utf16: 3 } }, { start: { utf16: 3 }, end: { utf16: 6 } }), false);
  assert.equal(domain.rangesOverlap({ start: { utf16: 0 }, end: { utf16: 3 } }, { start: { utf16: 2 }, end: { utf16: 6 } }), true);
});

test('selection and style helpers are deterministic at their boundaries', () => {
  assert.equal(domain.selectedTextOf({ renderedSelectedText: 'abc' }), 'abc');
  assert.equal(domain.hasUsableSelection({ bookId: 'book', sectionIndex: 0, text: 'x' }), true);
  assert.equal(domain.hasUsableSelection({ bookId: 'book', sectionIndex: 0, text: '   ' }), false);
  assert.equal(JSON.stringify(domain.buildHighlightStyle({ hex: '#123456ff', opacity: 0, markerMode: 'underline' })), JSON.stringify({
    backgroundColor: '#123456', opacity: 0.65, underline: true, borderRadius: 0, markerMode: 'underline', priority: 10
  }));
});

test('host compatibility stays on the 0.9.96 path unless newer fields are reported', () => {
  const legacy = domain.normalizeBootContext({
    app: { version: '0.9.96+741', locale: 'he-IL', textDirection: 'rtl', runMode: 'foreground' }
  });
  assert.equal(legacy.appVersion, '0.9.96+741');
  assert.equal(legacy.language, 'he');
  assert.equal(legacy.capabilities.declarativeStartup, true);
  assert.equal(legacy.capabilities.interfaceLanguage, false);
  assert.equal(legacy.capabilities.backgroundDone, false);
  assert.equal(domain.ownsLegacyRuntime(legacy, []), true);
  assert.equal(domain.ownsLegacyRuntime(legacy, ['app.run_on_startup']), false);

  const future = domain.normalizeBootContext({
    app: { version: '0.9.97', locale: 'en', language: 'en', textDirection: 'ltr', runMode: 'background' }
  });
  assert.equal(future.language, 'en');
  assert.equal(future.textDirection, 'ltr');
  assert.equal(future.capabilities.interfaceLanguage, true);
  assert.equal(future.capabilities.backgroundDone, true);
  assert.equal(domain.ownsLegacyRuntime(future, ['app.run_on_startup']), true);
});

test('highlight ids are restricted to safe storage-key characters', () => {
  assert.equal(domain.isSafeHighlightId('marker-book-1-yellow'), true);
  assert.equal(domain.isSafeHighlightId(''), false);
  assert.equal(domain.isSafeHighlightId('marker/../../settings'), false);
  assert.equal(domain.isSafeHighlightId('x'.repeat(129)), false);
});
