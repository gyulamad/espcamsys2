'use strict';
// icon-picker.js — an icon chooser bubble for a text input, like the emoji pickers of chat apps: a click on
// the input opens a bubble under it with a search bar on top and the icons below; a click on an icon puts it
// in the input. Loaded by the camera settings page as a plain script (window.CamIconPicker) and by
// tests/node/test_icon_picker.js (the search and the key rules, with require()).
//
// The icons come from js/icon-catalog.js (groups of [icon, name, search words]). Everything shown is built with
// createElement and textContent, never as markup, so an icon or a name can not become HTML. The input stays a
// plain input: a person can still type any icon by hand, and the page's own handlers see the same `input` and
// `change` events as for typing.

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CamIconPicker = api;
})(typeof self !== 'undefined' ? self : this, function () {
  // ── the rules (no page needed) ─────────────────────────────────────

  // The words of a search: lower case, split at spaces, nothing empty.
  function terms(query) {
    return String(query == null ? '' : query).toLowerCase().split(/\s+/).filter(Boolean);
  }

  // How well one term fits one icon: 0 the name starts with it, 1 a word of the name or the search words
  // starts with it, 2 it is somewhere in them, 3 it is the icon itself (an icon pasted into the search);
  // null: no fit.
  function termScore(term, [icon, name, words]) {
    const title = name.toLowerCase();
    if (title.startsWith(term)) return 0;
    const all = (title + ' ' + (words || '')).toLowerCase();
    if (all.split(' ').some((word) => word.startsWith(term))) return 1;
    if (all.includes(term)) return 2;
    return icon.includes(term) ? 3 : null;
  }

  // The icons for a search. An empty search gives every group as it is. Else one group without a title with
  // the icons that fit EVERY word of the search, the best fit first (equal fits stay in the catalog's order).
  // -> [{ title, icons: [{ icon, name }] }], never a group without icons.
  function search(groups, query) {
    const wanted = terms(query);
    const entries = [];
    (groups || []).forEach((group) => (group.icons || []).forEach((entry) => entries.push({ group, entry, order: entries.length })));
    if (wanted.length === 0) {
      return (groups || []).filter((g) => (g.icons || []).length > 0)
        .map((g) => ({ title: g.title, icons: g.icons.map(([icon, name]) => ({ icon, name })) }));
    }
    const found = [];
    for (const item of entries) {
      let score = 0;
      for (const term of wanted) {
        const fit = termScore(term, item.entry);
        if (fit === null) { score = null; break; }
        score += fit;
      }
      if (score !== null) found.push({ score, order: item.order, icon: item.entry[0], name: item.entry[1] });
    }
    if (found.length === 0) return [];
    found.sort((a, b) => a.score - b.score || a.order - b.order);
    return [{ title: '', icons: found.map(({ icon, name }) => ({ icon, name })) }];
  }

  // Where the arrow keys go in the grid of icons: the new index of the icon with the focus, or null when the
  // key does nothing. `cols`: how many icons are in a row. Up from the first row (null) is the caller's to
  // handle: it goes back to the search bar.
  function moveIndex(index, key, cols, total) {
    const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -cols, ArrowDown: cols }[key];
    if (step === undefined || total <= 0) return null;
    const next = index + step;
    if (key === 'ArrowDown' && next >= total) {
      const lastRowStart = Math.floor((total - 1) / cols) * cols;
      return index >= lastRowStart ? null : total - 1;   // into a short last row: its last icon
    }
    if (next < 0 || next >= total) return null;
    return next;
  }

  // How far (px) the bubble has to move to the left to be fully on the screen: `left` and `width` are its
  // place and size, `viewportWidth` the width of the window, `margin` the space to keep at the edge. Never
  // so far that its left edge leaves the screen (a window narrower than the bubble: the right edge loses).
  function shiftToFit(left, width, viewportWidth, margin) {
    const overflow = left + width - (viewportWidth - margin);
    if (overflow <= 0) return 0;
    return Math.min(overflow, Math.max(0, left - margin));
  }

  // ── the bubble ─────────────────────────────────────────────────────

  const EDGE_MARGIN = 12;   // px kept free between the bubble and the edge of the window
  const ARROW_X = 28;       // px from the bubble's left edge to its arrow (the CSS default of --arrow-x)

  function element(doc, tag, className, props) {
    const el = doc.createElement(tag);
    if (className) el.className = className;
    return Object.assign(el, props || {});
  }

  // Puts the bubble on `input`. -> { open, close, isOpen, destroy }.
  //   groups: the catalog's GROUPS.  `doc`: the document (default: the page's).
  function attach(input, groups, doc) {
    const d = doc || document;

    // the input goes into a box of its own, so the bubble can sit right under it
    const box = element(d, 'span', 'icon-picker');
    input.parentNode.insertBefore(box, input);
    box.appendChild(input);

    const bubble = element(d, 'div', 'icon-bubble', { hidden: true });
    bubble.setAttribute('role', 'dialog');
    bubble.setAttribute('aria-label', 'Choose an icon');
    const searchBox = element(d, 'input', 'icon-search', { type: 'search', placeholder: 'Search icons…', autocomplete: 'off', spellcheck: false });
    searchBox.setAttribute('aria-label', 'Search icons');
    const results = element(d, 'div', 'icon-results');
    bubble.append(searchBox, results);
    box.appendChild(bubble);

    input.setAttribute('aria-haspopup', 'dialog');
    input.setAttribute('aria-expanded', 'false');

    let opened = false;
    let keepClosed = false;   // true while WE move the focus back to the input: that must not open the bubble again

    const choices = () => Array.from(results.querySelectorAll('.icon-choice'));

    function render() {
      results.replaceChildren();
      const shown = search(groups, searchBox.value);
      if (shown.length === 0) {
        results.appendChild(element(d, 'div', 'icon-empty', { textContent: 'No icon found' }));
        results.lastChild.setAttribute('role', 'status');
        return;
      }
      for (const group of shown) {
        if (group.title) results.appendChild(element(d, 'div', 'icon-group', { textContent: group.title }));
        const grid = element(d, 'div', 'icon-grid');
        for (const { icon, name } of group.icons) {
          const choice = element(d, 'button', 'icon-choice' + (icon === input.value ? ' selected' : ''), { type: 'button', textContent: icon, title: name });
          choice.setAttribute('aria-label', name);
          choice.setAttribute('aria-pressed', icon === input.value ? 'true' : 'false');
          choice.dataset.icon = icon;
          grid.appendChild(choice);
        }
        results.appendChild(grid);
      }
    }

    function focusInput() {
      keepClosed = true;
      try { input.focus(); } finally { keepClosed = false; }
    }

    // Under the input, moved to the left as far as it takes to be on the screen; the arrow keeps pointing at the input.
    function place() {
      bubble.style.left = '';
      bubble.style.removeProperty('--arrow-x');
      const shift = shiftToFit(bubble.getBoundingClientRect().left, bubble.offsetWidth, d.documentElement.clientWidth, EDGE_MARGIN);
      if (shift === 0) return;
      bubble.style.left = -shift + 'px';
      bubble.style.setProperty('--arrow-x', ARROW_X + shift + 'px');
    }

    function open() {
      if (opened) return;
      opened = true;
      searchBox.value = '';
      render();
      bubble.hidden = false;
      place();
      input.setAttribute('aria-expanded', 'true');
      results.scrollTop = 0;
      searchBox.focus();   // type to find
    }

    function close(giveFocusBack) {
      if (!opened) return;
      opened = false;
      bubble.hidden = true;
      input.setAttribute('aria-expanded', 'false');
      if (giveFocusBack) focusInput();
    }

    // An icon was chosen: into the input, announced like typing, and the bubble is done.
    function choose(icon) {
      input.value = icon;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      close(true);
    }

    function iconsPerRow(list) {
      if (list.length === 0) return 1;
      const top = list[0].offsetTop;
      const inFirstRow = list.filter((c) => c.offsetTop === top).length;
      return Math.max(1, inFirstRow);
    }

    function onInputOpen() {
      if (!keepClosed) open();
    }
    input.addEventListener('focus', onInputOpen);
    input.addEventListener('click', onInputOpen);   // a click on the input after the bubble was closed with Esc
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') close(false);
      else if (e.key === 'ArrowDown' && !opened) open();
    });

    searchBox.addEventListener('input', render);
    searchBox.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();   // never sends a form
        const first = choices()[0];
        if (first) choose(first.dataset.icon);
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        const first = choices()[0];
        if (first) first.focus();
      }
    });

    results.addEventListener('click', (e) => {
      const choice = e.target.closest ? e.target.closest('.icon-choice') : null;
      if (choice) choose(choice.dataset.icon);
    });
    results.addEventListener('keydown', (e) => {
      const list = choices();
      const index = list.indexOf(e.target);
      if (index < 0) return;
      const cols = iconsPerRow(list);
      if (e.key === 'ArrowUp' && index < cols) { e.preventDefault(); searchBox.focus(); return; }
      const next = moveIndex(index, e.key, cols, list.length);
      if (next === null) return;
      e.preventDefault();
      list[next].focus();
    });

    // Esc anywhere in the bubble closes it and gives the focus back to the input; leaving it by Tab closes it too
    bubble.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(true); } });
    box.addEventListener('focusout', (e) => {
      if (e.relatedTarget && !box.contains(e.relatedTarget)) close(false);   // no target (a click on the bubble's own background) is not leaving
    });
    const onOutsideClick = (e) => { if (!box.contains(e.target)) close(false); };
    const onResize = () => { if (opened) place(); };
    d.addEventListener('mousedown', onOutsideClick);
    (d.defaultView || window).addEventListener('resize', onResize);

    function destroy() {
      d.removeEventListener('mousedown', onOutsideClick);
      (d.defaultView || window).removeEventListener('resize', onResize);
      close(false);
    }

    return { open, close: () => close(true), isOpen: () => opened, destroy };
  }

  return { terms, search, moveIndex, shiftToFit, attach };
});
