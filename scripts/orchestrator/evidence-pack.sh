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
echo "### Self-Pruning — the three aspects the owner named on 2026-09-10"
echo
echo "**Aspect 3 — DB PRUNING: redundant, duplicated, noisy.** Three different faults."
echo '```'
# NOISE. `status` is a real column on wiki_pages with three values, and this is the corpus
# brainRetrievalPlanner actually retrieves from — so a stale or orphan page is not disk, it
# is a wrong answer waiting to be retrieved (BRAIN_VISION.md).
q "SELECT 'wiki corpus: '||count(*)||' pages — '
     ||count(*) FILTER (WHERE status='active')||' active, '
     ||count(*) FILTER (WHERE status='stale')||' stale, '
     ||count(*) FILTER (WHERE status='orphan')||' orphan ('
     ||round(100.0*count(*) FILTER (WHERE status<>'active')/greatest(count(*),1))
     ||'% of what retrieval reads is not active)'
     FROM wiki_pages" 2>/dev/null || echo "wiki_pages: unavailable"
# DUPLICATION — the same person stored twice, by the name a human would call one thing.
q "SELECT 'duplicate person names: '||coalesce(count(*),0)
     FROM (SELECT lower(trim(display_name)) n FROM persons
            WHERE display_name IS NOT NULL GROUP BY 1 HAVING count(*)>1) d" 2>/dev/null \
  || echo "persons: unavailable"
# REDUNDANCY — one concern, two live stores. A write to one leaves the other wrong.
q "SELECT 'contacts split across two tables: entities '||(SELECT count(*) FROM entities)
     ||' vs persons '||(SELECT count(*) FROM persons)" 2>/dev/null || echo "contact split: unavailable"
# BLOAT — "optimal level" in the owner's words. Dead tuples are rows the planner still walks.
q "SELECT 'heaviest dead-tuple tables: '||string_agg(relname||' '||n_dead_tup, ', ' ORDER BY n_dead_tup DESC)
     FROM (SELECT relname, n_dead_tup FROM pg_stat_user_tables
            WHERE n_dead_tup > 500 ORDER BY n_dead_tup DESC LIMIT 5) t" 2>/dev/null \
  || echo "pg_stat_user_tables: unavailable"
# WHOLE TABLES, not only rows — the owner's aspect 3 says "remove redundant and uncessary
# TABLES and their data". An empty table is a CANDIDATE and never a verdict: Class 4 is
# explicit that audit and receipt tables are kept precisely because empty is not unused.
q "SELECT 'tables: '||count(*)||' total, '||count(*) FILTER (WHERE n_live_tup = 0)
     ||' holding zero rows (CANDIDATES — empty is not unused, Class 4 keeps audit/receipt tables)'
     FROM pg_stat_user_tables" 2>/dev/null || echo "table census: unavailable"
echo '```'
echo
echo "**Aspects 1 and 2 — FILES and CODE.** Measured from the tree, not asserted."
echo '```'
# This script had no need for the filesystem until aspect 2, so it never defined a root.
# The literal is the convention every other script in this directory follows; NEXEO_ROOT
# overrides it so a clean-room clone measures ITS tree rather than the production one.
# (A ${BASH_SOURCE}-derived path was tried first and resolved empty under this script's
# own shell options — a derivation that silently yields "" is worse than a literal.)
PACK_ROOT="${NEXEO_ROOT:-/var/www/tmcai}"
SRC="$PACK_ROOT/server/src"
if [ -d "$SRC" ]; then
  printf 'live TypeScript: %s files, %s lines under server/src\n' \
    "$(find "$SRC" -name '*.ts' -type f | wc -l)" \
    "$(find "$SRC" -name '*.ts' -type f -exec cat {} + 2>/dev/null | wc -l)"
  # STALE EMITTED ARTIFACTS. `tsc` does not delete output for a deleted input, so a .js
  # outlives its .ts and keeps shipping inside dist. This is the one pruning fault that
  # reaches production by itself, which is why it is counted rather than described.
  if [ -d "$PACK_ROOT/server/dist" ]; then
    printf 'emitted .js in dist with no matching .ts in src: %s\n' \
      "$(cd "$PACK_ROOT/server/dist" && find . -name '*.js' -type f -printf '%P\n' 2>/dev/null \
         | sed 's/\.js$//' \
         | while read -r f; do [ -f "$SRC/$f.ts" ] || echo "$f"; done | wc -l)"
  fi
  # ASPECT 1 — THE RESIDUE OF HAVING BUILT, outside dist. Dated dist backups are written
  # by deploy.sh before every build and never collected, and this session alone created
  # several. Counted rather than described, because "some old backups" is not a measure.
  printf 'dist backups left in /tmp by past deploys: %s (%s)\n' \
    "$(find /tmp -maxdepth 1 -name 'nexeo-dist-backup-*' -type d 2>/dev/null | wc -l)" \
    "$(du -shc /tmp/nexeo-dist-backup-* 2>/dev/null | tail -1 | awk '{print $1}' || echo '0')"

  # NO INBOUND REFERENCE — an approximation, and labelled as one. One pass collects every
  # basename any file imports; anything never named is a CANDIDATE for Class 1, not a
  # verdict: dynamic imports and registry lookups do not appear as text.
  python3 - "$SRC" <<'PYDEAD' 2>/dev/null || echo "dead-file scan: unavailable"
import os, re, sys
root = sys.argv[1]
files = {}
text = []
for d, _, ns in os.walk(root):
    for n in ns:
        if n.endswith('.ts') and not n.endswith('.d.ts'):
            p = os.path.join(d, n)
            # src/scripts/ holds OPERATOR ENTRY POINTS — run by hand or by the loop, never
            # imported, and already triaged by tests/operatorScriptParity.test.ts. Counting
            # them here reported 27 candidates that were all known entry points, which
            # buries the ones that are actually orphaned.
            if os.sep + 'scripts' + os.sep in p:
                continue
            files[n[:-3]] = p
            try: text.append(open(p, errors='replace').read())
            except Exception: pass
blob = '\n'.join(text)
named = set(re.findall(r"[\w./-]+/([\w.-]+)['\"]", blob)) | set(re.findall(r"\b(\w+)\.(?:ts|js)\b", blob))
# Tests and type declarations are never imported BY DESIGN — vitest discovers *.test.ts,
# and a .d.ts is consumed by the compiler, not by a require. Leaving them in made the
# first run report 40 candidates whose first four were test files, which is how a measure
# teaches its reader to ignore it.
orphans = [b for b in files
           if b not in named
           and not b.startswith('index')
           and not b.endswith(('.test', '.spec', '.d'))]
print(f"source files never named by any import (CANDIDATES, not a verdict): {len(orphans)} of {len(files)}")
if orphans:
    print("  e.g. " + ", ".join(sorted(orphans)[:6]))
PYDEAD
fi
echo '```'
echo
echo "### What this pack does NOT tell you"
echo
echo "- Whether a send was DELIVERED. A provider receipt is the only proof, and there"
echo "  are none, so treat every send as accepted-by-transport but unconfirmed."
echo "- What Nexeo actually said. The text is stored nowhere on the worker path."
echo "- Anything about quality. Counts show a capability FIRES, not that it fires well."
