/*!
 * uBO-style standalone Element Picker (bookmarklet edition)
 * ------------------------------------------------------------------
 * Ported from uBlock Origin's own source (GPLv3):
 *   - src/js/scriptlets/epicker.js   (page-side picking / filter algorithm)
 *   - src/js/epicker-ui.js           (dialog UI logic)
 *   - src/css/epicker-ui.css         (dialog UI styling)
 *   - src/web_accessible_resources/epicker-ui.html (dialog markup)
 * uBlock Origin: Copyright (C) 2014-present Raymond Hill, GPLv3.
 *   https://github.com/gorhill/uBlock
 *
 * This file merges the two contexts uBO normally splits across an
 * extension content-script and a sandboxed iframe (they talked to each
 * other over postMessage/MessageChannel) into a single in-page script,
 * since a bookmarklet has no extension background page and no
 * web_accessible_resources to load into an iframe. Isolation from the
 * host page's CSS is done with a Shadow DOM root instead of an iframe.
 *
 * Not ported (extension-only features with no standalone equivalent):
 *   - CodeMirror editor (replaced with a plain styled <textarea>)
 *   - Full static-filtering AST validator (replaced with a light regex check)
 *   - Persisting created filters to a real uBO filter list (replaced with
 *     clipboard copy + immediate CSS hide, see onCreateClicked)
 *   - Cross-session "net filter union" memory, procedural cosmetic filters,
 *     the element zapper's separate minimal UI
 *
 * Run again (re-fire the bookmarklet) to close the picker.
 */
