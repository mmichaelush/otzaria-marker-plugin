'use strict';

/**
 * A fake Otzaria host for the headless engine.
 *
 * It models the parts of the SDK the engine actually depends on: the RPC
 * envelope, plugin storage, the in-memory highlight registry and the
 * context-menu registry (including the fact that `contributes.startup`
 * registers items before any engine exists, so `updateContextMenuItem`
 * normally succeeds and `addContextMenuItem` is the fallback).
 */

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..', '..');
const SCRIPTS = [
  'js/marker-domain.js',
  'js/marker-i18n.js',
  'i18n/en.js',
  'js/marker-runtime.js',
  'js/marker-core.js'
];

function manifest() {
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8').replace(/^﻿/, ''));
}

// ── Host payload contract ──────────────────────────────────────────────
//
// A fake that accepts anything is worse than no fake: it lets the plugin
// ship a payload the real host rejects, and every test still passes. These
// mirror `PluginHighlightRegistry` — the field allowlists, the closed value
// sets and the ranges — so a bad payload fails here first.
//
// This is not hypothetical. `metadata.source: 'marker'` (the host allows
// only manual/ai/import/sync) made every single highlight fail in the real
// app while the whole suite stayed green.

const HIGHLIGHT_SOURCES = new Set(['manual', 'ai', 'import', 'sync']);
const MARKER_MODES = new Set(['text-background', 'line-marker', 'box', 'underline']);
const SET_HIGHLIGHT_FIELDS = new Set([
  'highlightId', 'bookId', 'bookUid', 'sectionIndex', 'currentRef', 'range', 'style', 'metadata'
]);
const UPDATE_HIGHLIGHT_FIELDS = new Set([
  'highlightId', 'expectedVersion', 'expectedEtag', 'style', 'metadata'
]);
const STYLE_FIELDS = new Set([
  'backgroundColor', 'foregroundColor', 'opacity', 'underline',
  'underlineColor', 'borderRadius', 'markerMode', 'priority'
]);
const METADATA_FIELDS = new Set(['note', 'tags', 'source']);

class HostRejection extends Error {}

// The host refuses control characters, in two flavours.
// `PluginHighlightRegistry._optionalText` keeps tab / newline / carriage
// return; `ContextMenuRegistry._optionalSafeText` and
// `PluginToolbarRegistry` keep none. Both reject the whole call.
const HIGHLIGHT_CONTROL = new RegExp('[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F]');
const MENU_CONTROL = new RegExp('[\\u0000-\\u001F\\u007F]');

function rejectHighlightControl(value, field) {
  if (typeof value === 'string' && HIGHLIGHT_CONTROL.test(value)) {
    throw new HostRejection(`${field} contains unsupported control characters`);
  }
}

function rejectMenuControl(value, field) {
  if (typeof value === 'string' && MENU_CONTROL.test(value)) {
    throw new HostRejection(`${field} has an invalid type or content`);
  }
}

const rejectUnknown = (object, allowed, name) => {
  for (const key of Object.keys(object || {})) {
    if (!allowed.has(key)) throw new HostRejection(`unknown field "${key}" in ${name}`);
  }
};

function validateStyle(style) {
  if (style == null) return;
  rejectUnknown(style, STYLE_FIELDS, 'style');
  if (!/^#[0-9A-Fa-f]{6}([0-9A-Fa-f]{2})?$/.test(String(style.backgroundColor || ''))) {
    throw new HostRejection('backgroundColor must be #RRGGBB or #RRGGBBAA');
  }
  const opacity = style.opacity ?? 1;
  const radius = style.borderRadius ?? 0;
  if (opacity < 0 || opacity > 1 || radius < 0 || radius > 32) {
    throw new HostRejection('opacity or borderRadius is out of range');
  }
  const priority = style.priority ?? 0;
  if (!Number.isInteger(priority) || priority < -1000 || priority > 1000) {
    throw new HostRejection('priority must be an integer between -1000 and 1000');
  }
  if (!MARKER_MODES.has(style.markerMode ?? 'text-background')) {
    throw new HostRejection('unsupported markerMode');
  }
}

function validateMetadata(metadata) {
  if (metadata == null) return;
  rejectUnknown(metadata, METADATA_FIELDS, 'metadata');
  if (metadata.source != null && !HIGHLIGHT_SOURCES.has(metadata.source)) {
    throw new HostRejection('unsupported highlight source');
  }
  if (metadata.note != null && String(metadata.note).length > 4000) {
    throw new HostRejection('note is too long');
  }
  rejectHighlightControl(metadata.note, 'note');
  if (metadata.tags == null) return;
  if (!Array.isArray(metadata.tags)) throw new HostRejection('tags must be an array');
  if (metadata.tags.length > 20) {
    throw new HostRejection('tags must contain 1-20 non-empty text values');
  }
  for (const tag of metadata.tags) {
    if (typeof tag !== 'string' || !tag.length || tag.length > 64) {
      throw new HostRejection('tags must contain 1-20 non-empty text values');
    }
    rejectHighlightControl(tag, 'tag');
  }
}

