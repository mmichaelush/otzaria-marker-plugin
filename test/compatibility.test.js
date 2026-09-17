const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.join(__dirname, '..');
const read = relativePath => fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
const readJson = relativePath => JSON.parse(read(relativePath).replace(/^﻿/, ''));

const { validateMenuItem, validateToolbarItem } = require('./helpers/harness.js');

const MANIFEST = readJson('manifest.json');
const TARGET_VERSION = '0.9.97';
const SOURCES = [
  'js/marker-domain.js', 'js/marker-i18n.js', 'js/marker-runtime.js',
  'js/marker-richtext.js', 'js/marker-core.js', 'js/marker-ui.js',
  'js/marker-background.js'
];

/**
 * The Otzaria version each API used here was introduced in, and the permission
 * it needs. Mirrors the API version table in the SDK docs
 * (`docs/plugin-sdk/API_REFERENCE.md` § טבלת גרסאות API); the host blocks
 * packaging when a call is newer than the declared `minAppVersion`, so this
 * table is what keeps the manifest honest before that check ever runs.
 *
 * `null` means the call needs no permission.
 */
const API = {
  'app.openUrl': { since: '0.9.95', permission: 'app.open_url' },
  'feedback.report': { since: '0.9.97', permission: null },
  'feedback.hasReporterEmail': { since: '0.9.97', permission: null },
  'fonts.resolveFamilies': { since: '0.9.97', permission: null },
  'fs.abortBinaryWrite': { since: '0.9.97', permission: 'fs.user_files.write' },
  'fs.beginBinaryWrite': { since: '0.9.97', permission: 'fs.user_files.write' },
  'fs.commitUserFileWrite': { since: '0.9.97', permission: 'fs.user_files.write' },
  'fs.deleteEntry': { since: '0.9.97', permission: null },
  'fs.listDir': { since: '0.9.97', permission: null },
  'fs.pickUserFile': { since: '0.9.94', permission: 'fs.user_files.read' },
  'fs.readFile': { since: '0.9.97', permission: null },
  'fs.readTextFile': { since: '0.9.94', permission: 'fs.user_files.read' },
  'fs.revokeFile': { since: '0.9.94', permission: 'fs.user_files.read' },
  'fs.writeFile': { since: '0.9.97', permission: null },
  'plugin.openSelf': { since: '0.9.96', permission: 'navigation.write' },
  'reader.addContextMenuItem': { since: '0.9.89', permission: 'reader.context_menu' },
  'reader.addToolbarItem': { since: '0.9.97', permission: 'reader.toolbar' },
  'reader.clearAllHighlights': { since: '0.9.89', permission: 'reader.highlight' },
  'reader.clearHighlight': { since: '0.9.89', permission: 'reader.highlight' },
  'reader.getHighlightCapabilities': { since: '0.9.97', permission: 'reader.open' },
  'reader.getHighlights': { since: '0.9.89', permission: 'reader.highlight' },
  'reader.getCurrentRef': { since: '0.9.89', permission: 'reader.open' },
  'reader.getSelection': { since: '0.9.89', permission: 'reader.open' },
  'reader.openBook': { since: '0.9.89', permission: 'reader.open' },
  'reader.openBookAtRef': { since: '0.9.89', permission: 'reader.open' },
  'reader.removeContextMenuItem': { since: '0.9.89', permission: 'reader.context_menu' },
  'reader.revealHighlight': { since: '0.9.96', permission: 'reader.highlight' },
  'reader.scrollToSection': { since: '0.9.97', permission: 'reader.open' },
  'reader.setHighlight': { since: '0.9.89', permission: 'reader.highlight' },
  'reader.updateContextMenuItem': { since: '0.9.95', permission: 'reader.context_menu' },
  'reader.updateHighlight': { since: '0.9.95', permission: 'reader.highlight' },
  'reader.updateToolbarItem': { since: '0.9.97', permission: 'reader.toolbar' },
  'settings.getMany': { since: '0.9.89', permission: 'settings.read' },
  'shortcut.create': { since: '0.9.94', permission: 'ui.create_shortcut' },
  'storage.get': { since: '0.9.89', permission: 'plugin.storage.read' },
  'storage.list': { since: '0.9.89', permission: 'plugin.storage.read' },
  'storage.remove': { since: '0.9.89', permission: 'plugin.storage.write' },
  'storage.set': { since: '0.9.89', permission: 'plugin.storage.write' },
  'ui.showError': { since: '0.9.89', permission: 'ui.feedback' },
  'ui.showMessage': { since: '0.9.89', permission: 'ui.feedback' },
  'ui.showSuccess': { since: '0.9.89', permission: 'ui.feedback' },
  'ui.showWarning': { since: '0.9.89', permission: 'ui.feedback' },
  // The system "save as" dialog is the consent gate, so this needs no
  // permission — but it does need a transient user activation.
  'ui.exportPdf': { since: '0.9.97', permission: null },
  'ui.setUnsavedChanges': { since: '0.9.97', permission: null }
};

