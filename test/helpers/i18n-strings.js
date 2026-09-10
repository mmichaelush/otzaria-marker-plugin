'use strict';

/**
 * Collects every user-facing Hebrew string in the plugin.
 *
 * Hebrew is the source language and doubles as the lookup key, so the set of
 * keys a catalog must cover is derivable from the code itself. `i18n.test.js`
 * uses this to fail whenever a new string is added without a translation.
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const HEBREW = /[֐-׿]/;

const JS_SOURCES = ['js/marker-core.js', 'js/marker-ui.js'];
const HTML_SOURCES = ['index.html'];

/**
 * Strings the scanners cannot see, because they reach `t()` through a
 * variable. Kept short on purpose — anything longer belongs in a literal.
 */
const DYNAMIC_STRINGS = Object.freeze([
  // marker-ui.js → COLOR_PRESETS, translated as `t(name)`
  'מרווה', 'משמש', 'זהב', 'לימון', 'שמיים', 'לבנדר', 'ורוד', 'סגלגל',
  // marker-domain.js → DEFAULT_SETTINGS.colors, translated as `t(color.label)`
  'צהוב', 'ירוק', 'כחול', 'אדום', 'כתום', 'סגול', 'צבע',
  // marker-domain.js → MarkerBackupError, translated as `t(error.messageKey)`
  'זה אינו קובץ גיבוי תקין של מרקר',
  'גרסת קובץ הגיבוי אינה נתמכת',
  'כמות ההדגשות בקובץ אינה תקינה',
  'לא נמצאה בקובץ אף הדגשה תקינה'
]);

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

/**
 * `t('…')` calls, plus the two indirect translation points in the domain
 * module: `translate('…')` (the injected translator used to build menu
 * payloads) and `new MarkerBackupError('…')` (message keys re-translated by
 * the caller).
 */
function stringsFromJs(source) {
  const found = [];
  const patterns = [
    /\bt\(\s*'((?:[^'\\]|\\.)*)'/g,
    /\bt\(\s*"((?:[^"\\]|\\.)*)"/g,
    /\btranslate\(\s*'((?:[^'\\]|\\.)*)'/g,
    /\bMarkerBackupError\(\s*'((?:[^'\\]|\\.)*)'/g
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) found.push(match[1]);
  }
  return found.map(value => value.replace(/\\'/g, "'").replace(/\\"/g, '"'));
}

/** `data-i18n` element text and `data-i18n-attr` attribute values. */
function stringsFromHtml(source) {
  const found = [];
  const elementPattern = /<([a-z0-9]+)\b[^>]*\bdata-i18n\b(?![-a-z])[^>]*>([\s\S]*?)<\/\1>/gi;
  for (const match of source.matchAll(elementPattern)) found.push(match[2].trim());

  const attrHostPattern = /<[a-z0-9]+\b([^>]*\bdata-i18n-attr="([^"]+)"[^>]*)>/gi;
  for (const match of source.matchAll(attrHostPattern)) {
    for (const rawName of match[2].split(',')) {
      const name = rawName.trim();
      if (!name) continue;
      const value = new RegExp(`\\b${name}="([^"]*)"`).exec(match[1]);
      if (value) found.push(value[1]);
    }
  }
  return found;
}

/** Every Hebrew string that a catalog is expected to translate. */
function collectSourceStrings() {
  const strings = new Set(DYNAMIC_STRINGS);
  for (const file of [...JS_SOURCES, 'js/marker-domain.js']) {
    stringsFromJs(read(file)).forEach(value => strings.add(value));
  }
  for (const file of HTML_SOURCES) stringsFromHtml(read(file)).forEach(value => strings.add(value));
  return [...strings].filter(value => HEBREW.test(value)).sort();
}

module.exports = {
  ROOT, read, DYNAMIC_STRINGS, collectSourceStrings, stringsFromJs, stringsFromHtml
};
