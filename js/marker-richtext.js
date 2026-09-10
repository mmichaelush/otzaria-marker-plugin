(function (global) {
  'use strict';

  /**
   * The rich-text note editor, and the sanitizer that guards it.
   *
   * Notes are stored as HTML, and HTML can arrive from an imported backup file
   * that this plugin never produced. The security boundary is therefore
   * **sanitize on output**: `sanitize()` runs on every path that turns stored
   * note HTML back into markup — rendering a card, filling the editor, or
   * building an HTML export. Sanitizing on save as well is only tidiness.
   */

  const D = global.MarkerDomain;
  const MAX_HTML_LENGTH = D.MAX_NOTE_HTML_LENGTH;
  const FONT_SIZES = D.NOTE_FONT_SIZES;
  /** `medium` — the level `queryCommandValue` reports for unstyled text. */
  const DEFAULT_SIZE_LEVEL = 3;

  // ── Sanitizer ──────────────────────────────────────────────────────────────
  //
  // The policy — which tags, which hrefs, which font sizes — lives in
  // `marker-domain.js`, where it is pure and covered by tests. What is left
  // here is only the DOM walk that applies it.

  const safeHref = D.safeNoteHref;

  function copyAllowedAttributes(source, target, tag) {
    if (tag === 'a') {
      const href = safeHref(source.getAttribute('href'));
      if (!href) return false;             // A link with no safe target is just text.
      target.setAttribute('href', href);
      target.setAttribute('target', '_blank');
      target.setAttribute('rel', 'noopener noreferrer');
      return true;
    }
    if (tag !== 'span') return true;
    const size = D.safeNoteFontSize(source.getAttribute('style'), source.getAttribute('size'));
    if (size) target.setAttribute('style', `font-size:${size}`);
    return true;
  }

  /** The recursion bound. Well above `NOTE_MAX_DEPTH`, well below the stack. */
  const HARD_DEPTH_LIMIT = 200;

  function sanitizeInto(sourceNode, targetNode, doc, depth) {
    for (const child of [...sourceNode.childNodes]) {
      if (child.nodeType === 3) {
        targetNode.appendChild(doc.createTextNode(child.nodeValue));
        continue;
      }
      if (child.nodeType !== 1) continue;   // comments, CDATA, processing instructions

      // Past the hard limit the subtree is flattened rather than walked.
      // `NOTE_MAX_DEPTH` alone only stops the *output* from nesting further;
      // the walk itself kept descending, so a pathologically deep document
      // still blew the stack. `textContent` is native and does not recurse.
      if (depth > HARD_DEPTH_LIMIT) {
        targetNode.appendChild(doc.createTextNode(child.textContent || ''));
        continue;
      }

      const tag = D.noteTagFor(child.tagName);
      // Depth guard: beyond this the element is unwrapped, not emitted.
      if (!tag || depth > D.NOTE_MAX_DEPTH) {
        sanitizeInto(child, targetNode, doc, depth + 1);
        continue;
      }
      if (tag === 'br') {
        targetNode.appendChild(doc.createElement('br'));
        continue;
      }
      const element = doc.createElement(tag);
      if (!copyAllowedAttributes(child, element, tag)) {
        sanitizeInto(child, targetNode, doc, depth + 1);
        continue;
      }
      // A span can also be carrying bold, italic, underline or strike as CSS
      // — from an engine that ignores `styleWithCSS`, or from pasted
      // content. Re-express it as the equivalent allowlisted tags so the
      // styling survives instead of being quietly dropped.
      let inner = element;
      if (tag === 'span') {
        for (const styleTag of D.noteStyleTags(child.getAttribute('style'))) {
          const wrapper = doc.createElement(styleTag);
          inner.appendChild(wrapper);
          inner = wrapper;
        }
      }
      sanitizeInto(child, inner, doc, depth + 1);
      targetNode.appendChild(element);
    }
  }

  /**
   * Returns markup containing only allowlisted tags and attributes.
   *
   * Parsing happens in an inert `DOMParser` document: scripts do not run,
   * images do not load, and no handler fires while we walk the tree.
   */
  function sanitize(html) {
    const input = String(html || '');
    if (!input.trim()) return '';
    const doc = new DOMParser().parseFromString(
      `<body>${input.slice(0, MAX_HTML_LENGTH)}</body>`, 'text/html');
    const output = document.implementation.createHTMLDocument('');
    const container = output.createElement('div');
    sanitizeInto(doc.body, container, output, 0);
    return container.innerHTML;
  }

  /** The searchable, exportable mirror of a note. */
  function toPlainText(html) {
    const input = String(html || '');
    if (!input.trim()) return '';
    const doc = new DOMParser().parseFromString(
      `<body>${input.slice(0, MAX_HTML_LENGTH)}</body>`, 'text/html');
    for (const block of doc.body.querySelectorAll('p,li,h2,h3,blockquote,br')) {
      block.appendChild(doc.createTextNode('\n'));
    }
    return doc.body.textContent.replace(/\n{3,}/g, '\n\n').trim();
  }

  /** Plain text going into a rich note: keep the line breaks, drop nothing. */
  function fromPlainText(text) {
    const value = String(text || '').trim();
    if (!value) return '';
    const doc = document.implementation.createHTMLDocument('');
    const container = doc.createElement('div');
    for (const line of value.split(/\r?\n/)) {
      const paragraph = doc.createElement('p');
      paragraph.textContent = line;
      container.appendChild(paragraph);
    }
    return container.innerHTML;
  }

  /**
   * Text is the only thing a note can hold — the sanitizer allows no embedded
   * content — so text is the only thing that makes one non-empty.
   *
   * `<br>` in particular must not count: clearing a `contenteditable` leaves
   * `<p><br></p>` behind, and treating that as content would store an
   * "empty" note forever — the placeholder would never come back, the card
   * would render a blank note block, and the "with a note" filter would
   * count it.
   */
  function isEmptyHtml(html) {
    return !toPlainText(html);
  }

  // ── Selection helpers ──────────────────────────────────────────────────────

  function currentRange() {
    const selection = global.getSelection();
    return selection && selection.rangeCount ? selection.getRangeAt(0) : null;
  }

  function ancestorTag(root, tags) {
    const range = currentRange();
    let node = range?.commonAncestorContainer;
    if (node && node.nodeType === 3) node = node.parentNode;
    while (node && node !== root && root.contains(node)) {
      if (tags.includes(node.tagName)) return node;
      node = node.parentNode;
    }
    return null;
  }

  function selectNode(node) {
    const range = document.createRange();
    range.selectNodeContents(node);
    const selection = global.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  }

  /**
   * `<mark>` has no execCommand of its own, and `hiliteColor` would emit an
   * arbitrary colour that the sanitizer would have to trust. Wrapping the
   * range by hand keeps the output inside the allowlist and keeps the
   * highlight following the app theme.
   */
  function toggleMark(root) {
    const existing = ancestorTag(root, ['MARK']);
    if (existing) {
      const parent = existing.parentNode;
      while (existing.firstChild) parent.insertBefore(existing.firstChild, existing);
      parent.removeChild(existing);
      parent.normalize();
      return;
    }
    const range = currentRange();
    if (!range || range.collapsed) return;
    const mark = document.createElement('mark');
    try {
      range.surroundContents(mark);
    } catch {
      // The range crosses element boundaries; extracting first always works.
      mark.appendChild(range.extractContents());
      range.insertNode(mark);
    }
    // The selection may have swallowed highlights of its own. Leaving them
    // nested doubles the shading and takes two toggles to undo, so the inner
    // ones are unwrapped and the text nodes merged back together.
    for (const nested of [...mark.querySelectorAll('mark')]) {
      while (nested.firstChild) nested.parentNode.insertBefore(nested.firstChild, nested);
      nested.parentNode.removeChild(nested);
    }
    mark.normalize();
    selectNode(mark);
  }

  function currentSizeLevel() {
    const value = document.queryCommandValue('fontSize');
    const level = Number.parseInt(value, 10);
    return Number.isInteger(level) && level >= 1 && level <= 7 ? level : DEFAULT_SIZE_LEVEL;
  }

  function stepFontSize(direction) {
    const next = Math.min(7, Math.max(1, currentSizeLevel() + direction));
    document.execCommand('fontSize', false, String(next));
  }

  // ── Editor ─────────────────────────────────────────────────────────────────

  const COMMANDS = Object.freeze({
    bold: root => document.execCommand('bold'),
    italic: root => document.execCommand('italic'),
    underline: root => document.execCommand('underline'),
    strike: root => document.execCommand('strikeThrough'),
    mark: root => toggleMark(root),
    fontUp: () => stepFontSize(1),
    fontDown: () => stepFontSize(-1),
    heading: root => {
      const inHeading = Boolean(ancestorTag(root, ['H2']));
      document.execCommand('formatBlock', false, inHeading ? 'p' : 'h2');
    },
    bulletList: () => document.execCommand('insertUnorderedList'),
    numberList: () => document.execCommand('insertOrderedList'),
    quote: root => {
      const inQuote = Boolean(ancestorTag(root, ['BLOCKQUOTE']));
      document.execCommand('formatBlock', false, inQuote ? 'p' : 'blockquote');
    },
    clear: () => {
      document.execCommand('removeFormat');
      document.execCommand('formatBlock', false, 'p');
    }
  });

  /** Which buttons should look pressed for the current caret position. */
  function activeCommands(root) {
    const state = command => {
      try { return document.queryCommandState(command); } catch { return false; }
    };
    return {
      bold: state('bold'),
      italic: state('italic'),
      underline: state('underline'),
      strike: state('strikeThrough'),
      mark: Boolean(ancestorTag(root, ['MARK'])),
      heading: Boolean(ancestorTag(root, ['H2'])),
      quote: Boolean(ancestorTag(root, ['BLOCKQUOTE'])),
      bulletList: state('insertUnorderedList'),
      numberList: state('insertOrderedList')
    };
  }

  /**
   * Wires a `contenteditable` element to a toolbar.
   *
   * Toolbar buttons declare `data-rt-command`; the link control declares
   * `data-rt-link`. Nothing else in the page needs to know how the editor
   * works — the controller is the whole surface.
   */
  function createEditor({ element, toolbar, linkBar, onDirty, onSave }) {
    let dirty = false;
    let savedRange = null;

    element.setAttribute('contenteditable', 'true');
    element.setAttribute('role', 'textbox');
    element.setAttribute('aria-multiline', 'true');

    // Emit <p> instead of <div>, and tags rather than CSS for bold and its
    // neighbours.
    //
    // `styleWithCSS` must stay **off**. With it on, execCommand('bold')
    // produces <span style="font-weight:bold"> — and the sanitizer keeps no
    // declaration but font-size, so every bold, italic, underline and strike
    // was stripped on save. The user saw the formatting while typing and got
    // plain text back. Off, the same commands emit <b>/<i>/<u>/<s>, which are
    // on the allowlist, and fontSize emits <font size>, which
    // `safeNoteFontSize` already reads.
    try {
      document.execCommand('defaultParagraphSeparator', false, 'p');
      document.execCommand('styleWithCSS', false, false);
    } catch { /* not supported here; the sanitizer copes with either shape */ }

    function markDirty() {
      if (!dirty) {
        dirty = true;
        onDirty?.(true);
      }
      refreshPlaceholder();
    }

    function refreshPlaceholder() {
      element.classList.toggle('is-empty', isEmptyHtml(element.innerHTML));
    }

    function rememberRange() {
      const range = currentRange();
      if (range && element.contains(range.commonAncestorContainer)) savedRange = range;
    }

    function restoreRange() {
      if (!savedRange) {
        element.focus();
        return;
      }
      const selection = global.getSelection();
      selection.removeAllRanges();
      selection.addRange(savedRange);
      element.focus();
    }

    function refreshToolbar() {
      if (!toolbar) return;
      const active = activeCommands(element);
      for (const button of toolbar.querySelectorAll('[data-rt-command]')) {
        const isActive = active[button.dataset.rtCommand] === true;
        button.classList.toggle('is-active', isActive);
        button.setAttribute('aria-pressed', String(isActive));
      }
    }

    function run(command) {
      restoreRange();
      const handler = COMMANDS[command];
      if (!handler) return;
      try {
        handler(element);
      } catch (error) {
        console.warn('[marker][richtext] command failed', command, error);
      }
      rememberRange();
      markDirty();
      refreshToolbar();
    }

    function applyLink(url) {
      const href = safeHref(url);
      if (!href) return false;
      restoreRange();
      const range = currentRange();
      if (range && range.collapsed) {
        // No selection: the address becomes its own link text.
        document.execCommand('insertText', false, href);
        const end = currentRange();
        if (end) {
          end.setStart(end.endContainer, Math.max(0, end.endOffset - href.length));
          const selection = global.getSelection();
          selection.removeAllRanges();
          selection.addRange(end);
        }
      }
      document.execCommand('createLink', false, href);
      rememberRange();
      markDirty();
      return true;
    }

    const onToolbarClick = event => {
      const button = event.target.closest('[data-rt-command]');
      if (!button || !toolbar.contains(button)) return;
      event.preventDefault();
      run(button.dataset.rtCommand);
    };
    // pointerdown must not steal the selection from the editor.
    const onToolbarPointerDown = event => {
      if (event.target.closest('[data-rt-command],[data-rt-link]')) event.preventDefault();
    };
    const onInput = () => markDirty();
    const onSelectionChange = () => {
      rememberRange();
      refreshToolbar();
    };
    const onKeyDown = event => {
      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
        event.preventDefault();
        onSave?.();
        return;
      }
      if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
      const shortcut = { b: 'bold', i: 'italic', u: 'underline' }[event.key.toLowerCase()];
      if (!shortcut) return;
      event.preventDefault();
      run(shortcut);
    };
    /** Pasted markup is sanitized before it can enter the document. */
    const onPaste = event => {
      const html = event.clipboardData?.getData('text/html');
      const text = event.clipboardData?.getData('text/plain');
      if (!html && !text) return;
      event.preventDefault();
      const safe = html ? sanitize(html) : fromPlainText(text);
      document.execCommand('insertHTML', false, safe);
      markDirty();
    };

    toolbar?.addEventListener('click', onToolbarClick);
    toolbar?.addEventListener('pointerdown', onToolbarPointerDown);
    linkBar?.addEventListener('pointerdown', onToolbarPointerDown);
    element.addEventListener('input', onInput);
    element.addEventListener('keydown', onKeyDown);
    element.addEventListener('paste', onPaste);
    element.addEventListener('keyup', onSelectionChange);
    // On the document, not the element: a drag that starts inside the editor
    // and releases outside it fires no `mouseup` on the element, and the
    // toolbar would then act on a range the user has already moved past.
    // `rememberRange` ignores anything outside the editor anyway.
    //
    // Guarded, because this fires for every click in the page: while the
    // dialog is closed there is nothing to update, and the work is five
    // `queryCommandState` calls plus two DOM walks.
    const onDocumentMouseUp = () => {
      if (!element.isConnected) return;
      const dialog = element.closest('dialog');
      if (dialog && !dialog.open) return;
      onSelectionChange();
    };
    document.addEventListener('mouseup', onDocumentMouseUp);
    element.addEventListener('focus', refreshToolbar);

    return Object.freeze({
      setHtml(html) {
        element.innerHTML = sanitize(html);
        savedRange = null;
        dirty = false;
        refreshPlaceholder();
        refreshToolbar();
      },
      getHtml() {
        const html = sanitize(element.innerHTML);
        return isEmptyHtml(html) ? '' : html;
      },
      getText() {
        return toPlainText(element.innerHTML);
      },
      get isDirty() { return dirty; },
      clearDirty() {
        dirty = false;
        onDirty?.(false);
      },
      focus() {
        element.focus();
        rememberRange();
      },
      applyLink,
      refreshToolbar,
      destroy() {
        toolbar?.removeEventListener('click', onToolbarClick);
        toolbar?.removeEventListener('pointerdown', onToolbarPointerDown);
        linkBar?.removeEventListener('pointerdown', onToolbarPointerDown);
        element.removeEventListener('input', onInput);
        element.removeEventListener('keydown', onKeyDown);
        element.removeEventListener('paste', onPaste);
        element.removeEventListener('keyup', onSelectionChange);
        document.removeEventListener('mouseup', onDocumentMouseUp);
        element.removeEventListener('focus', refreshToolbar);
      }
    });
  }

  global.MarkerRichText = Object.freeze({
    MAX_HTML_LENGTH, FONT_SIZES,
    sanitize, toPlainText, fromPlainText, isEmptyHtml, safeHref, createEditor
  });
})(globalThis);
