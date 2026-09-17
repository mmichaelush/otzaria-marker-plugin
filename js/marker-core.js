(function (global) {
  'use strict';

  /**
   * The headless engine.
   *
   * Everything that must work whether or not the plugin page is open lives
   * here: settings, the highlight store, the context-menu / toolbar
   * contributions, applying and removing highlights, and the private-space
   * backup.
   *
   * Several pages load it, in any number of Otzaria windows.
   * `background.html` is the engine — Otzaria keeps it alive with no UI, so
   * the marks stay on the page and a click on a colour is handled where the
   * user is instead of throwing them into the plugin tab. `index.html` loads
   * the same module and does everything it can too.
   *
   * **Every instance draws.** The host keys highlight records on
   * `(pluginId, instanceId)` and paints the union de-duplicated by
   * `(pluginId, highlightId)`, so the same mark held by four instances is one
   * mark on the page, and the copy owned by the instance the user is looking
   * at wins. Electing one owner instead is the mistake this design is a
   * correction of: every time the election was wrong — the engine idled out,
   * the permission was refused, the click went elsewhere — nothing was painted
   * at all. A redundant copy costs one RPC; a missing one costs the feature.
   *
   * Instances find out about each other's writes through a token in storage
   * (`MarkerDomain.REVISION_KEY`) — there is no message channel between plugin
   * instances. See `docs/ARCHITECTURE.md`, "בעלות על ההדגשות".
   *
   * The engine never touches the DOM.
   */

  const D = global.MarkerDomain;
  const R = global.MarkerRuntime;
  const I18n = global.MarkerI18n;
  const { call, callRaw, callSoft, notify, CODES, MarkerSdkError } = R;
  const logger = R.createLogger('core');
  const t = (text, vars) => I18n.t(text, vars);

  const PLUGIN_ID = 'com.otzaria-marker';
  const PLUGIN_VERSION = '0.9.6';
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
  /**
   * How often an instance checks whether the *other* one changed something.
   *
   * One `storage.get` of a short string, against an RPC bucket of 50 tokens
   * that refills one per 10ms — negligible. It is a poll because the SDK has
   * no instance-to-instance channel and no event for a storage write: the
   * alternative was for the plugin page to wait for the next reader navigation
   * before the colour it just changed appeared on the page.
   */
  const REVISION_POLL_MS = 1500;
  /**
   * A selection has to settle before the eraser is added to or removed from
   * the colour row — a drag fires this event per pointer move.
   */
  const SELECTION_DEBOUNCE_MS = 120;

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
  /** Otzaria's own display preferences that the plugin has to mirror. */
  let hostDisplaySettings = { replace: false, style: D.HOLY_NAME_STYLES[0] };
  let holyNamePolicy = D.resolveHolyNamePolicy('auto', hostDisplaySettings);
  /** Books whose marks are hidden for now — the reader toolbar button. */
  let mutedBooks = [];
  /** The last value this instance wrote to the host-readable toolbar flag. */
  let lastToolbarFlag = null;
  /**
   * The last value this instance saw in the shared change marker.
   *
   * `null` until the first read establishes a baseline. It is a token rather
   * than a counter on purpose: a counter is read-modify-write, and two
   * instances that happen to increment the same value would land on the same
   * number and each conclude that nothing had changed. All that is needed is
   * "different from what I last saw".
   */
  let revision = null;
  let revisionTimer = null;
  let selectionTimer = null;
  /**
   * Whether the eraser is currently registered in the colour row.
   *
   * Starts `false`: the rule is "only over an existing mark", and before any
   * selection has been reported there is no mark under one. It is switched on
   * wholesale when the plugin cannot watch selections at all — see
   * `eraserFollowsSelection`.
   */
  let eraserInMenu = false;
  /**
   * Whether the last read of the highlight store returned all of it.
   *
   * `reconcileHighlights` takes marks *off* the page by comparing what is
   * drawn against what is stored, so it is only allowed to do that while this
   * is true. A partial read plus a confident sweep is how a user loses the
   * sight of their marks without losing the marks.
   */
  let storeComplete = false;
  /**
   * This instance wrote while it was behind another one, so the change marker
   * now says "you are current" when it is not. Cleared by the next reload.
   */
  let staleView = false;

  /**
   * How many stored highlights are read at once.
   *
   * Small enough that the host's throttle is never the reason a record goes
   * missing, large enough that boot does not scale linearly with the number of
   * marks — see the pacing note in `MarkerRuntime`.
   */
  const STORAGE_READ_CONCURRENCY = 6;

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
    // The timer is cleared by whichever side wins. `Promise.race` does not
    // cancel the loser, so without this every call logged "acting before boot"
    // ten seconds later — including the calls where boot had won.
    let timer = null;
    return Promise.race([
      bootCompleted,
      new Promise(resolve => {
        timer = setTimeout(() => {
          logger.warn('Acting before boot completed');
          resolve();
        }, timeoutMs);
      })
    ]).finally(() => {
      if (timer !== null) clearTimeout(timer);
    });
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

  // ── Cross-instance change marker ───────────────────────────────────────────

  /**
   * Announces "storage moved on" to the other live instance.
   *
   * Called after every write the other side would want to see. Failure is not
   * fatal: the next poll re-reads anyway, the page also re-reads on
   * `plugin.resumed` (registered in `marker-ui.js`, so the engine has no such
   * handler), and the engine re-reads whenever the reader reports a section
   * change.
   */
  async function bumpRevision() {
    // Read before writing, because writing is how an instance declares itself
    // up to date — and it has no right to declare that if someone else wrote
    // while it was not looking.
    //
    // Two windows marking at the same moment is the case that breaks: window
    // one writes its token, window two writes its own a moment later without
    // having polled in between. Window one sees a token it did not write and
    // reloads, but window two now matches storage exactly and concludes there
    // is nothing to fetch — so the mark made in window one never reaches it,
    // and nothing later disturbs the token to correct that.
    const stored = await callSoft('storage.get', { key: D.REVISION_KEY });
    if (revision !== null && typeof stored === 'string' && stored !== revision) {
      staleView = true;
    }
    revision = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    await callSoft('storage.set', { key: D.REVISION_KEY, value: revision });
  }

  /**
   * Re-reads storage when another instance changed something — or when our own
   * last read of it came back incomplete.
   *
   * The second half is not an optimisation. `reconcileHighlights` refuses to
   * erase anything while the store view is partial, which is right, but on its
   * own it only made the damage permanent: the token had not changed, so this
   * returned early on every tick and the records that failed to read stayed
   * missing from the list and off the page until the app was restarted. One
   * transient storage hiccup at launch cost the user a highlight for the whole
   * session. Retrying the read is the other half of the same rule.
   */
  async function pollRevision() {
    const stored = await callSoft('storage.get', { key: D.REVISION_KEY });
    const next = typeof stored === 'string' ? stored : '';
    // Three reasons to go back to storage, and only one of them is the token:
    // somebody else wrote, our own last read came back short (`storeComplete`),
    // or we wrote while behind and know it (`staleView`).
    const behind = !storeComplete || staleView;
    if (next === revision && !behind) return false;
    // A first read only establishes the baseline; there is nothing to reload.
    const isFirstRead = revision === null;
    revision = next;
    if (isFirstRead && !behind) return false;
    staleView = false;
    await loadSettings();
    if (applyLanguage()) emit('language', I18n.language);
    await loadMutedBooks();
    await loadHighlights();
    emit('settings', settings);
    // The toolbar gate is evaluated from a snapshot this window owns.
    await syncToolbarFlag();
    // Every instance repaints, not only the engine: each owns its own copies,
    // the host paints the set once, and an instance that skipped this would
    // keep showing the colour, the note or the very mark that another
    // instance has just changed or deleted.
    await enqueue(async () => {
      await syncContributions();
      await reconcileHighlights();
    });
    return true;
  }

  function startRevisionWatch() {
    if (revisionTimer) return;
    revisionTimer = setInterval(() => {
      pollRevision().catch(error => logger.debug('Revision poll failed', error));
    }, REVISION_POLL_MS);
  }

  function stopRevisionWatch() {
    if (!revisionTimer) return;
    clearInterval(revisionTimer);
    revisionTimer = null;
  }

  // ── Settings ───────────────────────────────────────────────────────────────

  async function loadSettings() {
    const stored = await callSoft('storage.get', { key: D.SETTINGS_KEY });
    settings = D.normalizeSettings(stored);
    holyNamePolicy = D.resolveHolyNamePolicy(settings.holyNames, hostDisplaySettings);
    return settings;
  }

  /**
   * Reads the two Otzaria preferences the plugin has to agree with, so a
   * marked verse reads here exactly as it reads in the book.
   *
   * `settings.getMany` and not `settings.get`: a key the host blocks is simply
   * absent from the map, where `get` would reject and take the boot with it.
   */
  async function loadHostDisplaySettings() {
    const values = await callSoft('settings.getMany', {
      keys: [D.HOST_HOLY_NAME_KEY, D.HOST_HOLY_NAME_STYLE_KEY]
    }, {}) || {};
    hostDisplaySettings = {
      replace: values[D.HOST_HOLY_NAME_KEY] === true,
      style: String(values[D.HOST_HOLY_NAME_STYLE_KEY] || D.HOLY_NAME_STYLES[0])
    };
    holyNamePolicy = D.resolveHolyNamePolicy(settings.holyNames, hostDisplaySettings);
    return hostDisplaySettings;
  }

  /**
   * The reader toolbar button is gated in the manifest on
   * `when: { storage: { key: 'marker_toolbar_button' } }`, which the host
   * evaluates without running a line of plugin code. That condition can only
   * read a whole stored value, so the flag lives in its own key and this keeps
   * it in step with the settings object the user actually edits.
   *
   * **Every window has to write it for itself.** `PluginConditionEvaluator`
   * holds an in-memory snapshot per isolate and refreshes it from
   * `onStorageValueChanged` — which fires only in the window that wrote. A
   * window that learns about the change through the shared store would keep
   * showing the old toolbar until it was restarted; writing the value it just
   * read is what refreshes its own evaluator. Writing the same value again is
   * harmless and is not a change, so this cannot ping-pong between windows.
   */
  async function syncToolbarFlag() {
    const value = settings.toolbarButton === true;
    if (value === lastToolbarFlag) return;
    // Latched only once the write landed. Latching first meant a failed write
    // was never retried, and this window kept the stale toolbar until restart
    // — the very desync the comment above describes.
    if (await callSoft('storage.set', { key: D.TOOLBAR_FLAG_KEY, value }) === null) return;
    lastToolbarFlag = value;
  }

  /**
   * Persists settings and reconciles everything derived from them: the
   * interface language, the context-menu contributions, and the style of
   * highlights already drawn in the reader.
   */
  async function saveSettings(next) {
    const previousColors = colorStyleSignature(settings.colors);
    const previousLanguage = settings.language;
    const previousToolbar = settings.toolbarButton;
    settings = D.normalizeSettings(next);
    holyNamePolicy = D.resolveHolyNamePolicy(settings.holyNames, hostDisplaySettings);
    await call('storage.set', { key: D.SETTINGS_KEY, value: settings });
    if (settings.toolbarButton !== previousToolbar) await syncToolbarFlag();

    if (settings.language !== previousLanguage && applyLanguage()) {
      emit('language', I18n.language);
    }
    emit('settings', settings);

    await enqueue(() => syncContributions());
    if (colorStyleSignature(settings.colors) !== previousColors) {
      await restyleStoredHighlights();
    }
    scheduleAutoBackup();
    await bumpRevision();
    return settings;
  }

  // ── Hiding the marks in one book ───────────────────────────────────────────

  async function loadMutedBooks() {
    const stored = await callSoft('storage.get', { key: D.MUTED_BOOKS_KEY });
    mutedBooks = D.normalizeMutedBooks(stored);
    return mutedBooks;
  }

  function isMuted(bookId) {
    return mutedBooks.includes(bookId);
  }

  /**
   * Takes the plugin's colours off one book, or puts them back.
   *
   * Nothing is deleted: the records stay in storage and the host copies are
   * dropped and redrawn. Quiet by default — `announce` is for the deliberate
   * toggle, not for the automatic un-hide that marking performs.
   */
  async function setMuted(bookId, muted, { announce = false } = {}) {
    if (!bookId || isMuted(bookId) === muted) return muted;
    mutedBooks = muted
      ? D.normalizeMutedBooks([...mutedBooks, bookId])
      : mutedBooks.filter(entry => entry !== bookId);
    await callSoft('storage.set', { key: D.MUTED_BOOKS_KEY, value: mutedBooks });

    if (muted) {
      await callSoft('reader.clearAllHighlights', { bookId });
      if (announce) await notify.success(t('ההדגשות בספר הזה מוסתרות. לחיצה נוספת תחזיר אותן.'));
    } else {
      for (const item of highlights.filter(entry => entry.bookId === bookId)) {
        await drawHighlight(item);
      }
      if (announce) await notify.success(t('ההדגשות בספר הזה מוצגות שוב'));
    }
    emit('muted', mutedBooks);
    await syncContributions({ force: true });
    await bumpRevision();
    return muted;
  }

  async function toggleMutedBook(bookId) {
    if (!bookId) {
      await notify.info(t('לא זוהה ספר פתוח. פִּתחו ספר ולחצו שוב.'));
      return null;
    }
    return await setMuted(bookId, !isMuted(bookId), { announce: true });
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
   * Reads every `highlight:` record.
   *
   * A few at a time, not all at once. `Promise.all` over the whole list was a
   * silent data-loss bug: the host throttle lets 50 calls through and refuses
   * the rest, `callSoft` swallowed each refusal, and a user with more than
   * fifty marks simply lost the tail of their own list — which
   * `reconcileHighlights` then faithfully erased from the reader.
   *
   * Every failure path below keeps the record we already had rather than
   * dropping it. **A read that failed is not a store that is empty**, and the
   * difference between those two is a page full of the user's marks.
   *
   * `silent` suppresses the change event — used during boot, so the page
   * renders once with real data instead of flashing an empty list first.
   */
  async function loadHighlights({ silent = false } = {}) {
    const listed = await callRaw('storage.list', {});
    if (!listed?.success || !Array.isArray(listed.data)) {
      storeComplete = false;
      logger.warn('Could not list the stored highlights', listed?.error?.code);
      return highlights;
    }
    const previousByKey = new Map(highlights.map(item => [item.key, item]));
    const highlightKeys = listed.data
      .filter(key => String(key).startsWith(D.HIGHLIGHT_PREFIX));
    let unread = 0;
    const records = await R.mapLimit(highlightKeys, STORAGE_READ_CONCURRENCY, async key => {
      const response = await callRaw('storage.get', { key });
      if (!response?.success) {
        unread += 1;
        return previousByKey.get(key) || null;
      }
      return D.normalizeHighlight(response.data, key);
    });
    storeComplete = unread === 0;
    if (unread) logger.warn(`${unread} stored highlights could not be read`);
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
   *
   * Drift is not only the host's doing. Another instance — another tab, or
   * another Otzaria window, which is a separate process with its own registry
   * — changes a colour by writing storage and bumping the revision, and cannot
   * reach the copies this instance owns. So the appearance, the deletion and
   * the hiding that happened elsewhere all reach the reader here, by noticing
   * that what is drawn no longer matches what is stored.
   */
  async function reconcileHighlights() {
    // Runs in every instance. The host keys records on
    // `(pluginId, instanceId)`, so this only ever touches copies this instance
    // drew — and it has to run even with nothing stored, because that is
    // exactly when a mark deleted elsewhere is still on the page.
    const drawn = await callRaw('reader.getHighlights', { includeStale: true });
    const unsupported = !drawn?.success
      && new MarkerSdkError('reader.getHighlights', drawn).isUnsupported;
    if (!drawn?.success && !unsupported) {
      // Same rule as a failed store read: not knowing what is on the page, we
      // would redraw all of it and erase none of it, for nothing. A host that
      // has no such call at all is a different matter — there the empty answer
      // is the true one, and every stored mark is simply drawn again.
      logger.warn('Could not read the drawn highlights', drawn?.error?.code);
      return { restored: 0, updated: 0, removed: 0 };
    }
    const hostById = new Map((Array.isArray(drawn?.data) ? drawn.data : [])
      .map(record => [record.highlightId, record]));

    let restored = 0;
    let updated = 0;
    // What this instance ought to be showing right now. Anything it is showing
    // that is not in here has to come off the page: a record deleted in
    // another instance or another window (which cannot reach this instance's
    // host records), or one whose book the user has since hidden. Skipping
    // those instead of clearing them is why hiding a book only ever took
    // effect in the one instance that was told.
    const shouldDraw = new Set(highlights
      .filter(item => !isMuted(item.bookId) && item.status !== 'failed_to_anchor')
      .map(item => item.highlightId));
    let removed = 0;
    // Only ever against a store we know we read in full. Taking a mark off the
    // page is irreversible from the user's side — they cannot tell a mark that
    // was deleted somewhere else from one whose record we failed to read — so
    // a degraded read forfeits this pass and the next poll makes it up.
    for (const record of storeComplete ? hostById.values() : []) {
      if (shouldDraw.has(record.highlightId)) continue;
      if (await callSoft('reader.clearHighlight', { highlightId: record.highlightId })) {
        removed += 1;
      }
    }
    for (const item of highlights) {
      if (!shouldDraw.has(item.highlightId)) continue;
      const hostRecord = hostById.get(item.highlightId);
      if (!hostRecord) {
        // Only an instance that can still act while its marks are on screen
        // may put them there. Otzaria calls `controller.pause()` on a plugin
        // tab the moment the user goes back to the book, freezing its timers —
        // so a page that had drawn the whole store sat frozen holding a copy
        // of every mark, visible in the book and impossible to update.
        //
        // Hiding a book is what exposed it. `clearAllHighlights` is scoped to
        // the calling instance, so the engine cleared its own copies and the
        // page's frozen ones stayed on the page: marks made earlier refused to
        // hide, while a mark made in that same session — held only by the
        // engine, because the page had been frozen since before it existed —
        // hid perfectly. Same for un-hiding, which is why it looked like the
        // button only worked on "new" marks.
        //
        // A click is the exception, and it is handled where it lands
        // (`applyHighlight`): the host routes clicks with
        // `preferBackground: true`, so one reaching the page is proof no engine
        // took it, and the page drawing it is the only way it appears at all.
        if (!isEngine) continue;
        if (await drawHighlight(item)) restored++;
        continue;
      }
      // What is drawn no longer looks like what is stored — another instance
      // edited the record. Re-drawing is the only way to move a copy this
      // instance owns to the appearance chosen somewhere else.
      const desiredStyle = D.buildHighlightStyle(item.style || { hex: item.color });
      if (JSON.stringify(hostRecord.style) !== JSON.stringify(desiredStyle)) {
        if (await drawHighlight(item)) updated++;
        continue;
      }
      // `version` and `etag` belong to *this* instance's copy — every window
      // and every tab has its own, and they are only ever compared against the
      // host record they came from. Taken here without a write: persisting a
      // drift in these alone made two instances overwrite each other's numbers
      // on every pass, for a value neither of them reads back.
      item.version = hostRecord.version ?? item.version;
      item.etag = hostRecord.etag ?? item.etag;

      // The anchor is different: the host re-anchors after the book text
      // changes, and that result is worth keeping for the next cold start.
      const status = hostRecord.status || item.status;
      const sourceRange = hostRecord.range || item.sourceRange;
      const drifted = status !== item.status
        || JSON.stringify(sourceRange) !== JSON.stringify(item.sourceRange);
      if (!drifted) continue;
      Object.assign(item, { status, sourceRange });
      await persistHighlight(item).catch(error => logger.warn('Failed persisting drift', error));
      updated++;
    }
    if (restored || updated) emit('highlights', highlights);
    return { restored, updated, removed };
  }

  /**
   * Hands this instance's drawn marks back, leaving them to the engine.
   *
   * A page still ends up holding a record whenever it handled a click itself,
   * and that record is exactly the kind that goes stale: the next time the
   * user opens a book the page is frozen, and a copy it can no longer touch
   * stays on the page. Resuming is the one moment a page is demonstrably
   * running *and* not the thing the user is looking at in the book, so it is
   * where the copies go back.
   *
   * The engine already has its own copy of everything stored — it reconciles
   * on the same revision token — so nothing disappears from the book.
   */
  async function releaseDrawnRecords() {
    if (isEngine) return false;
    return await callSoft('reader.clearAllHighlights', {}) !== null;
  }

  /** (Re)draws one stored highlight in the reader, from any instance. */
  async function drawHighlight(item) {
    if (item.status === 'failed_to_anchor') return false;
    if (isMuted(item.bookId)) return false;
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
        await updateHighlight(item, { color, render: false, bump: false });
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
   * Whether the eraser can be kept in step with the selection at all.
   *
   * Without `events.subscribe:reader.selection_changed` nothing ever tells us
   * what is selected, and a rule of "only over a mark" would mean "never".
   * Then the eraser stays in the row permanently — a slightly busier menu is a
   * far better failure than an action the user cannot reach.
   */
  function eraserFollowsSelection() {
    return D.hasPermission(hostContext.permissions, 'events.subscribe:reader.selection_changed');
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
   * Skipped entirely when nothing visible changed: it runs on every boot, on
   * every settings save and on every navigation.
   */
  async function syncContributions({ force = false } = {}) {
    const withClear = eraserInMenu || !eraserFollowsSelection();
    const muted = isMutedCurrentBookHint();
    const signature = D.menuSignature(settings, I18n.language, { withClear, muted });
    if (!force && signature === lastMenuSignature) return false;

    const colorsPayload = D.buildColorMenuPayload(settings, t, { withClear });
    if (!colorsPayload) {
      logger.warn('No enabled color — keeping the previously registered menu');
      return false;
    }
    try {
      await patchOrRegisterMenuItem(colorsPayload, isEngine);
      await patchOrRegisterMenuItem(D.buildHighlightMenuPayload(t), isEngine);
      await patchOrRegisterToolbarItem(D.buildToolbarPayload(t, { muted }), isEngine);
      lastMenuSignature = signature;
      return true;
    } catch (error) {
      lastMenuSignature = null;
      logger.error('Failed syncing contributions', error);
      return false;
    }
  }

  /**
   * Whether the book the toolbar button currently points at is muted.
   *
   * The button's label has to say what the next click does, and the engine
   * learns which book that is from `reader.current_ref_changed`. Before the
   * first one arrives the honest answer is "not muted", which is also the
   * label that matches the default state.
   */
  let currentBookIdHint = '';

  function isMutedCurrentBookHint() {
    return Boolean(currentBookIdHint) && isMuted(currentBookIdHint);
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

    // Marking a book the user hid earlier is the clearest possible statement
    // that they want to see marks in it again. Leaving it hidden meant the
    // colour click did nothing visible and nothing explained why.
    if (isMuted(bookId)) await setMuted(bookId, false);

    const overlapping = D.highlightsOverlappingTargets(highlights, bookId, targets);
    const groupId = targets.length > 1 ? D.makeHighlightId(targets[0].sectionIndex, `g-${color.id}`) : null;
    const style = D.buildHighlightStyle(color);
    const created = [];

    try {
      for (const target of targets) {
        const highlightId = D.makeHighlightId(target.sectionIndex, color.id);
        // A hidden book is the one case where a real record is deliberately
        // not painted — and marking has already un-hidden it above, so this
        // only holds for a book hidden in another instance a moment ago.
        const response = !isMuted(bookId)
          ? await callRaw('reader.setHighlight', {
            highlightId,
            bookId,
            // The stable identifier the docs recommend storing; the host keeps
            // it on its own record too, and ignores it when absent.
            ...(selection.bookUid ? { bookUid: selection.bookUid } : {}),
            sectionIndex: target.sectionIndex,
            range: target.range,
            style,
            metadata: D.buildHighlightMetadata({ colorLabel: color.label })
          })
          : { success: true, data: null };
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
    await bumpRevision();
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
    await bumpRevision();
    // Counted, not assumed. Reporting success after every attempt failed is
    // how a broken removal passes for a working one.
    const failed = targets.length - removed;
    if (failed) {
      await notify.error(t('{failed} סימונים לא הוסרו', { failed }));
    } else {
      await notify.success(removed > 1
        ? t('הסימון הוסר מכל השורות')
        : t('ההדגשה הוסרה'));
    }
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
    color, note, noteHtml, tags, favorite, render = true, bump = true
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

    // This instance updates the copy it owns. The others notice through the
    // change marker and update theirs, and until they do the host prefers the
    // copy owned by the instance the user can see — which is this one.
    let result = null;
    if (!isMuted(item.bookId)) {
      let hostRecord = await readHostRecord();
      try {
        result = hostRecord ? await patch(hostRecord) : await recreate();
      } catch (error) {
        const recoverable = error instanceof MarkerSdkError
          && [CODES.conflict, CODES.highlightNotFound, CODES.notFound].includes(error.code);
        if (!recoverable) throw error;
        hostRecord = await readHostRecord();
        result = hostRecord ? await patch(hostRecord) : await recreate();
      }
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
    // A bulk restyle bumps once at the end, not once per record.
    if (bump) await bumpRevision();
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
    await bumpRevision();
    // The caller offers an undo bar for what came back. Records that refused
    // to go are still there, and the undo bar is not the place to learn it.
    const failed = targets.length - deleted.length;
    if (failed) await notify.error(t('{failed} סימונים לא הוסרו', { failed }));
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
    await bumpRevision();
    return { restored: records.length - failed, failed };
  }

  /**
   * Wipes the store.
   *
   * Refuses on a partial read: it can only delete the records it managed to
   * load, and the ones it missed would come back at the next launch — after
   * the user had been told they were gone and after the page had been cleared,
   * so nothing on screen would contradict the claim.
   */
  async function deleteAllHighlights() {
    if (!storeComplete) {
      await loadHighlights();
      if (!storeComplete) {
        await notify.error(t('לא ניתן לקרוא כרגע את כל ההדגשות השמורות, ולכן המחיקה לא בוצעה. נסו שוב בעוד רגע.'));
        return 0;
      }
    }
    await writeSafetyBackup('delete-all');
    await callSoft('reader.clearAllHighlights', {});
    for (const item of highlights) {
      await callSoft('storage.remove', { key: item.key });
    }
    highlights = [];
    emit('highlights', highlights);
    scheduleAutoBackup();
    await bumpRevision();
  }

  /**
   * Opens the book and puts the reader on the marked line.
   *
   * `reader.revealHighlight` is the precise call, and it is instance-scoped:
   * the host looks the record up under `(pluginId, instanceId)`, so only the
   * instance that drew the mark may ask for it. From the plugin page that is
   * never true, and the fallback alone was not good enough — `openBookAtRef`
   * navigates to the *ref*, which is a chapter or a siman, so a mark in the
   * middle of a long chapter landed at its top. That is the "sometimes it does
   * not scroll to the right place" the reports describe.
   *
   * `reader.scrollToSection` closes the gap: it needs no ownership, it takes
   * the section index the record already carries, and it is exact to the line.
   * It only works on the book that is *open*, so it runs after the open call.
   */
  async function revealHighlight(item) {
    try {
      if (await call('reader.revealHighlight', { highlightId: item.highlightId }) === true) {
        return true;
      }
    } catch (error) {
      logger.debug('revealHighlight is not available here', error?.code || error);
    }
    // The identifier, not the display title: `item.book` is what the user
    // sees on the card, and the two differ whenever the host gives a stable id.
    const bookId = item.bookId || item.book;
    if (!bookId) throw new Error(t('לא נשמר מזהה ספר'));
    const opened = item.ref
      ? await call('reader.openBookAtRef', { bookId, ref: item.ref, index: item.sectionIndex, highlight: true })
      : await call('reader.openBook', { bookId, index: item.sectionIndex });
    if (opened !== true) throw new Error(t('אוצריא לא מצאה את הספר השמור'));
    // The book is open either way; only the exact line is in doubt. Saying so
    // is the difference between "the plugin is broken" and "scroll down a bit".
    if (!await scrollToStoredSection(item)) {
      await notify.info(t('הספר נפתח, אך לא ניתן היה לגלול בדיוק לשורה המסומנת.'));
    }
    return true;
  }

  /**
   * Scrolls the freshly opened book to the marked line.
   *
   * Retried, because the call answers `false` while the reader pane is still
   * building: `reader.openBook` resolves when the tab is created, not when it
   * has laid out. Three short attempts cover that without making a failure
   * look like a hang.
   */
  async function scrollToStoredSection(item) {
    if (!Number.isInteger(item.sectionIndex) || item.sectionIndex < 0) return false;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (attempt) await new Promise(resolve => setTimeout(resolve, 120));
      const scrolled = await callSoft('reader.scrollToSection', {
        sectionIndex: item.sectionIndex,
        highlight: true
      });
      if (scrolled === true) return true;
    }
    logger.warn('The reader did not scroll to the stored section', item.sectionIndex);
    return false;
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

  /**
   * The automatic backups, newest first.
   *
   * Throws when the folder could not be read at all. The caller renders "no
   * backup saved" for an empty result, and a user who has backups being told
   * they have none — right where they came to recover — is the one message
   * this plugin must never show by accident.
   */
  async function listAutoBackups() {
    const listing = await call('fs.listDir', { path: BACKUP_DIR });
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
      await syncToolbarFlag();
      await enqueue(() => syncContributions({ force: true }));
      scheduleAutoBackup();
      await bumpRevision();
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
        //
        // And only the message that is true: pointing a user whose records did
        // not come back at a file that was never written is worse than telling
        // them plainly that there is no copy.
        await notify.error(safetyBackup
          ? t('הייבוא נכשל, והשחזור למצב הקודם הצליח רק חלקית ({failed} רשומות). עותק של המצב שלפני הייבוא נשמר בקובץ {path}.',
            { failed: rollback.failed, path: safetyBackupPath('import') })
          : t('הייבוא נכשל, והשחזור למצב הקודם הצליח רק חלקית ({failed} רשומות). לא ניתן היה לשמור עותק של המצב הקודם.',
            { failed: rollback.failed }));
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
    await bumpRevision();
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
  // **Nothing here is gated on `isEngine`.** The host delivers a
  // targeted event (a menu click, a toolbar click, a shortcut) to exactly one
  // instance — `dispatchEventToPlugin` picks a single controller — so there is
  // no double-handling to prevent, and gating them was an outright bug: a
  // click routed to an instance whose `isEngine` was `false` vanished without
  // a trace.
  //
  // A click can also be what wakes the instance, so every handler waits for
  // `whenBooted()` before it reads the settings.

  async function onColorClicked(data) {
    // Paired with the boot line: between them, a report of "it stopped
    // responding" is answerable without guessing. The dispatcher prints where
    // it sent the click; this prints whether anything received it.
    logger.debug('colour clicked', data?.colorId);
    const colorId = D.colorIdFromItemId(data?.colorId);
    // Settings may still be loading if this click is what woke the instance.
    if (!booted) await whenBooted();

    if (colorId === D.CLEAR_COLOR_ID) {
      await enqueue(() => clearHighlightsInSelection(data?.selection));
      return;
    }
    const color = settings.colors.find(entry => entry.id === colorId);
    if (!color) {
      await reportUnknownColor(data?.colorId);
      return;
    }
    await enqueue(() => applyHighlight(color, data?.selection));
  }

  /**
   * A click on a colour the settings no longer know.
   *
   * The row on screen and the colours in the settings have drifted apart:
   * Otzaria re-registers the manifest's own row whenever the plugin's last
   * instance goes away, and that row knows nothing of a colour the user has
   * since renamed, switched off or added.
   *
   * Marking in some other colour would be guessing at what they wanted.
   * Saying nothing, though, is the complaint itself — a menu that answers a
   * click with silence reads as a broken plugin. So put the row right and ask
   * for the click again.
   *
   * Unless there is nothing to put right: with every colour switched off there
   * is no row to register, `syncContributions` can only keep the stale one,
   * and "pick again" would send the user around the same loop forever. That
   * case gets the one instruction that actually resolves it.
   */
  async function reportUnknownColor(clickedId) {
    logger.warn('Unknown color clicked', clickedId);
    if (!D.enabledColors(settings).length) {
      await notify.info(t('כל הצבעים כבויים. הדליקו לפחות צבע אחד במסך „ניהול צבעים”.'));
      return;
    }
    await enqueue(() => syncContributions({ force: true }));
    await notify.info(t('רשימת הצבעים התעדכנה זה עתה. בחרו צבע שוב מהתפריט.'));
  }

  /**
   * The eraser: removes every mark the selection touches.
   *
   * Overlap, not containment — a user dragging roughly over a mark expects it
   * to go, not to be told the selection missed its edges by a character. Parts
   * of a multi-paragraph highlight go together, which
   * `highlightsOverlappingTargets` already handles through `expandByGroup`.
   */
  async function clearHighlightsInSelection(selection) {
    const targets = D.selectionTargets(selection);
    const bookId = D.bookIdOf(selection);
    if (!targets.length || !bookId) {
      await notify.info(await explainUnavailableSelection(selection));
      return 0;
    }

    const doomed = D.highlightsOverlappingTargets(highlights, bookId, targets);
    if (!doomed.length) {
      // Silence here is indistinguishable from a dead menu item.
      await notify.info(t('אין סימון בקטע שנבחר'));
      return 0;
    }

    let removed = 0;
    for (const item of doomed) {
      try {
        await clearHighlightRecord(item);
        removed += 1;
      } catch (error) {
        logger.error('Failed clearing a highlight', error);
      }
    }
    emit('highlights', highlights);
    scheduleAutoBackup();
    await bumpRevision();
    // The selection is still standing and now has nothing left to erase, and
    // an unchanged selection fires no further `reader.selection_changed` — so
    // the eraser would sit there offering an action that does nothing.
    if (eraserInMenu && eraserFollowsSelection()) {
      eraserInMenu = false;
      await syncContributions();
    }

    const failed = doomed.length - removed;
    if (failed) {
      await notify.error(t('{failed} סימונים לא הוסרו', { failed }));
    } else {
      await notify.success(removed === 1
        ? t('הסימון הוסר')
        : t('{count} סימונים הוסרו', { count: removed }));
    }
    return removed;
  }

  async function onMenuItemClicked(data) {
    const itemId = String(data?.itemId || '');

    if (itemId === D.MENU_NOTE_ID) {
      const ids = D.clickedHighlightIds(data?.selection, hostContext.pluginId || PLUGIN_ID);
      if (ids.length) {
        emit('edit-highlight', ids[0]);
        return;
      }
      // This item is `openPlugin`, so the tab has already come to the front.
      // Leaving it there showing the plain list is the worst of both: the user
      // lost their place in the book and got nothing for it.
      await notify.info(t('ההדגשה שלחצתם עליה אינה של מרקר, ולכן אין לה הערה לערוך.'));
      return;
    }
    if (!booted) await whenBooted();

    if (itemId === D.MENU_REMOVE_ID) {
      await enqueue(() => removeClickedHighlights(data?.selection));
      return;
    }
    const colorId = D.colorIdFromItemId(itemId);
    // The colour row renders as a submenu when the user asks for names rather
    // than swatches, and a submenu child is an `item`: its click arrives here,
    // not in `onColorClicked`. The eraser is one of those children, so it
    // needs the same branch — without it "נקה סימון" was dead in that layout.
    if (colorId === D.CLEAR_COLOR_ID) {
      await enqueue(() => clearHighlightsInSelection(data?.selection));
      return;
    }
    const color = settings.colors.find(entry => entry.id === colorId);
    if (color) {
      await enqueue(() => applyHighlight(color, data?.selection));
      return;
    }
    if (colorId) await reportUnknownColor(itemId);
  }

  /** Keyboard shortcuts declared in `contributes.startup.shortcuts`. */
  async function onCommand(data) {
    const command = String(data?.command || '');
    if (command === D.COMMAND_OPEN_PANEL) {
      if (await callSoft('plugin.openSelf', { param: { view: 'highlights' } })) return;
      // A keystroke that does nothing and says nothing is indistinguishable
      // from a keystroke Otzaria never delivered.
      await notify.info(t('לא ניתן היה לפתוח את מרקר. אפשר לפתוח אותו מלשונית הכלים.'));
      return;
    }
    if (!booted) await whenBooted();
    if (command === D.COMMAND_TOGGLE_BOOK) {
      const bookId = currentBookIdHint || (await currentBook())?.bookId || '';
      if (bookId) currentBookIdHint = bookId;
      await enqueue(() => toggleMutedBook(bookId));
      return;
    }
    if (command !== D.COMMAND_HIGHLIGHT_DEFAULT) return;
    const selection = await callSoft('reader.getSelection', {});
    await enqueue(() => applyHighlight(D.defaultColor(settings), selection));
  }

  /**
   * The reader toolbar button. It hides and shows the plugin's colours in the
   * book on screen — the one thing worth a single click while reading. Opening
   * the list is `Ctrl+Alt+M` and the tool tab, both of which are deliberate.
   */
  async function onToolbarItemClicked(data) {
    if (String(data?.itemId || '') !== D.TOOLBAR_ITEM_ID) return;
    if (!booted) await whenBooted();
    // The payload carries the reader's own location, which is more reliable
    // than the last event we happened to see.
    const bookId = data?.currentBookId || data?.bookId
      || currentBookIdHint || (await currentBook())?.bookId || '';
    if (bookId) currentBookIdHint = bookId;
    await enqueue(() => toggleMutedBook(bookId));
  }

  /**
   * Keeps the toolbar label pointing at the book actually on screen.
   *
   * Not gated on `isEngine`, for the same reason as `onSelectionChanged`: this
   * is a broadcast, and a live plugin tab takes it instead of the engine.
   */
  async function onCurrentRefChanged(data) {
    const bookId = String(data?.currentBookId || data?.bookId || '');
    if (!bookId || bookId === currentBookIdHint) return;
    currentBookIdHint = bookId;
    await enqueue(() => syncContributions());
  }

  /**
   * Shows the eraser in the colour row only over text that already carries a
   * mark of ours. There is no host condition for "the selection overlaps a
   * highlight" — `showWhen` matches words and nothing else — so whichever
   * instance is receiving selection events keeps the registration in step.
   *
   * **Runs in whichever instance is told.** `reader.selection_changed` is a
   * broadcast, and `PluginRuntimeDispatcher._selectEventTargets` hands a
   * broadcast to the live *foreground* instances when there are any, falling
   * back to the background engine only when there are none. So while a plugin
   * tab is open the engine never sees a selection at all — gating this on
   * `isEngine` was exactly the bug: the eraser froze in whatever state it was
   * last left in, and only a restart cleared it. Patching a menu item is
   * allowed from any instance (the registration is plugin-level).
   *
   * Debounced, because a drag fires this per pointer move, and the RPC is
   * skipped unless the answer actually flipped.
   */
  function onSelectionChanged(selection) {
    if (!eraserFollowsSelection()) return;
    if (selectionTimer) clearTimeout(selectionTimer);
    selectionTimer = setTimeout(() => {
      selectionTimer = null;
      const next = D.selectionTouchesHighlight(highlights, selection);
      if (next === eraserInMenu) return;
      eraserInMenu = next;
      enqueue(() => syncContributions())
        .catch(error => logger.debug('Eraser visibility sync failed', error));
    }, SELECTION_DEBOUNCE_MS);
  }

  /**
   * The source text of a section the user has open changed, so the host
   * re-anchored our highlights. Read the authoritative state back rather than
   * guessing which anchors moved.
   */
  async function onSectionContentChanged(change) {
    if (change?.changeType !== 'source-content') return;
    await enqueue(async () => {
      await loadHighlights();
      await reconcileHighlights();
    });
  }

  /**
   * The user changed a permission in the plugin settings.
   *
   * `app.run_on_startup` is in that list, and it decides which instance draws
   * — so ownership really can change under us here. Switching it off while the
   * page is open has to make the page take over, and switching it on has to
   * make the page stand down and let the engine that is about to wake do the
   * drawing.
   */
  async function onPermissionsChanged(data) {
    // Before boot this instance has no highlights loaded, and reconciling
    // against an empty list would clear whatever it had already drawn.
    if (!booted) await whenBooted();
    const permissions = Array.isArray(data?.permissions) ? data.permissions : [];
    hostContext = Object.freeze(Object.assign({}, hostContext, { permissions }));
    isEngine = D.ownsEngine(hostContext);
    emit('engine', isEngine);
    await enqueue(async () => {
      await reconcileHighlights();
      await syncContributions({ force: true });
    });
  }

  /**
   * An Otzaria setting changed while we were running. Two of them matter: the
   * interface language, and whether the book text substitutes the Divine Name
   * — the plugin shows the same text the book shows.
   */
  async function onSettingsChanged(data) {
    const key = String(data?.key || '');
    if (key === D.HOST_HOLY_NAME_KEY || key === D.HOST_HOLY_NAME_STYLE_KEY) {
      await loadHostDisplaySettings();
      emit('settings', settings);
      return;
    }
    if (key !== I18n.LANGUAGE_SETTING_KEY) return;
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

  /**
   * The tab is about to be frozen.
   *
   * Best effort by necessity: the host awaits only the synchronous part of the
   * dispatch and then calls `controller.pause()`, so an RPC started here may
   * never finish. It is still worth starting — on platforms with no native
   * pause this is the whole protection, and where there is one the release on
   * resume covers what this could not.
   */
  async function onSuspended() {
    stopRevisionWatch();
    await releaseDrawnRecords();
  }

  /** The tab is live again: pick the watch back up and re-read what changed. */
  async function onResumed() {
    await releaseDrawnRecords();
    startRevisionWatch();
    await pollRevision();
  }

  // ── Boot ───────────────────────────────────────────────────────────────────

  async function boot(payload) {
    hostContext = D.normalizeBootContext(payload);
    isEngine = D.ownsEngine(hostContext);

    // Read the stored state before announcing boot, so the page's first render
    // already has the settings and the highlights.
    await loadSettings();
    await loadHostDisplaySettings();
    applyLanguage();
    await loadMutedBooks();
    await loadHighlights({ silent: true });
    booted = true;
    markBooted();
    emit('boot', { hostContext, settings, isEngine, theme: payload?.theme });

    // Established before the boot work, not after it: a slow or failing task
    // below must not leave this instance with no watcher for the other one.
    await pollRevision();
    startRevisionWatch();

    // One deliberately loud line per instance, because the failure this is
    // here to diagnose is invisible from the plugin's side: when the host's
    // lazy activation is wedged it parks every click in a queue it will never
    // drain, and the plugin sees only broadcasts. Knowing whether the engine
    // reached this point at all is the first question in any such report, and
    // it lands in the same console as the dispatcher's own tracing.
    logger.info(`booted v${PLUGIN_VERSION} as`,
      isEngine ? 'engine' : 'page',
      `— ${highlights.length} highlights, ${mutedBooks.length} hidden books`);

    await enqueue(async () => {
      await removeLegacyMenuItems();
      await syncToolbarFlag();
      await syncContributions({ force: true });
      // Drawing the stored marks is the whole job of the background engine:
      // the host keeps them in memory only, per instance, and erases them when
      // that instance goes away.
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
    R.on('reader.current_ref_changed', onCurrentRefChanged, logger);
    R.on('reader.selection_changed', onSelectionChanged, logger);
    R.on('plugin.permissions_changed', onPermissionsChanged, logger);
    R.on('settings.changed', onSettingsChanged, logger);
    R.on('reader.toolbar_item_clicked', onToolbarItemClicked, logger);
    // Otzaria freezes a plugin tab (`controller.pause()`) the moment the user
    // returns to the book, and thaws it when they come back. The engine never
    // gets either event — it is never on screen to begin with.
    R.on('plugin.suspended', onSuspended, logger);
    R.on('plugin.resumed', onResumed, logger);
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
    get mutedBooks() { return mutedBooks; },
    get holyNamePolicy() { return holyNamePolicy; },
    get hostDisplaySettings() { return hostDisplaySettings; },
    displayText: value => D.applyHolyNamePolicy(value, holyNamePolicy),
    getHighlights, findHighlight, loadHighlights, reconcileHighlights,
    loadSettings, saveSettings, applyLanguage, loadHostDisplaySettings,
    syncContributions, readerCapabilities, currentBook,
    applyHighlight, updateHighlight, deleteHighlights, restoreHighlights,
    deleteAllHighlights, revealHighlight, toggleMutedBook,
    pollRevision, startRevisionWatch, stopRevisionWatch,
    buildBackup, importBackup, saveFileAs, readFileFromUser,
    writeAutoBackup, listAutoBackups, readAutoBackup,
    exportPdf, setUnsavedChanges,
    hasReporterEmail, sendReport, describeError
  });
})(globalThis);
