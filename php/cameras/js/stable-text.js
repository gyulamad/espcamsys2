'use strict';
// stable-text.js — an element whose TEXT CHANGES keeps its SIZE, so a change of value can never move the
// layout around it. This is the one implementation for every counter, status pill and label the pages keep
// up to date (F-35): a countdown that runs "NEXT IN 10 s" -> "NEXT IN 9 s" is one character narrower, and
// in a row that wraps (flex-wrap) that one character can decide where the line breaks — the row grows or
// shrinks by a line and everything below it hops. The cure is to reserve, ONCE, the room of the WIDEST
// text the element will ever show: from then on the line breaking depends only on the width of the screen,
// never on the data, and nothing moves when the values change.
//
//   CamStableText.reserve(el, texts)        keep the element's WIDTH stable for any of `texts`
//                                           (a string or an array; already-shown text need not be repeated)
//   CamStableText.reserveHeight(el, texts)  keep the element's HEIGHT stable (for a full-width block whose
//                                           text wraps into a varying number of lines)
//   CamStableText.release(el)               take the reservation back (the element may shrink again)
//
// The room is measured in the element's own font (family, size, spacing, transformation): a hidden measurer
// span copies the element's computed font and is measured off screen. Because a reserved element only ever
// grows beyond its text (min-width / min-height), the reservation is harmless for every value it never
// reaches — and where an element already carries a reservation, the wider of the two wins (never a fight
// between two writers of the same style). Web fonts load after the first paint (font-display: swap), and a
// narrower/wider face would invalidate the measured room: every reservation is measured again when the
// fonts are in, and again when the window is resized (a wrapped block's height depends on its width).
//
// The rules (what to reserve on which element) live in the pages, next to the text they set; this file only
// knows how. Loaded by the pages as a plain script (window.CamStableText) and by the tests with require()
// (create(), with stand-ins for the document — the rules of screen-keeper.js).

