import { useState, useEffect, useRef, lazy, Suspense } from 'react';

const DashboardWidget = lazy(() => import('./widgets/DashboardWidget'));

export default function ArtifactPanel({ artifact, onClose }) {
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const timerRef = useRef(null);

  // Timer for loading state + auto-close after 60s
  useEffect(() => {
    if (artifact?.type === 'loading') {
      setElapsed(0);
      timerRef.current = setInterval(() => {
        setElapsed(s => {
          if (s >= 60) {
            // Auto-close stuck panel after 60s
            onClose?.();
            return s;
          }
          return s + 1;
        });
      }, 1000);
    } else {
      if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
    }
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [artifact?.type]);

  if (!artifact) return null;

  return (
    <>
      <div className={`artifact-overlay ${artifact ? 'open' : ''}`} onClick={onClose} />

      <div className={`artifact-panel ${artifact ? 'open' : ''} ${isFullscreen ? 'fullscreen' : ''}`}>
        <div className="artifact-header">
          <span className="artifact-title">
            {artifact.title || 'Dashboard'}
            {artifact.type === 'loading' && <span className="artifact-timer">{elapsed}s</span>}
          </span>
          <div className="artifact-actions">
            <DownloadMenu artifact={artifact} />
            <button className="artifact-btn" onClick={() => setIsFullscreen(f => !f)} title={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}>
              {isFullscreen ? (
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M8 3v3a2 2 0 01-2 2H3M21 8h-3a2 2 0 01-2-2V3M3 16h3a2 2 0 012 2v3M16 21v-3a2 2 0 012-2h3"/></svg>
              ) : (
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M8 3H5a2 2 0 00-2 2v3M21 8V5a2 2 0 00-2-2h-3M3 16v3a2 2 0 002 2h3M16 21h3a2 2 0 002-2v-3"/></svg>
              )}
            </button>
            <button className="artifact-btn" onClick={onClose} title="Close">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>
            </button>
          </div>
        </div>
        <div className="artifact-body">
          {artifact.type === 'loading' && (
            <div className="artifact-loading">
              <div className="welcome-loading-dots"><span></span><span></span><span></span></div>
              <p>Building your interactive view...</p>
              <p className="artifact-loading-detail">
                {elapsed < 10 ? 'Generating layout and data...' :
                 elapsed < 20 ? 'Creating filters and tables...' :
                 elapsed < 35 ? 'Adding charts and interactivity...' :
                 'Finalizing — almost there...'}
              </p>
              <p className="artifact-loading-timer">{elapsed}s elapsed · typically 20-40s for dashboards</p>
            </div>
          )}
          {artifact.type === 'widget' && <ArtifactWidget html={artifact.html} />}
          {artifact.type === 'dashboard' && artifact.widgetData && (
            <Suspense fallback={<div style={{padding:20,color:'#888'}}>Loading dashboard...</div>}>
              <DashboardWidget data={artifact.widgetData} />
            </Suspense>
          )}
          {artifact.type === 'chart' && <div className="artifact-chart">{artifact.content}</div>}
        </div>
      </div>
    </>
  );
}

function ArtifactWidget({ html }) {
  const doc = `<!DOCTYPE html>
<html><head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<script src="https://cdn.jsdelivr.net/npm/chart.js@4"></script>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Inter', -apple-system, sans-serif; background: #1e1e1e; color: #e8e8e0; padding: 20px; font-size: 14px; line-height: 1.6; }
  h1, h2, h3 { font-weight: 500; color: #eee; margin: 12px 0 8px; }
  h1 { font-size: 20px; } h2 { font-size: 17px; } h3 { font-size: 15px; }
  table { width: 100%; border-collapse: collapse; margin: 10px 0; font-size: 13px; }
  thead { position: sticky; top: 0; z-index: 1; }
  th { background: #2a2a2a; color: #e8e8e0; text-align: left; padding: 10px 12px; border-bottom: 2px solid #cc6b4a; font-weight: 600; font-size: 12px; text-transform: uppercase; letter-spacing: 0.3px; }
  td { padding: 8px 12px; border-bottom: 1px solid #2a2a2a; color: #bbb; }
  tr:nth-child(even) td { background: #1a1a1a; }
  tr:hover td { background: #2a2a2a; color: #eee; }
  .card-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; margin: 12px 0; }
  .stat-card { background: linear-gradient(135deg, #252525, #1e1e1e); border: 1px solid #333; border-radius: 12px; padding: 16px; text-align: center; }
  .stat-card:hover { border-color: #cc6b4a; }
  .stat-value { font-size: 28px; font-weight: 700; color: #cc6b4a; }
  .stat-label { font-size: 11px; color: #888; margin-top: 6px; text-transform: uppercase; letter-spacing: 0.5px; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 11px; font-weight: 500; }
  .badge-critical { background: rgba(239,68,68,0.15); color: #ef4444; }
  .badge-high { background: rgba(245,158,11,0.15); color: #f59e0b; }
  .badge-medium { background: rgba(59,130,246,0.15); color: #3b82f6; }
  .badge-low { background: rgba(74,222,128,0.15); color: #4ade80; }
  .filter-bar { display: flex; gap: 8px; flex-wrap: wrap; margin: 10px 0; }
  .filter-btn { padding: 6px 14px; border-radius: 16px; border: 1px solid #444; background: transparent; color: #aaa; cursor: pointer; font-size: 12px; font-family: inherit; transition: all 0.15s; }
  .filter-btn:hover { background: #333; color: #eee; }
  .filter-btn.active { background: #cc6b4a; border-color: #cc6b4a; color: #fff; }
  .progress-bar { width: 100%; height: 6px; background: #333; border-radius: 3px; overflow: hidden; }
  .progress-fill { height: 100%; border-radius: 3px; background: #cc6b4a; transition: width 0.3s; }
  .chart-wrap { background: #252525; border: 1px solid #333; border-radius: 10px; padding: 14px; margin: 10px 0; max-height: 300px; }
  .chart-wrap canvas { max-height: 260px !important; }
  .chart-grid, [style*="grid-template-columns"] { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
  @media (max-width: 600px) { .chart-grid, [style*="grid-template-columns"] { grid-template-columns: 1fr; } }
  select, input { background: #2a2a2a; border: 1px solid #444; color: #eee; padding: 6px 10px; border-radius: 8px; font-size: 13px; }
  .org-tree { list-style:none; padding:0; }
  .org-tree ul { list-style:none; padding-left:24px; border-left:2px solid #333; margin-left:16px; }
  .org-node { padding:10px 14px; margin:4px 0; border-radius:10px; background:#252525; border:1px solid #333; display:inline-block; min-width:250px; transition:all 0.15s; }
  .org-node:hover { border-color:#cc6b4a; }
  .org-node .name { font-weight:600; color:#e8e8e0; font-size:14px; }
  .org-node .title { font-size:12px; color:#888; margin-top:3px; }
  .org-node .grade { font-size:10px; color:#cc6b4a; font-weight:600; padding:2px 6px; background:rgba(204,107,74,0.15); border-radius:4px; }
  .org-node .dept { font-size:10px; color:#4ade80; padding:2px 6px; background:rgba(74,222,128,0.15); border-radius:4px; }
  .toggle-btn { background:#333; border:1px solid #555; color:#aaa; width:22px; height:22px; border-radius:50%; font-size:12px; cursor:pointer; display:inline-flex; align-items:center; justify-content:center; margin-right:8px; }
  .toggle-btn:hover { background:#cc6b4a; color:#fff; }
  .org-search { width:100%; padding:10px 14px; background:#2a2a2a; border:1px solid #444; border-radius:8px; color:#eee; font-size:14px; margin:12px 0; }
</style>
</head><body>
${html}
</body></html>`;

  return (
    <iframe
      srcDoc={doc}
      className="artifact-iframe"
      sandbox="allow-scripts allow-same-origin allow-downloads"
      title="Dashboard"
    />
  );
}

function DownloadMenu({ artifact }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    const handler = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('click', handler);
    return () => document.removeEventListener('click', handler);
  }, []);

  if (!artifact || artifact.type !== 'widget') return null;

  const getHtmlContent = () => artifact.html || '';

  const downloadCSV = () => {
    const html = getHtmlContent();
    // Extract all tables from HTML
    const div = document.createElement('div');
    div.innerHTML = html;
    const tables = div.querySelectorAll('table');
    let csv = '';
    tables.forEach((table, ti) => {
      if (ti > 0) csv += '\n\n';
      table.querySelectorAll('tr').forEach(row => {
        const cols = [];
        row.querySelectorAll('th, td').forEach(cell => cols.push('"' + cell.textContent.replace(/"/g, '""').trim() + '"'));
        csv += cols.join(',') + '\n';
      });
    });
    const blob = new Blob([csv], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = (artifact.title || 'report').replace(/[^a-z0-9]/gi, '_') + '.csv';
    a.click();
    setOpen(false);
  };

  // C5 — HTML sanitizer used before writing artifact content into a new
  // window or Blob. Regex-based script/button/style stripping cannot
  // reliably block XSS (nested tags, srcdoc iframes, event handlers, etc).
  // We parse with DOMParser, walk the tree, and only keep an allowlist of
  // tags and attributes. This runs fully client-side — no new deps.
  const SAFE_TAGS = new Set([
    'html', 'head', 'body', 'meta', 'title', 'style',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'p', 'div', 'span', 'br', 'hr', 'strong', 'em', 'b', 'i', 'u',
    'ul', 'ol', 'li', 'dl', 'dt', 'dd',
    'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td',
    'img', 'a', 'blockquote', 'code', 'pre', 'small', 'sup', 'sub',
  ]);
  const SAFE_ATTRS = new Set(['href', 'src', 'alt', 'title', 'colspan', 'rowspan', 'class', 'style']);
  const sanitizeHtmlFragment = (raw) => {
    const doc = new DOMParser().parseFromString(`<div>${raw}</div>`, 'text/html');
    const root = doc.body.firstChild;
    const walk = (node) => {
      for (const child of Array.from(node.childNodes)) {
        if (child.nodeType === 8 /* comment */) {
          child.remove();
          continue;
        }
        if (child.nodeType !== 1 /* element */) continue;
        const tag = child.tagName.toLowerCase();
        if (!SAFE_TAGS.has(tag)) {
          // Drop the whole subtree rather than unwrapping — safer when the
          // content is <script>, <iframe>, <object>, <svg>, etc.
          child.remove();
          continue;
        }
        // Strip disallowed attributes and all event handlers (on*) and
        // javascript:/data: URLs except image data: (safe).
        for (const attr of Array.from(child.attributes)) {
          const name = attr.name.toLowerCase();
          const val = attr.value;
          if (name.startsWith('on') || !SAFE_ATTRS.has(name)) {
            child.removeAttribute(attr.name);
            continue;
          }
          if ((name === 'href' || name === 'src') && /^\s*javascript:/i.test(val)) {
            child.removeAttribute(attr.name);
          }
          if (name === 'src' && /^\s*data:(?!image\/)/i.test(val)) {
            child.removeAttribute(attr.name);
          }
        }
        walk(child);
      }
    };
    walk(root);
    return root.innerHTML;
  };

  const downloadWord = () => {
    const html = sanitizeHtmlFragment(getHtmlContent());
    const wordContent = `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40">
<head><meta charset="utf-8"><style>body{font-family:Arial,sans-serif;font-size:12px}table{border-collapse:collapse;width:100%}th,td{border:1px solid #ccc;padding:6px 8px;text-align:left}th{background:#f0f0f0;font-weight:bold}h2,h3{color:#333}</style></head>
<body>${html}</body></html>`;
    const blob = new Blob([wordContent], { type: 'application/msword' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = (artifact.title || 'report').replace(/[^a-z0-9]/gi, '_') + '.doc';
    a.click();
    setOpen(false);
  };

  const downloadPDF = () => {
    // C5 — Sanitize first, then render inside a sandboxed iframe using
    // srcdoc + sandbox="allow-same-origin allow-modals" (no allow-scripts)
    // so even a sanitizer miss can't execute JS in the print window.
    const html = sanitizeHtmlFragment(getHtmlContent());
    const safeTitle = (artifact.title || 'Report').replace(/[<>"']/g, '');
    const srcdoc = `<!doctype html><html><head><title>${safeTitle}</title>
<style>body{font-family:Arial,sans-serif;font-size:12px;padding:20px}table{border-collapse:collapse;width:100%;margin:10px 0}th,td{border:1px solid #ccc;padding:6px 8px;text-align:left}th{background:#f0f0f0;font-weight:bold}h2{font-size:18px}h3{font-size:14px;margin-top:16px}.stat-card{display:inline-block;border:1px solid #ccc;border-radius:8px;padding:12px 20px;margin:4px;text-align:center}.stat-value{font-size:24px;font-weight:bold;color:#333}.stat-label{font-size:10px;color:#888;text-transform:uppercase}.card-grid{margin-bottom:16px}</style>
</head><body>${html}</body></html>`;
    const printWindow = window.open('', '_blank');
    if (printWindow) {
      const iframe = printWindow.document.createElement('iframe');
      iframe.setAttribute('sandbox', 'allow-same-origin allow-modals');
      iframe.style.cssText = 'width:100%;height:100vh;border:0';
      iframe.srcdoc = srcdoc;
      printWindow.document.body.style.margin = '0';
      printWindow.document.body.appendChild(iframe);
      setTimeout(() => { try { iframe.contentWindow?.print(); } catch { printWindow.print(); } }, 500);
    }
    setOpen(false);
  };

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button className="artifact-btn" onClick={() => setOpen(!open)} title="Download">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3"/></svg>
      </button>
      {open && (
        <div style={{ position: 'absolute', right: 0, top: '100%', background: '#2a2a2a', border: '1px solid #444', borderRadius: 8, padding: 4, zIndex: 100, minWidth: 150, boxShadow: '0 4px 12px rgba(0,0,0,0.3)' }}>
          <button onClick={downloadCSV} style={{ display: 'block', width: '100%', padding: '8px 12px', background: 'none', border: 'none', color: '#eee', fontSize: 13, textAlign: 'left', cursor: 'pointer', borderRadius: 6 }}
            onMouseEnter={e => e.target.style.background = '#333'} onMouseLeave={e => e.target.style.background = 'none'}>
            📊 Excel (CSV)
          </button>
          <button onClick={downloadWord} style={{ display: 'block', width: '100%', padding: '8px 12px', background: 'none', border: 'none', color: '#eee', fontSize: 13, textAlign: 'left', cursor: 'pointer', borderRadius: 6 }}
            onMouseEnter={e => e.target.style.background = '#333'} onMouseLeave={e => e.target.style.background = 'none'}>
            📝 Word (DOC)
          </button>
          <button onClick={downloadPDF} style={{ display: 'block', width: '100%', padding: '8px 12px', background: 'none', border: 'none', color: '#eee', fontSize: 13, textAlign: 'left', cursor: 'pointer', borderRadius: 6 }}
            onMouseEnter={e => e.target.style.background = '#333'} onMouseLeave={e => e.target.style.background = 'none'}>
            📄 PDF (Print)
          </button>
        </div>
      )}
    </div>
  );
}