/**
 * Calls the host only honours when invoked straight from a user gesture,
 * mapped to the `MarkerCore` function that wraps each one.
 *
 * `ui.print` is deliberately not used: it opens the bare operating-system
 * dialog with no preview. Printing goes through `window.print()`, which opens
 * the engine's own print window inside Otzaria.
 */
const USER_GESTURE_ONLY = Object.freeze({
  'ui.exportPdf': 'exportPdf'
});

/**
 * Granted to every plugin from 0.9.97 onwards. Declaring them is tolerated for
 * backwards compatibility but raises a validator warning, so the manifest must
 * stay clear of them.
 */
const BASELINE_PERMISSIONS = new Set([
  'plugin.storage.read', 'plugin.storage.write', 'app.info.read',
  'ui.feedback', 'notifications.send', 'events.subscribe:theme.changed'
]);

/** Events that reach only the plugin that caused them — no subscribe needed. */
const UNSCOPED_EVENTS = new Set([
  'plugin.boot', 'plugin.ready', 'plugin.suspended', 'plugin.resumed',
  'plugin.page_opened', 'app.command',
  'contextMenu.colorClicked', 'contextMenu.itemClicked',
  'reader.context_menu_item_clicked', 'reader.toolbar_item_clicked',
  'ui.messageClicked'
]);

function compareVersions(a, b) {
  const parse = value => String(value).match(/^(\d+)\.(\d+)\.(\d+)/).slice(1).map(Number);
  const left = parse(a);
  const right = parse(b);
  for (let index = 0; index < 3; index++) {
    if (left[index] !== right[index]) return left[index] > right[index] ? 1 : -1;
  }
  return 0;
}

function allSource() {
  return SOURCES.map(read).join('\n');
}