const MENU_TYPES = new Set(['item', 'submenu', 'color-row', 'separator']);
const MENU_CONTEXTS = new Set([
  'reader-selection', 'reader-page-shape-selection', 'reader-highlight'
]);
const TOOLBAR_CONTEXTS = new Set(['reader-text', 'reader-pdf']);

/** Mirrors `ContextMenuRegistry._parseItem`. */
function validateMenuItem(item, depth = 0, inherited = null) {
  if (depth > 2) throw new HostRejection('context menu nesting is too deep');
  if (!item.id || String(item.id).length > 128) throw new HostRejection('id is required');
  const type = item.type || 'item';
  if (!MENU_TYPES.has(type)) throw new HostRejection('unsupported context menu item type');

  const contexts = item.contexts ?? inherited
    ?? ['reader-selection', 'reader-page-shape-selection'];
  if (!Array.isArray(contexts) || !contexts.length) {
    throw new HostRejection('contexts must be a non-empty array');
  }
  if (new Set(contexts).size !== contexts.length) {
    throw new HostRejection('contexts must be unique');
  }
  for (const context of contexts) {
    if (!MENU_CONTEXTS.has(context)) throw new HostRejection(`unsupported context ${context}`);
    if (item.contexts && inherited && !inherited.includes(context)) {
      throw new HostRejection('child contexts must be within the parent contexts');
    }
  }
  if (item.title != null && String(item.title).length > 100) {
    throw new HostRejection('title is too long');
  }
  rejectMenuControl(item.title, 'title');
  if (item.action && (item.onClickEvent || item.openPlugin === true)) {
    throw new HostRejection('action cannot be combined with onClickEvent or openPlugin');
  }

  const children = item.children;
  if (children != null) {
    if (!Array.isArray(children) || children.length > 30) {
      throw new HostRejection('children must contain at most 30 items');
    }
    for (const child of children) validateMenuItem(child, depth + 1, contexts);
  }
  const colors = item.colors;
  if (colors != null) {
    if (!Array.isArray(colors) || !colors.length || colors.length > 12) {
      throw new HostRejection('colors must contain 1-12 values');
    }
    for (const color of colors) {
      if (!/^#[0-9A-Fa-f]{6}([0-9A-Fa-f]{2})?$/.test(String(color.color || ''))) {
        throw new HostRejection('colors must use #RRGGBB or #RRGGBBAA');
      }
      if (!color.id || String(color.id).length > 64) throw new HostRejection('color.id is required');
      if (String(color.label || '').length > 64) throw new HostRejection('color.label is too long');
      rejectMenuControl(color.label, 'color.label');
    }
  }
  if (type === 'submenu' && !children?.length) {
    throw new HostRejection('submenu requires children');
  }
  if (type === 'color-row' && !colors?.length) {
    throw new HostRejection('color-row requires colors');
  }
}

/** Mirrors `PluginToolbarRegistry`: a top-level control needs an icon. */
function validateToolbarItem(item, isChild = false) {
  if (!item.id) throw new HostRejection('id is required');
  rejectMenuControl(item.title, 'title');
  if (!isChild && !item.icon) throw new HostRejection('a toolbar item requires an icon');
  for (const context of item.contexts || ['reader-text', 'reader-pdf']) {
    if (!TOOLBAR_CONTEXTS.has(context)) throw new HostRejection(`unsupported context ${context}`);
  }
  for (const child of item.children || []) validateToolbarItem(child, true);
}

function validateSetHighlight(payload) {
  rejectUnknown(payload, SET_HIGHLIGHT_FIELDS, 'setHighlight');
  if (typeof payload.bookId !== 'string' || !payload.bookId) {
    throw new HostRejection('bookId is required');
  }
  if (!Number.isInteger(payload.sectionIndex) || payload.sectionIndex < 0) {
    throw new HostRejection('sectionIndex must be a non-negative integer');
  }
  if (!payload.range) throw new HostRejection('range is required');
  validateStyle(payload.style);
  validateMetadata(payload.metadata);
}

/**
 * @param {object} [options]
 * @param {object|null} [options.settings]           value behind `marker_settings`
 * @param {object[]}    [options.highlights]         pre-existing stored highlights
 * @param {boolean}     [options.declarativeMenu]    manifest items already registered
 * @param {object}      [options.overrides]          method → handler overrides
 */
