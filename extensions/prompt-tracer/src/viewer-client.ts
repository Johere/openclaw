// Browser-side viewer — runs in the page, no bundler needed.
// Written as a self-contained IIFE-style module embedded directly in the HTML.

export const VIEWER_CLIENT_SCRIPT = /* language=javascript */ `
(function () {
  'use strict';

  // ── Colour palette ─────────────────────────────────────────────────────────
  const PHASE_COLORS = {
    before_prompt_build: { bg: '#1e3a5f', border: '#4a9eff', label: 'Prompt Build', text: '#7cc4ff' },
    llm_input:          { bg: '#2d1b5e', border: '#a855f7', label: 'LLM Input',    text: '#c084fc' },
    tool_call:          { bg: '#3b1f00', border: '#f97316', label: 'Tool Call',    text: '#fb923c' },
    llm_output:         { bg: '#052e16', border: '#22c55e', label: 'LLM Output',   text: '#4ade80' },
    message_write:      { bg: '#1e293b', border: '#64748b', label: 'Msg Write',    text: '#94a3b8' },
    wire_body_placeholder: { bg: '#1f1f23', border: '#52525b', label: 'Wire Body', text: '#a1a1aa' },
  };
  const PHASE_COLORS_LIGHT = {
    before_prompt_build: { bg: '#dbeafe', border: '#3b82f6', label: 'Prompt Build', text: '#1d4ed8' },
    llm_input:          { bg: '#ede9fe', border: '#7c3aed', label: 'LLM Input',    text: '#5b21b6' },
    tool_call:          { bg: '#fff7ed', border: '#ea580c', label: 'Tool Call',    text: '#c2410c' },
    llm_output:         { bg: '#dcfce7', border: '#16a34a', label: 'LLM Output',   text: '#15803d' },
    message_write:      { bg: '#f8fafc', border: '#cbd5e1', label: 'Msg Write',    text: '#475569' },
    wire_body_placeholder: { bg: '#f4f4f5', border: '#a1a1aa', label: 'Wire Body', text: '#71717a' },
  };

  // ── State ───────────────────────────────────────────────────────────────────
  let selectedNode = null;
  let parsedTrace = null;
  let theme = 'dark';

  function palette() {
    return theme === 'dark' ? PHASE_COLORS : PHASE_COLORS_LIGHT;
  }

  // ── DOM helpers ─────────────────────────────────────────────────────────────
  function el(tag, attrs, ...children) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === 'style' && typeof v === 'object') {
        Object.assign(e.style, v);
      } else if (k.startsWith('on') && typeof v === 'function') {
        e.addEventListener(k.slice(2).toLowerCase(), v);
      } else {
        e.setAttribute(k, v);
      }
    }
    for (const c of children) {
      if (c == null) continue;
      if (typeof c === 'string') e.appendChild(document.createTextNode(c));
      else e.appendChild(c);
    }
    return e;
  }

  // ── XML parsing ─────────────────────────────────────────────────────────────
  function parseTrace(xmlText) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(xmlText, 'application/xml');
    const traceEl = doc.querySelector('trace');
    if (!traceEl) return null;

    const meta = {};
    const metaEl = traceEl.querySelector('meta');
    if (metaEl) {
      for (const child of metaEl.children) {
        meta[child.tagName] = child.textContent;
      }
    }

    const observedTools = { notice: '', tools: [] };
    const observedEl = traceEl.querySelector('observedTools');
    if (observedEl) {
      const noticeEl = observedEl.querySelector('notice');
      if (noticeEl) observedTools.notice = noticeEl.textContent || '';
      for (const t of observedEl.querySelectorAll('tool')) {
        observedTools.tools.push({
          name: t.getAttribute('name') || '',
          callCount: parseInt(t.getAttribute('callCount') || '0', 10),
          firstSeenAt: t.getAttribute('firstSeenAt') || '',
          lastSeenAt: t.getAttribute('lastSeenAt') || '',
          paramKeys: (t.getAttribute('paramKeys') || '').split(',').filter(Boolean),
        });
      }
    }

    const turns = [];
    for (const turnEl of traceEl.querySelectorAll('turns > turn')) {
      const phases = [];
      for (const phaseEl of turnEl.querySelectorAll('phase')) {
        const kind = phaseEl.getAttribute('kind');
        const phase = { kind, at: phaseEl.getAttribute('at'), attrs: {} };
        for (const attr of phaseEl.attributes) {
          phase.attrs[attr.name] = attr.value;
        }
        // Collect child content
        phase.children = {};
        for (const child of phaseEl.children) {
          phase.children[child.tagName] = {
            text: child.textContent,
            attrs: Object.fromEntries(Array.from(child.attributes).map(a => [a.name, a.value])),
          };
        }
        // For phases with direct CDATA (e.g. message_write)
        if (!Object.keys(phase.children).length) {
          phase.rawText = phaseEl.textContent;
        }
        phases.push(phase);
      }
      turns.push({
        index: parseInt(turnEl.getAttribute('index') || '0', 10),
        startedAt: turnEl.getAttribute('startedAt'),
        endedAt: turnEl.getAttribute('endedAt'),
        durationMs: turnEl.getAttribute('durationMs'),
        phases,
      });
    }

    return {
      traceId: traceEl.getAttribute('traceId'),
      sessionKey: traceEl.getAttribute('sessionKey'),
      channel: traceEl.getAttribute('channel'),
      startedAt: traceEl.getAttribute('startedAt'),
      endedAt: traceEl.getAttribute('endedAt'),
      meta,
      observedTools,
      turns,
    };
  }

  // ── Pretty-print panel ──────────────────────────────────────────────────────
  function formatContent(phase) {
    const lines = [];
    const addSection = (label, content) => {
      if (!content) return;
      lines.push('── ' + label + ' ──');
      let text = typeof content === 'string' ? content : JSON.stringify(content, null, 2);
      // Try to pretty-print JSON
      try { text = JSON.stringify(JSON.parse(text), null, 2); } catch {}
      lines.push(text);
      lines.push('');
    };

    if (phase.children && Object.keys(phase.children).length) {
      for (const [key, val] of Object.entries(phase.children)) {
        addSection(key, val.text);
      }
    } else if (phase.rawText) {
      addSection('content', phase.rawText);
    }

    const attrLines = Object.entries(phase.attrs)
      .filter(([k]) => k !== 'kind' && k !== 'at')
      .map(([k, v]) => k + ': ' + v)
      .join('\\n');
    if (attrLines) {
      lines.unshift('── attributes ──');
      lines.unshift(attrLines);
      lines.unshift('');
    }
    return lines.join('\\n');
  }

  // ── Drawer ──────────────────────────────────────────────────────────────────
  function openDrawer(phase) {
    const drawer = document.getElementById('pt-drawer');
    const title = document.getElementById('pt-drawer-title');
    const body = document.getElementById('pt-drawer-body');
    const pal = palette();
    const color = pal[phase.kind] || pal.message_write;

    title.textContent = (color.label || phase.kind) + (phase.attrs && phase.attrs.name ? ': ' + phase.attrs.name : '');
    title.style.color = color.text;

    if (phase.kind === 'wire_body_placeholder') {
      body.innerHTML = '';
      body.appendChild(renderWireBodyPlaceholderBody());
    } else {
      const content = formatContent(phase);
      body.textContent = content || '(empty)';
    }
    drawer.style.display = 'flex';
    selectedNode = phase;
  }

  // ── Wire body placeholder drawer content ────────────────────────────────────
  function renderWireBodyPlaceholderBody() {
    const isDark = theme === 'dark';
    const mutedColor = isDark ? '#a1a1aa' : '#71717a';
    const borderColor = isDark ? '#3f3f46' : '#e4e4e7';
    const cellTextColor = isDark ? '#e4e4e7' : '#18181b';
    const headerBg = isDark ? '#27272a' : '#f4f4f5';

    const container = el('div', { style: { display: 'flex', flexDirection: 'column', gap: '12px' } });

    const notice = (parsedTrace && parsedTrace.observedTools && parsedTrace.observedTools.notice)
      || 'wire body unavailable, full tool schema list can not recoverable without wrapStreamFn';
    container.appendChild(el('div', {
      style: {
        padding: '10px 12px',
        border: '1px solid ' + (isDark ? '#713f12' : '#fde68a'),
        background: isDark ? '#1c1917' : '#fffbeb',
        color: isDark ? '#fbbf24' : '#92400e',
        borderRadius: '6px',
        fontSize: '12px',
        lineHeight: '1.5',
      },
    }, '⚠ ' + notice));

    container.appendChild(el('div', {
      style: { fontSize: '13px', fontWeight: 'bold', color: cellTextColor, marginTop: '4px' },
    }, 'Tools observed this trace'));

    const tools = (parsedTrace && parsedTrace.observedTools && parsedTrace.observedTools.tools) || [];
    if (tools.length === 0) {
      container.appendChild(el('div', {
        style: { color: mutedColor, fontSize: '12px' },
      }, '(no tool invocations observed yet)'));
      return container;
    }

    const table = el('table', {
      style: {
        width: '100%',
        borderCollapse: 'collapse',
        fontSize: '12px',
        color: cellTextColor,
      },
    });
    const thead = el('thead');
    const headerRow = el('tr');
    for (const h of ['Tool', 'Calls', 'First seen', 'Last seen', 'Param keys']) {
      headerRow.appendChild(el('th', {
        style: {
          textAlign: 'left',
          padding: '6px 8px',
          borderBottom: '1px solid ' + borderColor,
          background: headerBg,
          fontWeight: '600',
        },
      }, h));
    }
    thead.appendChild(headerRow);
    table.appendChild(thead);

    const tbody = el('tbody');
    for (const t of tools) {
      const tr = el('tr');
      const cells = [
        t.name,
        String(t.callCount),
        t.firstSeenAt,
        t.lastSeenAt,
        (t.paramKeys || []).join(', ') || '—',
      ];
      for (const c of cells) {
        tr.appendChild(el('td', {
          style: {
            padding: '6px 8px',
            borderBottom: '1px solid ' + borderColor,
            verticalAlign: 'top',
            fontFamily: 'ui-monospace, monospace',
          },
        }, c));
      }
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    container.appendChild(table);

    return container;
  }

  function closeDrawer() {
    const drawer = document.getElementById('pt-drawer');
    drawer.style.display = 'none';
    selectedNode = null;
  }

  // ── Node rendering ──────────────────────────────────────────────────────────
  function renderPhaseNode(phase, turnIdx, phaseIdx) {
    const pal = palette();
    const color = pal[phase.kind] || pal.message_write;
    const isError = phase.attrs.error;
    const borderColor = isError ? '#ef4444' : color.border;
    const label = color.label || phase.kind;
    const sublabel = phase.attrs.name || phase.attrs.provider || phase.attrs.model || '';

    const node = el('div', {
      class: 'pt-node',
      style: {
        background: color.bg,
        border: '2px solid ' + borderColor,
        borderRadius: '8px',
        padding: '8px 12px',
        cursor: 'pointer',
        minWidth: '130px',
        maxWidth: '160px',
        userSelect: 'none',
        transition: 'transform 0.1s, box-shadow 0.1s',
      },
      onClick: () => openDrawer(phase),
      'data-turn': turnIdx,
      'data-phase': phaseIdx,
    },
      el('div', { style: { fontSize: '11px', fontWeight: 'bold', color: color.text } }, label),
      sublabel ? el('div', { style: { fontSize: '10px', color: '#888', marginTop: '2px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, sublabel) : null,
      phase.attrs.durationMs ? el('div', { style: { fontSize: '10px', color: '#6b7280', marginTop: '2px' } }, phase.attrs.durationMs + 'ms') : null,
      isError ? el('div', { style: { fontSize: '10px', color: '#ef4444', marginTop: '2px' } }, '⚠ error') : null,
    );

    node.addEventListener('mouseenter', () => {
      node.style.transform = 'translateY(-2px)';
      node.style.boxShadow = '0 4px 16px rgba(0,0,0,0.5)';
    });
    node.addEventListener('mouseleave', () => {
      node.style.transform = '';
      node.style.boxShadow = '';
    });

    return node;
  }

  // ── SVG arrows ──────────────────────────────────────────────────────────────
  function drawArrow(svg, fromEl, toEl) {
    const svgRect = svg.getBoundingClientRect();
    const fromRect = fromEl.getBoundingClientRect();
    const toRect = toEl.getBoundingClientRect();

    const x1 = fromRect.right - svgRect.left;
    const y1 = fromRect.top + fromRect.height / 2 - svgRect.top;
    const x2 = toRect.left - svgRect.left;
    const y2 = toRect.top + toRect.height / 2 - svgRect.top;

    const mx = (x1 + x2) / 2;
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', \`M\${x1},\${y1} C\${mx},\${y1} \${mx},\${y2} \${x2},\${y2}\`);
    path.setAttribute('stroke', theme === 'dark' ? '#4b5563' : '#94a3b8');
    path.setAttribute('stroke-width', '1.5');
    path.setAttribute('fill', 'none');
    path.setAttribute('marker-end', 'url(#pt-arrow)');
    svg.appendChild(path);
  }

  // ── Canvas rendering ────────────────────────────────────────────────────────
  function renderCanvas(trace) {
    const canvas = document.getElementById('pt-canvas');
    canvas.innerHTML = '';

    const isDark = theme === 'dark';
    const turnBg = isDark ? '#0f172a' : '#f8fafc';
    const turnBorder = isDark ? '#1e293b' : '#e2e8f0';
    const turnTextColor = isDark ? '#64748b' : '#94a3b8';

    for (const turn of trace.turns) {
      const row = el('div', {
        class: 'pt-turn',
        style: {
          display: 'flex',
          alignItems: 'center',
          gap: '0',
          marginBottom: '16px',
          position: 'relative',
        },
      });

      const label = el('div', {
        style: {
          minWidth: '52px',
          fontSize: '11px',
          color: turnTextColor,
          marginRight: '12px',
          textAlign: 'right',
          flexShrink: '0',
        },
      }, 'Turn ' + turn.index);
      row.appendChild(label);

      const nodeRow = el('div', {
        class: 'pt-node-row',
        style: {
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          flexWrap: 'nowrap',
          background: turnBg,
          border: '1px solid ' + turnBorder,
          borderRadius: '12px',
          padding: '10px 14px',
        },
      });

      // Inject a wire_body placeholder right after llm_input in each turn.
      const displayPhases = [];
      for (const p of turn.phases) {
        displayPhases.push(p);
        if (p.kind === 'llm_input') {
          displayPhases.push({
            kind: 'wire_body_placeholder',
            at: p.at,
            attrs: {},
            children: {},
          });
        }
      }

      const nodes = [];
      for (let pi = 0; pi < displayPhases.length; pi++) {
        const phase = displayPhases[pi];
        const node = renderPhaseNode(phase, turn.index, pi);
        nodes.push(node);
        nodeRow.appendChild(node);

        if (pi < displayPhases.length - 1) {
          nodeRow.appendChild(el('div', {
            style: {
              color: isDark ? '#374151' : '#d1d5db',
              fontSize: '16px',
              flexShrink: '0',
              lineHeight: '1',
            },
          }, '→'));
        }
      }

      if (turn.durationMs) {
        nodeRow.appendChild(el('div', {
          style: { marginLeft: '8px', fontSize: '10px', color: isDark ? '#4b5563' : '#94a3b8', flexShrink: '0' },
        }, turn.durationMs + 'ms'));
      }

      row.appendChild(nodeRow);
      canvas.appendChild(row);
    }
  }

  // ── Sidebar turn list ───────────────────────────────────────────────────────
  function renderSidebar(trace) {
    const sidebar = document.getElementById('pt-sidebar');
    sidebar.innerHTML = '';

    const isDark = theme === 'dark';
    const hoverBg = isDark ? '#1e293b' : '#f1f5f9';
    const textColor = isDark ? '#94a3b8' : '#475569';

    for (const turn of trace.turns) {
      const item = el('div', {
        style: {
          padding: '6px 10px',
          cursor: 'pointer',
          borderRadius: '6px',
          fontSize: '12px',
          color: textColor,
          marginBottom: '2px',
        },
        onClick: () => {
          const turnEls = document.querySelectorAll('.pt-turn');
          if (turnEls[turn.index]) turnEls[turn.index].scrollIntoView({ behavior: 'smooth', block: 'center' });
        },
      },
        el('span', { style: { fontWeight: 'bold', color: isDark ? '#64748b' : '#94a3b8' } }, 'T' + turn.index),
        ' ',
        turn.phases.map(p => {
          const pal = palette();
          const c = pal[p.kind] || pal.message_write;
          return el('span', { style: { color: c.border, fontSize: '10px', marginRight: '2px' } }, '●');
        })
      );
      item.addEventListener('mouseenter', () => { item.style.background = hoverBg; });
      item.addEventListener('mouseleave', () => { item.style.background = ''; });
      sidebar.appendChild(item);
    }
  }

  // ── Header ──────────────────────────────────────────────────────────────────
  function renderHeader(trace) {
    const header = document.getElementById('pt-header-info');
    const isDark = theme === 'dark';
    const muted = isDark ? '#6b7280' : '#9ca3af';
    header.innerHTML = '';
    const parts = [
      trace.traceId && el('span', { style: { color: muted } }, 'ID: ' + trace.traceId),
      trace.meta.provider && el('span', { style: { color: muted } }, trace.meta.provider),
      trace.meta.model && el('span', { style: { color: muted } }, trace.meta.model),
      trace.channel && el('span', { style: { color: muted } }, trace.channel),
      el('span', { style: { color: muted } }, trace.turns.length + ' turns'),
    ].filter(Boolean);
    for (const p of parts) {
      header.appendChild(p);
      header.appendChild(document.createTextNode('  '));
    }
  }

  // ── Keyboard navigation ─────────────────────────────────────────────────────
  function onKeydown(e) {
    if (e.key === 'Escape') closeDrawer();
  }

  // ── Main render ─────────────────────────────────────────────────────────────
  function render(trace) {
    parsedTrace = trace;
    renderHeader(trace);
    renderCanvas(trace);
    renderSidebar(trace);
  }

  // ── Bootstrap ───────────────────────────────────────────────────────────────
  function init() {
    const root = document.getElementById('pt-root');
    const isDark = root && root.getAttribute('data-theme') === 'dark';
    theme = isDark ? 'dark' : 'light';

    document.addEventListener('keydown', onKeydown);

    const closeBtn = document.getElementById('pt-drawer-close');
    if (closeBtn) closeBtn.addEventListener('click', closeDrawer);

    const overlay = document.getElementById('pt-drawer-overlay');
    if (overlay) overlay.addEventListener('click', closeDrawer);

    // Load XML — either from inline script tag or from fetch
    const xmlScript = document.getElementById('pt-xml-data');
    if (xmlScript) {
      const xmlText = xmlScript.textContent || '';
      const trace = parseTrace(xmlText);
      if (trace) render(trace);
      else document.getElementById('pt-canvas').textContent = 'Failed to parse embedded XML.';
      return;
    }

    const xmlUrl = root && root.getAttribute('data-xml-url');
    if (xmlUrl) {
      fetch(xmlUrl)
        .then(r => r.text())
        .then(xmlText => {
          const trace = parseTrace(xmlText);
          if (trace) render(trace);
          else document.getElementById('pt-canvas').textContent = 'Failed to parse XML from ' + xmlUrl;
        })
        .catch(err => {
          document.getElementById('pt-canvas').textContent = 'Failed to load trace: ' + err.message;
        });
      return;
    }

    document.getElementById('pt-canvas').textContent = 'No XML data source found.';
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
`;
