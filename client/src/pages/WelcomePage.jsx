/**
 * WelcomePage — first-run walkthrough for new Nexeo users.
 *
 * Reachable at /welcome and via a "Welcome / Get started" entry on the
 * Settings page. NOT in the rail — the rail is for daily work, this
 * is one-time orientation. Users who land on Day Brief without ever
 * having opened the walkthrough see a small dismissable banner that
 * deep-links here.
 *
 * Content is structured as numbered cards rather than a scrolling
 * essay — the reader can skim, jump to the section that's relevant
 * to them, and close. Each card focuses on ONE concept the user has
 * to internalise.
 */
import { useNavigate } from 'react-router-dom';
import { useEffect } from 'react';

const COL = {
  bg: 'var(--bg-1)',
  card: 'var(--bg-2)',
  border: 'var(--border)',
  text: 'var(--text)',
  muted: 'var(--text-muted)',
  dim: 'var(--text-dim)',
  accent: 'var(--accent)',
  star: '#f0a574',
};

export default function WelcomePage() {
  const navigate = useNavigate();

  // Stamp localStorage so the Day Brief banner can hide itself once
  // the user has visited at least once.
  useEffect(() => {
    try { localStorage.setItem('nexeo:walkthrough_seen', '1'); } catch {}
  }, []);

  return (
    <div style={{ height: '100vh', overflowY: 'auto', background: COL.bg }}>
      <div style={{ maxWidth: 880, margin: '0 auto', padding: '40px 28px 80px' }}>

        <Header onClose={() => navigate('/?tab=brief')} />

        <Hero />

        <Step n={1} title="Set up — 3 minutes" lead="Once. Then Nexeo runs in the background.">
          <SubStep label="Connect your accounts">
            On the <em>Connectors</em> tab, click <strong>Connect</strong> for Gmail, Google Calendar, and WhatsApp. You'll be redirected to Google / Meta to grant access; come back and the connector flips to <Pill color="#4ade80">Live</Pill>.
            <Tip>Until WhatsApp is paired, Nexeo has no outbound channel. Day Brief still works in the browser — you just won't get proactive pings.</Tip>
          </SubStep>
          <SubStep label="Set quiet hours + language">
            <em>Settings → Brain notifications</em>. Default quiet hours respect 22:00–06:00. Language is auto-detected from your contact number ({'+92'} → Urdu) and overridable.
          </SubStep>
          <SubStep label="Star your most important contacts">
            <em>Contacts</em> tab. Star ratings tell Nexeo how aggressively to ping you when those people email. <strong>This is the single most valuable thing you do here.</strong> See Step 4 for what each tier means.
          </SubStep>
        </Step>

        <Step n={2} title="The four surfaces" lead="Everything Nexeo does for you lives in one of these four places.">
          <SurfaceCard
            icon="☀️" name="Day Brief"
            what="Your morning page. Risk Radar, attention queue, what Brain handled overnight."
            do_="Open this first thing. Click an action on each item until the queue is clean."
          />
          <SurfaceCard
            icon="▦" name="Action Center (Open Items)"
            what="Every item Nexeo is tracking. Filter by status / priority / source."
            do_={(<>Use ✓ Done when you finished the work; ✕ Wrong when an item shouldn't have existed; Snooze when you'll come back to it.</>)}
          />
          <SurfaceCard
            icon="👥" name="Contacts"
            what="Every person Nexeo has seen. Auto-built from your email and calendar."
            do_="Star the people who matter. Mark inactive anyone you don't want Nexeo to track."
          />
          <SurfaceCard
            icon="💬" name="Nexeo Chat"
            what="The orange brain dock at the bottom-right of Day Brief. Ask anything."
            do_={(<>Try: <em>"What's on my plate today?"</em> · <em>"Draft a reply to the Day-9 thread"</em> · <em>"How does the star cadence work?"</em></>)}
          />
        </Step>

        <Step n={3} title="Star ratings = how Nexeo notifies you" lead="The single dial that controls how aggressively Nexeo pings you about each contact.">
          <table style={tableStyle}>
            <thead>
              <tr>
                <Th>★</Th><Th>Status</Th><Th>When their email arrives</Th>
              </tr>
            </thead>
            <tbody>
              <Row stars={0} status="Unrated" body="Normal triage. No proactive ping. Item still appears in Day Brief." />
              <Row stars={1} status="Light" body="One WhatsApp text after 48h if you haven't acted." />
              <Row stars={2} status="Light" body="One WhatsApp text after 24h if you haven't acted." />
              <Row stars={3} status="Important" body="WhatsApp text immediately, repeats every 4h until you act. Cap: 3 pings." />
              <Row stars={4} status="High" body="WhatsApp voicenote immediately, plus text follow-up at +2h. Cap: 2 pings." />
              <Row stars={5} status="Top critical" body={<><strong>Voice call</strong> immediately + voicenote at +30 min + text at +2h. <strong>Bypasses quiet hours.</strong></>} />
            </tbody>
          </table>
          <Tip>
            Nexeo skips the ping if the message looks like FYI / "thanks" / auto-reply / calendar invite — even from a 5★ sender. Stars don't override <strong>content judgment</strong>.
          </Tip>
        </Step>

        <Step n={4} title="WhatsApp goes both ways" lead="Nexeo messages you. You message back. Specific phrases do specific things.">
          <Two>
            <Half title="What Nexeo sends">
              <ul style={ulStyle}>
                <li><strong>Critical bundles</strong> — once per fingerprint per ~5 min</li>
                <li><strong>Star-cadence pings</strong> — per Step 3</li>
                <li><strong>Producer prompts</strong> — "When do you want X done by?"</li>
                <li><strong>Delegatee replies</strong> — "Asad confirmed Friday for the deck"</li>
              </ul>
            </Half>
            <Half title="What you can say back">
              <ul style={ulStyle}>
                <li><em>tomorrow</em> / <em>friday</em> / <em>in 5 days</em> / <em>2026-12-31</em> — date answers</li>
                <li><em>Asad Khan</em> / <em>asad@…</em> — owner answers</li>
                <li><em>"shouldn't be"</em> / <em>"stop"</em> / <em>"don't care"</em> — pushback (silences for 24h + teaches)</li>
                <li>Anything else — chat with Nexeo in your language</li>
              </ul>
            </Half>
          </Two>
        </Step>

        <Step n={5} title="The 3 actions on every item" lead="Three buttons, three different signals.">
          <ActionRow color="#4ade80" symbol="✓" name="Done"
            meaning="I completed this work."
            signal="Positive: this kind of item is real and useful." />
          <ActionRow color="#f59e0b" symbol="⏸" name="Snooze"
            meaning="Not now, ask me later."
            signal="Neutral: defer without judgment." />
          <ActionRow color="#ef4444" symbol="✕" name="Wrong"
            meaning="This row should never have existed."
            signal="Negative: don't create these. After 3 from the same sender + topic in 14 days, Nexeo stops creating future ones automatically." />
          <Tip>
            That last one is powerful. If the same vendor advisory keeps showing up, click ✕ Wrong on three of them and you'll never see it again.
          </Tip>
        </Step>

        <Step n={6} title="Two superpowers most users miss" lead="Things that pay off after a few weeks of use.">
          <SubStep label="Standing instructions in plain English">
            <em>My Rules → Standing Instructions</em>. Type what you want Nexeo to always do:
            <Quote>"Always delegate Raazia's emails to Asad."</Quote>
            <Quote>"When CBL emails about pricing, draft a reply with the standard rate card and CC Yousuf."</Quote>
            <Quote>"Alert me if anyone mentions 'lawsuit' or 'breach'."</Quote>
            Nexeo parses each into a structured rule and respects it on every relevant turn.
          </SubStep>
          <SubStep label="The 👍 / 👎 loop">
            Every chat answer has thumbs. Click them. After ≥2 high-confidence 👎 in 14 days on the same kind of mistake, Nexeo auto-promotes a permanent rule into your <em>Learned Preferences</em> — see it on My Rules.
          </SubStep>
        </Step>

        <Step n={7} title="Safety nets" lead="If anything ever feels off, you have one-click control.">
          <ul style={ulStyle}>
            <li><strong>Pause Brain on WhatsApp</strong> — Settings → Brain notifications → Safety. Single checkbox; flip on, all WhatsApp output stops immediately.</li>
            <li><strong>Daily message cap</strong> — same panel. Hard ceiling on outbound (default 20). Even a runaway bug can't exceed it.</li>
            <li><strong>Smart cleanup</strong> — Action Center top-right. Closes stale + duplicate items in bulk with a preview before applying.</li>
            <li><strong>Mark inactive</strong> on Contacts — soft-delete a contact; Nexeo never re-creates them from feed events.</li>
          </ul>
        </Step>

        <Step n={8} title="When you're ready for more" lead="Two pages that explain Nexeo deeper.">
          <ul style={ulStyle}>
            <li><Anchor onClick={() => navigate('/how-it-works')}>How Nexeo Works</Anchor> — full architecture: triage, criticality engine, learning loops, self-rebuild spectrum.</li>
            <li><Anchor onClick={() => navigate('/?tab=rules')}>My Rules</Anchor> — every place you steer Nexeo: standing instructions, learned preferences, patterns, risk radar, decisions, delegations.</li>
          </ul>
        </Step>

        <FooterCTA onClose={() => navigate('/?tab=brief')} />
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────── */

function Header({ onClose }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <img src="/nexeo-logo.jpeg" alt="Nexeo" width={40} height={40}
             style={{ borderRadius: 8, objectFit: 'cover' }}
             onError={(e) => { e.currentTarget.style.display = 'none'; }} />
        <span style={{ fontSize: 14, color: COL.muted }}>Get started</span>
      </div>
      <button onClick={onClose}
              style={{ background: 'transparent', border: `1px solid ${COL.border}`, color: COL.muted, padding: '6px 14px', borderRadius: 6, cursor: 'pointer', fontSize: 13 }}>
        Skip · Open Day Brief →
      </button>
    </div>
  );
}

function Hero() {
  return (
    <div style={{ marginBottom: 36 }}>
      <h1 style={{ margin: 0, fontSize: 36, fontWeight: 700, letterSpacing: -0.6, color: COL.text }}>
        Welcome to Nexeo.
      </h1>
      <p style={{ marginTop: 12, fontSize: 17, lineHeight: 1.55, color: COL.muted, maxWidth: 640 }}>
        Your AI executive assistant for email, WhatsApp, calendar, and the chaos in between.
        Nexeo watches the noise so you don't have to, decides what actually needs you,
        and reaches you on WhatsApp when something matters — in your language.
      </p>
      <p style={{ marginTop: 8, fontSize: 14, color: COL.dim, maxWidth: 640 }}>
        This walkthrough takes about 5 minutes. Skim it once; the things you internalise here
        will pay back every day.
      </p>
    </div>
  );
}

function Step({ n, title, lead, children }) {
  return (
    <section style={{
      background: COL.card,
      border: `1px solid ${COL.border}`,
      borderRadius: 14,
      padding: '22px 26px',
      marginBottom: 18,
    }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 14, marginBottom: 4 }}>
        <span style={{
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          width: 32, height: 32, borderRadius: '50%',
          background: 'rgba(214,109,60,0.12)', color: COL.accent,
          fontSize: 14, fontWeight: 700, flexShrink: 0,
        }}>{n}</span>
        <h2 style={{ margin: 0, fontSize: 22, fontWeight: 600, color: COL.text }}>{title}</h2>
      </div>
      {lead && <p style={{ margin: '4px 0 14px 46px', color: COL.muted, fontSize: 14 }}>{lead}</p>}
      <div style={{ marginLeft: 46 }}>{children}</div>
    </section>
  );
}

