import { useMemo, useRef, useEffect, useCallback } from 'react';
import ChartRenderer from './ChartRenderer';
import WidgetRenderer from './WidgetRenderer';

const PLACEHOLDER = '%%BLOCK_PLACEHOLDER%%';

function extractBlocks(text) {
  let remaining = text;
  const blocks = [];

  // 1. Extract ```widget ... ``` blocks (interactive HTML dashboards)
  // Also handle unclosed widgets (truncated output) — treat everything after ```widget as HTML
  remaining = remaining.replace(/```widget\s*\n([\s\S]*?)```/g, (_, html) => {
    blocks.push({ type: 'widget', html: html.trim() });
    return `\n${PLACEHOLDER}\n`;
  });
  // If widget block was opened but never closed (truncated), extract it anyway
  if (remaining.includes('```widget')) {
    remaining = remaining.replace(/```widget\s*\n([\s\S]*)$/g, (_, html) => {
      if (html.trim()) {
        blocks.push({ type: 'widget', html: html.trim() });
        return `\n${PLACEHOLDER}\n`;
      }
      return _;
    });
  }

  // 2. Extract ```chart ... ``` blocks
  remaining = remaining.replace(/```chart\s*\n([\s\S]*?)```/g, (_, json) => {
    try {
      const spec = JSON.parse(json.trim());
      if (spec.type && spec.labels) {
        blocks.push({ type: 'chart', spec });
        return `\n${PLACEHOLDER}\n`;
      }
    } catch {}
    return _;
  });

  // 3. Extract bare JSON chart objects (AI sometimes omits fences)
  remaining = remaining.replace(
    /\n(\{[^{}]*"type"\s*:\s*"(?:bar|line|pie|doughnut)"[\s\S]*?"labels"\s*:\s*\[[\s\S]*?\})\s*(?:\n|$)/g,
    (match, json) => {
      try {
        const spec = JSON.parse(json.trim());
        if (spec.type && spec.labels) {
          blocks.push({ type: 'chart', spec });
          return `\n${PLACEHOLDER}\n`;
        }
      } catch {}
      return match;
    }
  );

  // Strip raw HTML that leaked into text (AI generated <div>, <table>, <script> without widget fences)
  remaining = remaining.replace(/<div[\s\S]*?<\/div>/gi, '').replace(/<table[\s\S]*?<\/table>/gi, '').replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<canvas[\s\S]*?<\/canvas>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '');

  if (blocks.length === 0 && !remaining.trim()) return [{ type: 'text', content: text }];
  if (blocks.length === 0) return [{ type: 'text', content: remaining }];

  // Interleave text and blocks
  const textParts = remaining.split(PLACEHOLDER);
  const result = [];
  let blockIdx = 0;

  for (let i = 0; i < textParts.length; i++) {
    const txt = textParts[i].trim();
    if (txt) result.push({ type: 'text', content: txt });
    if (blockIdx < blocks.length) result.push(blocks[blockIdx++]);
  }
  while (blockIdx < blocks.length) result.push(blocks[blockIdx++]);

  return result.length > 0 ? result : [{ type: 'text', content: text }];
}

// Allowlist of drill-link types. Anything not in this set is rendered as
// plain text (no anchor) to prevent attribute injection via unknown types.
const DRILL_TYPES = new Set(['project', 'client', 'deal', 'query']);

function formatMarkdown(text) {
  // Escape &, <, >, " and ' so captured groups are always safe in both text
  // position AND inside double-quoted HTML attributes below. This is the one
  // place that decides XSS safety for the whole pipeline — treat it carefully.
  let t = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

  // Code blocks
  t = t.replace(/```[\s\S]*?```/g, m =>
    `<pre><code>${m.replace(/^```[a-z]*\n?/, '').replace(/```$/, '')}</code></pre>`
  );

  // Inline code
  t = t.replace(/`([^`]+)`/g, '<code>$1</code>');

  // Bold & italic
  t = t.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
  t = t.replace(/\*(.*?)\*/g, '<em>$1</em>');

  // Drill-down links: [Text](drill://type/query)
  t = t.replace(/\[([^\]]+)\]\(drill:\/\/(\w+)\/([^)]+)\)/g, (_, text, type, query) => {
    // Unknown types: render as plain text, do NOT emit an anchor. Prevents
    // attribute-injection if an attacker smuggles a novel "type" through
    // AI output. `text` is already attribute-safe (escaped above).
    if (!DRILL_TYPES.has(type)) return text;
    const tooltip = type === 'project' ? `Click to see details about ${text}` :
                    type === 'client' ? `Click to see ${text} profile` :
                    type === 'deal' ? `Click to see deal details` :
                    /* query */       `Click to explore`;
    return `<a class="drill-link" data-drill-type="${type}" data-drill-query="${query}" title="${tooltip}">${text}</a>`;
  });

  // Legacy Fix All button: [apply_fixes:action1|action2:Label]
  t = t.replace(/\[apply_fixes:([^:]+):([^\]]+)\]/g, (_, actions, label) =>
    `<div class="draft-actions" style="margin-top:12px"><button class="action-btn action-confirm" data-action="apply_fixes" data-fixes="${actions}">${label}</button></div>`
  );

  // Per-log Fix button: [log_fix:logId:key=value:Label]
  t = t.replace(/\[log_fix:(\d+):([^:]+):([^\]]+)\]/g, (_, logId, fixes, label) =>
    `<button class="action-btn action-log-fix" data-action="log_fix" data-log-id="${logId}" data-fixes="${fixes}" style="background:#cc6b4a;color:#fff;border:none;padding:4px 12px;border-radius:6px;cursor:pointer;font-size:12px;margin-right:6px">${label}</button>`
  );

  // Per-log Ignore button: [log_ignore:logId:Label]
  t = t.replace(/\[log_ignore:(\d+):([^\]]+)\]/g, (_, logId, label) =>
    `<button class="action-btn action-log-ignore" data-action="log_ignore" data-log-id="${logId}" style="background:#333;color:#aaa;border:1px solid #555;padding:4px 12px;border-radius:6px;cursor:pointer;font-size:12px">${label}</button>`
  );

  // Bulk Fix All: [log_fix_all:id1,id2:key1=val1|key2=val2:Label]
  t = t.replace(/\[log_fix_all:([^:]+):([^:]*):([^\]]+)\]/g, (_, logIds, fixes, label) =>
    `<button class="action-btn action-log-fix" data-action="log_fix_all" data-log-ids="${logIds}" data-fixes="${fixes}" style="background:#cc6b4a;color:#fff;border:none;padding:6px 16px;border-radius:6px;cursor:pointer;font-size:13px;font-weight:600;margin-right:8px">${label}</button>`
  );

  // Bulk Ignore All: [log_ignore_all:id1,id2:Label]
  t = t.replace(/\[log_ignore_all:([^:]+):([^\]]+)\]/g, (_, logIds, label) =>
    `<button class="action-btn action-log-ignore" data-action="log_ignore_all" data-log-ids="${logIds}" style="background:#333;color:#aaa;border:1px solid #555;padding:6px 16px;border-radius:6px;cursor:pointer;font-size:13px;font-weight:600">${label}</button>`
  );

  // Email reply/replyall buttons: [reply:email:subject:Label] [replyall:email:subject:Label]
  t = t.replace(/\[reply:([^:]+):([^:]*):([^\]]+)\]/g, (_, email, subject, label) =>
    `<button class="action-btn action-reply" data-action="reply" data-email="${email}" data-subject="${subject}">${label}</button>`
  );
  t = t.replace(/\[replyall:([^:]+):([^:]*):([^\]]+)\]/g, (_, email, subject, label) =>
    `<button class="action-btn action-reply" data-action="replyall" data-email="${email}" data-subject="${subject}">${label}</button>`
  );

  // Calendar event modify button: [event_modify:eventId:title:Label]
  t = t.replace(/\[event_modify:([^:]+):([^:]*):([^\]]+)\]/g, (_, eventId, title, label) =>
    `<button class="action-btn action-event" data-action="modify_event" data-event-id="${eventId}" data-event-title="${title}">${label}</button>`
  );

  // Confirm send button: [DRAFT READY]
  t = t.replace(/\[DRAFT READY\]/g,
    '<div class="draft-actions"><button class="action-btn action-confirm" data-action="confirm_send">Confirm & Send</button><button class="action-btn action-edit" data-action="edit_draft">Edit</button></div>'
  );

  // Regular markdown links (non-drill)
  t = t.replace(/\[([^\]]+)\]\((?!drill:)(https?:\/\/[^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');

  // Markdown tables
  t = t.replace(/(?:^|\n)(\|.+\|)\n(\|[-| :]+\|)\n((?:\|.+\|\n?)+)/g, (_, header, sep, body) => {
    const thCells = header.split('|').filter(c => c.trim()).map(c => `<th>${c.trim()}</th>`).join('');
    const rows = body.trim().split('\n').map(row => {
      const cells = row.split('|').filter(c => c.trim()).map(c => `<td>${c.trim()}</td>`).join('');
      return `<tr>${cells}</tr>`;
    }).join('');
    return `<table class="md-table"><thead><tr>${thCells}</tr></thead><tbody>${rows}</tbody></table>`;
  });

  // Headers
  t = t.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  t = t.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  t = t.replace(/^# (.+)$/gm, '<h1>$1</h1>');

  // Lists
  t = t.replace(/^- (.+)$/gm, '<li>$1</li>');
  t = t.replace(/(<li>[\s\S]*?<\/li>)/g, '<ul>$1</ul>');

  // Paragraphs
  t = t.split(/\n\n+/).map(b => {
    b = b.trim();
    if (!b) return '';
    if (/^<(h[1-3]|ul|pre|li|table)/.test(b)) return b;
    return '<p>' + b.replace(/\n/g, '<br>') + '</p>';
  }).join('');

  return t;
}

export default function MarkdownRenderer({ content, isStreaming, onFollowUp, onOpenArtifact }) {
  // ALL HOOKS MUST BE AT THE TOP — before any conditional returns
  const containerRef = useRef(null);
  const panelLoadingRef = useRef(false);
  const lastWidgetRef = useRef('');
  const parts = useMemo(() => extractBlocks(content), [content]);

  const hasIncompleteBlock = isStreaming && (
    (content.includes('```widget') && !content.includes('```widget\n')) ||
    (content.match(/```widget\n/g)?.length || 0) > (content.match(/```\n/g)?.length || 0) ||
    (content.includes('```widget') && content.split('```').length % 2 === 0) ||
    (content.includes('```chart') && content.split('```').length % 2 === 0)
  );

  const hasBlocks = parts.some(p => p.type !== 'text');
  const followUps = !isStreaming ? extractFollowUps(content) : [];

  const handleDrillClick = useCallback((e) => {
    const link = e.target.closest('.drill-link');
    if (!link || !onFollowUp) return;
    e.preventDefault();
    const type = link.dataset.drillType;
    const query = link.dataset.drillQuery;
    onFollowUp(type === 'query' ? query : `tell me more about ${query}`);
  }, [onFollowUp]);

  // Handle action button clicks (reply, reply all, modify event, confirm send)
  const handleActionClick = useCallback((e) => {
    const btn = e.target.closest('.action-btn');
    if (!btn || !onFollowUp) return;
    e.preventDefault();
    const action = btn.dataset.action;
    if (action === 'reply') {
      const email = btn.dataset.email;
      const subject = btn.dataset.subject;
      onFollowUp(`Reply to ${email} regarding "${subject}" — what should I say?`);
    } else if (action === 'replyall') {
      const email = btn.dataset.email;
      const subject = btn.dataset.subject;
      onFollowUp(`Reply all to "${subject}" — what should I say?`);
    } else if (action === 'modify_event') {
      const title = btn.dataset.eventTitle;
      onFollowUp(`I want to change the "${title}" event — what would you like to change?`);
    } else if (action === 'confirm_send') {
      onFollowUp('confirm');
    } else if (action === 'edit_draft') {
      onFollowUp('I want to edit the draft — ');
    } else if (action === 'apply_fixes') {
      const fixes = btn.dataset.fixes;
      onFollowUp(`yes apply all fixes: ${fixes}`);
    } else if (action === 'log_fix') {
      const logId = btn.dataset.logId;
      const fixes = btn.dataset.fixes;
      const fixArray = fixes ? fixes.split('|').map(f => { const [key, value] = f.split('='); return { key, value }; }) : [];
      btn.disabled = true;
      btn.textContent = 'Fixing...';
      import('../services/api').then(({ default: api }) => {
        api.post(`/logs/${logId}/fix`, { fixes: fixArray }).then(() => {
          btn.textContent = '✅ Fixed';
          btn.style.background = '#22c55e';
          const ignoreBtn = btn.nextElementSibling;
          if (ignoreBtn) ignoreBtn.style.display = 'none';
        }).catch(() => { btn.textContent = '❌ Failed'; btn.disabled = false; });
      });
    } else if (action === 'log_ignore') {
      const logId = btn.dataset.logId;
      btn.disabled = true;
      btn.textContent = 'Ignoring...';
      import('../services/api').then(({ default: api }) => {
        api.patch(`/logs/${logId}/ignore`).then(() => {
          btn.textContent = '⊘ Ignored';
          btn.style.background = '#555';
          const fixBtn = btn.previousElementSibling;
          if (fixBtn?.dataset?.action === 'log_fix') fixBtn.style.display = 'none';
        }).catch(() => { btn.textContent = '❌ Failed'; btn.disabled = false; });
      });
    } else if (action === 'log_fix_all') {
      const logIds = btn.dataset.logIds.split(',').map(Number);
      const fixes = btn.dataset.fixes ? btn.dataset.fixes.split('|').map(f => { const [key, value] = f.split('='); return { key, value }; }) : [];
      btn.disabled = true;
      btn.textContent = 'Fixing all...';
      import('../services/api').then(({ default: api }) => {
        api.post('/logs/fix-all', { fixes, logIds }).then(() => {
          btn.textContent = '✅ All Fixed';
          btn.style.background = '#22c55e';
          document.querySelectorAll('.action-log-fix, .action-log-ignore').forEach(b => { if (b !== btn) b.style.display = 'none'; });
        }).catch(() => { btn.textContent = '❌ Failed'; btn.disabled = false; });
      });
    } else if (action === 'log_ignore_all') {
      const logIds = btn.dataset.logIds.split(',').map(Number);
      btn.disabled = true;
      btn.textContent = 'Ignoring all...';
      import('../services/api').then(({ default: api }) => {
        api.post('/logs/ignore-all', { logIds }).then(() => {
          btn.textContent = '⊘ All Ignored';
          btn.style.background = '#555';
          document.querySelectorAll('.action-log-fix, .action-log-ignore').forEach(b => { if (b !== btn) b.style.display = 'none'; });
        }).catch(() => { btn.textContent = '❌ Failed'; btn.disabled = false; });
      });
    }
  }, [onFollowUp]);

  // Panel loading state
  useEffect(() => {
    if (hasIncompleteBlock && onOpenArtifact && !panelLoadingRef.current) {
      panelLoadingRef.current = true;
      onOpenArtifact('loading', null, 'Building...');
    }
    if (!hasIncompleteBlock) panelLoadingRef.current = false;
  }, [hasIncompleteBlock, onOpenArtifact]);

  // Drill-link + action button click handler
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    el.addEventListener('click', handleDrillClick);
    el.addEventListener('click', handleActionClick);
    return () => { el.removeEventListener('click', handleDrillClick); el.removeEventListener('click', handleActionClick); };
  }, [handleDrillClick, handleActionClick]);

  // Auto-open widget in panel when streaming completes
  useEffect(() => {
    if (isStreaming || !onOpenArtifact) return;
    const firstWidget = parts.find(p => p.type === 'widget');
    if (firstWidget && firstWidget.html !== lastWidgetRef.current) {
      lastWidgetRef.current = firstWidget.html;
      const titleMatch = firstWidget.html.match(/<h[12][^>]*>([^<]+)/i);
      onOpenArtifact('widget', firstWidget.html, titleMatch ? titleMatch[1].trim() : 'Interactive View');
    }
  }, [parts, isStreaming, onOpenArtifact]);

  // ── RENDER ─────────────────────────────────────────────

  if (hasIncompleteBlock) {
    const blockStart = content.lastIndexOf('```');
    const textBefore = content.substring(0, blockStart).trim();
    return (
      <div className={`msg-text streaming-cursor`}>
        {textBefore && <div dangerouslySetInnerHTML={{ __html: formatMarkdown(textBefore) }} />}
      </div>
    );
  }

  if (!hasBlocks) {
    const mainContent = followUps.length > 0 ? removeFollowUps(content) : content;
    return (
      <div ref={containerRef} className={`msg-text${isStreaming ? ' streaming-cursor' : ''}`}>
        <div dangerouslySetInnerHTML={{ __html: formatMarkdown(mainContent) }} />
        {followUps.length > 0 && <FollowUpChips items={followUps} onFollowUp={onFollowUp} />}
      </div>
    );
  }

  return (
    <div ref={containerRef} className={`msg-text${isStreaming ? ' streaming-cursor' : ''}`}>
      {parts.map((part, i) => {
        if (part.type === 'chart') {
          return (
            <button key={i} className="artifact-link" onClick={() => onOpenArtifact?.('chart', null, 'Chart')}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M8 16V12M12 16V8M16 16v-2"/></svg>
              View chart
            </button>
          );
        }
        if (part.type === 'widget') {
          const wTitle = part.html.match(/<h[12][^>]*>([^<]+)/i);
          const label = wTitle ? wTitle[1].trim() : 'Interactive View';
          return (
            <button key={i} className="artifact-link" onClick={() => onOpenArtifact?.('widget', part.html, label)}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6M15 3h6v6M10 14L21 3"/></svg>
              View {label.toLowerCase()}
            </button>
          );
        }
        const partContent = i === parts.length - 1 && followUps.length > 0 ? removeFollowUps(part.content) : part.content;
        return <div key={i} dangerouslySetInnerHTML={{ __html: formatMarkdown(partContent) }} />;
      })}
      {followUps.length > 0 && <FollowUpChips items={followUps} onFollowUp={onFollowUp} />}
    </div>
  );
}

function extractFollowUps(text) {
  // Match the last bullet list ONLY if it looks like suggestions/questions (not data descriptions).
  // Must have a header like "Next steps:", "Would you like:", "You can:", etc.
  const lines = text.trim().split('\n');
  const suggestions = [];
  let hasHeader = false;

  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line.startsWith('- ') || line.startsWith('* ')) {
      const content = line.replace(/^[-*]\s*/, '').replace(/\*\*/g, '').trim();
      // Only treat as follow-up if it looks like a suggestion (question, action verb, short)
      if (content.length < 120 && (/\?$/.test(content) || /^(show|check|view|tell|give|list|create|send|analyze|compare|help|would|can|shall|want|try)/i.test(content))) {
        suggestions.unshift(content);
      } else {
        // Long descriptive bullet — not a follow-up suggestion, stop
        break;
      }
    } else if (suggestions.length > 0) {
      // Check if this line is a header introducing follow-ups
      if (/next steps|would you like|you can also|here are some|try asking|you might want|what would you like/i.test(line)) {
        hasHeader = true;
      }
      break;
    }
  }
  // Only show pills if we found a clear follow-up section with 2+ items
  return (suggestions.length >= 2 && hasHeader) ? suggestions : [];
}

function removeFollowUps(text) {
  const lines = text.trim().split('\n');
  // Remove trailing list items and the "Next steps:" / "Would you like me to:" header
  let end = lines.length;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line.startsWith('- ') || line.startsWith('* ') || !line) {
      end = i;
    } else if (/^(\*\*)?next steps|would you like/i.test(line)) {
      end = i;
      break;
    } else {
      break;
    }
  }
  return lines.slice(0, end).join('\n').trim();
}

function FollowUpChips({ items, onFollowUp }) {
  if (!onFollowUp) return null;
  return (
    <div className="followup-chips">
      {items.map((item, i) => (
        <button key={i} className="followup-chip" onClick={() => onFollowUp(item)}>
          {item}
        </button>
      ))}
    </div>
  );
}