(function ubloPickerBookmarklet() {
'use strict';

/* ---------------------------------------------------------------------
   Re-entry guard: firing the bookmarklet again quits an active picker.
--------------------------------------------------------------------- */
if (window.__uboPickerInstance) {
    window.__uboPickerInstance.quit();
    return;
}

const PICKER_ID = 'ubo-picker-' + Math.random().toString(36).slice(2, 10);
const reCosmeticAnchor = /^#(?:\$|\?|\$\?)?#/;
const hideStyle = 'display:none!important;';

/* ---------------------------------------------------------------------
   Shadow DOM host: isolates the picker's own styles from the host page
   (and vice versa) the way uBO's sandboxed iframe used to.
--------------------------------------------------------------------- */
const hostEl = document.createElement('div');
hostEl.id = PICKER_ID;
hostEl.style.cssText = [
    'all: initial',
    'position: fixed',
    'inset: 0',
    'z-index: 2147483647',
    'pointer-events: none',
].join(' !important; ') + ' !important;';
document.documentElement.appendChild(hostEl);

const shadow = hostEl.attachShadow({ mode: 'open' });

const cssText = `
:host {
    all: initial;
    color-scheme: light dark;
    font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Inter, sans-serif;
    --surface-1: #f0f0f2;
    --surface-2: #e2e2e5;
    --surface-3: #c6c6cc;
    --border-1: #b8b8c0;
    --border-2: #aaaab4;
    --ink-1: rgb(32 18 58);
    --ink-100: #fff;
    --accent: rgb(34 93 176);
    --accent-ink: #fff;
    --error: #c00004;
    --button-surface: var(--surface-3);
    --font-size-smaller: 13px;
}
@media (prefers-color-scheme: dark) {
    :host {
        --surface-1: rgb(27 27 35);
        --surface-2: rgb(47 47 59);
        --surface-3: rgb(69 69 85);
        --border-1: rgb(81 81 98);
        --border-2: rgb(93 93 110);
        --ink-1: rgb(226 226 229);
        --ink-100: #000;
        --accent: rgb(137 170 247);
        --accent-ink: #000;
        --error: #ff5354;
        --button-surface: var(--surface-3);
    }
}
* { box-sizing: border-box; }
aside {
    background-color: var(--surface-1);
    border: 1px solid var(--border-2);
    border-radius: 6px;
    box-shadow: 0 4px 24px rgba(0,0,0,.35);
    box-sizing: border-box;
    color: var(--ink-1);
    cursor: default;
    display: flex;
    flex-direction: column;
    max-width: min(32rem, 100vw - 4px);
    min-width: min(24rem, 100vw - 4px);
    overflow-y: auto;
    overflow-x: hidden;
    pointer-events: auto;
    position: fixed;
    width: min(32rem, 100vw - 4px);
    z-index: 100;
}
:host(.paused) aside {}
:host(:not(.paused)) aside,
:host(.minimized) aside {
    min-width: min(16rem, 100vw - 4px);
    overflow: hidden;
    width: min(16rem, 100vw - 4px);
}
:host(:not(.paused)) aside > *:not(#windowbar),
:host(.minimized) aside > *:not(#windowbar) {
    display: none;
}
aside > *:not(:first-child) { padding: 0 6px 6px; }

#windowbar {
    display: flex;
    cursor: default;
}
#windowbar svg {
    fill: none;
    pointer-events: none;
    stroke: var(--ink-1);
    stroke-width: 3px;
}
#windowbar > div { position: relative; }
#move {
    background-image: radial-gradient(circle, var(--border-2) 1px, transparent 1.2px);
    background-size: 6px 6px;
    background-position: center;
    cursor: grab;
    flex-grow: 1;
    min-height: 2em;
    opacity: .8;
}
aside.moving #move { cursor: grabbing; }
#quit, #minimize {
    align-items: center;
    display: flex;
    height: 2em;
    justify-content: center;
    width: 2em;
}
#quit:hover, #minimize:hover { background-color: var(--surface-2); }
#quit svg, #minimize svg { width: 60%; height: 60%; }
:host(.minimized) #minimize svg > path,
#minimize svg > rect { display: none; }
:host(.minimized) #minimize svg > rect { display: inline; }

section { border: 0; box-sizing: border-box; display: block; width: 100%; }
section > div:first-child {
    border: 1px solid var(--surface-3);
    border-radius: 4px;
    margin: 6px 0 0;
    position: relative;
}
section.invalidFilter > div:first-child { border-color: var(--error); }
#filterInput {
    background: transparent;
    border: none;
    box-sizing: border-box;
    color: var(--ink-1);
    display: block;
    font: 12px/1.4 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    height: 6em;
    max-height: min(6em, 10vh);
    min-height: 1em;
    outline: none;
    padding: 4px;
    resize: none;
    width: 100%;
}
.resultsetWidgets { display: flex; font-size: var(--font-size-smaller); }
#resultsetModifiers {
    align-items: flex-end;
    display: inline-flex;
    flex-grow: 1;
    justify-content: space-evenly;
}
#resultsetModifiers.hide > * { visibility: hidden; }
.resultsetModifier { border: 0; pointer-events: auto; position: relative; width: 40%; }
.resultsetModifier > span { align-items: flex-end; display: flex; height: 100%; pointer-events: none; width: 100%; }
.resultsetModifier > span > span { margin: 2px 0; }
.resultsetModifier > span > span:nth-of-type(1) {
    background-color: var(--accent);
    border-inline-end: 1px solid var(--surface-3);
    display: inline-block; flex-shrink: 0; height: 6px;
}
.resultsetModifier > span > span:nth-of-type(2) {
    background-color: var(--accent);
    clip-path: polygon(calc(50% - 2px) 0%, 0% calc(100% - 6px), 0% 100%, 100% 100%, 100% calc(100% - 6px), calc(50% + 2px) 0%);
    display: inline-block; flex-shrink: 0; height: 20px; width: 20px;
}
.resultsetModifier > span > span:nth-of-type(3) {
    background-color: var(--surface-3);
    border-inline-start: 1px solid var(--surface-3);
    display: inline-block; flex-grow: 1; height: 6px;
}
.resultsetModifier input {
    border: 0; height: 100%; left: 0; margin: 0; opacity: 0;
    padding: 0; position: absolute; top: 0; width: 100%; cursor: pointer;
}
#resultsetCount {
    align-items: center;
    background-color: var(--surface-3);
    border-radius: 3px;
    color: var(--ink-1);
    display: inline-flex;
    justify-content: center;
    min-width: 2.2em;
    padding: 0 2px;
}
section.invalidFilter #resultsetCount { background-color: var(--error); color: var(--ink-100); }
section > div:first-child + div { direction: ltr; margin: 4px 0; text-align: right; }

#toolbar { display: flex; justify-content: space-between; gap: 6px; margin-top: 6px; }
#toolbar > div { display: flex; gap: 6px; }
button {
    align-items: center;
    appearance: none;
    border: 0;
    border-radius: 5px;
    background-color: var(--button-surface);
    color: var(--ink-1);
    cursor: pointer;
    display: inline-flex;
    font-size: 13px;
    justify-content: center;
    min-height: 32px;
    min-width: 5em;
    padding: 0 12px;
    position: relative;
}
button:hover { filter: brightness(0.93); }
@media (prefers-color-scheme: dark) {
    button:hover { filter: brightness(1.2); }
}
button[disabled] { opacity: .5; pointer-events: none; }
button.preferred { background-color: var(--accent); color: var(--accent-ink); }
:host(.preview) #preview { background-color: var(--accent); color: var(--accent-ink); }

ul { margin: 6px 0 0; padding: 0; list-style-type: none; text-align: left; overflow: hidden; }
#candidateFilters { max-height: min(18em, 18vh); overflow-y: auto; }
#candidateFilters > li > span:first-child { font-size: 90%; font-weight: bold; }
#candidateFilters .changeFilter { list-style-type: none; margin: 2px 0 8px 1em; overflow: hidden; text-align: left; }
#candidateFilters .changeFilter li {
    border: 1px solid transparent; cursor: pointer; direction: ltr;
    font: 12px/1.4 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    white-space: nowrap; border-radius: 2px; padding: 0 2px;
}
#candidateFilters .changeFilter li.active { border: 1px dotted rgb(0 96 223); }
#candidateFilters .changeFilter li:hover { background-color: var(--surface-2); }

svg#sea { cursor: crosshair; box-sizing: border-box; height: 100%; left: 0; position: absolute; top: 0; width: 100%; pointer-events: auto; }
:host(.paused) svg#sea { cursor: not-allowed; }
svg#sea > path:first-child { fill: rgba(0,0,0,.5); fill-rule: evenodd; }
svg#sea > path + path { stroke: #f00; stroke-width: .5px; fill: rgba(255,63,63,.20); }
:host(.preview) svg#sea > path { fill: rgba(0,0,0,.10); }
:host(.preview) svg#sea > path + path { stroke: none; }

#toast {
    position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%) translateY(8px);
    background: var(--ink-1); color: var(--surface-1); padding: 8px 14px; border-radius: 6px;
    font-size: 13px; max-width: min(90vw, 34rem); text-align: center; opacity: 0;
    pointer-events: none; transition: opacity .15s ease, transform .15s ease; z-index: 200;
}
#toast.show { opacity: .95; transform: translateX(-50%) translateY(0); }
`;

const styleEl = document.createElement('style');
styleEl.textContent = cssText;
shadow.appendChild(styleEl);

/* ---------------------------------------------------------------------
   Markup: a faithful port of web_accessible_resources/epicker-ui.html
   (CodeMirror swapped for a plain <textarea>).
--------------------------------------------------------------------- */
const markup = `
<aside style="right:8px;bottom:8px;">
  <div id="windowbar">
    <div id="minimize" title="Minimize">
      <svg viewBox="0 0 64 64"><path d="M 16,48 H 48"/><rect x="16" y="16" height="32" width="32"/></svg>
    </div>
    <div id="move"></div>
    <div id="quit" title="Quit picker">
      <svg viewBox="0 0 64 64"><path d="M16 16L48 48M16 48L48 16"/></svg>
    </div>
  </div>
  <section>
    <div>
      <textarea id="filterInput" spellcheck="false" autocapitalize="off" placeholder="##selector or a network filter"></textarea>
      <div class="resultsetWidgets">
        <span id="resultsetModifiers">
          <span id="resultsetDepth" class="resultsetModifier" title="Ancestor depth">
            <span><span></span><span></span><span></span></span>
            <input type="range" min="0" max="7" value="7">
          </span>
          <span id="resultsetSpecificity" class="resultsetModifier" title="Specificity">
            <span><span></span><span></span><span></span></span>
            <input type="range" min="0" max="7" value="6">
          </span>
        </span>
        <span id="resultsetCount"></span>
      </div>
    </div>
    <div id="toolbar">
      <div>
        <button id="pick" type="button">Pick<span class="hover"></span></button>
        <button id="preview" type="button">Preview<span class="hover"></span></button>
      </div>
      <button id="create" type="button" class="preferred" disabled>Create<span class="hover"></span></button>
    </div>
  </section>
  <ul id="candidateFilters">
    <li id="netFilters"><span>Network filters</span><ul class="changeFilter"></ul></li>
    <li id="cosmeticFilters" data-specificity="3"><span>Cosmetic filters</span><ul class="changeFilter"></ul></li>
  </ul>
</aside>
<svg id="sea"><path d=""></path><path d=""></path></svg>
<div id="toast"></div>
`;
shadow.appendChild(document.createRange().createContextualFragment(markup));

const $ = sel => shadow.querySelector(sel);
const $$ = sel => shadow.querySelectorAll(sel);
const dialog = $('aside');
const svgRoot = $('svg#sea');
const svgOcean = svgRoot.children[0];
const svgIslands = svgRoot.children[1];
const NoPaths = 'M0 0';
const filterInput = $('#filterInput');
const toastEl = $('#toast');

let toastTimer;
function toast(msg, ms) {
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), ms || 2200);
}

