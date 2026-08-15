/*
  Standalone Element Picker (inspired by uBlock Origin's element picker)
  No hiding/zapping — pure selector inspection tool.

  Usage: tap an element -> see candidate CSS selectors (most specific to
  most general) -> tap a candidate to preview matches highlighted on the
  page -> tap Copy to copy the selector text -> Up/Down to walk to a
  parent/child element and regenerate candidates for it.
*/
(function () {
  if (window.__epicker) {
    window.__epicker.disable();
    return;
  }

  const state = { current: null, stack: [], panel: null, handler: null, highlighted: [] };
  window.__epicker = state;

  // ---------- selector helpers ----------

  function classSelector(el) {
    if (!el.classList.length) return '';
    return '.' + Array.from(el.classList).map(c => CSS.escape(c)).join('.');
  }

  function fullPath(el) {
    const parts = [];
    let node = el, depth = 0;
    while (node && node.nodeType === 1 && depth < 8) {
      if (node.id) {
        parts.unshift('#' + CSS.escape(node.id));
        break;
      }
      let seg = node.tagName.toLowerCase();
      const parent = node.parentElement;
      if (parent) {
        const same = Array.from(parent.children).filter(c => c.tagName === node.tagName);
        if (same.length > 1) seg += ':nth-of-type(' + (same.indexOf(node) + 1) + ')';
      }
      parts.unshift(seg);
      node = parent;
      depth++;
    }
    return parts.join(' > ');
  }

  function nearestIdAncestor(el) {
    let node = el.parentElement, depth = 0;
    while (node && depth < 6) {
      if (node.id) return node;
      node = node.parentElement;
      depth++;
    }
    return null;
  }

  function candidatesFor(el) {
    const list = [];
    const tag = el.tagName.toLowerCase();
    const cls = classSelector(el);

    if (el.id) list.push({ label: 'ID', value: '#' + CSS.escape(el.id) });
    if (cls) {
      list.push({ label: 'Tag + classes', value: tag + cls });
      list.push({ label: 'Classes only', value: cls });
    }
    const anc = nearestIdAncestor(el);
    if (anc) {
      list.push({ label: 'Inside #' + anc.id, value: '#' + CSS.escape(anc.id) + ' ' + tag + cls });
    }
    list.push({ label: 'Tag only', value: tag });
    list.push({ label: 'Full path', value: fullPath(el) });

    const seen = new Set();
    return list.filter(c => c.value && !seen.has(c.value) && seen.add(c.value));
  }

  function ancestorChain(el) {
    const chain = [];
    let node = el, depth = 0;
    while (node && node.tagName && node.tagName !== 'BODY' && node.tagName !== 'HTML' && depth < 10) {
      chain.unshift(node);
      node = node.parentElement;
      depth++;
    }
    return chain;
  }

  // ---------- highlight preview ----------

  function clearHighlights() {
    state.highlighted.forEach(el => {
      el.style.outline = el.__epickerOldOutline || '';
      el.style.outlineOffset = '';
    });
    state.highlighted = [];
  }

  function previewSelector(sel) {
    clearHighlights();
    let matches;
    try {
      matches = document.querySelectorAll(sel);
    } catch (e) {
      return 0;
    }
    matches.forEach(el => {
      el.__epickerOldOutline = el.style.outline;
      el.style.outline = '2px solid #e6432c';
      el.style.outlineOffset = '-2px';
    });
    state.highlighted = Array.from(matches);
    return matches.length;
  }

  // ---------- clipboard ----------

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
    } else {
      fallbackCopy(text);
    }
  }

  function fallbackCopy(text) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch (e) {}
    ta.remove();
  }

  // ---------- panel ----------

  const panel = document.createElement('div');
  panel.style.cssText =
    'position:fixed;top:12px;right:12px;z-index:2147483647;background:#fff;' +
    'border:1px solid #ddd;border-radius:10px;padding:12px;box-shadow:0 4px 20px rgba(0,0,0,.2);' +
    'width:280px;max-height:80vh;overflow-y:auto;font-family:sans-serif;color:#222;font-size:13px;';
  document.body.appendChild(panel);
  state.panel = panel;

  function render() {
    const el = state.current;
    let html = '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">' +
      '<strong style="font-size:14px;">Element Picker</strong>' +
      '<button id="epk-close" style="background:none;border:none;font-size:16px;cursor:pointer;color:#888;">\u2715</button></div>';

    if (!el) {
      html += '<p style="color:#888;text-align:center;padding:12px 0;">Tap an element on the page to inspect it</p>';
      panel.innerHTML = html;
      panel.querySelector('#epk-close').addEventListener('click', disable);
      return;
    }

    html += '<div style="background:#f7f7f7;border-radius:6px;padding:8px;margin-bottom:8px;">' +
      '<div><b>Tag:</b> ' + el.tagName.toLowerCase() + '</div>' +
      (el.id ? '<div><b>ID:</b> ' + el.id + '</div>' : '') +
      (el.className && typeof el.className === 'string' ? '<div><b>Classes:</b> ' + el.className + '</div>' : '') +
      '</div>';

    html += '<div style="display:flex;gap:6px;margin-bottom:8px;">' +
      '<button id="epk-up" style="flex:1;padding:6px;background:#eee;border:none;border-radius:6px;cursor:pointer;">\u2191 Parent</button>' +
      '<button id="epk-down" style="flex:1;padding:6px;background:#eee;border:none;border-radius:6px;cursor:pointer;" ' +
      (state.stack.length ? '' : 'disabled') + '>\u2193 Child</button></div>';

    html += '<div style="font-weight:600;margin-bottom:4px;">Candidate selectors</div>';
    const cands = candidatesFor(el);
    cands.forEach((c, i) => {
      html += '<div class="epk-cand" data-i="' + i + '" style="border:1px solid #eee;border-radius:6px;padding:6px;margin-bottom:6px;cursor:pointer;">' +
        '<div style="font-size:11px;color:#888;">' + c.label + '</div>' +
        '<div style="display:flex;align-items:center;gap:6px;">' +
        '<code style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;">' + c.value.replace(/</g, '&lt;') + '</code>' +
        '<button class="epk-copy" data-i="' + i + '" style="background:#e6432c;color:#fff;border:none;border-radius:4px;padding:4px 8px;font-size:11px;cursor:pointer;">Copy</button>' +
        '</div><div class="epk-count" data-i="' + i + '" style="font-size:11px;color:#666;margin-top:2px;"></div>' +
        '</div>';
    });

    panel.innerHTML = html;
    panel.querySelector('#epk-close').addEventListener('click', disable);
    panel.querySelector('#epk-up').addEventListener('click', goUp);
    const downBtn = panel.querySelector('#epk-down');
    if (!downBtn.disabled) downBtn.addEventListener('click', goDown);

    panel.querySelectorAll('.epk-cand').forEach(row => {
      row.addEventListener('click', (e) => {
        if (e.target.classList.contains('epk-copy')) return;
        const i = +row.dataset.i;
        const n = previewSelector(cands[i].value);
        panel.querySelector('.epk-count[data-i="' + i + '"]').textContent = n + ' match' + (n === 1 ? '' : 'es') + ' highlighted on page';
      });
    });
    panel.querySelectorAll('.epk-copy').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const i = +btn.dataset.i;
        copyText(cands[i].value);
        btn.textContent = 'Copied!';
        setTimeout(() => { btn.textContent = 'Copy'; }, 1200);
      });
    });
  }

  function select(el) {
    clearHighlights();
    state.current = el;
    state.stack = [];
    render();
  }

  function goUp() {
    if (!state.current || !state.current.parentElement) return;
    state.stack.push(state.current);
    state.current = state.current.parentElement;
    clearHighlights();
    render();
  }

  function goDown() {
    if (!state.stack.length) return;
    state.current = state.stack.pop();
    clearHighlights();
    render();
  }

  // ---------- pick clicks on the page ----------

  state.handler = function (e) {
    if (panel.contains(e.target)) return;
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    select(e.target);
    return false;
  };
  document.addEventListener('click', state.handler, true);

  function disable() {
    clearHighlights();
    document.removeEventListener('click', state.handler, true);
    if (panel.parentNode) panel.remove();
    delete window.__epicker;
  }
  state.disable = disable;

  render();
})();
