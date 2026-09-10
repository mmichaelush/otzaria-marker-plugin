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

  /** The raw envelope — for calls that need `version`/`etag` off a failure. */
  async function callRaw(method, payload) {
    if (!global.Otzaria?.call) {
      return { success: false, data: null, error: { code: CODES.unavailable, message: 'SDK is not injected' } };
    }
    return global.Otzaria.call(method, payload || {});
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
   * mutable host state, and the RPC rate limiter is a 50-token bucket, so
   * firing them in parallel risks both interleaving and `error.rate_limited`.
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
    call, callRaw, callSoft, notify, protectEvent, on, createQueue
  });
})(globalThis);
