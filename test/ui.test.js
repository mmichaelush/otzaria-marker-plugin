const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

/**
 * Static contract checks for the page.
 *
 * There is no DOM in these tests, so they cannot exercise behaviour — but they
 * can prove the wiring is consistent: every id the script reaches for exists,
 * every element the script writes into is declared once, and the stylesheet
 * defines every class the markup uses. Those are exactly the mistakes a
 * refactor introduces and a Node test would otherwise miss entirely.
 */

const ROOT = path.join(__dirname, '..');
const read = relativePath => fs.readFileSync(path.join(ROOT, relativePath), 'utf8');

const HTML = read('index.html');
const D = (() => {
  const context = { globalThis: null };
  context.globalThis = context;
  vm.runInNewContext(read('js/marker-domain.js'), context, { filename: 'marker-domain.js' });
  return context.MarkerDomain;
})();
const UI = read('js/marker-ui.js');
const CSS = read('css/style.css');

function htmlIds() {
  return [...HTML.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
}

function selectedIds() {
  return new Set([...UI.matchAll(/\$\(\s*'#([A-Za-z0-9_-]+)'/g)].map(match => match[1]));
}

test('every id the page script selects exists in the markup', () => {
  const declared = new Set(htmlIds());
  const missing = [...selectedIds()].filter(id => !declared.has(id)).sort();
  assert.deepEqual(missing, [], `selected but not declared: ${missing.join(', ')}`);
});

test('ids are unique', () => {
  const ids = htmlIds();
  const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
  assert.deepEqual([...new Set(duplicates)], []);
});

test('the ids addressed through a template string are declared too', () => {
  // `scheduleAutoSave` resolves `#${statusId}` at run time, so a status
  // element is invisible to the selector scan above.
  for (const id of ['preferencesAutoSaveStatus']) {
    assert.equal(HTML.includes(`id="${id}"`), true, `${id} is missing`);
    assert.equal(UI.includes(`'${id}'`), true, `${id} is never passed to scheduleAutoSave`);
  }
});

test('the colours tab saves silently, but never fails silently', () => {
  // Its controls show their own result — swatch, preview strip, menu badge —
  // so a "saved automatically ✓" line on top of that was noise. The failure
  // path still has to reach the user, and with no status element the only
  // route left is a message.
  assert.equal(HTML.includes('id="colorsAutoSaveStatus"'), false);
  assert.match(UI, /const COLORS_AUTOSAVE = null;/);
  assert.match(UI, /scheduleAutoSave\(collectColorsFromForm, COLORS_AUTOSAVE/);
  assert.match(UI, /if \(!status\) \{\s*await notify\.error\(/,
    'a save that fails with no status element must say so another way');
});

test('the shade popover can be dismissed, and applying a shade dismisses it', () => {
  // It is a `<details>` pinned to the middle of the screen. Without a close
  // button the only way out was a second click on the trigger behind it.
  assert.match(UI, /data-action="close-picker"/);
  assert.match(UI, /case 'close-picker':/);
  const closes = (UI.match(/closePicker\(\);/g) || []).length;
  assert.ok(closes >= 3, `apply, preset and the close button must all close it (saw ${closes})`);
  assert.match(UI, /picker\.open = false/);
});

test('the note link bar is only ever hidden through resetLinkBar', () => {
  // #noteLinkUrl is a type="url" inside #editHighlightForm. Hidden while
  // enabled and holding an invalid value, it makes the whole form
  // un-submittable over a control the browser cannot focus — saving a note
  // dies silently for the rest of the session. resetLinkBar is what disables
  // it, so every path that hides the bar has to go through it.
  const hides = [...UI.matchAll(/\$\('#noteLinkBar'\)\.hidden = true/g)];
  assert.equal(hides.length, 1, 'a second place hides the bar without resetting it');
  const guard = /function resetLinkBar\(\) \{[\s\S]*?input\.disabled = true;[\s\S]*?hidden = true/;
  assert.match(UI, guard, 'resetLinkBar must disable the input, not just hide the bar');
  assert.match(UI, /function closeEditDialog\(\) \{\s*resetLinkBar\(\);/,
    'closing the edit dialog must reset the bar too');
});

test('the chosen default color survives the trip back through the form', () => {
  // The auto-save re-collects from the markup when the debounce fires, so a
  // default held only in a variable would be dropped on the way out.
  assert.match(UI, /data-default="\$\{isDefault\}"/,
    'the row must carry its default flag in the markup');
  assert.match(UI, /row\.dataset\.default === 'true'/,
    'collectColorsFromForm must read the flag back');
  assert.match(UI, /data-action="make-default"/);
  assert.match(UI, /case 'make-default'/);
});

test('every text-entry field gets the app field styling', () => {
  // The rule used to list the types it covered, and quietly missed `email`
  // and `url` — the report address and the note link rendered with the
  // browser's own square border in the middle of a rounded form. Written as
  // an exclusion, it covers whatever type is added next.
  const NON_TEXT = new Set([
    'checkbox', 'radio', 'range', 'file', 'button', 'submit', 'reset', 'image'
  ]);
  const used = new Set(
    [...`${HTML}\n${UI}`.matchAll(/<input[^>]*\btype="([a-z]+)"/g)].map(match => match[1])
  );
  const textEntry = [...used].filter(type => !NON_TEXT.has(type));
  assert.ok(textEntry.length > 0, 'the markup scan found no fields');

  const rule = /(?:^|\n)select,\s*\ntextarea,\s*\n(input:not\([^{]*?)\s*\{/.exec(CSS);
  assert.ok(rule, 'the base field rule must stay an exclusion, not a list of types');
  const excluded = new Set([...rule[1].matchAll(/:not\(\[type="([a-z]+)"\]\)/g)].map(m => m[1]));
  for (const type of textEntry) {
    assert.equal(excluded.has(type), false, `input[type="${type}"] is left unstyled`);
  }
});

test('the status filter offers exactly the statuses the domain knows', () => {
  // A value in the markup that `matchesStatus` does not know falls through
  // its `default` and silently shows everything — a filter that looks
  // applied and filters nothing.
  const select = /<select id="statusFilter"[\s\S]*?<\/select>/.exec(HTML)?.[0] || '';
  const values = [...select.matchAll(/value="([^"]+)"/g)].map(match => match[1]);
  assert.deepEqual(values.sort(), [...D.STATUS_FILTERS].sort());
});

test('every tab button has a matching panel', () => {
  const tabs = [...HTML.matchAll(/class="tab[^"]*" type="button" data-tab="([^"]+)"/g)].map(m => m[1]);
  const panels = [...HTML.matchAll(/data-panel="([^"]+)"/g)].map(m => m[1]);
  assert.deepEqual(tabs.sort(), panels.sort());
  assert.ok(tabs.length >= 4);
});

test('the tab grid matches the number of tabs', () => {
  const tabs = [...HTML.matchAll(/data-tab="([^"]+)"/g)].length;
  const columns = [...CSS.matchAll(/\.tabs\s*\{[^}]*?grid-template-columns:\s*repeat\((\d+)/g)]
    .map(match => Number(match[1]));
  assert.ok(columns.length > 0, 'the tab grid rule moved');
  for (const count of columns) {
    assert.equal(count, tabs, `a .tabs rule still lays out ${count} columns for ${tabs} tabs`);
  }
});

test('the stylesheet defines every class the markup uses', () => {
  const used = new Set();
  for (const match of HTML.matchAll(/\bclass="([^"]+)"/g)) {
    for (const name of match[1].split(/\s+/)) if (name) used.add(name);
  }
  // Classes the script adds at run time, plus state classes toggled in JS.
  const runtimeClasses = new Set(['active', 'dark-mode', 'is-selected', 'is-disabled',
    'drag-dragging', 'drag-over', 'fade-in', 'otz-native-select', 'danger-action']);
  const missing = [...used]
    .filter(name => !runtimeClasses.has(name))
    .filter(name => !CSS.includes(`.${name}`))
    .sort();
  assert.deepEqual(missing, [], `classes with no style: ${missing.join(', ')}`);
});

test('the stylesheet has no rules for classes nothing uses', () => {
  // The reverse of the check above. Dead CSS survives refactors silently and
  // is the main reason a stylesheet grows without anyone noticing — the rewrite
  // left 19 rules behind from the UI the old app.js drove.
  const consumers = ['index.html', 'js/marker-ui.js', 'js/marker-richtext.js']
    .map(read).join('\n');
  const declared = new Set([...CSS.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)].map(match => match[1]));
  const orphans = [...declared]
    .filter(name => !new RegExp(`\\b${name.replace(/-/g, '\\-')}\\b`).test(consumers))
    .sort();
  assert.deepEqual(orphans, [], `stylesheet classes nothing references: ${orphans.join(', ')}`);
});

test('the stylesheet passes the store design check', () => {
  // The store refuses the "מראה תואם לאוצריא" tag over any of these, and the
  // publish fails with HTTP 400 — after the merge has already landed. The
  // packaging validator only reports them as notices, so this is the only
  // place the rule is enforced before it costs a release.
  //
  // Mirrors PluginExtendedValidator._checkDesignCompliance. Custom property
  // *definitions* are stripped first: an absolute value is allowed there,
  // because that is the default applyTheme overwrites.
  const scanned = CSS
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/--[a-zA-Z_][\w-]*\s*:\s*[^;}]+;?/g, '');

  const hex = [...scanned.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map(match => match[0]);
  assert.deepEqual(hex, [], 'hard-coded hex colors — use var(--color-*)');

  assert.equal(/\b(?:rgb|rgba|hsl|hsla)\s*\(/.test(scanned), false,
    'hard-coded rgb()/hsl() — use var(--color-*)');

  for (const match of scanned.matchAll(/font-family\s*:\s*([^;}]+)/gi)) {
    assert.match(match[1], /var\(\s*--font/i, `font-family must be a token: ${match[1].trim()}`);
  }

  for (const match of scanned.matchAll(/border-radius\s*:\s*([^;}]+)/gi)) {
    const value = match[1].trim();
    if (/var\(/.test(value) || /^0(?:px)?(?:\s+0(?:px)?)*$/.test(value)) continue;
    if (/^\d+(?:\.\d+)?\s*%$/.test(value)) continue;
    assert.equal(/\d+\s*px/i.test(value), false,
      `border-radius must be a token: ${value}`);
  }

  // font-size in px is allowed only under a top-bar selector, which the app
  // requires so the bar does not grow with the reading font.
  const selectorAt = index => {
    const open = scanned.lastIndexOf('{', index);
    if (open < 0) return '';
    const previous = Math.max(scanned.lastIndexOf('}', open), scanned.lastIndexOf('{', open - 1));
    return scanned.slice(previous + 1, open).trim();
  };
  for (const match of scanned.matchAll(/font-size\s*:\s*([^;}]+)/gi)) {
    const value = match[1].trim();
    if (/var\(/.test(value) || !/\d+\s*px/i.test(value)) continue;
    if (/^0(?:px)?$/.test(value)) continue;
    assert.match(selectorAt(match.index), /top-?bar/i,
      `font-size in px outside the top bar: ${value}`);
  }
});

test('the stylesheet has balanced braces', () => {
  let depth = 0;
  for (const character of CSS) {
    if (character === '{') depth++;
    if (character === '}') depth--;
    assert.ok(depth >= 0, 'a stray closing brace');
  }
  assert.equal(depth, 0);
});

test('the page loads its scripts in dependency order', () => {
  const order = [...HTML.matchAll(/<script src="([^"]+)"><\/script>/g)].map(match => match[1]);
  assert.deepEqual(order, [
    'js/marker-domain.js',
    'js/marker-i18n.js',
    'i18n/en.js',
    'js/marker-runtime.js',
    'js/marker-richtext.js',
    'js/marker-core.js',
    'js/marker-ui.js'
  ]);
});

test('the engine is started exactly once, by the page script', () => {
  assert.equal((UI.match(/Core\.start\(\)/g) || []).length, 1);
  assert.equal(HTML.includes('MarkerCore.start()'), false, 'the page must start via marker-ui.js');
});

test('every form is wired up, and each one has a submit handler', () => {
  const forms = [...HTML.matchAll(/<form id="([^"]+)"/g)].map(match => match[1]);
  assert.ok(forms.length >= 4);
  for (const form of forms) {
    assert.ok(UI.includes(`'#${form}'`), `#${form} is never referenced by the page script`);
  }
  // A form without a submit handler reloads the WebView on Enter, which would
  // silently discard whatever the user was doing.
  const submitHandlers = (UI.match(/addEventListener\('submit'/g) || []).length;
  assert.ok(submitHandlers >= forms.length,
    `${forms.length} forms but only ${submitHandlers} submit handlers`);
});

test('every dialog can be dismissed without submitting', () => {
  const dialogs = [...HTML.matchAll(/<dialog id="([^"]+)"/g)].map(match => match[1]);
  assert.ok(dialogs.length >= 2);
  for (const dialog of dialogs) {
    assert.match(UI, new RegExp(`#${dialog}`), `#${dialog} is never referenced`);
  }
  assert.match(UI, /#closeEditDialogBtn'\)\.addEventListener\('click'/);
  assert.match(UI, /#closeAddColorDialogBtn'\)\.addEventListener\('click'/);
});

test('the accessible name of an icon-only control is translated, not hard-coded', () => {
  // An icon button with no text needs aria-label, and that label must be
  // marked for translation or the English UI keeps a Hebrew screen-reader name.
  const iconButtons = [...HTML.matchAll(/<button[^>]*class="[^"]*icon-btn[^"]*"[^>]*>/g)].map(m => m[0]);
  assert.ok(iconButtons.length > 0);
  for (const button of iconButtons) {
    assert.match(button, /aria-label="/, `an icon button has no aria-label: ${button}`);
    assert.match(button, /data-i18n-attr="[^"]*aria-label/, `an aria-label is not translated: ${button}`);
  }
});

test('range inputs expose their current value through an output', () => {
  for (const id of ['fontSize', 'lineHeight']) {
    assert.match(HTML, new RegExp(`<output id="${id}Value" for="${id}">`));
  }
});
