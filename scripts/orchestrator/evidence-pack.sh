#!/usr/bin/env bash
#
# evidence-pack.sh — what the code DOES at runtime, for the scorer to cite.
#
# The scorer reads the codebase and nothing else, so it cannot see the one place a
# capability actually exists. Measured consequence, 2026-08-13: it scored Self
# Follow-Up 43 with basis "doc-read" while the follow-up worker had chased a real
# delegatee that morning, twice on consecutive days. A capability that only manifests
# at runtime can never be credited by a file reader, however much gets built — which
# is why eight of nine capabilities had never moved across eleven cards.
#
# AGGREGATES ONLY, AND DELIBERATELY SO. This text is sent to a third-party model, so
# it carries counts, dates and rates — never a name, a phone number, an email address
# or a message body. The scorer needs to know THAT the capability fires and how often,
# not WHO it fired at. Anything identifying is the owner's data and does not leave the
# box for a scoring run.
set -uo pipefail
cd /var/www/tmcai/server
set -a; . ./.env 2>/dev/null; set +a

q() { psql "$DATABASE_URL" -X -A -t -F'|' -c "$1" 2>/dev/null; }

echo "## Production runtime evidence (aggregates only — no names, numbers or message text)"
echo
echo "Generated $(date -u '+%F %H:%M UTC') from the live database. Cite these as"
echo '`basis: "live-evidence"` where they support a capability; they are observations of'
echo "the running system, not test results."
echo
echo "### Self Follow-Up — does the worker actually chase?"
echo '```'
q "SELECT 'follow-ups to a delegatee: '||count(*)||', latest '||coalesce(max(created_at)::date::text,'never')
     FROM agent_actions WHERE action_type='action_lifecycle_follow_up' AND input->>'audience'='concerned_party'"
q "SELECT 'follow-ups routed to the OWNER instead: '||count(*)
     FROM agent_actions WHERE action_type='action_lifecycle_follow_up' AND input->>'audience'='owner'"
q "SELECT 'escalations raised: '||count(*)||', latest '||coalesce(max(created_at)::date::text,'never')
     FROM agent_actions WHERE action_type='action_lifecycle_escalated'"
q "SELECT 'outbound sends: '||count(*)||' ('||count(*) FILTER (WHERE receipt_status='accepted')||' accepted, '
          ||count(*) FILTER (WHERE receipt_status='failed')||' failed), with a provider receipt: '
          ||count(*) FILTER (WHERE provider_message_id IS NOT NULL)
     FROM delegation_thread_events WHERE event_type='outbound_receipt'"
q "SELECT 'sent text retrievable from any table: no (no body/text column exists on the send path)'"
echo '```'
echo
echo "### Authorized Action — do dispatches happen, and are they approved?"
echo '```'
q "SELECT 'agent actions by type: '||string_agg(t||' '||n, ', ' ORDER BY n DESC)
     FROM (SELECT action_type t, count(*) n FROM agent_actions GROUP BY 1 ORDER BY 2 DESC LIMIT 8) s"
q "SELECT 'actions requiring approval: '||count(*) FILTER (WHERE requires_approval)||' of '||count(*)
     FROM agent_actions"
echo '```'
echo
echo "### Self-Pruning — is anything ever withdrawn or cleaned?"
echo '```'
q "SELECT 'open_items by status: '||string_agg(status||' '||n, ', ' ORDER BY n DESC)
     FROM (SELECT status, count(*) n FROM open_items GROUP BY 1) s"
q "SELECT 'items with a status the lifecycle matrix cannot express: '||count(*)
     FROM open_items WHERE status NOT IN ('NEW','TRIAGED','IN_PROGRESS','DELEGATED','WAITING_INFO','SNOOZED','INFORMED','CLOSED','CANCELLED')"
q "SELECT 'test-fixture items reaching production: '||count(*)
     FROM open_items WHERE title ~ '\[DEF-[0-9]+ TEST\]'"
echo '```'
echo
echo "### Memory — is anything stored and reused?"
echo '```'
q "SELECT 'brain memory rows: '||count(*) FROM brain_memory" 2>/dev/null || echo "brain_memory: table absent"
q "SELECT 'conversation turns on record: '||count(*) FROM brain_user_messages" 2>/dev/null || echo "brain_user_messages: unavailable"
# THE LEARN CAPABILITY HAD NO EVIDENCE IN THIS PACK AT ALL (added 2026-09-07).
#
# The only memory line above queries `brain_memory`, a table that does not exist — the
# scorer's own notes read "pack: brain_memory absent". So Learn was scored `code-read`
# every time, on the shape of the code rather than on whether anything was ever learned,
# and it sat at 42 as the only capability with zero movement all campaign. It was not
# being measured.
#
# `governed_brain_memories` is where the answer actually lives, and the split matters
# more than the total: ACTIVE means a rule is being injected into every prompt by
# governedMemoriesBlock; PENDING means it is inert and waiting on a human. A row with
# approved_at set and approved_by NULL was activated by Brain itself, which is the
# capability working — so it is counted separately and named as such.
q "SELECT 'governed memories: '||count(*)||' total — '
     ||count(*) FILTER (WHERE status='active')||' ACTIVE (injected into every prompt), '
     ||count(*) FILTER (WHERE status='pending_approval')||' pending a human, '
     ||count(*) FILTER (WHERE status IN ('archived','rejected'))||' archived/rejected'
     FROM governed_brain_memories" 2>/dev/null || echo "governed_brain_memories: unavailable"
q "SELECT 'self-activated by Brain (approved_at set, approved_by NULL): '
     ||count(*) FILTER (WHERE status='active' AND approved_at IS NOT NULL AND approved_by IS NULL)
     ||' of '||count(*) FILTER (WHERE status='active')||' active'
     FROM governed_brain_memories" 2>/dev/null || echo "self-activation: unavailable"
q "SELECT 'oldest memory still pending a human: '
     ||coalesce(min(created_at)::date::text,'none')
     FROM governed_brain_memories WHERE status='pending_approval'" 2>/dev/null || echo "pending age: unavailable"
q "SELECT 'interaction learning logs: '||count(*)||', latest '
     ||coalesce(max(created_at)::date::text,'never')
     FROM brain_interaction_learning_logs" 2>/dev/null || echo "brain_interaction_learning_logs: unavailable"
echo '```'
echo
echo "### What this pack does NOT tell you"
echo
echo "- Whether a send was DELIVERED. A provider receipt is the only proof, and there"
echo "  are none, so treat every send as accepted-by-transport but unconfirmed."
echo "- What Nexeo actually said. The text is stored nowhere on the worker path."
echo "- Anything about quality. Counts show a capability FIRES, not that it fires well."
