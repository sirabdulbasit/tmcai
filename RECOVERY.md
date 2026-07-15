# tmcai — Operational Recovery Runbook

Last incident: 2026-05-11 — system reboot caused tmcai DB outage for ~4 hours.
Root cause: host's system Postgres (`postgresql.service`) auto-started after
reboot and grabbed port 5432, blocking `postgres_container` from binding to
that port. `postgres_container` also lost its network attachment to
`objectives_app_network`. App returned 500s because Prisma couldn't reach
the DB.

This runbook is the playbook for the next time something similar happens,
written so the recovery is mechanical instead of a panic-driven discovery.

## Architecture (as of 2026-05-11)

- **App server**: `tmcai-server` under pm2, listens on `:4002`
- **DB**: `postgres_container` (Docker, image `postgres:16`) — bind-mounts
  volume `objectives_postgres_data` (shared with objectives app — KNOWN RISK,
  see "Long-term fix" below)
- **DB credentials** (in `/var/www/tmcai/server/.env`):
  - URL: `postgresql://tmcai_user:TmcAi2026Prod%239@127.0.0.1:5432/tmcai`
  - User: `tmcai_user` (lives inside `postgres_container`, NOT a system PG role)
  - DB name: `tmcai`
- **System Postgres** (`postgresql.service`): **PERMANENTLY DISABLED** to
  prevent port-5432 conflict with `postgres_container`. Do not re-enable.
- **pgvector extension**: installed manually in `postgres_container` after
  the 2026-05-11 incident (`apt-get install postgresql-16-pgvector` +
  `CREATE EXTENSION vector`). Not in the image by default; survives container
  restart but NOT volume recreation.

## Daily checks (manual, 30 seconds)

```bash
# Is the app responding?
curl -s -o /dev/null -w "HTTP %{http_code}\n" http://localhost:4002/api/health/app-info

# Is the DB reachable?
PGPASSWORD='TmcAi2026Prod#9' psql -h 127.0.0.1 -U tmcai_user -d tmcai -c "SELECT COUNT(*) FROM users;" 2>&1 | head -3

# Is today's backup in place?
ls -lh /root/backups/tmcai-$(date -u +%Y%m%d)*.dump 2>/dev/null
```

Expected:
- HTTP 200
- `count: 3` (or whatever your user count is)
- Today's `.dump` file > 0 bytes

If any fail → recovery flow below.

## Recovery flow — app returns 500 after reboot or restart

**Step 1: Confirm the symptom is DB connectivity**

```bash
pm2 logs tmcai-server --lines 50 --nostream | grep -iE 'prisma|authentication|connect' | tail -10
```

If you see `Authentication failed` or `Connection refused` → continue.
If something else → don't run the rest; diagnose first.

**Step 2: Is `postgres_container` running and on the right network?**

```bash
docker ps | grep postgres_container
docker inspect postgres_container --format '{{range $k, $v := .NetworkSettings.Networks}}{{$k}}: {{$v.IPAddress}}{{println}}{{end}}'
sudo ss -tlnp | grep 5432
```

Expected:
- `docker ps` shows it as `Up`
- Network list includes `objectives_app_network` with an IP
- Port 5432 is listening (docker-proxy)

**Step 3: If port 5432 is taken by system Postgres**

```bash
# Confirm it's the system one
sudo lsof -i :5432 -n -P | head -5

# Stop and disable system Postgres
sudo systemctl stop postgresql
sudo systemctl disable postgresql

# Restart postgres_container to grab the port
docker restart postgres_container
sleep 5
```

**Step 4: If postgres_container has no network attachment**

```bash
# Reattach
docker network connect objectives_app_network postgres_container

# Verify
docker inspect postgres_container --format '{{range $k, $v := .NetworkSettings.Networks}}{{$k}}: {{$v.IPAddress}}{{println}}{{end}}'
```

**Step 5: Verify DB is reachable**

```bash
PGPASSWORD='TmcAi2026Prod#9' psql -h 127.0.0.1 -U tmcai_user -d tmcai -c "SELECT COUNT(*) FROM users;"
```