(function (root, factory) {
  const api = factory();   // reserve/reserveHeight/release for this page, plus create() for the tests
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CamStableText = api;
})(typeof self !== 'undefined' ? self : this, function () {
  // The computed styles a measurer must copy to measure like the element draws its text (white-space too: a
  // block that wraps its sentences wraps differently from one that keeps its line breaks).
  const FONT_STYLES = ['fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'letterSpacing', 'textTransform', 'lineHeight', 'whiteSpace'];

  const textsOf = (texts) => (Array.isArray(texts) ? texts : [texts]);
  const isText = (t) => typeof t === 'string' && t !== '';
  const pxOf = (v) => (typeof v === 'string' && v.endsWith('px') ? parseFloat(v) : 0);

  function create({ doc, win, measureText, measureLines } = {}) {
    const documentObj = doc !== undefined ? doc : (typeof document !== 'undefined' ? document : null);
    const windowObj = win !== undefined ? win : (typeof window !== 'undefined' ? window : null);
    // Tests without a layout engine (jsdom has none) hand their own measurers in; everything else uses the
    // one hidden span per reservation kind, styled like the element and parked off screen.
    const measureWidth = measureText || defaultMeasureWidth;
    const measureHeight = measureLines || defaultMeasureLines;

    let measurer = null;        // the hidden span, made once, reused for every measurement
    const reserved = new Map(); // element -> { kind, texts } of the live reservations (re-measured on fonts / resize)

    function theMeasurer() {
      if (measurer) return measurer;
      if (!documentObj || !documentObj.body) return null;
      measurer = documentObj.createElement('span');
      measurer.setAttribute('aria-hidden', 'true');
      measurer.style.cssText = 'position:absolute;left:-9999px;top:-9999px;visibility:hidden;white-space:pre;margin:0;padding:0;border:0;';
      documentObj.body.appendChild(measurer);
      return measurer;
    }

    function styledWith(el) {
      const m = theMeasurer();
      if (!m || !el) return null;
      try {
        const cs = documentObj.defaultView && documentObj.defaultView.getComputedStyle(el);
        if (cs) for (const p of FONT_STYLES) m.style[p] = cs[p];
      } catch (e) { /* no computed style here: measure with the measurer's own font */ }
      return m;
    }

    function defaultMeasureWidth(text, el) {
      const m = styledWith(el);
      if (!m) return 0;
      m.style.width = 'auto';
      m.style.whiteSpace = 'pre';   // the width of the text as ONE line, whatever the element wraps
      m.textContent = text;
      const box = m.getBoundingClientRect();
      return box ? box.width : 0;
    }

    // The height `text` wraps to inside the width the element has now (a block's line count is its width's).
    // The element's own white-space is kept: a block with pre-line wraps differently from one with normal.
    function defaultMeasureLines(text, el) {
      const m = styledWith(el);
      const room = el && el.clientWidth;
      if (!m || !room) return 0;
      m.style.width = room + 'px';
      m.textContent = text;
      const box = m.getBoundingClientRect();
      return box ? box.height : 0;
    }

    // Grows `styleName` to `size` px at least, keeping anything already reserved (two writers — this helper
    // and busy.js's spinner room — must not pull each other's reservation down).
    function grow(el, styleName, size) {
      if (!(size > 0)) return;
      el.style[styleName] = Math.max(pxOf(el.style[styleName]), Math.ceil(size)) + 'px';
    }

    // What the element adds around its text: its padding and its border. min-width / min-height size the
    // element's own box (border-box on these pages), so a reservation of the bare TEXT would fall short of
    // the widest text plus this chrome — a pill or button could still shrink between its wordings. Read off
    // the element's computed style; without one (no document here, a stand-in element) it is nothing, and the
    // reservation keeps the text's own room — exact for the padding-less spans this all started with.
    function chromeOf(el, props) {
      if (!documentObj || !documentObj.defaultView || typeof documentObj.defaultView.getComputedStyle !== 'function') return 0;
      let cs;
      try { cs = documentObj.defaultView.getComputedStyle(el); } catch (e) { return 0; }
      if (!cs) return 0;
      return props.reduce((sum, p) => sum + (parseFloat(cs[p]) || 0), 0);
    }
    const WIDE = ['paddingLeft', 'paddingRight', 'borderLeftWidth', 'borderRightWidth'];
    const TALL = ['paddingTop', 'paddingBottom', 'borderTopWidth', 'borderBottomWidth'];

    function apply(entry) {
      const chrome = entry.kind === 'width' ? chromeOf(entry.el, WIDE) : chromeOf(entry.el, TALL);
      const sizes = entry.texts.map((t) => (entry.kind === 'width' ? measureWidth(t, entry.el) : measureHeight(t, entry.el)));
      grow(entry.el, entry.kind === 'width' ? 'minWidth' : 'minHeight', Math.max(0, ...sizes) + chrome);
    }

    // The page's fonts (font-display: swap) and the window's width change what everything measures to:
    // every live reservation is measured again then. One listener for all of them.
    function remeasureAll() {
      for (const entry of reserved.values()) apply(entry);
    }
    function watchRemovals() {
      if (!windowObj || windowObj.__camStableTextWired) return;
      windowObj.__camStableTextWired = true;
      windowObj.addEventListener('resize', remeasureAll);
      const fonts = documentObj && documentObj.fonts;
      if (fonts && typeof fonts.ready !== 'undefined' && typeof fonts.ready.then === 'function') fonts.ready.then(remeasureAll).catch(() => {});
      if (fonts && typeof fonts.addEventListener === 'function') fonts.addEventListener('loadingdone', remeasureAll);
    }

    // Reserves the room of the widest of `texts` on `el` (min-width), or — reserveHeight — of the tallest
    // (min-height). A change of the candidates re-reserves; the wider room of an older reservation stays
    // (a reservation only ever gives room back through release()). The same candidates again (a page that
    // reserves on every push) measure nothing: the room is already standing.
    function reserve(kind) {
      return function (el, texts) {
        if (!el) return null;
        const candidates = textsOf(texts).filter(isText);
        if (candidates.length === 0) return null;
        const prev = reserved.get(el);
        const room = kind === 'width' ? 'minWidth' : 'minHeight';
        if (prev && prev.kind === kind && JSON.stringify(prev.texts) === JSON.stringify(candidates)) {
          return el.style[room] || null;   // nothing new: keep the room that is standing
        }
        const entry = { el, texts: candidates, kind };
        reserved.set(el, entry);   // one live reservation per element: the newest candidates are the ones that count
        apply(entry);
        watchRemovals();
        return el.style[room] || null;   // null: there was nothing to measure from
      };
    }

    function release(el) {
      if (!el || !reserved.has(el)) return;
      reserved.delete(el);
      el.style.minWidth = '';
      el.style.minHeight = '';
    }

    return { reserve: reserve('width'), reserveHeight: reserve('height'), release, remeasureAll };
  }

  const page = create();   // the page's own instance, bound to this page's document (an inert stand-in in node)
  page.create = create;    // tests (and a second document, if one ever needs it): create({ doc, win, measureText, measureLines })
  return page;
});