/* =======================================================================
   PAGE-SIDE ALGORITHM
   Ported near-verbatim from src/js/scriptlets/epicker.js.
======================================================================= */

const netFilterCandidates = [];
const cosmeticFilterCandidates = [];
let targetElements = [];
let candidateElements = [];
let bestCandidateFilter = null;

const safeQuerySelectorAll = function(node, selector) {
    if (node !== null) {
        try { return node.querySelectorAll(selector); } catch (ex) {}
    }
    return [];
};

const getElementBoundingClientRect = function(elem) {
    let rect = typeof elem.getBoundingClientRect === 'function'
        ? elem.getBoundingClientRect()
        : { height: 0, left: 0, top: 0, width: 0 };
    if (rect.width !== 0 && rect.height !== 0) return rect;
    if (elem.shadowRoot instanceof DocumentFragment) {
        return getElementBoundingClientRect(elem.shadowRoot);
    }
    let left = rect.left, right = left + rect.width, top = rect.top, bottom = top + rect.height;
    for (const child of elem.children) {
        rect = getElementBoundingClientRect(child);
        if (rect.width === 0 || rect.height === 0) continue;
        if (rect.left < left) left = rect.left;
        if (rect.right > right) right = rect.right;
        if (rect.top < top) top = rect.top;
        if (rect.bottom > bottom) bottom = rect.bottom;
    }
    return { bottom, height: bottom - top, left, right, top, width: right - left };
};

const highlightElements = function(elems, force) {
    if ((force !== true) && (elems.length === targetElements.length) &&
        (elems.length === 0 || elems[0] === targetElements[0])) {
        return;
    }
    targetElements = [];
    const ow = self.innerWidth, oh = self.innerHeight;
    const islands = [];
    for (const elem of elems) {
        if (elem === hostEl) continue;
        targetElements.push(elem);
        const rect = getElementBoundingClientRect(elem);
        if (rect.left > ow || rect.top > oh || rect.left + rect.width < 0 || rect.top + rect.height < 0) continue;
        islands.push(`M${rect.left} ${rect.top}h${rect.width}v${rect.height}h-${rect.width}z`);
    }
    const ocean = `M0 0h${ow}v${oh}h-${ow}z`;
    const islandsD = islands.join('');
    svgOcean.setAttribute('d', ocean + islandsD);
    svgIslands.setAttribute('d', islandsD || NoPaths);
};

// Simplified: uBO merges multiple resource URLs into one wildcarded
// pattern using google-diff-match-patch. That library isn't ported here
// (too large for a bookmarklet payload) — we fall back to "use the first
// URL found", which still yields a valid, if less broad, net filter.
const mergeStrings = function(urls) {
    return urls.length === 0 ? '' : urls[0];
};

const trimFragmentFromURL = function(url) {
    const pos = url.indexOf('#');
    return pos !== -1 ? url.slice(0, pos) : url;
};

