/**
 * Contacts — the user's auto-discovered + imported address book of
 * intelligence. Each contact is an entity_person wiki page; the user
 * sets a 0-5 star importance rating that boosts criticality + risk
 * radar severity for that sender.
 *
 * Filters:
 *   • Search by name / email
 *   • Min stars (★+ ≥ 1, ≥ 4, etc.)
 *   • Source (auto-discovered / google / microsoft / whatsapp)
 *
 * Star UX: click a star to set; click the same star again to clear.
 * Saves immediately, no Save button. Optimistic update with revert on
 * error.
 */
import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { Link } from 'react-router-dom';
import api from '../services/api';
import { useAuth } from '../context/AuthContext';

const SOURCE_OPTIONS = [
  { value: '',                    label: 'All sources' },
  { value: 'auto_discovered',     label: 'Auto-discovered' },
  { value: 'google_contacts',     label: 'Google' },
  { value: 'microsoft_contacts',  label: 'Microsoft' },
  { value: 'whatsapp_history',    label: 'WhatsApp' },
  { value: 'odoo_mirror',         label: 'Odoo CRM' },
];

const STAR_FILTERS = [
  { value: 0, label: 'All' },
  { value: 1, label: '★ 1+' },
  { value: 2, label: '★ 2+' },
  { value: 3, label: '★ 3+' },
  { value: 4, label: '★ 4+' },
  { value: 5, label: '★ 5' },
];

