# tmcai-agents — HaseebOS v15 agent worker

Python FastAPI service hosting the 7-agent Gemini ADK fleet on Cloud Run.

Each agent is defined in `src/agents/*.py`. The Brain Orchestrator is the root
agent — it supervises and delegates to the six workers via ADK's
`transfer_to_agent()`.

## Agent roster

| Agent | Model | Role |
|---|---|---|
| Brain Orchestrator | Gemini Pro | Supervisor, routes to workers |
| Feed Curator | Gemini Flash | Promotes raw feed events to OpenItems |
| Triage Analyst | Gemini Flash | Archetype + priorityScore assignment |
| Action Executor | Gemini Flash | Dispatches approved actions via platform API |
| Reflection Agent | Gemini Flash | Nightly pattern analysis, proposes DRAFT rules |
| Steering Analyst | Gemini Flash | Daily KPI snapshots + Morning Brief |
| External Knowledge | Gemini Flash | RAG over KB + TMC Context + KNOW |
| Shadow Scorer | Gemini Flash | Evaluates DRAFT/SHADOW rules against Golden Dataset |

## How it fits

- Agents **never write Postgres directly**. Every mutation goes through the
  tmcai platform API at `$PLATFORM_API_URL` (Cloud Run internal). Auth via
  a machine-to-machine token stored in Secret Manager.
- Pub/Sub push subscriptions → `/pubsub/feed-raw`, `/pubsub/actions-approved`,
  `/pubsub/openitems-scored`, `/pubsub/steering-snapshot`. Each endpoint
  decodes the envelope and drives the Brain with a structured prompt.
- Kill switch is checked on every tool invocation via the Brain's
  `kill_switch_check` tool. A failed fetch is treated as "halted" (fail-safe).

## Local dev

```bash
cp .env.example .env     # fill in PLATFORM_API_TOKEN + REDIS_AUTH
pip install -e ".[dev]"
uvicorn src.main:app --reload --port 8080
```

Invoke the Brain manually:

```bash
curl -X POST http://localhost:8080/admin/run-brain \
  -H 'Content-Type: application/json' \
  -d '{"tenant_id":"C-1604","prompt":"Summarize today'\''s pending approvals"}'
```

## Deploy

```bash
gcloud builds submit --config cloudbuild.yaml \
  --substitutions=_SERVICE=tmcai-agents,_REGION=us-central1
```

The cloudbuild defaults assume:
- Artifact Registry repo `us-central1-docker.pkg.dev/$PROJECT_ID/tmcai`
- Service account `tmcai-agent-worker@$PROJECT_ID.iam.gserviceaccount.com`
- VPC connector `tmcai-vpc` in `us-central1`
- Secrets `platform-api-token` and `memorystore-auth` in Secret Manager

Adjust substitutions via `--substitutions=_SERVICE_ACCOUNT=...,_VPC_CONNECTOR=...`
if cowork used different names.

## Pub/Sub push subscriptions

After deploying the service, run (once per topic):

```bash
gcloud pubsub subscriptions create feed.raw-feed-curator \
  --topic=feed.raw \
  --push-endpoint=https://tmcai-agents-<hash>-uc.a.run.app/pubsub/feed-raw \
  --push-auth-service-account=tmcai-agent-worker@$PROJECT_ID.iam.gserviceaccount.com \
  --ack-deadline=60 \
  --max-delivery-attempts=5 \
  --dead-letter-topic=projects/$PROJECT_ID/topics/feed.raw.dlq
```

Repeat for `actions.approved-executor`, `openitems.scored-triage-analyst`,
`steering.snapshot-steering`. Subscription names must match the `SUB_*` env
vars in `.env`.
