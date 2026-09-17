(function (global) {
  'use strict';

  /**
   * The entry point of the background engine.
   *
   * `background.html` has no interface and never will: Otzaria loads it in a
   * hidden WebView so that the marks stay drawn in the reader, the colour row
   * works without throwing the user into the plugin tab, and the keyboard
   * shortcuts work from the book. Everything it does lives in `MarkerCore`;
   * this file only starts it.
   *
   * Nothing here may touch the DOM or load the page modules — `marker-ui.js`
   * and `marker-richtext.js` are the plugin page's, and loading them in a
   * headless WebView would cost memory for a document nobody looks at.
   */

  if (!global.MarkerCore) {
    console.error('[marker][background] MarkerCore did not load');
    return;
  }
  global.MarkerCore.start();
})(globalThis);
