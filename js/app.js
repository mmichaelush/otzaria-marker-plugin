(function () {
  'use strict';

  // Dependencies are explicit at the boundary: domain rules stay testable,
  // while this module owns only session state, DOM, and orchestration.
  const {
    SETTINGS_KEY, HIGHLIGHT_PREFIX, MAX_COLORS, MAX_MENU_COLORS,
    HIGHLIGHTS_PAGE_SIZE, DEFAULT_SETTINGS, structuredCloneSafe, escapeHtml,
    hexToRgba, toSafeHex, normalizeSettings, normalizeSearchText, normalizeTags,
    rangeBounds, rangesOverlap, compactText, splitSelectionPieces,
    selectedTextOf, hasUsableSelection, buildHighlightStyle, makeHighlightId,
    isSafeHighlightId, normalizeBootContext, ownsLegacyRuntime
  } = MarkerDomain;
  const { call, callRaw, createLogger, protectEvent } = MarkerRuntime;
  const logger = createLogger('app');
  const PLUGIN_VERSION = '0.9.1';
  const COLOR_PALETTE = Object.freeze([
    ['#B7DDBB', 'מרווה'], ['#FFD08A', 'משמש'], ['#FFE27A', 'זהב'],
    ['#FFF3A6', 'לימון'], ['#B8D8F0', 'שמיים'], ['#D8B4E2', 'לבנדר'],
    ['#F3B6C8', 'ורוד'], ['#C9C2F5', 'סגלגל']
  ]);
  const READER_SELECTION_CONTEXTS = Object.freeze([
    'reader-selection',
    'reader-page-shape-selection'
  ]);

  let settings          = structuredCloneSafe(DEFAULT_SETTINGS);
  let menuRegistered    = false;
  let registeredMenuType = null;
  let allHighlights     = [];
  let uiBound           = false;
  let lastSelection     = null;
  let savedSelection    = null;
  // Last reader.selection_changed payload info: its currentIndex is the
  // selection START line — needed to anchor multi-line selections.
  let lastEventSelection = null;
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
  let hostContext       = normalizeBootContext(null);
  let enhancedSelectCounter = 0;

  function isForeground() { return runMode === 'foreground'; }

  function applyHostMetadata(context) {
    if (!isForeground()) return;
    const root = document.documentElement;
    root.dataset.hostVersion = context.appVersion;
    root.dataset.hostLanguage = context.language;
    root.dataset.hostTextDirection = context.textDirection;
  }

  function colorForSelectValue(value) {
    const color = settings.colors.find(item => item.id === value);
    return color ? toSafeHex(color.hex) : '';
  }

  function selectOptionHtml(select, option) {
    const color = colorForSelectValue(option.value);
    const selected = option.value === select.value;
    return `<button type="button" class="otz-select-option${selected ? ' is-selected' : ''}" data-select-value="${escapeHtml(option.value)}" role="option" aria-selected="${selected}" ${option.disabled ? 'disabled' : ''}>${color ? `<span class="option-color-swatch" style="--option-color:${escapeHtml(color)}"></span>` : '<span class="otz-option-spacer" aria-hidden="true"></span>'}<span class="otz-option-label">${escapeHtml(option.textContent || '')}</span>${selected ? '<svg class="otz-option-check" viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4 4L19 6"/></svg>' : ''}</button>`;
  }

  function syncEnhancedSelect(select) {
    const shell = select?._otzSelectShell;
    if (!shell?.isConnected) return;
    const selected = select.options[select.selectedIndex] || select.options[0];
    const color = selected ? colorForSelectValue(selected.value) : '';
    const trigger = shell.querySelector('.otz-select-trigger');
    const label = trigger?.querySelector('.otz-select-value');
    const swatch = trigger?.querySelector('.option-color-swatch');
    if (label) label.textContent = selected?.textContent || 'בחירה';
    if (swatch) {
      swatch.hidden = !color;
      if (color) swatch.style.setProperty('--option-color', color);
    }
    shell.querySelector('.otz-select-menu').innerHTML = [...select.options]
      .map(option => selectOptionHtml(select, option)).join('');
    shell.classList.toggle('is-disabled', select.disabled);
    trigger.setAttribute('aria-disabled', String(select.disabled));
  }

  function enhanceSelect(select) {
    if (!select || select.dataset.otzEnhanced === 'true') {
      if (select) syncEnhancedSelect(select);
      return;
    }
    select.dataset.otzEnhanced = 'true';
    select.classList.add('otz-native-select');
    const shell = document.createElement('details');
    shell.className = 'otz-select';
    shell.dataset.selectId = select.id || `otz-select-${++enhancedSelectCounter}`;
    shell.innerHTML = `<summary class="otz-select-trigger"><span class="option-color-swatch" hidden></span><span class="otz-select-value">בחירה</span><svg class="otz-select-chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="m7 9 5 5 5-5"/></svg></summary><div class="otz-select-menu" role="listbox"></div>`;
    select.insertAdjacentElement('afterend', shell);
    select._otzSelectShell = shell;
    syncEnhancedSelect(select);
  }

  function enhanceSelects(root = document) {
    $$('select', root).forEach(enhanceSelect);
  }

  function syncAllEnhancedSelects() {
    $$('select[data-otz-enhanced="true"]').forEach(syncEnhancedSelect);
  }

  const $  = (sel, ctx = document) => ctx.querySelector(sel);
  const $$ = (sel, ctx = document) => [...ctx.querySelectorAll(sel)];

  // ── Settings ───────────────────────────────────────────────────────────────

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
        logger.error('Failed syncing highlight style', item.highlightId, error);
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
        logger.error('Automatic settings save failed', error);
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
    document.documentElement.style.setProperty('--highlight-font-size', `${appearance.fontSize}px`);
    document.documentElement.style.setProperty('--highlight-line-height', String(appearance.lineHeight));
    const list = $('#highlightsList');
    if (list) list.dataset.view = appearance.viewMode;
  }

  // ── Context Menu ───────────────────────────────────────────────────────────
  // Strategy:
  //   • registerContextMenuItems() — full registration (first time or after removal)
  //   • patchOrRebuildMenu()       — uses reader.updateContextMenuItem when possible,
  //                                  falls back to full rebuild only on error
  //   • unregisterContextMenuItems() — removes the single root item

  async function unregisterContextMenuItems(force = false) {
    if (!menuRegistered && !force) return;
    try { await call('reader.removeContextMenuItem', { id: 'marker-root' }); } catch (_) {}
    // Legacy id from versions that registered a separate item per context.
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

  /** Parts of a split (multi-line) highlight are removed together */
  function expandByGroup(items) {
    const groups = new Set(items.map(item => item.groupId).filter(Boolean));
    if (!groups.size) return items;
    const out = [...items];
    for (const item of allHighlights) {
      if (item.groupId && groups.has(item.groupId) && !out.includes(item)) out.push(item);
    }
    return out;
  }

  /** Start line of a multi-line selection, when the last selection event matches it */
  function multiLineStartIndexHint(selection) {
    if (!lastEventSelection || !Number.isInteger(lastEventSelection.currentIndex)) return null;
    return compactText(lastEventSelection.text) === compactText(selectedTextOf(selection))
      ? lastEventSelection.currentIndex
      : null;
  }

  function highlightsOverlappingSelection(selection) {
    const bookId = selection?.currentBookId || selection?.bookId;
    const index  = selection?.currentIndex ?? selection?.sectionIndex;
    if (!bookId || index == null) return [];
    const pieces = splitSelectionPieces(selectedTextOf(selection));
    if (pieces.length > 1 && !selection.sourceRange) {
      // Multi-line selection carries no per-line anchor — match by line span.
      const start = multiLineStartIndexHint(selection) ?? index;
      const end = start + pieces.length - 1;
      return expandByGroup(allHighlights.filter(item =>
        item.bookId === bookId &&
        item.sectionIndex >= start &&
        item.sectionIndex <= end
      ));
    }
    return expandByGroup(allHighlights.filter(item =>
      item.bookId === bookId &&
      item.sectionIndex === index &&
      (!selection.sourceRange || rangesOverlap(item.sourceRange, selection.sourceRange))
    ));
  }

  /** Overlaps against resolved per-section targets (multi-line apply) */
  function highlightsOverlappingTargets(bookId, targets) {
    const out = [];
    for (const target of targets) {
      for (const item of allHighlights) {
        if (item.bookId === bookId &&
            item.sectionIndex === target.sectionIndex &&
            (!target.range || rangesOverlap(item.sourceRange, target.range)) &&
            !out.includes(item)) {
          out.push(item);
        }
      }
    }
    return expandByGroup(out);
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
        icon:         'eraser_24_regular'
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
    // Remove both current and legacy ids so a previous plugin instance cannot
    // leave a duplicate heading beside the color row.
    await unregisterContextMenuItems(true);
    const colors = menuColors();
    if (!colors.length) return;

    const sel    = savedSelection || lastSelection;
    const hasHL = await hasHighlightOverlappingSelection(sel);
    if (revision !== selectionRevision) return;
    const built  = buildColorItems(hasHL);

    try {
      if (built.type === 'submenu') {
        await call('reader.addContextMenuItem', {
          id: 'marker-root',
          type: 'submenu',
          title: '\u05DE\u05E8\u05E7\u05E8',
          icon: 'highlight_24_regular',
          contexts: READER_SELECTION_CONTEXTS,
          children: built.children
        });
      } else {
        await call('reader.addContextMenuItem', {
          id: 'marker-root',
          type: 'color-row',
          title: '\u05DE\u05E8\u05E7\u05E8',
          contexts: READER_SELECTION_CONTEXTS,
          colors: built.colorItems
        });
      }
      menuRegistered = true;
      registeredMenuType = built.type;
    } catch (error) {
      menuRegistered = false;
      registeredMenuType = null;
      await unregisterContextMenuItems(true).catch(() => {});
      throw error;
    }
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
    } catch (_) {
      // Item may have been removed externally — rebuild from scratch
      menuRegistered = false;
      registeredMenuType = null;
      await registerContextMenuItems();
    }
  }

  // ── Selection helpers ──────────────────────────────────────────────────────
  function rememberSelection(data) {
    if (!hasUsableSelection(data)) return;
    const revision = ++selectionRevision;
    const sel = Object.assign({}, data, { rememberedAt: Date.now() });
    lastSelection  = sel;
    savedSelection = sel;
    lastEventSelection = {
      text: selectedTextOf(sel),
      currentIndex: sel.currentIndex ?? sel.sectionIndex ?? null
    };
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
  //                     + groupId (shared by the parts of a multi-line highlight)

  async function findPieceOccurrence(bookId, sectionIndex, piece, prefer) {
    try {
      const res = await call('reader.findTextOccurrences', {
        bookId,
        sectionIndex,
        query: piece,
        layer: 'source',
        normalize: { profile: 'search', overrides: { ignorePunctuation: true } },
        limit: 200
      });
      const results = res?.results || [];
      if (!results.length) return null;
      // First piece is a line suffix → prefer the last occurrence;
      // any other piece starts the line → prefer the first.
      return prefer === 'last' ? results[results.length - 1] : results[0];
    } catch (_) { return null; }
  }

  /**
   * Anchors each line of a multi-line selection in its own section, via
   * reader.findTextOccurrences (available since Otzaria 0.9.95).
   * Returns [{sectionIndex, range, text}] or null when unresolvable.
   */
  async function resolveMultiSectionTargets(selection) {
    const bookId = selection?.currentBookId || selection?.bookId;
    const clickedIndex = selection?.currentIndex ?? selection?.sectionIndex;
    const pieces = splitSelectionPieces(selectedTextOf(selection));
    if (!bookId || clickedIndex == null || pieces.length < 2) return null;

    const candidates = [];
    const hint = multiLineStartIndexHint(selection);
    if (hint != null) candidates.push(hint);
    // Without a hint the clicked line still lies somewhere within the span.
    for (let start = clickedIndex; start > clickedIndex - pieces.length; start--) {
      if (start >= 0 && !candidates.includes(start)) candidates.push(start);
    }
    for (const start of candidates) {
      const targets = [];
      let resolved = true;
      for (let k = 0; k < pieces.length; k++) {
        const prefer = k === 0 ? 'last' : 'first';
        const occurrence = await findPieceOccurrence(bookId, start + k, pieces[k], prefer);
        if (!occurrence?.range) { resolved = false; break; }
        targets.push({
          sectionIndex: start + k,
          range: occurrence.range,
          text: occurrence.text || pieces[k]
        });
      }
      if (resolved) return targets;
    }
    return null;
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

      const bookId       = selection.currentBookId || selection.bookId;
      const sectionIndex = selection.currentIndex  ?? selection.sectionIndex;

      // Single-line selection \u2192 one target; multi-line \u2192 anchor per section.
      // A multi-line selection never trusts sourceRange: the Host may return
      // a range covering only the first line, silently dropping the rest.
      const pieces = splitSelectionPieces(selectedTextOf(selection));
      const targets = pieces.length <= 1 && selection.sourceRange
        ? [{ sectionIndex, range: selection.sourceRange, text: selectedTextOf(selection) }]
        : await resolveMultiSectionTargets(selection);
      if (!targets) {
        await call('ui.showMessage', {
          message: '\u05DC\u05D0 \u05E0\u05D9\u05EA\u05DF \u05DC\u05E1\u05DE\u05DF \u05D0\u05EA \u05D4\u05D8\u05E7\u05E1\u05D8 \u05D4\u05E0\u05D1\u05D7\u05E8 \u2014 \u05D4\u05DE\u05D9\u05E7\u05D5\u05DD \u05D4\u05DE\u05D3\u05D5\u05D9\u05E7 \u05DC\u05D0 \u05D6\u05D5\u05D4\u05D4.\n\u05D9\u05D9\u05EA\u05DB\u05DF \u05E9\u05D4\u05DE\u05D9\u05DC\u05D4 \u05DE\u05D5\u05D7\u05DC\u05E4\u05EA \u05D1\u05EA\u05E6\u05D5\u05D2\u05D4. \u05E0\u05E1\u05D4 \u05DC\u05D1\u05D7\u05D5\u05E8 \u05D8\u05E7\u05E1\u05D8 \u05D0\u05D7\u05E8.'
        }).catch(() => {});
        await unregisterContextMenuItems();
        return;
      }

      // A color action on an already highlighted range is a replacement.
      // Keep the old records until every new target is stored successfully.
      const overlapping = highlightsOverlappingTargets(bookId, targets);

      const groupId = targets.length > 1
        ? makeHighlightId(bookId, targets[0].sectionIndex, `group-${color.id}`)
        : null;
      const applied = [];
      try {
        for (const target of targets) {
          const highlightId = makeHighlightId(bookId, target.sectionIndex, color.id);
          const hlRes = await callRaw('reader.setHighlight', {
            highlightId,
            bookId,
            sectionIndex: target.sectionIndex,
            range:    target.range,
            style:    buildHighlightStyle(color),
            metadata: { source: 'manual', tags: [color.label] }
          });
          if (!hlRes.success) throw new Error('setHighlight failed: ' + hlRes.error?.message);
          applied.push(highlightId);

          // Persist to plugin storage, including version + etag for future updates
          await saveHighlightMeta({
            highlightId,
            ...(groupId ? { groupId } : {}),
            bookId,
            sectionIndex: target.sectionIndex,
            colorId:     color.id,
            color:       color.hex,
            style:       buildHighlightStyle(color),
            text:        target.text,
            ref:         selection.currentRef  || '',
            book:        selection.currentBook || bookId,
            sourceRange: target.range,
            version:     hlRes.data?.version ?? null,
            etag:        hlRes.data?.etag    ?? null
          });
        }
      } catch (err) {
        // A partial multi-line highlight is misleading \u2014 roll back what landed.
        for (const highlightId of applied) {
          await call('reader.clearHighlight', { highlightId }).catch(() => {});
          await call('storage.remove', { key: highlightKey(highlightId) }).catch(() => {});
        }
        throw err;
      }

      for (const item of overlapping) {
        if (!item.highlightId) continue;
        try {
          await call('reader.clearHighlight', { highlightId: item.highlightId });
        } catch (error) {
          if (error?.code !== 'error.highlight_not_found') throw error;
        }
        await call('storage.remove', { key: item.key || highlightKey(item.highlightId) });
      }

      lastSelection  = null;
      savedSelection = null;
      await renderHighlightList();
      await unregisterContextMenuItems();
      await call('ui.showSuccess', { message: `\u05E0\u05E9\u05DE\u05E8 \u05D1${color.label} \u2713` }).catch(() => {});
    } catch (err) {
      logger.error('applyHighlight error:', err);
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
      } catch (err) { logger.warn('Failed loading highlight', key, err); }
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
      if (item.status === 'failed_to_anchor') continue;
      const color = getColorById(item.colorId);
      // SDK 1.1 uses the book title as reader bookId. Early experimental
      // builds stored the database id while keeping the title in `book`.
      // Normalize those records so existing marks become visible/openable too.
      const canonicalBookId = String(item.book || item.bookId || '');
      if (!canonicalBookId) continue;
      try {
        const res = await callRaw('reader.setHighlight', {
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
      } catch (error) {
        logger.warn('Failed reapplying highlight', item.highlightId, error);
      }
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
    enhanceSelect(colorSelect);
    syncEnhancedSelect(colorSelect);
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
        logger.error('Failed restoring deleted highlight', item.highlightId, err);
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
      try {
        await call('reader.clearHighlight', { highlightId: item.highlightId });
      } catch (error) {
        if (error?.code !== 'error.highlight_not_found') throw error;
      }
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
      catch (err) { failed++; logger.error('Failed updating highlight color', item.highlightId, err); }
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
      catch (err) { failed++; logger.error('Failed adding tags', item.highlightId, err); }
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
      } catch (err) { logger.error('Failed deleting selected highlight', item.highlightId, err); }
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
    await call('reader.clearAllHighlights', {});
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
          try {
            await call('reader.clearHighlight', { highlightId: item.highlightId });
          } catch (error) {
            if (error?.code !== 'error.highlight_not_found') throw error;
          }
        }
        await call('storage.remove', { key: item.key });
      }
      await renderHighlightList();
      await patchOrRebuildMenu();
      await call('ui.showSuccess', {
        message: matches.length > 1
          ? '\u05D4\u05E1\u05D9\u05DE\u05D5\u05DF \u05D4\u05D5\u05E1\u05E8 \u05DE\u05DB\u05DC \u05D4\u05E9\u05D5\u05E8\u05D5\u05EA'
          : '\u05D4\u05D4\u05D3\u05D2\u05E9\u05D4 \u05D4\u05D5\u05E1\u05E8\u05D4'
      }).catch(() => {});
    } catch (err) { logger.error(err); }
  }

  async function openHighlight(item) {
    try {
      const revealed = await call('reader.revealHighlight', {
        highlightId: item.highlightId
      });
      if (revealed === true) return;
    } catch (error) {
      // Compatibility with Otzaria versions from before revealHighlight.
      logger.warn('Precise highlight reveal unavailable; falling back', error?.code || error);
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
    syncAllEnhancedSelects();
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
    const loadMore = $('#loadMoreBtn');
    loadMore.hidden = !hasMore;
    loadMore.style.display = hasMore ? '' : 'none';
    updateBulkActions();
    if (!filtered.length) {
      const emptyTitle = allHighlights.length ? 'לא נמצאו תוצאות' : 'המרקר מוכן';
      const emptyMessage = allHighlights.length
        ? 'אין הדגשות שמתאימות לסינון הנוכחי. אפשר לשנות את החיפוש או לאפס את המסננים.'
        : 'סמנו טקסט בספר, לחצו לחיצה ימנית ובחרו צבע מתפריט מרקר.';
      list.innerHTML = `<div class="empty-state">
        <span class="empty-state-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none">
            <path d="M4 16.7 15.9 4.8a2.1 2.1 0 0 1 3 0l.3.3a2.1 2.1 0 0 1 0 3L7.3 20H4v-3.3Z" fill="currentColor"/>
            <path d="M4 21h16" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" opacity=".55"/>
          </svg>
        </span>
        <strong>${emptyTitle}</strong>
        <span>${emptyMessage}</span>
      </div>`;
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
      const colorMenu = settings.colors.map(option =>
        `<button type="button" class="highlight-color-option${option.id === h.colorId ? ' is-selected' : ''}" data-action="change-color" data-key="${escapeHtml(h.key)}" data-color-id="${escapeHtml(option.id)}" role="option" aria-selected="${option.id === h.colorId}"><span class="option-color-swatch" style="--option-color:${escapeHtml(toSafeHex(option.hex))}"></span><span>${escapeHtml(option.label)}</span>${option.id === h.colorId ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4 4L19 6"/></svg>' : ''}</button>`
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
          <details class="inline-color-picker">
            <summary aria-label="שנה צבע עבור ${escapeHtml(title)}"><span class="option-color-swatch" style="--option-color:${escapeHtml(toSafeHex(c.hex))}"></span><span>${escapeHtml(c.label)}</span><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 9 5 5 5-5"/></svg></summary>
            <div class="highlight-color-menu" role="listbox" aria-label="צבע ההדגשה">${colorMenu}</div>
          </details>
          <button class="small-btn" type="button" data-action="open" data-key="${escapeHtml(h.key)}" aria-label="פתח: ${escapeHtml(title)}"><svg class="btn-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h13M13 6l6 6-6 6"/></svg><span>פתח</span></button>
          <button class="small-btn" type="button" data-action="edit" data-key="${escapeHtml(h.key)}" aria-label="ערוך: ${escapeHtml(title)}"><svg class="btn-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m5 16 10.5-10.5a2.1 2.1 0 0 1 3 3L8 19H5v-3Z"/><path d="M4 21h16"/></svg><span>ערוך</span></button>
          <button class="small-btn danger-action" type="button" data-action="delete" data-key="${escapeHtml(h.key)}" aria-label="מחק: ${escapeHtml(title)}"><svg class="btn-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h14M10 11v6M14 11v6M7 7l1 13h8l1-13M9 7l1-3h4l1 3"/></svg><span>\u05DE\u05D7\u05E7</span></button>
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
      const safeHex = escapeHtml(toSafeHex(c.hex));
      const previewOpacity = Number.isFinite(Number(c.opacity)) ? Number(c.opacity) : .45;
      const previewRadius = Number.isFinite(Number(c.borderRadius)) ? Number(c.borderRadius) : 4;
      return `<div class="color-row" data-index="${i}" data-marker-mode="${escapeHtml(c.markerMode)}" style="--picked-color:${safeHex};--marker-preview-color:${hexToRgba(safeHex, previewOpacity)};--marker-radius:${previewRadius}px">
        <div class="color-row-main">
          <button type="button" class="drag-handle" title="שינוי סדר" aria-label="שינוי סדר של ${escapeHtml(c.label)}"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="9" cy="6" r="1.25"/><circle cx="15" cy="6" r="1.25"/><circle cx="9" cy="12" r="1.25"/><circle cx="15" cy="12" r="1.25"/><circle cx="9" cy="18" r="1.25"/><circle cx="15" cy="18" r="1.25"/></svg></button>
          <details class="color-picker-details">
            <summary class="color-picker-btn" title="בחירת גוון" aria-label="בחירת גוון עבור ${escapeHtml(c.label)}"><span class="color-swatch"></span><span class="color-picker-label">בחירת גוון</span><svg class="chevron-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m7 9 5 5 5-5"/></svg></summary>
            <div class="color-picker-popover">
              <span class="picker-popover-title">בחרו גוון</span>
              <div class="preset-swatches" role="listbox" aria-label="גוונים מוכנים">${COLOR_PALETTE.map(([hex, name]) => `<button type="button" class="preset-swatch${toSafeHex(c.hex) === hex ? ' is-selected' : ''}" data-action="preset" data-hex="${hex}" title="${name}" aria-label="${name}" aria-selected="${toSafeHex(c.hex) === hex}" style="--swatch:${hex}"></button>`).join('')}</div>
              <label class="hex-field">קוד HEX<div class="hex-input-row"><input type="text" value="${safeHex}" data-field="hex-display" inputmode="text" maxlength="7" spellcheck="false" /><button type="button" class="hex-picker-btn" data-action="browser-picker" title="פתיחת בוחר הצבעים של הדפדפן" aria-label="פתיחת בוחר הצבעים של הדפדפן"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.5a8.5 8.5 0 1 0 0 17h1.2a1.8 1.8 0 0 0 0-3.6h-.7a1.5 1.5 0 0 1 0-3h2.2A5.8 5.8 0 0 0 20.5 8 8.5 8.5 0 0 0 12 3.5Z"/><circle cx="8" cy="9" r="1"/><circle cx="11.5" cy="6.8" r="1"/><circle cx="15.5" cy="8" r="1"/></svg></button></div></label>
              <button type="button" class="apply-hex-btn" data-action="apply-hex">החלת הגוון</button>
            </div>
          </details>
        <input class="native-color" type="color" value="${safeHex}" data-field="hex" aria-label="\u05E6\u05D1\u05E2" tabindex="-1" />
          <label class="color-name-field"><span>שם הצבע</span><input type="text" value="${escapeHtml(c.label)}" data-field="label" aria-label="\u05E9\u05DD \u05E6\u05D1\u05E2" /></label>
          <div class="color-row-actions">
            <label class="color-switch-label" title="${c.enabled ? 'לחץ לכיבוי' : 'לחץ להפעלה'}">
              <input type="checkbox" data-field="enabled" ${c.enabled ? 'checked' : ''} />
              <span class="color-switch-copy"><strong>${c.enabled ? 'פעיל' : 'כבוי'}</strong>${badge}</span>
            </label>
            <div class="order-btns">
              <button type="button" data-action="up" ${i === 0 ? 'disabled' : ''} title="העבר למעלה" aria-label="העבר את ${escapeHtml(c.label)} למעלה"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 14 5-5 5 5"/></svg></button>
              <button type="button" data-action="down" ${i === settings.colors.length - 1 ? 'disabled' : ''} title="העבר למטה" aria-label="העבר את ${escapeHtml(c.label)} למטה"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 10 5 5 5-5"/></svg></button>
            </div>
            <button class="color-icon-btn danger-action" type="button" data-action="remove" ${settings.colors.length <= 1 ? 'disabled' : ''} title="מחק צבע" aria-label="מחק את ${escapeHtml(c.label)}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h14M10 11v6M14 11v6M7 7l1 13h8l1-13M9 7l1-3h4l1 3"/></svg></button>
          </div>
        </div>
        <div class="color-preview" aria-label="תצוגה מקדימה של ${escapeHtml(c.label)}">
          <span class="color-preview-label"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z"/><circle cx="12" cy="12" r="2.5"/></svg>תצוגה מקדימה</span>
          <span class="marker-preview">טקסט מסומן לדוגמה</span>
        </div>
        <details class="color-style-editor">
          <summary><span><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h10M18 7h2M4 17h2M10 17h10"/><circle cx="16" cy="7" r="2"/><circle cx="8" cy="17" r="2"/></svg>עריכת סגנון ההדגשה</span><small>סוג סימון, שקיפות ועיגול פינות</small></summary>
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
    enhanceSelects(editor);
    syncAllEnhancedSelects();

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
        logger.warn('Highlight list refresh failed', error);
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
      } catch (error) { failed++; logger.error('Global tag update failed', item.highlightId, error); }
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
      pluginVersion: PLUGIN_VERSION,
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
      item && isSafeHighlightId(item.highlightId) &&
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
      logger.error('Backup import failed', error);
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
      logger.error('Backup import failed', error);
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
          logger.error('Backup import rollback failed', rollbackError);
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

  function updateNewColorPreview() {
    const hex = toSafeHex($('#newColorHex')?.value);
    const opacity = Number($('#newColorOpacity')?.value || .45);
    const radius = Number($('#newColorRadius')?.value || 4);
    const mode = $('#newColorMarkerMode')?.value || 'text-background';
    const preview = $('#newColorPreview');
    if (!preview) return;
    preview.style.setProperty('--new-color', hex);
    preview.style.setProperty('--new-color-rgba', hexToRgba(hex, opacity));
    preview.style.setProperty('--new-color-radius', `${radius}px`);
    preview.dataset.markerMode = mode;
    const output = $('#newColorOpacityOutput');
    if (output) output.textContent = `${Math.round(opacity * 100)}%`;
    $('#newColorRadiusField')?.toggleAttribute('hidden', !['text-background', 'box'].includes(mode));
  }

  function openAddColorDialog() {
    const dialog = $('#addColorDialog');
    if (!dialog) return;
    $('#newColorLabel').value = 'גוון חדש';
    $('#newColorPicker').value = '#D8B4E2';
    $('#newColorHex').value = '#D8B4E2';
    $('#newColorMarkerMode').value = 'text-background';
    $('#newColorOpacity').value = '0.45';
    $('#newColorRadius').value = '4';
    syncEnhancedSelect($('#newColorMarkerMode'));
    updateNewColorPreview();
    if (!dialog.open) dialog.showModal();
    requestAnimationFrame(() => $('#newColorLabel')?.focus());
  }

  function bindUi() {
    if (uiBound) return;
    uiBound = true;
    enhanceSelects(document);

    document.addEventListener('click', e => {
      const option = e.target.closest('.otz-select-option');
      if (option) {
        const shell = option.closest('.otz-select');
        const select = shell?.previousElementSibling;
        if (!select?.matches?.('select')) return;
        select.value = option.dataset.selectValue;
        select.dispatchEvent(new Event('change', { bubbles: true }));
        syncEnhancedSelect(select);
        shell.open = false;
        return;
      }
      const trigger = e.target.closest('.otz-select-trigger');
      if (trigger) {
        const current = trigger.closest('.otz-select');
        $$('.otz-select[open]').forEach(menu => { if (menu !== current) menu.open = false; });
        return;
      }
      $$('.otz-select[open]').forEach(menu => {
        if (!menu.contains(e.target)) menu.open = false;
      });
    });
    document.addEventListener('change', e => {
      if (e.target.matches('select[data-otz-enhanced="true"]')) syncEnhancedSelect(e.target);
    });
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') $$('.otz-select[open]').forEach(menu => { menu.open = false; });
    });

    $$('.tab').forEach(btn => btn.addEventListener('click', async () => {
      $$('.tab').forEach(b => b.classList.toggle('active', b === btn));
      $$('.tab-panel').forEach(p => p.classList.toggle('active', p.dataset.panel === btn.dataset.tab));
      if (btn.dataset.tab === 'highlights') renderHighlightList().catch(logger.warn);
      if (btn.dataset.tab === 'colors' || btn.dataset.tab === 'settings') {
        await loadAllHighlights().catch(logger.warn);
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
      searchRenderTimer = setTimeout(() => resetListWindowAndRender().catch(logger.warn), 180);
    });
    $('#resetFiltersBtn').addEventListener('click', () => {
      $('#highlightSearch').value = '';
      $('#bookFilter').value = 'all';
      $('#colorFilter').value = 'all';
      $('#tagFilter').value = 'all';
      $('#statusFilter').value = 'all';
      $('#sortHighlights').value = 'newest';
      $('#groupHighlights').value = 'none';
      resetListWindowAndRender().catch(logger.warn);
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
      renderHighlightList().catch(logger.warn);
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
        logger.error('Failed editing highlight', err);
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
    });
    $('#highlightsList').addEventListener('click', async e => {
      const button = e.target.closest('button[data-action="change-color"]');
      if (!button) return;
      const item = allHighlights.find(h => h.key === button.dataset.key);
      const color = settings.colors.find(c => c.id === button.dataset.colorId);
        if (!item || !color || color.id === item.colorId) return;
      button.disabled = true;
        try {
          await updateHighlightColor(item, color);
          await call('ui.showSuccess', { message: `הצבע שונה ל${color.label}` }).catch(() => {});
        } catch (err) {
          logger.error('Failed updating highlight color', err);
          await call('ui.showError', { message: highlightUpdateErrorMessage(err) }).catch(() => {});
          await renderHighlightList();
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
        deleteSelectedHighlights().catch(logger.error);
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
          logger.error('Failed opening highlight', err);
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
      if (btn.dataset.action === 'preset') {
        const hex = toSafeHex(btn.dataset.hex);
        row.querySelector('[data-field="hex"]').value = hex;
        row.querySelector('[data-field="hex-display"]').value = hex;
        row.style.setProperty('--picked-color', hex);
        row.style.setProperty('--marker-preview-color', hexToRgba(hex, Number(row.querySelector('[data-field="opacity"]')?.value) || .45));
        settings = collectColorSettingsFromForm();
        scheduleAutoSave(settings, 'colorsAutoSaveStatus', 150);
        return;
      }
      if (btn.dataset.action === 'browser-picker') {
        const input = row.querySelector('input[type="color"]');
        if (input?.showPicker) input.showPicker();
        else input?.click();
        return;
      }
      if (btn.dataset.action === 'apply-hex') {
        const display = row.querySelector('[data-field="hex-display"]');
        const rawHex = String(display?.value || '').trim();
        if (!/^#[0-9A-F]{6}$/i.test(rawHex)) {
          display?.setCustomValidity('יש להזין קוד HEX תקין, לדוגמה #B7DDBB');
          display?.reportValidity();
          return;
        }
        const hex = rawHex.toUpperCase();
        display.setCustomValidity('');
        row.querySelector('[data-field="hex"]').value = hex;
        display.value = hex;
        row.style.setProperty('--picked-color', hex);
        row.style.setProperty('--marker-preview-color', hexToRgba(hex, Number(row.querySelector('[data-field="opacity"]')?.value) || .45));
        settings = collectColorSettingsFromForm();
        scheduleAutoSave(settings, 'colorsAutoSaveStatus', 150);
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
        row?.style.setProperty('--picked-color', e.target.value);
        row?.style.setProperty('--marker-preview-color', hexToRgba(e.target.value, Number(row.querySelector('[data-field="opacity"]')?.value) || .45));
        const hexDisplay = row?.querySelector('[data-field="hex-display"]');
        if (hexDisplay) hexDisplay.value = e.target.value.toUpperCase();
      }
      if (e.target.matches('[data-field="opacity"]')) {
        const row = e.target.closest('.color-row');
        row?.style.setProperty('--marker-preview-color', hexToRgba(row.querySelector('[data-field="hex"]')?.value, Number(e.target.value)));
        const output = e.target.closest('label')?.querySelector('output');
        if (output) output.textContent = `${Math.round(Number(e.target.value) * 100)}%`;
      }
      if (e.target.matches('[data-field="hex-display"]')) {
        const value = e.target.value.trim();
        if (/^#[0-9A-F]{6}$/i.test(value)) {
          const hiddenColor = e.target.closest('.color-row')?.querySelector('[data-field="hex"]');
          if (hiddenColor) hiddenColor.value = value;
          const row = e.target.closest('.color-row');
          row?.style.setProperty('--picked-color', value);
          row?.style.setProperty('--marker-preview-color', hexToRgba(value, Number(row.querySelector('[data-field="opacity"]')?.value) || .45));
        }
      }
      if (e.target.matches('[data-field="borderRadius"]')) {
        e.target.closest('.color-row')?.style.setProperty('--marker-radius', `${e.target.value}px`);
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
          settings = collectColorSettingsFromForm();
          renderSettings();
          call('ui.showMessage', {
            message: `ניתן להפעיל עד ${MAX_MENU_COLORS} צבעים בו-זמנית (${MAX_MENU_COLORS} הראשונים מופיעים בתפריט)`
          }).catch(() => {});
          return;
        }
      }
      settings = collectColorSettingsFromForm();
      scheduleAutoSave(settings, 'colorsAutoSaveStatus', 150);
      if (e.target.matches('[data-field="enabled"]')) renderSettings();
    });

    $('#addColorBtn').addEventListener('click', openAddColorDialog);
    $('#closeAddColorDialogBtn').addEventListener('click', () => $('#addColorDialog').close());
    $('#cancelAddColorBtn').addEventListener('click', () => $('#addColorDialog').close());
    $('#newColorPicker').addEventListener('input', e => {
      $('#newColorHex').value = e.target.value.toUpperCase();
      updateNewColorPreview();
    });
    $('#newColorHex').addEventListener('input', e => {
      const value = e.target.value.trim();
      if (/^#[0-9A-F]{6}$/i.test(value)) {
        $('#newColorPicker').value = value;
        e.target.setCustomValidity('');
        updateNewColorPreview();
      }
    });
    $('#newColorMarkerMode').addEventListener('change', updateNewColorPreview);
    $('#newColorOpacity').addEventListener('input', updateNewColorPreview);
    $('#newColorRadius').addEventListener('input', updateNewColorPreview);
    $('#addColorForm').addEventListener('submit', async e => {
      e.preventDefault();
      settings = collectColorSettingsFromForm();
      if (settings.colors.length >= MAX_COLORS) {
        await call('ui.showMessage', { message: `ניתן להוסיף עד ${MAX_COLORS} צבעים.` }).catch(() => {});
        return;
      }
      const rawHex = $('#newColorHex').value.trim();
      if (!/^#[0-9A-F]{6}$/i.test(rawHex)) {
        $('#newColorHex').setCustomValidity('יש להזין קוד HEX תקין, לדוגמה #D8B4E2');
        $('#newColorHex').reportValidity();
        return;
      }
      const label = $('#newColorLabel').value.trim();
      if (!label) {
        $('#newColorLabel').setCustomValidity('יש לתת שם לצבע');
        $('#newColorLabel').reportValidity();
        return;
      }
      $('#newColorLabel').setCustomValidity('');
      settings.colors.push({
        id: `custom-${Date.now()}`,
        hex: rawHex.toUpperCase(),
        label,
        enabled: enabledColors().length < MAX_MENU_COLORS,
        markerMode: $('#newColorMarkerMode').value,
        opacity: Number($('#newColorOpacity').value),
        borderRadius: Number($('#newColorRadius').value)
      });
      settings = normalizeSettings(settings);
      $('#addColorDialog').close();
      await saveSettings(settings);
      await call('ui.showSuccess', { message: `הצבע "${label}" נוסף` }).catch(() => {});
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
      await saveSettings(settings);
      await call('ui.showSuccess', { message: 'הצבעים אופסו לברירת המחדל' }).catch(() => {});
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

    $('#resetPreferencesBtn').addEventListener('click', async () => {
      settings = normalizeSettings(Object.assign({}, settings, {
        menuStyle: DEFAULT_SETTINGS.menuStyle,
        appearance: structuredCloneSafe(DEFAULT_SETTINGS.appearance)
      }));
      await saveSettings(settings);
      applyDisplaySettings();
      await call('ui.showSuccess', { message: 'התצוגה אופסה לברירת המחדל' }).catch(() => {});
    });

    $('#renameTagBtn').addEventListener('click', () => transformGlobalTag('rename'));
    $('#mergeTagBtn').addEventListener('click', () => transformGlobalTag('merge'));
    $('#deleteTagBtn').addEventListener('click', () => transformGlobalTag('delete'));
    $('#exportVisibleHumanBtn').addEventListener('click', async () => {
      try { await exportVisibleHumanReadable(); }
      catch (error) {
        logger.error('Human-readable export failed', error);
        await call('ui.showError', { message: 'ייצוא ההדגשות נכשל' }).catch(() => {});
      }
    });

    $('#exportBackupBtn').addEventListener('click', async () => {
      try {
        await exportBackup();
      } catch (error) {
        logger.error('Backup export failed', error);
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
  const on = (eventName, handler) => Otzaria.on(eventName, protectEvent(eventName, handler, logger));

  on('plugin.boot', async payload => {
    try {
      hostContext = normalizeBootContext(payload);
      runMode = hostContext.runMode;
      runtimeOwner = ownsLegacyRuntime(hostContext, payload?.permissions);
      await loadSettings();
      if (isForeground()) {
        applyHostMetadata(hostContext);
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
          .catch(logger.warn);
      }
    } catch (err) { logger.error(err); }
  });

  on('theme.changed', theme => {
    if (isForeground()) {
      applyTheme(theme);
      applyDisplaySettings();
    }
  });

  on('plugin.permissions_changed', async data => {
    if (!isForeground()) return;
    const wasOwner = runtimeOwner;
    const willOwnRuntime = ownsLegacyRuntime(hostContext, data?.permissions);
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
  on('reader.selection_changed', async data => {
    if (!runtimeOwner) return;
    if (!hasUsableSelection(data)) {
      selectionRevision++;
      lastSelection = null;
      savedSelection = null;
      lastEventSelection = null;
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
  // נרשם דרך משתנה כי ה-validator עדיין לא מכיר events אלו
  const _cmColor   = 'contextMenu.colorClicked';
  const _cmItem    = 'contextMenu.itemClicked';
  const _suspended = 'plugin.suspended';
  const _resumed   = 'plugin.resumed';

  on(_cmColor, data => {
    if (runtimeOwner) return onColorClicked(data);
  });
  on(_cmItem, data => {
    if (runtimeOwner) return onStandardMenuClick(data);
  });

  // Source content changed: re-anchor highlights for affected sections
  on('reader.sectionContentChanged', async change => {
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

  on('reader.current_ref_changed', async () => {
    if (!runtimeOwner) return;
    selectionRevision++;
    lastSelection = null;
    // Give the context-menu click event 3 s to arrive before clearing savedSelection
    setTimeout(() => { savedSelection = null; }, 3000);
    await unregisterContextMenuItems();
  });

  on('navigation.changed', async () => {
    if (!runtimeOwner) return;
    selectionRevision++;
    lastSelection  = null;
    savedSelection = null;
    await unregisterContextMenuItems();
  });

  on(_suspended, () => {
    if (isForeground()) {
      stopUiRefresh();
      return;
    }
    if (!runtimeOwner) return;
    window.clearTimeout(selectionTimer);
    selectionTimer = null;
    savedSelection = null;
  });

  on(_resumed, () => {
    if (isForeground()) {
      renderHighlightList().catch(logger.warn);
      startUiRefresh();
      return;
    }
    if (!runtimeOwner) return;
    if (lastSelection && Date.now() - lastSelection.rememberedAt > 45_000) {
      lastSelection = null;
    }
  });

})();
