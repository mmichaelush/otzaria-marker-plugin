(function (global) {
  'use strict';

  /**
   * Translation layer.
   *
   * Hebrew is the source language: every string in the code and in the HTML is
   * written in Hebrew and used as its own lookup key. A catalog is a flat map
   * from the Hebrew string to the translated one, registered on
   * `global.MARKER_TRANSLATIONS[<language>]` by the files in `i18n/`.
   *
   * A missing catalog, or a missing key inside one, falls back to the Hebrew
   * source — so a partial translation degrades to mixed text, never to a blank
   * or a raw key.
   */

  const SOURCE_LANGUAGE = 'he';
  const LANGUAGE_SETTING_KEY = 'key-settings-language';

  let language = SOURCE_LANGUAGE;
  let direction = 'rtl';
  let dictionary = null;
  const listeners = new Set();

  function catalogs() {
    return global.MARKER_TRANSLATIONS || {};
  }

  /**
   * The language to render in: an explicit user choice in the plugin settings
   * wins over the host's interface language, and a language with no catalog
   * falls back to Hebrew.
   */
  function resolveLanguage(preference, hostLanguage) {
    const requested = preference && preference !== 'auto' ? preference : hostLanguage;
    const normalized = String(requested || SOURCE_LANGUAGE).split(/[-_]/)[0].toLowerCase();
    if (normalized === SOURCE_LANGUAGE) return SOURCE_LANGUAGE;
    return catalogs()[normalized] ? normalized : SOURCE_LANGUAGE;
  }

  function configure(nextLanguage, nextDirection) {
    const resolved = String(nextLanguage || SOURCE_LANGUAGE).toLowerCase();
    const changed = resolved !== language;
    language = resolved;
    dictionary = resolved === SOURCE_LANGUAGE ? null : (catalogs()[resolved] || null);
    direction = nextDirection
      || (global.MarkerDomain ? global.MarkerDomain.directionForLanguage(resolved) : 'rtl');
    if (changed) for (const listener of listeners) listener(resolved, direction);
    return changed;
  }

  function onChange(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  /**
   * Translate `text`, then substitute `{name}` placeholders from `vars`.
   * Placeholders are interpolated after lookup so a catalog entry may reorder
   * them freely.
   */
  function t(text, vars) {
    const source = String(text ?? '');
    // An own-property check, not a plain lookup: a source string such as
    // "constructor" or "toString" would otherwise resolve to a function off
    // the prototype chain and be rendered as its source code.
    const translated = dictionary && Object.prototype.hasOwnProperty.call(dictionary, source)
      ? dictionary[source]
      : null;
    let result = typeof translated === 'string' && translated ? translated : source;
    if (vars) {
      result = result.replace(/\{(\w+)\}/g, (match, name) =>
        Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : match);
    }
    return result;
  }

  /**
   * Applies the active language to a DOM subtree.
   *
   * The static HTML stays Hebrew and `dir="rtl"` (the packaging validator
   * requires it), so translation happens at runtime through markers:
   *   `data-i18n`      — replace textContent
   *   `data-i18n-attr` — comma-separated attributes to translate in place
   * Each element keeps its Hebrew source in `data-i18n-src*` the first time it
   * is translated, so switching language twice does not translate a
   * translation.
   */
  function translateElement(element) {
    if (element.hasAttribute('data-i18n')) {
      if (!element.dataset.i18nSrc) element.dataset.i18nSrc = element.textContent.trim();
      element.textContent = t(element.dataset.i18nSrc);
    }
    const attrs = element.getAttribute('data-i18n-attr');
    if (!attrs) return;
    for (const rawName of attrs.split(',')) {
      const name = rawName.trim();
      if (!name) continue;
      const cacheKey = `i18nSrc${name.replace(/(^|-)([a-z])/g, (m, dash, ch) => ch.toUpperCase())}`;
      if (!element.dataset[cacheKey]) {
        const current = element.getAttribute(name);
        if (current == null) continue;
        element.dataset[cacheKey] = current;
      }
      element.setAttribute(name, t(element.dataset[cacheKey]));
    }
  }

  function translateDocument(root) {
    const scope = root || global.document;
    if (!scope?.querySelectorAll) return;
    if (scope.matches?.('[data-i18n],[data-i18n-attr]')) translateElement(scope);
    for (const element of scope.querySelectorAll('[data-i18n],[data-i18n-attr]')) {
      translateElement(element);
    }
  }

  function applyDocumentLanguage(doc) {
    const target = doc || global.document;
    if (!target?.documentElement) return;
    target.documentElement.lang = language;
    target.documentElement.dir = direction;
    target.documentElement.dataset.markerLanguage = language;
  }

  global.MarkerI18n = Object.freeze({
    SOURCE_LANGUAGE, LANGUAGE_SETTING_KEY,
    resolveLanguage, configure, onChange,
    t, translateElement, translateDocument, applyDocumentLanguage,
    get language() { return language; },
    get direction() { return direction; }
  });
})(globalThis);