function SubStep({ label, children }) {
  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ fontSize: 14, fontWeight: 600, color: COL.text, marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 14, lineHeight: 1.6, color: COL.muted }}>{children}</div>
    </div>
  );
}

function SurfaceCard({ icon, name, what, do_ }) {
  return (
    <div style={{
      display: 'grid', gridTemplateColumns: '40px 1fr', gap: 14,
      padding: '12px 14px', marginBottom: 10,
      background: 'rgba(255,255,255,0.02)', border: `1px solid ${COL.border}`, borderRadius: 8,
    }}>
      <div style={{ fontSize: 22, lineHeight: '24px' }}>{icon}</div>
      <div>
        <div style={{ fontSize: 14, fontWeight: 600, color: COL.text }}>{name}</div>
        <div style={{ fontSize: 13, color: COL.muted, marginTop: 2 }}>{what}</div>
        <div style={{ fontSize: 13, color: COL.text, marginTop: 6 }}><strong>What to do:</strong> {do_}</div>
      </div>
    </div>
  );
}

function Row({ stars, status, body }) {
  return (
    <tr style={{ borderTop: `1px solid ${COL.border}` }}>
      <td style={tdStyle}>
        {stars > 0 ? (
          <span style={{ color: stars >= 4 ? COL.star : COL.text }}>{'★'.repeat(stars)}</span>
        ) : <span style={{ color: COL.dim }}>—</span>}
      </td>
      <td style={tdStyle}><strong>{status}</strong></td>
      <td style={{ ...tdStyle, color: COL.muted }}>{body}</td>
    </tr>
  );
}

