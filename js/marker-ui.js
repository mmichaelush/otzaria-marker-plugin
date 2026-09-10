(function (global) {
  'use strict';

  /**
   * The plugin page.
   *
   * This file owns the DOM and nothing else: every read or write of plugin
   * state goes through `MarkerCore`, and every host call goes through
   * `MarkerRuntime`.
   */

  const D = global.MarkerDomain;
  const R = global.MarkerRuntime;
  const I18n = global.MarkerI18n;
  const Core = global.MarkerCore;
  const RichText = global.MarkerRichText;
  const { callSoft, notify } = R;
  const logger = R.createLogger('ui');
  const t = (text, vars) => I18n.t(text, vars);

  const $ = (selector, scope = document) => scope.querySelector(selector);
  const $$ = (selector, scope = document) => [...scope.querySelectorAll(selector)];
  const escapeHtml = D.escapeHtml;

  const COLOR_PRESETS = Object.freeze([
    ['#B7DDBB', 'מרווה'], ['#FFD08A', 'משמש'], ['#FFE27A', 'זהב'],
    ['#FFF3A6', 'לימון'], ['#B8D8F0', 'שמיים'], ['#D8B4E2', 'לבנדר'],
    ['#F3B6C8', 'ורוד'], ['#C9C2F5', 'סגלגל']
  ]);
  const UNDO_WINDOW_MS = 30_000;

  // ── Session state (view-only) ──────────────────────────────────────────────

  let draftSettings = null;             // form state before it is committed
  let renderedLimit = D.HIGHLIGHTS_PAGE_SIZE;
  let visibleKeys = [];
  const selectedKeys = new Set();
  let editingKey = null;
  let editReturnFocus = null;
  let editor = null;                    // the rich note editor, created lazily
  let currentBookFilter = null;         // { bookId, title } for the quick chip
  let pendingEditId = null;             // an edit request that arrived before boot
  let pendingDeleted = [];
  let undoTimer = null;
  let searchTimer = null;
  let lastRenderSignature = null;
  let enhancedSelectCounter = 0;
  const autoSaveTimers = new Map();
  const autoSaveRevisions = new Map();

  function settings() {
    return draftSettings || Core.settings;
  }

  function colorLabelOf(colorId) {
    return colorDisplayLabel(D.findColor(Core.settings, colorId));
  }

  /**
   * The label to *show* for a color.
   *
   * The built-in colors are stored with their Hebrew labels, because that
   * string is also the catalog key — so they translate like any other source
   * string, while a name the user typed passes through untouched. The colors
   * editor deliberately does not use this: the field there edits the stored
   * value, and showing a translation in it would save the translation.
   */
  function colorDisplayLabel(color) {
    return t(color?.label || '');
  }

  // ── Theme ──────────────────────────────────────────────────────────────────

  function applyTheme(theme) {
    if (!theme?.colorScheme) return;
    const cs = theme.colorScheme;
    const root = document.documentElement;
    const set = (name, value) => { if (value) root.style.setProperty(name, value); };
    set('--color-primary', cs.primary);
    set('--color-on-primary', cs.onPrimary);
    set('--color-primary-container', cs.primaryContainer || D.hexToRgba(cs.primary, 0.12));
    set('--color-on-primary-container', cs.onPrimaryContainer || cs.primary);
    set('--color-secondary', cs.secondary);
    set('--color-on-secondary', cs.onSecondary);
    set('--color-secondary-container', cs.secondaryContainer);
    set('--color-on-secondary-container', cs.onSecondaryContainer);
    set('--color-surface', cs.surface);
    set('--color-on-surface', cs.onSurface);
    set('--color-on-surface-variant', cs.onSurfaceVariant);
    set('--color-surface-container-lowest', cs.surfaceContainerLowest || cs.surface);
    set('--color-surface-container-low', cs.surfaceContainerLow || cs.surfaceContainer || cs.surface);
    set('--color-surface-container', cs.surfaceContainer || cs.surfaceContainerLow || cs.surface);
    set('--color-surface-container-high', cs.surfaceContainerHigh || cs.surfaceContainerHighest);
    set('--color-surface-container-highest', cs.surfaceContainerHighest);
    set('--color-error', cs.error);
    set('--color-on-error', cs.onError);
    set('--color-error-container', cs.errorContainer);
    set('--color-on-error-container', cs.onErrorContainer);
    set('--color-outline', cs.outline);
    set('--color-outline-variant', cs.outlineVariant);
    set('--color-scrim', cs.scrim || '#000000');
    root.style.setProperty('--color-primary-subtle', D.hexToRgba(cs.primary, 0.12));
    root.style.setProperty('--color-secondary-subtle', D.hexToRgba(cs.secondary, 0.10));
    if (theme.typography?.fontFamily) {
      const appFont = `'${theme.typography.fontFamily}', 'David', 'Noto Serif Hebrew', serif`;
      root.style.setProperty('--font-app', appFont);
      root.style.setProperty('--font-main', appFont);
      root.style.setProperty('--font-size-base', `${theme.typography.fontSize}px`);
      root.style.setProperty('--line-height', String(theme.typography.lineHeight));
    }
    document.body.classList.toggle('dark-mode', theme.mode === 'dark');
  }

  function applyDisplaySettings() {
    const appearance = settings().appearance;
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
    const root = document.documentElement;
    root.style.setProperty('--font-main', fontMap[appearance.fontFamily] || 'var(--font-app)');
    root.style.setProperty('--highlight-font-size', `${appearance.fontSize}px`);
    root.style.setProperty('--highlight-line-height', String(appearance.lineHeight));
    const list = $('#highlightsList');
    if (list) list.dataset.view = appearance.viewMode;
  }

  // ── Custom select ──────────────────────────────────────────────────────────
  // The native <select> stays the source of truth for value and change events;
  // `.otz-select` is only a skin over it, so filtering and saving keep working
  // exactly as they would with a plain select.

  function swatchFor(value) {
    const color = Core.settings.colors.find(entry => entry.id === value);
    return color ? D.toSafeHex(color.hex) : '';
  }

  function optionHtml(select, option) {
    const color = swatchFor(option.value);
    const selected = option.value === select.value;
    return `<button type="button" class="otz-select-option${selected ? ' is-selected' : ''}" data-select-value="${escapeHtml(option.value)}" role="option" aria-selected="${selected}"${option.disabled ? ' disabled' : ''}>`
      + (color
        ? `<span class="option-color-swatch" style="--option-color:${escapeHtml(color)}"></span>`
        : '<span class="otz-option-spacer" aria-hidden="true"></span>')
      + `<span class="otz-option-label">${escapeHtml(option.textContent || '')}</span>`
      + (selected ? '<svg class="otz-option-check" viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4 4L19 6"/></svg>' : '')
      + '</button>';
  }

  function syncEnhancedSelect(select) {
    const shell = select?._otzSelectShell;
    if (!shell?.isConnected) return;
    const selected = select.options[select.selectedIndex] || select.options[0];
    const color = selected ? swatchFor(selected.value) : '';
    const trigger = shell.querySelector('.otz-select-trigger');
    const label = trigger?.querySelector('.otz-select-value');
    const swatch = trigger?.querySelector('.option-color-swatch');
    if (label) label.textContent = selected?.textContent || t('בחירה');
    if (swatch) {
      swatch.hidden = !color;
      if (color) swatch.style.setProperty('--option-color', color);
    }
    shell.querySelector('.otz-select-menu').innerHTML =
      [...select.options].map(option => optionHtml(select, option)).join('');
    shell.classList.toggle('is-disabled', select.disabled);
    trigger?.setAttribute('aria-disabled', String(select.disabled));
  }

  function enhanceSelect(select) {
    if (!select) return;
    if (select.dataset.otzEnhanced === 'true') {
      syncEnhancedSelect(select);
      return;
    }
    select.dataset.otzEnhanced = 'true';
    select.classList.add('otz-native-select');
    const shell = document.createElement('details');
    shell.className = 'otz-select';
    shell.dataset.selectId = select.id || `otz-select-${++enhancedSelectCounter}`;
    shell.innerHTML = '<summary class="otz-select-trigger"><span class="option-color-swatch" hidden></span>'
      + '<span class="otz-select-value"></span>'
      + '<svg class="otz-select-chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="m7 9 5 5 5-5"/></svg></summary>'
      + '<div class="otz-select-menu" role="listbox"></div>';
    // The native `<select>` is visually hidden but still focusable and
    // operable, so it remains the accessible control. The shell mirrors it,
    // which makes a second tab stop and a duplicate announcement — hide it
    // from assistive tech and take it out of the tab order. The focus ring
    // moves to the visible trigger in CSS.
    shell.setAttribute('aria-hidden', 'true');
    shell.querySelector('summary').tabIndex = -1;
    select.insertAdjacentElement('afterend', shell);
    select._otzSelectShell = shell;
    syncEnhancedSelect(select);
  }

  function enhanceSelects(scope = document) {
    $$('select', scope).forEach(enhanceSelect);
  }

  function syncAllEnhancedSelects() {
    $$('select[data-otz-enhanced="true"]').forEach(syncEnhancedSelect);
  }

  // ── Auto-save ──────────────────────────────────────────────────────────────

  /**
   * Debounced settings write, with a per-status revision guard so a slow
   * earlier save can never report over a newer one.
   *
   * `collect` is a **function**, called when the timer fires rather than
   * when it is set. That matters because a settings object is whole: the two
   * forms auto-save independently, and a snapshot taken on the Settings tab
   * carries a copy of the colors as they were at that moment. Saved a moment
   * later, it would put them back — silently undoing a color the user changed
   * in between. Collecting at flush time means each form writes its own
   * fields onto whatever the committed state is by then.
   */
  function scheduleAutoSave(collect, statusId, delay = 450) {
    const revision = (autoSaveRevisions.get(statusId) || 0) + 1;
    autoSaveRevisions.set(statusId, revision);
    clearTimeout(autoSaveTimers.get(statusId));

    const status = $(`#${statusId}`);
    if (status) {
      status.hidden = false;
      status.dataset.state = 'saving';
      status.textContent = t('שומר…');
    }
    autoSaveTimers.set(statusId, setTimeout(async () => {
      try {
        const payload = collect();
        // `normalizeSettings(null)` returns the defaults, so a nullish payload
        // would quietly overwrite every setting the user has.
        if (!payload || typeof payload !== 'object') {
          logger.error('Refusing to auto-save an empty settings payload', { statusId });
          return;
        }
        await Core.saveSettings(payload);
        // Only the newest save may drop the draft: an older one finishing late
        // would discard edits the user made while it was in flight.
        if (revision !== autoSaveRevisions.get(statusId)) return;
        draftSettings = null;
        if (!status) return;
        status.dataset.state = 'saved';
        status.textContent = t('נשמר אוטומטית ✓');
      } catch (error) {
        logger.error('Automatic settings save failed', error);
        if (revision !== autoSaveRevisions.get(statusId) || !status) return;
        status.dataset.state = 'error';
        status.textContent = t('השמירה נכשלה');
      }
    }, delay));
  }

  // ── Dates ──────────────────────────────────────────────────────────────────

  function toGematria(value) {
    const numbers = [400, 300, 200, 100, 90, 80, 70, 60, 50, 40, 30, 20, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1];
    const letters = ['ת', 'ש', 'ר', 'ק', 'צ', 'פ', 'ע', 'ס', 'נ', 'מ', 'ל', 'כ', 'י', 'ט', 'ח', 'ז', 'ו', 'ה', 'ד', 'ג', 'ב', 'א'];
    let remaining = value;
    let out = '';
    for (let index = 0; index < numbers.length; index++) {
      while (remaining >= numbers[index]) {
        out += letters[index];
        remaining -= numbers[index];
      }
    }
    return out.replace('יה', 'טו').replace('יו', 'טז');
  }

  /** Hebrew date in Hebrew, a plain locale date in any other language. */
  function formatDate(timestamp) {
    if (!timestamp) return '';
    const date = new Date(timestamp);
    if (I18n.language !== 'he') {
      try {
        return new Intl.DateTimeFormat(I18n.language, { dateStyle: 'medium' }).format(date);
      } catch { return date.toISOString().slice(0, 10); }
    }
    const days = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];
    const dayName = days[date.getDay()];
    try {
      const parts = new Intl.DateTimeFormat('he-IL-u-ca-hebrew', { day: 'numeric', month: 'long', year: 'numeric' })
        .formatToParts(date);
      const day = parseInt(parts.find(part => part.type === 'day')?.value || '0', 10);
      const month = parts.find(part => part.type === 'month')?.value || '';
      const year = parseInt(parts.find(part => part.type === 'year')?.value || '0', 10);
      const shortYear = year > 1000 ? year % 1000 : year;
      const gregorian = date.toLocaleDateString('he-IL', { day: 'numeric', month: 'numeric', year: 'numeric' });
      return `יום ${dayName} ${toGematria(day)} ${month} ${toGematria(shortYear)} (${gregorian})`;
    } catch {
      return `יום ${dayName} ${date.toLocaleDateString('he-IL')}`;
    }
  }

  // ── Highlight list ─────────────────────────────────────────────────────────

  function currentFilters() {
    return {
      query: $('#highlightSearch').value,
      bookId: $('#bookFilter').value,
      colorId: $('#colorFilter').value,
      tag: $('#tagFilter').value,
      status: $('#statusFilter').value
    };
  }

  function renderFilters() {
    const all = Core.getHighlights();
    const bookFilter = $('#bookFilter');
    const colorFilter = $('#colorFilter');
    const tagFilter = $('#tagFilter');
    const bulkColor = $('#bulkColor');
    const previous = {
      book: bookFilter.value || 'all',
      color: colorFilter.value || 'all',
      tag: tagFilter.value || 'all',
      bulk: bulkColor.value
    };

    const books = [...new Map(all.map(item => [item.bookId, item.book || item.bookId])).entries()]
      .sort((a, b) => D.hebrewCompare(a[1], b[1]));
    bookFilter.innerHTML = `<option value="all">${escapeHtml(t('כל הספרים'))}</option>`
      + books.map(([id, title]) => `<option value="${escapeHtml(id)}">${escapeHtml(title)}</option>`).join('');
    colorFilter.innerHTML = `<option value="all">${escapeHtml(t('כל הצבעים'))}</option>`
      + Core.settings.colors.map(color =>
        `<option value="${escapeHtml(color.id)}">${escapeHtml(colorDisplayLabel(color))}</option>`).join('');
    const tags = [...new Set(all.flatMap(item => item.tags))].sort(D.hebrewCompare);
    tagFilter.innerHTML = `<option value="all">${escapeHtml(t('כל התגיות'))}</option>`
      + tags.map(tag => `<option value="${escapeHtml(tag)}">${escapeHtml(tag)}</option>`).join('');
    bulkColor.innerHTML = D.enabledColors(Core.settings).map(color =>
      `<option value="${escapeHtml(color.id)}">${escapeHtml(colorDisplayLabel(color))}</option>`).join('');

    const restore = (select, value) => {
      if ([...select.options].some(option => option.value === value)) select.value = value;
    };
    restore(bookFilter, previous.book);
    restore(colorFilter, previous.color);
    restore(tagFilter, previous.tag);
    restore(bulkColor, previous.bulk);
    syncAllEnhancedSelects();
  }

  function updateBulkActions() {
    const existing = new Set(Core.getHighlights().map(item => item.key));
    for (const key of [...selectedKeys]) if (!existing.has(key)) selectedKeys.delete(key);
    $('#bulkActions').hidden = selectedKeys.size === 0;
    $('#selectedCount').textContent = t('{count} נבחרו', { count: selectedKeys.size });
  }

  /**
   * The note block for a card.
   *
   * **This is the security boundary for note content.** Stored markup can come
   * from an imported backup this plugin never wrote, so it is sanitized here,
   * on the way out, every single time — never trusted because it was
   * sanitized once on the way in.
   */
  /**
   * Sanitized note markup, memoized by its exact input.
   *
   * The boundary above is unchanged — nothing is trusted because it was
   * sanitized once on the way in — but `sanitize` builds a whole inert
   * document per call, and a list of several hundred cards re-renders on
   * every keystroke in the search box. Keyed by the raw string, so an edited
   * note always gets a fresh pass; cleared wholesale rather than evicted one
   * by one, because the cost of a rebuild is one render.
   */
  const sanitizedNotes = new Map();
  const MAX_SANITIZED_NOTES = 500;

  function sanitizedNote(html) {
    if (sanitizedNotes.has(html)) return sanitizedNotes.get(html);
    const safe = RichText.sanitize(html);
    if (sanitizedNotes.size >= MAX_SANITIZED_NOTES) sanitizedNotes.clear();
    sanitizedNotes.set(html, safe);
    return safe;
  }

  function noteMarkup(item) {
    if (item.noteHtml) {
      const safe = sanitizedNote(item.noteHtml);
      if (safe) return `<div class="highlight-note is-rich">${safe}</div>`;
    }
    return item.note ? `<div class="highlight-note">${escapeHtml(item.note)}</div>` : '';
  }

  function highlightCardHtml(item) {
    const color = D.findColor(Core.settings, item.colorId);
    const title = `${item.book || item.bookId}${item.ref ? ' · ' + item.ref : ''}`;
    const text = (item.text || '').trim();
    const short = text.length > 90 ? `${text.slice(0, 90)}…` : text;
    const stale = D.isStale(item);
    const colorMenu = Core.settings.colors.map(option => {
      const selected = option.id === item.colorId;
      return `<button type="button" class="highlight-color-option${selected ? ' is-selected' : ''}" data-action="change-color" data-key="${escapeHtml(item.key)}" data-color-id="${escapeHtml(option.id)}" role="option" aria-selected="${selected}"><span class="option-color-swatch" style="--option-color:${escapeHtml(D.toSafeHex(option.hex))}"></span><span>${escapeHtml(colorDisplayLabel(option))}</span>${selected ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4 4L19 6"/></svg>' : ''}</button>`;
    }).join('');
    const label = `${title}. ${short || t('שורה מסומנת')}`;

    return `<article class="highlight-card fade-in"${stale ? ' data-stale="true"' : ''} data-key="${escapeHtml(item.key)}" tabindex="0" aria-label="${escapeHtml(label)}">
      <input class="highlight-select" type="checkbox" data-key="${escapeHtml(item.key)}" aria-label="${escapeHtml(t('בחר: {name}', { name: label }))}"${selectedKeys.has(item.key) ? ' checked' : ''} />
      <span class="dot" style="background:${escapeHtml(D.toSafeHex(color.hex))};box-shadow:0 0 0 7px ${escapeHtml(D.hexToRgba(color.hex, 0.22))}">
        <svg class="marker-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M4 16.7 15.9 4.8a2.1 2.1 0 0 1 3 0l.3.3a2.1 2.1 0 0 1 0 3L7.3 20H4v-3.3Z" fill="currentColor"/>
          <path d="M13.8 6.9 17.1 10.2" stroke="rgba(0,0,0,0.35)" stroke-width="1.5" stroke-linecap="round"/>
        </svg>
      </span>
      <div class="highlight-body">
        <div class="highlight-title">${item.favorite ? `<span class="favorite-badge" title="${escapeHtml(t('מועדפת'))}" aria-label="${escapeHtml(t('מועדפת'))}">★</span>` : ''}${escapeHtml(title)}${stale ? `<span class="stale-badge" title="${escapeHtml(t('העוגן שובש'))}">⚠️</span>` : ''}</div>
        <div class="highlight-text">${escapeHtml(short || t('שורה מסומנת'))}</div>
        ${noteMarkup(item)}
        ${item.tags.length ? `<div class="highlight-tags">${item.tags.map(tag => `<span class="tag-chip">${escapeHtml(tag)}</span>`).join('')}</div>` : ''}
        <div class="highlight-meta">${escapeHtml(colorDisplayLabel(color))}${item.timestamp ? ' · ' + escapeHtml(formatDate(item.timestamp)) : ''}</div>
      </div>
      <div class="row-actions">
        <details class="inline-color-picker">
          <summary aria-label="${escapeHtml(t('שנה צבע עבור {name}', { name: title }))}"><span class="option-color-swatch" style="--option-color:${escapeHtml(D.toSafeHex(color.hex))}"></span><span>${escapeHtml(colorDisplayLabel(color))}</span><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 9 5 5 5-5"/></svg></summary>
          <div class="highlight-color-menu" role="listbox" aria-label="${escapeHtml(t('צבע ההדגשה'))}">${colorMenu}</div>
        </details>
        <button class="small-btn" type="button" data-action="open" data-key="${escapeHtml(item.key)}" aria-label="${escapeHtml(t('פתח: {name}', { name: title }))}"><svg class="btn-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h13M13 6l6 6-6 6"/></svg><span>${escapeHtml(t('פתח'))}</span></button>
        <button class="small-btn" type="button" data-action="edit" data-key="${escapeHtml(item.key)}" aria-label="${escapeHtml(t('ערוך: {name}', { name: title }))}"><svg class="btn-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m5 16 10.5-10.5a2.1 2.1 0 0 1 3 3L8 19H5v-3Z"/><path d="M4 21h16"/></svg><span>${escapeHtml(t('ערוך'))}</span></button>
        <button class="small-btn" type="button" data-action="copy" data-key="${escapeHtml(item.key)}" aria-label="${escapeHtml(t('העתק: {name}', { name: title }))}"><svg class="btn-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 9h10v11H9z"/><path d="M15 9V5H5v11h4"/></svg><span>${escapeHtml(t('העתק'))}</span></button>
        <button class="small-btn danger-action" type="button" data-action="delete" data-key="${escapeHtml(item.key)}" aria-label="${escapeHtml(t('מחק: {name}', { name: title }))}"><svg class="btn-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h14M10 11v6M14 11v6M7 7l1 13h8l1-13M9 7l1-3h4l1 3"/></svg><span>${escapeHtml(t('מחק'))}</span></button>
      </div>
    </article>`;
  }

  function groupLabelOf(item, mode, activeTag) {
    switch (mode) {
      case 'book': return item.book || item.bookId || t('ללא ספר');
      case 'color': return colorLabelOf(item.colorId);
      case 'tag': return activeTag !== 'all' ? activeTag : (item.tags[0] || t('ללא תגית'));
      case 'date': return item.timestamp ? formatDate(item.timestamp) : t('ללא תאריך');
      default: return '';
    }
  }

  /**
   * The quick-filter strip: one chip per useful cut of the data, each showing
   * its count. A chip with a count of zero is not rendered — an affordance
   * that leads to an empty list is worse than no affordance.
   */
  function renderSummaryStrip() {
    const strip = $('#summaryStrip');
    const filters = currentFilters();
    // The chips count within the search, not around it. Each chip is an
    // alternative *cut* of the data, so the other chips' own filters are left
    // out — but a chip promising 40 results while the search shows 2 is
    // simply wrong, and clicking it lands on an empty list.
    const all = D.filterHighlights(Core.getHighlights(), { query: filters.query }, colorLabelOf);
    const stats = D.summarize(all);
    if (!all.length) {
      strip.innerHTML = '';
      strip.hidden = true;
      return;
    }
    strip.hidden = false;

    const chip = (key, value, label, count, active) => count
      ? `<button type="button" class="summary-chip${active ? ' is-active' : ''}" data-chip="${key}" data-value="${escapeHtml(value)}" aria-pressed="${active}"><span>${escapeHtml(label)}</span><b>${count}</b></button>`
      : '';

    const chips = [
      chip('status', 'all', t('הכול'), stats.total, filters.status === 'all'
        && filters.bookId === 'all' && filters.colorId === 'all' && filters.tag === 'all'),
      currentBookFilter
        ? chip('book', currentBookFilter.bookId, t('בספר הפתוח'),
          all.filter(item => item.bookId === currentBookFilter.bookId).length,
          filters.bookId === currentBookFilter.bookId)
        : '',
      chip('status', 'favorites', t('מועדפות'), stats.favorites, filters.status === 'favorites'),
      chip('status', 'noted', t('עם הערה'), stats.noted, filters.status === 'noted'),
      chip('status', 'tagged', t('עם תגית'), stats.tagged, filters.status === 'tagged'),
      chip('status', 'stale', t('דורשות תיקון'), stats.stale, filters.status === 'stale'),
      ...Core.settings.colors.map(color =>
        chip('color', color.id, colorDisplayLabel(color), stats.byColor.get(color.id) || 0,
          filters.colorId === color.id))
    ];
    strip.innerHTML = chips.filter(Boolean).join('');
  }

  /** Every chip toggles: clicking the active one goes back to showing all. */
  function applyChip(key, value) {
    const toggle = (id, next) => {
      const select = $(id);
      select.value = select.value === next ? 'all' : next;
    };
    if (key === 'status') {
      if (value === 'all') {
        // "All" is a reset, not a filter — it clears the search too, or the
        // count on the chip would not match what the list then shows.
        $('#highlightSearch').value = '';
        for (const id of ['#bookFilter', '#colorFilter', '#tagFilter', '#statusFilter']) {
          $(id).value = 'all';
        }
      } else {
        toggle('#statusFilter', value);
      }
    }
    if (key === 'color') toggle('#colorFilter', value);
    if (key === 'book') toggle('#bookFilter', value);
    syncAllEnhancedSelects();
    resetListWindow();
  }

  function renderHighlights() {
    const all = Core.getHighlights();
    applyDisplaySettings();
    renderFilters();
    renderSummaryStrip();

    const filters = currentFilters();
    const filtered = D.sortHighlights(
      D.filterHighlights(all, filters, colorLabelOf),
      $('#sortHighlights').value,
      colorLabelOf
    );
    visibleKeys = filtered.map(item => item.key);
    const displayed = filtered.slice(0, renderedLimit);
    const hasMore = displayed.length < filtered.length;

    $('#resultsCount').textContent = hasMore
      ? t('מוצגות {shown} מתוך {matching} · סך הכול {total}', {
        shown: displayed.length, matching: filtered.length, total: all.length
      })
      : t('{matching} מתוך {total} הדגשות', { matching: filtered.length, total: all.length });
    $('#loadMoreBtn').hidden = !hasMore;
    updateBulkActions();

    const list = $('#highlightsList');
    if (!filtered.length) {
      list.innerHTML = `<div class="empty-state">
        <span class="empty-state-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none">
            <path d="M4 16.7 15.9 4.8a2.1 2.1 0 0 1 3 0l.3.3a2.1 2.1 0 0 1 0 3L7.3 20H4v-3.3Z" fill="currentColor"/>
            <path d="M4 21h16" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" opacity=".55"/>
          </svg>
        </span>
        <strong>${escapeHtml(all.length ? t('לא נמצאו תוצאות') : t('המרקר מוכן'))}</strong>
        <span>${escapeHtml(all.length
          ? t('אין הדגשות שמתאימות לסינון הנוכחי. אפשר לשנות את החיפוש או לאפס את המסננים.')
          : t('סמנו טקסט בספר, לחצו לחיצה ימנית ובחרו צבע מתפריט מרקר.'))}</span>
      </div>`;
      return;
    }

    const groupMode = $('#groupHighlights').value;
    if (groupMode === 'none') {
      list.innerHTML = displayed.map(highlightCardHtml).join('');
      return;
    }
    const groups = new Map();
    for (const item of displayed) {
      const label = groupLabelOf(item, groupMode, filters.tag);
      if (!groups.has(label)) groups.set(label, []);
      groups.get(label).push(item);
    }
    list.innerHTML = [...groups.entries()].map(([label, items]) =>
      `<h2 class="highlight-group-title">${escapeHtml(label)} · ${items.length}</h2>${items.map(highlightCardHtml).join('')}`
    ).join('');
  }

  function resetListWindow() {
    renderedLimit = D.HIGHLIGHTS_PAGE_SIZE;
    renderHighlights();
  }

  // ── Printing ───────────────────────────────────────────────────────────────

  /**
   * `ui.print` and `ui.exportPdf` render this very page, so what ends up on
   * paper is whatever `@media print` leaves visible. Everything currently
   * matching the filters is rendered first — printing page 1 of a paged list
   * would silently drop the rest.
   */
  function preparePrintView() {
    renderedLimit = Number.MAX_SAFE_INTEGER;
    renderHighlights();
    const filters = currentFilters();
    const scope = filters.bookId !== 'all'
      ? Core.getHighlights().find(item => item.bookId === filters.bookId)?.book
      : '';
    $('#printHeading').textContent = scope
      ? t('הדגשות מרקר — {book}', { book: scope })
      : t('הדגשות מרקר');
    $('#printMeta').textContent = t('{count} הדגשות · {date}', {
      count: visibleKeys.length,
      date: new Date().toLocaleDateString(I18n.language === 'he' ? 'he-IL' : I18n.language)
    });
  }

  /** Puts the paging back after printing, so the screen is not left unpaged. */
  function restoreListWindow() {
    renderedLimit = D.HIGHLIGHTS_PAGE_SIZE;
    renderHighlights();
  }

  function printFileName() {
    return `${t('הדגשות מרקר')} ${new Date().toISOString().slice(0, 10)}`;
  }

  /**
   * Saves sort, grouping and the open tab. Writes only on a real change, so
   * clicking through tabs does not hit storage each time, and stays silent —
   * this is not something the user "saved", so the auto-save indicator on the
   * settings screen must not light up for it.
   */
  function persistViewState() {
    const view = {
      sort: $('#sortHighlights').value,
      group: $('#groupHighlights').value,
      tab: activeTab()
    };
    const current = Core.settings.view;
    if (view.sort === current.sort && view.group === current.group && view.tab === current.tab) {
      return;
    }
    Core.saveSettings(D.normalizeSettings(Object.assign({}, Core.settings, { view })))
      .catch(error => logger.warn('Failed saving the view state', error));
  }

  function restoreViewState() {
    const view = Core.settings.view;
    $('#sortHighlights').value = view.sort;
    $('#groupHighlights').value = view.group;
    const tab = $(`.tab[data-tab="${view.tab}"]`);
    if (tab && view.tab !== 'highlights') tab.click();
    syncAllEnhancedSelects();
  }

  // ── Undo bar ───────────────────────────────────────────────────────────────

  function dismissUndo() {
    clearTimeout(undoTimer);
    undoTimer = null;
    pendingDeleted = [];
    $('#undoDeleteBar').hidden = true;
  }

  function offerUndo(items) {
    if (!items.length) return;
    clearTimeout(undoTimer);
    pendingDeleted = items.map(item => D.structuredCloneSafe(item));
    $('#undoDeleteText').textContent = items.length === 1
      ? t('ההדגשה נמחקה')
      : t('{count} הדגשות נמחקו', { count: items.length });
    $('#undoDeleteBar').hidden = false;
    undoTimer = setTimeout(dismissUndo, UNDO_WINDOW_MS);
  }

  async function undoDelete() {
    const items = pendingDeleted.slice();
    if (!items.length) return;
    dismissUndo();
    const { restored, failed } = await Core.restoreHighlights(items);
    if (failed) {
      await notify.confirm(t('שחזור חלקי'), t('{restored} שוחזרו; {failed} לא שוחזרו', { restored, failed }));
    } else {
      await notify.success(restored === 1
        ? t('ההדגשה שוחזרה')
        : t('{count} הדגשות שוחזרו', { count: restored }));
    }
  }

  // ── Highlight actions ──────────────────────────────────────────────────────

  function selectedHighlights() {
    return Core.getHighlights().filter(item => selectedKeys.has(item.key));
  }

  async function runBulk(items, action, describe) {
    let failed = 0;
    for (const item of items) {
      try {
        await action(item);
      } catch (error) {
        failed++;
        logger.error('Bulk action failed', item.highlightId, error);
      }
    }
    renderHighlights();
    const message = describe(items.length - failed, failed);
    if (failed) await notify.confirm(t('עדכון חלקי'), message);
    else await notify.success(message);
  }

  async function deleteHighlightsWithUndo(items) {
    const deleted = await Core.deleteHighlights(items);
    selectedKeys.clear();
    renderHighlights();
    offerUndo(deleted);
  }

  // ── Note editor ────────────────────────────────────────────────────────────

  /** Created once, on first use, and reused for every highlight afterwards. */
  function noteEditor() {
    if (editor) return editor;
    editor = RichText.createEditor({
      element: $('#editHighlightNote'),
      toolbar: $('#noteToolbar'),
      linkBar: $('#noteLinkBar'),
      onDirty: dirty => Core.setUnsavedChanges(dirty, t('ההערה שבעריכה תאבד')),
      onSave: () => $('#editHighlightForm').requestSubmit()
    });
    return editor;
  }

  function openLinkBar() {
    const bar = $('#noteLinkBar');
    bar.hidden = false;
    const input = $('#noteLinkUrl');
    input.disabled = false;
    input.value = '';
    input.setCustomValidity('');
    input.focus();
  }

  /**
   * Puts the link bar back to its inert state.
   *
   * Every path that hides the bar must go through here. The input is a
   * `type="url"` inside `#editHighlightForm`, so a leftover value, a
   * leftover validity message, or simply being left enabled while hidden
   * makes the form permanently un-submittable — the browser refuses to
   * submit over a control it cannot focus, and saving a note dies silently
   * for the rest of the session.
   */
  function resetLinkBar() {
    const input = $('#noteLinkUrl');
    input.setCustomValidity('');
    input.value = '';
    input.disabled = true;
    $('#noteLinkBar').hidden = true;
  }

  function closeLinkBar() {
    resetLinkBar();
    noteEditor().focus();
  }

  async function applyNoteLink() {
    const input = $('#noteLinkUrl');
    if (!noteEditor().applyLink(input.value.trim())) {
      input.setCustomValidity(t('יש להזין כתובת שמתחילה ב-http או ב-https'));
      input.reportValidity();
      return;
    }
    closeLinkBar();
  }

  /**
   * Opens the note editor for `item`.
   *
   * @param {object} item          the highlight to edit
   * @param {Element|null} returnFocus  the control that opened the dialog
   * @returns {boolean} `false` when the user chose to keep an unsaved note
   */
  function openEditDialog(item, returnFocus) {
    // A request can arrive from the reader's context menu while the dialog is
    // already open on another highlight — silently swapping the content would
    // throw away whatever the user had typed.
    if (editingKey && editingKey !== item.key && editor?.isDirty) {
      notify.info(t('יש הערה שלא נשמרה. שמרו או בטלו אותה לפני מעבר להדגשה אחרת.'));
      $('#editHighlightDialog').focus();
      return false;
    }
    editingKey = item.key;
    editReturnFocus = returnFocus || null;
    const colorSelect = $('#editHighlightColor');
    colorSelect.innerHTML = Core.settings.colors.map(color =>
      `<option value="${escapeHtml(color.id)}">${escapeHtml(colorDisplayLabel(color))}</option>`).join('');
    colorSelect.value = item.colorId;
    enhanceSelect(colorSelect);
    syncEnhancedSelect(colorSelect);
    // Records written before rich notes existed carry plain text only.
    noteEditor().setHtml(item.noteHtml || RichText.fromPlainText(item.note));
    resetLinkBar();
    $('#editHighlightTags').value = item.tags.join(', ');
    $('#editHighlightFavorite').checked = item.favorite === true;
    $('#editHighlightPreview').textContent = item.text || t('הדגשה ללא תצוגה מקדימה');
    const dialog = $('#editHighlightDialog');
    if (!dialog.open) dialog.showModal();
    requestAnimationFrame(() => noteEditor().focus());
    return true;
  }

  function closeEditDialog() {
    resetLinkBar();
    editingKey = null;
    editor?.clearDirty();
    Core.setUnsavedChanges(false);
    const dialog = $('#editHighlightDialog');
    if (dialog.open) dialog.close();
    const target = editReturnFocus;
    editReturnFocus = null;
    if (target?.isConnected) requestAnimationFrame(() => target.focus());
  }

  async function saveEditedHighlight() {
    const savedKey = editingKey;
    const item = Core.findHighlight(savedKey);
    const color = Core.settings.colors.find(entry => entry.id === $('#editHighlightColor').value);
    // A record can disappear underneath the dialog — deleted in bulk, or wiped
    // by an import. Saying nothing looks exactly like a dead Save button.
    if (!item) {
      closeEditDialog();
      await notify.info(t('ההדגשה כבר אינה קיימת, ולכן לא נשמרה.'));
      return;
    }
    if (!color) {
      await notify.error(t('הצבע שנבחר אינו קיים יותר. בחרו צבע אחר.'));
      return;
    }
    const rich = noteEditor();
    // The store cuts an over-long note to fit. Doing that without a word looks
    // like the tail of the note was simply lost.
    if (rich.getHtml().length > D.MAX_NOTE_HTML_LENGTH) {
      await notify.info(t('ההערה ארוכה מהמותר ותישמר מקוצרת.'));
    }
    await Core.updateHighlight(item, {
      color,
      // Both are stored: the markup for display, the text for search and for
      // the Markdown and plain-text exports.
      noteHtml: rich.getHtml(),
      note: rich.getText(),
      tags: $('#editHighlightTags').value,
      favorite: $('#editHighlightFavorite').checked,
      render: false
    });
    closeEditDialog();
    renderHighlights();
    // The list was rebuilt, so the button the dialog came from no longer
    // exists: focus has to be put back on its replacement, or it falls to the
    // document and keyboard users lose their place.
    focusRowAction(savedKey);
    await notify.success(t('ההדגשה עודכנה'));
  }

  /** Puts focus back on a rebuilt row's edit button, if the row is still there. */
  function focusRowAction(key) {
    if (!key) return;
    requestAnimationFrame(() => {
      const escaped = global.CSS?.escape ? global.CSS.escape(key) : key.replace(/["\\]/g, '\\$&');
      const button = document.querySelector(`[data-action="edit"][data-key="${escaped}"]`);
      (button || $('#highlightsList'))?.focus?.();
    });
  }

  /** Opens the editor for a highlight the reader's context menu picked. */
  function openEditByHighlightId(highlightId) {
    const item = Core.findHighlight(highlightId);
    if (!item) {
      notify.info(t('ההדגשה לא נמצאה ברשימה. נסו לרענן.'));
      return;
    }
    $('.tab[data-tab="highlights"]').click();
    openEditDialog(item, null);
  }

  // ── Clipboard ──────────────────────────────────────────────────────────────

  /** Writing to the clipboard needs no permission under a user gesture. */
  async function copyToClipboard(text, message) {
    try {
      await navigator.clipboard.writeText(text);
      await notify.success(message);
    } catch (error) {
      logger.warn('Clipboard write failed', error);
      await notify.error(t('ההעתקה נכשלה'));
    }
  }

  function citationOf(item) {
    const heading = [item.book || item.bookId, item.ref].filter(Boolean).join(' · ');
    const note = item.note.trim();
    return [item.text, heading ? `(${heading})` : '', note ? `${t('הערה')}: ${note}` : '']
      .filter(Boolean).join('\n');
  }

  // ── Colors editor ──────────────────────────────────────────────────────────

  function colorRowHtml(color, index, total, { inMenu, isDefault }) {
    const hex = escapeHtml(D.toSafeHex(color.hex));
    // Enabled is not the same as shown: only the first MAX_MENU_COLORS
    // enabled colors reach the menu, and a badge that promised otherwise
    // would be the one place the user could not tell.
    const badge = inMenu ? ` <span class="menu-badge">${escapeHtml(t('תפריט'))}</span>` : '';
    return `<div class="color-row" data-index="${index}" data-default="${isDefault}" data-marker-mode="${escapeHtml(color.markerMode)}" style="--picked-color:${hex};--marker-preview-color:${D.hexToRgba(hex, color.opacity)};--marker-radius:${color.borderRadius}px">
      <div class="color-row-main">
        <button type="button" class="drag-handle" title="${escapeHtml(t('שינוי סדר'))}" aria-label="${escapeHtml(t('שינוי סדר של {name}', { name: color.label }))}"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="9" cy="6" r="1.25"/><circle cx="15" cy="6" r="1.25"/><circle cx="9" cy="12" r="1.25"/><circle cx="15" cy="12" r="1.25"/><circle cx="9" cy="18" r="1.25"/><circle cx="15" cy="18" r="1.25"/></svg></button>
        <details class="color-picker-details">
          <summary class="color-picker-btn" title="${escapeHtml(t('בחירת גוון'))}" aria-label="${escapeHtml(t('בחירת גוון עבור {name}', { name: color.label }))}"><span class="color-swatch"></span><span class="color-picker-label">${escapeHtml(t('בחירת גוון'))}</span><svg class="chevron-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m7 9 5 5 5-5"/></svg></summary>
          <div class="color-picker-popover">
            <span class="picker-popover-title">${escapeHtml(t('בחרו גוון'))}</span>
            <div class="preset-swatches" role="listbox" aria-label="${escapeHtml(t('גוונים מוכנים'))}">${COLOR_PRESETS.map(([presetHex, name]) => {
              const selected = D.toSafeHex(color.hex) === presetHex;
              return `<button type="button" class="preset-swatch${selected ? ' is-selected' : ''}" data-action="preset" data-hex="${presetHex}" title="${escapeHtml(t(name))}" aria-label="${escapeHtml(t(name))}" aria-selected="${selected}" style="--swatch:${presetHex}"></button>`;
            }).join('')}</div>
            <label class="hex-field">${escapeHtml(t('קוד HEX'))}<div class="hex-input-row"><input type="text" value="${hex}" data-field="hex-display" inputmode="text" maxlength="7" spellcheck="false" /><button type="button" class="hex-picker-btn" data-action="browser-picker" title="${escapeHtml(t('פתיחת בוחר הצבעים של המערכת'))}" aria-label="${escapeHtml(t('פתיחת בוחר הצבעים של המערכת'))}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.5a8.5 8.5 0 1 0 0 17h1.2a1.8 1.8 0 0 0 0-3.6h-.7a1.5 1.5 0 0 1 0-3h2.2A5.8 5.8 0 0 0 20.5 8 8.5 8.5 0 0 0 12 3.5Z"/><circle cx="8" cy="9" r="1"/><circle cx="11.5" cy="6.8" r="1"/><circle cx="15.5" cy="8" r="1"/></svg></button></div></label>
            <button type="button" class="apply-hex-btn" data-action="apply-hex">${escapeHtml(t('החלת הגוון'))}</button>
          </div>
        </details>
        <input class="native-color" type="color" value="${hex}" data-field="hex" aria-label="${escapeHtml(t('צבע'))}" tabindex="-1" />
        <label class="color-name-field"><span>${escapeHtml(t('שם הצבע'))}</span><input type="text" value="${escapeHtml(color.label)}" data-field="label" aria-label="${escapeHtml(t('שם צבע'))}" /></label>
        <div class="color-row-actions">
          <label class="color-switch-label" title="${escapeHtml(color.enabled ? t('לחץ לכיבוי') : t('לחץ להפעלה'))}">
            <input type="checkbox" data-field="enabled"${color.enabled ? ' checked' : ''} />
            <span class="color-switch-copy"><strong>${escapeHtml(color.enabled ? t('פעיל') : t('כבוי'))}</strong>${badge}</span>
          </label>
          <div class="order-btns">
            <button type="button" data-action="up"${index === 0 ? ' disabled' : ''} title="${escapeHtml(t('העבר למעלה'))}" aria-label="${escapeHtml(t('העבר את {name} למעלה', { name: color.label }))}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 14 5-5 5 5"/></svg></button>
            <button type="button" data-action="down"${index === total - 1 ? ' disabled' : ''} title="${escapeHtml(t('העבר למטה'))}" aria-label="${escapeHtml(t('העבר את {name} למטה', { name: color.label }))}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 10 5 5 5-5"/></svg></button>
          </div>
          <button class="color-icon-btn default-action${isDefault ? ' is-default' : ''}" type="button" data-action="make-default"${isDefault || !color.enabled ? ' disabled' : ''} title="${escapeHtml(isDefault ? t('זהו צבע ברירת המחדל') : t('הפוך לצבע ברירת המחדל'))}" aria-pressed="${isDefault}" aria-label="${escapeHtml(t('הפוך את {name} לברירת המחדל', { name: color.label }))}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3.8 2.5 5.1 5.6.8-4 3.9 1 5.6-5.1-2.7-5 2.7 1-5.6-4.1-3.9 5.6-.8Z"/></svg></button>
          <button class="color-icon-btn danger-action" type="button" data-action="remove"${total <= 1 ? ' disabled' : ''} title="${escapeHtml(t('מחק צבע'))}" aria-label="${escapeHtml(t('מחק את {name}', { name: color.label }))}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h14M10 11v6M14 11v6M7 7l1 13h8l1-13M9 7l1-3h4l1 3"/></svg></button>
        </div>
      </div>
      <div class="color-preview" aria-label="${escapeHtml(t('תצוגה מקדימה של {name}', { name: color.label }))}">
        <span class="color-preview-label"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z"/><circle cx="12" cy="12" r="2.5"/></svg>${escapeHtml(t('תצוגה מקדימה'))}</span>
        <span class="marker-preview">${escapeHtml(t('טקסט מסומן לדוגמה'))}</span>
      </div>
      <details class="color-style-editor">
        <summary><span><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h10M18 7h2M4 17h2M10 17h10"/><circle cx="16" cy="7" r="2"/><circle cx="8" cy="17" r="2"/></svg>${escapeHtml(t('עריכת סגנון ההדגשה'))}</span><small>${escapeHtml(t('סוג סימון, שקיפות ועיגול פינות'))}</small></summary>
        <div class="color-style-grid">
          <label>${escapeHtml(t('אופן הסימון'))}
            <select data-field="markerMode">
              <option value="text-background"${color.markerMode === 'text-background' ? ' selected' : ''}>${escapeHtml(t('רקע לטקסט'))}</option>
              <option value="underline"${color.markerMode === 'underline' ? ' selected' : ''}>${escapeHtml(t('קו תחתון'))}</option>
              <option value="box"${color.markerMode === 'box' ? ' selected' : ''}>${escapeHtml(t('מסגרת'))}</option>
              <option value="line-marker"${color.markerMode === 'line-marker' ? ' selected' : ''}>${escapeHtml(t('צבע לטקסט'))}</option>
            </select>
          </label>
          <label>${escapeHtml(t('שקיפות'))} <output>${Math.round(color.opacity * 100)}%</output>
            <input type="range" min="0.15" max="1" step="0.05" value="${color.opacity}" data-field="opacity" />
          </label>
          <label class="radius-setting">${escapeHtml(t('עיגול פינות'))}
            <input type="range" min="0" max="16" step="1" value="${color.borderRadius}" data-field="borderRadius" />
          </label>
        </div>
      </details>
    </div>`;
  }

  function renderColorsEditor() {
    const current = settings();
    const editor = $('#colorsEditor');
    const inMenu = new Set(D.enabledColors(current).map(color => color.id));
    editor.innerHTML = current.colors
      .map((color, index) => colorRowHtml(color, index, current.colors.length, {
        inMenu: inMenu.has(color.id),
        isDefault: color.id === current.defaultColorId
      })).join('');
    $('#addColorBtn').disabled = current.colors.length >= D.MAX_COLORS;
    $('#menuColorLimitNote').textContent = t('{active} צבעים פעילים — מוצגים עד {max} בתפריט', {
      active: current.colors.filter(color => color.enabled).length,
      max: D.MAX_MENU_COLORS
    });
    enhanceSelects(editor);
    initColorDragDrop();
  }

  function collectColorsFromForm() {
    const colors = $$('.color-row').map(row => {
      const index = Number(row.dataset.index);
      const current = settings().colors[index] || {};
      return {
        id: current.id,
        hex: $('[data-field="hex"]', row).value,
        label: $('[data-field="label"]', row).value.trim() || t('צבע'),
        enabled: $('[data-field="enabled"]', row).checked,
        markerMode: $('[data-field="markerMode"]', row).value,
        opacity: Number($('[data-field="opacity"]', row).value),
        borderRadius: Number($('[data-field="borderRadius"]', row).value)
      };
    });
    // Read back from the markup like every other field, because the save is
    // collected when the debounce fires rather than when the star is clicked.
    const marked = $$('.color-row').find(row => row.dataset.default === 'true');
    const defaultColorId = colors[Number(marked?.dataset.index)]?.id
      || Core.settings.defaultColorId;

    // Built over the *committed* settings, never over the draft: the draft
    // may hold the other form's pending edits, and writing them back from
    // here would undo whatever has been saved in the meantime.
    return D.normalizeSettings(Object.assign({}, Core.settings, { colors, defaultColorId }));
  }

  function initColorDragDrop() {
    $$('.color-row').forEach(row => row.addEventListener('pointerdown', onColorDragStart));
  }

  function onColorDragStart(event) {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    // The handle is a button, so it has to be allowed back in before the
    // controls are excluded — it is the row's only reorder affordance.
    if (!event.target.closest('.drag-handle')
      && event.target.closest('input, button, label, select, summary, details')) return;
    const source = event.currentTarget.closest('.color-row');
    if (!source) return;
    // Held locally, and `draftSettings` is left alone until the drop
    // actually reorders something: an auto-save that lands mid-drag would
    // clear a shared draft, and a press that turns out to be a plain click
    // would leave one standing forever.
    const dragBase = collectColorsFromForm();
    event.preventDefault();

    const sourceIndex = Number(source.dataset.index);
    let targetIndex = sourceIndex;
    source.classList.add('drag-dragging');

    const move = pointerEvent => {
      const over = document.elementFromPoint(pointerEvent.clientX, pointerEvent.clientY)
        ?.closest?.('.color-row');
      if (over) targetIndex = Number(over.dataset.index);
      $$('.color-row').forEach(row => row.classList.toggle('drag-over', row === over && row !== source));
    };
    const finish = () => {
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', finish);
      document.removeEventListener('pointercancel', finish);
      $$('.color-row').forEach(row => row.classList.remove('drag-dragging', 'drag-over'));
      // A press that never moved is a click, not a reorder: re-rendering and
      // writing the settings for it would be pure churn.
      if (targetIndex === sourceIndex) return;
      const colors = D.structuredCloneSafe(dragBase.colors);
      const [moved] = colors.splice(sourceIndex, 1);
      colors.splice(targetIndex, 0, moved);
      draftSettings = D.normalizeSettings(Object.assign({}, dragBase, { colors }));
      renderColorsEditor();
      scheduleAutoSave(collectColorsFromForm, 'colorsAutoSaveStatus', 100);
    };
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', finish);
    document.addEventListener('pointercancel', finish);
  }

  // ── Preferences form ───────────────────────────────────────────────────────

  function renderPreferences() {
    const current = settings();
    $('#languageSelect').value = current.language;
    $('#viewMode').value = current.appearance.viewMode;
    $('#fontFamily').value = current.appearance.fontFamily;
    $('#fontSize').value = String(current.appearance.fontSize);
    $('#lineHeight').value = String(current.appearance.lineHeight);
    $('#autoBackupToggle').checked = current.autoBackup;
    const menuStyle = $(`input[name="menuStyle"][value="${current.menuStyle}"]`);
    if (menuStyle) menuStyle.checked = true;

    const template = current.exportTemplate;
    $('#humanExportFormat').value = template.format;
    $('#exportIncludeBook').checked = template.includeBook;
    $('#exportIncludeRef').checked = template.includeRef;
    $('#exportIncludeNote').checked = template.includeNote;
    $('#exportIncludeTags').checked = template.includeTags;
    $('#exportIncludeDate').checked = template.includeDate;

    const tags = [...new Set(Core.getHighlights().flatMap(item => item.tags))].sort(D.hebrewCompare);
    const tagSource = $('#manageTagSource');
    const previous = tagSource.value;
    tagSource.innerHTML = tags.length
      ? tags.map(tag => `<option value="${escapeHtml(tag)}">${escapeHtml(tag)}</option>`).join('')
      : `<option value="">${escapeHtml(t('אין תגיות'))}</option>`;
    if (tags.includes(previous)) tagSource.value = previous;

    updateRangeOutputs();
    applyDisplaySettings();
    syncAllEnhancedSelects();
  }

  function collectPreferencesFromForm() {
    // Over the committed settings — see collectColorsFromForm.
    return D.normalizeSettings(Object.assign({}, Core.settings, {
      language: $('#languageSelect').value,
      menuStyle: $('input[name="menuStyle"]:checked')?.value || Core.settings.menuStyle,
      autoBackup: $('#autoBackupToggle').checked,
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
    $('#fontSizeValue').textContent = t('{size} פיקסלים', { size: $('#fontSize').value });
    $('#lineHeightValue').textContent = $('#lineHeight').value;
  }

  async function transformGlobalTag(action) {
    const source = $('#manageTagSource').value;
    const target = D.normalizeTags($('#manageTagTarget').value)[0] || '';
    // Saying nothing here reads as a dead button. Each case gets its reason.
    if (!source) {
      await notify.info(t('בחרו תגית לפעולה.'));
      return;
    }
    if (action !== 'delete' && !target) {
      await notify.info(t('הזינו את שם התגית החדשה.'));
      $('#manageTagTarget').focus();
      return;
    }
    if (source === target) {
      await notify.info(t('שם התגית החדשה זהה לקיימת.'));
      return;
    }
    if (action === 'delete') {
      const confirmed = await notify.confirm(
        t('מחיקת תגית'),
        t('התגית „{tag}” תוסר מכל ההדגשות. להמשיך?', { tag: source })
      );
      if (!confirmed) return;
    }
    const affected = Core.getHighlights().filter(item => item.tags.includes(source));
    await runBulk(
      affected,
      item => Core.updateHighlight(item, {
        tags: item.tags.flatMap(tag => tag === source ? (action === 'delete' ? [] : [target]) : [tag]),
        render: false
      }),
      (done, failed) => failed
        ? t('{done} עודכנו; {failed} נכשלו', { done, failed })
        : t('{count} הדגשות עודכנו', { count: done })
    );
    $('#manageTagTarget').value = '';
    renderPreferences();
  }

  // ── Export & backup ────────────────────────────────────────────────────────

  function humanExportContent(items, template) {
    const rows = items.map(item => {
      const heading = [
        template.includeBook ? (item.book || item.bookId) : '',
        template.includeRef ? item.ref : ''
      ].filter(Boolean).join(' · ');
      const date = template.includeDate && item.timestamp ? formatDate(item.timestamp) : '';
      const note = template.includeNote && item.note ? item.note : '';
      const tags = template.includeTags && item.tags.length ? item.tags : [];

      if (template.format === 'html') {
        // The rich note keeps its formatting in an HTML export — sanitized,
        // because the source may be an imported backup.
        const noteBlock = template.includeNote && item.noteHtml
          ? `<div class="note">${sanitizedNote(item.noteHtml)}</div>`
          : (note ? `<p><strong>${escapeHtml(t('הערה'))}:</strong> ${escapeHtml(note)}</p>` : '');
        return `<article dir="${I18n.direction}"><h2>${escapeHtml(heading)}</h2><blockquote>${escapeHtml(item.text)}</blockquote>`
          + noteBlock
          + (tags.length ? `<p><strong>${escapeHtml(t('תגיות'))}:</strong> ${tags.map(escapeHtml).join(', ')}</p>` : '')
          + (date ? `<time>${escapeHtml(date)}</time>` : '')
          + '</article>';
      }
      if (template.format === 'text') {
        return [heading, item.text, note ? `${t('הערה')}: ${note}` : '',
          tags.length ? `${t('תגיות')}: ${tags.join(', ')}` : '', date].filter(Boolean).join('\n');
      }
      // Markdown has no escaping layer of its own, so every stored value is
      // neutralized before it becomes part of the document structure.
      const md = D.escapeMarkdownBlocks;
      return [
        `## ${md(heading) || t('הדגשה')}`,
        `> ${md(item.text).replace(/\n/g, '\n> ')}`,
        note ? `**${t('הערה')}:** ${md(note)}` : '',
        tags.length ? `**${t('תגיות')}:** ${tags.map(md).join(', ')}` : '',
        date ? `_${date}_` : ''
      ].filter(Boolean).join('\n\n');
    });
    if (template.format !== 'html') return rows.join('\n\n---\n\n');
    return `<!doctype html><html lang="${I18n.language}" dir="${I18n.direction}"><meta charset="utf-8">`
      + `<title>${escapeHtml(t('הדגשות מרקר'))}</title>`
      + '<style>body{font-family:system-ui;max-width:850px;margin:auto;padding:24px}'
      + 'article{border-bottom:1px solid #ddd;padding:16px 0}blockquote{white-space:pre-wrap}</style>'
      + `<body><h1>${escapeHtml(t('הדגשות מרקר'))}</h1>${rows.join('')}</body></html>`;
  }

  function datedName(prefix) {
    return `${prefix}-${new Date().toISOString().slice(0, 10)}`;
  }

  async function saveTextFile(text, prefix, extension, mimeType) {
    const result = await Core.saveFileAs(text, datedName(prefix), extension, mimeType);
    if (result?.cancelled) return false;
    await notify.success(t('הקובץ נשמר: {name}', { name: result?.name || '' }));
    return true;
  }

  async function exportVisible() {
    const keys = new Set(visibleKeys);
    const items = Core.getHighlights().filter(item => keys.has(item.key));
    if (!items.length) {
      await notify.info(t('אין הדגשות לייצוא'));
      return;
    }
    const template = Core.settings.exportTemplate;
    const extension = template.format === 'markdown' ? 'md' : template.format === 'html' ? 'html' : 'txt';
    const mime = template.format === 'html' ? 'text/html' : 'text/plain';
    await saveTextFile(humanExportContent(items, template), 'otzaria-marker-export', extension, mime);
  }

  async function exportBackup(items) {
    const payload = JSON.stringify(Core.buildBackup(items), null, 2);
    const prefix = items ? 'otzaria-marker-selected' : 'otzaria-marker-backup';
    await saveTextFile(payload, prefix, 'json', 'application/json');
  }

  async function importBackupText(text) {
    if (typeof text !== 'string' || text.length > 50_000_000) {
      await notify.error(t('קובץ הגיבוי גדול מדי או שאינו קובץ טקסט תקין'));
      return;
    }
    let backup;
    try {
      backup = D.parseBackup(JSON.parse(text));
    } catch (error) {
      await notify.error(error instanceof D.MarkerBackupError
        ? t(error.messageKey)
        : t('קובץ הגיבוי אינו תקין'));
      return;
    }
    const replace = $('#importMode').value === 'replace';
    const plan = D.planImport(Core.getHighlights(), backup.highlights);
    const confirmed = await notify.confirm(
      replace ? t('החלפת גיבוי') : t('מיזוג גיבוי'),
      replace
        ? t('כל {current} ההדגשות הקיימות יוחלפו ב-{incoming} הדגשות מהגיבוי.', {
          current: Core.getHighlights().length, incoming: backup.highlights.length
        })
        : t('תצוגה מקדימה: {added} חדשות, {updated} עדכונים, {identical} כפילויות זהות שיידלגו. גם הגדרות התוסף יעודכנו מהגיבוי.', {
          added: plan.added.length, updated: plan.updated.length, identical: plan.identical.length
        })
    );
    if (!confirmed) return;

    try {
      const result = await Core.importBackup(backup, { replace });
      renderAll();
      await notify.success(replace
        ? t('הגיבוי יובא בהצלחה · {count} הדגשות', { count: result.imported })
        : t('הייבוא הושלם · {added} חדשות · {updated} עודכנו · {identical} דולגו', {
          added: result.plan.added.length,
          updated: result.plan.updated.length,
          identical: result.plan.identical.length
        }));
    } catch (error) {
      logger.error('Backup import failed', error);
      await notify.error(t('ייבוא הגיבוי נכשל: {reason}. השינויים בוטלו והמצב הקודם שוחזר.', {
        reason: Core.describeError(error)
      }));
      renderAll();
    }
  }

  async function renderAutoBackupList() {
    const select = $('#autoBackupSelect');
    const entries = await Core.listAutoBackups();
    select.innerHTML = entries.length
      ? entries.map(entry => {
        const when = entry.modified ? new Date(entry.modified).toLocaleString() : '';
        const size = Math.round((entry.size || 0) / 1024);
        return `<option value="${escapeHtml(entry.path)}">${escapeHtml(entry.name)} · ${escapeHtml(when)} · ${size}KB</option>`;
      }).join('')
      : `<option value="">${escapeHtml(t('אין גיבוי אוטומטי שמור'))}</option>`;
    $('#restoreAutoBackupBtn').disabled = !entries.length;
    syncEnhancedSelect(select);
  }

  // ── About & report ─────────────────────────────────────────────────────────

  async function renderAbout() {
    const host = Core.hostContext;
    $('#aboutPluginVersion').textContent = Core.PLUGIN_VERSION;
    $('#aboutHostVersion').textContent = host.appVersion;
    $('#aboutPlatform').textContent = host.platform;
    $('#aboutRunMode').textContent = t('הדף מנהל את התוסף');
    $('#createShortcutBtn').hidden = !host.isDesktop;
    $('#createStartMenuShortcutBtn').hidden = host.platform !== 'windows';
    $('#reportEmailField').hidden = await Core.hasReporterEmail();
  }

  async function createShortcut(location) {
    const result = await callSoft('shortcut.create', { label: t('מרקר'), location });
    if (!result) {
      await notify.error(t('לא ניתן ליצור קיצור דרך'));
      return;
    }
    if (result.created) await notify.success(t('קיצור הדרך נוצר'));
  }

  async function submitReport(event) {
    event.preventDefault();
    const details = $('#reportDetails').value.trim();
    if (details.length < 10) {
      $('#reportDetails').setCustomValidity(t('נא לפרט מעט יותר — לפחות עשרה תווים.'));
      $('#reportDetails').reportValidity();
      return;
    }
    const button = $('#sendReportBtn');
    button.disabled = true;
    try {
      // feedback.report manages its own timeout and waits for the user's
      // confirmation dialog — it must never be raced by a timeout here.
      const outcome = await Core.sendReport({
        details,
        reportType: $('#reportType').value,
        reporterEmail: $('#reportEmail').value.trim()
      });
      if (outcome === 'cancelled') return;
      $('#reportDetails').value = '';
      await notify.success(outcome === 'queued'
        ? t('הדיווח נשמר ויישלח כשתהיה תקשורת')
        : t('הדיווח נשלח. תודה!'));
    } catch (error) {
      logger.error('Report failed', error);
      await notify.error(t('שליחת הדיווח נכשלה: {reason}', { reason: Core.describeError(error) }));
    } finally {
      button.disabled = false;
    }
  }

  // ── Add-color dialog ───────────────────────────────────────────────────────

  function updateNewColorPreview() {
    const hex = D.toSafeHex($('#newColorHex').value);
    const opacity = Number($('#newColorOpacity').value);
    const radius = Number($('#newColorRadius').value);
    const mode = $('#newColorMarkerMode').value;
    const preview = $('#newColorPreview');
    preview.style.setProperty('--new-color', hex);
    preview.style.setProperty('--new-color-rgba', D.hexToRgba(hex, opacity));
    preview.style.setProperty('--new-color-radius', `${radius}px`);
    preview.dataset.markerMode = mode;
    $('#newColorOpacityOutput').textContent = `${Math.round(opacity * 100)}%`;
    $('#newColorRadiusField').hidden = !['text-background', 'box'].includes(mode);
  }

  function openAddColorDialog() {
    const dialog = $('#addColorDialog');
    $('#newColorLabel').value = t('גוון חדש');
    $('#newColorPicker').value = '#D8B4E2';
    $('#newColorHex').value = '#D8B4E2';
    $('#newColorMarkerMode').value = 'text-background';
    $('#newColorOpacity').value = '0.45';
    $('#newColorRadius').value = '4';
    syncEnhancedSelect($('#newColorMarkerMode'));
    updateNewColorPreview();
    if (!dialog.open) dialog.showModal();
    requestAnimationFrame(() => $('#newColorLabel').focus());
  }

  async function submitNewColor(event) {
    event.preventDefault();
    const next = collectColorsFromForm();
    if (next.colors.length >= D.MAX_COLORS) {
      await notify.info(t('ניתן להוסיף עד {max} צבעים.', { max: D.MAX_COLORS }));
      return;
    }
    const hexInput = $('#newColorHex');
    const labelInput = $('#newColorLabel');
    const hex = hexInput.value.trim();
    if (!/^#[0-9A-F]{6}$/i.test(hex)) {
      hexInput.setCustomValidity(t('יש להזין קוד HEX תקין, לדוגמה #D8B4E2'));
      hexInput.reportValidity();
      return;
    }
    const label = labelInput.value.trim();
    if (!label) {
      labelInput.setCustomValidity(t('יש לתת שם לצבע'));
      labelInput.reportValidity();
      return;
    }
    next.colors.push({
      id: `custom-${Date.now()}`,
      hex: hex.toUpperCase(),
      label,
      enabled: next.colors.filter(color => color.enabled).length < D.MAX_MENU_COLORS,
      markerMode: $('#newColorMarkerMode').value,
      opacity: Number($('#newColorOpacity').value),
      borderRadius: Number($('#newColorRadius').value)
    });
    $('#addColorDialog').close();
    draftSettings = null;
    await Core.saveSettings(next);
    renderColorsEditor();
    await notify.success(t('הצבע „{name}” נוסף', { name: label }));
  }

  // ── Rendering entry points ─────────────────────────────────────────────────

  function renderAll() {
    renderHighlights();
    renderColorsEditor();
    renderPreferences();
    renderAbout().catch(error => logger.warn('Failed rendering the about tab', error));
  }

  function activeTab() {
    return $('.tab.active')?.dataset.tab || 'highlights';
  }

  /**
   * The background engine writes to the same storage while this page is open,
   * so the list can go stale without any local event. Polling exists only for
   * that case — when the page itself owns the engine, nothing external can
   * change the data and the timer never starts.
   */
  /**
   * What "the list changed" means for the background poll.
   *
   * `noteHtml` belongs here as much as `note` does: an edit that only
   * changes the formatting leaves the plain-text mirror identical, and the
   * card would keep rendering the old markup until something else changed.
   */
  function highlightsSignature() {
    return JSON.stringify(Core.getHighlights().map(item => [
      item.highlightId, item.timestamp, item.colorId, item.status, item.version,
      item.note, item.noteHtml, item.tags, item.favorite
    ]));
  }

  function applyLanguageToPage() {
    I18n.applyDocumentLanguage(document);
    I18n.translateDocument(document);
    renderAll();
    syncAllEnhancedSelects();
  }

  // ── Event wiring ───────────────────────────────────────────────────────────

  function bindTabs() {
    $$('.tab').forEach(button => button.addEventListener('click', () => {
      $$('.tab').forEach(other => other.classList.toggle('active', other === button));
      $$('.tab-panel').forEach(panel =>
        panel.classList.toggle('active', panel.dataset.panel === button.dataset.tab));
      if (button.dataset.tab === 'highlights') renderHighlights();
      if (button.dataset.tab === 'colors') renderColorsEditor();
      if (button.dataset.tab === 'settings') {
        renderPreferences();
        renderAutoBackupList().catch(error => logger.warn('Failed listing backups', error));
      }
      if (button.dataset.tab === 'about') renderAbout().catch(error => logger.warn('about', error));
      persistViewState();
    }));
  }

  function bindEnhancedSelects() {
    document.addEventListener('click', event => {
      const option = event.target.closest('.otz-select-option');
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
      const trigger = event.target.closest('.otz-select-trigger');
      const current = trigger?.closest('.otz-select');
      $$('.otz-select[open]').forEach(menu => {
        if (menu !== current && !menu.contains(event.target)) menu.open = false;
      });
    });
    document.addEventListener('change', event => {
      if (event.target.matches('select[data-otz-enhanced="true"]')) syncEnhancedSelect(event.target);
    });
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape') $$('.otz-select[open]').forEach(menu => { menu.open = false; });
    });
  }

  function bindHighlightList() {
    const list = $('#highlightsList');

    list.addEventListener('change', event => {
      if (!event.target.matches('.highlight-select')) return;
      if (event.target.checked) selectedKeys.add(event.target.dataset.key);
      else selectedKeys.delete(event.target.dataset.key);
      updateBulkActions();
    });

    list.addEventListener('click', async event => {
      const button = event.target.closest('button[data-action]');
      if (!button) return;
      const item = Core.findHighlight(button.dataset.key);
      if (!item) return;

      if (button.dataset.action === 'change-color') {
        const color = Core.settings.colors.find(entry => entry.id === button.dataset.colorId);
        if (!color || color.id === item.colorId) return;
        button.disabled = true;
        try {
          await Core.updateHighlight(item, { color });
          await notify.success(t('הצבע שונה ל{color}', { color: colorDisplayLabel(color) }));
        } catch (error) {
          logger.error('Failed changing color', error);
          await notify.error(Core.describeError(error));
          renderHighlights();
        }
        return;
      }
      if (button.dataset.action === 'open') {
        try {
          await Core.revealHighlight(item);
        } catch (error) {
          logger.error('Failed opening highlight', error);
          await notify.info(t('לא הצלחנו לפתוח את הסימון: {reason}', {
            reason: Core.describeError(error)
          }));
        }
        return;
      }
      if (button.dataset.action === 'edit') openEditDialog(item, button);
      if (button.dataset.action === 'copy') {
        await copyToClipboard(citationOf(item), t('ההדגשה הועתקה'));
      }
      if (button.dataset.action === 'delete') await deleteHighlightsWithUndo([item]);
    });

    list.addEventListener('keydown', event => {
      const card = event.target.closest('.highlight-card');
      if (!card || event.target !== card) return;
      if (event.key === 'Enter') {
        event.preventDefault();
        card.querySelector('button[data-action="open"]')?.click();
        return;
      }
      if (event.key === ' ' || event.key === 'Spacebar') {
        event.preventDefault();
        const checkbox = card.querySelector('.highlight-select');
        if (!checkbox) return;
        checkbox.checked = !checkbox.checked;
        checkbox.dispatchEvent(new Event('change', { bubbles: true }));
        return;
      }
      // Arrow keys walk the list without reaching for the mouse. Up/Down
      // rather than Left/Right, so the direction is the same in both scripts.
      const step = { ArrowDown: 1, ArrowUp: -1, Home: 0, End: -0 }[event.key];
      if (step === undefined) return;
      event.preventDefault();
      const cards = $$('.highlight-card', list);
      const index = cards.indexOf(card);
      const target = event.key === 'Home' ? cards[0]
        : event.key === 'End' ? cards[cards.length - 1]
          : cards[index + step];
      target?.focus();
    });

    // A link inside a note must not navigate the plugin's own WebView.
    list.addEventListener('click', event => {
      const link = event.target.closest('.highlight-note a[href]');
      if (!link) return;
      event.preventDefault();
      callSoft('app.openUrl', { url: link.href });
    });
  }

  function bindToolbar() {
    $('#refreshBtn').addEventListener('click', async () => {
      await Core.loadHighlights();
      await Core.reconcileHighlights();
    });
    for (const id of ['#bookFilter', '#colorFilter', '#tagFilter', '#statusFilter']) {
      $(id).addEventListener('change', resetListWindow);
    }
    // Sort and grouping are remembered between sessions; the filters and the
    // search box are not, so reopening never lands on a mysteriously empty list.
    for (const id of ['#sortHighlights', '#groupHighlights']) {
      $(id).addEventListener('change', () => {
        resetListWindow();
        persistViewState();
      });
    }
    $('#summaryStrip').addEventListener('click', event => {
      const chip = event.target.closest('.summary-chip');
      if (chip) applyChip(chip.dataset.chip, chip.dataset.value);
    });
    // ui.print and ui.exportPdf require a transient user activation, so they
    // are called straight from the click with nothing awaited in between.
    // `window.print()` opens the engine's own print window — a preview, a page
    // range and the paper settings, laid out inside Otzaria. `ui.print` is the
    // other option and jumps straight to the bare OS dialog with no preview,
    // which is not what a "print the list" button should do.
    $('#printBtn').addEventListener('click', () => {
      preparePrintView();
      try {
        global.print();
      } catch (error) {
        logger.error('Printing failed', error);
        notify.error(t('ההדפסה נכשלה'));
      } finally {
        restoreListWindow();
      }
    });
    $('#exportPdfBtn').addEventListener('click', () => {
      preparePrintView();
      guard(async () => {
        const result = await Core.exportPdf({ fileName: printFileName() });
        if (result?.saved) await notify.success(t('הקובץ נשמר: {name}', { name: result.name }));
      }, () => t('ייצוא ה-PDF נכשל')).finally(restoreListWindow);
    });
    $('#highlightSearch').addEventListener('input', () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(resetListWindow, 180);
    });
    $('#resetFiltersBtn').addEventListener('click', () => {
      $('#highlightSearch').value = '';
      for (const id of ['#bookFilter', '#colorFilter', '#tagFilter', '#statusFilter']) $(id).value = 'all';
      $('#sortHighlights').value = 'newest';
      $('#groupHighlights').value = 'none';
      resetListWindow();
    });
    $('#selectVisibleBtn').addEventListener('click', selectVisible);
    $('#selectAllBtn').addEventListener('click', () => {
      Core.getHighlights().forEach(item => selectedKeys.add(item.key));
      $$('.highlight-select').forEach(input => { input.checked = true; });
      updateBulkActions();
    });
    $('#loadMoreBtn').addEventListener('click', () => {
      renderedLimit += D.HIGHLIGHTS_PAGE_SIZE;
      renderHighlights();
    });
    $('#clearSelectionBtn').addEventListener('click', clearSelection);
    $('#clearAllBtn').addEventListener('click', async () => {
      const all = Core.getHighlights();
      if (!all.length) return;
      const confirmed = await notify.confirm(
        t('מחיקת כל ההדגשות'),
        t('האם למחוק את כל {count} ההדגשות? פעולה זו אינה הפיכה.', { count: all.length })
      );
      if (!confirmed) return;
      await Core.deleteAllHighlights();
      selectedKeys.clear();
      renderHighlights();
    });

    $('#applyBulkColorBtn').addEventListener('click', async () => {
      const color = D.findColor(Core.settings, $('#bulkColor').value);
      const items = selectedHighlights();
      if (!items.length) return;
      await runBulk(items, item => Core.updateHighlight(item, { color, render: false }),
        (done, failed) => failed
          ? t('{done} הדגשות עודכנו; {failed} לא עודכנו', { done, failed })
          : t('{count} הדגשות עודכנו ל{color}', { count: done, color: colorDisplayLabel(color) }));
    });
    $('#applyBulkTagsBtn').addEventListener('click', async () => {
      const added = D.normalizeTags($('#bulkTags').value);
      const items = selectedHighlights();
      if (!items.length || !added.length) return;
      await runBulk(items,
        item => Core.updateHighlight(item, { tags: [...item.tags, ...added], render: false }),
        (done, failed) => failed
          ? t('{done} הדגשות עודכנו; {failed} לא עודכנו', { done, failed })
          : t('התגיות נוספו ל-{count} הדגשות', { count: done }));
      $('#bulkTags').value = '';
    });
    $('#exportSelectedBtn').addEventListener('click', async () => {
      const items = selectedHighlights();
      if (!items.length) return;
      await exportBackup(items);
    });
    $('#deleteSelectedBtn').addEventListener('click', async () => {
      const items = selectedHighlights();
      if (!items.length) return;
      const confirmed = await notify.confirm(
        t('מחיקת הדגשות נבחרות'),
        t('האם למחוק {count} הדגשות? פעולה זו אינה הפיכה.', { count: items.length })
      );
      if (!confirmed) return;
      await deleteHighlightsWithUndo(items);
    });
    $('#undoDeleteBtn').addEventListener('click', undoDelete);
    $('#dismissUndoBtn').addEventListener('click', dismissUndo);
  }

  function selectVisible() {
    visibleKeys.forEach(key => selectedKeys.add(key));
    $$('.highlight-select').forEach(input => { input.checked = selectedKeys.has(input.dataset.key); });
    updateBulkActions();
  }

  function clearSelection() {
    selectedKeys.clear();
    $$('.highlight-select').forEach(input => { input.checked = false; });
    updateBulkActions();
  }

  function bindDialogs() {
    $('#closeEditDialogBtn').addEventListener('click', closeEditDialog);
    $('#cancelEditHighlightBtn').addEventListener('click', closeEditDialog);
    // Escape on a half-written note would throw the note away without a word,
    // so the dismissal is held back until the user confirms it.
    $('#editHighlightDialog').addEventListener('cancel', event => {
      if (!editor?.isDirty) {
        closeEditDialog();
        return;
      }
      event.preventDefault();
      notify.confirm(t('סגירת העריכה'), t('ההערה שנכתבה תאבד. לסגור בכל זאת?'))
        .then(confirmed => { if (confirmed) closeEditDialog(); });
    });
    $('#editHighlightForm').addEventListener('submit', async event => {
      event.preventDefault();
      const submitter = event.submitter;
      if (submitter) submitter.disabled = true;
      try {
        await saveEditedHighlight();
      } catch (error) {
        logger.error('Failed editing highlight', error);
        await notify.error(Core.describeError(error));
      } finally {
        if (submitter) submitter.disabled = false;
      }
    });

    $('#noteToolbar').addEventListener('click', event => {
      if (event.target.closest('[data-rt-link]')) openLinkBar();
    });
    $('#noteLinkApply').addEventListener('click', applyNoteLink);
    $('#noteLinkCancel').addEventListener('click', closeLinkBar);
    $('#noteLinkUrl').addEventListener('keydown', event => {
      if (event.key === 'Enter') {
        event.preventDefault();
        applyNoteLink();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        closeLinkBar();
      }
    });

    $('#addColorBtn').addEventListener('click', openAddColorDialog);
    $('#closeAddColorDialogBtn').addEventListener('click', () => $('#addColorDialog').close());
    $('#cancelAddColorBtn').addEventListener('click', () => $('#addColorDialog').close());
    $('#addColorForm').addEventListener('submit', event => {
      submitNewColor(event).catch(async error => {
        logger.error('Failed adding a color', error);
        await notify.error(Core.describeError(error));
      });
    });
    $('#newColorPicker').addEventListener('input', event => {
      $('#newColorHex').value = event.target.value.toUpperCase();
      updateNewColorPreview();
    });
    $('#newColorHex').addEventListener('input', event => {
      const value = event.target.value.trim();
      if (!/^#[0-9A-F]{6}$/i.test(value)) return;
      $('#newColorPicker').value = value;
      updateNewColorPreview();
    });
    $('#newColorMarkerMode').addEventListener('change', updateNewColorPreview);
    $('#newColorOpacity').addEventListener('input', updateNewColorPreview);
    $('#newColorRadius').addEventListener('input', updateNewColorPreview);
  }

  function bindColorsEditor() {
    const editor = $('#colorsEditor');

    editor.addEventListener('click', async event => {
      const button = event.target.closest('button[data-action]');
      if (!button) return;
      const row = button.closest('.color-row');
      const index = Number(row.dataset.index);
      // Deliberately local. `draftSettings` is only set on the paths that
      // schedule a save, because a draft left standing makes `settings()`
      // shadow the real settings — a later import would render, and then
      // save, the stale colors instead of the imported ones.
      const draft = collectColorsFromForm();

      const setRowHex = hex => {
        row.querySelector('[data-field="hex"]').value = hex;
        row.querySelector('[data-field="hex-display"]').value = hex;
        row.style.setProperty('--picked-color', hex);
        row.style.setProperty('--marker-preview-color',
          D.hexToRgba(hex, Number(row.querySelector('[data-field="opacity"]').value)));
        draftSettings = collectColorsFromForm();
        scheduleAutoSave(collectColorsFromForm, 'colorsAutoSaveStatus', 150);
      };


      switch (button.dataset.action) {
        case 'preset':
          setRowHex(D.toSafeHex(button.dataset.hex));
          return;
        case 'browser-picker': {
          const input = row.querySelector('input[type="color"]');
          if (input?.showPicker) input.showPicker();
          else input?.click();
          return;
        }
        case 'apply-hex': {
          const display = row.querySelector('[data-field="hex-display"]');
          const value = String(display.value || '').trim();
          if (!/^#[0-9A-F]{6}$/i.test(value)) {
            display.setCustomValidity(t('יש להזין קוד HEX תקין, לדוגמה #B7DDBB'));
            display.reportValidity();
            return;
          }
          setRowHex(value.toUpperCase());
          return;
        }
        case 'make-default': {
          const chosen = draft.colors[index];
          if (!chosen) return;
          draft.defaultColorId = chosen.id;
          break;
        }
        case 'remove':
          draft.colors.splice(index, 1);
          break;
        case 'up':
          if (index > 0) {
            [draft.colors[index - 1], draft.colors[index]] =
              [draft.colors[index], draft.colors[index - 1]];
          }
          break;
        case 'down':
          if (index < draft.colors.length - 1) {
            [draft.colors[index + 1], draft.colors[index]] =
              [draft.colors[index], draft.colors[index + 1]];
          }
          break;
        default:
          return;
      }
      draftSettings = D.normalizeSettings(draft);
      renderColorsEditor();
      scheduleAutoSave(collectColorsFromForm, 'colorsAutoSaveStatus', 100);
    });

    editor.addEventListener('input', event => {
      const row = event.target.closest('.color-row');
      if (!row) return;
      if (event.target.matches('input[type="color"]')) {
        const hex = event.target.value.toUpperCase();
        row.style.setProperty('--picked-color', hex);
        row.style.setProperty('--marker-preview-color',
          D.hexToRgba(hex, Number(row.querySelector('[data-field="opacity"]').value)));
        const display = row.querySelector('[data-field="hex-display"]');
        if (display) display.value = hex;
      }
      if (event.target.matches('[data-field="opacity"]')) {
        row.style.setProperty('--marker-preview-color',
          D.hexToRgba(row.querySelector('[data-field="hex"]').value, Number(event.target.value)));
        const output = event.target.closest('label')?.querySelector('output');
        if (output) output.textContent = `${Math.round(Number(event.target.value) * 100)}%`;
      }
      if (event.target.matches('[data-field="hex-display"]')) {
        const value = event.target.value.trim();
        if (/^#[0-9A-F]{6}$/i.test(value)) {
          row.querySelector('[data-field="hex"]').value = value;
          row.style.setProperty('--picked-color', value);
          row.style.setProperty('--marker-preview-color',
            D.hexToRgba(value, Number(row.querySelector('[data-field="opacity"]').value)));
        }
      }
      if (event.target.matches('[data-field="borderRadius"]')) {
        row.style.setProperty('--marker-radius', `${event.target.value}px`);
      }
      draftSettings = collectColorsFromForm();
      scheduleAutoSave(collectColorsFromForm, 'colorsAutoSaveStatus');
    });

    editor.addEventListener('change', event => {
      if (event.target.matches('[data-field="markerMode"]')) {
        event.target.closest('.color-row')?.setAttribute('data-marker-mode', event.target.value);
      }
      draftSettings = collectColorsFromForm();
      scheduleAutoSave(collectColorsFromForm, 'colorsAutoSaveStatus', 150);
      if (event.target.matches('[data-field="enabled"]')) renderColorsEditor();
    });

    $('#colorsForm').addEventListener('submit', event => {
      event.preventDefault();
      scheduleAutoSave(collectColorsFromForm, 'colorsAutoSaveStatus', 0);
    });
    $('#resetColorsBtn').addEventListener('click', async () => {
      const confirmed = await notify.confirm(
        t('איפוס צבעים'),
        t('האם לאפס את הצבעים לברירת המחדל? שינויי הצבעים שלך יאבדו.')
      );
      if (!confirmed) return;
      draftSettings = null;
      await Core.saveSettings(Object.assign({}, Core.settings, {
        colors: D.structuredCloneSafe(D.DEFAULT_SETTINGS.colors),
        defaultColorId: D.DEFAULT_SETTINGS.defaultColorId
      }));
      renderColorsEditor();
      await notify.success(t('הצבעים אופסו לברירת המחדל'));
    });
  }

  /**
   * Controls that live inside `#preferencesForm` for layout reasons but are
   * not settings: the tag-management fields and the backup pickers. Typing a
   * tag name must not write the settings and flash "saved automatically" —
   * each keystroke would be a storage write plus a `syncContributions`
   * against the host's RPC budget, for something that is not a preference.
   */
  const NON_SETTING_FIELDS =
    '#manageTagSource, #manageTagTarget, #importMode, #autoBackupSelect';

  function bindPreferences() {
    const form = $('#preferencesForm');
    const isSetting = event => !event.target?.closest?.(NON_SETTING_FIELDS);

    form.addEventListener('input', event => {
      if (!isSetting(event)) return;
      draftSettings = collectPreferencesFromForm();
      updateRangeOutputs();
      applyDisplaySettings();
      scheduleAutoSave(collectPreferencesFromForm, 'preferencesAutoSaveStatus');
    });
    form.addEventListener('change', event => {
      if (!isSetting(event)) return;
      draftSettings = collectPreferencesFromForm();
      applyDisplaySettings();
      scheduleAutoSave(collectPreferencesFromForm, 'preferencesAutoSaveStatus', 150);
    });
    form.addEventListener('submit', event => {
      event.preventDefault();
      scheduleAutoSave(collectPreferencesFromForm, 'preferencesAutoSaveStatus', 0);
    });
    $('#resetPreferencesBtn').addEventListener('click', async () => {
      draftSettings = null;
      await Core.saveSettings(Object.assign({}, Core.settings, {
        menuStyle: D.DEFAULT_SETTINGS.menuStyle,
        appearance: D.structuredCloneSafe(D.DEFAULT_SETTINGS.appearance)
      }));
      renderPreferences();
      await notify.success(t('התצוגה אופסה לברירת המחדל'));
    });

    for (const [id, action] of [['#renameTagBtn', 'rename'], ['#mergeTagBtn', 'merge'], ['#deleteTagBtn', 'delete']]) {
      $(id).addEventListener('click', () =>
        guard(() => transformGlobalTag(action), () => t('עדכון התגית נכשל')));
    }

    $('#exportVisibleHumanBtn').addEventListener('click', () =>
      guard(exportVisible, () => t('ייצוא ההדגשות נכשל')));
    $('#exportBackupBtn').addEventListener('click', () =>
      guard(() => exportBackup(), () => t('ייצוא הגיבוי נכשל')));
    $('#importBackupBtn').addEventListener('click', () => guard(async () => {
      const text = await Core.readFileFromUser(t('בחרו קובץ גיבוי של המרקר'), ['json']);
      if (text != null) await importBackupText(text);
    }, () => t('ייבוא הגיבוי נכשל')));
    $('#restoreAutoBackupBtn').addEventListener('click', () => guard(async () => {
      const path = $('#autoBackupSelect').value;
      if (!path) return;
      await importBackupText(await Core.readAutoBackup(path));
      await renderAutoBackupList();
    }, () => t('שחזור הגיבוי האוטומטי נכשל')));
  }

  /**
   * Runs `action`, reporting any failure as `<message>: <reason>`.
   *
   * `describeFailure` is a function, not a string: these are wired up once at
   * boot, and a string would freeze the message in the language that was
   * active then — the user could switch to English and still get the Hebrew
   * error.
   */
  async function guard(action, describeFailure) {
    try {
      await action();
    } catch (error) {
      const message = describeFailure();
      logger.error(message, error);
      await notify.error(`${message}: ${Core.describeError(error)}`);
    }
  }

  function bindAbout() {
    $('#openHomepageBtn').addEventListener('click', () =>
      callSoft('app.openUrl', { url: Core.HOMEPAGE }));
    $('#openStoreBtn').addEventListener('click', () =>
      callSoft('app.openUrl', { url: Core.STORE_PAGE }));
    $('#createShortcutBtn').addEventListener('click', () => createShortcut('desktop'));
    $('#createStartMenuShortcutBtn').addEventListener('click', () => createShortcut('startMenu'));
    $('#reportForm').addEventListener('submit', submitReport);
  }

  function bindGlobalKeys() {
    document.addEventListener('keydown', event => {
      const modifier = event.ctrlKey || event.metaKey;
      // A modal owns the keyboard while it is open. Jumping to the search box
      // behind it would switch tabs the user cannot see and steal focus from
      // the note they are writing, so every shortcut here waits its turn.
      if ($('#editHighlightDialog').open || $('#addColorDialog').open) return;

      if (modifier && event.key.toLowerCase() === 'f') {
        event.preventDefault();
        $('.tab[data-tab="highlights"]').click();
        requestAnimationFrame(() => $('#highlightSearch').focus());
        return;
      }
      const editable = event.target?.matches?.('input, textarea, select, [contenteditable="true"]');
      if (editable) return;
      if (activeTab() !== 'highlights') return;

      if (modifier && event.key.toLowerCase() === 'a') {
        event.preventDefault();
        selectVisible();
      } else if (event.key === 'Delete' && selectedKeys.size) {
        event.preventDefault();
        $('#deleteSelectedBtn').click();
      } else if (event.key === 'Escape' && selectedKeys.size) {
        event.preventDefault();
        clearSelection();
      }
    });
  }

  function showEngineNotice() {
    const notice = $('#engineNotice');
    const permissions = Core.hostContext.permissions;
    if (!D.hasPermission(permissions, 'app.startup_contributions')) {
      $('#engineNoticeText').textContent =
        t('ההרשאה „תרומות עלייה” כבויה, ולכן תפריט הלחיצה הימנית נרשם רק כשהתוסף פתוח.');
      notice.hidden = false;
      return;
    }
    if (!D.hasPermission(permissions, 'reader.highlight')) {
      $('#engineNoticeText').textContent =
        t('ההרשאה „סימון בקורא” כבויה, ולכן ההדגשות נשמרות אך אינן מצוירות על הטקסט.');
      notice.hidden = false;
      return;
    }
    notice.hidden = true;
  }

  // ── Startup ────────────────────────────────────────────────────────────────

  /**
   * Every `setCustomValidity` message in this page is a one-shot complaint
   * about the value at the moment it was submitted. Left in place it makes the
   * field permanently invalid — and with it the whole form permanently
   * un-submittable — so editing the value withdraws the complaint. Captured on
   * the document so it covers fields inside dialogs too.
   */
  function bindValidityReset() {
    const clear = event => {
      const field = event.target;
      if (field?.validity?.customError) field.setCustomValidity('');
    };
    document.addEventListener('input', clear, true);
    document.addEventListener('change', clear, true);
  }

  let bound = false;

  /** Idempotent: a second `plugin.boot` must not double every listener. */
  function bindAll() {
    if (bound) return;
    bound = true;
    bindValidityReset();
    bindEnhancedSelects();
    bindTabs();
    bindToolbar();
    bindHighlightList();
    bindDialogs();
    bindColorsEditor();
    bindPreferences();
    bindAbout();
    bindGlobalKeys();
    enhanceSelects(document);
  }

  Core.on('boot', ({ theme }) => {
    applyTheme(theme);
    I18n.applyDocumentLanguage(document);
    I18n.translateDocument(document);
    bindAll();
    restoreViewState();
    renderAll();
    showEngineNotice();
    if (Core.pendingPageParam) openFromParam(Core.pendingPageParam);
    if (pendingEditId) {
      const id = pendingEditId;
      pendingEditId = null;
      openEditByHighlightId(id);
    }
    // Powers the "in the open book" chip. Best effort: no reader tab, no chip.
    Core.currentBook().then(book => {
      currentBookFilter = book;
      renderSummaryStrip();
    }).catch(error => logger.warn('Failed reading the current book', error));
  });

  // The reader's right-click menu asked to edit one highlight's note. The
  // click can land before boot finishes — the host queues it while the page
  // it just opened is still loading — so it is replayed once the page is up.
  Core.on('edit-highlight', highlightId => {
    if (!Core.booted || !bound) {
      pendingEditId = highlightId;
      return;
    }
    openEditByHighlightId(highlightId);
  });

  Core.on('highlights', () => {
    const signature = highlightsSignature();
    if (signature === lastRenderSignature) return;
    lastRenderSignature = signature;
    renderHighlights();
  });

  Core.on('settings', () => {
    // Color labels and shades appear on every card, so the list always
    // re-renders; the two forms do not, or they would fight the user's typing.
    renderHighlights();
    if (draftSettings) return;
    renderColorsEditor();
    renderPreferences();
  });

  Core.on('language', applyLanguageToPage);
  Core.on('engine', () => {
    showEngineNotice();
    renderAbout().catch(error => logger.warn('about', error));
  });
  Core.on('page-opened', param => openFromParam(param));

  /** `plugin.openSelf` / a toolbar click can ask for a specific view. */
  function openFromParam(param) {
    const view = typeof param === 'string' ? param : param?.view;
    // Checked against the known tabs rather than interpolated: the value comes
    // from the host, and an unexpected one would build a malformed selector
    // that makes `querySelector` throw.
    if (!D.TABS.includes(view)) return;
    $(`.tab[data-tab="${view}"]`)?.click();
  }

  R.on('theme.changed', theme => {
    applyTheme(theme);
    applyDisplaySettings();
  }, logger);

  // Storage is the authority, and it may have moved on while the page was
  // suspended — a fresh read on resume, but no polling in between: this is
  // the only instance, so nothing else writes.
  R.on('plugin.resumed', () => Core.loadHighlights(), logger);

  Core.start();
})(globalThis);