function createHost(options = {}) {
  const {
    settings = null,
    highlights = [],
    declarativeMenu = true,
    overrides = {}
  } = options;

  const calls = [];
  const storage = new Map();
  const hostHighlights = new Map();
  const contextMenu = new Map();
  const toolbar = new Map();
  const files = new Map();

  if (settings) storage.set('marker_settings', settings);
  for (const item of highlights) storage.set(`highlight:${item.highlightId}`, item);
  if (declarativeMenu) {
    for (const item of manifest().contributes.startup.contextMenuItems) {
      contextMenu.set(item.id, JSON.parse(JSON.stringify(item)));
    }
    for (const item of manifest().contributes.startup.toolbarItems) {
      toolbar.set(item.id, JSON.parse(JSON.stringify(item)));
    }
  }

  const ok = data => ({ success: true, data, error: null });
  const fail = (code, message = code) => ({
    success: false, data: null, error: { schemaVersion: 1, code, message, retryable: false, category: 'not_found' }
  });


  const handlers = {
    'storage.get': ({ key }) => ok(storage.has(key) ? storage.get(key) : null),
    'storage.set': ({ key, value }) => { storage.set(key, value); return ok(true); },
    'storage.remove': ({ key }) => { storage.delete(key); return ok(true); },
    'storage.list': () => ok([...storage.keys()]),

    'reader.addContextMenuItem': payload => {
      validateMenuItem(payload);
      if (!contextMenu.has(payload.id) && contextMenu.size >= 2) {
        return fail('error.invalid_params', 'at most 2 top-level items');
      }
      contextMenu.set(payload.id, payload);
      return ok(true);
    },
    'reader.updateContextMenuItem': ({ id, patch }) => {
      if (!contextMenu.has(id)) return fail('error.not_found');
      // The host re-parses the *merged* item, so a patch can be rejected for
      // a field it never touched.
      const merged = Object.assign({}, contextMenu.get(id), patch, { id });
      validateMenuItem(merged);
      contextMenu.set(id, merged);
      return ok(true);
    },
    'reader.removeContextMenuItem': ({ id }) => { contextMenu.delete(id); return ok(true); },

    'reader.addToolbarItem': payload => {
      validateToolbarItem(payload);
      toolbar.set(payload.id, payload);
      return ok(true);
    },
    'reader.updateToolbarItem': ({ id, patch }) => {
      if (!toolbar.has(id)) return fail('error.not_found');
      const merged = Object.assign({}, toolbar.get(id), patch, { id });
      validateToolbarItem(merged);
      toolbar.set(id, merged);
      return ok(true);
    },

    'reader.setHighlight': payload => {
      validateSetHighlight(payload);
      const previous = hostHighlights.get(payload.highlightId);
      const record = {
        highlightId: payload.highlightId,
        bookId: payload.bookId,
        sectionIndex: payload.sectionIndex,
        range: payload.range,
        style: payload.style,
        version: (previous?.version || 0) + 1,
        etag: `etag-${(previous?.version || 0) + 1}`,
        status: 'active'
      };
      hostHighlights.set(record.highlightId, record);
      return ok(record);
    },
    'reader.updateHighlight': payload => {
      rejectUnknown(payload, UPDATE_HIGHLIGHT_FIELDS, 'updateHighlight');
      validateStyle(payload.style);
      validateMetadata(payload.metadata);
      const record = hostHighlights.get(payload.highlightId);
      if (!record) return fail('error.highlight_not_found');
      if (payload.expectedVersion != null && payload.expectedVersion !== record.version) {
        return fail('error.conflict');
      }
      record.version += 1;
      record.etag = `etag-${record.version}`;
      record.style = payload.style || record.style;
      return ok(record);
    },
    'reader.getHighlights': payload => ok([...hostHighlights.values()].filter(record =>
      (!payload?.bookId || record.bookId === payload.bookId)
      && (payload?.sectionIndex == null || record.sectionIndex === payload.sectionIndex))),
    'reader.clearHighlight': ({ highlightId }) => hostHighlights.delete(highlightId)
      ? ok(true)
      : fail('error.highlight_not_found'),
    'reader.clearAllHighlights': () => { hostHighlights.clear(); return ok(true); },
    'reader.getHighlightCapabilities': () => ok({
      surface: 'combined', highlights: true, selection: true, contextMenu: ['mainText']
    }),
    'reader.getSelection': () => ok(null),
    'reader.revealHighlight': () => ok(true),

    'fs.writeFile': ({ path: filePath, content }) => {
      files.set(filePath, content);
      return ok({ path: filePath, size: content.length, usedBytes: content.length, quotaBytes: 100e6 });
    },
    'fs.readFile': ({ path: filePath }) => files.has(filePath)
      ? ok({ path: filePath, encoding: 'utf8', size: files.get(filePath).length, content: files.get(filePath) })
      : fail('error.not_found'),
    'fs.listDir': ({ path: dir }) => ok({
      path: dir,
      entries: [...files.keys()].filter(key => key.startsWith(`${dir}/`)).map(key => ({
        path: key, name: key.slice(dir.length + 1), type: 'file',
        size: files.get(key).length, modified: new Date().toISOString()
      }))
    }),
    'fs.deleteEntry': ({ path: filePath }) => ok(files.delete(filePath)),

    'ui.showMessage': () => ok(true),
    'ui.showSuccess': () => ok(true),
    'ui.showError': () => ok(true),
    'ui.showWarning': () => ok({ confirmed: true }),
    'plugin.openSelf': () => ok(true),
    'feedback.hasReporterEmail': () => ok(false),
    'feedback.report': () => ok('sent')
  };

  const listeners = new Map();
  const Otzaria = {
    on: (event, handler) => {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(handler);
    },
    off: (event, handler) => {
      const list = listeners.get(event) || [];
      const index = list.indexOf(handler);
      if (index >= 0) list.splice(index, 1);
    },
    call: async (method, payload) => {
      calls.push({ method, payload });
      const handler = overrides[method] || handlers[method];
      if (!handler) return fail('error.unknown_method', method);
      try {
        return handler(payload || {});
      } catch (error) {
        if (!(error instanceof HostRejection)) throw error;
        // Exactly what the real host returns for a contract violation.
        return {
          success: false,
          data: null,
          error: {
            schemaVersion: 1,
            code: 'error.invalid_params',
            message: error.message,
            retryable: false,
            category: 'validation'
          }
        };
      }
    }
  };

  const timers = new Set();
  const context = {
    console,
    Otzaria,
    crypto: undefined,
    document: undefined,
    Blob: global.Blob,
    fetch: global.fetch,
    setTimeout: (fn, ms) => { const id = setTimeout(fn, ms); timers.add(id); return id; },
    clearTimeout: id => { timers.delete(id); return clearTimeout(id); },
    setInterval: () => 0,
    clearInterval: () => {},
    globalThis: {}
  };
  context.globalThis = context;
  context.window = context;

  for (const script of SCRIPTS) {
    vm.runInNewContext(fs.readFileSync(path.join(ROOT, script), 'utf8'), context, {
      filename: path.basename(script)
    });
  }
  context.MarkerCore.start();

  return {
    context,
    calls,
    storage,
    hostHighlights,
    contextMenu,
    toolbar,
    files,
    core: context.MarkerCore,
    domain: context.MarkerDomain,
    i18n: context.MarkerI18n,
    callsTo: method => calls.filter(entry => entry.method === method),
    /** Delivers a host event exactly as the dispatcher would. */
    emit: async (event, payload) => {
      for (const handler of listeners.get(event) || []) await handler(payload);
    },
    dispose: () => { for (const id of timers) clearTimeout(id); timers.clear(); }
  };
}

