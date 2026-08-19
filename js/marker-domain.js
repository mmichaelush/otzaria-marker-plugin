(function (global) {
  'use strict';

  /**
   * Pure domain helpers for the marker plugin.
   *
   * This module deliberately does not access the DOM, Otzaria, timers, or
   * plugin state. Keeping these rules in one place makes storage migrations,
   * rendering, and tests use the same normalization behavior.
   */
  const MAX_COLORS = 12;
  const MAX_MENU_COLORS = 5;
  const HIGHLIGHTS_PAGE_SIZE = 100;
  const SETTINGS_KEY = 'marker_settings';
  const HIGHLIGHT_PREFIX = 'highlight:';
  const HOST_TARGET_VERSION = '0.9.96';
  const FUTURE_HOST_BASELINE = '0.9.97';

  const DEFAULT_SETTINGS = Object.freeze({
    colors: [
      { id: 'yellow', hex: '#f1e784ff', label: '\u05E6\u05D4\u05D5\u05D1', enabled: true },
      { id: 'green', hex: '#8bcf8dff', label: '\u05D9\u05E8\u05D5\u05E7', enabled: true },
      { id: 'blue', hex: '#88bde9ff', label: '\u05DB\u05D7\u05D5\u05DC', enabled: true },
      { id: 'red', hex: '#f37e75ff', label: '\u05D0\u05D3\u05D5\u05DD', enabled: true },
      { id: 'orange', hex: '#f0bd72ff', label: '\u05DB\u05EA\u05D5\u05DD', enabled: true },
      { id: 'purple', hex: '#e297f0ff', label: '\u05E1\u05D2\u05D5\u05DC', enabled: false }
    ],
    defaultColorId: 'yellow',
    menuStyle: 'buttonRow',
    appearance: { viewMode: 'content', fontFamily: 'app', fontSize: 18, lineHeight: 1.5 },
    exportTemplate: {
      format: 'markdown', includeBook: true, includeRef: true,
      includeNote: true, includeTags: true, includeDate: true
    },
    maxColors: MAX_COLORS
  });

  function structuredCloneSafe(value) {
    return JSON.parse(JSON.stringify(value));
  }

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

  /**
   * Normalizes plugin.boot without calling a version-specific Host API.
   * 0.9.96 reports Hebrew; newer hosts may also provide app.language.
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
    const defaultDirection = ['he', 'ar', 'fa', 'ur'].includes(language) ? 'rtl' : 'ltr';
    const textDirection = ['rtl', 'ltr'].includes(app.textDirection)
      ? app.textDirection
      : defaultDirection;
    const runMode = app.runMode === 'background' ? 'background' : 'foreground';

    return Object.freeze({
      appVersion,
      platform: String(app.platform || 'unknown'),
      locale,
      language,
      textDirection,
      runMode,
      capabilities: Object.freeze({
        declarativeStartup: compareHostVersions(appVersion, HOST_TARGET_VERSION) >= 0,
        interfaceLanguage: compareHostVersions(appVersion, FUTURE_HOST_BASELINE) >= 0 && Boolean(reportedLanguage),
        backgroundDone: compareHostVersions(appVersion, FUTURE_HOST_BASELINE) >= 0
      })
    });
  }

  function hasPermission(permissions, permission) {
    return Array.isArray(permissions) && permissions.includes(permission);
  }

  /** Current 0.9.96 ownership model. Declarative startup is intentionally inactive. */
  function ownsLegacyRuntime(bootContext, permissions) {
    return bootContext?.runMode === 'background'
      || !hasPermission(permissions, 'app.run_on_startup');
  }

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>'"]/g,
      ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[ch]));
  }

  function hexToRgba(hex, alpha) {
    const match = /^#?([0-9a-f]{6})/i.exec(hex || '');
    if (!match) return `rgba(103,80,164,${alpha})`;
    const value = match[1];
    return `rgba(${parseInt(value.slice(0, 2), 16)},${parseInt(value.slice(2, 4), 16)},${parseInt(value.slice(4, 6), 16)},${alpha})`;
  }

  /** Strip alpha so color values passed to the Host API are always #RRGGBB. */
  function toSafeHex(hex) {
    const match = /^#([0-9a-fA-F]{6})/.exec(hex || '');
    return match ? `#${match[1]}` : '#FFF176';
  }

  function normalizeSettings(raw) {
    const source = raw && typeof raw === 'object' ? raw : {};
    const settings = Object.assign(structuredCloneSafe(DEFAULT_SETTINGS), source);
    const colors = Array.isArray(settings.colors) ? settings.colors : DEFAULT_SETTINGS.colors;
    settings.colors = colors.slice(0, MAX_COLORS).map((color, index) => {
      const borderRadius = Number(color?.borderRadius);
      return {
        id: String(color?.id || `custom-${Date.now()}-${index}`).replace(/[^a-zA-Z0-9_-]/g, '-'),
        hex: /^#[0-9a-fA-F]{6,8}$/.test(color?.hex || '') ? color.hex : (DEFAULT_SETTINGS.colors[index]?.hex || '#FFF176'),
        label: String(color?.label || '\u05E6\u05D1\u05E2').slice(0, 24),
        enabled: Boolean(color?.enabled),
        opacity: Math.min(1, Math.max(0.15, Number(color?.opacity) || 0.65)),
        markerMode: ['text-background', 'underline', 'box', 'line-marker'].includes(color?.markerMode) ? color.markerMode : 'text-background',
        borderRadius: Number.isFinite(borderRadius) ? Math.min(16, Math.max(0, borderRadius)) : 3
      };
    });
    settings.maxColors = MAX_COLORS;
    settings.menuStyle = settings.menuStyle === 'submenu' ? 'submenu' : 'buttonRow';
    const appearance = Object.assign({}, DEFAULT_SETTINGS.appearance, settings.appearance || {});
    const allowedViews = ['content', 'tiles', 'list', 'compact', 'details'];
    const allowedFonts = ['app', 'system', 'FrankRuhlCLM', 'TaameyDavidCLM', 'TaameyAshkenaz', 'KeterYG', 'Shofar', 'NotoSerifHebrew', 'NotoRashiHebrew', 'Tinos', 'Rubik'];
    appearance.viewMode = allowedViews.includes(appearance.viewMode) ? appearance.viewMode : 'content';
    appearance.fontFamily = allowedFonts.includes(appearance.fontFamily) ? appearance.fontFamily : 'app';
    appearance.fontSize = Math.min(26, Math.max(13, Number(appearance.fontSize) || 18));
    appearance.lineHeight = Math.min(2, Math.max(1.2, Number(appearance.lineHeight) || 1.5));
    settings.appearance = appearance;
    const exportTemplate = Object.assign({}, DEFAULT_SETTINGS.exportTemplate, settings.exportTemplate || {});
    exportTemplate.format = ['markdown', 'html', 'text'].includes(exportTemplate.format) ? exportTemplate.format : 'markdown';
    for (const key of ['includeBook', 'includeRef', 'includeNote', 'includeTags', 'includeDate']) exportTemplate[key] = exportTemplate[key] !== false;
    settings.exportTemplate = exportTemplate;
    if (!settings.colors.some(color => color.id === settings.defaultColorId)) settings.defaultColorId = settings.colors.find(color => color.enabled)?.id || settings.colors[0]?.id || 'yellow';
    return settings;
  }

  function normalizeSearchText(value) {
    return String(value || '').normalize('NFKD').replace(/[\u0591-\u05C7]/g, '').replace(/[\u200E\u200F\u202A-\u202E]/g, '').replace(/\s+/g, ' ').trim().toLocaleLowerCase('he');
  }

  function normalizeTags(value) {
    const values = Array.isArray(value) ? value : String(value || '').split(/[,،;]/);
    const unique = new Map();
    for (const raw of values) {
      const tag = String(raw || '').replace(/\s+/g, ' ').trim().slice(0, 40);
      const key = normalizeSearchText(tag);
      if (key && !unique.has(key)) unique.set(key, tag);
      if (unique.size >= 12) break;
    }
    return [...unique.values()];
  }

  function rangeBounds(range) {
    const start = range?.start?.utf16 ?? range?.start?.grapheme;
    const end = range?.end?.utf16 ?? range?.end?.grapheme;
    return Number.isInteger(start) && Number.isInteger(end) && start < end ? { start, end } : null;
  }

  function rangesOverlap(first, second) {
    const a = rangeBounds(first); const b = rangeBounds(second);
    return !!a && !!b && a.start < b.end && b.start < a.end;
  }

  function compactText(value) { return String(value || '').replace(/\s+/g, ''); }
  function splitSelectionPieces(text) { return String(text || '').split('\n').map(piece => piece.trim()).filter(Boolean); }
  function selectedTextOf(selection) { return String(selection?.sourceSelectedText || selection?.renderedSelectedText || selection?.text || selection?.selectedText || ''); }
  function hasUsableSelection(selection) {
    return !!(selection && selectedTextOf(selection).trim() && (selection.currentBookId || selection.bookId) && (selection.currentIndex != null || selection.sectionIndex != null));
  }

  function buildHighlightStyle(colorValue) {
    const color = typeof colorValue === 'string' ? { hex: colorValue } : (colorValue || {});
    return {
      backgroundColor: toSafeHex(color.backgroundColor || color.hex),
      opacity: Math.min(1, Math.max(0.15, Number(color.opacity) || 0.65)),
      underline: color.markerMode === 'underline',
      borderRadius: Math.min(16, Math.max(0, Number(color.borderRadius) || 0)),
      markerMode: color.markerMode || 'text-background',
      priority: 10
    };
  }

  function makeHighlightId(bookId, sectionIndex, colorId) {
    const random = global.crypto?.getRandomValues ? [...global.crypto.getRandomValues(new Uint32Array(2))].map(value => value.toString(36)).join('') : Math.random().toString(36).slice(2, 14);
    return `marker-${Date.now().toString(36)}-${sectionIndex}-${colorId}-${random}`.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 128);
  }

  /** Storage keys and host calls only accept the plugin's compact id format. */
  function isSafeHighlightId(value) {
    return typeof value === 'string' && /^[A-Za-z0-9._-]{1,128}$/.test(value);
  }

  global.MarkerDomain = Object.freeze({
    SETTINGS_KEY, HIGHLIGHT_PREFIX, MAX_COLORS, MAX_MENU_COLORS, HIGHLIGHTS_PAGE_SIZE,
    HOST_TARGET_VERSION, FUTURE_HOST_BASELINE,
    DEFAULT_SETTINGS, structuredCloneSafe, escapeHtml, hexToRgba, toSafeHex,
    normalizeSettings, normalizeSearchText, normalizeTags, rangeBounds, rangesOverlap,
    compactText, splitSelectionPieces, selectedTextOf, hasUsableSelection,
    buildHighlightStyle, makeHighlightId, isSafeHighlightId, compareHostVersions,
    normalizeBootContext, hasPermission, ownsLegacyRuntime
  });
})(globalThis);
