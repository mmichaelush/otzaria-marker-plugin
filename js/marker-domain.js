(function (global) {
  'use strict';

  /**
   * Pure domain rules for the marker plugin.
   *
   * This module never touches the DOM, `Otzaria`, timers or plugin state.
   * Keeping the rules here means storage migrations, rendering, the context
   * menu and the tests all agree on one normalization behaviour.
   */

  // ── Contracts ──────────────────────────────────────────────────────────────
  const SETTINGS_SCHEMA_VERSION = 2;
  const BACKUP_SCHEMA_VERSION = 2;
  const HOST_TARGET_VERSION = '0.9.97';

  const SETTINGS_KEY = 'marker_settings';
  const HIGHLIGHT_PREFIX = 'highlight:';

  /**
   * The host allows a color row 1-12 entries and a plugin 2 top-level menu
   * items. The menu carries at most 8 colors plus the eraser, which keeps the
   * row readable in a narrow reader pane; the palette itself may still hold
   * up to 12, and the colors editor says which ones reach the menu.
   */
  const MAX_COLORS = 12;
  const MAX_MENU_COLORS = 8;
  const MAX_TAGS_PER_HIGHLIGHT = 12;
  const HIGHLIGHTS_PAGE_SIZE = 100;
  const MAX_NOTE_LENGTH = 4000;
  /** Rich notes are markup, so they need far more room than their text. */
  const MAX_NOTE_HTML_LENGTH = 20000;

  // Ids are part of the manifest contract — `contributes.startup` declares the
  // same values so the engine can patch the declarative registration in place.
  const MENU_COLORS_ID = 'marker-colors';
  const MENU_HIGHLIGHT_ID = 'marker-highlight-actions';
  const MENU_REMOVE_ID = 'marker-remove';
  const MENU_NOTE_ID = 'marker-note';
  const TOOLBAR_ITEM_ID = 'marker-toolbar';
  const COLOR_ITEM_PREFIX = 'mark-';
  /**
   * The eraser at the end of the color row.
   *
   * Removing a mark was otherwise reachable only through the
   * `reader-highlight` context, and the host builds that context only when
   * the right-click lands exactly on a mark **and there is no active
   * selection** (`_buildClickedHighlightEntries`). Right after marking there
   * usually is one, so the menu goes down the `reader-selection` path
   * instead and the remove action is nowhere to be found. Otzaria's own
   * highlight menu solves it the same way — a `clear` swatch in the row.
   */
  const CLEAR_COLOR_ID = 'clear';
  /** Fully transparent: the host reads it as "no fill" and draws the icon. */
  const CLEAR_COLOR_VALUE = '#00000000';
  /**
   * The host caps a color-row entry's `id` at 64 characters, and the id it
   * sees is `mark-` + the stored id. Budgeting for the prefix here keeps a
   * long custom id from failing the whole menu payload — one over-long color
   * would otherwise take the entire color row down with it.
   */
  const MAX_COLOR_ID_LENGTH = 64 - COLOR_ITEM_PREFIX.length;
  const SELECTION_CONTEXTS = Object.freeze(['reader-selection', 'reader-page-shape-selection']);
  const HIGHLIGHT_CONTEXTS = Object.freeze(['reader-highlight']);
  /** Ids registered by plugin versions <= 0.9.4; removed once on boot. */
  const LEGACY_MENU_IDS = Object.freeze(['marker-root', 'marker-page-shape']);

  const COMMAND_HIGHLIGHT_DEFAULT = 'marker.highlightDefault';
  const COMMAND_OPEN_PANEL = 'marker.openPanel';

  /**
   * `metadata.source` on a highlight is a **closed set** in the host
   * (`manual` / `ai` / `import` / `sync`); anything else is rejected with
   * `error.invalid_params: unsupported highlight source`, and the mark is
   * never drawn. Every highlight here is made by the user, so `manual` is the
   * only value the plugin ever sends.
   */
  const HIGHLIGHT_SOURCES = Object.freeze(['manual', 'ai', 'import', 'sync']);
  const HIGHLIGHT_SOURCE = 'manual';
  /** The host caps `metadata.tags` at 20 entries of up to 64 characters. */
  const MAX_METADATA_TAGS = 20;
  const MAX_METADATA_TAG_LENGTH = 64;

  /**
   * Control characters the host rejects, in the two flavours it enforces.
   *
   * Any of them anywhere in a payload fails the whole call with
   * `error.invalid_params`, so they are stripped rather than escaped — one
   * stray character pasted into a note must not cost the user their mark.
   *
   * `PluginHighlightRegistry._optionalText` tolerates tab, newline and
   * carriage return, because a note is multi-line text.
   * `ContextMenuRegistry._optionalSafeText` and `PluginToolbarRegistry`
   * tolerate none: a menu title is a single line.
   */
  const HIGHLIGHT_TEXT_CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
  const MENU_TEXT_CONTROL = /[\u0000-\u001F\u007F]/g;

  /** Text bound for a highlight's `metadata`: keeps the line structure. */
  function safeHighlightText(value) {
    return String(value ?? '').replace(HIGHLIGHT_TEXT_CONTROL, '');
  }

  /** Text bound for a menu or toolbar label: collapsed onto one line. */
  function safeMenuText(value) {
    return String(value ?? '').replace(MENU_TEXT_CONTROL, ' ').trim();
  }

  /**
   * The `metadata` object for a highlight, built to the host's contract:
   * only `note`, `tags` and `source` are accepted, an empty tag is an error,
   * the tag list is capped, and no control characters may survive.
   */
  function buildHighlightMetadata({ colorLabel, note, tags } = {}) {
    const allTags = [colorLabel, ...(tags || [])]
      .map(tag => safeHighlightText(tag).trim().slice(0, MAX_METADATA_TAG_LENGTH))
      .filter(Boolean)
      .slice(0, MAX_METADATA_TAGS);
    return {
      source: HIGHLIGHT_SOURCE,
      note: safeHighlightText(note).slice(0, MAX_NOTE_LENGTH),
      tags: allTags
    };
  }

  const MARKER_MODES = Object.freeze(['text-background', 'underline', 'box', 'line-marker']);
  const VIEW_MODES = Object.freeze(['content', 'tiles', 'list', 'details', 'compact']);
  const EXPORT_FORMATS = Object.freeze(['markdown', 'html', 'text']);
  const LANGUAGES = Object.freeze(['auto', 'he', 'en']);
  const SORT_MODES = Object.freeze(['newest', 'oldest', 'book', 'location', 'color', 'favorites']);
  const GROUP_MODES = Object.freeze(['none', 'book', 'color', 'tag', 'date']);
  const TABS = Object.freeze(['highlights', 'colors', 'settings', 'about']);
  const STATUS_FILTERS = Object.freeze(['all', 'favorites', 'stale', 'noted', 'tagged']);
  const FONT_CHOICES = Object.freeze([
    'app', 'system', 'FrankRuhlCLM', 'TaameyDavidCLM', 'TaameyAshkenaz',
    'KeterYG', 'Shofar', 'NotoSerifHebrew', 'NotoRashiHebrew', 'Tinos', 'Rubik'
  ]);
  const RTL_LANGUAGES = Object.freeze(['he', 'ar', 'fa', 'ur', 'yi']);

  const DEFAULT_SETTINGS = Object.freeze({
    schemaVersion: SETTINGS_SCHEMA_VERSION,
    colors: [
      { id: 'yellow', hex: '#F1E784', label: 'צהוב', enabled: true },
      { id: 'green', hex: '#8BCF8D', label: 'ירוק', enabled: true },
      { id: 'blue', hex: '#88BDE9', label: 'כחול', enabled: true },
      { id: 'red', hex: '#F37E75', label: 'אדום', enabled: true },
      { id: 'orange', hex: '#F0BD72', label: 'כתום', enabled: true },
      { id: 'purple', hex: '#E297F0', label: 'סגול', enabled: false }
    ],
    defaultColorId: 'yellow',
    menuStyle: 'buttonRow',
    language: 'auto',
    autoBackup: true,
    // Remembered between sessions. Filters and the search box deliberately are
    // not: reopening to an empty list because of a filter set last week reads
    // as data loss.
    view: { sort: 'newest', group: 'none', tab: 'highlights' },
    appearance: { viewMode: 'content', fontFamily: 'app', fontSize: 18, lineHeight: 1.5 },
    exportTemplate: {
      format: 'markdown', includeBook: true, includeRef: true,
      includeNote: true, includeTags: true, includeDate: true
    }
  });

  // ── Small helpers ──────────────────────────────────────────────────────────

  /**
   * Keys that must never survive a round trip through untrusted JSON.
   *
   * `JSON.parse` creates `__proto__` as an ordinary *own* property, and the
   * very next `Object.assign` hands it to the `__proto__` setter — which
   * replaces the target's prototype with whatever the backup file said. The
   * damage is contained to that one object rather than to
   * `Object.prototype`, but it is still an object the plugin then writes back
   * to storage and reads as settings.
   */
  const UNSAFE_KEYS = Object.freeze(['__pro' + 'to__', 'constructor', 'prototype']);

  function structuredCloneSafe(value) {
    return JSON.parse(JSON.stringify(value),
      (key, parsed) => (UNSAFE_KEYS.includes(key) ? undefined : parsed));
  }

  /** A defensive copy of untrusted input, or `{}` when it cannot be copied. */
  function sanitizeParsed(value) {
    if (!value || typeof value !== 'object') return {};
    try {
      return structuredCloneSafe(value);
    } catch {
      return {};   // a cycle, or a value JSON cannot represent
    }
  }

  /**
   * Neutralizes the block-level Markdown a stored value could introduce into
   * an export.
   *
   * Book titles, notes and tags are user input, and an imported backup is
   * outright untrusted: a note that begins with `## ` or holds a line of
   * `---` would forge a heading or the record separator and silently
   * restructure the exported document. Only line-leading constructs are
   * escaped — escaping inline `*` and `_` too would turn ordinary prose
   * into backslash noise for no gain.
   */
  function escapeMarkdownBlocks(value) {
    return String(value ?? '')
      .split('\n')
      .map(line => line.replace(/^(\s*)([#>+*=-]|\d+[.)])/, '$1\\$2'))
      .join('\n');
  }

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>'"]/g,
      ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[ch]));
  }

  function clamp(value, min, max, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
  }

  function hexToRgba(hex, alpha) {
    const match = /^#?([0-9a-f]{6})/i.exec(hex || '');
    if (!match) return `rgba(103,80,164,${alpha})`;
    const value = match[1];
    return `rgba(${parseInt(value.slice(0, 2), 16)},${parseInt(value.slice(2, 4), 16)},${parseInt(value.slice(4, 6), 16)},${alpha})`;
  }

  /** The Host only accepts #RRGGBB / #RRGGBBAA — strip anything else. */
  function toSafeHex(hex) {
    const match = /^#([0-9a-fA-F]{6})/.exec(hex || '');
    return match ? `#${match[1].toUpperCase()}` : '#FFF176';
  }

  // ── Host version & boot context ────────────────────────────────────────────

  function versionParts(value) {
    const match = String(value || '').match(/^(\d+)\.(\d+)\.(\d+)/);
    return match ? match.slice(1).map(Number) : [0, 0, 0];
  }

  function compareHostVersions(first, second) {
    const a = versionParts(first);
    const b = versionParts(second);
    for (let index = 0; index < 3; index++) {
      if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1;
    }
    return 0;
  }

  function hasPermission(permissions, permission) {
    return Array.isArray(permissions) && permissions.includes(permission);
  }

  function directionForLanguage(language) {
    return RTL_LANGUAGES.includes(language) ? 'rtl' : 'ltr';
  }

  /**
   * Flattens `plugin.boot` into the few facts the plugin actually branches on.
   * `capabilities` reflects what this host build supports; every one of them is
   * a 0.9.97 feature, so on the declared `minAppVersion` they are all true and
   * only degrade if the plugin is side-loaded onto an older build.
   */
  function normalizeBootContext(payload) {
    const app = payload?.app && typeof payload.app === 'object' ? payload.app : {};
    const rawVersion = String(app.version || HOST_TARGET_VERSION);
    const appVersion = /^\d+\.\d+\.\d+/.test(rawVersion) ? rawVersion : HOST_TARGET_VERSION;
    const locale = String(app.locale || 'he-IL');
    const localeLanguage = locale.split(/[-_]/)[0].toLowerCase();
    const reportedLanguage = /^[a-z]{2,3}$/i.test(app.language || '')
      ? String(app.language).toLowerCase()
      : '';
    const language = reportedLanguage || localeLanguage || 'he';
    const textDirection = ['rtl', 'ltr'].includes(app.textDirection)
      ? app.textDirection
      : directionForLanguage(language);
    const supportsCurrentApi = compareHostVersions(appVersion, HOST_TARGET_VERSION) >= 0;

    return Object.freeze({
      appVersion,
      platform: String(app.platform || 'unknown'),
      pluginId: String(payload?.plugin?.id || ''),
      pluginVersion: String(payload?.plugin?.version || ''),
      locale,
      language,
      textDirection,
      runMode: app.runMode === 'background' ? 'background' : 'foreground',
      devMode: app.devMode === true,
      isDesktop: ['windows', 'macos', 'linux'].includes(String(app.platform || '')),
      permissions: Array.isArray(payload?.permissions) ? [...payload.permissions] : [],
      // Read by the page to explain a downgrade, and by the compatibility
      // tests. Every flag turns on together, because 0.9.97 introduced them
      // together — they are kept apart so a future split stays expressible.
      capabilities: Object.freeze({
        declarativeStartup: supportsCurrentApi,
        highlightContextMenu: supportsCurrentApi,
        selectionSections: supportsCurrentApi,
        interfaceLanguage: supportsCurrentApi,
        privateFiles: supportsCurrentApi,
        toolbarItems: supportsCurrentApi
      })
    });
  }

  /**
   * Which instance draws the highlights.
   *
   * **The plugin deliberately runs no background instance.** Host highlights
   * are owned per *instance*, not per plugin: when an instance is disposed the
   * host calls `removeInstance` and every mark it drew is erased from the
   * reader. A lazily-woken background instance is torn down a few minutes
   * after it goes idle — so anything it drew disappears with it, and the page
   * cannot clear or update records it does not own.
   *
   * With one instance, ownership is never ambiguous and every mark lives
   * exactly as long as the instance that drew it. See
   * `docs/ARCHITECTURE.md` § בעלות על ההדגשות.
   */
  function ownsEngine(bootContext) {
    return bootContext?.runMode !== 'background';
  }

  // ── Settings ───────────────────────────────────────────────────────────────

  function normalizeColor(color, index) {
    const fallback = DEFAULT_SETTINGS.colors[index] || DEFAULT_SETTINGS.colors[0];
    return {
      id: String(color?.id || `custom-${index}`)
        .replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, MAX_COLOR_ID_LENGTH),
      hex: /^#[0-9a-fA-F]{6,8}$/.test(color?.hex || '') ? toSafeHex(color.hex) : fallback.hex,
      // The label is a menu title as well as a stored value, so it may not
      // carry a control character.
      label: safeMenuText(color?.label).slice(0, 24) || 'צבע',
      enabled: Boolean(color?.enabled),
      opacity: clamp(color?.opacity, 0.15, 1, 0.65),
      markerMode: MARKER_MODES.includes(color?.markerMode) ? color.markerMode : 'text-background',
      borderRadius: Math.round(clamp(color?.borderRadius, 0, 16, 3))
    };
  }

  /** Every settings read and write funnels through here — old, partial and
   *  hostile shapes all come out as one predictable object. */
  function normalizeSettings(raw) {
    const source = sanitizeParsed(raw);
    const settings = Object.assign(structuredCloneSafe(DEFAULT_SETTINGS), source);

    const colors = Array.isArray(settings.colors) && settings.colors.length
      ? settings.colors
      : DEFAULT_SETTINGS.colors;
    const seenIds = new Set();
    settings.colors = colors.slice(0, MAX_COLORS).map((color, index) => {
      const normalized = normalizeColor(color, index);
      const base = normalized.id;
      for (let suffix = 2; seenIds.has(normalized.id); suffix += 1) {
        const tail = `-${suffix}`;
        normalized.id = base.slice(0, MAX_COLOR_ID_LENGTH - tail.length) + tail;
      }
      seenIds.add(normalized.id);
      return normalized;
    });

    settings.schemaVersion = SETTINGS_SCHEMA_VERSION;
    settings.menuStyle = settings.menuStyle === 'submenu' ? 'submenu' : 'buttonRow';
    settings.language = LANGUAGES.includes(settings.language) ? settings.language : 'auto';
    settings.autoBackup = settings.autoBackup !== false;

    const view = Object.assign({}, DEFAULT_SETTINGS.view, settings.view || {});
    view.sort = SORT_MODES.includes(view.sort) ? view.sort : 'newest';
    view.group = GROUP_MODES.includes(view.group) ? view.group : 'none';
    view.tab = TABS.includes(view.tab) ? view.tab : 'highlights';
    settings.view = view;

    const appearance = Object.assign({}, DEFAULT_SETTINGS.appearance, settings.appearance || {});
    appearance.viewMode = VIEW_MODES.includes(appearance.viewMode) ? appearance.viewMode : 'content';
    appearance.fontFamily = FONT_CHOICES.includes(appearance.fontFamily) ? appearance.fontFamily : 'app';
    appearance.fontSize = Math.round(clamp(appearance.fontSize, 13, 26, 18));
    appearance.lineHeight = Math.round(clamp(appearance.lineHeight, 1.2, 2, 1.5) * 10) / 10;
    settings.appearance = appearance;

    const exportTemplate = Object.assign({}, DEFAULT_SETTINGS.exportTemplate, settings.exportTemplate || {});
    exportTemplate.format = EXPORT_FORMATS.includes(exportTemplate.format) ? exportTemplate.format : 'markdown';
    for (const key of ['includeBook', 'includeRef', 'includeNote', 'includeTags', 'includeDate']) {
      exportTemplate[key] = exportTemplate[key] !== false;
    }
    settings.exportTemplate = exportTemplate;

    // Enabled, not merely present: the default drives the Ctrl+Alt+H
    // shortcut, and marking with a color the user has switched off — one that
    // is not even in the menu — is not something they can explain.
    if (!settings.colors.some(color => color.id === settings.defaultColorId && color.enabled)) {
      settings.defaultColorId = settings.colors.find(color => color.enabled)?.id
        || settings.colors[0].id;
    }
    return settings;
  }

  function enabledColors(settings) {
    return (settings?.colors || []).filter(color => color.enabled).slice(0, MAX_MENU_COLORS);
  }

  function findColor(settings, colorId) {
    return (settings?.colors || []).find(color => color.id === colorId)
      || DEFAULT_SETTINGS.colors.find(color => color.id === colorId)
      || { id: String(colorId || 'yellow'), hex: '#FFF176', label: 'צבע', opacity: 0.65, markerMode: 'text-background', borderRadius: 3 };
  }

  function defaultColor(settings) {
    return findColor(settings, settings?.defaultColorId)
      || enabledColors(settings)[0]
      || DEFAULT_SETTINGS.colors[0];
  }

  // ── Context menu payloads ──────────────────────────────────────────────────

  function colorItemId(colorId) {
    return `${COLOR_ITEM_PREFIX}${colorId}`;
  }

  function colorIdFromItemId(itemId) {
    const value = String(itemId || '');
    return value.startsWith(COLOR_ITEM_PREFIX) ? value.slice(COLOR_ITEM_PREFIX.length) : '';
  }

  /**
   * The colors item, in whichever shape the user picked. Returned as a plain
   * payload so `reader.addContextMenuItem` and `reader.updateContextMenuItem`
   * (and the tests) all build it the same way.
   *
   * `null` when no color is enabled — the caller keeps the previous menu rather
   * than registering an empty one, which the Host rejects.
   */
  function buildColorMenuPayload(settings, translate = value => value) {
    const colors = enabledColors(settings);
    if (!colors.length) return null;
    const title = safeMenuText(translate('מרקר'));
    if (settings.menuStyle === 'submenu') {
      return {
        id: MENU_COLORS_ID,
        type: 'submenu',
        title,
        icon: 'highlight_24_regular',
        contexts: [...SELECTION_CONTEXTS],
        children: [
          ...colors.map(color => ({
            id: colorItemId(color.id),
            type: 'item',
            title: safeMenuText(translate(color.label)),
            icon: 'highlight_24_regular'
          })),
          clearMenuEntry(translate)
        ]
      };
    }
    return {
      id: MENU_COLORS_ID,
      // The host discards a colour row's title — `AppContextMenuEntry.colorRow`
      // hardcodes `label = null` — so it is sent for the submenu shape only.
      // Users who want the name visible pick the submenu style in settings.
      type: 'color-row',
      title,
      contexts: [...SELECTION_CONTEXTS],
      colors: [
        ...colors.map(color => ({
          id: colorItemId(color.id),
          color: toSafeHex(color.hex),
          label: safeMenuText(translate(color.label))
          // No `selected`: the host draws it as a thick primary-coloured ring,
          // which reads as a rendering artifact rather than "this is your
          // default colour".
        })),
        clearMenuEntry(translate)
      ]
    };
  }

  /**
   * The eraser entry, in the shape each menu style needs.
   *
   * `toSafeHex` is bypassed on purpose: it keeps six hex digits and would
   * turn the transparent value into opaque black, which the host would then
   * draw as a black swatch instead of the eraser icon.
   */
  function clearMenuEntry(translate = value => value) {
    return {
      id: colorItemId(CLEAR_COLOR_ID),
      type: 'item',
      color: CLEAR_COLOR_VALUE,
      title: safeMenuText(translate('נקה סימון')),
      label: safeMenuText(translate('נקה סימון')),
      icon: 'eraser_24_regular'
    };
  }

  /**
   * Right-click directly on a highlight — shown without any selection.
   *
   * A submenu rather than two top-level items: the host caps a plugin at two
   * top-level entries, and the colour row already owns one of them.
   * `openPlugin` on the note entry opens the plugin page and delivers the
   * click to it, which is how the editor knows which highlight to open.
   */
  function buildHighlightMenuPayload(translate = value => value) {
    return {
      id: MENU_HIGHLIGHT_ID,
      type: 'submenu',
      title: safeMenuText(translate('מרקר')),
      icon: 'highlight_24_regular',
      contexts: [...HIGHLIGHT_CONTEXTS],
      children: [
        {
          id: MENU_NOTE_ID,
          type: 'item',
          title: safeMenuText(translate('ערוך הערה')),
          icon: 'note_edit_24_regular',
          openPlugin: true
        },
        {
          id: MENU_REMOVE_ID,
          type: 'item',
          title: safeMenuText(translate('הסר סימון')),
          icon: 'eraser_24_regular'
        }
      ]
    };
  }

  function buildToolbarPayload(translate = value => value) {
    return {
      id: TOOLBAR_ITEM_ID,
      type: 'button',
      title: safeMenuText(translate('מרקר — ניהול ההדגשות')),
      icon: 'highlight_24_regular',
      contexts: ['reader-text'],
      openPlugin: true
    };
  }

  /** Cheap equality key: skip the menu RPC when nothing visible changed. */
  function menuSignature(settings, language) {
    return JSON.stringify([
      language || 'he',
      settings?.menuStyle,
      settings?.defaultColorId,
      enabledColors(settings).map(color => [color.id, toSafeHex(color.hex), color.label])
    ]);
  }

  // ── Text & tags ────────────────────────────────────────────────────────────

  function normalizeSearchText(value) {
    return String(value || '')
      .normalize('NFKD')
      .replace(/[֑-ׇ]/g, '')
      .replace(/[‎‏‪-‮]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLocaleLowerCase('he');
  }

  function normalizeTags(value) {
    const values = Array.isArray(value) ? value : String(value || '').split(/[,،;]/);
    const unique = new Map();
    for (const raw of values) {
      const tag = String(raw || '').replace(/\s+/g, ' ').trim().slice(0, 40);
      const key = normalizeSearchText(tag);
      if (key && !unique.has(key)) unique.set(key, tag);
      if (unique.size >= MAX_TAGS_PER_HIGHLIGHT) break;
    }
    return [...unique.values()];
  }

  // ── Selection & ranges ─────────────────────────────────────────────────────

  /**
   * The host's own caps on a `text-range-v1` anchor
   * (`PluginTextRangeAnchor` / `PluginAnchorContext`).
   *
   * The host counts **grapheme clusters** (`String.characters.length` in
   * Dart), and so must we. Code points are the wrong unit and in the
   * dangerous direction: pointed Hebrew runs about three code points per
   * grapheme, so a 4,000-grapheme selection from a vocalized text is 12,000
   * code points — well inside the host's limit, and rejected by a code-point
   * bound. The user would lose the mark.
   */
  const MAX_ANCHOR_EXACT_TEXT = 10000;
  const MAX_ANCHOR_CONTEXT = 128;
  /**
   * A ceiling on the stored record, not a host rule. Set far above anything a
   * legal anchor can reach — 10,000 graphemes of heavily pointed text is on
   * the order of 60,000 UTF-16 units — so it only ever catches the abuse it
   * exists for: a hand-edited backup measured at 5 MB per record.
   */
  const MAX_ANCHOR_BYTES = 262144;

  const graphemeSegmenter = typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function'
    ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
    : null;

  /**
   * Grapheme clusters in `value`, or `null` where the engine cannot count
   * them. `null` means "unknown", and an unknown length is never grounds for
   * rejection — the host is the authority, and guessing low loses data.
   */
  function graphemeCount(value) {
    if (!graphemeSegmenter) return null;
    let count = 0;
    // eslint-disable-next-line no-unused-vars
    for (const _segment of graphemeSegmenter.segment(String(value ?? ''))) count += 1;
    return count;
  }

  /** `true` only when the text is *known* to exceed `max` graphemes. */
  function exceedsGraphemes(value, max) {
    const count = graphemeCount(value);
    return count !== null && count > max;
  }

  /**
   * The anchor to store, or `null` when it is unusable.
   *
   * An anchor is passed to the host verbatim, and a stored record is written
   * back on every load, so an unbounded one is both a rejected `setHighlight`
   * and a storage record that grows without limit — a hand-edited backup was
   * measured at 5 MB per record. Anything the host would refuse outright is
   * dropped here instead: the highlight stays in the list, it simply cannot be
   * redrawn, which is exactly what the `failed_to_anchor` status is for.
   */
  function normalizeSourceRange(range) {
    if (!range || typeof range !== 'object' || Array.isArray(range)) return null;
    if (!rangeBounds(range)) return null;
    if (range.type != null && range.type !== 'text-range-v1') return null;
    if (range.exactText != null
      && (typeof range.exactText !== 'string'
        || exceedsGraphemes(range.exactText, MAX_ANCHOR_EXACT_TEXT))) return null;
    for (const side of ['beforeText', 'afterText']) {
      const raw = range[side]?.raw;
      if (raw != null
        && (typeof raw !== 'string' || exceedsGraphemes(raw, MAX_ANCHOR_CONTEXT))) return null;
    }
    let serialized;
    try {
      serialized = JSON.stringify(range);
    } catch {
      return null;   // a cycle, or a value JSON cannot represent
    }
    if (!serialized || serialized.length > MAX_ANCHOR_BYTES) return null;
    // A copy, not the caller's object: an imported anchor is untrusted input
    // like any other, and it is about to be stored and sent to the host.
    return sanitizeParsed(range);
  }

  function rangeBounds(range) {
    const start = range?.start?.utf16 ?? range?.start?.grapheme;
    const end = range?.end?.utf16 ?? range?.end?.grapheme;
    return Number.isInteger(start) && Number.isInteger(end) && start < end ? { start, end } : null;
  }

  function rangesOverlap(first, second) {
    const a = rangeBounds(first);
    const b = rangeBounds(second);
    return !!a && !!b && a.start < b.end && b.start < a.end;
  }

  function selectedTextOf(selection) {
    return String(selection?.sourceSelectedText
      || selection?.renderedSelectedText
      || selection?.text
      || selection?.selectedText
      || '');
  }

  function sectionIndexOf(selection) {
    return selection?.sectionIndex ?? selection?.currentIndex ?? null;
  }

  function bookIdOf(selection) {
    return selection?.bookId || selection?.currentBookId || '';
  }

  function bookTitleOf(selection) {
    return selection?.bookTitle || selection?.currentBook || bookIdOf(selection);
  }

  /**
   * The per-section anchors a highlight should be written to.
   *
   * Since 0.9.97 the Host resolves a multi-paragraph selection itself and hands
   * back `selection.sections`, one fully anchored entry per paragraph. A
   * single-paragraph selection keeps the flat shape. Anything without a
   * `sourceRange` cannot be anchored and is dropped, so a partial highlight is
   * never written.
   */
  function selectionTargets(selection) {
    if (!selection) return [];
    const parts = Array.isArray(selection.sections) && selection.sections.length
      ? selection.sections
      : [selection];
    const targets = [];
    for (const part of parts) {
      const sectionIndex = sectionIndexOf(part);
      if (!part?.sourceRange || !Number.isInteger(sectionIndex) || sectionIndex < 0) continue;
      if (!rangeBounds(part.sourceRange)) continue;
      targets.push({
        sectionIndex,
        range: part.sourceRange,
        text: selectedTextOf(part)
      });
    }
    return targets;
  }

  function hasUsableSelection(selection) {
    return Boolean(bookIdOf(selection)) && selectionTargets(selection).length > 0;
  }

  function clickedHighlightIds(selection, pluginId) {
    const clicked = Array.isArray(selection?.clickedHighlights) ? selection.clickedHighlights : [];
    return clicked
      .filter(entry => !pluginId || !entry?.pluginId || entry.pluginId === pluginId)
      .map(entry => String(entry?.highlightId || ''))
      .filter(isSafeHighlightId);
  }

  // ── Highlight records ──────────────────────────────────────────────────────

  /** The Host draws `backgroundColor` + `opacity`; the extra fields describe
   *  the plugin's own marker modes and round-trip through storage. */
  function buildHighlightStyle(colorValue) {
    const color = typeof colorValue === 'string' ? { hex: colorValue } : (colorValue || {});
    const markerMode = MARKER_MODES.includes(color.markerMode) ? color.markerMode : 'text-background';
    return {
      backgroundColor: toSafeHex(color.backgroundColor || color.hex),
      opacity: clamp(color.opacity, 0.15, 1, 0.65),
      underline: markerMode === 'underline',
      borderRadius: Math.round(clamp(color.borderRadius, 0, 16, 0)),
      markerMode,
      priority: 10
    };
  }

  function makeHighlightId(sectionIndex, colorId) {
    const random = global.crypto?.getRandomValues
      ? [...global.crypto.getRandomValues(new Uint32Array(2))].map(value => value.toString(36)).join('')
      : Math.random().toString(36).slice(2, 14);
    return `marker-${Date.now().toString(36)}-${sectionIndex}-${colorId}-${random}`
      .replace(/[^A-Za-z0-9._-]/g, '-')
      .slice(0, 128);
  }

  /** Storage keys and Host calls only accept this compact id shape. */
  function isSafeHighlightId(value) {
    return typeof value === 'string' && /^[A-Za-z0-9._-]{1,128}$/.test(value);
  }

  function highlightKey(highlightId) {
    return `${HIGHLIGHT_PREFIX}${highlightId}`;
  }

  /**
   * One stored highlight, normalized. Unknown fields are dropped on purpose:
   * the record is written back to storage, so an open-ended shape would let
   * one bad import poison every later read.
   */
  function normalizeHighlight(raw, key) {
    if (!raw || !isSafeHighlightId(raw.highlightId)) return null;
    const sectionIndex = Number(raw.sectionIndex);
    // Both are host payload fields: `_requiredString(payload, 'bookId',
    // maxLength: 500)` runs them through `_optionalText`, so a control
    // character or an over-long value fails every call for that record.
    const bookId = safeHighlightText(raw.bookId || raw.book).slice(0, 500);
    if (!bookId || !Number.isInteger(sectionIndex) || sectionIndex < 0) return null;
    const anchor = normalizeSourceRange(raw.sourceRange);
    if (!anchor) return null;
    return {
      highlightId: raw.highlightId,
      groupId: isSafeHighlightId(raw.groupId) ? raw.groupId : null,
      bookId,
      bookUid: typeof raw.bookUid === 'string'
        ? (safeHighlightText(raw.bookUid).slice(0, 200) || null)
        : null,
      book: String(raw.book || bookId).slice(0, 500),
      sectionIndex,
      colorId: String(raw.colorId || 'yellow').slice(0, 64),
      color: toSafeHex(raw.color),
      style: buildHighlightStyle(raw.style || { hex: raw.color }),
      text: String(raw.text || '').slice(0, 20000),
      ref: String(raw.ref || '').slice(0, 1000),
      // `note` is the plain-text mirror: it drives search, the Markdown and
      // text exports, and it is the fallback whenever `noteHtml` is absent
      // (records written before rich notes existed have only this).
      note: String(raw.note || '').slice(0, MAX_NOTE_LENGTH),
      noteHtml: String(raw.noteHtml || '').slice(0, MAX_NOTE_HTML_LENGTH),
      tags: normalizeTags(raw.tags),
      favorite: raw.favorite === true,
      sourceRange: anchor,
      version: Number.isInteger(raw.version) ? raw.version : null,
      etag: typeof raw.etag === 'string' ? raw.etag.slice(0, 300) : null,
      status: ['active', 'stale', 'failed_to_anchor'].includes(raw.status) ? raw.status : 'active',
      timestamp: Number.isFinite(raw.timestamp) ? raw.timestamp : Date.now(),
      key: key || highlightKey(raw.highlightId)
    };
  }

  function isStale(highlight) {
    return highlight?.status === 'stale' || highlight?.status === 'failed_to_anchor';
  }

  /** Parts of a multi-paragraph highlight live and die together. */
  function expandByGroup(items, all) {
    const groups = new Set(items.map(item => item.groupId).filter(Boolean));
    if (!groups.size) return [...items];
    const out = [...items];
    for (const item of all) {
      if (item.groupId && groups.has(item.groupId) && !out.includes(item)) out.push(item);
    }
    return out;
  }

  /** Stored highlights that the given targets would paint over. */
  function highlightsOverlappingTargets(all, bookId, targets) {
    const out = [];
    for (const target of targets) {
      for (const item of all) {
        if (item.bookId !== bookId || item.sectionIndex !== target.sectionIndex) continue;
        if (target.range && !rangesOverlap(item.sourceRange, target.range)) continue;
        if (!out.includes(item)) out.push(item);
      }
    }
    return expandByGroup(out, all);
  }

  // ── Note sanitizing policy ─────────────────────────────────────────────────
  //
  // The rules that decide what is safe inside a note live here, apart from the
  // DOM walk that applies them (`marker-richtext.js`). Keeping the policy pure
  // is what makes it testable: a sanitizer nobody can test is a sanitizer
  // nobody should trust, and stored notes can come from an imported file this
  // plugin never wrote.

  /** Allowed tags, mapped to the tag actually emitted. */
  const NOTE_TAGS = Object.freeze({
    B: 'b', STRONG: 'b', I: 'i', EM: 'i', U: 'u', S: 's', STRIKE: 's', DEL: 's',
    MARK: 'mark', H2: 'h2', H3: 'h3', P: 'p', DIV: 'p', BR: 'br',
    UL: 'ul', OL: 'ol', LI: 'li', BLOCKQUOTE: 'blockquote',
    A: 'a', SPAN: 'span', FONT: 'span'
  });

  /** `font-size` is the only declaration that survives, and only as a keyword. */
  const NOTE_FONT_SIZES = Object.freeze([
    'xx-small', 'x-small', 'small', 'medium', 'large', 'x-large', 'xx-large'
  ]);
  /** `execCommand('fontSize')` and `<font size>` both speak 1-7. */
  const NOTE_SIZE_LEVELS = Object.freeze(['1', '2', '3', '4', '5', '6', '7']);
  const NOTE_MAX_DEPTH = 20;

  /** The emitted tag name for `tagName`, or `''` when it must be unwrapped. */
  function noteTagFor(tagName) {
    return NOTE_TAGS[String(tagName || '').toUpperCase()] || '';
  }

  /**
   * The href to emit, or `''` to turn the link into plain text.
   *
   * Only absolute http(s) URLs pass. `javascript:` is the obvious attack, but
   * `data:` and a bare relative path matter just as much: the first can carry
   * script, and the second would navigate the plugin's own WebView away from
   * its page.
   */
  function safeNoteHref(value) {
    const href = String(value ?? '').trim();
    if (!href || href.length > 2000) return '';
    // Browsers ignore control characters inside a scheme, so `java\tscript:`
    // navigates while a naive prefix check sees something harmless. Strip them
    // before testing, and reject anything with whitespace left in it.
    const clean = href.replace(/[\u0000-\u001F\u007F]/g, '');
    if (/\s/.test(clean)) return '';
    return /^https?:\/\/\S+$/i.test(clean) ? clean : '';
  }

  /**
   * The allowlisted tags a `style` attribute stands for.
   *
   * Bold and its neighbours can arrive as CSS rather than as tags — that is
   * what `execCommand` emits under `styleWithCSS`, and it is what most
   * pasted content carries. The sanitizer keeps no declaration but
   * `font-size`, so without this the styling is dropped: the user watches
   * the text go bold while typing and finds it plain after saving.
   *
   * Mapping to tags rather than allowing the declarations through keeps the
   * output inside the existing allowlist, and keeps one shape in storage
   * whatever the engine produced.
   */
  function noteStyleTags(styleValue) {
    const style = String(styleValue ?? '').toLowerCase();
    const tags = [];
    const weight = /font-weight\s*:\s*([a-z0-9]+)/.exec(style)?.[1];
    if (weight === 'bold' || weight === 'bolder' || Number(weight) >= 600) tags.push('b');
    if (/font-style\s*:\s*(italic|oblique)/.test(style)) tags.push('i');
    const decoration = /text-decoration[a-z-]*\s*:\s*([^;]+)/.exec(style)?.[1] || '';
    if (decoration.includes('underline')) tags.push('u');
    if (decoration.includes('line-through')) tags.push('s');
    return tags;
  }

  /** The `font-size` keyword to emit, from either a style string or `size`. */
  function safeNoteFontSize(styleValue, sizeAttribute) {
    const match = /font-size\s*:\s*([a-z-]+)/i.exec(String(styleValue ?? ''));
    const keyword = match ? match[1].toLowerCase() : '';
    if (NOTE_FONT_SIZES.includes(keyword)) return keyword;
    const level = NOTE_SIZE_LEVELS.indexOf(String(sizeAttribute ?? '').trim());
    return level >= 0 ? NOTE_FONT_SIZES[level] : '';
  }

  // ── Sorting, filtering & grouping ──────────────────────────────────────────

  function hebrewCompare(a, b) {
    return String(a || '').localeCompare(String(b || ''), 'he', { numeric: true });
  }

  function highlightHaystack(item, colorLabel) {
    return normalizeSearchText([
      item.text, item.note, item.tags.join(' '), item.book, item.bookId, item.ref, colorLabel
    ].join(' '));
  }

  function hasNote(item) {
    return Boolean(item?.note?.trim() || item?.noteHtml?.trim());
  }

  function matchesStatus(item, status) {
    switch (status) {
      case 'favorites': return item.favorite === true;
      case 'stale': return isStale(item);
      case 'noted': return hasNote(item);
      case 'tagged': return item.tags.length > 0;
      default: return true;
    }
  }

  function filterHighlights(all, filters, colorLabelOf) {
    const query = normalizeSearchText(filters?.query);
    return all.filter(item => {
      if (filters?.bookId && filters.bookId !== 'all' && item.bookId !== filters.bookId) return false;
      if (filters?.colorId && filters.colorId !== 'all' && item.colorId !== filters.colorId) return false;
      if (filters?.tag && filters.tag !== 'all' && !item.tags.includes(filters.tag)) return false;
      if (!matchesStatus(item, filters?.status)) return false;
      if (query && !highlightHaystack(item, colorLabelOf(item.colorId)).includes(query)) return false;
      return true;
    });
  }

  /** Counts for the summary strip, and for the empty-state wording. */
  function summarize(all) {
    const byColor = new Map();
    const books = new Set();
    let noted = 0;
    let tagged = 0;
    let favorites = 0;
    let stale = 0;
    for (const item of all) {
      byColor.set(item.colorId, (byColor.get(item.colorId) || 0) + 1);
      books.add(item.bookId);
      if (hasNote(item)) noted++;
      if (item.tags.length) tagged++;
      if (item.favorite) favorites++;
      if (isStale(item)) stale++;
    }
    return { total: all.length, books: books.size, noted, tagged, favorites, stale, byColor };
  }

  function sortHighlights(items, mode, colorLabelOf) {
    const byLocation = (a, b) => hebrewCompare(a.book || a.bookId, b.book || b.bookId)
      || a.sectionIndex - b.sectionIndex;
    const newestFirst = (a, b) => (b.timestamp || 0) - (a.timestamp || 0);
    return [...items].sort((a, b) => {
      switch (mode) {
        case 'oldest': return (a.timestamp || 0) - (b.timestamp || 0);
        case 'book': return byLocation(a, b);
        case 'location':
          return byLocation(a, b)
            || (rangeBounds(a.sourceRange)?.start || 0) - (rangeBounds(b.sourceRange)?.start || 0);
        case 'color':
          return hebrewCompare(colorLabelOf(a.colorId), colorLabelOf(b.colorId)) || newestFirst(a, b);
        case 'favorites':
          return Number(b.favorite) - Number(a.favorite) || newestFirst(a, b);
        default: return newestFirst(a, b);
      }
    });
  }

  // ── Backup ─────────────────────────────────────────────────────────────────

  function buildBackup(settings, highlights, pluginVersion) {
    return {
      format: 'otzaria-marker-backup',
      schemaVersion: BACKUP_SCHEMA_VERSION,
      pluginVersion: String(pluginVersion || ''),
      exportedAt: new Date().toISOString(),
      settings: normalizeSettings(settings),
      highlights: highlights.map(({ key, ...item }) => item)
    };
  }

  class MarkerBackupError extends Error {
    constructor(messageKey) {
      super(messageKey);
      this.name = 'MarkerBackupError';
      this.messageKey = messageKey;
    }
  }

  /**
   * Reads a backup file. Version 1 files (plugin <= 0.9.4) are accepted as-is:
   * the record shape did not change, only fields were added.
   */
  function parseBackup(raw) {
    if (!raw || raw.format !== 'otzaria-marker-backup') {
      throw new MarkerBackupError('זה אינו קובץ גיבוי תקין של מרקר');
    }
    if (![1, BACKUP_SCHEMA_VERSION].includes(raw.schemaVersion)) {
      throw new MarkerBackupError('גרסת קובץ הגיבוי אינה נתמכת');
    }
    if (!Array.isArray(raw.highlights) || raw.highlights.length > 20000) {
      throw new MarkerBackupError('כמות ההדגשות בקובץ אינה תקינה');
    }
    const highlights = [];
    const seen = new Set();
    let skipped = 0;
    for (const entry of raw.highlights) {
      const item = normalizeHighlight(entry);
      if (!item || seen.has(item.highlightId)) { skipped++; continue; }
      seen.add(item.highlightId);
      delete item.key;
      highlights.push(item);
    }
    if (!highlights.length && raw.highlights.length) {
      throw new MarkerBackupError('לא נמצאה בקובץ אף הדגשה תקינה');
    }
    return { settings: normalizeSettings(raw.settings), highlights, skipped };
  }

  /** What an import would change, so the confirmation dialog can be honest. */
  function planImport(current, incoming) {
    const currentById = new Map(current.map(item => [item.highlightId, item]));
    const signature = item => JSON.stringify([
      item.bookId, item.sectionIndex, item.colorId, item.color, item.text,
      item.note, item.noteHtml, item.tags, item.favorite, item.style,
      item.ref, item.book, item.sourceRange
    ]);
    const plan = { added: [], updated: [], identical: [] };
    for (const item of incoming) {
      const existing = currentById.get(item.highlightId);
      if (!existing) plan.added.push(item);
      else if (signature(existing) === signature(item)) plan.identical.push(item);
      else plan.updated.push(item);
    }
    return plan;
  }

  global.MarkerDomain = Object.freeze({
    SETTINGS_SCHEMA_VERSION, BACKUP_SCHEMA_VERSION, HOST_TARGET_VERSION,
    SETTINGS_KEY, HIGHLIGHT_PREFIX,
    MAX_COLORS, MAX_MENU_COLORS, MAX_TAGS_PER_HIGHLIGHT, HIGHLIGHTS_PAGE_SIZE,
    MAX_NOTE_LENGTH, MAX_NOTE_HTML_LENGTH,
    MENU_COLORS_ID, MENU_HIGHLIGHT_ID, MENU_REMOVE_ID, MENU_NOTE_ID,
    TOOLBAR_ITEM_ID, COLOR_ITEM_PREFIX, MAX_COLOR_ID_LENGTH,
    CLEAR_COLOR_ID, CLEAR_COLOR_VALUE, clearMenuEntry,
    safeHighlightText, safeMenuText,
    SELECTION_CONTEXTS, HIGHLIGHT_CONTEXTS, LEGACY_MENU_IDS,
    COMMAND_HIGHLIGHT_DEFAULT, COMMAND_OPEN_PANEL,
    HIGHLIGHT_SOURCES, HIGHLIGHT_SOURCE, MAX_METADATA_TAGS, MAX_METADATA_TAG_LENGTH,
    MARKER_MODES, VIEW_MODES, EXPORT_FORMATS, LANGUAGES, FONT_CHOICES,
    SORT_MODES, GROUP_MODES, TABS, STATUS_FILTERS,
    DEFAULT_SETTINGS, MarkerBackupError,

    structuredCloneSafe, sanitizeParsed, escapeHtml, escapeMarkdownBlocks,
    clamp, hexToRgba, toSafeHex,
    compareHostVersions, hasPermission, directionForLanguage,
    normalizeBootContext, ownsEngine,
    normalizeSettings, enabledColors, findColor, defaultColor,
    colorItemId, colorIdFromItemId, buildColorMenuPayload, buildHighlightMenuPayload,
    buildToolbarPayload, menuSignature,
    NOTE_TAGS, NOTE_FONT_SIZES, NOTE_SIZE_LEVELS, NOTE_MAX_DEPTH,
    noteTagFor, safeNoteHref, safeNoteFontSize, noteStyleTags,
    normalizeSearchText, normalizeTags,
    rangeBounds, rangesOverlap, selectedTextOf, normalizeSourceRange,
    MAX_ANCHOR_EXACT_TEXT, MAX_ANCHOR_CONTEXT, MAX_ANCHOR_BYTES, sectionIndexOf, bookIdOf, bookTitleOf,
    selectionTargets, hasUsableSelection, clickedHighlightIds,
    buildHighlightStyle, buildHighlightMetadata,
    makeHighlightId, isSafeHighlightId, highlightKey,
    normalizeHighlight, isStale, hasNote, expandByGroup, highlightsOverlappingTargets,
    hebrewCompare, matchesStatus, filterHighlights, sortHighlights, summarize,
    buildBackup, parseBackup, planImport
  });
})(globalThis);
