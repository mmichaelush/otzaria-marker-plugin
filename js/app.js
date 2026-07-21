(function () {
  'use strict';

  const SETTINGS_KEY     = 'marker_settings';
  const HIGHLIGHT_PREFIX = 'highlight:';
  const MAX_COLORS       = 12;
  const MAX_MENU_COLORS  = 5;
  const HIGHLIGHTS_PAGE_SIZE = 100;

  const DEFAULT_SETTINGS = {
    colors: [
      { id: 'yellow', hex: '#f1e784ff', label: '\u05E6\u05D4\u05D5\u05D1',  enabled: true  },
      { id: 'green',  hex: '#8bcf8dff', label: '\u05D9\u05E8\u05D5\u05E7',  enabled: true  },
      { id: 'blue',   hex: '#88bde9ff', label: '\u05DB\u05D7\u05D5\u05DC',  enabled: true  },
      { id: 'red',    hex: '#f37e75ff', label: '\u05D0\u05D3\u05D5\u05DD',  enabled: true  },
      { id: 'orange', hex: '#f0bd72ff', label: '\u05DB\u05EA\u05D5\u05DD',  enabled: true  },
      { id: 'purple', hex: '#e297f0ff', label: '\u05E1\u05D2\u05D5\u05DC',  enabled: false },
    ],
    defaultColorId: 'yellow',
    menuStyle: 'buttonRow',
    appearance: {
      viewMode: 'content',
      fontFamily: 'app',
      fontSize: 18,
      lineHeight: 1.5
    },
    exportTemplate: {
      format: 'markdown', includeBook: true, includeRef: true,
      includeNote: true, includeTags: true, includeDate: true
    },
    maxColors: MAX_COLORS
  };

  let settings          = structuredCloneSafe(DEFAULT_SETTINGS);
  let menuRegistered    = false;
  let registeredMenuType = null;
  let allHighlights     = [];
  let uiBound           = false;
  let lastSelection     = null;
  let savedSelection    = null;
  let selectionTimer    = null;
  let dragSrcIndex      = null;
  let uiRefreshTimer    = null;
  let uiRefreshInFlight = false;
  let selectionRevision = 0;
  let lastRenderedHighlightsSignature = null;
  let searchRenderTimer = null;
  const selectedHighlightKeys = new Set();
  let editingHighlightKey = null;
  let visibleHighlightKeys = [];
  let renderedHighlightLimit = HIGHLIGHTS_PAGE_SIZE;
  let lastDeletedHighlights = [];
  let undoDeleteTimer = null;
  let editReturnFocus = null;
  const autoSaveTimers = new Map();
  const autoSaveRevisions = new Map();
  let runMode           = 'foreground';
  let runtimeOwner      = true;

  function hasStartupPermission(permissions) {
    return Array.isArray(permissions) && permissions.includes('app.run_on_startup');
  }

  function isForeground() { return runMode === 'foreground'; }

  const $  = (sel, ctx = document) => ctx.querySelector(sel);
  const $$ = (sel, ctx = document) => [...ctx.querySelectorAll(sel)];

  function structuredCloneSafe(v) { return JSON.parse(JSON.stringify(v)); }

  // ── SDK wrapper ────────────────────────────────────────────────────────────
  async function call(method, payload) {
    const res = await Otzaria.call(method, payload || {});
    if (!res || !res.success) {
      const code = res?.error?.code || 'error.unknown';
      const error = new Error(`${method} [${code}]: ${res?.error?.message || 'unknown error'}`);
      error.code = code;
      error.category = res?.error?.category;
      error.retryable = Boolean(res?.error?.retryable);
      throw error;
    }
    return res.data;
  }

  // ── Utils ──────────────────────────────────────────────────────────────────
  function escapeHtml(v) {
    return String(v ?? '').replace(/[&<>'"]/g,
      ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[ch]));
  }

  function hexToRgba(hex, a) {
    const m = /^#?([0-9a-f]{6})/i.exec(hex || '');
    if (!m) return `rgba(103,80,164,${a})`;
    const n = m[1];
    return `rgba(${parseInt(n.slice(0,2),16)},${parseInt(n.slice(2,4),16)},${parseInt(n.slice(4,6),16)},${a})`;
  }

  /** Strip alpha so color is always safe #RRGGBB for the Host API */
  function toSafeHex(hex) {
    const m = /^#([0-9a-fA-F]{6})/.exec(hex || '');
    return m ? `#${m[1]}` : '#FFF176';
  }

  // ── Settings ───────────────────────────────────────────────────────────────
  function normalizeSettings(raw) {
    const s = Object.assign(structuredCloneSafe(DEFAULT_SETTINGS), raw || {});
    s.colors = (Array.isArray(s.colors) ? s.colors : DEFAULT_SETTINGS.colors).slice(0, MAX_COLORS);
    s.colors = s.colors.map((c, i) => ({
      id:      String(c.id || `custom-${Date.now()}-${i}`).replace(/[^a-zA-Z0-9_-]/g, '-'),
      hex:     /^#[0-9a-fA-F]{6,8}$/.test(c.hex || '') ? c.hex : (DEFAULT_SETTINGS.colors[i]?.hex || '#FFF176'),
      label:   String(c.label || '\u05E6\u05D1\u05E2').slice(0, 24),
      enabled: Boolean(c.enabled),
      opacity: Math.min(1, Math.max(0.15, Number(c.opacity) || 0.65)),
      markerMode: ['text-background', 'underline', 'box', 'line-marker'].includes(c.markerMode) ? c.markerMode : 'text-background',
      borderRadius: Math.min(16, Math.max(0, Number(c.borderRadius) || 3))
    }));
    s.maxColors = MAX_COLORS;
    s.menuStyle = s.menuStyle === 'submenu' ? 'submenu' : 'buttonRow';
    const appearance = Object.assign({}, DEFAULT_SETTINGS.appearance, s.appearance || {});
    const allowedViews = ['content', 'tiles', 'list', 'compact', 'details'];
    const allowedFonts = [
      'app', 'system', 'FrankRuhlCLM', 'TaameyDavidCLM', 'TaameyAshkenaz',
      'KeterYG', 'Shofar', 'NotoSerifHebrew', 'NotoRashiHebrew', 'Tinos', 'Rubik'
    ];
    appearance.viewMode = allowedViews.includes(appearance.viewMode) ? appearance.viewMode : 'content';
    appearance.fontFamily = allowedFonts.includes(appearance.fontFamily) ? appearance.fontFamily : 'app';
    appearance.fontSize = Math.min(26, Math.max(13, Number(appearance.fontSize) || 18));
    appearance.lineHeight = Math.min(2, Math.max(1.2, Number(appearance.lineHeight) || 1.5));
    s.appearance = appearance;
    const exportTemplate = Object.assign({}, DEFAULT_SETTINGS.exportTemplate, s.exportTemplate || {});
    exportTemplate.format = ['markdown', 'html', 'text'].includes(exportTemplate.format) ? exportTemplate.format : 'markdown';
    for (const key of ['includeBook', 'includeRef', 'includeNote', 'includeTags', 'includeDate']) {
      exportTemplate[key] = exportTemplate[key] !== false;
    }
    s.exportTemplate = exportTemplate;
    if (!s.colors.some(c => c.id === s.defaultColorId))
      s.defaultColorId = s.colors.find(c => c.enabled)?.id || s.colors[0]?.id || 'yellow';
    return s;
  }

  async function loadSettings() {
    try {
      settings = normalizeSettings(await call('storage.get', { key: SETTINGS_KEY }));
    } catch { settings = structuredCloneSafe(DEFAULT_SETTINGS); }
    return settings;
  }

  function colorStyleSignature(colors) {
    return JSON.stringify((colors || []).map(color => ({
      id: color.id,
      hex: toSafeHex(color.hex),
      opacity: color.opacity,
      markerMode: color.markerMode,
      borderRadius: color.borderRadius
    })));
  }

  async function syncStoredHighlightStyles() {
    await loadAllHighlights();
    for (const item of allHighlights) {
      const color = settings.colors.find(entry => entry.id === item.colorId);
      if (!color) continue;
      const desired = buildHighlightStyle(color);
      if (JSON.stringify(buildHighlightStyle(item.style || { hex: item.color })) === JSON.stringify(desired)) continue;
      await updateHighlightColor(item, color, { render: false }).catch(error => {
        console.error('Failed syncing highlight style', item.highlightId, error);
      });
    }
  }

  async function saveSettings(next, { refreshUi = true } = {}) {
    const previousColorStyles = colorStyleSignature(settings.colors);
    settings = normalizeSettings(next);
    const colorsChanged = previousColorStyles !== colorStyleSignature(settings.colors);
    await call('storage.set', { key: SETTINGS_KEY, value: settings });
    // כשהרקע הוא בעל המנוע, ה-instance הגלוי עדיין חייב לעדכן מיד את הרישום
    // המשותף. אחרת ניווט למסך ההגדרות מסיר את הפריט והוא חוזר רק באתחול הבא.
    if (isForeground() && !runtimeOwner) {
      await rebuildSharedContextMenu();
    } else if (menuRegistered) {
      await patchOrRebuildMenu();
    } else if (hasUsableSelection(savedSelection || lastSelection)) {
      await registerContextMenuItems();
    }
    if (isForeground() && colorsChanged) await syncStoredHighlightStyles();
    if (isForeground() && refreshUi) {
      renderSettings();
      await renderHighlightList();
    }
  }

  function scheduleAutoSave(next, statusId, delay = 450) {
    const snapshot = structuredCloneSafe(next);
    const revision = (autoSaveRevisions.get(statusId) || 0) + 1;
    autoSaveRevisions.set(statusId, revision);
    clearTimeout(autoSaveTimers.get(statusId));
    const status = $(`#${statusId}`);
    if (status) {
      status.dataset.state = 'saving';
      status.textContent = 'שומר…';
    }
    const timer = setTimeout(async () => {
      try {
        await saveSettings(snapshot, { refreshUi: false });
        if (revision !== autoSaveRevisions.get(statusId)) return;
        if (status) {
          status.dataset.state = 'saved';
          status.textContent = 'נשמר אוטומטית ✓';
        }
      } catch (error) {
        console.error('Automatic settings save failed', error);
        if (revision !== autoSaveRevisions.get(statusId)) return;
        if (status) {
          status.dataset.state = 'error';
          status.textContent = 'השמירה נכשלה';
        }
      }
    }, delay);
    autoSaveTimers.set(statusId, timer);
  }

  // ── Theme ──────────────────────────────────────────────────────────────────
  function applyTheme(theme) {
    if (!theme?.colorScheme) return;
    const cs = theme.colorScheme;
    const r  = document.documentElement;
    const set = (n, v) => { if (v) r.style.setProperty(n, v); };
    set('--color-primary',                cs.primary);
    set('--color-on-primary',             cs.onPrimary);
    set('--color-primary-container',      cs.primaryContainer    || hexToRgba(cs.primary, .12));
    set('--color-on-primary-container',   cs.onPrimaryContainer  || cs.primary);
    set('--color-secondary',              cs.secondary);
    set('--color-on-secondary',           cs.onSecondary);
    set('--color-secondary-container',    cs.secondaryContainer);
    set('--color-on-secondary-container', cs.onSecondaryContainer);
    set('--color-surface',                cs.surface);
    set('--color-on-surface',             cs.onSurface);
    set('--color-on-surface-variant',     cs.onSurfaceVariant);
    set('--color-surface-container-lowest',  cs.surfaceContainerLowest || cs.surface);
    set('--color-surface-container-low',     cs.surfaceContainerLow   || cs.surfaceContainer || cs.surface);
    set('--color-surface-container',         cs.surfaceContainer      || cs.surfaceContainerLow || cs.surface);
    set('--color-surface-container-high',    cs.surfaceContainerHigh  || cs.surfaceContainerHighest);
    set('--color-surface-container-highest', cs.surfaceContainerHighest);
    set('--color-error',              cs.error);
    set('--color-on-error',           cs.onError);
    set('--color-error-container',    cs.errorContainer);
    set('--color-on-error-container', cs.onErrorContainer);
    set('--color-outline',            cs.outline);
    set('--color-outline-variant',    cs.outlineVariant);
    set('--color-scrim',              cs.scrim || '#000000');
    r.style.setProperty('--color-primary-subtle',   hexToRgba(cs.primary,   0.12));
    r.style.setProperty('--color-secondary-subtle', hexToRgba(cs.secondary, 0.10));
    if (theme.typography) {
      const appFont = `'${theme.typography.fontFamily}', 'David', 'Noto Serif Hebrew', serif`;
      r.style.setProperty('--font-app', appFont);
      r.style.setProperty('--font-main', appFont);
      r.style.setProperty('--font-size-base', `${theme.typography.fontSize}px`);
      r.style.setProperty('--line-height',    String(theme.typography.lineHeight));
    }
    document.body.classList.toggle('dark-mode', theme.mode === 'dark');
  }

  function enabledColors() { return settings.colors.filter(c => c.enabled); }
  function menuColors()    { return enabledColors().slice(0, MAX_MENU_COLORS); }

  function applyDisplaySettings() {
    if (!isForeground()) return;
    const appearance = settings.appearance || DEFAULT_SETTINGS.appearance;
    const fontMap = {
      app: 'var(--font-app)',
      system: "system-ui, -apple-system, 'Segoe UI', sans-serif",
      FrankRuhlCLM: "'FrankRuhlCLM', serif",
      TaameyDavidCLM: "'TaameyDavidCLM', serif",
      TaameyAshkenaz: "'TaameyAshkenaz', serif",
      KeterYG: "'KeterYG', serif",
      Shofar: "'Shofar', sans-serif",
      NotoSerifHebrew: "'NotoSerifHebrew', serif",
      NotoRashiHebrew: "'NotoRashiHebrew', serif",
      Tinos: "'Tinos', serif",
      Rubik: "'Rubik', sans-serif"
    };
    document.documentElement.style.setProperty('--font-main', fontMap[appearance.fontFamily]);
    document.documentElement.style.setProperty('--highlight-font', fontMap[appearance.fontFamily]);
    document.documentElement.style.setProperty('--highlight-font-size', `${appearance.fontSize}px`);
    document.documentElement.style.setProperty('--highlight-line-height', String(appearance.lineHeight));
    const list = $('#highlightsList');
    if (list) list.dataset.view = appearance.viewMode;
  }

  function normalizeSearchText(value) {
    return String(value || '')
      .normalize('NFKD')
      .replace(/[\u0591-\u05C7]/g, '')
      .replace(/[\u200E\u200F\u202A-\u202E]/g, '')
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
      if (unique.size >= 12) break;
    }
    return [...unique.values()];
  }


  // ── Context Menu ───────────────────────────────────────────────────────────
  // Strategy:
  //   • registerContextMenuItems() — full registration (first time or after removal)
  //   • patchOrRebuildMenu()       — uses reader.updateContextMenuItem when possible,
  //                                  falls back to full rebuild only on error
  //   • unregisterContextMenuItems() — removes the single root item

  async function unregisterContextMenuItems() {
    if (!menuRegistered) return;
    try { await call('reader.removeContextMenuItem', { id: 'marker-root' }); } catch (_) {}
    try { await call('reader.removeContextMenuItem', { id: 'marker-page-shape' }); } catch (_) {}
    try { await call('reader.removeContextMenuItem', { id: 'marker-remove' }); } catch (_) {}
    menuRegistered = false;
    registeredMenuType = null;
  }

  function hasHighlightAtSection(bookId, sectionIndex) {
    return allHighlights.some(h => h.bookId === bookId && h.sectionIndex === sectionIndex);
  }

  async function rebuildSharedContextMenu() {
    await call('reader.removeContextMenuItem', { id: 'marker-root' }).catch(() => {});
    await call('reader.removeContextMenuItem', { id: 'marker-page-shape' }).catch(() => {});
    await call('reader.removeContextMenuItem', { id: 'marker-remove' }).catch(() => {});
    menuRegistered = false;
    registeredMenuType = null;
    await loadAllHighlights();
    await registerContextMenuItems();
  }

  function rangeBounds(range) {
    const start = range?.start?.utf16 ?? range?.start?.grapheme;
    const end   = range?.end?.utf16   ?? range?.end?.grapheme;
    return Number.isInteger(start) && Number.isInteger(end) && start < end
      ? { start, end }
      : null;
  }

  function rangesOverlap(first, second) {
    const a = rangeBounds(first);
    const b = rangeBounds(second);
    return !!a && !!b && a.start < b.end && b.start < a.end;
  }

  function highlightsOverlappingSelection(selection) {
    const bookId = selection?.currentBookId || selection?.bookId;
    const index  = selection?.currentIndex ?? selection?.sectionIndex;
    if (!bookId || index == null) return [];
    return allHighlights.filter(item =>
      item.bookId === bookId &&
      item.sectionIndex === index &&
      (!selection.sourceRange || rangesOverlap(item.sourceRange, selection.sourceRange))
    );
  }

  async function hasHighlightOverlappingSelection(selection) {
    const bookId = selection?.currentBookId || selection?.bookId;
    const index = selection?.currentIndex ?? selection?.sectionIndex;
    if (!bookId || index == null) return false;

    // טווחי העוגן שבאחסון עלולים להתיישן לאחר re-anchor. קוראים את המצב
    // הסמכותי מה-Host ומעדכנים בזיכרון לפני שמחליטים אם להציג את המחק.
    try {
      const hostRecords = await call('reader.getHighlights', {
        bookId,
        sectionIndex: index,
        includeStale: true
      });
      const storedById = new Map(allHighlights.map(item => [item.highlightId, item]));
      for (const host of hostRecords || []) {
        const stored = storedById.get(host.highlightId);
        if (!stored) continue;
        if (host.range) stored.sourceRange = host.range;
        if (host.status) stored.status = host.status;
      }
    } catch (_) {}

    const overlapping = highlightsOverlappingSelection(selection);
    if (overlapping.length) return true;
    return !selection?.sourceRange && hasHighlightAtSection(bookId, index);
  }

  /** Build the color-row colors array from current settings + hasHL flag */
  function buildColorItems(hasHL) {
    const colors = menuColors();
    if (settings.menuStyle === 'submenu') {
      const children = colors.map(c => ({
        id:           `mark-${c.id}`,
        type:         'item',
        title:        c.label,
        icon:         'highlight_24_regular'
      }));
      if (hasHL) children.push({
        id:           'mark-remove',
        type:         'item',
        title:        '\u05D4\u05E1\u05E8 \u05E1\u05D9\u05DE\u05D5\u05DF',
        icon:         'highlight_off_24_regular'
      });
      return { type: 'submenu', children };
    }
    // color-row
    const colorItems = colors.map(c => ({
      id:    `mark-${c.id}`,
      color: toSafeHex(c.hex),
      label: c.label
    }));
    if (hasHL) {
      colorItems.push({
        id: 'marker-remove',
        color: '#00000000',
        label: '\u05D4\u05E1\u05E8 \u05E1\u05D9\u05DE\u05D5\u05DF',
        icon: 'eraser_24_regular'
      });
    }
    return { type: 'color-row', colorItems, children: [] };
  }

  async function registerContextMenuItems() {
    const revision = selectionRevision;
    await unregisterContextMenuItems();
    const colors = menuColors();
    if (!colors.length) return;

    const sel    = savedSelection || lastSelection;
    const hasHL = await hasHighlightOverlappingSelection(sel);
    if (revision !== selectionRevision) return;
    const built  = buildColorItems(hasHL);

    async function registerForContext(id, context) {
      if (built.type === 'submenu') {
        await call('reader.addContextMenuItem', {
          id,
          type:     'submenu',
          title:    '\u05DE\u05E8\u05E7\u05E8',
          icon:     'highlight_24_regular',
          contexts: [context],
          children: built.children
        });
      } else {
        await call('reader.addContextMenuItem', {
          id,
          type:              'color-row',
          title:             '\u05DE\u05E8\u05E7\u05E8',
          contexts:         [context],
          colors:            built.colorItems,
          ...(built.children.length ? { children: built.children } : {})
        });
      }
    }
    await registerForContext('marker-root', 'reader-selection');
    await registerForContext('marker-page-shape', 'reader-page-shape-selection');
    await syncStandaloneRemoveItem(hasHL, built.type);
    menuRegistered = true;
    registeredMenuType = built.type;
  }

  /**
   * Use reader.updateContextMenuItem to patch colors / children in place.
   * Falls back to full rebuild if the menu was removed or the call fails.
   */
  async function patchOrRebuildMenu() {
    const revision = selectionRevision;
    if (!menuRegistered) {
      if (hasUsableSelection(savedSelection || lastSelection)) {
        await registerContextMenuItems();
      }
      return;
    }

    const sel    = savedSelection || lastSelection;
    const hasHL = await hasHighlightOverlappingSelection(sel);
    if (revision !== selectionRevision) return;
    const built  = buildColorItems(hasHL);

    if (registeredMenuType !== built.type) {
      await registerContextMenuItems();
      return;
    }

    const patch = built.type === 'submenu'
      ? { children: built.children }
      : {
          colors:   built.colorItems,
          children: built.children
        };

    try {
      await call('reader.updateContextMenuItem', { id: 'marker-root', patch });
      await call('reader.updateContextMenuItem', { id: 'marker-page-shape', patch });
      await syncStandaloneRemoveItem(hasHL, built.type);
    } catch (_) {
      // Item may have been removed externally — rebuild from scratch
      menuRegistered = false;
      registeredMenuType = null;
      await registerContextMenuItems();
    }
  }

  async function syncStandaloneRemoveItem(hasHL, menuType) {
    // color-row renders its eraser inline; submenu renders it as a child.
    await call('reader.removeContextMenuItem', { id: 'marker-remove' }).catch(() => {});
  }


  // ── Selection helpers ──────────────────────────────────────────────────────
  function hasUsableSelection(sel) {
    return !!(
      sel &&
      selectedTextOf(sel).trim() &&
      (sel.currentBookId || sel.bookId) &&
      (sel.currentIndex != null || sel.sectionIndex != null)
    );
  }

  function selectedTextOf(sel) {
    return String(
      sel?.sourceSelectedText ||
      sel?.renderedSelectedText ||
      sel?.text ||
      sel?.selectedText ||
      ''
    );
  }

  function rememberSelection(data) {
    if (!hasUsableSelection(data)) return;
    const revision = ++selectionRevision;
    const sel = Object.assign({}, data, { rememberedAt: Date.now() });
    lastSelection  = sel;
    savedSelection = sel;
    window.clearTimeout(selectionTimer);
    selectionTimer = window.setTimeout(() => {
      selectionRevision++;
      lastSelection  = null;
      savedSelection = null;
      unregisterContextMenuItems().catch(() => {});
    }, 45_000);
    // Enrich with sourceRange from getSelection (may not be in the event payload)
    call('reader.getSelection', {}).then(cur => {
      if (!cur || !lastSelection || revision !== selectionRevision) return;
      const patch = {
        sourceRange: cur.sourceRange ?? null,
        start:       cur.start       ?? null,
        end:         cur.end         ?? null
      };
      lastSelection  = Object.assign({}, lastSelection,  patch);
      savedSelection = Object.assign({}, savedSelection, patch);
      patchOrRebuildMenu().catch(() => {});
    }).catch(() => {});
    return revision;
  }

  async function refreshContextMenuForSelection() {
    if (hasUsableSelection(lastSelection)) {
      if (menuRegistered) {
        await patchOrRebuildMenu();
      } else {
        await registerContextMenuItems();
      }
    } else {
      await unregisterContextMenuItems();
    }
  }

  async function resolveSelection() {
    if (hasUsableSelection(savedSelection)) return savedSelection;
    if (hasUsableSelection(lastSelection))  return lastSelection;
    try {
      const cur = await call('reader.getSelection', {});
      if (hasUsableSelection(cur)) return cur;
    } catch (_) {}
    return null;
  }

  function enrichSelectionFromEvent(eventData) {
    if (eventData?.selection) {
      const merged = Object.assign({}, eventData.selection, { rememberedAt: Date.now() });
      savedSelection = merged;
      lastSelection  = merged;
    }
  }


  // ── Highlights ─────────────────────────────────────────────────────────────
  // Storage schema: each key = HIGHLIGHT_PREFIX + highlightId
  // Each record stores: highlightId, bookId, sectionIndex, colorId, color, text,
  //                     ref, book, note, tags, sourceRange, version, etag, timestamp

  function makeHighlightId(bookId, sectionIndex, colorId) {
    const random = globalThis.crypto?.getRandomValues
      ? [...globalThis.crypto.getRandomValues(new Uint32Array(2))]
          .map(value => value.toString(36))
          .join('')
      : Math.random().toString(36).slice(2, 14);
    return `marker-${Date.now().toString(36)}-${sectionIndex}-${colorId}-${random}`
      .replace(/[^A-Za-z0-9._-]/g, '-')
      .slice(0, 128);
  }

  function highlightKey(highlightId) {
    return `${HIGHLIGHT_PREFIX}${highlightId}`;
  }

  async function saveHighlightMeta(data) {
    await call('storage.set', {
      key:   highlightKey(data.highlightId),
      value: Object.assign({}, data, { timestamp: Date.now() })
    });
  }

  function buildHighlightStyle(colorValue) {
    const color = typeof colorValue === 'string'
      ? { hex: colorValue }
      : (colorValue || {});
    const baseHex = color.backgroundColor || color.hex;
    return {
      backgroundColor: toSafeHex(baseHex),
      opacity:         Math.min(1, Math.max(0.15, Number(color.opacity) || 0.65)),
      underline:       color.markerMode === 'underline',
      borderRadius:    Math.min(16, Math.max(0, Number(color.borderRadius) || 0)),
      markerMode:      color.markerMode || 'text-background',
      priority:        10
    };
  }

  async function applyHighlight(color) {
    try {
      // Ensure we have a selection with a sourceRange
      let selection = await resolveSelection();
      if (!selection?.sourceRange) {
        const cur = await call('reader.getSelection', {}).catch(() => null);
        if (cur?.sourceRange) {
          selection = Object.assign({}, selection || cur, { sourceRange: cur.sourceRange });
          savedSelection = selection;
          if (lastSelection) lastSelection = Object.assign({}, lastSelection, { sourceRange: cur.sourceRange });
        }
      }

      if (!hasUsableSelection(selection)) {
        await call('ui.showMessage', { message: '\u05DB\u05D3\u05D9 \u05DC\u05D4\u05E9\u05EA\u05DE\u05E9 \u05D1\u05DE\u05E8\u05E7\u05E8 \u05E6\u05E8\u05D9\u05DA \u05E7\u05D5\u05D3\u05DD \u05DC\u05E1\u05DE\u05DF \u05D8\u05E7\u05E1\u05D8 \u05E2\u05DD \u05D4\u05E2\u05DB\u05D1\u05E8.' }).catch(() => {});
        await unregisterContextMenuItems();
        return;
      }

      if (!selection.sourceRange) {
        await call('ui.showMessage', {
          message: '\u05DC\u05D0 \u05E0\u05D9\u05EA\u05DF \u05DC\u05E1\u05DE\u05DF \u05D0\u05EA \u05D4\u05D8\u05E7\u05E1\u05D8 \u05D4\u05E0\u05D1\u05D7\u05E8 \u2014 \u05D4\u05DE\u05D9\u05E7\u05D5\u05DD \u05D4\u05DE\u05D3\u05D5\u05D9\u05E7 \u05DC\u05D0 \u05D6\u05D5\u05D4\u05D4.\n\u05D9\u05D9\u05EA\u05DB\u05DF \u05E9\u05D4\u05DE\u05D9\u05DC\u05D4 \u05DE\u05D5\u05D7\u05DC\u05E4\u05EA \u05D1\u05EA\u05E6\u05D5\u05D2\u05D4. \u05E0\u05E1\u05D4 \u05DC\u05D1\u05D7\u05D5\u05E8 \u05D8\u05E7\u05E1\u05D8 \u05D0\u05D7\u05E8.'
        }).catch(() => {});
        await unregisterContextMenuItems();
        return;
      }

      const bookId       = selection.currentBookId || selection.bookId;
      const sectionIndex = selection.currentIndex  ?? selection.sectionIndex;

      // A color action on an already highlighted range is a replacement.
      // Remove every overlapping record first so only one color remains.
      const overlapping = highlightsOverlappingSelection(selection);
      for (const item of overlapping) {
        if (item.highlightId) {
          await call('reader.clearHighlight', {
            highlightId: item.highlightId
          }).catch(() => {});
        }
        await call('storage.remove', {
          key: item.key || highlightKey(item.highlightId)
        }).catch(() => {});
      }
      if (overlapping.length) {
        const removedIds = new Set(overlapping.map(item => item.highlightId));
        allHighlights = allHighlights.filter(item => !removedIds.has(item.highlightId));
      }
      const highlightId  = makeHighlightId(bookId, sectionIndex, color.id);

      const hlRes = await Otzaria.call('reader.setHighlight', {
        highlightId,
        bookId,
        sectionIndex,
        range:    selection.sourceRange,
        style:    buildHighlightStyle(color),
        metadata: { source: 'manual', tags: [color.label] }
      });

      if (!hlRes.success) throw new Error('setHighlight failed: ' + hlRes.error?.message);

      // Persist to plugin storage, including version + etag for future updates
      await saveHighlightMeta({
        highlightId,
        bookId,
        sectionIndex,
        colorId:     color.id,
        color:       color.hex,
        style:       buildHighlightStyle(color),
        text:        selectedTextOf(selection),
        ref:         selection.currentRef  || '',
        book:        selection.currentBook || bookId,
        sourceRange: selection.sourceRange,
        version:     hlRes.data?.version ?? null,
        etag:        hlRes.data?.etag    ?? null
      });

      lastSelection  = null;
      savedSelection = null;
      await renderHighlightList();
      await unregisterContextMenuItems();
      await call('ui.showSuccess', { message: `\u05E0\u05E9\u05DE\u05E8 \u05D1${color.label} \u2713` }).catch(() => {});
    } catch (err) {
      console.error('applyHighlight error:', err);
      await call('ui.showError', { message: '\u05D4\u05E1\u05D9\u05DE\u05D5\u05DF \u05E0\u05DB\u05E9\u05DC. \u05D5\u05D3\u05D0 \u05E9\u05D0\u05EA\u05D4 \u05E0\u05DE\u05E6\u05D0 \u05D1\u05D8\u05E7\u05E1\u05D8 \u05E8\u05D2\u05D9\u05DC \u05D5\u05DC\u05D0 \u05D1-PDF.' }).catch(() => {});
    }
  }


  // ── Context menu event handlers ────────────────────────────────────────────

  /** contextMenu.colorClicked — new SDK 1.1 event for color-row */
  async function onColorClicked(data) {
    const colorId = String(data?.colorId || '').replace(/^mark-/, '');
    if (colorId === 'marker-remove') {
      enrichSelectionFromEvent(data);
      await handleRemoveHighlight();
      return;
    }
    const color   = settings.colors.find(c => c.id === colorId);
    if (!color) return;
    enrichSelectionFromEvent(data);
    await applyHighlight(color);
  }

  /** contextMenu.itemClicked — new SDK 1.1 event for item / submenu children */
  async function onStandardMenuClick(data) {
    enrichSelectionFromEvent(data);
    const itemId = String(data?.itemId || '');
    if (itemId === 'mark-remove' || itemId === 'marker-remove') {
      await handleRemoveHighlight();
      return;
    }
    // Submenu color items: id is mark-<colorId>
    if (itemId.startsWith('mark-')) {
      const colorId = itemId.replace(/^mark-/, '');
      const color   = settings.colors.find(c => c.id === colorId);
      if (color) await applyHighlight(color);
    }
  }

  // ── Highlight storage helpers ──────────────────────────────────────────────

  async function loadAllHighlights() {
    const keys  = await call('storage.list');
    const hkeys = (Array.isArray(keys) ? keys : []).filter(k => String(k).startsWith(HIGHLIGHT_PREFIX));
    const items = [];
    for (const key of hkeys) {
      try {
        const v = await call('storage.get', { key });
        if (v?.bookId != null && v?.sectionIndex != null) items.push({ ...v, key });
      } catch (err) { console.warn('Failed loading highlight', key, err); }
    }
    allHighlights = items.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    return allHighlights;
  }

  /** Sync plugin storage with Host highlights — mark stale/failed items in UI */
  async function syncStaleHighlights() {
    if (!allHighlights.length) return;

    // Group by book+section and query only sections that have highlights
    const sections = [...new Map(
      allHighlights.map(h => [`${h.bookId}::${h.sectionIndex}`, { bookId: h.bookId, sectionIndex: h.sectionIndex }])
    ).values()];

    for (const { bookId, sectionIndex } of sections) {
      let hostRecords;
      try {
        hostRecords = await call('reader.getHighlights', { bookId, sectionIndex, includeStale: true });
      } catch (_) { continue; }

      const hostMap = new Map((hostRecords || []).map(r => [r.highlightId, r]));

      for (const item of allHighlights) {
        if (item.bookId !== bookId || item.sectionIndex !== sectionIndex) continue;
        const host = hostMap.get(item.highlightId);
        if (!host) continue;
        // Update version/etag and stale status in storage if changed
        const hostRange = host.range || item.sourceRange;
        const rangeChanged = JSON.stringify(hostRange) !== JSON.stringify(item.sourceRange);
        if (host.version !== item.version ||
            host.etag !== item.etag ||
            host.status !== item.status ||
            rangeChanged) {
          const updated = Object.assign({}, item, {
            version: host.version,
            etag:    host.etag,
            status:  host.status,
            sourceRange: hostRange
          });
          await call('storage.set', { key: item.key, value: updated }).catch(() => {});
          Object.assign(item, {
            version: host.version,
            etag: host.etag,
            status: host.status,
            sourceRange: hostRange
          });
        }
      }
    }
  }

  /**
   * Re-anchor highlights whose sourceRange still exists in storage.
   * Called on boot and after sectionContentChanged.
   */
  async function reapplyAllHighlights(onlyHighlightIds = null) {
    const storedItems = await loadAllHighlights();
    const items = onlyHighlightIds instanceof Set
      ? storedItems.filter(item => onlyHighlightIds.has(item.highlightId))
      : storedItems;
    for (const item of items) {
      if (!item.highlightId || !item.sourceRange) continue;
      const color = getColorById(item.colorId);
      // SDK 1.1 uses the book title as reader bookId. Early experimental
      // builds stored the database id while keeping the title in `book`.
      // Normalize those records so existing marks become visible/openable too.
      const canonicalBookId = String(item.book || item.bookId || '');
      if (!canonicalBookId) continue;
      try {
        const res = await Otzaria.call('reader.setHighlight', {
          highlightId:  item.highlightId,
          bookId:       canonicalBookId,
          sectionIndex: item.sectionIndex,
          range:        item.sourceRange,
          style:        buildHighlightStyle(item.style || Object.assign({}, color, { hex: item.color || color.hex })),
          metadata:     { source: 'manual', tags: [color.label, ...normalizeTags(item.tags)], note: item.note || '' }
        });
        // Keep version/etag in sync
        if (res.success && res.data) {
          const patch = {
            bookId: canonicalBookId,
            version: res.data.version ?? null,
            etag: res.data.etag ?? null,
            status: res.data.status ?? 'active'
          };
          if (patch.bookId !== item.bookId || patch.version !== item.version || patch.status !== item.status) {
            await call('storage.set', { key: item.key, value: Object.assign({}, item, patch) }).catch(() => {});
            Object.assign(item, patch);
          }
        }
      } catch (_) {}
    }
  }

  async function updateHighlightColor(item, color, { render = true, note, tags, favorite } = {}) {
    if (!item?.highlightId || !color) return false;
    const effectiveNote = note === undefined ? (item.note || '') : note;
    const effectiveTags = normalizeTags(tags === undefined ? item.tags : tags);
    const metadata = {
      source: 'manual',
      note: effectiveNote,
      tags: [color.label, ...effectiveTags]
    };
    const listHostRecords = async () => {
      const records = await call('reader.getHighlights', {
        includeStale: true
      });
      return Array.isArray(records) ? records : [];
    };
    const createHostRecord = () => {
      if (!item.sourceRange) {
        const error = new Error('Cannot restore highlight without its source range');
        error.code = 'error.missing_anchor';
        throw error;
      }
      return call('reader.setHighlight', {
        highlightId: item.highlightId,
        bookId: item.bookId,
        sectionIndex: item.sectionIndex,
        range: item.sourceRange,
        style: buildHighlightStyle(color),
        metadata
      });
    };
    const updateHostRecord = record => call('reader.updateHighlight', {
      highlightId: item.highlightId,
      expectedVersion: record.version,
      expectedEtag: record.etag,
      style: buildHighlightStyle(color),
      metadata
    });

    let records = await listHostRecords();
    let authoritative = records.find(record => record.highlightId === item.highlightId);
    let updated;
    if (!authoritative) {
      try {
        updated = await createHostRecord();
      } catch (error) {
        if (error?.code !== 'error.conflict') throw error;
        records = await listHostRecords();
        authoritative = records.find(record => record.highlightId === item.highlightId);
        if (!authoritative) throw error;
        updated = await updateHostRecord(authoritative);
      }
    } else {
      try {
        updated = await updateHostRecord(authoritative);
      } catch (error) {
        if (error?.code !== 'error.conflict') throw error;
        records = await listHostRecords();
        authoritative = records.find(record => record.highlightId === item.highlightId);
        updated = authoritative ? await updateHostRecord(authoritative) : await createHostRecord();
      }
    }
    const stored = Object.assign({}, item, {
      colorId: color.id,
      color: color.hex,
      style: buildHighlightStyle(color),
      version: updated?.version ?? item.version,
      etag: updated?.etag ?? item.etag,
      status: updated?.status ?? item.status
    });
    stored.note = effectiveNote;
    stored.tags = effectiveTags;
    if (favorite !== undefined) stored.favorite = Boolean(favorite);
    delete stored.key;
    await call('storage.set', { key: item.key || highlightKey(item.highlightId), value: stored });
    Object.assign(item, stored);
    if (render) await renderHighlightList();
    return true;
  }

  function highlightUpdateErrorMessage(error) {
    if (error?.code === 'error.missing_anchor') return 'לא ניתן לערוך את ההדגשה משום שהעוגן המדויק שלה חסר.';
    if (error?.code === 'error.highlight_not_found') return 'ההדגשה אינה פעילה בקורא. נסה לרענן את הרשימה.';
    if (error?.code === 'error.conflict') return 'ההדגשה השתנתה שוב בזמן השמירה. נסה פעם נוספת.';
    if (error?.code === 'error.invalid_params') return `אוצריא דחתה את נתוני העריכה: ${error.message}`;
    return `שמירת השינויים נכשלה${error?.message ? `: ${error.message}` : '.'}`;
  }

  function openEditHighlight(item, returnFocus = null) {
    editingHighlightKey = item.key;
    editReturnFocus = returnFocus;
    const colorSelect = $('#editHighlightColor');
    colorSelect.innerHTML = settings.colors.map(color =>
      `<option value="${escapeHtml(color.id)}">${escapeHtml(color.label)}</option>`
    ).join('');
    colorSelect.value = item.colorId;
    $('#editHighlightNote').value = item.note || '';
    $('#editHighlightTags').value = normalizeTags(item.tags).join(', ');
    $('#editHighlightFavorite').checked = item.favorite === true;
    $('#editHighlightPreview').textContent = item.text || 'הדגשה ללא תצוגה מקדימה';
    const dialog = $('#editHighlightDialog');
    if (!dialog.open) dialog.showModal();
    requestAnimationFrame(() => $('#editHighlightNote').focus());
  }

  function closeEditHighlight() {
    editingHighlightKey = null;
    $('#editHighlightDialog').close();
    const target = editReturnFocus;
    editReturnFocus = null;
    if (target?.isConnected) requestAnimationFrame(() => target.focus());
  }

  function dismissUndoDelete() {
    clearTimeout(undoDeleteTimer);
    undoDeleteTimer = null;
    lastDeletedHighlights = [];
    $('#undoDeleteBar').hidden = true;
  }

  function offerUndoDelete(items) {
    clearTimeout(undoDeleteTimer);
    lastDeletedHighlights = items.map(item => structuredCloneSafe(item));
    $('#undoDeleteText').textContent = items.length === 1
      ? 'ההדגשה נמחקה'
      : `${items.length} הדגשות נמחקו`;
    $('#undoDeleteBar').hidden = false;
    undoDeleteTimer = setTimeout(dismissUndoDelete, 30000);
  }

  async function undoLastDelete() {
    const items = lastDeletedHighlights.slice();
    if (!items.length) return;
    clearTimeout(undoDeleteTimer);
    let failed = 0;
    for (const item of items) {
      const color = getColorById(item.colorId);
      try {
        const restored = await call('reader.setHighlight', {
          highlightId: item.highlightId,
          bookId: item.bookId,
          sectionIndex: item.sectionIndex,
          range: item.sourceRange,
          style: buildHighlightStyle(item.style || Object.assign({}, color, { hex: item.color || color.hex })),
          metadata: { source: 'manual', tags: [color.label, ...normalizeTags(item.tags)], note: item.note || '' }
        });
        const value = Object.assign({}, item, {
          version: restored?.version ?? null,
          etag: restored?.etag ?? null,
          status: restored?.status ?? 'active'
        });
        delete value.key;
        await call('storage.set', { key: item.key || highlightKey(item.highlightId), value });
      } catch (err) {
        failed++;
        console.error('Failed restoring deleted highlight', item.highlightId, err);
      }
    }
    dismissUndoDelete();
    await renderHighlightList();
    await call(failed ? 'ui.showWarning' : 'ui.showSuccess', failed
      ? { title: 'שחזור חלקי', content: `${items.length - failed} שוחזרו; ${failed} לא שוחזרו` }
      : { message: items.length === 1 ? 'ההדגשה שוחזרה' : `${items.length} הדגשות שוחזרו` }
    ).catch(() => {});
  }

  async function saveEditedHighlight() {
    const item = allHighlights.find(h => h.key === editingHighlightKey);
    const color = settings.colors.find(c => c.id === $('#editHighlightColor').value);
    if (!item || !color) return;
    const note = $('#editHighlightNote').value.trim();
    const tags = normalizeTags($('#editHighlightTags').value);
    const favorite = $('#editHighlightFavorite').checked;
    await updateHighlightColor(item, color, { render: false, note, tags, favorite });
    closeEditHighlight();
    await renderHighlightList();
    await call('ui.showSuccess', { message: 'ההדגשה עודכנה' }).catch(() => {});
  }

  async function deleteHighlight(item, { render = true, remember = true } = {}) {
    if (item.highlightId) {
      await call('reader.clearHighlight', {
        highlightId: item.highlightId
      }).catch(() => {});
    }
    await call('storage.remove', { key: item.key || highlightKey(item.highlightId) });
    selectedHighlightKeys.delete(item.key);
    if (remember) offerUndoDelete([item]);
    if (render) await renderHighlightList();
  }

  async function applyColorToSelected() {
    const color = getColorById($('#bulkColor').value);
    const items = allHighlights.filter(item => selectedHighlightKeys.has(item.key));
    if (!items.length || !color?.id) return;
    let failed = 0;
    for (const item of items) {
      try { await updateHighlightColor(item, color, { render: false }); }
      catch (err) { failed++; console.error('Failed updating highlight color', item.highlightId, err); }
    }
    await renderHighlightList();
    const message = failed
      ? `${items.length - failed} הדגשות עודכנו; ${failed} לא עודכנו`
      : `${items.length} הדגשות עודכנו ל${color.label}`;
    await call(failed ? 'ui.showWarning' : 'ui.showSuccess', failed ? { title: 'עדכון חלקי', content: message } : { message }).catch(() => {});
  }

  async function addTagsToSelected() {
    const addedTags = normalizeTags($('#bulkTags').value);
    const items = allHighlights.filter(item => selectedHighlightKeys.has(item.key));
    if (!items.length || !addedTags.length) return;
    let failed = 0;
    for (const item of items) {
      const color = getColorById(item.colorId);
      const tags = normalizeTags([...normalizeTags(item.tags), ...addedTags]);
      try { await updateHighlightColor(item, color, { render: false, tags }); }
      catch (err) { failed++; console.error('Failed adding tags', item.highlightId, err); }
    }
    $('#bulkTags').value = '';
    await renderHighlightList();
    const message = failed
      ? `${items.length - failed} הדגשות עודכנו; ${failed} לא עודכנו`
      : `התגיות נוספו ל-${items.length} הדגשות`;
    await call(failed ? 'ui.showWarning' : 'ui.showSuccess', failed
      ? { title: 'עדכון חלקי', content: message }
      : { message }
    ).catch(() => {});
  }

  async function deleteSelectedHighlights() {
    const items = allHighlights.filter(item => selectedHighlightKeys.has(item.key));
    if (!items.length) return;
    const response = await call('ui.showWarning', {
      title: 'מחיקת הדגשות נבחרות',
      content: `האם למחוק ${items.length} הדגשות? פעולה זו אינה הפיכה.`
    });
    if (!response?.confirmed) return;
    const deleted = [];
    for (const item of items) {
      try {
        await deleteHighlight(item, { render: false, remember: false });
        deleted.push(item);
      } catch (err) { console.error('Failed deleting selected highlight', item.highlightId, err); }
    }
    selectedHighlightKeys.clear();
    if (deleted.length) offerUndoDelete(deleted);
    await renderHighlightList();
  }

  async function deleteAllHighlights() {
    if (!allHighlights.length) return;
    const res = await call('ui.showWarning', {
      title:   '\u05DE\u05D7\u05D9\u05E7\u05EA \u05DB\u05DC \u05D4\u05D4\u05D3\u05D2\u05E9\u05D5\u05EA',
      content: '\u05D4\u05D0\u05DD \u05DC\u05DE\u05D7\u05D5\u05E7 \u05D0\u05EA \u05DB\u05DC \u05D4\u05D4\u05D3\u05D2\u05E9\u05D5\u05EA? \u05E4\u05E2\u05D5\u05DC\u05D4 \u05D6\u05D5 \u05D0\u05D9\u05E0\u05D4 \u05D4\u05E4\u05D9\u05DB\u05D4.'
    });
    if (!res?.confirmed) return;
    await call('reader.clearAllHighlights', {}).catch(() => {});
    for (const item of allHighlights) {
      await call('storage.remove', { key: item.key }).catch(() => {});
    }
    selectedHighlightKeys.clear();
    await renderHighlightList();
  }

  async function handleRemoveHighlight() {
    try {
      const sel    = savedSelection || lastSelection;
      const bookId = sel?.currentBookId || sel?.bookId;
      const index  = sel?.currentIndex  ?? sel?.sectionIndex;
      if (!bookId || index == null) return;
      const matches = highlightsOverlappingSelection(sel);
      if (!matches.length) {
        await call('ui.showMessage', { message: '\u05D0\u05D9\u05DF \u05D4\u05D3\u05D2\u05E9\u05D4 \u05D1\u05E9\u05D5\u05E8\u05D4 \u05D6\u05D5.' }).catch(() => {});
        return;
      }
      for (const item of matches) {
        if (item.highlightId) {
          await call('reader.clearHighlight', {
            highlightId: item.highlightId
          }).catch(() => {});
        }
        await call('storage.remove', { key: item.key }).catch(() => {});
      }
      await renderHighlightList();
      await patchOrRebuildMenu();
      await call('ui.showSuccess', { message: '\u05D4\u05D4\u05D3\u05D2\u05E9\u05D4 \u05D4\u05D5\u05E1\u05E8\u05D4' }).catch(() => {});
    } catch (err) { console.error(err); }
  }

  async function openHighlight(item) {
    try {
      const revealed = await call('reader.revealHighlight', {
        highlightId: item.highlightId
      });
      if (revealed === true) return;
    } catch (error) {
      // Compatibility with Otzaria versions from before revealHighlight.
      console.warn('Precise highlight reveal unavailable; falling back', error?.code || error);
    }
    const bookId = String(item.book || item.bookId || '');
    if (!bookId) throw new Error('\u05DC\u05D0 \u05E0\u05E9\u05DE\u05E8 \u05DE\u05D6\u05D4\u05D4 \u05E1\u05E4\u05E8');
    const opened = item.ref
      ? await call('reader.openBookAtRef', { bookId, ref: item.ref, index: item.sectionIndex })
      : await call('reader.openBook', { bookId, index: item.sectionIndex });
    if (opened !== true) {
      throw new Error('\u05D0\u05D5\u05E6\u05E8\u05D9\u05D0 \u05DC\u05D0 \u05DE\u05E6\u05D0\u05D4 \u05D0\u05EA \u05D4\u05E1\u05E4\u05E8 \u05D4\u05E9\u05DE\u05D5\u05E8');
    }
  }

  function getColorById(colorId) {
    return settings.colors.find(c => c.id === colorId)
        || DEFAULT_SETTINGS.colors.find(c => c.id === colorId)
        || { id: colorId || 'yellow', hex: '#FFF176', label: '\u05E6\u05D1\u05E2' };
  }


  // ── Render helpers ─────────────────────────────────────────────────────────
  function toHebrewDate(timestamp) {
    if (!timestamp) return '';
    const d = new Date(timestamp);
    const days = ['\u05E8\u05D0\u05E9\u05D5\u05DF','\u05E9\u05E0\u05D9','\u05E9\u05DC\u05D9\u05E9\u05D9','\u05E8\u05D1\u05D9\u05E2\u05D9','\u05D7\u05DE\u05D9\u05E9\u05D9','\u05E9\u05D9\u05E9\u05D9','\u05E9\u05D1\u05EA'];
    const dayName = days[d.getDay()];
    const toGematria = n => {
      const vals = [400,300,200,100,90,80,70,60,50,40,30,20,10,9,8,7,6,5,4,3,2,1];
      const lets = ['\u05EA','\u05E9','\u05E8','\u05E7','\u05E6','\u05E4','\u05E2','\u05E1','\u05E0','\u05DE','\u05DC','\u05DB','\u05D9','\u05D8','\u05D7','\u05D6','\u05D5','\u05D4','\u05D3','\u05D2','\u05D1','\u05D0'];
      let r = '';
      for (let i = 0; i < vals.length; i++) while (n >= vals[i]) { r += lets[i]; n -= vals[i]; }
      return r.replace('\u05D9\u05D4', '\u05D8\u05D5').replace('\u05D9\u05D5', '\u05D8\u05D6');
    };
    try {
      const parts = new Intl.DateTimeFormat('he-IL-u-ca-hebrew', { day: 'numeric', month: 'long', year: 'numeric' }).formatToParts(d);
      const dayNum   = parseInt((parts.find(p => p.type === 'day')  || {}).value || 0, 10);
      const monPart  = (parts.find(p => p.type === 'month') || {}).value || '';
      const yearNum  = parseInt((parts.find(p => p.type === 'year') || {}).value || 0, 10);
      const yearShort = yearNum > 1000 ? yearNum % 1000 : yearNum;
      const gregStr  = d.toLocaleDateString('he-IL', { day: 'numeric', month: 'numeric', year: 'numeric' });
      return `\u05D9\u05D5\u05DD ${dayName} ${toGematria(dayNum)} ${monPart} ${toGematria(yearShort)} (${gregStr})`;
    } catch { return `\u05D9\u05D5\u05DD ${dayName} ${d.toLocaleDateString('he-IL')}`; }
  }

  function renderFilters() {
    const bf = $('#bookFilter'), cf = $('#colorFilter'), tf = $('#tagFilter'), bulkColor = $('#bulkColor');
    const sb = bf.value || 'all', sc = cf.value || 'all', st = tf.value || 'all';
    const books = [...new Map(allHighlights.map(h => [h.bookId, h.book || h.bookId])).entries()]
      .sort((a, b) => String(a[1]).localeCompare(String(b[1]), 'he'));
    bf.innerHTML = `<option value="all">\u05DB\u05DC \u05D4\u05E1\u05E4\u05E8\u05D9\u05DD</option>` +
      books.map(([id, t]) => `<option value="${escapeHtml(id)}">${escapeHtml(t)}</option>`).join('');
    cf.innerHTML = `<option value="all">\u05DB\u05DC \u05D4\u05E6\u05D1\u05E2\u05D9\u05DD</option>` +
      settings.colors.map(c => `<option value="${escapeHtml(c.id)}">${escapeHtml(c.label)}</option>`).join('');
    const tags = [...new Set(allHighlights.flatMap(item => normalizeTags(item.tags)))]
      .sort((a, b) => a.localeCompare(b, 'he'));
    tf.innerHTML = `<option value="all">כל התגיות</option>` +
      tags.map(tag => `<option value="${escapeHtml(tag)}">${escapeHtml(tag)}</option>`).join('');
    bf.value = [...bf.options].some(o => o.value === sb) ? sb : 'all';
    cf.value = [...cf.options].some(o => o.value === sc) ? sc : 'all';
    tf.value = [...tf.options].some(o => o.value === st) ? st : 'all';
    const previousBulkColor = bulkColor.value;
    bulkColor.innerHTML = enabledColors().map(c =>
      `<option value="${escapeHtml(c.id)}">${escapeHtml(c.label)}</option>`
    ).join('');
    if ([...bulkColor.options].some(o => o.value === previousBulkColor)) bulkColor.value = previousBulkColor;
  }

  function updateBulkActions() {
    const existingKeys = new Set(allHighlights.map(h => h.key));
    [...selectedHighlightKeys].forEach(key => { if (!existingKeys.has(key)) selectedHighlightKeys.delete(key); });
    const count = selectedHighlightKeys.size;
    $('#bulkActions').hidden = count === 0;
    $('#selectedCount').textContent = `${count} נבחרו`;
  }

  function resetListWindowAndRender() {
    renderedHighlightLimit = HIGHLIGHTS_PAGE_SIZE;
    return renderHighlightList();
  }

  async function renderHighlightList() {
    await loadAllHighlights();
    if (!isForeground()) return;
    lastRenderedHighlightsSignature = highlightListSignature();
    applyDisplaySettings();
    renderFilters();
    const list     = $('#highlightsList');
    const bookVal  = $('#bookFilter').value;
    const colorVal = $('#colorFilter').value;
    const tagVal = $('#tagFilter').value;
    const statusVal = $('#statusFilter').value;
    const query = normalizeSearchText($('#highlightSearch').value);
    const sortMode = $('#sortHighlights').value;
    const groupMode = $('#groupHighlights').value;
    const filtered = allHighlights.filter(h =>
      (bookVal  === 'all' || h.bookId  === bookVal) &&
      (colorVal === 'all' || h.colorId === colorVal) &&
      (tagVal === 'all' || normalizeTags(h.tags).includes(tagVal)) &&
      (statusVal === 'all' ||
        (statusVal === 'favorites' && h.favorite === true) ||
        (statusVal === 'stale' && (h.status === 'stale' || h.status === 'failed_to_anchor'))) &&
      (!query || normalizeSearchText([
        h.text, h.note, normalizeTags(h.tags).join(' '), h.book, h.bookId, h.ref, getColorById(h.colorId).label
      ].join(' ')).includes(query))
    );
    const hebrewCompare = (a, b) => String(a || '').localeCompare(String(b || ''), 'he', { numeric: true });
    filtered.sort((a, b) => {
      if (sortMode === 'oldest') return (a.timestamp || 0) - (b.timestamp || 0);
      if (sortMode === 'book') return hebrewCompare(a.book || a.bookId, b.book || b.bookId) || (a.sectionIndex || 0) - (b.sectionIndex || 0);
      if (sortMode === 'location') return hebrewCompare(a.book || a.bookId, b.book || b.bookId) || (a.sectionIndex || 0) - (b.sectionIndex || 0) || (a.sourceRange?.start || 0) - (b.sourceRange?.start || 0);
      if (sortMode === 'color') return hebrewCompare(getColorById(a.colorId).label, getColorById(b.colorId).label) || (b.timestamp || 0) - (a.timestamp || 0);
      if (sortMode === 'favorites') return Number(b.favorite === true) - Number(a.favorite === true) || (b.timestamp || 0) - (a.timestamp || 0);
      return (b.timestamp || 0) - (a.timestamp || 0);
    });
    visibleHighlightKeys = filtered.map(item => item.key);
    const displayed = filtered.slice(0, renderedHighlightLimit);
    const hasMore = displayed.length < filtered.length;
    $('#resultsCount').textContent = hasMore
      ? `מוצגות ${displayed.length} מתוך ${filtered.length} · סך הכול ${allHighlights.length}`
      : `${filtered.length} מתוך ${allHighlights.length} הדגשות`;
    $('#loadMoreBtn').hidden = !hasMore;
    updateBulkActions();
    if (!filtered.length) {
      list.innerHTML = `<div class="empty-state">${allHighlights.length
        ? '\u05D0\u05D9\u05DF \u05D4\u05D3\u05D2\u05E9\u05D5\u05EA \u05E9\u05DE\u05EA\u05D0\u05D9\u05DE\u05D5\u05EA \u05DC\u05E1\u05D9\u05E0\u05D5\u05DF \u05D4\u05E0\u05D5\u05DB\u05D7\u05D9.'
        : '\u05E2\u05D3\u05D9\u05D9\u05DF \u05DC\u05D0 \u05E1\u05D9\u05DE\u05E0\u05EA \u05E9\u05D5\u05DD \u05D3\u05D1\u05E8.'}</div>`;
      return;
    }
    const cardHtml = h => {
      const c     = getColorById(h.colorId);
      const title = `${h.book || h.bookId}${h.ref ? ' \u00B7 ' + h.ref : ''}`;
      const text  = (h.text || '').trim();
      const short = text.length > 90 ? text.slice(0, 90) + '\u2026' : text;
      const date  = h.timestamp ? toHebrewDate(h.timestamp) : '';
      const note = String(h.note || '').trim();
      const tags = normalizeTags(h.tags);
      const isStale = h.status === 'stale' || h.status === 'failed_to_anchor';
      const staleAttr = isStale ? ' data-stale="true"' : '';
      const staleBadge = isStale
        ? `<span class="stale-badge" title="\u05D4\u05E2\u05D5\u05D2\u05DF \u05E9\u05D5\u05D1\u05E9">\u26A0\uFE0F</span>`
        : '';
      const favoriteBadge = h.favorite === true
        ? `<span class="favorite-badge" title="מועדפת" aria-label="מועדפת">★</span>`
        : '';
      const colorOptions = settings.colors.map(option =>
        `<option value="${escapeHtml(option.id)}"${option.id === h.colorId ? ' selected' : ''}>${escapeHtml(option.label)}</option>`
      ).join('');
      const accessibleLabel = `${title}. ${short || 'שורה מסומנת'}`;
      return `<article class="highlight-card fade-in"${staleAttr} data-key="${escapeHtml(h.key)}" tabindex="0" aria-label="${escapeHtml(accessibleLabel)}">
        <input class="highlight-select" type="checkbox" data-key="${escapeHtml(h.key)}" aria-label="בחר: ${escapeHtml(accessibleLabel)}" ${selectedHighlightKeys.has(h.key) ? 'checked' : ''} />
        <span class="dot" style="background:${escapeHtml(toSafeHex(c.hex))};box-shadow:0 0 0 7px ${escapeHtml(hexToRgba(c.hex, .22))}">
          <svg class="marker-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M4 16.7 15.9 4.8a2.1 2.1 0 0 1 3 0l.3.3a2.1 2.1 0 0 1 0 3L7.3 20H4v-3.3Z" fill="currentColor"/>
            <path d="M13.8 6.9 17.1 10.2" stroke="rgba(0,0,0,0.35)" stroke-width="1.5" stroke-linecap="round"/>
          </svg>
        </span>
        <div class="highlight-body">
          <div class="highlight-title">${favoriteBadge}${escapeHtml(title)}${staleBadge}</div>
          <div class="highlight-text">${escapeHtml(short || '\u05E9\u05D5\u05E8\u05D4 \u05DE\u05E1\u05D5\u05DE\u05E0\u05EA')}</div>
          ${note ? `<div class="highlight-note">${escapeHtml(note)}</div>` : ''}
          ${tags.length ? `<div class="highlight-tags">${tags.map(tag => `<span class="tag-chip">${escapeHtml(tag)}</span>`).join('')}</div>` : ''}
          <div class="highlight-meta">${escapeHtml(c.label)}${date ? ' \u00B7 ' + escapeHtml(date) : ''}</div>
        </div>
        <div class="row-actions">
          <select class="inline-color" data-key="${escapeHtml(h.key)}" aria-label="שנה צבע עבור ${escapeHtml(title)}">${colorOptions}</select>
          <button class="small-btn" type="button" data-action="open" data-key="${escapeHtml(h.key)}" aria-label="פתח: ${escapeHtml(title)}">\u05E4\u05EA\u05D7</button>
          <button class="small-btn" type="button" data-action="edit" data-key="${escapeHtml(h.key)}" aria-label="ערוך: ${escapeHtml(title)}">ערוך</button>
          <button class="small-btn danger-action" type="button" data-action="delete" data-key="${escapeHtml(h.key)}" aria-label="מחק: ${escapeHtml(title)}">\u05DE\u05D7\u05E7</button>
        </div>
      </article>`;
    };
    const groupKey = h => {
      if (groupMode === 'book') return h.book || h.bookId || 'ללא ספר';
      if (groupMode === 'color') return getColorById(h.colorId).label;
      if (groupMode === 'tag') return tagVal !== 'all' ? tagVal : (normalizeTags(h.tags)[0] || 'ללא תגית');
      if (groupMode === 'date') return h.timestamp ? toHebrewDate(h.timestamp) : 'ללא תאריך';
      return '';
    };
    if (groupMode === 'none') {
      list.innerHTML = displayed.map(cardHtml).join('');
    } else {
      const groups = new Map();
      displayed.forEach(h => {
        const key = groupKey(h);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(h);
      });
      list.innerHTML = [...groups.entries()].map(([label, items]) =>
        `<h2 class="highlight-group-title">${escapeHtml(label)} · ${items.length}</h2>${items.map(cardHtml).join('')}`
      ).join('');
    }
  }


  // ── Settings panel render ──────────────────────────────────────────────────
  function renderSettings() {
    if (!isForeground()) return;
    const enabled = enabledColors();
    const editor  = $('#colorsEditor');
    editor.innerHTML = settings.colors.map((c, i) => {
      const inMenuSlot = c.enabled && enabled.indexOf(c) < MAX_MENU_COLORS;
      const badge = inMenuSlot
        ? ` <span class="menu-badge">\u05EA\u05E4\u05E8\u05D9\u05D8</span>`
        : (c.enabled ? ` <span class="menu-badge muted">\u05DE\u05D7\u05D5\u05E5 \u05DC\u05DE\u05D2\u05D1\u05DC\u05D4</span>` : '');
      return `<div class="color-row" data-index="${i}" data-marker-mode="${escapeHtml(c.markerMode)}">
        <span class="drag-handle" title="\u05D2\u05E8\u05D5\u05E8">\u2807</span>
        <button type="button" class="color-picker-btn" data-action="pick" style="--picked-color:${escapeHtml(toSafeHex(c.hex))}" title="\u05D1\u05D7\u05E8 \u05E6\u05D1\u05E2"><span></span></button>
        <input class="native-color" type="color" value="${escapeHtml(toSafeHex(c.hex))}" data-field="hex" aria-label="\u05E6\u05D1\u05E2" />
        <input type="text" value="${escapeHtml(c.label)}" data-field="label" aria-label="\u05E9\u05DD \u05E6\u05D1\u05E2" />
        <label class="color-switch-label" title="${c.enabled ? 'לחץ לכיבוי' : 'לחץ להפעלה'}">
          <input type="checkbox" data-field="enabled" ${c.enabled ? 'checked' : ''} />פעיל${badge}
        </label>
        <div class="order-btns">
          <button type="button" data-action="up"   ${i === 0 ? 'disabled' : ''} title="\u05D4\u05E2\u05DC\u05D4">\u25B2</button>
          <button type="button" data-action="down" ${i === settings.colors.length - 1 ? 'disabled' : ''} title="\u05D4\u05D5\u05E8\u05D3">\u25BC</button>
        </div>
        <button class="small-btn danger-action" type="button" data-action="remove" ${settings.colors.length <= 1 ? 'disabled' : ''}>\u05DE\u05D7\u05E7</button>
        <details class="color-style-editor">
          <summary>סגנון הדגשה</summary>
          <div class="color-style-grid">
            <label>אופן הסימון
              <select data-field="markerMode">
                <option value="text-background" ${c.markerMode === 'text-background' ? 'selected' : ''}>רקע לטקסט</option>
                <option value="underline" ${c.markerMode === 'underline' ? 'selected' : ''}>קו תחתון</option>
                <option value="box" ${c.markerMode === 'box' ? 'selected' : ''}>מסגרת</option>
                <option value="line-marker" ${c.markerMode === 'line-marker' ? 'selected' : ''}>צבע לטקסט</option>
              </select>
            </label>
            <label>שקיפות <output>${Math.round(c.opacity * 100)}%</output>
              <input type="range" min="0.15" max="1" step="0.05" value="${c.opacity}" data-field="opacity" />
            </label>
            <label class="radius-setting">עיגול פינות
              <input type="range" min="0" max="16" step="1" value="${c.borderRadius}" data-field="borderRadius" />
            </label>
          </div>
        </details>
      </div>`;
    }).join('');

    const ab = $('#addColorBtn');
    if (ab) ab.disabled = settings.colors.length >= MAX_COLORS;
    const note = $('#menuColorLimitNote');
    if (note) note.textContent = `${enabled.length} \u05E6\u05D1\u05E2\u05D9\u05DD \u05E4\u05E2\u05D9\u05DC\u05D9\u05DD \u2014 \u05DE\u05D5\u05E6\u05D2\u05D9\u05DD \u05E2\u05D3 ${MAX_MENU_COLORS} \u05D1\u05EA\u05E4\u05E8\u05D9\u05D8`;

    const radioStyle = $(`input[name="menuStyle"][value="${settings.menuStyle}"]`);
    if (radioStyle) radioStyle.checked = true;

    const appearance = settings.appearance || DEFAULT_SETTINGS.appearance;
    $('#viewMode').value = appearance.viewMode;
    $('#fontFamily').value = appearance.fontFamily;
    $('#fontSize').value = String(appearance.fontSize);
    $('#lineHeight').value = String(appearance.lineHeight);
    const exportTemplate = settings.exportTemplate || DEFAULT_SETTINGS.exportTemplate;
    $('#humanExportFormat').value = exportTemplate.format;
    $('#exportIncludeBook').checked = exportTemplate.includeBook;
    $('#exportIncludeRef').checked = exportTemplate.includeRef;
    $('#exportIncludeNote').checked = exportTemplate.includeNote;
    $('#exportIncludeTags').checked = exportTemplate.includeTags;
    $('#exportIncludeDate').checked = exportTemplate.includeDate;
    const managedTags = [...new Set(allHighlights.flatMap(item => normalizeTags(item.tags)))].sort((a, b) => a.localeCompare(b, 'he'));
    const tagSource = $('#manageTagSource');
    const previousTag = tagSource.value;
    tagSource.innerHTML = managedTags.length
      ? managedTags.map(tag => `<option value="${escapeHtml(tag)}">${escapeHtml(tag)}</option>`).join('')
      : '<option value="">אין תגיות</option>';
    if (managedTags.includes(previousTag)) tagSource.value = previousTag;
    updateRangeOutputs();
    applyDisplaySettings();

    initDragDrop();
  }

  // ── Drag-and-drop ──────────────────────────────────────────────────────────
  function initDragDrop() {
    $$('.color-row').forEach(row => {
      row.addEventListener('pointerdown', onPointerDragStart);
    });
  }

  function highlightListSignature() {
    return JSON.stringify(allHighlights.map(item => [
      item.highlightId,
      item.timestamp,
      item.colorId,
      item.status,
      item.version,
      item.etag,
      item.sourceRange
    ]));
  }

  function stopUiRefresh() {
    if (uiRefreshTimer != null) clearInterval(uiRefreshTimer);
    uiRefreshTimer = null;
  }

  function startUiRefresh() {
    if (!isForeground()) return;
    stopUiRefresh();
    uiRefreshTimer = setInterval(async () => {
      const highlightsTabVisible = $('.tab[data-tab="highlights"]')?.classList.contains('active');
      if (!highlightsTabVisible || document.visibilityState === 'hidden' || uiRefreshInFlight) return;
      uiRefreshInFlight = true;
      try {
        await loadAllHighlights();
        if (highlightListSignature() !== lastRenderedHighlightsSignature) {
          await renderHighlightList();
        }
      } catch (error) {
        console.warn('Highlight list refresh failed', error);
      } finally {
        uiRefreshInFlight = false;
      }
    }, 2000);
  }

  function onPointerDragStart(e) {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (e.target.closest('input, button, label, select, summary, details')) return;
    const source = e.currentTarget.closest('.color-row');
    if (!source) return;
    settings = collectColorSettingsFromForm();
    e.preventDefault();
    dragSrcIndex = Number(source.dataset.index);
    let destinationIndex = dragSrcIndex;
    source.classList.add('drag-dragging');

    const move = event => {
      const target = document.elementFromPoint(event.clientX, event.clientY)?.closest?.('.color-row');
      if (target) destinationIndex = Number(target.dataset.index);
      $$('.color-row').forEach(row => row.classList.toggle('drag-over', row === target && row !== source));
    };
    const finish = () => {
      if (dragSrcIndex != null && destinationIndex !== dragSrcIndex) {
        const colors = structuredCloneSafe(settings.colors);
        const [moved] = colors.splice(dragSrcIndex, 1);
        colors.splice(destinationIndex, 0, moved);
        settings.colors = colors;
      }
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', finish);
      document.removeEventListener('pointercancel', finish);
      onRowDragEnd();
      renderSettings();
      scheduleAutoSave(settings, 'colorsAutoSaveStatus', 100);
    };
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', finish);
    document.addEventListener('pointercancel', finish);
  }

  function onRowDragEnd() {
    $$('.color-row').forEach(r => r.classList.remove('drag-dragging', 'drag-over'));
    dragSrcIndex = null;
  }

  // ── Form helpers ───────────────────────────────────────────────────────────
  function collectColorSettingsFromForm() {
    const colors = $$('.color-row').map(row => {
      const cur = settings.colors[Number(row.dataset.index)] || {};
      return {
        id:      cur.id || `custom-${Date.now()}`,
        hex:     $('[data-field="hex"]', row).value,
        label:   $('[data-field="label"]', row).value.trim() || '\u05E6\u05D1\u05E2',
        enabled: $('[data-field="enabled"]', row).checked,
        markerMode: $('[data-field="markerMode"]', row).value,
        opacity: Number($('[data-field="opacity"]', row).value),
        borderRadius: Number($('[data-field="borderRadius"]', row).value)
      };
    });
    return normalizeSettings({
      colors,
      defaultColorId: settings.defaultColorId,
      menuStyle:      settings.menuStyle,
      appearance:     settings.appearance,
      maxColors:      MAX_COLORS
    });
  }

  function collectPreferencesFromForm() {
    const menuStyleEl = $('input[name="menuStyle"]:checked');
    return normalizeSettings(Object.assign({}, settings, {
      menuStyle: menuStyleEl?.value || settings.menuStyle,
      appearance: {
        viewMode: $('#viewMode').value,
        fontFamily: $('#fontFamily').value,
        fontSize: Number($('#fontSize').value),
        lineHeight: Number($('#lineHeight').value)
      },
      exportTemplate: {
        format: $('#humanExportFormat').value,
        includeBook: $('#exportIncludeBook').checked,
        includeRef: $('#exportIncludeRef').checked,
        includeNote: $('#exportIncludeNote').checked,
        includeTags: $('#exportIncludeTags').checked,
        includeDate: $('#exportIncludeDate').checked
      }
    }));
  }

  function updateRangeOutputs() {
    $('#fontSizeValue').textContent = `${$('#fontSize').value} פיקסלים`;
    $('#lineHeightValue').textContent = $('#lineHeight').value;
  }

  async function transformGlobalTag(action) {
    const source = $('#manageTagSource').value;
    const target = normalizeTags($('#manageTagTarget').value)[0] || '';
    if (!source || (action !== 'delete' && !target) || source === target) return;
    if (action === 'delete') {
      const confirmation = await call('ui.showWarning', {
        title: 'מחיקת תגית', content: `התגית „${source}” תוסר מכל ההדגשות. להמשיך?`
      });
      if (!confirmation?.confirmed) return;
    }
    const affected = allHighlights.filter(item => normalizeTags(item.tags).includes(source));
    let failed = 0;
    for (const item of affected) {
      const nextTags = normalizeTags(item.tags).flatMap(tag => tag === source ? (action === 'delete' ? [] : [target]) : [tag]);
      try {
        await updateHighlightColor(item, getColorById(item.colorId), { render: false, tags: nextTags });
      } catch (error) { failed++; console.error('Global tag update failed', item.highlightId, error); }
    }
    $('#manageTagTarget').value = '';
    await renderHighlightList();
    renderSettings();
    await call(failed ? 'ui.showWarning' : 'ui.showSuccess', failed
      ? { title: 'עדכון חלקי', content: `${affected.length - failed} עודכנו; ${failed} נכשלו` }
      : { message: `${affected.length} הדגשות עודכנו` }
    ).catch(() => {});
  }

  function humanExportContent(items, template) {
    const rows = items.map(item => {
      const heading = [template.includeBook ? (item.book || item.bookId) : '', template.includeRef ? item.ref : ''].filter(Boolean).join(' · ');
      const tags = normalizeTags(item.tags);
      const date = template.includeDate && item.timestamp ? toHebrewDate(item.timestamp) : '';
      if (template.format === 'html') {
        return `<article dir="rtl"><h2>${escapeHtml(heading)}</h2><blockquote>${escapeHtml(item.text || '')}</blockquote>${template.includeNote && item.note ? `<p><strong>הערה:</strong> ${escapeHtml(item.note)}</p>` : ''}${template.includeTags && tags.length ? `<p><strong>תגיות:</strong> ${tags.map(escapeHtml).join(', ')}</p>` : ''}${date ? `<time>${escapeHtml(date)}</time>` : ''}</article>`;
      }
      if (template.format === 'text') {
        return [heading, item.text || '', template.includeNote && item.note ? `הערה: ${item.note}` : '', template.includeTags && tags.length ? `תגיות: ${tags.join(', ')}` : '', date].filter(Boolean).join('\n');
      }
      return [`## ${heading || 'הדגשה'}`, `> ${(item.text || '').replace(/\n/g, '\n> ')}`, template.includeNote && item.note ? `**הערה:** ${item.note}` : '', template.includeTags && tags.length ? `**תגיות:** ${tags.join(', ')}` : '', date ? `_${date}_` : ''].filter(Boolean).join('\n\n');
    });
    if (template.format === 'html') return `<!doctype html><html lang="he" dir="rtl"><meta charset="utf-8"><title>הדגשות מרקר</title><style>body{font-family:system-ui;max-width:850px;margin:auto;padding:24px}article{border-bottom:1px solid #ddd;padding:16px 0}blockquote{white-space:pre-wrap}</style><body><h1>הדגשות מרקר</h1>${rows.join('')}</body></html>`;
    return rows.join('\n\n---\n\n');
  }

  async function exportVisibleHumanReadable() {
    const visibleKeys = new Set(visibleHighlightKeys);
    const items = allHighlights.filter(item => visibleKeys.has(item.key));
    if (!items.length) return;
    const template = settings.exportTemplate || DEFAULT_SETTINGS.exportTemplate;
    const extension = template.format === 'markdown' ? 'md' : template.format === 'html' ? 'html' : 'txt';
    const mime = template.format === 'html' ? 'text/html' : 'text/plain';
    const file = new File([humanExportContent(items, template)], `otzaria-marker-export-${new Date().toISOString().slice(0, 10)}.${extension}`, { type: `${mime};charset=utf-8` });
    if (navigator.canShare?.({ files: [file] })) {
      try { await navigator.share({ title: 'הדגשות מרקר', files: [file] }); return; }
      catch (error) { if (error?.name === 'AbortError') return; }
    }
    const url = URL.createObjectURL(file);
    const link = document.createElement('a');
    link.href = url; link.download = file.name; link.hidden = true;
    document.body.appendChild(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // ── Backup & restore ──────────────────────────────────────────────────────
  function backupPayload(highlights = allHighlights) {
    return {
      format: 'otzaria-marker-backup',
      schemaVersion: 1,
      pluginVersion: '1.13.6',
      exportedAt: new Date().toISOString(),
      settings: normalizeSettings(settings),
      highlights: highlights.map(({ key, ...item }) => item)
    };
  }

  async function downloadBackup(highlights, filenamePrefix) {
    const json = JSON.stringify(backupPayload(highlights), null, 2);
    const filename = `${filenamePrefix}-${new Date().toISOString().slice(0, 10)}.json`;

    // נסה להשתמש ב-File System Access API לבחירת תיקייה
    if (window.showSaveFilePicker) {
      try {
        const fileHandle = await window.showSaveFilePicker({
          suggestedName: filename,
          types: [{ description: 'JSON Backup', accept: { 'application/json': ['.json'] } }]
        });
        const writable = await fileHandle.createWritable();
        await writable.write(json);
        await writable.close();
        return;
      } catch (error) {
        if (error?.name === 'AbortError') return;
        // fallback לשיטה הישנה
      }
    }

    const file = new File([json], filename, { type: 'application/json' });
    if (navigator.canShare?.({ files: [file] })) {
      try {
        await navigator.share({ title: 'גיבוי מרקר אוצריא', files: [file] });
        return;
      } catch (error) {
        if (error?.name === 'AbortError') return;
      }
    }
    const url = URL.createObjectURL(file);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.hidden = true;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function exportBackup() {
    await loadAllHighlights();
    await downloadBackup(allHighlights, 'otzaria-marker-backup');
  }

  async function exportSelectedHighlights() {
    const items = allHighlights.filter(item => selectedHighlightKeys.has(item.key));
    if (!items.length) return;
    await downloadBackup(items, 'otzaria-marker-selected');
    await call('ui.showSuccess', { message: `יוצאו ${items.length} הדגשות` }).catch(() => {});
  }

  function validateBackup(raw) {
    if (!raw || raw.format !== 'otzaria-marker-backup' || raw.schemaVersion !== 1) {
      throw new Error('\u05D6\u05D4 \u05D0\u05D9\u05E0\u05D5 \u05E7\u05D5\u05D1\u05E5 \u05D2\u05D9\u05D1\u05D5\u05D9 \u05EA\u05E7\u05D9\u05DF \u05E9\u05DC \u05DE\u05E8\u05E7\u05E8');
    }
    if (!Array.isArray(raw.highlights) || raw.highlights.length > 10000) {
      throw new Error('\u05DB\u05DE\u05D5\u05EA \u05D4\u05D4\u05D3\u05D2\u05E9\u05D5\u05EA \u05D1\u05E7\u05D5\u05D1\u05E5 \u05D0\u05D9\u05E0\u05D4 \u05EA\u05E7\u05D9\u05E0\u05D4');
    }
    const highlights = raw.highlights.filter(item =>
      item && typeof item.highlightId === 'string' && item.highlightId.length <= 128 &&
      typeof item.bookId === 'string' && Number.isInteger(item.sectionIndex) &&
      item.sectionIndex >= 0 && rangeBounds(item.sourceRange)
    ).map(item => ({
      highlightId: item.highlightId,
      bookId: item.bookId,
      sectionIndex: item.sectionIndex,
      colorId: String(item.colorId || 'yellow').slice(0, 80),
      color: toSafeHex(item.color),
      text: String(item.text || '').slice(0, 20000),
      note: String(item.note || '').slice(0, 1000),
      tags: normalizeTags(item.tags),
      favorite: item.favorite === true,
      style: buildHighlightStyle(item.style || { hex: item.color }),
      ref: String(item.ref || '').slice(0, 1000),
      book: String(item.book || item.bookId).slice(0, 1000),
      sourceRange: item.sourceRange,
      version: Number.isInteger(item.version) ? item.version : null,
      etag: typeof item.etag === 'string' ? item.etag.slice(0, 300) : null,
      timestamp: Number.isFinite(item.timestamp) ? item.timestamp : Date.now()
    }));
    if (highlights.length !== raw.highlights.length) {
      throw new Error('\u05D0\u05D7\u05EA \u05D4\u05D4\u05D3\u05D2\u05E9\u05D5\u05EA \u05D1\u05E7\u05D5\u05D1\u05E5 \u05E4\u05D2\u05D5\u05DE\u05D4');
    }
    if (new Set(highlights.map(item => item.highlightId)).size !== highlights.length) {
      throw new Error('קובץ הגיבוי מכיל מזהי הדגשות כפולים');
    }
    return { settings: normalizeSettings(raw.settings), highlights };
  }

  function highlightImportSignature(item) {
    return JSON.stringify({
      bookId: item.bookId,
      sectionIndex: item.sectionIndex,
      colorId: item.colorId,
      color: toSafeHex(item.color),
      text: item.text || '',
      note: item.note || '',
      tags: normalizeTags(item.tags),
      favorite: item.favorite === true,
      style: buildHighlightStyle(item.style || { hex: item.color }),
      ref: item.ref || '',
      book: item.book || item.bookId,
      sourceRange: item.sourceRange
    });
  }

  function previewBackupImport(highlights) {
    const currentById = new Map(allHighlights.map(item => [item.highlightId, item]));
    const result = { added: [], updated: [], identical: [] };
    for (const item of highlights) {
      const current = currentById.get(item.highlightId);
      if (!current) result.added.push(item);
      else if (highlightImportSignature(current) === highlightImportSignature(item)) result.identical.push(item);
      else result.updated.push(item);
    }
    return result;
  }

  async function importBackup() {
    let token = null;
    try {
      const picked = await call('fs.pickUserFile', {
        title: '\u05D1\u05D7\u05E8 \u05E7\u05D5\u05D1\u05E5 \u05D2\u05D9\u05D1\u05D5\u05D9 \u05E9\u05DC \u05D4\u05DE\u05E8\u05E7\u05E8',
        extensions: ['json']
      });
      if (picked?.cancelled) return;
      token = picked.token;
      await restoreBackupText(await call('fs.readTextFile', { token }));
    } catch (error) {
      if (error?.code === 'permission_denied' || String(error?.message || '').includes('permission_denied')) {
        // עדכון מתוסף ישן יכול להשאיר את ההרשאה החדשה כבויה. בוחר הקבצים
        // המובנה של ה-WebView עדיין בטוח: המשתמש מעניק גישה לקובץ יחיד בלבד.
        $('#backupFileInput').click();
        return;
      }
      console.error('Backup import failed', error);
      await call('ui.showError', { message: `\u05D9\u05D9\u05D1\u05D5\u05D0 \u05D4\u05D2\u05D9\u05D1\u05D5\u05D9 \u05E0\u05DB\u05E9\u05DC: ${error?.message || error}` }).catch(() => {});
    } finally {
      if (token) await call('fs.revokeFile', { token }).catch(() => {});
    }
  }

  async function restoreBackupText(text) {
    let rollback = null;
    let mutationStarted = false;
    try {
      if (typeof text !== 'string' || text.length > 50_000_000) {
        throw new Error('קובץ הגיבוי גדול מדי או שאינו קובץ טקסט תקין');
      }
      await loadAllHighlights();
      rollback = {
        settings: structuredCloneSafe(settings),
        highlights: allHighlights.map(item => structuredCloneSafe(item))
      };
      const backup = validateBackup(JSON.parse(text));
      const replace = $('#importMode').value === 'replace';
      const preview = previewBackupImport(backup.highlights);
      const confirmation = await call('ui.showWarning', {
        title: replace ? '\u05D4\u05D7\u05DC\u05E4\u05EA \u05D2\u05D9\u05D1\u05D5\u05D9' : '\u05DE\u05D9\u05D6\u05D5\u05D2 \u05D2\u05D9\u05D1\u05D5\u05D9',
        content: replace
          ? `כל ${allHighlights.length} ההדגשות הקיימות יוחלפו ב-${backup.highlights.length} הדגשות מהגיבוי.`
          : `תצוגה מקדימה: ${preview.added.length} חדשות, ${preview.updated.length} עדכונים, ${preview.identical.length} כפילויות זהות שיידלגו. גם הגדרות התוסף יעודכנו מהגיבוי.`
      });
      if (!confirmation?.confirmed) return;

      mutationStarted = true;
      if (replace) {
        await call('reader.clearAllHighlights', {}).catch(() => {});
        for (const item of allHighlights) {
          await call('storage.remove', { key: item.key || highlightKey(item.highlightId) }).catch(() => {});
        }
      }
      const itemsToImport = replace ? backup.highlights : [...preview.added, ...preview.updated];
      await call('storage.set', { key: SETTINGS_KEY, value: backup.settings });
      settings = backup.settings;
      for (const item of itemsToImport) {
        await call('storage.set', { key: highlightKey(item.highlightId), value: item });
      }
      if (!replace) {
        for (const item of preview.updated) {
          await call('reader.clearHighlight', { highlightId: item.highlightId }).catch(() => {});
        }
      }
      await reapplyAllHighlights(new Set(itemsToImport.map(item => item.highlightId)));
      await syncStaleHighlights();
      renderSettings();
      await renderHighlightList();
      const summary = replace
        ? `הגיבוי יובא בהצלחה · ${backup.highlights.length} הדגשות`
        : `הייבוא הושלם · ${preview.added.length} חדשות · ${preview.updated.length} עודכנו · ${preview.identical.length} כפילויות דולגו`;
      await call('ui.showSuccess', { message: summary });
    } catch (error) {
      console.error('Backup import failed', error);
      let rolledBack = false;
      if (mutationStarted && rollback) {
        try {
          await call('reader.clearAllHighlights', {}).catch(() => {});
          await loadAllHighlights();
          for (const item of allHighlights) {
            await call('storage.remove', { key: item.key || highlightKey(item.highlightId) }).catch(() => {});
          }
          await call('storage.set', { key: SETTINGS_KEY, value: rollback.settings });
          settings = rollback.settings;
          for (const item of rollback.highlights) {
            const value = Object.assign({}, item);
            delete value.key;
            await call('storage.set', { key: highlightKey(item.highlightId), value });
          }
          await reapplyAllHighlights();
          await renderHighlightList();
          rolledBack = true;
        } catch (rollbackError) {
          console.error('Backup import rollback failed', rollbackError);
        }
      }
      const suffix = rolledBack ? ' השינויים בוטלו והמצב הקודם שוחזר.' : '';
      await call('ui.showError', { message: `\u05D9\u05D9\u05D1\u05D5\u05D0 \u05D4\u05D2\u05D9\u05D1\u05D5\u05D9 \u05E0\u05DB\u05E9\u05DC: ${error?.message || error}.${suffix}` }).catch(() => {});
    }
  }


  // ── UI binding ─────────────────────────────────────────────────────────────
  function isEditableTarget(target) {
    return target?.matches?.('input, textarea, select, [contenteditable="true"]');
  }

  function selectVisibleHighlights() {
    visibleHighlightKeys.forEach(key => selectedHighlightKeys.add(key));
    $$('.highlight-select').forEach(input => { input.checked = selectedHighlightKeys.has(input.dataset.key); });
    updateBulkActions();
  }

  function bindUi() {
    if (uiBound) return;
    uiBound = true;

    $$('.tab').forEach(btn => btn.addEventListener('click', async () => {
      $$('.tab').forEach(b => b.classList.toggle('active', b === btn));
      $$('.tab-panel').forEach(p => p.classList.toggle('active', p.dataset.panel === btn.dataset.tab));
      if (btn.dataset.tab === 'highlights') renderHighlightList().catch(console.warn);
      if (btn.dataset.tab === 'colors' || btn.dataset.tab === 'settings') {
        await loadAllHighlights().catch(console.warn);
        renderSettings();
      }
    }));

    $('#refreshBtn').addEventListener('click', renderHighlightList);
    $('#bookFilter').addEventListener('change', resetListWindowAndRender);
    $('#colorFilter').addEventListener('change', resetListWindowAndRender);
    $('#tagFilter').addEventListener('change', resetListWindowAndRender);
    $('#statusFilter').addEventListener('change', resetListWindowAndRender);
    $('#sortHighlights').addEventListener('change', resetListWindowAndRender);
    $('#groupHighlights').addEventListener('change', resetListWindowAndRender);
    $('#highlightSearch').addEventListener('input', () => {
      clearTimeout(searchRenderTimer);
      searchRenderTimer = setTimeout(() => resetListWindowAndRender().catch(console.warn), 180);
    });
    $('#resetFiltersBtn').addEventListener('click', () => {
      $('#highlightSearch').value = '';
      $('#bookFilter').value = 'all';
      $('#colorFilter').value = 'all';
      $('#tagFilter').value = 'all';
      $('#statusFilter').value = 'all';
      $('#sortHighlights').value = 'newest';
      $('#groupHighlights').value = 'none';
      resetListWindowAndRender().catch(console.warn);
    });
    $('#selectVisibleBtn').addEventListener('click', () => {
      selectVisibleHighlights();
    });
    $('#selectAllBtn').addEventListener('click', () => {
      allHighlights.forEach(item => selectedHighlightKeys.add(item.key));
      $$('.highlight-select').forEach(input => { input.checked = true; });
      updateBulkActions();
    });
    $('#loadMoreBtn').addEventListener('click', () => {
      renderedHighlightLimit += HIGHLIGHTS_PAGE_SIZE;
      renderHighlightList().catch(console.warn);
    });
    $('#applyBulkColorBtn').addEventListener('click', applyColorToSelected);
    $('#applyBulkTagsBtn').addEventListener('click', addTagsToSelected);
    $('#exportSelectedBtn').addEventListener('click', exportSelectedHighlights);
    $('#deleteSelectedBtn').addEventListener('click', deleteSelectedHighlights);
    $('#clearSelectionBtn').addEventListener('click', () => {
      selectedHighlightKeys.clear();
      $$('.highlight-select').forEach(input => { input.checked = false; });
      updateBulkActions();
    });
    $('#clearAllBtn').addEventListener('click', deleteAllHighlights);
    $('#undoDeleteBtn').addEventListener('click', undoLastDelete);
    $('#dismissUndoBtn').addEventListener('click', dismissUndoDelete);
    $('#closeEditDialogBtn').addEventListener('click', closeEditHighlight);
    $('#cancelEditHighlightBtn').addEventListener('click', closeEditHighlight);
    $('#editHighlightDialog').addEventListener('cancel', () => {
      editingHighlightKey = null;
      const target = editReturnFocus;
      editReturnFocus = null;
      if (target?.isConnected) setTimeout(() => target.focus(), 0);
    });
    $('#editHighlightForm').addEventListener('submit', async e => {
      e.preventDefault();
      const submit = e.submitter;
      if (submit) submit.disabled = true;
      try {
        await saveEditedHighlight();
      } catch (err) {
        console.error('Failed editing highlight', err);
        await call('ui.showError', { message: highlightUpdateErrorMessage(err) }).catch(() => {});
      } finally {
        if (submit) submit.disabled = false;
      }
    });

    $('#highlightsList').addEventListener('change', async e => {
      if (e.target.matches('.highlight-select')) {
        if (e.target.checked) selectedHighlightKeys.add(e.target.dataset.key);
        else selectedHighlightKeys.delete(e.target.dataset.key);
        updateBulkActions();
        return;
      }
      if (e.target.matches('.inline-color')) {
        const item = allHighlights.find(h => h.key === e.target.dataset.key);
        const color = settings.colors.find(c => c.id === e.target.value);
        if (!item || !color || color.id === item.colorId) return;
        e.target.disabled = true;
        try {
          await updateHighlightColor(item, color);
          await call('ui.showSuccess', { message: `הצבע שונה ל${color.label}` }).catch(() => {});
        } catch (err) {
          console.error('Failed updating highlight color', err);
          await call('ui.showError', { message: highlightUpdateErrorMessage(err) }).catch(() => {});
          await renderHighlightList();
        }
      }
    });

    $('#highlightsList').addEventListener('keydown', e => {
      const card = e.target.closest('.highlight-card');
      if (!card || e.target !== card) return;
      if (e.key === 'Enter') {
        e.preventDefault();
        card.querySelector('button[data-action="open"]')?.click();
      } else if (e.key === ' ' || e.key === 'Spacebar') {
        e.preventDefault();
        const checkbox = card.querySelector('.highlight-select');
        if (!checkbox) return;
        checkbox.checked = !checkbox.checked;
        checkbox.dispatchEvent(new Event('change', { bubbles: true }));
      }
    });

    document.addEventListener('keydown', e => {
      const modifier = e.ctrlKey || e.metaKey;
      if (modifier && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        $('.tab[data-tab="highlights"]')?.click();
        requestAnimationFrame(() => $('#highlightSearch').focus());
        return;
      }
      if (isEditableTarget(e.target) || $('#editHighlightDialog').open) return;
      const highlightsVisible = $('.tab[data-tab="highlights"]')?.classList.contains('active');
      if (!highlightsVisible) return;
      if (modifier && e.key.toLowerCase() === 'a') {
        e.preventDefault();
        selectVisibleHighlights();
      } else if (e.key === 'Delete' && selectedHighlightKeys.size) {
        e.preventDefault();
        deleteSelectedHighlights().catch(console.error);
      } else if (e.key === 'Escape' && selectedHighlightKeys.size) {
        e.preventDefault();
        selectedHighlightKeys.clear();
        $$('.highlight-select').forEach(input => { input.checked = false; });
        updateBulkActions();
      }
    });

    $('#highlightsList').addEventListener('click', async e => {
      const btn = e.target.closest('button[data-action]');
      if (!btn) return;
      const item = allHighlights.find(h => h.key === btn.dataset.key);
      if (!item) return;
      if (btn.dataset.action === 'open') {
        try {
          await openHighlight(item);
        } catch (err) {
          console.error('Failed opening highlight', err);
          await call('ui.showMessage', {
            message: `\u05DC\u05D0 \u05D4\u05E6\u05DC\u05D7\u05E0\u05D5 \u05DC\u05E4\u05EA\u05D5\u05D7 \u05D0\u05EA \u05D4\u05E1\u05D9\u05DE\u05D5\u05DF: ${err?.message || err}`
          }).catch(() => {});
        }
      }
      if (btn.dataset.action === 'edit') openEditHighlight(item, btn);
      if (btn.dataset.action === 'delete') await deleteHighlight(item);
    });

    $('#colorsEditor').addEventListener('click', e => {
      const btn = e.target.closest('button[data-action]');
      if (!btn) return;
      settings = collectColorSettingsFromForm();
      const row = btn.closest('.color-row');
      const i   = Number(row.dataset.index);
      if (btn.dataset.action === 'pick') {
        const inp = row.querySelector('input[type="color"]');
        if (inp?.showPicker) inp.showPicker(); else inp?.click();
        return;
      }
      if (btn.dataset.action === 'remove') {
        settings.colors.splice(i, 1);
      } else if (btn.dataset.action === 'up' && i > 0) {
        [settings.colors[i-1], settings.colors[i]] = [settings.colors[i], settings.colors[i-1]];
      } else if (btn.dataset.action === 'down' && i < settings.colors.length - 1) {
        [settings.colors[i+1], settings.colors[i]] = [settings.colors[i], settings.colors[i+1]];
      }
      renderSettings();
      scheduleAutoSave(settings, 'colorsAutoSaveStatus', 100);
    });

    $('#colorsEditor').addEventListener('input', e => {
      if (e.target.matches('input[type="color"]')) {
        const row = e.target.closest('.color-row');
        row?.querySelector('.color-picker-btn')?.style.setProperty('--picked-color', e.target.value);
      }
      if (e.target.matches('[data-field="opacity"]')) {
        const output = e.target.closest('label')?.querySelector('output');
        if (output) output.textContent = `${Math.round(Number(e.target.value) * 100)}%`;
      }
      settings = collectColorSettingsFromForm();
      scheduleAutoSave(settings, 'colorsAutoSaveStatus');
    });

    $('#colorsEditor').addEventListener('change', e => {
      if (e.target.matches('[data-field="markerMode"]')) {
        e.target.closest('.color-row')?.setAttribute('data-marker-mode', e.target.value);
      }
      // בדיקה אם הפעלנו יותר מ-MAX_MENU_COLORS - רק 5 הראשונים מופיעים בתפריט
      if (e.target.matches('[data-field="enabled"]') && e.target.checked) {
        const tempSettings = collectColorSettingsFromForm();
        const activeCount = tempSettings.colors.filter(c => c.enabled).length;
        if (activeCount > MAX_MENU_COLORS) {
          e.target.checked = false;
          call('ui.showMessage', {
            message: `ניתן להפעיל עד ${MAX_MENU_COLORS} צבעים בו-זמנית (${MAX_MENU_COLORS} הראשונים מופיעים בתפריט)`
          }).catch(() => {});
          return;
        }
      }
      settings = collectColorSettingsFromForm();
      scheduleAutoSave(settings, 'colorsAutoSaveStatus', 150);
    });

    $('#addColorBtn').addEventListener('click', () => {
      settings = collectColorSettingsFromForm();
      if (settings.colors.length >= MAX_COLORS) return;
      settings.colors.push({ id: `custom-${Date.now()}`, hex: '#E1BEE7', label: '\u05D2\u05D5\u05D5\u05DF \u05D7\u05D3\u05E9', enabled: true });
      renderSettings();
      scheduleAutoSave(settings, 'colorsAutoSaveStatus', 100);
      const inp = $('.color-row:last-child input[type="color"]');
      if (inp?.showPicker) inp.showPicker(); else inp?.click();
    });

    $('#resetColorsBtn').addEventListener('click', async () => {
      const res = await call('ui.showWarning', {
        title: 'איפוס צבעים',
        content: 'האם לאפס את הצבעים לברירת המחדל? שינויי הצבעים שלך יאבדו.'
      }).catch(() => null);
      if (!res?.confirmed) return;
      settings = normalizeSettings(Object.assign({}, settings, {
        colors: structuredCloneSafe(DEFAULT_SETTINGS.colors),
        defaultColorId: DEFAULT_SETTINGS.defaultColorId
      }));
      renderSettings();
      scheduleAutoSave(settings, 'colorsAutoSaveStatus', 100);
    });

    $('#colorsForm').addEventListener('submit', async e => {
      e.preventDefault();
      scheduleAutoSave(collectColorSettingsFromForm(), 'colorsAutoSaveStatus', 0);
    });

    $('#preferencesForm').addEventListener('input', () => {
      settings = collectPreferencesFromForm();
      updateRangeOutputs();
      applyDisplaySettings();
      scheduleAutoSave(settings, 'preferencesAutoSaveStatus');
    });

    $('#preferencesForm').addEventListener('change', () => {
      settings = collectPreferencesFromForm();
      applyDisplaySettings();
      scheduleAutoSave(settings, 'preferencesAutoSaveStatus', 150);
    });

    $('#preferencesForm').addEventListener('submit', async e => {
      e.preventDefault();
      scheduleAutoSave(collectPreferencesFromForm(), 'preferencesAutoSaveStatus', 0);
    });

    $('#resetPreferencesBtn').addEventListener('click', () => {
      settings = normalizeSettings(Object.assign({}, settings, {
        menuStyle: DEFAULT_SETTINGS.menuStyle,
        appearance: structuredCloneSafe(DEFAULT_SETTINGS.appearance)
      }));
      renderSettings();
      applyDisplaySettings();
      scheduleAutoSave(settings, 'preferencesAutoSaveStatus', 100);
    });

    $('#renameTagBtn').addEventListener('click', () => transformGlobalTag('rename'));
    $('#mergeTagBtn').addEventListener('click', () => transformGlobalTag('merge'));
    $('#deleteTagBtn').addEventListener('click', () => transformGlobalTag('delete'));
    $('#exportVisibleHumanBtn').addEventListener('click', async () => {
      try { await exportVisibleHumanReadable(); }
      catch (error) {
        console.error('Human-readable export failed', error);
        await call('ui.showError', { message: 'ייצוא ההדגשות נכשל' }).catch(() => {});
      }
    });

    $('#exportBackupBtn').addEventListener('click', async () => {
      try {
        await exportBackup();
      } catch (error) {
        console.error('Backup export failed', error);
        await call('ui.showError', { message: '\u05D9\u05D9\u05E6\u05D5\u05D0 \u05D4\u05D2\u05D9\u05D1\u05D5\u05D9 \u05E0\u05DB\u05E9\u05DC' }).catch(() => {});
      }
    });
    $('#importBackupBtn').addEventListener('click', importBackup);
    $('#backupFileInput').addEventListener('change', async event => {
      const file = event.target.files?.[0];
      event.target.value = '';
      if (!file) return;
      if (file.size > 10 * 1024 * 1024) {
        await call('ui.showError', { message: '\u05E7\u05D5\u05D1\u05E5 \u05D4\u05D2\u05D9\u05D1\u05D5\u05D9 \u05D2\u05D3\u05D5\u05DC \u05DE\u05D3\u05D9' }).catch(() => {});
        return;
      }
      await restoreBackupText(await file.text());
    });
  }

  // ── Boot & lifecycle ───────────────────────────────────────────────────────
  Otzaria.on('plugin.boot', async payload => {
    try {
      runMode = payload?.app?.runMode === 'background' ? 'background' : 'foreground';
      runtimeOwner = runMode === 'background' || !hasStartupPermission(payload?.permissions);
      await loadSettings();
      if (isForeground()) {
        applyTheme(payload.theme);
        bindUi();
        renderSettings();
        await renderHighlightList();
        startUiRefresh();
      }
      if (runtimeOwner) {
        await unregisterContextMenuItems();
        // Re-anchor all stored highlights, then sync stale status. When startup
        // permission is active this work belongs only to the background instance.
        reapplyAllHighlights()
          .then(() => syncStaleHighlights())
          .then(() => renderHighlightList())
          .catch(console.warn);
      }
    } catch (err) { console.error(err); }
  });

  Otzaria.on('theme.changed', theme => {
    if (isForeground()) {
      applyTheme(theme);
      applyDisplaySettings();
    }
  });

  Otzaria.on('plugin.permissions_changed', async data => {
    if (!isForeground()) return;
    const wasOwner = runtimeOwner;
    const willOwnRuntime = !hasStartupPermission(data?.permissions);
    if (wasOwner && !willOwnRuntime) {
      await unregisterContextMenuItems();
    }
    runtimeOwner = willOwnRuntime;
    if (!wasOwner && runtimeOwner) {
      await loadSettings();
      await reapplyAllHighlights();
      await syncStaleHighlights();
    }
  });

  // Selection: remember + show menu
  Otzaria.on('reader.selection_changed', async data => {
    if (!runtimeOwner) return;
    if (!hasUsableSelection(data)) {
      selectionRevision++;
      lastSelection = null;
      savedSelection = null;
      await unregisterContextMenuItems();
      return;
    }
    const revision = rememberSelection(data);
    if (revision == null) return;
    // Settings may have changed in the visible instance since the previous
    // selection. Storage is shared between foreground and background.
    await loadSettings();
    await loadAllHighlights();
    if (revision !== selectionRevision) return;
    await refreshContextMenuForSelection();
  });

  // Context menu — new SDK 1.1 events (primary path)
  Otzaria.on('contextMenu.colorClicked', data => {
    if (runtimeOwner) return onColorClicked(data);
  });
  Otzaria.on('contextMenu.itemClicked', data => {
    if (runtimeOwner) return onStandardMenuClick(data);
  });

  // Source content changed: re-anchor highlights for affected sections
  Otzaria.on('reader.sectionContentChanged', async change => {
    if (!runtimeOwner) return;
    if (!change || change.changeType !== 'source-content') return;
    const bookId       = change.bookId;
    const sectionIndex = change.sectionIndex;
    if (bookId == null || sectionIndex == null) return;

    const affected = allHighlights.filter(h => h.bookId === bookId && h.sectionIndex === sectionIndex);
    if (!affected.length) return;

    // The Host performs re-anchoring before dispatching this event. Read back
    // the authoritative range/status instead of trying to create the same id.
    await syncStaleHighlights();
    await renderHighlightList();
  });

  Otzaria.on('reader.current_ref_changed', async () => {
    if (!runtimeOwner) return;
    selectionRevision++;
    lastSelection = null;
    // Give the context-menu click event 3 s to arrive before clearing savedSelection
    setTimeout(() => { savedSelection = null; }, 3000);
    await unregisterContextMenuItems();
  });

  Otzaria.on('navigation.changed', async () => {
    if (!runtimeOwner) return;
    selectionRevision++;
    lastSelection  = null;
    savedSelection = null;
    await unregisterContextMenuItems();
  });

  Otzaria.on('plugin.suspended', () => {
    if (isForeground()) {
      stopUiRefresh();
      return;
    }
    if (!runtimeOwner) return;
    window.clearTimeout(selectionTimer);
    selectionTimer = null;
    savedSelection = null;
  });

  Otzaria.on('plugin.resumed', () => {
    if (isForeground()) {
      renderHighlightList().catch(console.warn);
      startUiRefresh();
      return;
    }
    if (!runtimeOwner) return;
    if (lastSelection && Date.now() - lastSelection.rememberedAt > 45_000) {
      lastSelection = null;
    }
  });

})();
