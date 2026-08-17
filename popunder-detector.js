/**
 * Popunder Ad Detector & Filter Rule Generator
 * ---------------------------------------------
 * Hooks the APIs popunder/popup ads rely on, blocks the attempt live,
 * and generates ready-to-paste uBlock Origin / AdGuard filter rules
 * for whatever domain triggered it.
 *
 * Click the bookmarklet once per page to activate. Click again to
 * toggle the panel open/closed (does not re-hook).
 */
(function () {
  'use strict';

  if (window.__popunderDetector) {
    window.__popunderDetector.togglePanel();
    return;
  }

  // =========================================================
  // CONFIG — tweak these
  // =========================================================
  const CONFIG = {
    BLOCK_BY_DEFAULT: true,          // stop the popup/popunder from actually opening
    DEDUPE_BY_DOMAIN: true,          // collapse repeat hits from the same domain into a counter
    PANEL_POSITION: 'bottom-right',  // 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left'
    MAX_LOG: 200,                    // cap on stored detections
  };

  const state = {
    detections: [],   // { type, targetDomain, callerDomain, confidence, count, time }
    blocking: CONFIG.BLOCK_BY_DEFAULT,
    panelOpen: true,
  };

  // =========================================================
  // Helpers
  // =========================================================
  function domainFromUrl(url) {
    if (!url) return null;
    try { return new URL(url, location.href).hostname; }
    catch (e) { return null; }
  }

  // Best-effort: pull the first non-injector script URL out of a stack trace.
  function callerDomainFromStack(stack) {
    if (!stack) return null;
    const lines = stack.split('\n');
    for (const line of lines) {
      const m = line.match(/(https?:\/\/[^\s()]+):\d+:\d+/);
      if (m && !m[1].includes('popunder-detector')) {
        return domainFromUrl(m[1]);
      }
    }
    return null;
  }

  function record(type, targetUrl, callerDomain) {
    const targetDomain = domainFromUrl(targetUrl)
      || (targetUrl === 'about:blank' ? 'about:blank' : targetUrl)
      || 'unknown';

    if (CONFIG.DEDUPE_BY_DOMAIN) {
      const existing = state.detections.find(d => d.type === type && d.targetDomain === targetDomain);
      if (existing) {
        existing.count++;
        existing.time = new Date().toLocaleTimeString();
        renderPanel();
        return;
      }
    }

    state.detections.unshift({
      type, targetDomain, callerDomain,
      count: 1, time: new Date().toLocaleTimeString(),
    });
    if (state.detections.length > CONFIG.MAX_LOG) state.detections.length = CONFIG.MAX_LOG;
    renderPanel();
    updateBadge();
  }

  // uBlock Origin and AdGuard both implement the Adblock Plus-style
  // $popup option, which specifically targets window.open()-spawned
  // windows/tabs — exactly the mechanism popunders use.
  function rulesFor(d) {
    const rules = [];
    if (d.targetDomain && d.targetDomain !== 'unknown' && d.targetDomain !== 'about:blank') {
      rules.push(`||${d.targetDomain}^$popup`);
    }
    if (d.callerDomain && d.callerDomain !== location.hostname) {
      rules.push(`||${d.callerDomain}^`);
    }
    if (rules.length === 0) rules.push('! could not resolve a domain for this hit — check console');
    return rules;
  }

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
    document.body.removeChild(ta);
  }

  // =========================================================
  // Hook 1 — window.open (primary vector, catches most popunders)
  // =========================================================
  let lastOpenTime = 0;
  const nativeOpen = window.open;
  window.open = function (url, name, specs) {
    lastOpenTime = Date.now();
    const caller = callerDomainFromStack(new Error().stack);
    record('window.open', url || 'about:blank', caller);
    if (state.blocking) {
      console.warn('[Popunder Detector] blocked window.open ->', url);
      return null;
    }
    return nativeOpen.apply(window, arguments);
  };

  // =========================================================
  // Hook 2 — self.blur() fired right after an open() call.
  // Classic "push under": open a window, then blur yourself so the
  // new window ends up behind the current tab.
  // =========================================================
  const nativeBlur = window.blur;
  window.blur = function () {
    if (Date.now() - lastOpenTime < 500) {
      record('push-under (blur)', location.href, callerDomainFromStack(new Error().stack));
    }
    return nativeBlur.apply(window, arguments);
  };

  // =========================================================
  // Hook 3 — programmatic .click() on a hidden target="_blank" anchor.
  // A technique that opens a new tab without ever calling window.open
  // directly. Logged only (not blocked) since real "open in new tab"
  // links use the same method.
  // =========================================================
  const nativeAnchorClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    if (this.target === '_blank' && this.href) {
      const rect = this.getBoundingClientRect();
      const hidden = rect.width === 0 || rect.height === 0 || getComputedStyle(this).display === 'none';
      if (hidden) {
        record('synthetic anchor click', this.href, callerDomainFromStack(new Error().stack));
      }
    }
    return nativeAnchorClick.apply(this, arguments);
  };

  // =========================================================
  // Panel UI — Shadow DOM isolated so page CSS can't touch it
  // =========================================================
  const host = document.createElement('div');
  host.id = 'popunder-detector-host';
  host.style.cssText = `all:initial; position:fixed; z-index:2147483647; ${positionCSS()}`;
  document.documentElement.appendChild(host);
  const shadow = host.attachShadow({ mode: 'closed' });

  function positionCSS() {
    switch (CONFIG.PANEL_POSITION) {
      case 'bottom-left': return 'left:12px; bottom:12px;';
      case 'top-right': return 'right:12px; top:12px;';
      case 'top-left': return 'left:12px; top:12px;';
      default: return 'right:12px; bottom:12px;';
    }
  }

  shadow.innerHTML = `
    <style>
      * { box-sizing: border-box; font-family: -apple-system, Roboto, sans-serif; }
      .badge { width:52px; height:52px; border-radius:50%; background:#1a1a2e; color:#0ef;
        border:2px solid #0ef; display:flex; align-items:center; justify-content:center;
        font-size:18px; font-weight:bold; box-shadow:0 2px 10px rgba(0,0,0,.4); cursor:pointer; }
      .panel { display:none; width:min(340px, 90vw); max-height:70vh; overflow-y:auto;
        background:#14141f; color:#e6e6f0; border:1px solid #333; border-radius:10px;
        margin-bottom:8px; font-size:13px; box-shadow:0 4px 20px rgba(0,0,0,.5); }
      .panel.open { display:block; }
      .hdr { padding:10px 12px; display:flex; justify-content:space-between; align-items:center;
        border-bottom:1px solid #2a2a3a; position:sticky; top:0; background:#14141f; }
      .hdr b { color:#0ef; }
      .btn { background:#22223a; color:#e6e6f0; border:1px solid #3a3a55; border-radius:6px;
        padding:6px 10px; font-size:12px; cursor:pointer; }
      .btn:active { background:#33335a; }
      .row { padding:10px 12px; border-bottom:1px solid #22222f; }
      .dom { color:#ff6b6b; font-weight:600; word-break:break-all; }
      .meta { color:#888; font-size:11px; margin:2px 0 6px; }
      .rule { background:#0a0a12; border:1px solid #2a2a3a; border-radius:6px; padding:6px 8px;
        font-family:monospace; font-size:11.5px; margin:4px 0; word-break:break-all; }
      .empty { padding:16px 12px; color:#888; text-align:center; }
      .footer { padding:8px 12px; display:flex; gap:6px; flex-wrap:wrap; border-top:1px solid #2a2a3a;
        position:sticky; bottom:0; background:#14141f; }
      .toggle { display:flex; align-items:center; gap:6px; font-size:12px; }
    </style>
    <div class="panel" id="panel">
      <div class="hdr"><span><b>Popunder Detector</b></span><button class="btn" id="closeBtn">Close</button></div>
      <div id="list"><div class="empty">No popunder attempts caught yet.<br>Click around the page normally.</div></div>
      <div class="footer">
        <button class="btn" id="copyAllBtn">Copy all rules</button>
        <label class="toggle"><input type="checkbox" id="blockToggle" checked> Block live</label>
        <button class="btn" id="deactivateBtn">Deactivate</button>
      </div>
    </div>
    <div class="badge" id="badge">0</div>
  `;

  const $panel = shadow.getElementById('panel');
  const $list = shadow.getElementById('list');
  const $badge = shadow.getElementById('badge');
  const $blockToggle = shadow.getElementById('blockToggle');

  shadow.getElementById('badge').addEventListener('click', togglePanel);
  shadow.getElementById('closeBtn').addEventListener('click', togglePanel);
  shadow.getElementById('copyAllBtn').addEventListener('click', () => {
    const all = state.detections.flatMap(d => rulesFor(d));
    copyText([...new Set(all)].join('\n'));
    flashBadgeText('OK');
  });
  shadow.getElementById('deactivateBtn').addEventListener('click', deactivate);
  $blockToggle.addEventListener('change', e => { state.blocking = e.target.checked; });

  function togglePanel() {
    state.panelOpen = !state.panelOpen;
    $panel.classList.toggle('open', state.panelOpen);
  }
  function updateBadge() { $badge.textContent = String(state.detections.length); }
  function flashBadgeText(txt) {
    const old = $badge.textContent;
    $badge.textContent = txt;
    setTimeout(() => $badge.textContent = old, 800);
  }

  function renderPanel() {
    if (state.detections.length === 0) {
      $list.innerHTML = '<div class="empty">No popunder attempts caught yet.<br>Click around the page normally.</div>';
      return;
    }
    $list.innerHTML = state.detections.map((d, i) => `
      <div class="row">
        <div class="dom">${escapeHtml(d.targetDomain)}${d.count > 1 ? ` ×${d.count}` : ''}</div>
        <div class="meta">${escapeHtml(d.type)} · caller: ${escapeHtml(d.callerDomain || 'unknown')} · ${d.time}</div>
        ${rulesFor(d).map(r => `<div class="rule">${escapeHtml(r)}</div>`).join('')}
        <button class="btn copy-one" data-i="${i}">Copy this rule</button>
      </div>
    `).join('');
    shadow.querySelectorAll('.copy-one').forEach(btn => {
      btn.addEventListener('click', () => {
        const d = state.detections[+btn.dataset.i];
        copyText(rulesFor(d).join('\n'));
        btn.textContent = 'Copied';
        setTimeout(() => btn.textContent = 'Copy this rule', 1000);
      });
    });
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  function deactivate() {
    window.open = nativeOpen;
    window.blur = nativeBlur;
    HTMLAnchorElement.prototype.click = nativeAnchorClick;
    host.remove();
    delete window.__popunderDetector;
    console.info('[Popunder Detector] deactivated, native functions restored.');
  }

  window.__popunderDetector = { togglePanel, deactivate, state };

  renderPanel();
  updateBadge();
  console.info('[Popunder Detector] active — badge is bottom-right.');
})();