const backgroundImageURLFromElement = function(elem) {
    const style = window.getComputedStyle(elem);
    const bgImg = style.backgroundImage || '';
    const matches = /^url\((["']?)([^"']+)\1\)$/.exec(bgImg);
    const url = matches !== null && matches.length === 3 ? matches[2] : '';
    return url.lastIndexOf('data:', 0) === -1 ? trimFragmentFromURL(url.slice(0, 1024)) : '';
};

const netFilter1stSources = {
     'audio': 'src', 'embed': 'src', 'iframe': 'src', 'img': 'src',
     'image': 'href', 'object': 'data', 'source': 'src', 'video': 'src'
};
const filterTypes = {
     'audio': 'media', 'embed': 'object', 'iframe': 'subdocument',
     'img': 'image', 'object': 'object', 'video': 'media'
};

const resourceURLsFromSrcset = function(elem, out) {
    let srcset = elem.srcset;
    if (typeof srcset !== 'string' || srcset === '') return;
    for (;;) {
        srcset = srcset.trim();
        if (srcset.length === 0) break;
        if (/^,/.test(srcset)) break;
        let match = /^\S+/.exec(srcset);
        if (match === null) break;
        srcset = srcset.slice(match.index + match[0].length);
        let url = match[0];
        if (/,$/.test(url)) {
            url = url.replace(/,$/, '');
        } else {
            match = /^[^,]*(?:\(.+?\))?[^,]*(?:,|$)/.exec(srcset);
            if (match === null) break;
            srcset = srcset.slice(match.index + match[0].length);
        }
        let parsedURL;
        try { parsedURL = new URL(url, document.baseURI); } catch (ex) { continue; }
        if (parsedURL.pathname.length === 0) continue;
        out.push(trimFragmentFromURL(parsedURL.href));
    }
};

const resourceURLsFromPicture = function(elem, out) {
    if (elem.localName === 'source') return;
    const picture = elem.parentElement;
    if (picture === null || picture.localName !== 'picture') return;
    const sources = picture.querySelectorAll(':scope > source');
    for (const source of sources) {
        const urls = resourceURLsFromElement(source);
        if (urls.length === 0) continue;
        out.push(...urls);
    }
};

const resourceURLsFromElement = function(elem) {
    const urls = [];
    const tagName = elem.localName;
    const prop = netFilter1stSources[tagName];
    if (prop === undefined) {
        const url = backgroundImageURLFromElement(elem);
        if (url !== '') urls.push(url);
        return urls;
    }
    let s = elem[prop];
    if (s instanceof SVGAnimatedString) s = s.baseVal;
    if (typeof s === 'string' && /^https?:\/\//.test(s)) {
        urls.push(trimFragmentFromURL(s.slice(0, 1024)));
    }
    resourceURLsFromSrcset(elem, urls);
    resourceURLsFromPicture(elem, urls);
    return urls;
};

const netFilterFromElement = function(elem) {
    if (elem === null || elem.nodeType !== 1) return 0;
    const urls = resourceURLsFromElement(elem);
    if (urls.length === 0) return 0;
    if (candidateElements.indexOf(elem) === -1) candidateElements.push(elem);
    const candidates = netFilterCandidates;
    const len = candidates.length;
    for (let i = 0; i < urls.length; i++) urls[i] = urls[i].replace(/^https?:\/\//, '');
    const pattern = mergeStrings(urls);
    if (bestCandidateFilter === null && elem.matches('html,body') === false) {
        bestCandidateFilter = { type: 'net', filters: candidates, slot: candidates.length };
    }
    candidates.push(`||${pattern}`);
    const pos = pattern.indexOf('?');
    if (pos !== -1) candidates.push(`||${pattern.slice(0, pos)}`);
    return candidates.length - len;
};

const cosmeticFilterFromElement = function(elem) {
    if (elem === null || elem.nodeType !== 1) return 0;
    if (candidateElements.indexOf(elem) === -1) candidateElements.push(elem);
    let selector = '';
    let v = typeof elem.id === 'string' && CSS.escape(elem.id);
    if (v) selector = '#' + v;
    v = elem.classList;
    if (v) {
        let i = v.length || 0;
        while (i--) selector += '.' + CSS.escape(v.item(i));
    }
    const tagName = CSS.escape(elem.localName);
    if (selector === '') {
        let attributes = [], attr;
        switch (tagName) {
        case 'a':
            v = elem.getAttribute('href');
            if (v) {
                v = v.trim().replace(/\?.*$/, '');
                if (v.length) attributes.push({ k: 'href', v: v });
            }
            break;
        case 'iframe':
        case 'img':
            v = elem.getAttribute('src');
            if (v && v.length !== 0) {
                v = v.trim();
                if (v.startsWith('data:')) {
                    let pos = v.indexOf(',');
                    if (pos !== -1) v = v.slice(0, pos + 1);
                } else if (v.startsWith('blob:')) {
                    try {
                        const bu = new URL(v.slice(5));
                        bu.pathname = '';
                        v = 'blob:' + bu.href;
                    } catch (ex) {}
                }
                attributes.push({ k: 'src', v: v.slice(0, 256) });
                break;
            }
            v = elem.getAttribute('alt');
            if (v && v.length !== 0) attributes.push({ k: 'alt', v: v });
            break;
        default: break;
        }
        while ((attr = attributes.pop())) {
            if (attr.v.length === 0) continue;
            const w = attr.v.replace(/([^\\])"/g, '$1\\"');
            v = elem.getAttribute(attr.k);
            if (attr.v === v) selector += `[${attr.k}="${w}"]`;
            else if (v.startsWith(attr.v)) selector += `[${attr.k}^="${w}"]`;
            else selector += `[${attr.k}*="${w}"]`;
        }
    }
    const parentNode = elem.parentNode;
    if (selector === '' || safeQuerySelectorAll(parentNode, `:scope > ${selector}`).length > 1) {
        selector = tagName + selector;
    }
    if (safeQuerySelectorAll(parentNode, `:scope > ${selector}`).length > 1) {
        let i = 1, walker = elem;
        while (walker.previousSibling !== null) {
            walker = walker.previousSibling;
            if (typeof walker.localName === 'string' && walker.localName === tagName) i++;
        }
        selector += `:nth-of-type(${i})`;
    }
    if (bestCandidateFilter === null) {
        bestCandidateFilter = { type: 'cosmetic', filters: cosmeticFilterCandidates, slot: cosmeticFilterCandidates.length };
    }
    cosmeticFilterCandidates.push(`##${selector}`);
    return 1;
};

const filtersFrom = function(x, y) {
    bestCandidateFilter = null;
    netFilterCandidates.length = 0;
    cosmeticFilterCandidates.length = 0;
    candidateElements.length = 0;
    let first = null;
    if (typeof x === 'number') {
        first = elementFromPoint(x, y);
    } else if (x instanceof HTMLElement) {
        first = x; x = undefined;
    }
    if (typeof x === 'number') {
        const elems = elementsFromPointBlind(x, y);
        for (const elem of elems) netFilterFromElement(elem);
    } else if (first !== null) {
        netFilterFromElement(first);
    }
    let elem = first;
    while (elem && elem !== document.body) {
        cosmeticFilterFromElement(elem);
        elem = elem.parentNode;
    }
    let i = cosmeticFilterCandidates.length;
    if (i !== 0) {
        const selector = cosmeticFilterCandidates[i - 1].slice(2);
        if (safeQuerySelectorAll(document.body, selector).length > 1) {
            cosmeticFilterCandidates.push('##body');
        }
    }
    if (bestCandidateFilter === null && netFilterCandidates.length !== 0) {
        bestCandidateFilter = { type: 'net', filters: netFilterCandidates, slot: 0 };
    }
    return netFilterCandidates.length + cosmeticFilterCandidates.length;
};

/* ---------------------------------------------------------------------
   elementFromPoint helpers.
   uBO's iframe made itself briefly non-hit-testable ("clickblind") so
   that document.elementFromPoint(x,y) would see through it to the real
   page element. We do the same trick to our svg#sea overlay.
--------------------------------------------------------------------- */
const withPickerBlind = function(fn) {
    const prev = svgRoot.style.pointerEvents;
    svgRoot.style.pointerEvents = 'none';
    try { return fn(); } finally { svgRoot.style.pointerEvents = prev; }
};

const elementFromPoint = (function() {
    let lastX, lastY;
    return (x, y) => {
        if (x !== undefined) { lastX = x; lastY = y; }
        else if (lastX !== undefined) { x = lastX; y = lastY; }
        else return null;
        let elem = withPickerBlind(() => document.elementFromPoint(x, y));
        if (elem === null || elem === document.body || elem === document.documentElement) {
            elem = null;
        }
        return elem;
    };
})();

const elementsFromPointBlind = function(x, y) {
    return withPickerBlind(() => document.elementsFromPoint(x, y));
};

const highlightElementAtPoint = function(mx, my) {
    const elem = elementFromPoint(mx, my);
    highlightElements(elem ? [elem] : []);
};

const filterElementAtPoint = function(mx, my) {
    if (filtersFrom(mx, my) === 0) return;
    showDialog();
};

/* ---------------------------------------------------------------------
   filterToDOMInterface — ported from epicker.js. Looks up which DOM
   elements a candidate filter (net-ish or cosmetic) currently matches,
   and can apply/unapply a "hide" style to them for live preview.
--------------------------------------------------------------------- */
const filterToDOMInterface = (function() {
    const reHnAnchorPrefix = '^[\\w-]+://(?:[^/?#]+\\.)?';
    const reCaret = '(?:[^%.0-9a-z_-]|$)';
    const rePseudoElements = /:(?::?after|:?before|:[a-z-]+)$/;

    const matchElemToRegex = (elem, re) => {
        const srcProp = netFilter1stSources[elem.localName];
        let src = elem[srcProp];
        if (src instanceof SVGAnimatedString) src = src.baseVal;
        if (typeof src === 'string' && /^https?:\/\//.test(src)) {
            if (re.test(src)) return srcProp;
        }
        src = elem.currentSrc;
        if (typeof src === 'string' && /^https?:\/\//.test(src)) {
            if (re.test(src)) return srcProp;
        }
    };

    const fromNetworkFilter = function(filter) {
        const out = [];
        if (/^[0-9a-z]$/i.test(filter)) return out;
        let reStr = '';
        if (filter.length > 2 && filter.startsWith('/') && filter.endsWith('/')) {
            reStr = filter.slice(1, -1);
        } else if (/^\w[\w.-]*[a-z]$/i.test(filter)) {
            reStr = reHnAnchorPrefix + filter.toLowerCase().replace(/\./g, '\\.') + reCaret;
        } else {
            let rePrefix = '', reSuffix = '', f = filter;
            if (f.startsWith('||')) { rePrefix = reHnAnchorPrefix; f = f.slice(2); }
            else if (f.startsWith('|')) { rePrefix = '^'; f = f.slice(1); }
            if (f.endsWith('|')) { reSuffix = '$'; f = f.slice(0, -1); }
            reStr = rePrefix + f.replace(/[.+?${}()|[\]\\]/g, '\\$&').replace(/\*+/g, '.*').replace(/\^/g, reCaret) + reSuffix;
        }
        let reFilter;
        try { reFilter = new RegExp(reStr, 'i'); } catch (ex) { return out; }
        const elems = document.querySelectorAll(Object.keys(netFilter1stSources).join());
        for (const elem of elems) {
            const srcProp = matchElemToRegex(elem, reFilter);
            if (srcProp === undefined) continue;
            out.push({ elem, src: srcProp, opt: filterTypes[elem.localName], style: hideStyle });
        }
        for (const elem of candidateElements) {
            if (reFilter.test(backgroundImageURLFromElement(elem))) {
                out.push({ elem, bg: true, opt: 'image', style: 'background-image:none!important;' });
            }
        }
        return out;
    };

    const fromPlainCosmeticFilter = function(raw) {
        let elems;
        try {
            document.documentElement.matches(`${raw},\na`);
            elems = document.querySelectorAll(raw.replace(rePseudoElements, ''));
        } catch (ex) { return; }
        const out = [];
        for (const elem of elems) {
            if (elem === hostEl) continue;
            out.push({ elem, raw, style: hideStyle });
        }
        return out;
    };

    const styleTokens = new Map();
    const injectedStyleEls = [];
    let lastFilter, lastResultset, previewing = false;
    let permanentStyleEl = null;

    const queryAll = function(filter) {
        filter = filter.trim();
        if (filter === lastFilter) return lastResultset;
        unapply();
        if (filter === '' || filter === '!') {
            lastFilter = ''; lastResultset = undefined; return;
        }
        lastFilter = filter;
        if (reCosmeticAnchor.test(filter) === false) {
            lastResultset = fromNetworkFilter(filter);
            if (previewing) apply();
            return lastResultset;
        }
        lastResultset = fromPlainCosmeticFilter(filter.replace(reCosmeticAnchor, ''));
        if (previewing) apply();
        return lastResultset;
    };

    const apply = function() {
        unapply();
        if (Array.isArray(lastResultset) === false) return;
        for (const { elem, style } of lastResultset) {
            if (elem === hostEl || style === undefined) continue;
            let styleToken = styleTokens.get(style);
            if (styleToken === undefined) {
                styleToken = PICKER_ID + '-s' + styleTokens.size;
                styleTokens.set(style, styleToken);
                const rule = document.createElement('style');
                rule.textContent = `[${styleToken}]{${style}}`;
                document.documentElement.appendChild(rule);
                injectedStyleEls.push(rule);
            }
            elem.setAttribute(styleToken, '');
        }
    };

    const unapply = function() {
        for (const styleToken of styleTokens.values()) {
            for (const elem of document.querySelectorAll(`[${styleToken}]`)) {
                elem.removeAttribute(styleToken);
            }
        }
    };

    const preview = function(state) {
        previewing = state !== false;
        if (previewing === false) return unapply();
        if (Array.isArray(lastResultset) === false) return;
        apply();
    };

    // Permanently hide elements (used by the Create button — since there
    // is no extension background page to persist a real filter list, we
    // apply the hide immediately and keep it applied after the picker
    // closes).
    const makePermanent = function() {
        if (Array.isArray(lastResultset) === false) return 0;
        if (permanentStyleEl === null) {
            permanentStyleEl = document.createElement('style');
            permanentStyleEl.id = PICKER_ID + '-created';
            document.documentElement.appendChild(permanentStyleEl);
        }
        let n = 0;
        for (const { elem, style } of lastResultset) {
            if (elem === hostEl) continue;
            elem.setAttribute(PICKER_ID + '-created', '');
            n++;
        }
        permanentStyleEl.textContent += `[${PICKER_ID}-created]{${hideStyle}}\n`;
        return n;
    };

    const teardown = function() {
        unapply();
        for (const el of injectedStyleEls.splice(0)) el.remove();
        styleTokens.clear();
    };

    return { queryAll, preview, makePermanent, teardown };
})();

/* ---------------------------------------------------------------------
   onOptimizeCandidates — ported from epicker.js (page-side; needs real
   document.querySelectorAll access to count matches per candidate path).
--------------------------------------------------------------------- */
const optimizeCandidates = function(candidatesPaths) {
    const results = [];
    for (const paths of candidatesPaths) {
        let count = Number.MAX_SAFE_INTEGER, selector = '';
        for (let i = 0, n = paths.length; i < n; i++) {
            const s = paths.slice(n - i - 1).join('');
            let elems;
            try { elems = document.querySelectorAll(s); } catch (ex) { elems = []; }
            if (elems.length < count) { selector = s; count = elems.length; }
        }
        results.push({ selector: `##${selector}`, count });
    }
    results.sort((a, b) => {
        const r = b.count - a.count;
        return r !== 0 ? r : a.selector.length - b.selector.length;
    });
    return results.map(a => a.selector);
};

/* =======================================================================
   DIALOG / UI-SIDE LOGIC
   Ported near-verbatim from src/js/epicker-ui.js.
======================================================================= */

const computedSpecificityCandidates = new Map();
let resultsetOpt;
let cosmeticFilterCandidatesUI = [];
let computedCandidate = '';
let needBody = false;

/* ---- textarea stand-in for uBO's CodeMirror instance -------------- */
const rawFilterFromTextarea = function() {
    const text = filterInput.value;
    const pos = text.indexOf('\n');
    return pos === -1 ? text : text.slice(0, pos);
};

// Lightweight stand-in for uBO's full static-filtering AST parser: good
// enough to tell "this looks like a usable cosmetic or network filter"
// from "this is garbage", without shipping the whole parser module.
const filterFromTextarea = function() {
    const filter = rawFilterFromTextarea();
    if (filter === '') return '';
    if (reCosmeticAnchor.test(filter)) {
        const sel = filter.replace(reCosmeticAnchor, '');
        if (sel === '') return '!';
        try { document.documentElement.matches(`${sel},\na`); } catch (ex) { return '!'; }
        return filter;
    }
    if (/\s/.test(filter)) return '!';
    if (filter.length < 2) return '!';
    return filter;
};

const setEditorValue = function(text) {
    filterInput.value = text;
};

const renderRange = function(id, value, invert) {
    const input = $(`#${id} input`);
    const max = parseInt(input.max, 10);
    if (typeof value !== 'number') value = parseInt(input.value, 10);
    if (invert) value = max - value;
    input.value = value;
    const slider = $(`#${id} > span`);
    const lside = slider.children[0];
    const thumb = slider.children[1];
    const sliderWidth = slider.offsetWidth || 1;
    const maxPercent = (sliderWidth - (thumb.offsetWidth || 0)) / sliderWidth * 100;
    const widthPercent = value / max * maxPercent;
    lside.style.width = `${widthPercent}%`;
};

const userFilterFromCandidate = function(filter) {
    if (filter === '' || filter === '!') return;
    const hn = location.hostname;
    if (reCosmeticAnchor.test(filter)) return hn + filter;
    const opts = [];
    if (filter.startsWith('||') === false) opts.push(`domain=${hn}`);
    if (resultsetOpt !== undefined) opts.push(resultsetOpt);
    if (opts.length) filter += '$' + opts.join(',');
    return filter;
};

const cosmeticCandidatesFromFilterChoice = function(filterChoice) {
    const { slot, filters } = filterChoice;
    renderRange('resultsetDepth', slot, true);
    renderRange('resultsetSpecificity');
    if (computedSpecificityCandidates.has(slot)) {
        applyOptimizedCandidates(slot);
        return;
    }
    const specificities = [0b0000, 0b0010, 0b0011, 0b1000, 0b1010, 0b1100, 0b1110, 0b1111];
    const candidatesPaths = [];
    for (const specificity of specificities) {
        const paths = [];
        let filter = filters[slot];
        for (let i = slot; i < filters.length; i++) {
            filter = filters[i].slice(2);
            if ((specificity & 0b0001) === 0) {
                filter = filter.replace(/:nth-of-type\(\d+\)/, '');
                if (filter.charAt(0) === '#' && ((specificity & 0b1000) === 0 || i === slot)) {
                    const pos = filter.search(/[^\\]\./);
                    if (pos !== -1) filter = filter.slice(pos + 1);
                }
            }
            if ((specificity & 0b0010) === 0) {
                const match = /^\[([^^*$=]+)[\^*$]?=.+\]$/.exec(filter);
                if (match !== null) filter = `[${match[1]}]`;
            }
            if (filter.charAt(0) === '#') {
                filter = filter.replace(/([^\\])\..+$/, '$1');
            }
            if (paths.length !== 0) filter += ' > ';
            paths.unshift(filter);
            if ((specificity & 0b1000) === 0 || filter.startsWith('#')) break;
        }
        if ((specificity & 0b1100) === 0b1000) {
            let i = 0;
            while (i < paths.length - 1) {
                if (/^[a-z0-9]+ > $/.test(paths[i + 1])) {
                    if (paths[i].endsWith(' > ')) paths[i] = paths[i].slice(0, -2);
                    paths.splice(i + 1, 1);
                } else {
                    i += 1;
                }
            }
        }
        if (needBody && paths.length !== 0 && paths[0].startsWith('#') === false &&
            paths[0].startsWith('body ') === false && (specificity & 0b1100) !== 0) {
            paths.unshift('body > ');
        }
        candidatesPaths.push(paths);
    }
    const results = optimizeCandidates(candidatesPaths);
    computedSpecificityCandidates.set(slot, results);
    applyOptimizedCandidates(slot);
};

const applyOptimizedCandidates = function(slot) {
    $('#resultsetModifiers').classList.remove('hide');
    const i = parseInt($('#resultsetSpecificity input').value, 10);
    const candidates = computedSpecificityCandidates.get(slot);
    computedCandidate = candidates[i];
    setEditorValue(computedCandidate);
    onCandidateChanged();
};

const candidateFromFilterChoice = function(filterChoice) {
    const { slot, filters } = filterChoice;
    const filter = filters[slot];
    for (const elem of $$('#candidateFilters li')) elem.classList.remove('active');
    computedCandidate = '';
    if (filter === undefined) return '';
    if (filter.startsWith('##') === false) {
        const li = $(`#netFilters li:nth-of-type(${slot + 1})`);
        if (li) li.classList.add('active');
        return filter;
    }
    const li = $(`#cosmeticFilters li:nth-of-type(${slot + 1})`);
    if (li) li.classList.add('active');
    return cosmeticCandidatesFromFilterChoice(filterChoice);
};

const populateCandidates = function(candidates, selector) {
    const root = dialog.querySelector(selector);
    const ul = root.querySelector('ul');
    while (ul.firstChild !== null) ul.firstChild.remove();
    for (let i = 0; i < candidates.length; i++) {
        const li = document.createElement('li');
        li.textContent = candidates[i];
        li.dataset.index = i;
        ul.appendChild(li);
    }
    root.style.display = candidates.length !== 0 ? '' : 'none';
};

const showDialog = function() {
    pausePicker();
    needBody = cosmeticFilterCandidates.length !== 0 &&
        cosmeticFilterCandidates[cosmeticFilterCandidates.length - 1] === '##body';
    const cosmeticForDisplay = needBody
        ? cosmeticFilterCandidates.slice(0, -1)
        : cosmeticFilterCandidates;
    cosmeticFilterCandidatesUI = cosmeticForDisplay;

    populateCandidates(netFilterCandidates, '#netFilters');
    populateCandidates(cosmeticForDisplay, '#cosmeticFilters');
    computedSpecificityCandidates.clear();

    const depthInput = $('#resultsetDepth input');
    depthInput.max = Math.max(cosmeticForDisplay.length - 1, 0);
    depthInput.value = depthInput.max;

    $('#candidateFilters').style.display =
        (netFilterCandidates.length || cosmeticForDisplay.length) ? '' : 'none';
    $('#create').setAttribute('disabled', '');

    if (bestCandidateFilter === null) {
        setEditorValue('');
        return;
    }
    const filterChoice = { filters: bestCandidateFilter.filters, slot: bestCandidateFilter.slot };
    const text = candidateFromFilterChoice(filterChoice);
    if (text === undefined) return;
    setEditorValue(text);
    onCandidateChanged();
};

/* ---------------------------------------------------------------------
   Pause / minimize / resume.
--------------------------------------------------------------------- */
const pausePicker = function() {
    hostEl.classList.add('paused');
    hostEl.classList.remove('minimized');
    svgListening(false);
};

const unpausePicker = function() {
    hostEl.classList.remove('paused', 'preview');
    hostEl.classList.add('minimized');
    filterToDOMInterface.preview(false);
    svgListening(true);
};

/* ---------------------------------------------------------------------
   Live hover highlighting while actively picking.
--------------------------------------------------------------------- */
const svgListening = (function() {
    let on = false, timer, mx = 0, my = 0;
    const onTimer = () => {
        timer = undefined;
        highlightElementAtPoint(mx, my);
    };
    const onHover = ev => {
        mx = ev.clientX; my = ev.clientY;
        if (timer === undefined) timer = self.requestAnimationFrame(onTimer);
    };
    return state => {
        if (state === on) return;
        on = state;
        if (on) {
            document.addEventListener('mousemove', onHover, { passive: true });
            return;
        }
        document.removeEventListener('mousemove', onHover, { passive: true });
        if (timer !== undefined) { self.cancelAnimationFrame(timer); timer = undefined; }
    };
})();

/* ---------------------------------------------------------------------
   Click / tap on the spotlight overlay.
--------------------------------------------------------------------- */
const onSvgClicked = function(ev) {
    if (hostEl.classList.contains('paused')) {
        if (hostEl.classList.contains('preview') === false) unpausePicker();
        return;
    }
    filterElementAtPoint(ev.clientX, ev.clientY);
};

// Swipe right: quit / hide dialog. Swipe left: reveal dialog.
const onSvgTouch = (function() {
    let startX = 0, startY = 0, t0 = 0;
    return ev => {
        if (ev.type === 'touchstart') {
            startX = ev.touches[0].screenX;
            startY = ev.touches[0].screenY;
            t0 = ev.timeStamp;
            return;
        }
        if (startX === undefined) return;
        const stopX = ev.changedTouches[0].screenX;
        const stopY = ev.changedTouches[0].screenY;
        const angle = Math.abs(Math.atan2(stopY - startY, stopX - startX));
        const distance = Math.sqrt((stopX - startX) ** 2 + (stopY - startY) ** 2);
        const duration = ev.timeStamp - t0;
        if (distance < 32 && duration < 200) {
            onSvgClicked({ clientX: ev.changedTouches[0].pageX, clientY: ev.changedTouches[0].pageY });
            ev.preventDefault();
            return;
        }
        if (distance < 64) return;
        const angleUpperBound = Math.PI * 0.25 * 0.5;
        const swipeRight = angle < angleUpperBound;
        if (swipeRight === false && angle < Math.PI - angleUpperBound) return;
        if (ev.cancelable) ev.preventDefault();
        if (swipeRight === false) {
            if (hostEl.classList.contains('paused')) hostEl.classList.remove('hide');
            return;
        }
        quitPicker();
    };
})();

/* ---------------------------------------------------------------------
   Drag the dialog around.
--------------------------------------------------------------------- */
const onStartMoving = (function() {
    let isTouch = false, mx0 = 0, my0 = 0, mx1 = 0, my1 = 0;
    let pw = 0, ph = 0, dw = 0, dh = 0, cx0 = 0, cy0 = 0, timer;
    const eatEvent = ev => { ev.stopPropagation(); ev.preventDefault(); };
    const move = () => {
        timer = undefined;
        const cx1 = cx0 + mx1 - mx0, cy1 = cy0 + my1 - my0;
        if (cx1 < pw / 2) {
            dialog.style.left = `${Math.max(cx1 - dw / 2, 2)}px`;
            dialog.style.removeProperty('right');
        } else {
            dialog.style.removeProperty('left');
            dialog.style.right = `${Math.max(pw - cx1 - dw / 2, 2)}px`;
        }
        if (cy1 < ph / 2) {
            dialog.style.top = `${Math.max(cy1 - dh / 2, 2)}px`;
            dialog.style.removeProperty('bottom');
        } else {
            dialog.style.removeProperty('top');
            dialog.style.bottom = `${Math.max(ph - cy1 - dh / 2, 2)}px`;
        }
    };
    const moveAsync = ev => {
        if (timer !== undefined) return;
        if (isTouch) { mx1 = ev.touches[0].pageX; my1 = ev.touches[0].pageY; }
        else { mx1 = ev.pageX; my1 = ev.pageY; }
        timer = self.requestAnimationFrame(move);
    };
    const stop = ev => {
        if (dialog.classList.contains('moving') === false) return;
        dialog.classList.remove('moving');
        if (isTouch) self.removeEventListener('touchmove', moveAsync, { capture: true });
        else self.removeEventListener('mousemove', moveAsync, { capture: true });
        eatEvent(ev);
    };
    return ev => {
        const target = dialog.querySelector('#move');
        if (ev.target !== target) return;
        if (dialog.classList.contains('moving')) return;
        isTouch = ev.type.startsWith('touch');
        if (isTouch) { mx0 = ev.touches[0].pageX; my0 = ev.touches[0].pageY; }
        else { mx0 = ev.pageX; my0 = ev.pageY; }
        const rect = dialog.getBoundingClientRect();
        dw = rect.width; dh = rect.height;
        cx0 = rect.x + dw / 2; cy0 = rect.y + dh / 2;
        pw = self.innerWidth; ph = self.innerHeight;
        dialog.classList.add('moving');
        if (isTouch) {
            self.addEventListener('touchmove', moveAsync, { capture: true });
            self.addEventListener('touchend', stop, { capture: true, once: true });
        } else {
            self.addEventListener('mousemove', moveAsync, { capture: true });
            self.addEventListener('mouseup', stop, { capture: true, once: true });
        }
        eatEvent(ev);
    };
})();

/* ---------------------------------------------------------------------
   Button / input handlers.
--------------------------------------------------------------------- */
const onCandidateChanged = function() {
    const filter = filterFromTextarea();
    const bad = filter === '!';
    $('section').classList.toggle('invalidFilter', bad);
    if (bad) {
        $('#resultsetCount').textContent = 'E';
        $('#create').setAttribute('disabled', '');
    }
    const text = rawFilterFromTextarea();
    $('#resultsetModifiers').classList.toggle('hide', text === '' || text !== computedCandidate);
    const resultset = filterToDOMInterface.queryAll(filter) || [];
    highlightElements(resultset.map(a => a.elem), true);
    if (filter === '!') return;
    resultsetOpt = resultset.length !== 0 ? resultset[0].opt : undefined;
    $('#resultsetCount').textContent = String(resultset.length);
    if (resultset.length !== 0) $('#create').removeAttribute('disabled');
    else $('#create').setAttribute('disabled', '');
};

const onPreviewClicked = function() {
    const state = hostEl.classList.toggle('preview');
    filterToDOMInterface.preview(state);
    if (state === false) highlightElements(targetElements, true);
};

const onCreateClicked = function() {
    const candidate = filterFromTextarea();
    if (candidate === '' || candidate === '!') return;
    const filter = userFilterFromCandidate(candidate);
    filterToDOMInterface.queryAll(candidate);
    const n = filterToDOMInterface.makePermanent();
    if (filter && navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(filter).catch(() => {});
    }
    toast(`Hid ${n} element${n === 1 ? '' : 's'} \u00b7 copied: ${filter}`, 3200);
    quitPicker();
};

const onPickClicked = function() { unpausePicker(); };
const onQuitClicked = function() { quitPicker(); };

const onDepthChanged = function() {
    const input = $('#resultsetDepth input');
    const max = parseInt(input.max, 10);
    const value = parseInt(input.value, 10);
    const text = candidateFromFilterChoice({ filters: cosmeticFilterCandidatesUI, slot: max - value });
    if (text === undefined) return;
    setEditorValue(text);
    onCandidateChanged();
};

const onSpecificityChanged = function() {
    renderRange('resultsetSpecificity');
    if (rawFilterFromTextarea() !== computedCandidate) return;
    const depthInput = $('#resultsetDepth input');
    const slot = parseInt(depthInput.max, 10) - parseInt(depthInput.value, 10);
    const i = parseInt($('#resultsetSpecificity input').value, 10);
    const candidates = computedSpecificityCandidates.get(slot);
    if (!candidates) return;
    computedCandidate = candidates[i];
    setEditorValue(computedCandidate);
    onCandidateChanged();
};

const onCandidateClicked = function(ev) {
    const li = ev.target.closest('li[data-index]');
    if (li === null) return;
    const isNet = li.closest('#netFilters') !== null;
    const index = parseInt(li.dataset.index, 10);
    const filters = isNet ? netFilterCandidates : cosmeticFilterCandidatesUI;
    const text = candidateFromFilterChoice({ filters, slot: index });
    if (text === undefined) return;
    setEditorValue(text);
    onCandidateChanged();
};

const onKeyPressed = function(ev) {
    if (ev.key === 'Escape' || ev.which === 27) {
        ev.stopPropagation();
        ev.preventDefault();
        quitPicker();
    }
};

const onMinimizeClicked = function() {
    if (hostEl.classList.contains('paused') === false) {
        pausePicker();
        onCandidateChanged();
    } else {
        hostEl.classList.toggle('minimized');
    }
};

/* ---------------------------------------------------------------------
   Boot / teardown.
--------------------------------------------------------------------- */
const startPicker = function() {
    self.addEventListener('keydown', onKeyPressed, true);
    self.addEventListener('scroll', onViewportChanged, { passive: true });
    self.addEventListener('resize', onViewportChanged, { passive: true });

    svgRoot.addEventListener('click', onSvgClicked);
    svgRoot.addEventListener('touchstart', onSvgTouch, { passive: true });
    svgRoot.addEventListener('touchend', onSvgTouch);

    $('#quit').addEventListener('click', onQuitClicked);
    $('#preview').addEventListener('click', onPreviewClicked);
    $('#create').addEventListener('click', onCreateClicked);
    $('#pick').addEventListener('click', onPickClicked);
    $('#minimize').addEventListener('click', onMinimizeClicked);
    $('#move').addEventListener('mousedown', onStartMoving);
    $('#move').addEventListener('touchstart', onStartMoving, { passive: false });
    $('#candidateFilters').addEventListener('click', onCandidateClicked);
    $('#resultsetDepth input').addEventListener('input', onDepthChanged);
    $('#resultsetSpecificity input').addEventListener('input', onSpecificityChanged);
    filterInput.addEventListener('input', onCandidateChanged);

    unpausePicker();
};

function onViewportChanged() {
    highlightElements(targetElements, true);
}

const quitPicker = function() {
    self.removeEventListener('scroll', onViewportChanged, { passive: true });
    self.removeEventListener('resize', onViewportChanged, { passive: true });
    self.removeEventListener('keydown', onKeyPressed, true);
    filterToDOMInterface.teardown();
    hostEl.remove();
    window.__uboPickerInstance = undefined;
};

window.__uboPickerInstance = { quit: quitPicker };

startPicker();

})();