function ActionRow({ color, symbol, name, meaning, signal }) {
  return (
    <div style={{
      display: 'grid', gridTemplateColumns: '40px 100px 1fr', gap: 14, alignItems: 'baseline',
      padding: '10px 12px', marginBottom: 8,
      background: 'rgba(255,255,255,0.02)', border: `1px solid ${color}33`, borderLeft: `3px solid ${color}`, borderRadius: 6,
    }}>
      <span style={{ fontSize: 22, color, textAlign: 'center', fontWeight: 600 }}>{symbol}</span>
      <strong style={{ color: COL.text, fontSize: 14 }}>{name}</strong>
      <div style={{ fontSize: 13, color: COL.muted, lineHeight: 1.5 }}>
        <span style={{ color: COL.text }}>{meaning}</span><br />
        <span style={{ fontSize: 12 }}><em>Signal:</em> {signal}</span>
      </div>
    </div>
  );
}

function Two({ children }) {
  return <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>{children}</div>;
}
function Half({ title, children }) {
  return (
    <div style={{
      padding: '12px 14px', background: 'rgba(255,255,255,0.02)',
      border: `1px solid ${COL.border}`, borderRadius: 8,
    }}>
      <div style={{ fontSize: 13, fontWeight: 600, color: COL.text, marginBottom: 6 }}>{title}</div>
      <div style={{ fontSize: 13, color: COL.muted, lineHeight: 1.6 }}>{children}</div>
    </div>
  );
}