/** A single-paragraph selection payload, shaped like the host's. */
function selection(overrides = {}) {
  return Object.assign({
    schemaVersion: 1,
    bookId: 'בראשית',
    bookTitle: 'בראשית',
    bookUid: 'id:183',
    sectionIndex: 4,
    currentIndex: 4,
    currentRef: 'בראשית פרק א',
    renderedSelectedText: 'ויאמר אלהים יהי אור',
    sourceSelectedText: 'וַיֹּאמֶר אֱלֹהִים יְהִי אוֹר',
    sourceRange: {
      type: 'text-range-v1', schemaVersion: 1, layer: 'source',
      start: { utf16: 10, grapheme: 10, codePoint: 10 },
      end: { utf16: 30, grapheme: 30, codePoint: 30 }
    }
  }, overrides);
}

/** A multi-paragraph selection, as delivered since Otzaria 0.9.97. */
function multiSectionSelection() {
  const section = (index, start, end) => ({
    schemaVersion: 1,
    bookId: 'בראשית',
    bookTitle: 'בראשית',
    sectionIndex: index,
    currentIndex: index,
    currentRef: 'בראשית פרק א',
    sourceSelectedText: `קטע ${index}`,
    renderedSelectedText: `קטע ${index}`,
    sourceRange: {
      type: 'text-range-v1', schemaVersion: 1, layer: 'source',
      start: { utf16: start }, end: { utf16: end }
    }
  });
  return selection({
    sourceRange: undefined,
    sections: [section(4, 12, 40), section(5, 0, 18), section(6, 0, 9)]
  });
}

module.exports = {
  ROOT, createHost, selection, multiSectionSelection, manifest,
  HostRejection, validateMenuItem, validateToolbarItem, validateSetHighlight
};
