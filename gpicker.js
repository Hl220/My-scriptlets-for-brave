/**
 * Standalone uBlock Origin Style Element Picker / Zapper (Mobile & Desktop)
 * Touch-enabled for mobile bookmarklets via jsDelivr
 */
(function () {
  if (window.__uBO_element_picker) {
    window.__uBO_element_picker.destroy();
  }

  const STYLE_ID = 'ubo-picker-styles';
  if (!document.getElementById(STYLE_ID)) {
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      .ubo-picker-hover {
        outline: 3px dashed #ff3333 !important;
        outline-offset: -3px !important;
        background-color: rgba(255, 0, 0, 0.25) !important;
      }
      #ubo-picker-container {
        position: fixed;
        bottom: 12px;
        left: 50%;
        transform: translateX(-50%);
        z-index: 2147483647;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        font-size: 14px;
        color: #111;
        background: #f8f9fa;
        border: 1px solid #ccc;
        border-radius: 12px;
        box-shadow: 0 8px 24px rgba(0,0,0,0.3);
        width: 92vw;
        max-width: 400px;
        overflow: hidden;
        user-select: none;
        touch-action: none;
      }
      #ubo-picker-header {
        background: #e9ecef;
        padding: 10px 14px;
        font-weight: bold;
        display: flex;
        justify-content: space-between;
        align-items: center;
        border-bottom: 1px solid #ddd;
        cursor: move;
        touch-action: none;
      }
      #ubo-picker-body {
        padding: 12px;
      }
      #ubo-picker-target-info {
        font-family: monospace;
        font-size: 12px;
        background: #212529;
        color: #20c997;
        padding: 8px;
        border-radius: 6px;
        margin-bottom: 10px;
        word-break: break-all;
      }
      .ubo-picker-row {
        margin-bottom: 10px;
      }
      .ubo-picker-row label {
        display: block;
        font-size: 12px;
        color: #555;
        margin-bottom: 4px;
      }
      .ubo-picker-row input[type="text"] {
        width: 100%;
        box-sizing: border-box;
        padding: 8px;
        font-family: monospace;
        font-size: 13px;
        border: 1px solid #ccc;
        border-radius: 6px;
      }
      .ubo-picker-row input[type="range"] {
        width: 100%;
        height: 28px;
      }
      #ubo-picker-actions {
        display: flex;
        gap: 8px;
        margin-top: 12px;
      }
      .ubo-btn {
        flex: 1;
        padding: 10px 0;
        border: none;
        border-radius: 6px;
        font-weight: bold;
        cursor: pointer;
        font-size: 13px;
        touch-action: manipulation;
      }
      .ubo-btn-primary { background: #3b82f6; color: white; }
      .ubo-btn-danger { background: #ef4444; color: white; }
      .ubo-btn-secondary { background: #e5e7eb; color: #374151; }
    `;
    document.head.appendChild(style);
  }

  let hoveredEl = null;
  let targetEl = null;
  let targetChain = [];
  let currentDepth = 0;
  let isPicking = true;

  function getTargetFromEvent(e) {
    if (e.touches && e.touches.length > 0) {
      return document.elementFromPoint(e.touches[0].clientX, e.touches[0].clientY);
    }
    return e.target;
  }

  function getSelector(el, specificity = 1) {
    if (!el || el === document.body) return 'body';
    if (el.id && specificity === 1) return `#${CSS.escape(el.id)}`;
    
    let sel = el.tagName.toLowerCase();
    if (el.classList.length > 0 && specificity <= 2) {
      const classes = Array.from(el.classList)
        .filter(c => !c.startsWith('ubo-'))
        .slice(0, 2)
        .map(c => `.${CSS.escape(c)}`)
        .join('');
      if (classes) sel += classes;
    }

    if (specificity > 2 && el.parentElement) {
      return `${getSelector(el.parentElement, specificity - 1)} > ${sel}`;
    }
    return sel;
  }

  function buildChain(el) {
    const chain = [];
    let curr = el;
    while (curr && curr !== document.body && curr !== document.documentElement) {
      chain.push(curr);
      curr = curr.parentElement;
    }
    return chain;
  }

  function handleMove(e) {
    if (!isPicking) return;
    const target = getTargetFromEvent(e);
    if (!target || target.closest('#ubo-picker-container')) return;

    if (hoveredEl && hoveredEl !== target) {
      hoveredEl.classList.remove('ubo-picker-hover');
    }
    hoveredEl = target;
    hoveredEl.classList.add('ubo-picker-hover');
  }

  function handleSelect(e) {
    if (!isPicking) return;
    const target = getTargetFromEvent(e);
    if (!target || target.closest('#ubo-picker-container')) return;

    e.preventDefault();
    e.stopPropagation();

    targetEl = target;
    if (hoveredEl) hoveredEl.classList.remove('ubo-picker-hover');

    isPicking = false;
    targetChain = buildChain(targetEl);
    currentDepth = 0;

    showDialog();
  }

  function showDialog() {
    let container = document.getElementById('ubo-picker-container');
    if (!container) {
      container = document.createElement('div');
      container.id = 'ubo-picker-container';
      document.body.appendChild(container);
    }

    const currentEl = targetChain[currentDepth] || targetEl;
    const initialSelector = getSelector(currentEl, 1);

    container.innerHTML = `
      <div id="ubo-picker-header">
        <span>⚡ uBlock Mobile Picker</span>
        <span style="padding: 4px 8px;" id="ubo-close-x">✕</span>
      </div>
      <div id="ubo-picker-body">
        <div id="ubo-picker-target-info">&lt;${currentEl.tagName.toLowerCase()}&gt; ${currentEl.className ? '.' + currentEl.className.split(' ').join('.') : ''}</div>
        
        <div class="ubo-picker-row">
          <label>CSS Selector:</label>
          <input type="text" id="ubo-selector-input" value="${initialSelector}">
        </div>

        ${targetChain.length > 1 ? `
        <div class="ubo-picker-row">
          <label>Parent Depth:</label>
          <input type="range" id="ubo-depth-slider" min="0" max="${targetChain.length - 1}" value="${currentDepth}">
        </div>
        ` : ''}

        <div id="ubo-picker-actions">
          <button class="ubo-btn ubo-btn-secondary" id="ubo-btn-repick">Re-pick</button>
          <button class="ubo-btn ubo-btn-danger" id="ubo-btn-remove">Block</button>
        </div>
      </div>
    `;

    highlightSelected(currentEl);

    container.querySelector('#ubo-close-x').onclick = destroy;
    container.querySelector('#ubo-close-x').ontouchstart = destroy;
    container.querySelector('#ubo-btn-repick').onclick = repick;
    container.querySelector('#ubo-btn-repick').ontouchstart = repick;

    const depthSlider = container.querySelector('#ubo-depth-slider');
    if (depthSlider) {
      const updateDepth = (val) => {
        currentDepth = parseInt(val, 10);
        const activeEl = targetChain[currentDepth];
        container.querySelector('#ubo-picker-target-info').textContent = `<${activeEl.tagName.toLowerCase()}> ${activeEl.className ? '.' + activeEl.className.split(' ').join('.') : ''}`;
        container.querySelector('#ubo-selector-input').value = getSelector(activeEl, 1);
        highlightSelected(activeEl);
      };
      depthSlider.oninput = (e) => updateDepth(e.target.value);
    }

    const removeAction = () => {
      const selector = container.querySelector('#ubo-selector-input').value;
      if (selector) {
        try {
          document.querySelectorAll(selector).forEach(el => el.remove());
        } catch (err) {
          alert('Invalid Selector');
          return;
        }
      }
      destroy();
    };

    container.querySelector('#ubo-btn-remove').onclick = removeAction;

    makeDraggable(container);
  }

  function highlightSelected(el) {
    document.querySelectorAll('.ubo-picker-hover').forEach(e => e.classList.remove('ubo-picker-hover'));
    if (el) el.classList.add('ubo-picker-hover');
  }

  function repick() {
    const container = document.getElementById('ubo-picker-container');
    if (container) container.remove();
    if (targetEl) targetEl.classList.remove('ubo-picker-hover');
    isPicking = true;
  }

  function makeDraggable(elmnt) {
    let pos1 = 0, pos2 = 0, pos3 = 0, pos4 = 0;
    const header = elmnt.querySelector('#ubo-picker-header');

    const startDrag = (e) => {
      const evt = e.touches ? e.touches[0] : e;
      pos3 = evt.clientX;
      pos4 = evt.clientY;
      document.onmousemove = moveDrag;
      document.ontouchmove = moveDrag;
      document.onmouseup = endDrag;
      document.ontouchend = endDrag;
    };

    const moveDrag = (e) => {
      const evt = e.touches ? e.touches[0] : e;
      pos1 = pos3 - evt.clientX;
      pos2 = pos4 - evt.clientY;
      pos3 = evt.clientX;
      pos4 = evt.clientY;
      elmnt.style.top = (elmnt.offsetTop - pos2) + "px";
      elmnt.style.left = (elmnt.offsetLeft - pos1) + "px";
      elmnt.style.transform = 'none';
      elmnt.style.bottom = 'auto';
    };

    const endDrag = () => {
      document.onmousemove = null;
      document.ontouchmove = null;
      document.onmouseup = null;
      document.ontouchend = null;
    };

    if (header) {
      header.onmousedown = startDrag;
      header.ontouchstart = startDrag;
    }
  }

  function destroy() {
    document.removeEventListener('mousemove', handleMove, true);
    document.removeEventListener('touchmove', handleMove, true);
    document.removeEventListener('click', handleSelect, true);
    document.removeEventListener('touchend', handleSelect, true);

    if (hoveredEl) hoveredEl.classList.remove('ubo-picker-hover');
    if (targetEl) targetEl.classList.remove('ubo-picker-hover');

    const container = document.getElementById('ubo-picker-container');
    if (container) container.remove();

    delete window.__uBO_element_picker;
  }

  document.addEventListener('mousemove', handleMove, true);
  document.addEventListener('touchmove', handleMove, true);
  document.addEventListener('click', handleSelect, true);
  document.addEventListener('touchend', handleSelect, true);

  window.__uBO_element_picker = { destroy };
})();