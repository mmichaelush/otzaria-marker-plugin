(function (global) {
  'use strict';

  const LOG_PREFIX = '[marker]';

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

  async function call(method, payload) {
    const response = await callRaw(method, payload);
    if (!response || !response.success) throw new MarkerSdkError(method, response);
    return response.data;
  }

  /** Raw SDK response for operations that need version/etag metadata. */
  async function callRaw(method, payload) {
    return global.Otzaria.call(method, payload || {});
  }

  /**
   * Converts an async event handler into a host-safe callback and adds the
   * event name to failures, avoiding unhandled promise rejections.
   */
  function protectEvent(eventName, handler, logger = createLogger('events')) {
    return payload => Promise.resolve().then(() => handler(payload)).catch(error => {
      logger.error(`Event failed: ${eventName}`, error);
    });
  }

  global.MarkerRuntime = Object.freeze({ MarkerSdkError, createLogger, call, callRaw, protectEvent });
})(globalThis);