export default function ContactsPage() {
  const { user } = useAuth();
  const [entities, setEntities] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);

  // Modal state
  const [showAdd, setShowAdd] = useState(false);
  const [importing, setImporting] = useState('');
  // Smart cleanup state — mirrors the Open Items pattern. Two stages:
  //   cleanupBusy=true while the dry-run scan is happening
  //   cleanupPreview holds the { total, samples } from a successful scan
  //   cleanupApplying=true while the actual archive call is running
  const [cleanupBusy, setCleanupBusy] = useState(false);
  const [cleanupPreview, setCleanupPreview] = useState(null);
  const [cleanupApplying, setCleanupApplying] = useState(false);

  // Inline toast queue (replaces alert()). Each toast auto-dismisses
  // after 6s; click-to-dismiss is also wired.
  const [toasts, setToasts] = useState([]);
  const notify = useCallback((kind, text) => {
    const id = Date.now() + Math.random();
    setToasts((ts) => [...ts, { id, kind, text }]);
    setTimeout(() => setToasts((ts) => ts.filter((t) => t.id !== id)), 6000);
  }, []);
  const dismissToast = useCallback((id) => {
    setToasts((ts) => ts.filter((t) => t.id !== id));
  }, []);

  // Filters
  const [q, setQ] = useState('');
  const [minStars, setMinStars] = useState(0);
  const [source, setSource] = useState('');
  const [sort, setSort] = useState('stars');
  // Visibility filter — Per MD 2026-05-13: "how can i see which contacts
  // are marked Private or Public?" Three states:
  //   '' (all) | 'public' (scope=tenant) | 'private' (scope=user)
  // Filtered client-side from the entities list so it composes with the
  // server-side filters above without an extra round-trip.
  const [visibility, setVisibility] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      params.set('limit', '200');
      if (q.trim()) params.set('q', q.trim());
      if (minStars > 0) params.set('minStars', String(minStars));
      if (source) params.set('source', source);
      if (sort) params.set('sort', sort);
      const res = await api.get(`/entity-catalog?${params.toString()}`);
      setEntities(res.data.entities ?? []);
      setTotal(res.data.total ?? res.data.count ?? 0);
    } catch (err) {
      setError(err.response?.data?.error ?? err.message);
    } finally {
      setLoading(false);
    }
  }, [q, minStars, source, sort]);

  useEffect(() => { load(); }, [load]);

  // Listen for custom 'contacts:reload' event fired by the InactiveButton
  // after a successful mark-inactive POST. Avoids the need to plumb a
  // callback through the ContactsTable → row → button hierarchy.
  useEffect(() => {
    const onReload = () => load();
    window.addEventListener('contacts:reload', onReload);
    return () => window.removeEventListener('contacts:reload', onReload);
  }, [load]);

  const onSetStars = useCallback(async (id, stars) => {
    // Optimistic update
    const prev = entities;
    setEntities((es) => es.map((e) => (e.id === id ? { ...e, stars } : e)));
    try {
      await api.patch(`/entity-catalog/${encodeURIComponent(id)}/stars`, { stars });
    } catch (err) {
      setEntities(prev);
      notify('error', `Couldn't save rating: ${err.response?.data?.error ?? err.message}`);
    }
  }, [entities, notify]);

  // Link two or more rows under one linkedPersonId (group them as
  // "same person, different identifiers"). Per the user 2026-05-13:
  // an executive contact often has work email + personal email + phone;
  // Path B keeps each as its own row (so scope can differ per channel)
  // but links them so Brain knows it's one person.
  const onLinkContacts = useCallback(async (ids) => {
    if (!Array.isArray(ids) || ids.length < 2) return;
    try {
      const { data } = await api.post('/entity-catalog/link', { ids });
      notify('success', `Linked ${data.count} identifiers under one person.`);
      load();
    } catch (err) {
      notify('error', `Link failed: ${err.response?.data?.error ?? err.message}`);
    }
  }, [load, notify]);

  const onUnlinkContact = useCallback(async (id) => {
    try {
      await api.post('/entity-catalog/unlink', { id });
      notify('success', 'Unlinked from group.');
      load();
    } catch (err) {
      notify('error', `Unlink failed: ${err.response?.data?.error ?? err.message}`);
    }
  }, [load, notify]);

  const triggerSweep = useCallback(async () => {
    setRefreshing(true);
    try {
      await api.post('/entity-catalog/sweep', { lookbackDays: 30 });
      await load();
      notify('ok', 'Refreshed contacts from feed.');
    } catch (err) {
      notify('error', `Sweep failed: ${err.response?.data?.error ?? err.message}`);
    } finally {
      setRefreshing(false);
    }
  }, [load, notify]);

  // Smart cleanup — scan-then-confirm flow. Preview lists what would be
  // archived; user clicks "Yes, archive them" to apply. Junk filter is
  // the same one that blocks new auto-discovery, so the criteria match
  // user expectations: no-reply, mailer-daemon, marketing@, newsletter@,
  // tracking-token prefixes, etc.
  const startCleanup = useCallback(async () => {
    setCleanupBusy(true);
    setCleanupPreview(null);
    try {
      const r = await api.post('/entity-catalog/cleanup-junk', { dryRun: true });
      const total = r.data?.total ?? 0;
      if (total === 0) {
        notify('ok', 'Nothing to clean up — all contacts look like real humans.');
      } else {
        setCleanupPreview(r.data);
      }
    } catch (err) {
      notify('error', `Cleanup scan failed: ${err.response?.data?.error ?? err.message}`);
    } finally {
      setCleanupBusy(false);
    }
  }, [notify]);

  const applyCleanup = useCallback(async () => {
    setCleanupApplying(true);
    try {
      const r = await api.post('/entity-catalog/cleanup-junk', { dryRun: false });
      notify('ok', `Archived ${r.data?.archived ?? 0} junk contact${(r.data?.archived ?? 0) === 1 ? '' : 's'}.`);
      setCleanupPreview(null);
      await load();
    } catch (err) {
      notify('error', `Cleanup failed: ${err.response?.data?.error ?? err.message}`);
    } finally {
      setCleanupApplying(false);
    }
  }, [notify, load]);

  const importFrom = useCallback(async (provider) => {
    setImporting(provider);
    try {
      const res = await api.post(`/entity-catalog/import/${provider}`);
      const r = res.data?.result ?? {};
      // Decide kind by outcome: any imports → success; nothing imported
      // and an error string → warn the user with the actionable hint.
      if ((r.imported ?? 0) > 0) {
        notify('ok', `Imported ${r.imported}/${r.scanned} contact${r.imported === 1 ? '' : 's'}${r.errors ? ` · ${r.errors} error${r.errors === 1 ? '' : 's'}` : ''}.`);
      } else if (r.error) {
        const provLabel = provider === 'google' ? 'Google' : 'Outlook';
        // 'invalid_grant' = stale OAuth token. Translate to actionable message.
        const isAuth = /invalid_grant|invalid_token|expired|permission/i.test(r.error);
        notify('warn', isAuth
          ? `${provLabel} authorization expired. Open Connectors and reconnect ${provLabel} to import contacts.`
          : `Imported 0 contacts. ${r.error}`);
      } else {
        notify('warn', `Imported 0 contacts (nothing to sync).`);
      }
      await load();
    } catch (err) {
      const msg = err.response?.data?.error ?? err.message;
      notify('error', `Import failed: ${msg}`);
    } finally {
      setImporting('');
    }
  }, [load, notify]);

  const counts = useMemo(() => {
    const byStars = [0, 0, 0, 0, 0, 0];
    for (const e of entities) byStars[e.stars ?? 0] += 1;
    return byStars;
  }, [entities]);

  return (
    <div style={{ padding: 'var(--s-6, 24px) var(--s-8, 32px)', maxWidth: 1400 }}>
      <header style={{ marginBottom: 'var(--s-4, 16px)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 12 }}>
          <div>
            <h1 style={{ margin: 0, fontSize: 'var(--fs-2xl, 24px)' }}>Contacts</h1>
            <p style={{ color: 'var(--text-muted, #98a0a8)', fontSize: 'var(--fs-sm, 13px)', margin: '4px 0 0', maxWidth: 720 }}>
              Set importance stars (★ 0–5) to tell Brain which people matter most. Higher stars = higher
              priority on every message they send. Auto-discovered from feed; import more from Google/Outlook
              or add manually.
            </p>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button onClick={() => setShowAdd(true)} style={btnStyle(false)}>+ Add contact</button>
            <button
              onClick={() => importFrom('google')}
              disabled={importing === 'google'}
              style={btnStyle(importing === 'google', 'subtle')}
              title="Import contacts from your connected Google account"
            >
              {importing === 'google' ? 'Importing…' : 'Import: Google'}
            </button>
            <button
              onClick={() => importFrom('microsoft')}
              disabled={importing === 'microsoft'}
              style={btnStyle(importing === 'microsoft', 'subtle')}
              title="Import contacts from your connected Outlook account"
            >
              {importing === 'microsoft' ? 'Importing…' : 'Import: Microsoft'}
            </button>
            <button onClick={triggerSweep} disabled={refreshing} style={btnStyle(refreshing, 'subtle')}>
              {refreshing ? 'Refreshing…' : 'Refresh from feed'}
            </button>
            <button
              onClick={startCleanup}
              disabled={cleanupBusy}
              style={btnStyle(cleanupBusy, 'subtle')}
              title="Find no-reply / newsletter / postmaster contacts and archive them. You'll see a preview before anything is archived."
            >
              {cleanupBusy ? 'Scanning…' : '🧹 Smart cleanup'}
            </button>
          </div>
        </div>

        {/* Cleanup confirmation banner — mirrors the Open Items pattern */}
        {cleanupPreview && (
          <div style={{
            marginTop: 12, padding: '12px 14px',
            background: 'rgba(245,158,11,0.08)',
            border: '1px solid rgba(245,158,11,0.4)',
            borderRadius: 8, color: 'var(--text)', fontSize: 13, lineHeight: 1.45,
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
              <div style={{ flex: 1, minWidth: 280 }}>
                About to archive <strong>{cleanupPreview.total}</strong> contact{cleanupPreview.total === 1 ? '' : 's'} that look like newsletter / no-reply / system addresses. Reversible — they're soft-archived, not deleted.
                {cleanupPreview.samples?.length > 0 && (
                  <div style={{ marginTop: 8, fontSize: 12, color: 'var(--text-muted)' }}>
                    Examples:&nbsp;
                    {cleanupPreview.samples.slice(0, 3).map((s, i) => (
                      <span key={i}>{i > 0 ? ' · ' : ''}{s.email}</span>
                    ))}
                    {cleanupPreview.samples.length > 3 && <span> · … and {cleanupPreview.total - 3} more</span>}
                  </div>
                )}
              </div>
              <div style={{ display: 'flex', gap: 6 }}>
                <button
                  onClick={applyCleanup} disabled={cleanupApplying}
                  style={{ padding: '6px 14px', borderRadius: 6, border: '1px solid #f59e0b', background: '#f59e0b', color: '#000', cursor: 'pointer', fontSize: 12, fontWeight: 600 }}
                >{cleanupApplying ? 'Archiving…' : 'Yes, archive them'}</button>
                <button
                  onClick={() => setCleanupPreview(null)}
                  style={{ padding: '6px 14px', borderRadius: 6, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 12 }}
                >Cancel</button>
              </div>
            </div>
          </div>
        )}
      </header>

      {showAdd && (
        <AddContactModal
          isAdmin={!!user?.isAdmin}
          onClose={() => setShowAdd(false)}
          onSaved={async (msg) => {
            setShowAdd(false);
            await load();
            if (msg) notify('ok', msg);
          }}
          notify={notify}
        />
      )}

      <ToastStack toasts={toasts} onDismiss={dismissToast} />

      {/* Filter bar */}
      <div style={{
        display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap',
        padding: '12px 14px', border: '1px solid var(--border, #28323e)',
        borderRadius: 10, marginBottom: 16, background: 'var(--panel, #141a22)',
      }}>
        <input
          type="search"
          placeholder="Search name or email…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          style={inputStyle}
        />
        <select value={minStars} onChange={(e) => setMinStars(Number(e.target.value))} style={selectStyle}>
          {STAR_FILTERS.map((f) => (
            <option key={f.value} value={f.value}>{f.label}</option>
          ))}
        </select>
        <select value={source} onChange={(e) => setSource(e.target.value)} style={selectStyle}>
          {SOURCE_OPTIONS.map((s) => (
            <option key={s.value} value={s.value}>{s.label}</option>
          ))}
        </select>
        <select value={sort} onChange={(e) => setSort(e.target.value)} style={selectStyle}>
          <option value="stars">Sort: Stars</option>
          <option value="recent">Sort: Recent</option>
        </select>
        {/* Visibility filter — All / Public / Private. Renders three
            pill-style buttons so MD can quickly see which contacts are
            tenant-shared vs personal. */}
        <div style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
          {[
            { value: '', label: 'All' },
            { value: 'public', label: '🌐 Public' },
            { value: 'private', label: '🔒 Private' },
          ].map((opt) => (
            <button
              key={opt.value}
              type="button"
              onClick={() => setVisibility(opt.value)}
              style={{
                padding: '4px 10px',
                borderRadius: 999,
                fontSize: 12,
                fontWeight: 600,
                cursor: 'pointer',
                background: visibility === opt.value
                  ? (opt.value === 'public' ? 'rgba(79,169,255,0.18)' : opt.value === 'private' ? 'rgba(155,155,155,0.18)' : 'rgba(214,109,60,0.15)')
                  : 'transparent',
                color: visibility === opt.value
                  ? (opt.value === 'public' ? '#4fa9ff' : opt.value === 'private' ? '#cccccc' : 'var(--accent)')
                  : 'var(--text-muted, #98a0a8)',
                border: `1px solid ${visibility === opt.value
                  ? (opt.value === 'public' ? '#4fa9ff' : opt.value === 'private' ? '#888' : 'var(--accent)')
                  : 'var(--border, #28323e)'}`,
              }}
            >
              {opt.label}
            </button>
          ))}
        </div>
        <span style={{ marginLeft: 'auto', color: 'var(--text-muted, #98a0a8)', fontSize: 12 }}>
          Showing {entities.length}{total > entities.length ? ` of ${total}` : ''} contacts
        </span>
      </div>

      {/* Star distribution summary */}
      <div style={{
        display: 'flex', gap: 8, flexWrap: 'wrap',
        marginBottom: 16, fontSize: 12,
      }}>
        {[5, 4, 3, 2, 1, 0].map((n) => (
          <span key={n} style={{
            padding: '4px 10px', borderRadius: 999,
            border: '1px solid var(--border, #28323e)',
            color: n >= 4 ? '#f0a14a' : n === 0 ? 'var(--text-muted, #98a0a8)' : 'var(--text, #e6e8eb)',
            background: 'var(--panel-2, #1b232d)',
          }}>
            {n === 0 ? 'Unrated' : `★ ${n}`}: {counts[n] ?? 0}
          </span>
        ))}
      </div>

      {error && (
        <div style={{ color: '#d9534f', padding: 12, marginBottom: 16, border: '1px solid #d9534f', borderRadius: 8 }}>
          {error}
        </div>
      )}

      {loading && entities.length === 0 ? (
        <div style={{ padding: 48, textAlign: 'center', color: 'var(--text-muted, #98a0a8)' }}>Loading contacts…</div>
      ) : entities.length === 0 ? (
        <EmptyState onRefresh={triggerSweep} />
      ) : (
        <ContactsTable
          entities={entities}
          onSetStars={onSetStars}
          visibility={visibility}
          onLinkContacts={onLinkContacts}
          onUnlinkContact={onUnlinkContact}
        />
      )}
    </div>
  );
}

function ContactsTable({ entities, onSetStars, visibility = '', onLinkContacts, onUnlinkContact }) {
  // Build a duplicate-detection index from the full list. A pair is
  // a "candidate duplicate" when they share a normalized phone OR
  // email AND they don't already share a linkedPersonId (already
  // linked rows don't need the badge). Per user 2026-05-13 settings:
  // phone-OR-email match, ask each time.
  const dupSiblings = (() => {
    const byPhone = new Map(); // phone -> [ids]
    const byEmail = new Map(); // email -> [ids]
    const norm = (s) => String(s ?? '').toLowerCase().replace(/\s/g, '');
    const normPhone = (s) => String(s ?? '').replace(/[^\d]/g, '');
    for (const e of entities) {
      if (e.email) {
        const k = norm(e.email);
        if (!byEmail.has(k)) byEmail.set(k, []);
        byEmail.get(k).push(e.id);
      }
      if (e.phone) {
        const k = normPhone(e.phone);
        if (k && !byPhone.has(k)) byPhone.set(k, []);
        if (k) byPhone.get(k).push(e.id);
      }
    }
    const sibs = new Map(); // entityId -> [other entityIds that share phone/email AND aren't in the same link group]
    const linkedGroupOf = new Map(); // entityId -> linkedPersonId|null
    for (const e of entities) linkedGroupOf.set(e.id, e.linkedPersonId ?? null);
    const consider = (group) => {
      if (!group || group.length < 2) return;
      for (const a of group) {
        for (const b of group) {
          if (a === b) continue;
          // Skip if both are already in the same link group — no need to suggest.
          const ga = linkedGroupOf.get(a);
          const gb = linkedGroupOf.get(b);
          if (ga && gb && ga === gb) continue;
          if (!sibs.has(a)) sibs.set(a, new Set());
          sibs.get(a).add(b);
        }
      }
    };
    for (const g of byPhone.values()) consider(g);
    for (const g of byEmail.values()) consider(g);
    return sibs;
  })();
  // Group entities by linkedPersonId. Rows with a shared id are
  // rendered under one collapsible header. Unlinked rows render
  // individually.
  const groups = (() => {
    const out = [];
    const seen = new Set();
    const indexByGroup = new Map();
    for (const e of entities) {
      const gid = e.linkedPersonId;
      if (!gid) continue;
      if (!indexByGroup.has(gid)) indexByGroup.set(gid, []);
      indexByGroup.get(gid).push(e);
    }
    // Preserve original order; emit group at the position of its first member.
    for (const e of entities) {
      if (seen.has(e.id)) continue;
      const gid = e.linkedPersonId;
      if (gid && indexByGroup.has(gid) && indexByGroup.get(gid).length > 1) {
        const members = indexByGroup.get(gid);
        for (const m of members) seen.add(m.id);
        out.push({ kind: 'group', linkedPersonId: gid, members });
      } else {
        seen.add(e.id);
        out.push({ kind: 'single', entity: e });
      }
    }
    return out;
  })();
  // tenantName lives in AuthContext at the app root; pull it here so the
  // tenant-shared pill renders the company display name. This nested
  // component doesn't see ContactsPage's destructured useAuth — different
  // function scope. Calling useAuth again is cheap (just consumes the
  // existing context); no extra fetch.
  const { tenantName } = useAuth();
  return (
    <div style={{
      border: '1px solid var(--border, #28323e)', borderRadius: 10,
      overflow: 'hidden', background: 'var(--panel, #141a22)',
    }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
        <thead>
          <tr style={{ background: 'var(--panel-2, #1b232d)', textAlign: 'left' }}>
            <Th>Stars</Th>
            <Th>Name</Th>
            <Th>Email / Phone</Th>
            <Th>Source</Th>
            <Th align="right">Strength</Th>
            <Th align="right">This week</Th>
            <Th>Last seen</Th>
            <Th />
          </tr>
        </thead>
        <tbody>
          {entities
            .filter((e) => {
              if (!visibility) return true;
              if (visibility === 'public') return e.scope === 'tenant';
              if (visibility === 'private') return e.scope !== 'tenant';
              return true;
            })
            .map((e) => {
            const isPrivate = e.scope !== 'tenant';
            return (
            <tr
              key={e.id}
              style={{
                borderTop: '1px solid var(--border, #28323e)',
                // Subtle muted background for Private rows so visibility
                // is immediately scannable. Per MD: Private contacts and
                // stars don't coexist — stars are a tenant-shared signal
                // that doesn't apply to personal contacts.
                background: isPrivate ? 'rgba(155,155,155,0.04)' : 'transparent',
              }}
            >
              <Td>
                {isPrivate ? (
                  <span
                    style={{ color: 'var(--text-muted, #98a0a8)', fontSize: 14, cursor: 'help' }}
                    title="Private contacts can't be starred. Stars are a tenant-shared signal; make this contact Public to rate them."
                  >
                    🔒
                  </span>
                ) : (
                  <StarRating value={e.stars ?? 0} onChange={(s) => onSetStars(e.id, s)} />
                )}
              </Td>
              <Td>
                <EditableName
                  id={e.id}
                  title={e.title}
                  bold={!isPrivate && e.stars >= 4}
                />
                {e.scope === 'tenant' ? (
                  <span
                    style={pillStyle('#4fa9ff', 'rgba(79,169,255,0.12)')}
                    title="Public — visible to every user in your tenant"
                  >
                    🌐 Public
                  </span>
                ) : (
                  <span
                    style={pillStyle('#9b9b9b', 'rgba(155,155,155,0.10)')}
                    title="Private — only you can see this contact. Not in tenant wiki, not in shared search."
                  >
                    🔒 Private
                  </span>
                )}
                {/* Linked-group pill — shown when this row is part of a
                    multi-identifier person (work email + personal email
                    + phone all linked under one linkedPersonId). */}
                {e.linkedPersonId && (
                  <span
                    style={pillStyle('#a78bfa', 'rgba(167,139,250,0.14)')}
                    title="Linked to other identifiers under one person — Brain treats these as the same contact"
                  >
                    🔗 Linked
                  </span>
                )}
                {/* Possible-duplicate hint — shown when this row shares a
                    phone or email with another UNLINKED row. Click to
                    link them as the same person (each row keeps its
                    own scope/stars). */}
                {(!e.linkedPersonId) && dupSiblings.has(e.id) && (() => {
                  const sibIds = Array.from(dupSiblings.get(e.id));
                  const sibTitles = sibIds
                    .map((sid) => entities.find((x) => x.id === sid)?.title)
                    .filter(Boolean)
                    .slice(0, 2);
                  return (
                    <button
                      type="button"
                      onClick={() => onLinkContacts?.([e.id, ...sibIds])}
                      style={{
                        ...pillStyle('#f59e0b', 'rgba(245,158,11,0.14)'),
                        cursor: 'pointer',
                        border: '1px solid rgba(245,158,11,0.4)',
                      }}
                      title={`Same identifier as: ${sibTitles.join(', ')}${sibIds.length > sibTitles.length ? ` (+${sibIds.length - sibTitles.length})` : ''}. Click to link them as one person.`}
                    >
                      ⚠ Same as {sibTitles[0] || 'another'} — Link
                    </button>
                  );
                })()}
              </Td>
              <Td>
                <span style={{ color: 'var(--text-muted, #98a0a8)' }}>
                  {e.email ?? e.phone ?? '—'}
                </span>
              </Td>
              <Td>
                <SourcePill source={e.importedFrom} channels={e.channels} />
              </Td>
              <Td align="right">
                {e.relationshipStrength != null
                  ? <span>{Math.round(e.relationshipStrength * 100)}%</span>
                  : <span style={{ color: 'var(--text-muted, #98a0a8)' }}>—</span>}
              </Td>
              <Td align="right">{e.weeklyVolume ?? 0}</Td>
              <Td>
                <span style={{ color: 'var(--text-muted, #98a0a8)' }}>
                  {fmtRelative(e.lastSeen ?? e.lastUpdatedAt)}
                </span>
              </Td>
              <Td>
                <div style={{ display: 'inline-flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                  {/* Public/Private toggle — owner-only. Default for
                      every auto-discovered contact is private (user
                      scope). User explicitly publishes a contact to
                      make it visible across the tenant. */}
                  {e.isOwner && (
                    <PublishButton
                      id={e.id}
                      isPublic={e.scope === 'tenant'}
                    />
                  )}
                  {/* Unlink — only visible on linked rows; lets the
                      user split a wrongly-merged identifier back out
                      from its person group. The remaining group rows
                      stay linked to each other. */}
                  {e.isOwner && e.linkedPersonId && onUnlinkContact && (
                    <button
                      type="button"
                      onClick={() => onUnlinkContact(e.id)}
                      style={{
                        padding: '4px 8px',
                        borderRadius: 6,
                        background: 'transparent',
                        color: 'var(--text-muted, #98a0a8)',
                        border: '1px solid var(--border, #28323e)',
                        cursor: 'pointer',
                        fontSize: 12,
                      }}
                      title="Remove this identifier from its linked-person group"
                    >
                      Unlink
                    </button>
                  )}
                  <InactiveButton id={e.id} title={e.title} />
                </div>
              </Td>
            </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/**
 * PublishButton — owner-only toggle between private and tenant-public
 * scope on a single contact. Default for all auto-discovered contacts
 * is private; the owner clicks "Make Public" to share with their
 * tenant. Click again ("Make Private") to revoke.
 *
 * Per user 2026-05-11: contacts default to private. Public is
 * always an explicit user action.
 */
function PublishButton({ id, isPublic }) {
  const [busy, setBusy] = useState(false);
  if (busy) {
    return <span style={{ color: 'var(--text-muted, #98a0a8)', fontSize: 11 }}>…</span>;
  }
  const flip = async () => {
    setBusy(true);
    try {
      const path = isPublic ? 'unpublish' : 'publish';
      const res = await fetch(`/api/v1/entity-catalog/${id}/${path}`, {
        method: 'PATCH', credentials: 'include',
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        alert(err.error || `Failed to ${path}`);
      } else {
        // Tell the parent to refetch the list. Simplest: dispatch a
        // custom event the ContactsPage useEffect listens to. If the
        // parent doesn't listen, the row will update on next natural
        // refresh.
        window.dispatchEvent(new CustomEvent('contacts:reload'));
      }
    } finally {
      setBusy(false);
    }
  };
  return (
    <button
      type="button"
      onClick={flip}
      title={isPublic
        ? 'This contact is visible to your whole tenant. Click to make it private again.'
        : 'Make this contact visible to every user in your tenant.'}
      style={{
        background: isPublic ? 'rgba(79,169,255,0.10)' : 'transparent',
        border: `1px solid ${isPublic ? 'rgba(79,169,255,0.45)' : 'var(--border, #444)'}`,
        color: isPublic ? '#4fa9ff' : 'var(--text-muted, #98a0a8)',
        padding: '3px 9px', borderRadius: 4, cursor: 'pointer',
        fontSize: 11, whiteSpace: 'nowrap',
      }}
    >
      {isPublic ? 'Make Private' : 'Make Public'}
    </button>
  );
}

// "Mark inactive" — confirm-then-archive button. Two-step UX so an
// accidental click can't hide a real contact. After archive, the row
// disappears from the list (re-fetched by parent on success).
function InactiveButton({ id, title }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  if (busy) {
    return <span style={{ color: 'var(--text-muted, #98a0a8)', fontSize: 11 }}>marking…</span>;
  }
  if (confirming) {
    return (
      <span style={{ display: 'inline-flex', gap: 4 }}>
        <button
          type="button"
          onClick={async () => {
            setBusy(true);
            try {
              await api.patch(`/entity-catalog/${id}/inactive`);
              window.dispatchEvent(new CustomEvent('contacts:reload'));
            } catch { setBusy(false); setConfirming(false); }
          }}
          style={{ background: 'rgba(239,68,68,0.15)', border: '1px solid rgba(239,68,68,0.5)', color: '#fca5a5', padding: '2px 8px', fontSize: 11, borderRadius: 4, cursor: 'pointer' }}
          title={`Mark "${title}" inactive — Brain will not re-create it from feed events`}
        >Confirm</button>
        <button
          type="button"
          onClick={() => setConfirming(false)}
          style={{ background: 'transparent', border: '1px solid var(--border, #28323e)', color: 'var(--text-muted, #98a0a8)', padding: '2px 8px', fontSize: 11, borderRadius: 4, cursor: 'pointer' }}
        >Cancel</button>
      </span>
    );
  }
  return (
    <button
      type="button"
      onClick={() => setConfirming(true)}
      style={{ background: 'transparent', border: '1px solid var(--border, #28323e)', color: 'var(--text-muted, #98a0a8)', padding: '2px 8px', fontSize: 11, borderRadius: 4, cursor: 'pointer' }}
      title="Mark inactive — Brain will not re-create this contact from feed events. Reversible."
    >Mark inactive</button>
  );
}

// EditableName — name as a Link by default; on pencil click, swap to an
// inline input. Save calls PATCH /entity-catalog/:id/rename, which sets
// metadata.userRenamed=true so feed ingest can never overwrite the user's
// chosen name. Esc cancels, Enter saves.
function EditableName({ id, title, bold }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef(null);

  useEffect(() => { setDraft(title); }, [title]);
  useEffect(() => { if (editing && inputRef.current) inputRef.current.select(); }, [editing]);

  const save = async () => {
    const next = draft.trim();
    if (!next || next === title) { setEditing(false); setDraft(title); return; }
    setBusy(true);
    try {
      await api.patch(`/entity-catalog/${id}/rename`, { name: next });
      window.dispatchEvent(new CustomEvent('contacts:reload'));
      setEditing(false);
    } catch {
      setBusy(false);
    }
  };

  if (editing) {
    return (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
        <input
          ref={inputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); save(); }
            if (e.key === 'Escape') { e.preventDefault(); setEditing(false); setDraft(title); }
          }}
          maxLength={280}
          disabled={busy}
          style={{
            background: 'var(--bg-2, #0f1418)',
            border: '1px solid var(--accent, #d66d3c)',
            color: 'var(--text, #e6e8eb)',
            padding: '2px 6px',
            fontSize: 13,
            borderRadius: 4,
            minWidth: 200,
          }}
        />
        <button
          type="button"
          onClick={save}
          disabled={busy}
          style={{ background: 'var(--accent, #d66d3c)', color: '#fff', border: 0, padding: '2px 8px', fontSize: 11, borderRadius: 4, cursor: 'pointer' }}
        >{busy ? '…' : 'Save'}</button>
        <button
          type="button"
          onClick={() => { setEditing(false); setDraft(title); }}
          disabled={busy}
          style={{ background: 'transparent', border: '1px solid var(--border, #28323e)', color: 'var(--text-muted, #98a0a8)', padding: '2px 8px', fontSize: 11, borderRadius: 4, cursor: 'pointer' }}
        >Cancel</button>
      </span>
    );
  }

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }} className="ui-editable-name">
      <Link
        to={`/contacts/${encodeURIComponent(id)}`}
        style={{ color: 'var(--text, #e6e8eb)', textDecoration: 'none', fontWeight: bold ? 600 : 400 }}
      >
        {title}
      </Link>
      <button
        type="button"
        onClick={(e) => { e.preventDefault(); setEditing(true); }}
        aria-label="Rename contact"
        title="Rename contact"
        style={{
          background: 'transparent', border: 0, padding: 2, cursor: 'pointer',
          color: 'var(--text-muted, #98a0a8)', display: 'inline-flex', alignItems: 'center',
          opacity: 0.5, transition: 'opacity 120ms',
        }}
        onMouseEnter={(e) => { e.currentTarget.style.opacity = 1; }}
        onMouseLeave={(e) => { e.currentTarget.style.opacity = 0.5; }}
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 20h9" />
          <path d="M16.5 3.5a2.121 2.121 0 1 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
        </svg>
      </button>
    </span>
  );
}

function StarRating({ value, onChange }) {
  const [hover, setHover] = useState(0);
  const display = hover || value;
  return (
    <div
      role="radiogroup"
      aria-label={`Importance: ${value} of 5 stars`}
      style={{ display: 'inline-flex', gap: 2 }}
      onMouseLeave={() => setHover(0)}
    >
      {[1, 2, 3, 4, 5].map((n) => {
        const isFilled = n <= display;
        const isCurrent = n === value;
        return (
          <button
            key={n}
            role="radio"
            aria-checked={isCurrent}
            aria-label={`${n} star${n === 1 ? '' : 's'}`}
            onMouseEnter={() => setHover(n)}
            onClick={(e) => {
              e.preventDefault();
              // Click same star to clear (toggle off)
              onChange(n === value ? 0 : n);
            }}
            style={{
              background: 'transparent', border: 0, padding: '2px 1px',
              cursor: 'pointer', fontSize: 16, lineHeight: 1,
              color: isFilled ? '#f0a14a' : 'var(--border, #3a4452)',
              transition: 'transform 80ms',
              transform: hover === n ? 'scale(1.15)' : 'scale(1)',
            }}
          >
            {isFilled ? '★' : '☆'}
          </button>
        );
      })}
    </div>
  );
}

// Source pill — for explicit imports (manual/google/MS/odoo) we show the
// import label. For auto-discovered contacts we show the actual feed
// channel(s) — gmail, whatsapp, gcal, slack, etc. Multi-channel senders
// (someone who emails AND whatsapps) get multiple chips.
function SourcePill({ source, channels = [] }) {
  const importMap = {
    manual:             { label: 'Manual',    bg: 'rgba(240,161,74,0.18)',  fg: '#f0a14a' },
    google_contacts:    { label: 'Google',    bg: 'rgba(76,175,80,0.18)',   fg: '#5fbe61' },
    microsoft_contacts: { label: 'Outlook',   bg: 'rgba(0,120,212,0.20)',   fg: '#3fa3e8' },
    odoo_mirror:        { label: 'Odoo',      bg: 'rgba(160,40,160,0.18)',  fg: '#c971c9' },
  };
  // Explicit imports always show their label first (they were intentional).
  if (importMap[source]) {
    const cfg = importMap[source];
    return <span style={pillStyle(cfg.fg, cfg.bg, 'inline')}>{cfg.label}</span>;
  }
  // Auto-discovered → show channel(s). Empty channels = older row that
  // hasn't been seen since the channel-tracking landed.
  const channelMap = {
    gmail:             { label: 'Gmail',     bg: 'rgba(217,83,79,0.16)',   fg: '#e87574' },
    outlook:           { label: 'Outlook',   bg: 'rgba(0,120,212,0.20)',   fg: '#3fa3e8' },
    whatsapp:          { label: 'WhatsApp',  bg: 'rgba(37,211,102,0.18)',  fg: '#3fc97e' },
    gcal:              { label: 'Cal',       bg: 'rgba(160,131,231,0.20)', fg: '#a684ff' },
    outlook_calendar:  { label: 'Outlook Cal', bg: 'rgba(0,120,212,0.18)', fg: '#3fa3e8' },
    gchat:             { label: 'GChat',     bg: 'rgba(76,175,80,0.18)',   fg: '#5fbe61' },
    slack:             { label: 'Slack',     bg: 'rgba(154,73,170,0.20)',  fg: '#c075d8' },
    ms_teams:          { label: 'Teams',     bg: 'rgba(98,100,167,0.22)',  fg: '#8b8df0' },
    onedrive_personal: { label: 'OneDrive',  bg: 'rgba(0,120,212,0.16)',   fg: '#3fa3e8' },
    gtasks:            { label: 'Tasks',     bg: 'rgba(76,175,80,0.18)',   fg: '#5fbe61' },
    crm:               { label: 'CRM',       bg: 'rgba(160,40,160,0.18)',  fg: '#c971c9' },
    manual:            { label: 'Manual',    bg: 'rgba(240,161,74,0.18)',  fg: '#f0a14a' },
  };
  if (channels.length === 0) {
    return <span style={pillStyle('#98a0a8', 'rgba(152,160,168,0.15)', 'inline')}>Auto</span>;
  }
  return (
    <span style={{ display: 'inline-flex', gap: 4, flexWrap: 'wrap' }}>
      {channels.slice(0, 3).map((c) => {
        const cfg = channelMap[c] ?? { label: c, bg: 'rgba(152,160,168,0.15)', fg: '#98a0a8' };
        return <span key={c} style={pillStyle(cfg.fg, cfg.bg, 'inline')}>{cfg.label}</span>;
      })}
      {channels.length > 3 && (
        <span style={pillStyle('#98a0a8', 'rgba(152,160,168,0.15)', 'inline')}>+{channels.length - 3}</span>
      )}
    </span>
  );
}

function EmptyState({ onRefresh }) {
  return (
    <div style={{
      padding: 64, textAlign: 'center',
      border: '1px dashed var(--border, #28323e)', borderRadius: 10,
      background: 'var(--panel, #141a22)',
    }}>
      <h3 style={{ margin: 0, fontSize: 16 }}>No contacts yet</h3>
      <p style={{ color: 'var(--text-muted, #98a0a8)', maxWidth: 460, margin: '12px auto' }}>
        Brain auto-discovers contacts from your feed (emails, WhatsApp, calendar). Once messages start flowing,
        people will appear here. You can also click <em>Refresh from feed</em> to sweep now.
      </p>
      <button onClick={onRefresh} style={btnStyle(false)}>Refresh from feed</button>
    </div>
  );
}

// ─── helpers + small primitives ──────────────────────────────────

function Th({ children, align = 'left' }) {
  return (
    <th style={{
      padding: '10px 12px', fontWeight: 500, textAlign: align,
      color: 'var(--text-muted, #98a0a8)', fontSize: 12,
      textTransform: 'uppercase', letterSpacing: '.5px',
    }}>{children}</th>
  );
}
function Td({ children, align = 'left' }) {
  return <td style={{ padding: '10px 12px', textAlign: align, verticalAlign: 'middle' }}>{children}</td>;
}

function pillStyle(fg, bg, layout = 'spaced') {
  return {
    display: 'inline-block', padding: '1px 8px',
    fontSize: 11, borderRadius: 999, background: bg, color: fg,
    verticalAlign: 'middle', fontWeight: 500,
    ...(layout === 'spaced' ? { marginLeft: 8 } : {}),
  };
}
const inputStyle = {
  flex: '1 1 200px', minWidth: 200,
  background: 'var(--panel-2, #1b232d)', color: 'var(--text, #e6e8eb)',
  border: '1px solid var(--border, #28323e)', borderRadius: 6,
  padding: '6px 10px', fontSize: 13,
};
const selectStyle = {
  background: 'var(--panel-2, #1b232d)', color: 'var(--text, #e6e8eb)',
  border: '1px solid var(--border, #28323e)', borderRadius: 6,
  padding: '6px 10px', fontSize: 13, cursor: 'pointer',
};
function btnStyle(disabled, variant = 'primary') {
  if (variant === 'subtle') {
    return {
      background: 'var(--panel-2, #1b232d)',
      color: disabled ? 'var(--text-muted, #98a0a8)' : 'var(--text, #e6e8eb)',
      border: '1px solid var(--border, #28323e)',
      borderRadius: 6,
      padding: '8px 14px', fontSize: 13,
      cursor: disabled ? 'not-allowed' : 'pointer',
      fontWeight: 500,
    };
  }
  return {
    background: disabled ? 'var(--panel-2, #1b232d)' : 'var(--accent, #4fa9ff)',
    color: disabled ? 'var(--text-muted, #98a0a8)' : '#0e1116',
    border: 'none', borderRadius: 6,
    padding: '8px 14px', fontSize: 13,
    cursor: disabled ? 'not-allowed' : 'pointer',
    fontWeight: 500,
  };
}

function AddContactModal({ isAdmin, onClose, onSaved, notify }) {
  const [form, setForm] = useState({
    name: '', email: '', phone: '', role: '', organization: '', notes: '',
    forceTenantShared: false,
  });
  const [saving, setSaving] = useState(false);
  // Inline form error stays inline (not a toast) — that's normal form
  // validation feedback, the no-dialogs rule is specifically about
  // alert/prompt/confirm popups. We just don't use those.
  const [error, setError] = useState(null);

  const upd = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const onSubmit = async (e) => {
    e.preventDefault();
    setError(null);
    if (!form.name.trim()) { setError('Name is required.'); return; }
    if (!form.email.trim() && !form.phone.trim()) {
      setError('Email or phone is required.');
      return;
    }
    setSaving(true);
    try {
      await api.post('/entity-catalog/manual', {
        name: form.name.trim(),
        email: form.email.trim() || null,
        phone: form.phone.trim() || null,
        role: form.role.trim() || null,
        organization: form.organization.trim() || null,
        notes: form.notes.trim() || null,
        forceTenantShared: isAdmin && form.forceTenantShared,
      });
      onSaved(`Added ${form.name.trim()}.`);
    } catch (err) {
      const msg = err.response?.data?.error ?? err.message;
      setError(msg);
      if (notify) notify('error', `Couldn't add contact: ${msg}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        zIndex: 100, padding: 16,
      }}
    >
      <form
        onClick={(e) => e.stopPropagation()}
        onSubmit={onSubmit}
        style={{
          background: 'var(--panel, #141a22)', color: 'var(--text, #e6e8eb)',
          border: '1px solid var(--border, #28323e)', borderRadius: 12,
          padding: 24, width: '100%', maxWidth: 520,
          boxShadow: '0 20px 60px rgba(0,0,0,0.5)',
        }}
      >
        <h2 style={{ margin: '0 0 4px', fontSize: 18 }}>Add contact</h2>
        <p style={{ color: 'var(--text-muted, #98a0a8)', fontSize: 12, margin: '0 0 18px' }}>
          Brain will create a canonical page for this person. Stars + recent activity get
          attached automatically as messages flow in.
        </p>

        {error && (
          <div style={{ background: 'rgba(217,83,79,0.12)', border: '1px solid #d9534f', color: '#ff8a87', padding: '8px 12px', borderRadius: 6, marginBottom: 12, fontSize: 13 }}>
            {error}
          </div>
        )}

        <FormField label="Name" required>
          <input value={form.name} onChange={upd('name')} style={modalInputStyle} placeholder="Faisal Hassan" autoFocus />
        </FormField>
        <FormField label="Email">
          <input type="email" value={form.email} onChange={upd('email')} style={modalInputStyle} placeholder="faisal@partner.com" />
        </FormField>
        <FormField label="Phone (WhatsApp)">
          <input type="tel" value={form.phone} onChange={upd('phone')} style={modalInputStyle} placeholder="+92 300 1234567" />
        </FormField>
        <div style={{ display: 'flex', gap: 12 }}>
          <div style={{ flex: 1 }}>
            <FormField label="Role">
              <input value={form.role} onChange={upd('role')} style={modalInputStyle} placeholder="CFO" />
            </FormField>
          </div>
          <div style={{ flex: 1 }}>
            <FormField label="Organization">
              <input value={form.organization} onChange={upd('organization')} style={modalInputStyle} placeholder="Partner Inc" />
            </FormField>
          </div>
        </div>
        <FormField label="Notes">
          <textarea value={form.notes} onChange={upd('notes')} style={{ ...modalInputStyle, minHeight: 60, resize: 'vertical' }} placeholder="Anything Brain should know…" />
        </FormField>

        {isAdmin && (
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8, fontSize: 13, color: 'var(--text-muted, #98a0a8)' }}>
            <input
              type="checkbox"
              checked={form.forceTenantShared}
              onChange={(e) => setForm((f) => ({ ...f, forceTenantShared: e.target.checked }))}
            />
            Make tenant-shared (visible to every user in this tenant)
          </label>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 20 }}>
          <button type="button" onClick={onClose} style={btnStyle(false, 'subtle')}>Cancel</button>
          <button type="submit" disabled={saving} style={btnStyle(saving)}>
            {saving ? 'Saving…' : 'Add contact'}
          </button>
        </div>
      </form>
    </div>
  );
}

function FormField({ label, required, children }) {
  return (
    <label style={{ display: 'block', marginBottom: 12 }}>
      <span style={{ display: 'block', fontSize: 12, color: 'var(--text-muted, #98a0a8)', marginBottom: 4 }}>
        {label}{required ? ' *' : ''}
      </span>
      {children}
    </label>
  );
}

const modalInputStyle = {
  width: '100%', boxSizing: 'border-box',
  background: 'var(--panel-2, #1b232d)', color: 'var(--text, #e6e8eb)',
  border: '1px solid var(--border, #28323e)', borderRadius: 6,
  padding: '8px 10px', fontSize: 14,
  fontFamily: 'inherit',
};

/**
 * Inline toast stack — replaces every browser alert() on this page.
 * Per the no-dialogs rule: feedback is a non-blocking, dismissible
 * banner that doesn't yank focus or interrupt typing. Bottom-right
 * stack, click to dismiss, auto-dismiss after 6s.
 */
function ToastStack({ toasts, onDismiss }) {
  if (!toasts.length) return null;
  return (
    <div style={{
      position: 'fixed', bottom: 24, right: 24, zIndex: 90,
      display: 'flex', flexDirection: 'column', gap: 8,
      maxWidth: 'min(420px, calc(100vw - 48px))',
    }}>
      {toasts.map((t) => {
        const palette = {
          ok:    { bg: 'rgba(76,175,80,0.18)',  border: '#4caf50', fg: '#9bd9a0' },
          warn:  { bg: 'rgba(240,161,74,0.18)', border: '#f0a14a', fg: '#f4c594' },
          error: { bg: 'rgba(217,83,79,0.20)',  border: '#d9534f', fg: '#f0a3a0' },
        }[t.kind] ?? { bg: 'rgba(79,169,255,0.16)', border: '#4fa9ff', fg: '#a8d0fc' };
        return (
          <button
            key={t.id}
            onClick={() => onDismiss(t.id)}
            style={{
              background: palette.bg,
              border: `1px solid ${palette.border}`,
              color: palette.fg,
              padding: '10px 14px', borderRadius: 8,
              fontSize: 13, lineHeight: 1.4,
              textAlign: 'left', cursor: 'pointer',
              boxShadow: '0 6px 20px rgba(0,0,0,0.35)',
              animation: 'toastIn 180ms ease-out',
            }}
            aria-live="polite"
          >
            {t.text}
          </button>
        );
      })}
      <style>{`@keyframes toastIn { from { opacity: 0; transform: translateY(8px) } to { opacity: 1; transform: none } }`}</style>
    </div>
  );
}

function fmtRelative(iso) {
  if (!iso) return '—';
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return '—';
  const diffMs = Date.now() - t;
  const days = Math.floor(diffMs / 86400000);
  if (days === 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days}d ago`;
  if (days < 30) return `${Math.floor(days / 7)}w ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return new Date(iso).toLocaleDateString();
}