Expected: `count: 3`. If it errors with "Connection refused", port mapping
isn't established — recreate the container (step 6).

**Step 6 (only if Step 5 fails): Recreate the container preserving the volume**

```bash
docker stop postgres_container && docker rm postgres_container

docker run -d \
  --name postgres_container \
  --network objectives_app_network \
  -p 127.0.0.1:5432:5432 \
  -e POSTGRES_USER=postgres \
  -e POSTGRES_PASSWORD='ag&73C#2^&*' \
  -e POSTGRES_DB=hrapr \
  -v objectives_postgres_data:/var/lib/postgresql/data \
  --restart unless-stopped \
  postgres:16

sleep 8

# Re-install pgvector (it's NOT in the image)
docker exec postgres_container bash -c "apt-get update -qq && apt-get install -y postgresql-16-pgvector"
docker exec postgres_container psql -U postgres -d tmcai -c "CREATE EXTENSION IF NOT EXISTS vector;"
```

The `objectives_postgres_data` volume contains both objectives' (hrapr DB)
and tmcai's (tmcai DB) data side-by-side. Recreating the container preserves
both since the volume is untouched.

**Step 7: Restart the app**

```bash
pm2 restart tmcai-server
sleep 5
curl -s -o /dev/null -w "HTTP %{http_code}\n" http://localhost:4002/api/health/app-info
```

Should return HTTP 200.

## If the data is genuinely lost (worst case)

```bash
# Find the latest dump
ls -lht /root/backups/tmcai-*.dump | head -5

# Restore (replace LATEST with actual filename)
LATEST=/root/backups/tmcai-20260503_134236.dump
docker exec postgres_container createuser -U postgres tmcai_user 2>/dev/null || true
docker exec postgres_container psql -U postgres -c "ALTER USER tmcai_user WITH PASSWORD 'TmcAi2026Prod#9';"
docker exec postgres_container createdb -U postgres -O tmcai_user tmcai 2>/dev/null || true
docker exec -i postgres_container pg_restore -U postgres -d tmcai --no-owner --no-privileges < "$LATEST"
docker exec postgres_container psql -U postgres -d tmcai -c "REASSIGN OWNED BY postgres TO tmcai_user;"
docker exec postgres_container psql -U postgres -d tmcai -c "GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO tmcai_user;"
docker exec postgres_container psql -U postgres -d tmcai -c "CREATE EXTENSION IF NOT EXISTS vector;"
pm2 restart tmcai-server
```

## Long-term fix (TODO — not yet done as of 2026-05-11)

Migrate tmcai off the shared `postgres_container` to its own dedicated
container per `/var/www/tmcai/docker-compose.yml` (already defines a clean
4-service stack). Steps:

1. `pg_dump` tmcai database + dump tmcai_user role
2. Edit compose `POSTGRES_PASSWORD` to match `.env` (or update `.env`)
3. `docker compose up -d postgres pgbouncer redis`
4. Restore the dumps into the new container
5. Update `.env` `DATABASE_URL` if port changes
6. Stop using `objectives_postgres_data` volume

This eliminates the dependency on the objectives team's container.

## Things NOT to do

- ❌ Do NOT re-enable `postgresql.service` (`sudo systemctl enable postgresql`) — it will conflict with `postgres_container` on port 5432 again
- ❌ Do NOT run `docker volume rm objectives_postgres_data` — that's where the tmcai data lives
- ❌ Do NOT run `docker compose down -v` on objectives' compose without checking what volumes it owns
- ❌ Do NOT run `pg_resetwal` or any `pg_ctl` directly against `/var/lib/postgresql/16/main` — that's the system Postgres data dir (disabled), tmcai data is in Docker

## Monitoring (to be set up)

External uptime monitor on `https://tai.tmcltd.com/api/health/app-info`
with 1-min interval and SMS alert to MD. Recommended:
- BetterStack (1-min free tier)
- UptimeRobot (5-min free tier)
- Healthchecks.io (for backup heartbeat — confirms daily dump cron is running)
