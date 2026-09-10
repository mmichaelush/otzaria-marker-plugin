(function (global) {
  'use strict';

  /**
   * The headless engine.
   *
   * Everything that must work whether or not the plugin page is open lives
   * here: settings, the highlight store, the context-menu / toolbar
   * contributions, applying and removing highlights, and the private-space
   * backup. `index.html` loads it and then `marker-ui.js`, which subscribes to
   * the events emitted here and renders them.
   *
   * The engine never touches the DOM, and the plugin runs exactly one instance
   * of it — see `ARCHITECTURE.md`, "מודל המופע היחיד".
   */

  const D = global.MarkerDomain;
  const R = global.MarkerRuntime;
  const I18n = global.MarkerI18n;
  const { call, callRaw, callSoft, notify, CODES, MarkerSdkError } = R;
  const logger = R.createLogger('core');
  const t = (text, vars) => I18n.t(text, vars);

  const PLUGIN_ID = 'com.otzaria-marker';
  const PLUGIN_VERSION = '0.9.5';
  const HOMEPAGE = 'https://github.com/mmichaelush/otzaria-marker-plugin';
  const STORE_PAGE = 'https://otzaria.org/plugins/6a6069b8dd175558ae6e4071';

  const BACKUP_DIR = 'backups';
  const BACKUP_LATEST = `${BACKUP_DIR}/latest.json`;
  /**
   * A destructive operation writes the *pre-operation* state here first.
   *
   * `latest.json` cannot serve as the safety net for one: the operation
   * finishes by scheduling an auto backup, which overwrites `latest.json`
   * with the post-destruction state ten seconds later. These files are named
   * per operation and are never pruned.
   */
  const safetyBackupPath = operation => `${BACKUP_DIR}/before-${operation}.json`;
  const BACKUP_KEEP_DAILY = 5;
  const AUTO_BACKUP_DELAY_MS = 10_000;

  // ── State ──────────────────────────────────────────────────────────────────

  let hostContext = D.normalizeBootContext(null);
  let settings = D.structuredCloneSafe(D.DEFAULT_SETTINGS);
  let highlights = [];
  let isEngine = false;
  let booted = false;
  let capabilities = null;
  let lastMenuSignature = null;
  let autoBackupTimer = null;
  let pendingPageParam = null;

  /** Serializes every host mutation — see MarkerRuntime.createQueue. */
  const enqueue = R.createQueue();

  /**
   * Resolves once `plugin.boot` has finished loading settings and highlights.
   *
   * A click can be what woke this instance: the host queues it and delivers it
   * right after dispatching `plugin.boot`, while our boot handler is still
   * awaiting storage. Acting then would read default settings instead of the
   * user's. The timeout is a backstop so a handler can never hang for good if
   * boot fails outright.
   */
  let markBooted = () => {};
  const bootCompleted = new Promise(resolve => { markBooted = resolve; });

  function whenBooted(timeoutMs = 10_000) {
    if (booted) return Promise.resolve();
    return Promise.race([
      bootCompleted,
      new Promise(resolve => setTimeout(() => {
        logger.warn('Acting before boot completed');
        resolve();
      }, timeoutMs))
    ]);
  }

  const listeners = new Map();

  function on(eventName, listener) {
    if (!listeners.has(eventName)) listeners.set(eventName, new Set());
    listeners.get(eventName).add(listener);
    return () => listeners.get(eventName)?.delete(listener);
  }

  function emit(eventName, detail) {
    for (const listener of listeners.get(eventName) || []) {
      try {
        listener(detail);
      } catch (error) {
        logger.error(`Listener failed for ${eventName}`, error);
      }
    }
  }

  // ── Settings ───────────────────────────────────────────────────────────────

  async function loadSettings() {
    const stored = await callSoft('storage.get', { key: D.SETTINGS_KEY });
    settings = D.normalizeSettings(stored);
    return settings;
  }

  /**
   * Persists settings and reconciles everything derived from them: the
   * interface language, the context-menu contributions, and the style of
   * highlights already drawn in the reader.
   */
  async function saveSettings(next) {
    const previousColors = colorStyleSignature(settings.colors);
    const previousLanguage = settings.language;
    settings = D.normalizeSettings(next);
    await call('storage.set', { key: D.SETTINGS_KEY, value: settings });

    if (settings.language !== previousLanguage && applyLanguage()) {
      emit('language', I18n.language);
    }
    emit('settings', settings);

    await enqueue(() => syncContributions());
    if (colorStyleSignature(settings.colors) !== previousColors) {
      await restyleStoredHighlights();
    }
    scheduleAutoBackup();
    return settings;
  }

  function colorStyleSignature(colors) {
    return JSON.stringify((colors || []).map(color => [
      color.id, D.toSafeHex(color.hex), color.opacity, color.markerMode, color.borderRadius
    ]));
  }

  function applyLanguage() {
    const resolved = I18n.resolveLanguage(settings.language, hostContext.language);
    const direction = settings.language && settings.language !== 'auto'
      ? D.directionForLanguage(resolved)
      : hostContext.textDirection;
    return I18n.configure(resolved, direction);
  }

  // ── Highlight store ────────────────────────────────────────────────────────

  /**
   * Reads every `highlight:` record. Parallel on purpose: sequential reads
   * made boot scale linearly with the number of stored highlights.
   *
   * `silent` suppresses the change event — used during boot, so the page
   * renders once with real data instead of flashing an empty list first.
   */
  async function loadHighlights({ silent = false } = {}) {
    const keys = await callSoft('storage.list', {}, []);
    const highlightKeys = (Array.isArray(keys) ? keys : [])
      .filter(key => String(key).startsWith(D.HIGHLIGHT_PREFIX));
    const records = await Promise.all(highlightKeys.map(async key => {
      const value = await callSoft('storage.get', { key });
      return D.normalizeHighlight(value, key);
    }));
    highlights = records.filter(Boolean).sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    if (!silent) emit('highlights', highlights);
    return highlights;
  }

  function getHighlights() {
    return highlights;
  }

  function findHighlight(key) {
    return highlights.find(item => item.key === key || item.highlightId === key) || null;
  }

  async function persistHighlight(record) {
    const value = Object.assign({}, record);
    delete value.key;
    await call('storage.set', { key: record.key || D.highlightKey(record.highlightId), value });
  }

  async function forgetHighlight(record) {
    await callSoft('storage.remove', { key: record.key || D.highlightKey(record.highlightId) });
    highlights = highlights.filter(item => item.highlightId !== record.highlightId);
  }

  // ── Host reconciliation ────────────────────────────────────────────────────

  /**
   * Brings the host's in-memory highlights in line with the stored ones.
   *
   * Host highlights do not survive an app restart, so on a cold start every
   * record has to be re-drawn; on a warm wake almost nothing has to happen.
   * Both cases are the same operation — one read, then writes only for what is
   * genuinely missing or has drifted.
   */
  async function reconcileHighlights() {
    if (!highlights.length) return { restored: 0, updated: 0 };
    const hostRecords = await callSoft('reader.getHighlights', { includeStale: true }, []);
    const hostById = new Map((Array.isArray(hostRecords) ? hostRecords : [])
      .map(record => [record.highlightId, record]));

    let restored = 0;
    let updated = 0;
    for (const item of highlights) {
      const hostRecord = hostById.get(item.highlightId);
      if (!hostRecord) {
        if (await drawHighlight(item)) restored++;
        continue;
      }
      const patch = {
        version: hostRecord.version ?? item.version,
        etag: hostRecord.etag ?? item.etag,
        status: hostRecord.status || item.status,
        sourceRange: hostRecord.range || item.sourceRange
      };
      const drifted = patch.version !== item.version
        || patch.etag !== item.etag
        || patch.status !== item.status
        || JSON.stringify(patch.sourceRange) !== JSON.stringify(item.sourceRange);
      if (!drifted) continue;
      Object.assign(item, patch);
      await persistHighlight(item).catch(error => logger.warn('Failed persisting drift', error));
      updated++;
    }
    if (restored || updated) emit('highlights', highlights);
    return { restored, updated };
  }

  /** (Re)draws one stored highlight in the reader. */
  async function drawHighlight(item) {
    if (item.status === 'failed_to_anchor') return false;
    const color = D.findColor(settings, item.colorId);
    const response = await callRaw('reader.setHighlight', {
      highlightId: item.highlightId,
      bookId: item.bookId,
      ...(item.bookUid ? { bookUid: item.bookUid } : {}),
      sectionIndex: item.sectionIndex,
      range: item.sourceRange,
      style: D.buildHighlightStyle(item.style || Object.assign({}, color, { hex: item.color })),
      metadata: D.buildHighlightMetadata({
        colorLabel: color.label,
        note: item.note,
        tags: item.tags
      })
    });
    if (!response?.success) {
      logger.warn('Failed drawing highlight', item.highlightId, response?.error?.code);
      return false;
    }
    const patch = {
      version: response.data?.version ?? null,
      etag: response.data?.etag ?? null,
      status: response.data?.status || 'active'
    };
    if (patch.version !== item.version || patch.etag !== item.etag || patch.status !== item.status) {
      Object.assign(item, patch);
      await persistHighlight(item).catch(error => logger.warn('Failed persisting draw', error));
    }
    return true;
  }

  /** Pushes the current color definitions onto highlights already drawn. */
  async function restyleStoredHighlights() {
    let changed = 0;
    for (const item of highlights) {
      const color = settings.colors.find(entry => entry.id === item.colorId);
      if (!color) continue;
      const desired = D.buildHighlightStyle(color);
      if (JSON.stringify(item.style) === JSON.stringify(desired)) continue;
      try {
        await updateHighlight(item, { color, render: false });
        changed++;
      } catch (error) {
        logger.warn('Failed restyling highlight', item.highlightId, error);
      }
    }
    if (changed) emit('highlights', highlights);
    return changed;
  }

  // ── Contributions (context menu, toolbar) ──────────────────────────────────

  /**
   * Updates an item that the manifest already declared.
   *
   * `contributes.startup` registers both menu items at plugin level before any
   * engine exists, so the normal path is a patch — which the host applies to
   * the declarative registration itself and therefore outlives this engine.
   * A fresh `add` is only needed when the declarative contribution is missing,
   * e.g. the user revoked `app.startup_contributions`.
   */
  async function patchOrRegisterMenuItem(payload, allowRegister) {
    const { id, ...patch } = payload;
    try {
      await call('reader.updateContextMenuItem', { id, patch });
      return 'patched';
    } catch (error) {
      if (!(error instanceof MarkerSdkError) || error.code !== CODES.notFound) throw error;
    }
    if (!allowRegister) return 'absent';
    await call('reader.addContextMenuItem', payload);
    return 'registered';
  }

  async function patchOrRegisterToolbarItem(payload, allowRegister) {
    const { id, ...patch } = payload;
    try {
      await call('reader.updateToolbarItem', { id, patch });
      return 'patched';
    } catch (error) {
      if (error instanceof MarkerSdkError && error.isUnsupported) return 'unsupported';
      if (!(error instanceof MarkerSdkError) || error.code !== CODES.notFound) throw error;
    }
    if (!allowRegister) return 'absent';
    return await callSoft('reader.addToolbarItem', payload) ? 'registered' : 'failed';
  }

  /**
   * Aligns the declared contributions with the user's colors and language.
   *
   * Runs from **any** instance, not only the engine: the manifest registers
   * the items at plugin level, so a patch from the visible page updates the
   * same registration the background reads. Without that, changing a color
   * while the background owns the engine would leave a stale menu until the
   * next launch.
   *
   * Registering a *new* item is engine-only, though. A fresh
   * `addContextMenuItem` binds to the calling instance, and the host routes
   * clicks to a visible instance that registered the item — so a page that
   * registered but does not own the engine would swallow every click.
   *
   * Skipped entirely when nothing visible changed: this runs on every boot and
   * every settings save, against a 50-token RPC bucket.
   */
  async function syncContributions({ force = false } = {}) {
    const signature = D.menuSignature(settings, I18n.language);
    if (!force && signature === lastMenuSignature) return false;

    const colorsPayload = D.buildColorMenuPayload(settings, t);
    if (!colorsPayload) {
      logger.warn('No enabled color — keeping the previously registered menu');
      return false;
    }
    try {
      await patchOrRegisterMenuItem(colorsPayload, isEngine);
      await patchOrRegisterMenuItem(D.buildHighlightMenuPayload(t), isEngine);
      await patchOrRegisterToolbarItem(D.buildToolbarPayload(t), isEngine);
      lastMenuSignature = signature;
      return true;
    } catch (error) {
      lastMenuSignature = null;
      logger.error('Failed syncing contributions', error);
      return false;
    }
  }

  /** Ids used by plugin versions <= 0.9.4; harmless if they are not there. */
  async function removeLegacyMenuItems() {
    for (const id of D.LEGACY_MENU_IDS) {
      await callSoft('reader.removeContextMenuItem', { id });
    }
  }

  // ── Reader capabilities ────────────────────────────────────────────────────

  /** Cached per boot: the surface only changes when the user switches tabs,
   *  and we only need it to explain a failure, never to gate the happy path. */
  async function readerCapabilities({ refresh = false } = {}) {
    if (capabilities && !refresh) return capabilities;
    capabilities = await callSoft('reader.getHighlightCapabilities', {}) || null;
    return capabilities;
  }

  /** The book open in the reader right now, for the "this book" quick filter. */
  async function currentBook() {
    const state = await callSoft('reader.getCurrentRef', {});
    const bookId = state?.currentBookId;
    return bookId ? { bookId, title: state.currentBook || bookId } : null;
  }

  /**
   * Why this click could not become a highlight, in the user's words.
   *
   * Three different situations reach the same dead end, and telling them
   * apart is the difference between an actionable message and a shrug: the
   * surface cannot draw highlights at all, the surface can but the host could
   * not anchor the selected text, or there was no selection to begin with.
   */
  async function explainUnavailableSelection(selection) {
    const caps = await readerCapabilities({ refresh: true });
    if (caps && caps.highlights === false) {
      return caps.surface === 'pdf'
        ? t('לא ניתן לסמן טקסט בקובץ PDF. הסימון עובד בספרי טקסט בלבד.')
        : t('התצוגה הנוכחית אינה תומכת בסימון. עברו לתצוגת הטקסט של הספר.');
    }
    if (D.selectedTextOf(selection).trim()) {
      return t('לא ניתן היה לקבע את הטקסט המסומן. נסו לבחור אותו שוב, או לבחור קטע מעט אחר.');
    }
    return t('כדי לסמן צריך לבחור טקסט בספר לפני פתיחת התפריט.');
  }

  // ── Applying highlights ────────────────────────────────────────────────────

  /**
   * Marks a selection with `color`.
   *
   * Since 0.9.97 the host anchors every paragraph of a multi-paragraph
   * selection for us and delivers them in `selection.sections`, so this is a
   * plain loop over ready-made anchors. Parts of one selection share a
   * `groupId` and are always removed together.
   *
   * A half-written multi-paragraph highlight is worse than none, so anything
   * already applied is rolled back if a later part fails.
   */
  async function applyHighlight(color, selection) {
    const targets = D.selectionTargets(selection);
    if (!targets.length) {
      await notify.info(await explainUnavailableSelection(selection));
      return null;
    }
    const bookId = D.bookIdOf(selection);
    if (!bookId) {
      await notify.info(t('לא זוהה הספר הפתוח. נסו לסמן שוב.'));
      return null;
    }

    const overlapping = D.highlightsOverlappingTargets(highlights, bookId, targets);
    const groupId = targets.length > 1 ? D.makeHighlightId(targets[0].sectionIndex, `g-${color.id}`) : null;
    const style = D.buildHighlightStyle(color);
    const created = [];

    try {
      for (const target of targets) {
        const highlightId = D.makeHighlightId(target.sectionIndex, color.id);
        const response = await callRaw('reader.setHighlight', {
          highlightId,
          bookId,
          // The stable identifier the docs recommend storing; the host keeps it
          // on its own record too, and ignores it when absent.
          ...(selection.bookUid ? { bookUid: selection.bookUid } : {}),
          sectionIndex: target.sectionIndex,
          range: target.range,
          style,
          metadata: D.buildHighlightMetadata({ colorLabel: color.label })
        });
        if (!response?.success) throw new MarkerSdkError('reader.setHighlight', response);

        const record = D.normalizeHighlight({
          highlightId,
          groupId,
          bookId,
          bookUid: selection.bookUid || null,
          book: D.bookTitleOf(selection),
          sectionIndex: target.sectionIndex,
          colorId: color.id,
          color: color.hex,
          style,
          text: target.text,
          ref: selection.currentRef || '',
          sourceRange: target.range,
          version: response.data?.version ?? null,
          etag: response.data?.etag ?? null,
          status: response.data?.status || 'active',
          timestamp: Date.now()
        });
        // The host drew the mark, but the record we would store came back
        // unusable. Leaving it would be an orphan: visible in the reader,
        // absent from the list, and impossible to remove from the UI.
        if (!record) {
          await callSoft('reader.clearHighlight', { highlightId });
          throw new Error(t('לא ניתן לשמור את ההדגשה, והסימון בוטל'));
        }
        await persistHighlight(record);
        created.push(record);
      }
    } catch (error) {
      for (const record of created) {
        await callSoft('reader.clearHighlight', { highlightId: record.highlightId });
        await callSoft('storage.remove', { key: record.key });
      }
      logger.error('Failed applying highlight', error);
      await notify.error(t('הסימון נכשל: {reason}', { reason: describeError(error) }));
      return null;
    }

    // The new marks replaced these; drop them only now that the new ones stuck.
    for (const item of overlapping) await clearHighlightRecord(item);

    highlights = [...created, ...highlights.filter(item =>
      !created.some(record => record.highlightId === item.highlightId))]
      .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    emit('highlights', highlights);
    scheduleAutoBackup();
    await notify.success(t('נשמר ב{color} ✓', { color: t(color.label) }));
    return created;
  }

  /** Clears one record from both the reader and plugin storage. */
  async function clearHighlightRecord(item) {
    if (item.highlightId) {
      try {
        await call('reader.clearHighlight', { highlightId: item.highlightId });
      } catch (error) {
        const missing = error instanceof MarkerSdkError
          && [CODES.highlightNotFound, CODES.notFound].includes(error.code);
        if (!missing) throw error;
      }
    }
    await forgetHighlight(item);
  }

  /**
   * Removes the highlights under a right-click in the `reader-highlight`
   * context. The host tells us exactly which ones were clicked, so there is no
   * guessing from ranges any more.
   */
  async function removeClickedHighlights(selection) {
    const ids = D.clickedHighlightIds(selection, hostContext.pluginId || PLUGIN_ID);
    const direct = highlights.filter(item => ids.includes(item.highlightId));
    const targets = D.expandByGroup(direct, highlights);
    if (!targets.length) {
      // Owned by the host record but missing from our store — clear it anyway
      // so the user is not left with a mark they cannot remove.
      for (const id of ids) await callSoft('reader.clearHighlight', { highlightId: id });
      if (!ids.length) await notify.info(t('אין כאן הדגשה של מרקר.'));
      return 0;
    }
    let removed = 0;
    for (const item of targets) {
      try {
        await clearHighlightRecord(item);
        removed++;
      } catch (error) {
        logger.error('Failed removing highlight', item.highlightId, error);
      }
    }
    emit('highlights', highlights);
    scheduleAutoBackup();
    await notify.success(removed > 1
      ? t('הסימון הוסר מכל השורות')
      : t('ההדגשה הוסרה'));
    return removed;
  }

  /**
   * Edits an existing highlight's color, note, tags or favourite flag.
   *
   * The host record is authoritative for `version`/`etag`; a mid-air collision
   * (`error.conflict`) is resolved by re-reading it once, and a record the host
   * has forgotten is re-created from the stored anchor.
   */
  async function updateHighlight(item, {
    color, note, noteHtml, tags, favorite, render = true
  } = {}) {
    const nextColor = color || D.findColor(settings, item.colorId);
    const nextNote = note === undefined ? item.note : String(note || '').slice(0, D.MAX_NOTE_LENGTH);
    // The caller sanitizes; the length cap here is the storage contract.
    const nextNoteHtml = noteHtml === undefined
      ? item.noteHtml
      : String(noteHtml || '').slice(0, D.MAX_NOTE_HTML_LENGTH);
    const nextTags = D.normalizeTags(tags === undefined ? item.tags : tags);
    const style = D.buildHighlightStyle(nextColor);
    const metadata = D.buildHighlightMetadata({
      colorLabel: nextColor.label, note: nextNote, tags: nextTags
    });

    const readHostRecord = async () => {
      const records = await callSoft('reader.getHighlights', { includeStale: true }, []);
      return (Array.isArray(records) ? records : [])
        .find(record => record.highlightId === item.highlightId) || null;
    };
    const recreate = () => call('reader.setHighlight', {
      highlightId: item.highlightId,
      bookId: item.bookId,
      sectionIndex: item.sectionIndex,
      range: item.sourceRange,
      style,
      metadata
    });
    // Optimistic concurrency: both guards come from the record we just read,
    // so they agree. Each is sent only when the host would accept it — the
    // host rejects a non-positive `expectedVersion` outright, which would turn
    // a plain edit into `error.invalid_params`.
    const patch = record => call('reader.updateHighlight', {
      highlightId: item.highlightId,
      ...(Number.isInteger(record.version) && record.version > 0
        ? { expectedVersion: record.version } : {}),
      ...(typeof record.etag === 'string' && record.etag ? { expectedEtag: record.etag } : {}),
      style,
      metadata
    });

    let hostRecord = await readHostRecord();
    let result;
    try {
      result = hostRecord ? await patch(hostRecord) : await recreate();
    } catch (error) {
      const recoverable = error instanceof MarkerSdkError
        && [CODES.conflict, CODES.highlightNotFound, CODES.notFound].includes(error.code);
      if (!recoverable) throw error;
      hostRecord = await readHostRecord();
      result = hostRecord ? await patch(hostRecord) : await recreate();
    }

    Object.assign(item, {
      colorId: nextColor.id,
      color: D.toSafeHex(nextColor.hex),
      style,
      note: nextNote,
      noteHtml: nextNoteHtml,
      tags: nextTags,
      favorite: favorite === undefined ? item.favorite : favorite === true,
      version: result?.version ?? item.version,
      etag: result?.etag ?? item.etag,
      status: result?.status || item.status
    });
    await persistHighlight(item);
    if (render) emit('highlights', highlights);
    scheduleAutoBackup();
    return item;
  }

  async function deleteHighlights(items) {
    const targets = D.expandByGroup(items, highlights);
    const deleted = [];
    for (const item of targets) {
      try {
        await clearHighlightRecord(item);
        deleted.push(item);
      } catch (error) {
        logger.error('Failed deleting highlight', item.highlightId, error);
      }
    }
    emit('highlights', highlights);
    scheduleAutoBackup();
    return deleted;
  }

  /** Restores records that were just deleted (the undo bar). */
  async function restoreHighlights(records) {
    let failed = 0;
    for (const raw of records) {
      const item = D.normalizeHighlight(raw);
      if (!item) { failed++; continue; }
      try {
        await persistHighlight(item);
        await drawHighlight(item);
        highlights.push(item);
      } catch (error) {
        failed++;
        logger.error('Failed restoring highlight', raw?.highlightId, error);
      }
    }
    highlights.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    emit('highlights', highlights);
    scheduleAutoBackup();
    return { restored: records.length - failed, failed };
  }

  async function deleteAllHighlights() {
    await writeSafetyBackup('delete-all');
    await callSoft('reader.clearAllHighlights', {});
    for (const item of highlights) {
      await callSoft('storage.remove', { key: item.key });
    }
    highlights = [];
    emit('highlights', highlights);
    scheduleAutoBackup();
  }

  async function revealHighlight(item) {
    try {
      if (await call('reader.revealHighlight', { highlightId: item.highlightId }) === true) return true;
    } catch (error) {
      logger.warn('revealHighlight unavailable, falling back to openBook', error?.code || error);
    }
    // The identifier, not the display title: `item.book` is what the user
    // sees on the card, and the two differ whenever the host gives a stable id.
    const bookId = item.bookId || item.book;
    if (!bookId) throw new Error(t('לא נשמר מזהה ספר'));
    const opened = item.ref
      ? await call('reader.openBookAtRef', { bookId, ref: item.ref, index: item.sectionIndex, highlight: true })
      : await call('reader.openBook', { bookId, index: item.sectionIndex });
    if (opened !== true) throw new Error(t('אוצריא לא מצאה את הספר השמור'));
    return true;
  }

  // ── Backup ─────────────────────────────────────────────────────────────────

  function buildBackup(items) {
    return D.buildBackup(settings, items || highlights, PLUGIN_VERSION);
  }

  /**
   * Writes the current state aside before something destructive happens, so
   * there is always one file holding the state the user had a moment ago.
   *
   * Awaited, not debounced: the point is that it lands *before* the damage.
   * A failure is not fatal — the operation still runs — but it is logged.
   *
   * @param {'import'|'delete-all'} operation
   */
  async function writeSafetyBackup(operation) {
    if (!highlights.length) return null;
    const written = await callSoft('fs.writeFile', {
      path: safetyBackupPath(operation),
      content: JSON.stringify(buildBackup())
    });
    if (!written) logger.warn('Safety backup could not be written', operation);
    return written || null;
  }

  /**
   * Snapshots everything into the plugin's private space (0.9.97) — no
   * permission, no dialog, and it is included in Otzaria's own backup.
   * Debounced because a bulk edit fires one mutation per record.
   */
  function scheduleAutoBackup() {
    if (!settings.autoBackup) return;
    if (autoBackupTimer) clearTimeout(autoBackupTimer);
    autoBackupTimer = setTimeout(() => {
      autoBackupTimer = null;
      writeAutoBackup().catch(error => logger.warn('Auto backup failed', error));
    }, AUTO_BACKUP_DELAY_MS);
  }

  async function writeAutoBackup() {
    const content = JSON.stringify(buildBackup());
    const written = await callSoft('fs.writeFile', { path: BACKUP_LATEST, content });
    if (!written) return null;
    const today = new Date().toISOString().slice(0, 10);
    await callSoft('fs.writeFile', { path: `${BACKUP_DIR}/daily-${today}.json`, content });
    await pruneDailyBackups();
    logger.debug('Auto backup written', written.usedBytes, '/', written.quotaBytes);
    return written;
  }

  async function pruneDailyBackups() {
    const listing = await callSoft('fs.listDir', { path: BACKUP_DIR });
    const daily = (listing?.entries || [])
      .filter(entry => entry.type === 'file' && entry.name.startsWith('daily-'))
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of daily.slice(0, Math.max(0, daily.length - BACKUP_KEEP_DAILY))) {
      await callSoft('fs.deleteEntry', { path: entry.path });
    }
  }

  async function listAutoBackups() {
    const listing = await callSoft('fs.listDir', { path: BACKUP_DIR });
    return (listing?.entries || [])
      .filter(entry => entry.type === 'file' && entry.name.endsWith('.json'))
      .sort((a, b) => String(b.modified || '').localeCompare(String(a.modified || '')));
  }

  async function readAutoBackup(path) {
    const file = await call('fs.readFile', { path });
    return file?.content || '';
  }

  /**
   * Writes a file the user picks a location for. The bytes go over the
   * loopback upload channel rather than the JSON-RPC bridge, which is the only
   * export path the host actually supports inside its WebView.
   */
  async function saveFileAs(text, suggestedName, extension, mimeType) {
    const blob = new Blob([text], { type: `${mimeType};charset=utf-8` });
    const upload = await call('fs.beginBinaryWrite', { purpose: 'user-file', expectedSize: blob.size });
    try {
      const response = await fetch(upload.uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Type': blob.type },
        body: blob
      });
      if (!response.ok) throw new Error(`upload failed with HTTP ${response.status}`);
    } catch (error) {
      await callSoft('fs.abortBinaryWrite', { writeToken: upload.writeToken });
      throw error;
    }
    return await call('fs.commitUserFileWrite', {
      writeToken: upload.writeToken,
      suggestedName,
      extension,
      title: t('שמירת קובץ')
    });
  }

  /** Reads a file the user picks. The token is always revoked afterwards. */
  async function readFileFromUser(title, extensions) {
    const picked = await call('fs.pickUserFile', { title, extensions });
    if (!picked || picked.cancelled) return null;
    try {
      return await call('fs.readTextFile', { token: picked.token });
    } finally {
      await callSoft('fs.revokeFile', { token: picked.token });
    }
  }

  /** Replaces or merges the store from a parsed backup, with rollback. */
  async function importBackup(backup, { replace = false } = {}) {
    await writeSafetyBackup('import');
    const snapshot = {
      settings: D.structuredCloneSafe(settings),
      highlights: highlights.map(item => D.structuredCloneSafe(item))
    };
    const plan = D.planImport(highlights, backup.highlights);
    const incoming = replace ? backup.highlights : [...plan.added, ...plan.updated];
    try {
      if (replace) {
        await callSoft('reader.clearAllHighlights', {});
        for (const item of highlights) await callSoft('storage.remove', { key: item.key });
      } else {
        for (const item of plan.updated) {
          await callSoft('reader.clearHighlight', { highlightId: item.highlightId });
        }
      }
      settings = D.normalizeSettings(backup.settings);
      await call('storage.set', { key: D.SETTINGS_KEY, value: settings });
      for (const item of incoming) {
        await call('storage.set', { key: D.highlightKey(item.highlightId), value: item });
      }
      await loadHighlights();
      await reconcileHighlights();
      // The backup carries the language preference too, so the page has to be
      // told to re-translate — not just to re-render.
      if (applyLanguage()) emit('language', I18n.language);
      emit('settings', settings);
      await enqueue(() => syncContributions({ force: true }));
      scheduleAutoBackup();
      return { plan, replaced: replace, imported: incoming.length };
    } catch (error) {
      logger.error('Import failed — rolling back', error);
      const rollback = await rollbackTo(snapshot).catch(rollbackError => {
        logger.error('Rollback failed', rollbackError);
        return { failed: snapshot.highlights.length + 1 };
      });
      // Never let a partial rollback pass as a clean one: the user has to know
      // that some records did not come back, and where the copy of them is.
      if (rollback.failed > 0) {
        // One literal, not a concatenation: the catalog is keyed by the
        // Hebrew source string, and the extractor reads a single literal.
        await notify.error(t('הייבוא נכשל, והשחזור למצב הקודם הצליח רק חלקית ({failed} רשומות). עותק של המצב שלפני הייבוא נשמר בקובץ {path}.',
          { failed: rollback.failed, path: safetyBackupPath('import') }));
      }
      throw error;
    }
  }

  /**
   * Puts `snapshot` back after a failed import.
   *
   * Every step is soft on purpose: a rollback that throws halfway leaves the
   * user worse off than one that keeps going. The failures are *counted*
   * though, because "restored" is a claim the caller must not make unless it
   * is true.
   *
   * @returns {Promise<{restored: number, failed: number}>}
   */
  async function rollbackTo(snapshot) {
    await callSoft('reader.clearAllHighlights', {});
    await loadHighlights();
    for (const item of highlights) await callSoft('storage.remove', { key: item.key });

    let failed = 0;
    settings = D.normalizeSettings(snapshot.settings);
    if (!await callSoft('storage.set', { key: D.SETTINGS_KEY, value: settings }, false)) {
      failed += 1;
    }
    for (const item of snapshot.highlights) {
      const value = Object.assign({}, item);
      delete value.key;
      const written = await callSoft(
        'storage.set', { key: D.highlightKey(item.highlightId), value }, false);
      if (!written) failed += 1;
    }
    await loadHighlights();
    await reconcileHighlights();
    emit('settings', settings);
    return { restored: snapshot.highlights.length - failed, failed };
  }

  // ── Printing and the unsaved-work flag ─────────────────────────────────────

  /**
   * `ui.exportPdf` renders the plugin page itself, so the page styles it for
   * paper through `@media print`. It checks for a *transient user activation*
   * in the WebView, which cannot be faked: it must be called straight from a
   * click handler, never after a long `await` chain.
   *
   * Printing deliberately does **not** go through `ui.print`. That call jumps
   * straight to the operating system's print dialog with no preview and no
   * page range; `window.print()` opens the engine's own print window, which
   * appears inside Otzaria and shows what will actually come out. Page size
   * there comes from the `@page` rule in the stylesheet, not from here.
   */
  async function exportPdf(options = {}) {
    return await call('ui.exportPdf', Object.assign({
      fileName: t('הדגשות מרקר'),
      title: t('ייצוא ל-PDF'),
      pageSize: 'a4',
      orientation: 'portrait',
      marginMm: 14,
      printBackgrounds: true
    }, options));
  }

  /**
   * Marks the tab as holding unsaved work, so closing it asks first. A safety
   * net only — it does not survive a crash, and it is cleared the moment the
   * note is saved.
   */
  function setUnsavedChanges(hasChanges, message) {
    return callSoft('ui.setUnsavedChanges', {
      hasChanges: Boolean(hasChanges),
      ...(message ? { message } : {})
    });
  }

  // ── Feedback ───────────────────────────────────────────────────────────────

  async function hasReporterEmail() {
    return await callSoft('feedback.hasReporterEmail', {}, false) === true;
  }

  /**
   * Sends a user report to the Otzaria site, which routes it to the plugin
   * author. The host always shows its own confirmation dialog, and the call
   * manages its own timeout — never wrap it in one.
   */
  async function sendReport({ details, reportType = 'other', reporterEmail = '' }) {
    const body = [
      details,
      '',
      `--- ${t('פרטי סביבה')} ---`,
      `${t('גרסת התוסף')}: ${PLUGIN_VERSION}`,
      `${t('גרסת אוצריא')}: ${hostContext.appVersion}`,
      `${t('מערכת')}: ${hostContext.platform}`,
      `${t('שפה')}: ${I18n.language}`,
      `${t('מספר הדגשות')}: ${highlights.length}`
    ].join('\n');
    return await call('feedback.report', {
      details: body.slice(0, 5000),
      reportType,
      ...(reporterEmail ? { reporterEmail } : {})
    });
  }

  function describeError(error) {
    if (!(error instanceof MarkerSdkError)) return error?.message || t('שגיאה לא ידועה');
    switch (error.code) {
      case CODES.permissionDenied:
      case 'error.permission_denied':
        return t('חסרה הרשאה. אפשר לאשר אותה בהגדרות התוסף.');
      case CODES.rateLimited: return t('יותר מדי פעולות בבת אחת. נסו שוב בעוד רגע.');
      case CODES.conflict: return t('ההדגשה השתנתה במקביל. נסו שוב.');
      case CODES.highlightNotFound: return t('ההדגשה אינה פעילה בקורא.');
      case CODES.invalidParams: return t('אוצריא דחתה את הנתונים: {message}', { message: error.hostMessage });
      case CODES.timeout: return t('הפעולה לקחה יותר מדי זמן. נסו שוב.');
      default: return error.hostMessage || error.code;
    }
  }

  // ── Menu & command handlers ────────────────────────────────────────────────
  //
  // **Click events are never gated on `isEngine`.** The host delivers a
  // targeted event (a menu click, a toolbar click, a shortcut) to exactly one
  // instance — `dispatchEventToPlugin` picks a single controller — so there is
  // no double-handling to prevent, and gating them was an outright bug: a
  // click routed to an instance whose `isEngine` was `false` vanished without
  // a trace.
  //
  // A click can also be what wakes the instance, so every handler waits for
  // `whenBooted()` before it reads the settings.

  async function onColorClicked(data) {
    const colorId = D.colorIdFromItemId(data?.colorId);
    // Settings may still be loading if this click is what woke the instance.
    if (!booted) await whenBooted();
    const color = settings.colors.find(entry => entry.id === colorId);
    if (!color) {
      logger.warn('Unknown color clicked', data?.colorId);
      return;
    }
    await enqueue(() => applyHighlight(color, data?.selection));
  }

  async function onMenuItemClicked(data) {
    const itemId = String(data?.itemId || '');

    if (itemId === D.MENU_NOTE_ID) {
      const ids = D.clickedHighlightIds(data?.selection, hostContext.pluginId || PLUGIN_ID);
      if (ids.length) emit('edit-highlight', ids[0]);
      return;
    }
    if (!booted) await whenBooted();

    if (itemId === D.MENU_REMOVE_ID) {
      await enqueue(() => removeClickedHighlights(data?.selection));
    } else {
      const color = settings.colors.find(entry => entry.id === D.colorIdFromItemId(itemId));
      if (color) await enqueue(() => applyHighlight(color, data?.selection));
    }
  }

  /** Keyboard shortcuts declared in `contributes.startup.shortcuts`. */
  async function onCommand(data) {
    const command = String(data?.command || '');
    if (command === D.COMMAND_OPEN_PANEL) {
      await callSoft('plugin.openSelf', { param: { view: 'highlights' } });
      return;
    }
    if (command !== D.COMMAND_HIGHLIGHT_DEFAULT) return;
    if (!booted) await whenBooted();
    const selection = await callSoft('reader.getSelection', {});
    await enqueue(() => applyHighlight(D.defaultColor(settings), selection));
  }

  /**
   * The source text of a section the user has open changed, so the host
   * re-anchored our highlights. Read the authoritative state back rather than
   * guessing which anchors moved.
   */
  async function onSectionContentChanged(change) {
    if (!isEngine || change?.changeType !== 'source-content') return;
    await enqueue(async () => {
      await loadHighlights();
      await reconcileHighlights();
    });
  }

  /**
   * The user changed a permission in the plugin settings. Ownership itself
   * cannot change any more — there is only ever one instance — but granting
   * `reader.context_menu` or `app.startup_contributions` back means the
   * contributions have to be re-registered, and regaining `reader.highlight`
   * means the marks have to be re-drawn.
   */
  async function onPermissionsChanged(data) {
    const permissions = Array.isArray(data?.permissions) ? data.permissions : [];
    hostContext = Object.freeze(Object.assign({}, hostContext, { permissions }));
    emit('engine', isEngine);
    await enqueue(async () => {
      await reconcileHighlights();
      await syncContributions({ force: true });
    });
  }

  /** The user switched Otzaria's interface language while we were running. */
  async function onSettingsChanged(data) {
    if (data?.key !== I18n.LANGUAGE_SETTING_KEY) return;
    const language = String(data.newValue || '').toLowerCase();
    if (!language) return;
    hostContext = Object.freeze(Object.assign({}, hostContext, {
      language,
      textDirection: D.directionForLanguage(language)
    }));
    if (settings.language !== 'auto') return;   // An explicit choice wins.
    if (!applyLanguage()) return;
    emit('language', I18n.language);
    await enqueue(() => syncContributions());
  }

  // ── Boot ───────────────────────────────────────────────────────────────────

  async function boot(payload) {
    hostContext = D.normalizeBootContext(payload);
    isEngine = D.ownsEngine(hostContext);

    // Read the stored state before announcing boot, so the page's first render
    // already has the settings and the highlights.
    await loadSettings();
    applyLanguage();
    await loadHighlights({ silent: true });
    booted = true;
    markBooted();
    emit('boot', { hostContext, settings, isEngine, theme: payload?.theme });

    await enqueue(async () => {
      await removeLegacyMenuItems();
      await syncContributions({ force: true });
      // Drawing the stored marks is the reason this instance must stay alive:
      // the host erases them when it goes away.
      await reconcileHighlights();
    });
  }

  function start() {
    R.on('plugin.boot', boot, logger);
    // `contextMenu.itemClicked` always fires; `reader.context_menu_item_clicked`
    // fires *in addition* for items without a custom onClickEvent, so handling
    // only the first avoids acting on the same click twice.
    R.on('contextMenu.colorClicked', onColorClicked, logger);
    R.on('contextMenu.itemClicked', onMenuItemClicked, logger);
    R.on('app.command', onCommand, logger);
    R.on('reader.sectionContentChanged', onSectionContentChanged, logger);
    R.on('plugin.permissions_changed', onPermissionsChanged, logger);
    R.on('settings.changed', onSettingsChanged, logger);
    // The reader toolbar button declares `openPlugin`, so the host opens the
    // page and delivers the click to it. Without this the page would land on
    // whichever tab was open last — a button labelled "manage highlights"
    // that opens the settings screen.
    R.on('reader.toolbar_item_clicked', data => {
        if (String(data?.itemId || '') === D.TOOLBAR_ITEM_ID) emit('page-opened', { view: 'highlights' });
    }, logger);
    R.on('plugin.page_opened', data => {
      pendingPageParam = data?.param ?? null;
      emit('page-opened', pendingPageParam);
    }, logger);
  }

  global.MarkerCore = Object.freeze({
    PLUGIN_ID, PLUGIN_VERSION, HOMEPAGE, STORE_PAGE,
    start, on,
    get hostContext() { return hostContext; },
    get settings() { return settings; },
    get isEngine() { return isEngine; },
    get booted() { return booted; },
    get pendingPageParam() { return pendingPageParam; },
    getHighlights, findHighlight, loadHighlights, reconcileHighlights,
    loadSettings, saveSettings, applyLanguage,
    syncContributions, readerCapabilities, currentBook,
    applyHighlight, updateHighlight, deleteHighlights, restoreHighlights,
    deleteAllHighlights, revealHighlight,
    buildBackup, importBackup, saveFileAs, readFileFromUser,
    writeAutoBackup, listAutoBackups, readAutoBackup,
    exportPdf, setUnsavedChanges,
    hasReporterEmail, sendReport, describeError
  });
})(globalThis);
