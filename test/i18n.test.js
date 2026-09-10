const assert = require('node:assert/strict');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const { ROOT, read, collectSourceStrings } = require('./helpers/i18n-strings.js');

function loadI18n(language) {
  const context = { console, document: undefined, globalThis: {} };
  context.globalThis = context;
  for (const file of ['js/marker-domain.js', 'js/marker-i18n.js', 'i18n/en.js']) {
    vm.runInNewContext(read(file), context, { filename: path.basename(file) });
  }
  if (language) context.MarkerI18n.configure(language);
  return context;
}

const PLACEHOLDER = /\{(\w+)\}/g;

function placeholders(value) {
  return [...String(value).matchAll(PLACEHOLDER)].map(match => match[1]).sort();
}

test('the English catalog covers every source string', () => {
  const { MARKER_TRANSLATIONS } = loadI18n();
  const missing = collectSourceStrings().filter(key => !(key in MARKER_TRANSLATIONS.en));
  assert.deepEqual(missing, [], `untranslated strings:\n${missing.join('\n')}`);
});

test('the English catalog has no entries the code no longer uses', () => {
  const { MARKER_TRANSLATIONS } = loadI18n();
  const known = new Set(collectSourceStrings());
  const stale = Object.keys(MARKER_TRANSLATIONS.en).filter(key => !known.has(key));
  assert.deepEqual(stale, [], `stale catalog entries:\n${stale.join('\n')}`);
});

test('the catalog has no duplicate keys', () => {
  // A repeated key in an object literal is legal JavaScript: the last one
  // silently wins, so the earlier translation is dead code nobody notices.
  const keys = [...read('i18n/en.js').matchAll(/^ {4}'((?:[^'\\]|\\.)*)':/gm)]
    .map(match => match[1]);
  const duplicates = [...new Set(keys.filter((key, index) => keys.indexOf(key) !== index))];
  assert.deepEqual(duplicates, [], `duplicate catalog keys: ${duplicates.join(', ')}`);
  assert.ok(keys.length > 300, 'the key scan stopped matching the file layout');
});

test('every translation keeps the placeholders of its source string', () => {
  const { MARKER_TRANSLATIONS } = loadI18n();
  for (const [source, translation] of Object.entries(MARKER_TRANSLATIONS.en)) {
    assert.deepEqual(
      placeholders(translation),
      placeholders(source),
      `placeholder mismatch for "${source}"`
    );
  }
});

test('no translation is left as the untranslated Hebrew source', () => {
  const { MARKER_TRANSLATIONS } = loadI18n();
  const untranslated = Object.entries(MARKER_TRANSLATIONS.en)
    .filter(([source, translation]) => source === translation)
    .map(([source]) => source);
  assert.deepEqual(untranslated, []);
});

test('t falls back to Hebrew for an unknown key and interpolates variables', () => {
  const { MarkerI18n } = loadI18n('en');
  assert.equal(MarkerI18n.language, 'en');
  assert.equal(MarkerI18n.t('מחרוזת שאינה בקטלוג'), 'מחרוזת שאינה בקטלוג');
  assert.equal(MarkerI18n.t('{count} נבחרו', { count: 3 }), '3 selected');
  assert.equal(MarkerI18n.t('{count} נבחרו'), '{count} selected');
});

test('resolveLanguage prefers an explicit choice and ignores languages without a catalog', () => {
  const { MarkerI18n } = loadI18n();
  assert.equal(MarkerI18n.resolveLanguage('auto', 'en'), 'en');
  assert.equal(MarkerI18n.resolveLanguage('he', 'en'), 'he');
  assert.equal(MarkerI18n.resolveLanguage('en', 'he'), 'en');
  assert.equal(MarkerI18n.resolveLanguage('auto', 'fr'), 'he');
  assert.equal(MarkerI18n.resolveLanguage('auto', 'en-US'), 'en');
  assert.equal(MarkerI18n.resolveLanguage(undefined, undefined), 'he');
});

test('configure reports a change once and notifies subscribers', () => {
  const { MarkerI18n } = loadI18n();
  const seen = [];
  MarkerI18n.onChange((language, direction) => seen.push([language, direction]));
  assert.equal(MarkerI18n.configure('en'), true);
  assert.equal(MarkerI18n.configure('en'), false);
  assert.equal(MarkerI18n.direction, 'ltr');
  assert.equal(MarkerI18n.configure('he'), true);
  assert.equal(MarkerI18n.direction, 'rtl');
  assert.deepEqual(seen, [['en', 'ltr'], ['he', 'rtl']]);
});

test('the HTML keeps the Hebrew source markup the packaging validator requires', () => {
  const html = read('index.html');
  assert.match(html, /<html dir="rtl" lang="he">/);
  // Every translated element must carry a marker; a bare Hebrew <span> in the
  // shell would silently stay Hebrew in the English UI.
  assert.match(html, /data-i18n>/);
  assert.match(html, /data-i18n-attr="/);
  assert.equal(html.includes('i18n/en.js'), true);
});

test('the catalog is loaded before anything that translates', () => {
  // The menu titles are built in marker-core.js through the injected `t`, so
  // the catalog has to be in place before the core script runs.
  const html = read('index.html');
  const order = ['js/marker-i18n.js', 'i18n/en.js', 'js/marker-core.js']
    .map(script => html.indexOf(script));
  assert.ok(order.every(index => index > 0), 'a translation script is missing');
  assert.deepEqual(order, [...order].sort((a, b) => a - b));
});

test('the packaged plugin ships the catalog', () => {
  const otzignore = read('.otzignore');
  const ignored = otzignore.split(/\r?\n/).map(line => line.trim());
  assert.equal(ignored.includes('i18n/'), false);
  assert.equal(require('node:fs').existsSync(path.join(ROOT, 'i18n', 'en.js')), true);
});
