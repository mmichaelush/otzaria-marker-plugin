(function (global) {
  'use strict';

  /**
   * The single boundary between the plugin and the Otzaria SDK.
   *
   * Everything that talks to the host goes through here so that failures carry
   * the same structured shape, logs carry the same prefix, and no async event
   * handler can turn into an unhandled rejection.
   */

  const LOG_PREFIX = '[marker]';

  /** Error codes the caller is expected to branch on rather than surface. */
  const CODES = Object.freeze({
    notFound: 'error.not_found',
    highlightNotFound: 'error.highlight_not_found',
    conflict: 'error.conflict',
    forbidden: 'error.forbidden',
    permissionDenied: 'permission_denied',
    unknownMethod: 'error.unknown_method',
    unavailable: 'error.unavailable',
    unsupportedContext: 'error.unsupported_context',
    invalidParams: 'error.invalid_params',
    rateLimited: 'error.rate_limited',
    timeout: 'error.timeout'
  });

  /** A method missing or blocked on this host — the feature simply degrades. */
  const SOFT_CODES = Object.freeze([
    CODES.unknownMethod, CODES.unavailable, CODES.unsupportedContext,
    CODES.permissionDenied, 'error.permission_denied'
  ]);

  class MarkerSdkError extends Error {
    constructor(method, response) {
      const failure = response?.error || {};
      const code = failure.code || 'error.unknown';
      super(`${method} [${code}]: ${failure.message || 'unknown error'}`);
      this.name = 'MarkerSdkError';
      this.method = method;
      this.code = code;
      this.category = failure.category || null;
      this.retryable = Boolean(failure.retryable);
      this.hostMessage = failure.message || '';
    }

    /** The host does not offer this call here; the caller can skip it. */
    get isUnsupported() {
      return SOFT_CODES.includes(this.code);
    }
  }

  function createLogger(scope) {
    const prefix = scope ? `${LOG_PREFIX}[${scope}]` : LOG_PREFIX;
    return Object.freeze({
      debug: (...args) => console.debug(prefix, ...args),
      info: (...args) => console.info(prefix, ...args),
      warn: (...args) => console.warn(prefix, ...args),
      error: (...args) => console.error(prefix, ...args)
    });
  }

  const logger = createLogger('sdk');

  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

  // ── RPC pacing ─────────────────────────────────────────────────────────────
  //
  // Otzaria throttles plugin RPCs with a 50-token bucket
  // (`PluginBridgeHandler.RateLimiter`) that, on every call, adds
  // `elapsedSinceLastCall ~/ 10` tokens **and then discards the remainder**.
  // The consequence is not a gentle slowdown, it is a cliff: a run of calls
  // spaced less than 10ms apart refills nothing at all, so exactly 50 get
  // through and every one after that comes back `error.rate_limited` until the
  // plugin falls silent for a moment.
  //
  // Fifty is a small number here. Reading 200 stored highlights is 200 calls;
  // redrawing them after a cold start is 200 more. It applies to a sequential
  // `await` loop just as much as to `Promise.all` — a storage read answers in
  // well under 10ms.
  //
  // Every rejected call was silent. A swallowed `storage.get` looks exactly
  // like a highlight that was never saved, a swallowed `reader.setHighlight`
  // like a mark the user never made, and a swallowed `ui.showError` is why
  // there was no error message to go with either.
  //
  // So we keep our own copy of the bucket and *wait* instead of being refused.
  // It is modelled on the host's exactly, discarded remainder included, which
  // makes our copy drain at least as fast as the real one — we throttle
  // ourselves a moment before the host would have refused us.

  const HOST_BUCKET_SIZE = 50;
  const RPC_REFILL_MS = 10;
  /**
   * Headroom, because our clock is coarser than the host's.
   *
   * `Date.now()` on Windows can sit still for several milliseconds and then
   * jump. Across a burst that means we sometimes read one gap as 16ms where
   * the host, timing each call separately in Dart, read sixteen gaps of under
   * 1ms and credited nothing — so our copy of the bucket can drift a few
   * tokens optimistic. Starting lower than the host absorbs that drift; the
   * retry below absorbs whatever is left.
   */
  const RPC_CLOCK_HEADROOM = 5;
  const RPC_BUCKET_SIZE = HOST_BUCKET_SIZE - RPC_CLOCK_HEADROOM;
  /** Long enough that the host credits a token for the gap (`diff ~/ 10`). */
  const RPC_WAIT_MS = RPC_REFILL_MS + 5;

  let rpcTokens = RPC_BUCKET_SIZE;
  let rpcRefilledAt = Date.now();

  function takeRpcToken() {
    const now = Date.now();
    // `Math.max` guards a clock that goes backwards — an NTP or DST
    // correction would otherwise drive the count to a number the wait loop
    // could not climb out of for an hour, with every call silently blocked.
    rpcTokens = Math.min(
      RPC_BUCKET_SIZE,
      rpcTokens + Math.max(0, Math.floor((now - rpcRefilledAt) / RPC_REFILL_MS))
    );
    rpcRefilledAt = now;
    if (rpcTokens <= 0) return false;
    rpcTokens -= 1;
    return true;
  }

  /**
   * Waits for a token. Chained so that callers take tokens in the order they
   * asked — only the *waiting* is serialized, never the calls themselves.
   */
  let rpcGate = Promise.resolve();

  function reserveRpcSlot() {
    const reservation = rpcGate.then(async () => {
      while (!takeRpcToken()) await sleep(RPC_WAIT_MS);
    });
    rpcGate = reservation.then(() => {}, () => {});
    return reservation;
  }

  /**
   * The backstop for the pacing above.
   *
   * The host's bucket belongs to the WebView, not to the plugin — one per
   * `PluginBridgeHandler`, which is one per instance — so our copy is of the
   * right thing. What it cannot be is exact: it starts counting when this
   * script loads rather than when the WebView registered, the host charges a
   * token for calls we never make (an unknown method, a call from an iframe),
   * and our clock is the coarser of the two. So the refusal has to be
   * survivable, not merely unlikely.
   *
   * Only `error.rate_limited` is retried, and that is deliberate. It is the one
   * failure the host raises *before running the call at all*, which makes it
   * safe to repeat for every method, including the ones that send mail or
   * write a file. A timeout is not retried: there the work may well have
   * happened.
   */
  const RPC_RETRY_BACKOFF_MS = Object.freeze([20, 60, 150, 400, 900]);

  const isRateLimited = response =>
    response?.error?.code === CODES.rateLimited;

  /** The raw envelope — for calls that need `version`/`etag` off a failure. */
  async function callRaw(method, payload) {
    if (!global.Otzaria?.call) {
      return { success: false, data: null, error: { code: CODES.unavailable, message: 'SDK is not injected' } };
    }
    const params = payload || {};
    await reserveRpcSlot();
    let response = await global.Otzaria.call(method, params);
    for (const backoff of RPC_RETRY_BACKOFF_MS) {
      if (!isRateLimited(response)) break;
      // The host refused because too little time had passed. Give it that
      // time — and empty our own bucket, which was evidently behind.
      rpcTokens = 0;
      await sleep(backoff);
      response = await global.Otzaria.call(method, params);
    }
    if (isRateLimited(response)) {
      logger.warn(`${method} is still rate limited after ${RPC_RETRY_BACKOFF_MS.length} retries`);
    }
    return response;
  }

  /**
   * `Promise.all` over `items` with at most `limit` in flight.
   *
   * Results keep the order of `items`. Unbounded fan-out is what turned a
   * slow read into a lossy one — see the pacing note above.
   */
  async function mapLimit(items, limit, task) {
    const list = [...items];
    const results = new Array(list.length);
    let next = 0;
    let stopped = false;
    const worker = async () => {
      while (next < list.length && !stopped) {
        const index = next++;
        try {
          results[index] = await task(list[index], index);
        } catch (error) {
          // Otherwise the surviving workers go on spending RPCs on a result
          // the caller has already stopped waiting for.
          stopped = true;
          throw error;
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.max(1, Math.min(limit, list.length)) }, worker)
    );
    return results;
  }

  /** Resolves with `data`, or throws `MarkerSdkError`. */
  async function call(method, payload) {
    const response = await callRaw(method, payload);
    if (!response || !response.success) throw new MarkerSdkError(method, response);
    return response.data;
  }

  /**
   * A call whose failure is not worth interrupting the flow for — an optional
   * registration, a best-effort cleanup, a toast. Returns `fallback` and logs
   * at debug level for unsupported methods, warn level for anything else.
   */
  async function callSoft(method, payload, fallback = null) {
    try {
      return await call(method, payload);
    } catch (error) {
      if (error instanceof MarkerSdkError && error.isUnsupported) {
        logger.debug(`${method} unavailable on this host`, error.code);
      } else {
        logger.warn(`${method} failed`, error);
      }
      return fallback;
    }
  }

  /** Toasts must never mask the operation that triggered them. */
  const notify = Object.freeze({
    info: message => callSoft('ui.showMessage', { message }),
    success: message => callSoft('ui.showSuccess', { message }),
    error: message => callSoft('ui.showError', { message }),
    async confirm(title, content, subtitle) {
      const data = await callSoft('ui.showWarning', {
        title, content, ...(subtitle ? { subtitle } : {})
      });
      return data?.confirmed === true;
    }
  });

  /**
   * Wraps an event handler so a rejection is logged with its event name
   * instead of escaping as an unhandled rejection inside the host WebView.
   */
  function protectEvent(eventName, handler, log = createLogger('events')) {
    return payload => Promise.resolve()
      .then(() => handler(payload))
      .catch(error => log.error(`Event failed: ${eventName}`, error));
  }

  /** `Otzaria.on` with the protection above already applied. */
  function on(eventName, handler, log) {
    if (!global.Otzaria?.on) return () => {};
    const wrapped = protectEvent(eventName, handler, log);
    global.Otzaria.on(eventName, wrapped);
    return () => global.Otzaria.off?.(eventName, wrapped);
  }

  /**
   * Runs `tasks` one after another. Highlight writes and menu updates share
   * mutable host state, so firing them in parallel risks interleaving. Pacing
   * against the host's throttle is `callRaw`'s job, not this one's.
   */
  function createQueue() {
    let tail = Promise.resolve();
    return function enqueue(task) {
      const run = tail.then(task, task);
      tail = run.then(() => {}, () => {});
      return run;
    };
  }

  global.MarkerRuntime = Object.freeze({
    CODES, MarkerSdkError, createLogger,
    call, callRaw, callSoft, notify, protectEvent, on, createQueue,
    mapLimit, sleep
  });
})(globalThis);
