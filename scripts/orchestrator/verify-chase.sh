#!/usr/bin/env bash
#
# verify-chase.sh — did Nexeo chase anyone, and can the owner read what it said?
#
# The live acceptance for C-2 increment 1, per D-10: *"improvement should not be in
# numbers it should be in real"*. Run BEFORE the deploy to record the baseline, and
# AFTER to produce the evidence. A test passing is not this.
#
# It answers three questions from production, in order of how much they matter:
#   1. Did a chase reach a DELEGATEE (not the owner) without the owner asking?
#   2. Can its exact text be retrieved?  (D-12: today it is stored nowhere)
#   3. Was delivery confirmed, or only accepted by the transport?
set -uo pipefail
cd /var/www/tmcai/server
set -a; . ./.env 2>/dev/null; set +a
psql "$DATABASE_URL" -X -q <<'SQL'
\echo == 1. follow-up actions, by audience — a chase to the OWNER is not a chase ==
SELECT output->>'channel' AS channel,
       input->>'audience'  AS audience,
       count(*)            AS n,
       max(created_at)::date AS latest
  FROM agent_actions
 WHERE action_type IN ('action_lifecycle_follow_up','delegation_follow_up_sent')
 GROUP BY 1,2 ORDER BY 3 DESC;

\echo
\echo == 2. is the SENT TEXT retrievable anywhere? (D-12 says no) ==
SELECT table_name, column_name
  FROM information_schema.columns
 WHERE table_name IN ('delegation_thread_events','agent_actions','whatsapp_outbound_messages')
   AND (column_name ~* 'body|text|payload|snippet|content')
 ORDER BY 1,2;

\echo
\echo == 3. delivery: accepted by transport vs confirmed by provider ==
SELECT channel, receipt_status,
       (provider_message_id IS NOT NULL) AS has_provider_receipt,
       count(*) AS n, max(created_at)::date AS latest
  FROM delegation_thread_events
 WHERE event_type = 'outbound_receipt'
 GROUP BY 1,2,3 ORDER BY 4 DESC;

\echo
\echo == 4. the owner-visible test: most recent worker send, with its text if stored ==
SELECT to_char(e.created_at,'YYYY-MM-DD HH24:MI') AS at, e.channel, e.receipt_status
  FROM delegation_thread_events e
 WHERE e.event_type = 'outbound_receipt'
 ORDER BY e.created_at DESC LIMIT 3;
SQL