/** Layering checks look at code, not at the prose that describes it. */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function usedMethods() {
  const source = allSource();
  return [...new Set([...source.matchAll(/\bcall(?:Soft|Raw)?\(\s*'([a-zA-Z.]+)'/g)]
    .map(match => match[1]))].sort();
}

function subscribedEvents() {
  const source = allSource();
  return [...new Set([...source.matchAll(/\bR\.on\(\s*'([a-zA-Z._]+)'/g)]
    .map(match => match[1]))].sort();
}

// ── Manifest ────────────────────────────────────────────────────────────────

test('the manifest targets Otzaria 0.9.97 and is valid for 0.9.98', () => {
  assert.equal(MANIFEST.minAppVersion, TARGET_VERSION);
  assert.equal(MANIFEST.schemaVersion, 1);
  assert.equal(MANIFEST.sdkVersion, '1.x');
  assert.match(MANIFEST.version, /^\d+\.\d+\.\d+$/);
  assert.ok(MANIFEST.name.length <= 14, 'the tool tab caps the name at 14 characters');
  assert.equal(MANIFEST.contributes.toolTab.title, MANIFEST.name);
  assert.ok(MANIFEST.description.length <= 150);
  assert.ok(['stable', 'beta', 'experimental'].includes(MANIFEST.stability));
  assert.equal(MANIFEST.maxAppVersion, undefined, 'nothing here breaks on a newer host');
});

test('the version and id in the code match the manifest', () => {
  const core = read('js/marker-core.js');
  const constant = name => new RegExp(`const ${name} = '([^']+)'`).exec(core)[1];
  assert.equal(constant('PLUGIN_VERSION'), MANIFEST.version,
    'PLUGIN_VERSION is reported in bug reports and written into every backup');
  assert.equal(constant('PLUGIN_ID'), MANIFEST.id);
  assert.equal(constant('HOMEPAGE'), MANIFEST.homepage);
});

test('the manifest is plain UTF-8 with no byte-order mark', () => {
  // A BOM makes the host's jsonDecode fail on the very first character.
  assert.equal(read('manifest.json').charCodeAt(0), '{'.charCodeAt(0));
});

test('the manifest declares no auto-granted baseline permission', () => {
  const declared = MANIFEST.permissions.filter(permission => BASELINE_PERMISSIONS.has(permission));
  assert.deepEqual(declared, []);
});

test('the manifest declares no permission the code never uses', () => {
  const used = new Set(usedMethods()
    .map(method => API[method]?.permission)
    .filter(Boolean));
  // Permissions that back a manifest contribution rather than an RPC call.
  for (const permission of [
    'app.startup_contributions', 'app.shortcuts',
    // `contributes.background.entrypoint` plus `startup.keepAlive`: no call
    // asks for them, and without both the marks vanish from the reader a few
    // minutes after the plugin tab is closed.
    'app.run_on_startup', 'app.background_keep_alive'
  ]) {
    used.add(permission);
  }
  for (const event of subscribedEvents()) {
    if (!UNSCOPED_EVENTS.has(event)) used.add(`events.subscribe:${event}`);
  }
  const unused = MANIFEST.permissions
    .filter(permission => !used.has(permission) && !BASELINE_PERMISSIONS.has(permission));
  assert.deepEqual(unused, [], `declared but unused: ${unused.join(', ')}`);
});

test('every SDK call is known, permitted, and available on the declared version', () => {
  const problems = [];
  for (const method of usedMethods()) {
    const spec = API[method];
    if (!spec) {
      problems.push(`${method}: not in the reviewed API table`);
      continue;
    }
    if (compareVersions(spec.since, MANIFEST.minAppVersion) > 0) {
      problems.push(`${method}: needs ${spec.since}, manifest declares ${MANIFEST.minAppVersion}`);
    }
    if (spec.permission
      && !BASELINE_PERMISSIONS.has(spec.permission)
      && !MANIFEST.permissions.includes(spec.permission)) {
      problems.push(`${method}: missing permission ${spec.permission}`);
    }
  }
  assert.deepEqual(problems, []);
});

test('every subscribed event has its subscribe permission', () => {
  const missing = subscribedEvents()
    .filter(event => !UNSCOPED_EVENTS.has(event))
    .filter(event => !MANIFEST.permissions.includes(`events.subscribe:${event}`)
      && !BASELINE_PERMISSIONS.has(`events.subscribe:${event}`));
  assert.deepEqual(missing, []);
});

test('the plugin declares no network access', () => {
  assert.equal(MANIFEST.network.enabled, false);
  assert.deepEqual(MANIFEST.network.allowlist, []);
  assert.equal(MANIFEST.permissions.includes('network.access'), false);
  assert.equal(MANIFEST.permissions.includes('network.localhost'), false);
  assert.equal(/\bfetch\(\s*['"`]https?:/.test(allSource()), false);
});

// ── Declarative contributions ───────────────────────────────────────────────

test('the manifest and the code agree on the contribution ids', () => {
  const source = read('js/marker-domain.js');
  const constant = name => new RegExp(`const ${name} = '([^']+)'`).exec(source)[1];
  const startup = MANIFEST.contributes.startup;
  const [colors, highlightActions] = startup.contextMenuItems;

  assert.equal(colors.id, constant('MENU_COLORS_ID'));
  assert.equal(highlightActions.id, constant('MENU_HIGHLIGHT_ID'));
  assert.deepEqual(highlightActions.children.map(child => child.id),
    [constant('MENU_NOTE_ID'), constant('MENU_REMOVE_ID')]);
  assert.equal(startup.toolbarItems[0].id, constant('TOOLBAR_ITEM_ID'));
  assert.match(colors.colors[0].id, new RegExp(`^${constant('COLOR_ITEM_PREFIX')}`));
});

test('the note action opens the page, because only the page can show an editor', () => {
  const [, highlightActions] = MANIFEST.contributes.startup.contextMenuItems;
  const note = highlightActions.children.find(child => child.id === 'marker-note');
  assert.equal(note.openPlugin, true);
  // The remove action must not open the page — it works headlessly.
  const remove = highlightActions.children.find(child => child.id === 'marker-remove');
  assert.equal(remove.openPlugin, undefined);
});

test('the gesture-only calls are invoked from a click, not after an await', () => {
  const ui = stripComments(read('js/marker-ui.js'));
  for (const [method, wrapper] of Object.entries(USER_GESTURE_ONLY)) {
    // The host checks navigator.userActivation directly, and a long await
    // chain loses it. Every call site must sit inside a click handler.
    assert.match(ui, new RegExp(`Core\\.${wrapper}\\(`), `${method} is never called`);
    assert.equal(new RegExp(`await[^\\n]*\\n\\s*Core\\.${wrapper}\\(`).test(ui), false,
      `${method} must not follow an await on the same path`);
    assert.match(ui, new RegExp(`addEventListener\\('click'[\\s\\S]{0,400}Core\\.${wrapper}\\(`),
      `${method} must be reached from a click handler`);
  }
});

test('the declarative contributions pass the host parser', () => {
  // The same rules the host applies at install time. A manifest that fails
  // here installs with the contribution silently dropped.
  const items = MANIFEST.contributes.startup.contextMenuItems;
  assert.ok(items.length <= 2, 'a plugin may register at most 2 top-level items');
  for (const item of items) validateMenuItem(item);
  for (const item of MANIFEST.contributes.startup.toolbarItems) validateToolbarItem(item);
});

test('the declarative toolbar item acts in place instead of opening the plugin', () => {
  const item = MANIFEST.contributes.startup.toolbarItems[0];
  assert.match(item.icon, /_24_(regular|filled)$/);
  assert.deepEqual(item.contexts, ['reader-text'], 'PDF has no highlight support');
  // With `openPlugin` the single click would throw the reader into the plugin
  // tab; the engine handles it silently and hides the marks in this book.
  assert.equal(item.openPlugin, undefined);
  // The user can take the button off the toolbar without uninstalling
  // anything, and the host honours that with no plugin code running.
  assert.deepEqual(item.when, {
    storage: { key: 'marker_toolbar_button', notEquals: false }
  });
  const domain = read('js/marker-domain.js');
  assert.match(domain, /const TOOLBAR_FLAG_KEY = 'marker_toolbar_button'/,
    'the flag the manifest gates on must be the one the plugin writes');
});

test('the highlight metadata source is one the host accepts', () => {
  // Regression guard for the bug that made every highlight fail: the host
  // takes only manual/ai/import/sync, and rejects anything else outright.
  const domainSource = /const HIGHLIGHT_SOURCE = '([^']+)'/.exec(read('js/marker-domain.js'))[1];
  assert.ok(['manual', 'ai', 'import', 'sync'].includes(domainSource));
  // Nothing may build a metadata object by hand and bypass the one builder.
  const core = stripComments(read('js/marker-core.js'));
  assert.equal(/metadata:\s*\{/.test(core), false,
    'metadata must be built by MarkerDomain.buildHighlightMetadata');
  assert.match(core, /D\.buildHighlightMetadata\(/);
});

test('every declared shortcut has a target and a canonical key', () => {
  const shortcuts = MANIFEST.contributes.startup.shortcuts;
  const commands = new Set([...read('js/marker-domain.js').matchAll(/COMMAND_\w+ = '([^']+)'/g)]
    .map(match => match[1]));
  for (const shortcut of shortcuts) {
    assert.ok(shortcut.id && shortcut.label, 'a shortcut needs id and label');
    assert.ok(shortcut.command || shortcut.contextMenuItemId, 'a shortcut needs a target');
    if (shortcut.key) assert.match(shortcut.key, /^(ctrl|alt|shift|meta)(\+(ctrl|alt|shift|meta))*\+[a-z0-9]+$/);
    if (shortcut.command) assert.ok(commands.has(shortcut.command), `${shortcut.command} is never handled`);
  }
  assert.equal(new Set(shortcuts.map(shortcut => shortcut.id)).size, shortcuts.length);
});

test('the background engine is declared, kept alive, and woken by the reader', () => {
  // The host owns highlights per *instance* and erases them when that instance
  // is torn down (PluginBridgeAdapter.dispose →
  // PluginHighlightRegistry.removeInstance). The only instance that outlives a
  // reading session is the background one, so it has to exist, it has to be
  // exempt from the idle shutdown that would take its marks with it, and
  // something has to wake it.
  const startup = MANIFEST.contributes.startup;
  assert.equal(MANIFEST.permissions.includes('app.run_on_startup'), true);
  assert.equal(MANIFEST.permissions.includes('app.background_keep_alive'), true);
  assert.equal(startup.keepAlive, true);
  assert.ok(startup.activationEvents.length > 0,
    'something has to wake the engine, or it never runs at all');
  assert.equal(MANIFEST.contributes.background.entrypoint, 'background.html');
  assert.equal(fs.existsSync(path.join(ROOT, 'background.html')), true);
});

test('`app.startup` is deliberately NOT an activation event', () => {
  // Do not put it back. It wedges the plugin permanently, and the failure is
  // total and silent: no marking, no erasing, no toolbar, no shortcut.
  //
  // `PluginLazyActivationService.syncPlugin` arms a one-shot 8-second timer for
  // `app.startup` that calls `_activate` **without checking whether an engine
  // is already running**. `_activate` sets `_activating[pluginId]` and calls
  // the activator; `PluginBackgroundHost._activateOnDemand` then returns early
  // — normally, building nothing — because `_activeBackgroundPlugins` already
  // holds the plugin. No widget means no `onLoadStop`, which means neither
  // `onBackgroundInstanceReady` nor `onBackgroundInstanceFailed` ever runs, so
  // `_activating` is never cleared and `isBootPending` stays true forever.
  //
  // `dispatchEventToPlugin` consults `queueIfBootPending` *before* it looks for
  // a controller, so from that moment every targeted event — colour click,
  // toolbar click, shortcut — is parked in a queue nothing will ever drain,
  // even when a perfectly healthy plugin tab is open. Broadcasts keep flowing,
  // which is what made it look like the plugin was alive but deaf.
  //
  // Whether the trap springs depends only on whether the engine happened to be
  // up at the eight-second mark, which is why it read as "it works for a few
  // seconds and then stops".
  //
  // Nothing is lost by leaving it out: the remaining triggers are reader
  // events, and they fire as soon as a book is on screen — which is exactly
  // when the engine is needed. Every other route into `_activate` is guarded by
  // "there is no usable instance", so only this timer could fire into a
  // healthy engine.
  const events = MANIFEST.contributes.startup.activationEvents
    .map(entry => (typeof entry === 'string' ? entry : entry.topic));
  assert.equal(events.includes('app.startup'), false);
});

test('every activation event carries its own subscribe permission', () => {
  // `app.startup` is the one trigger that is not a topic; every other entry is
  // an ordinary event and needs the same permission a live subscription does.
  for (const entry of MANIFEST.contributes.startup.activationEvents) {
    const topic = typeof entry === 'string' ? entry : entry.topic;
    if (topic === 'app.startup') continue;
    assert.ok(MANIFEST.permissions.includes(`events.subscribe:${topic}`),
      `${topic} is an activation event with no subscribe permission`);
  }
});

test('the background page is headless and shares the engine with the plugin page', () => {
  const background = read('background.html');
  const scripts = [...background.matchAll(/<script src="([^"]+)"><\/script>/g)]
    .map(match => match[1]);
  assert.deepEqual(scripts, [
    'js/marker-domain.js',
    'js/marker-i18n.js',
    'i18n/en.js',
    'js/marker-runtime.js',
    'js/marker-core.js',
    'js/marker-background.js'
  ]);
  // The page modules are the plugin tab's. Loading them here would cost a
  // DOM, a stylesheet and an editor in a WebView with nothing to show.
  assert.equal(background.includes('marker-ui.js'), false);
  assert.equal(background.includes('marker-richtext.js'), false);
  assert.equal(background.includes('style.css'), false);
  assert.equal(/<body>[\s\S]*<(?!script|\/)/.test(background), false,
    'the background page must render nothing');
  // The engine is started once per page, by that page's own entry script.
  assert.match(read('js/marker-background.js'), /MarkerCore\.start\(\)/);
});

test('the icons named in the manifest use the 24px naming rule', () => {
  const names = [
    MANIFEST.contributes.toolTab.iconName,
    ...MANIFEST.contributes.startup.contextMenuItems.map(item => item.icon),
    ...MANIFEST.contributes.startup.toolbarItems.map(item => item.icon)
  ].filter(Boolean);
  for (const name of names) assert.match(name, /^([a-z_]+:)?[a-z0-9_]+_24_(regular|filled)$/);
});

// ── Packaging ───────────────────────────────────────────────────────────────

test('the entrypoint exists and is not excluded from the package', () => {
  assert.equal(fs.existsSync(path.join(ROOT, MANIFEST.entrypoint)), true);
  const ignored = read('.otzignore').split(/\r?\n/).map(line => line.trim());
  assert.equal(ignored.includes(MANIFEST.entrypoint), false);
});

test('every runtime asset the pages load is packaged', () => {
  const ignored = read('.otzignore').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const referenced = new Set([MANIFEST.contributes.background.entrypoint]);
  for (const page of ['index.html', 'background.html']) {
    for (const match of read(page).matchAll(/(?:src|href)="([^"]+)"/g)) {
      referenced.add(match[1]);
    }
  }
  for (const asset of referenced) {
    assert.equal(fs.existsSync(path.join(ROOT, asset)), true, `${asset} is referenced but missing`);
    const directory = `${asset.split('/')[0]}/`;
    assert.equal(ignored.includes(directory), false, `${directory} is referenced at runtime but ignored`);
  }
});

test('the release workflow matches the declared compatibility target', () => {
  const workflow = read('.github/workflows/release.yml');
  assert.match(workflow, /otzaria-plugin-id:\s*6a6069b8dd175558ae6e4071/);
  assert.match(workflow, new RegExp(`app-version:\\s*${TARGET_VERSION.replace(/\./g, '\\.')}`));
  assert.match(workflow, /api-reference-url:.*0\.9\.97/);
});

// ── Layering ────────────────────────────────────────────────────────────────

test('only the runtime module talks to the SDK directly', () => {
  for (const file of SOURCES.filter(name => !name.endsWith('marker-runtime.js'))) {
    assert.equal(/\bOtzaria\.(call|on|off)\s*\(/.test(stripComments(read(file))), false,
      `${file} must go through MarkerRuntime`);
  }
});

test('the domain module stays pure', () => {
  const source = stripComments(read('js/marker-domain.js'));
  assert.equal(/\bdocument\b/.test(source), false, 'no DOM in the domain module');
  assert.equal(/\bOtzaria\b/.test(source), false, 'no SDK in the domain module');
  assert.equal(/\bsetTimeout\b|\bsetInterval\b/.test(source), false, 'no timers in the domain module');
});

test('the engine never touches the DOM, so the background page stays headless', () => {
  const source = stripComments(read('js/marker-core.js'));
  assert.equal(/\bdocument\s*\./.test(source), false, 'the engine must not touch the DOM');
  assert.equal(source.includes('MarkerUi'), false);
});

test('no CDN, remote font or inline event handler slipped in', () => {
  for (const page of ['index.html', 'background.html']) {
    const html = read(page);
    // Only loading matters. A URL inside a placeholder is sample text, not a
    // resource the page fetches.
    const loaded = [...html.matchAll(/\b(?:src|href)="([^"]+)"/g)].map(match => match[1]);
    const remote = loaded.filter(value => /^[a-z]+:\/\//i.test(value));
    assert.deepEqual(remote, [], `${page} must not load remote resources`);
    assert.equal(/\son(click|change|input|submit|load)=/i.test(html), false,
      `${page} has an inline event handler`);
  }
  assert.equal(/@import|url\(\s*['"]?https?:/.test(read('css/style.css')), false);
});

test('no font file is packaged — the reading fonts come from Otzaria', () => {
  // `src: local()` resolves only fonts installed on the machine inside a
  // plugin WebView, so the plugin used to carry its own copy of nine families
  // Otzaria already ships. `fonts.resolveFamilies` hands over the bytes.
  const fontFiles = fs.existsSync(path.join(ROOT, 'fonts'));
  assert.equal(fontFiles, false, 'the fonts/ directory is gone for good');
  assert.equal(/@font-face/.test(read('css/style.css')), false,
    'a @font-face in the stylesheet would need a file to point at');
  assert.match(read('js/marker-ui.js'), /fonts\.resolveFamilies/);
});

/**
 * Values that originate from book text, the user's own input, or a backup
 * file. Interpolating one of these into markup without `escapeHtml` is an
 * injection, so the UI must never do it.
 */
const UNTRUSTED_READS = [
  'item.text', 'item.note', 'item.book', 'item.bookId', 'item.ref', 'item.key',
  'item.highlightId', 'item.colorId', 'color.label', 'color.hex', 'color.id',
  'option.value', 'option.textContent', 'entry.name', 'entry.path',
  'title', 'short', 'note', 'label', 'tag', 'heading', 'when',
  // The book text after the Divine-Name policy — still book text.
  'text'
];

const MARKUP_LINE = /<[a-zA-Z/]/;

/**
 * Flags a bare `${item.text}` on a line that also emits markup.
 *
 * Scoping to markup lines is what makes this usable: the same value
 * interpolated into a plain string, a Markdown export or a text export needs
 * no escaping, and flagging those would train everyone to ignore the test.
 */
function unescapedInMarkup(files) {
  const found = [];
  for (const file of files) {
    const lines = stripComments(read(file)).split(/\r?\n/);
    lines.forEach((line, index) => {
      if (!MARKUP_LINE.test(line)) return;
      for (const value of UNTRUSTED_READS) {
        const pattern = new RegExp(`\\$\\{\\s*${value.replace('.', '\\.')}\\s*\\}`);
        if (pattern.test(line)) found.push(`${file}:${index + 1} \${${value}}`);
      }
    });
  }
  return found;
}

test('untrusted values reach the DOM only through escapeHtml', () => {
  const found = unescapedInMarkup(['js/marker-ui.js']);
  assert.deepEqual(found, [], `unescaped interpolations:\n${found.join('\n')}`);
});

test('stored note markup reaches the DOM only through the sanitizer', () => {
  const ui = stripComments(read('js/marker-ui.js'));
  // `noteHtml` is the one field the plugin renders as markup rather than as
  // text, and it can come from an imported backup file. Every read of it must
  // be wrapped, or a crafted backup becomes stored XSS.
  const reads = [...ui.matchAll(/[A-Za-z]+\.noteHtml/g)].map(match => match.index);
  assert.ok(reads.length > 0, 'the note rendering path moved');
  for (const index of reads) {
    const line = ui.slice(ui.lastIndexOf('\n', index) + 1, ui.indexOf('\n', index));
    // Only two uses turn it into markup: an interpolation into a template
    // literal, and a direct innerHTML assignment. A branch on it is harmless.
    const rendersMarkup = /\$\{[^}]*\.noteHtml/.test(line) || /innerHTML\s*=/.test(line);
    if (!rendersMarkup) continue;
    assert.match(line, /(?:RichText\.sanitize|sanitizedNote)\(/,
      `unsanitized noteHtml render: ${line.trim()}`);
  }
  assert.match(ui, /sanitizedNote\(item\.noteHtml\)/, 'the card must sanitize the note');
  // The memoizing wrapper is only a cache in front of the sanitizer — it must
  // never become a second, weaker policy.
  assert.match(ui, /function sanitizedNote\(html\) \{[\s\S]*?RichText\.sanitize\(html\)/,
    'sanitizedNote must delegate to RichText.sanitize');
});

test('the editor emits tags for bold, never CSS', () => {
  // styleWithCSS(true) makes execCommand('bold') produce
  // <span style="font-weight:bold">, and the sanitizer keeps no declaration
  // but font-size — so every bold, italic, underline and strike was stripped
  // the moment the note was saved.
  const richtext = read('js/marker-richtext.js');
  assert.match(richtext, /execCommand\('styleWithCSS', false, false\)/,
    'styleWithCSS must be off, or note formatting is lost on save');
  // And the CSS shape is still understood, for engines that ignore the flag
  // and for pasted content.
  assert.match(richtext, /D\.noteStyleTags\(/);
});

test('the sanitizer applies the policy from the domain, not its own copy', () => {
  const richtext = stripComments(read('js/marker-richtext.js'));
  for (const helper of ['noteTagFor', 'safeNoteHref', 'safeNoteFontSize']) {
    assert.match(richtext, new RegExp(`D\\.${helper}`),
      `the sanitizer must use MarkerDomain.${helper}, which is the tested policy`);
  }
  // A second, untested allowlist living here is exactly how the two drift.
  assert.equal(/const\s+TAG_MAP\s*=/.test(richtext), false);
});

test('the sanitizer parses into an inert document', () => {
  const richtext = stripComments(read('js/marker-richtext.js'));
  // Assigning untrusted markup to a live element's innerHTML would fetch
  // resources and fire handlers before a single node was inspected.
  assert.match(richtext, /new DOMParser\(\)\.parseFromString/);
  assert.equal(/document\.body\.innerHTML\s*=/.test(richtext), false);
});

test('the page loads the note editor', () => {
  assert.equal(read('index.html').includes('js/marker-richtext.js'), true);
});

test('every editor toolbar button maps to a command the editor implements', () => {
  const html = read('index.html');
  const richtext = read('js/marker-richtext.js');
  const buttons = [...html.matchAll(/data-rt-command="([a-zA-Z]+)"/g)].map(match => match[1]);
  assert.ok(buttons.length >= 10, 'the note toolbar lost its buttons');
  const commands = richtext.slice(richtext.indexOf('const COMMANDS'));
  for (const command of new Set(buttons)) {
    assert.match(commands, new RegExp(`\\b${command}:`), `no handler for "${command}"`);
  }
});

test('the exported HTML escapes its content too', () => {
  const ui = stripComments(read('js/marker-ui.js'));
  const start = ui.indexOf("if (template.format === 'html')");
  const htmlBranch = ui.slice(start, ui.indexOf("if (template.format === 'text')", start));
  assert.ok(start > 0 && htmlBranch.length > 0, 'the HTML export branch moved');
  assert.match(htmlBranch, /escapeHtml\(text\)/);
  assert.match(htmlBranch, /escapeHtml\(note\)/);
  assert.match(htmlBranch, /escapeHtml\(heading\)/);
  assert.match(htmlBranch, /tags\.map\(escapeHtml\)/);
});
