# TMC AI Intelligence — Service Level Agreement (SLA)

## 1. Uptime

| Metric | Target |
|--------|--------|
| Monthly uptime | 99.9% |
| Max planned downtime | 30 minutes/month (maintenance windows) |
| Max unplanned downtime | 8.7 hours/year |

Uptime is measured from the `/api/health/ready` endpoint. A minute counts as "down" if the endpoint returns non-200 status.

## 2. Response Time Targets

| Query Type | p50 | p95 | p99 |
|-----------|-----|-----|-----|
| Conversational (greetings, small talk) | < 1s | < 3s | < 5s |
| Quick answer (factual, count queries) | < 3s | < 8s | < 12s |
| Data query (dashboard, widget, analysis) | < 8s | < 15s | < 25s |
| File upload parse | < 30s | < 60s | < 90s |

Response time is measured from SSE connection open to first content chunk (`type: 'chunk'`).

## 3. Support Response SLAs

| Severity | Description | Response Time | Resolution Target |
|----------|-------------|---------------|-------------------|
| Critical | System down, data loss risk | 1 hour | 4 hours |
| High | Feature broken, no workaround | 4 hours | 24 hours |
| Normal | Feature degraded, workaround exists | 24 hours | 72 hours |
| Low | Enhancement request, cosmetic issue | 72 hours | Best effort |

## 4. Data Integrity

| Metric | Target |
|--------|--------|
| Multi-tenant data isolation | 100% (zero cross-tenant leakage) |
| PII masking accuracy | 99%+ (AI-powered NER detection) |
| Audit log completeness | 100% of queries logged |
| Backup frequency | Per DR plan (separate document) |

## 5. Monitoring

Automated monitoring via `slaMonitorService.ts`:
- Uptime tracked via health check pings every 60 seconds
- Response time percentiles computed from `audit_log` table
- Admin alerted when:
  - Uptime drops below 99.95% (approaching SLA threshold)
  - p95 response time exceeds target for 10+ consecutive minutes
  - Error rate exceeds 5% of requests in any 5-minute window

## 6. Exclusions

SLA does not cover:
- Planned maintenance windows (communicated 24 hours in advance)
- Third-party API outages (Gemini, Claude, OpenAI, BigQuery)
- Force majeure events
- Client-side network issues
- Abuse or misuse exceeding rate limits

## 7. Remedies

| Monthly Uptime | Service Credit |
|---------------|---------------|
| 99.0% - 99.9% | 10% of monthly fee |
| 95.0% - 99.0% | 25% of monthly fee |
| < 95.0% | 50% of monthly fee |

Service credits applied to next billing cycle upon request.

---

*Last updated: 2026-04-01*
*Approved by: [Pending Abdul Haseeb review]*