function Tip({ children }) {
  return (
    <div style={{
      marginTop: 10, padding: '8px 12px',
      background: 'rgba(99,102,241,0.06)', border: `1px solid rgba(99,102,241,0.25)`,
      borderRadius: 6, fontSize: 12.5, color: COL.text, lineHeight: 1.55,
    }}>
      💡 {children}
    </div>
  );
}

function Quote({ children }) {
  return (
    <blockquote style={{
      margin: '6px 0', padding: '6px 10px',
      borderLeft: `2px solid ${COL.accent}`, color: COL.text, fontStyle: 'italic',
      fontSize: 13, lineHeight: 1.5,
    }}>{children}</blockquote>
  );
}

function Pill({ color, children }) {
  return (
    <span style={{
      display: 'inline-block', padding: '1px 8px', borderRadius: 999,
      fontSize: 11, fontWeight: 600,
      background: `${color}22`, color, marginLeft: 4,
    }}>{children}</span>
  );
}

function Anchor({ onClick, children }) {
  return (
    <a onClick={(e) => { e.preventDefault(); onClick(); }} href="#"
       style={{ color: COL.accent, textDecoration: 'underline', cursor: 'pointer' }}>
      {children}
    </a>
  );
}

function FooterCTA({ onClose }) {
  return (
    <div style={{
      marginTop: 30, padding: '20px 24px',
      background: 'linear-gradient(135deg, rgba(214,109,60,0.10), rgba(214,109,60,0.04))',
      border: `1px solid rgba(214,109,60,0.35)`, borderRadius: 12,
      display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16,
    }}>
      <div>
        <div style={{ fontSize: 16, fontWeight: 600, color: COL.text }}>You're set up.</div>
        <div style={{ fontSize: 13, color: COL.muted, marginTop: 2 }}>
          Open the Day Brief and start triaging. Come back here anytime — Settings → Welcome.
        </div>
      </div>
      <button onClick={onClose}
              style={{ background: COL.accent, color: '#fff', border: 0, padding: '10px 20px', borderRadius: 8, cursor: 'pointer', fontSize: 14, fontWeight: 600 }}>
        Open Day Brief →
      </button>
    </div>
  );
}

const tableStyle = { width: '100%', borderCollapse: 'collapse', fontSize: 13, marginTop: 4 };
const Th = ({ children }) => (
  <th style={{ padding: '8px 10px', textAlign: 'left', fontWeight: 600, color: COL.dim, fontSize: 12, background: 'rgba(255,255,255,0.03)' }}>{children}</th>
);
const tdStyle = { padding: '10px', verticalAlign: 'top' };
const ulStyle = { margin: '4px 0 0', paddingLeft: 18, color: COL.muted, fontSize: 13.5, lineHeight: 1.7 };
