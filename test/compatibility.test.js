const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const read = relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8');
const readJson = relativePath => JSON.parse(read(relativePath).replace(/^\uFEFF/, ''));

const OTZARIA_096_METHODS = new Set([
  'fs.pickUserFile',
  'fs.readTextFile',
  'fs.revokeFile',
  'reader.addContextMenuItem',
  'reader.clearAllHighlights',
  'reader.clearHighlight',
  'reader.findTextOccurrences',
  'reader.getHighlights',
  'reader.getSelection',
  'reader.openBook',
  'reader.openBookAtRef',
  'reader.removeContextMenuItem',
  'reader.revealHighlight',
  'reader.setHighlight',
  'reader.updateContextMenuItem',
  'reader.updateHighlight',
  'storage.get',
  'storage.list',
  'storage.remove',
  'storage.set',
  'ui.showError',
  'ui.showMessage',
  'ui.showSuccess',
  'ui.showWarning'
]);

function sdkMethods(source) {
  return [...source.matchAll(/\bcall(?:Raw)?\(\s*['"]([^'"]+)['"]/g)]
    .map(match => match[1]);
}

test('manifest remains an Otzaria 0.9.96 legacy-startup release', () => {
  const manifest = readJson('manifest.json');
  assert.equal(manifest.minAppVersion, '0.9.96');
  assert.equal(manifest.permissions.includes('app.run_on_startup'), true);
  assert.equal(manifest.permissions.includes('app.startup_contributions'), false);
  assert.equal(manifest.contributes.startup, undefined);
});

test('all SDK calls are approved for the 0.9.96 release', () => {
  const source = ['js/marker-domain.js', 'js/marker-runtime.js', 'js/app.js']
    .map(read)
    .join('\n');
  const unexpected = [...new Set(sdkMethods(source))]
    .filter(method => !OTZARIA_096_METHODS.has(method))
    .sort();
  assert.deepEqual(unexpected, []);
  assert.equal(source.includes("call('plugin.backgroundDone'"), false);
  assert.equal(source.includes("call('app.getLocale'"), false);
});

test('SDK calls stay behind MarkerRuntime and view options keep the requested order', () => {
  const appSource = read('js/app.js');
  assert.equal(/\bOtzaria\.call\s*\(/.test(appSource), false);

  const html = read('index.html');
  const detailsIndex = html.indexOf('<option value="details">');
  const compactIndex = html.indexOf('<option value="compact">');
  assert.ok(detailsIndex >= 0 && compactIndex >= 0);
  assert.ok(detailsIndex < compactIndex);
});
