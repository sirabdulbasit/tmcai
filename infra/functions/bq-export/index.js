/**
 * TMCAI — Nightly PostgreSQL → BigQuery Export
 * Cloud Function (Gen 2, Node.js 20)
 *
 * Incrementally exports rows from PostgreSQL DecisionLog table
 * to BigQuery tmcai_decisions.decision_archive table.
 *
 * Triggered by Cloud Scheduler at 02:00 UTC daily.
 *
 * Environment variables:
 *   GCP_PROJECT_ID       - GCP project ID
 *   BQ_DATASET           - BigQuery dataset (tmcai_decisions)
 *   BQ_TABLE             - BigQuery table (decision_archive)
 *   STAGING_BUCKET       - GCS bucket for staging CSVs
 *   PG_SECRET_NAME       - Secret Manager key for PG connection string
 */

const { BigQuery } = require("@google-cloud/bigquery");
const { Storage } = require("@google-cloud/storage");
const {
  SecretManagerServiceClient,
} = require("@google-cloud/secret-manager");
const { Pool } = require("pg");
const { v4: uuidv4 } = require("uuid");

const bigquery = new BigQuery();
const storage = new Storage();
const secretClient = new SecretManagerServiceClient();

// Cache PG pool across invocations (warm starts)
let pgPool = null;

/**
 * Get PostgreSQL connection string from Secret Manager
 */
async function getPgConnectionString() {
  const secretName = `projects/${process.env.GCP_PROJECT_ID}/secrets/${process.env.PG_SECRET_NAME}/versions/latest`;
  const [version] = await secretClient.accessSecretVersion({
    name: secretName,
  });
  return version.payload.data.toString("utf8");
}

/**
 * Get or create PG connection pool
 */
async function getPool() {
  if (!pgPool) {
    const connectionString = await getPgConnectionString();
    pgPool = new Pool({
      connectionString,
      max: 3,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
    });
  }
  return pgPool;
}

/**
 * Get the last export timestamp from BQ
 */
async function getLastExportTimestamp() {
  const query = `
    SELECT MAX(exported_at) as last_export
    FROM \`${process.env.GCP_PROJECT_ID}.${process.env.BQ_DATASET}.${process.env.BQ_TABLE}\`
  `;

  try {
    const [rows] = await bigquery.query({ query });
    if (rows.length > 0 && rows[0].last_export) {
      return new Date(rows[0].last_export.value);
    }
  } catch (err) {
    // Table might be empty on first run
    console.log("No previous export found, exporting all rows");
  }

  // Default: export everything from 30 days ago
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
  return thirtyDaysAgo;
}

/**
 * Fetch new decision log entries from PostgreSQL
 */
async function fetchNewDecisions(since) {
  const pool = await getPool();

  const query = `
    SELECT
      id::text,
      "tenantId"::text as tenant_id,
      "agentId"::text as agent_id,
      "agentType" as agent_type,
      "decisionType" as decision_type,
      "inputSummary" as input_summary,
      "outputSummary" as output_summary,
      reasoning,
      "confidenceScore"::float as confidence_score,
      "riskTier" as risk_tier,
      "actionTaken" as action_taken,
      outcome,
      "userFeedback" as user_feedback,
      "durationMs"::int as duration_ms,
      "traceId" as trace_id,
      "modelVersion" as model_version,
      "tokensUsed"::int as tokens_used,
      "costUsd"::float as cost_usd,
      metadata::text as metadata,
      "createdAt" as created_at
    FROM "DecisionLog"
    WHERE "createdAt" > $1
    ORDER BY "createdAt" ASC
    LIMIT 10000
  `;

  const result = await pool.query(query, [since.toISOString()]);
  console.log(`Fetched ${result.rows.length} new decisions since ${since.toISOString()}`);
  return result.rows;
}

/**
 * Insert rows into BigQuery
 */
async function insertIntoBQ(rows) {
  if (rows.length === 0) {
    console.log("No new rows to export");
    return { inserted: 0 };
  }

  const exportedAt = new Date().toISOString();
  const dataset = bigquery.dataset(process.env.BQ_DATASET);
  const table = dataset.table(process.env.BQ_TABLE);

  // Transform rows for BQ schema
  const bqRows = rows.map((row) => ({
    id: row.id,
    tenant_id: row.tenant_id,
    agent_id: row.agent_id || "unknown",
    agent_type: row.agent_type || null,
    decision_type: row.decision_type || "unknown",
    input_summary: row.input_summary || null,
    output_summary: row.output_summary || null,
    reasoning: row.reasoning || null,
    confidence_score: row.confidence_score || null,
    risk_tier: row.risk_tier || null,
    action_taken: row.action_taken || null,
    outcome: row.outcome || null,
    user_feedback: row.user_feedback || null,
    duration_ms: row.duration_ms || null,
    trace_id: row.trace_id || null,
    model_version: row.model_version || null,
    tokens_used: row.tokens_used || null,
    cost_usd: row.cost_usd || null,
    metadata: row.metadata || null,
    created_at: row.created_at,
    exported_at: exportedAt,
  }));

  // Insert in batches of 500
  const batchSize = 500;
  let totalInserted = 0;

  for (let i = 0; i < bqRows.length; i += batchSize) {
    const batch = bqRows.slice(i, i + batchSize);
    await table.insert(batch);
    totalInserted += batch.length;
    console.log(`Inserted batch ${Math.floor(i / batchSize) + 1}: ${batch.length} rows`);
  }

  return { inserted: totalInserted };
}

/**
 * Main Cloud Function entry point
 */
exports.exportDecisionsToBQ = async (req, res) => {
  const startTime = Date.now();
  const exportId = uuidv4();

  console.log(`[${exportId}] Starting BQ export`);

  try {
    // 1. Get last export timestamp
    const since = await getLastExportTimestamp();
    console.log(`[${exportId}] Exporting decisions since: ${since.toISOString()}`);

    // 2. Fetch new rows from PostgreSQL
    const decisions = await fetchNewDecisions(since);

    // 3. Insert into BigQuery
    const result = await insertIntoBQ(decisions);

    const duration = Date.now() - startTime;
    const response = {
      status: "success",
      exportId,
      rowsExported: result.inserted,
      since: since.toISOString(),
      durationMs: duration,
    };

    console.log(`[${exportId}] Export complete:`, response);
    res.status(200).json(response);
  } catch (error) {
    const duration = Date.now() - startTime;
    console.error(`[${exportId}] Export failed after ${duration}ms:`, error);

    res.status(500).json({
      status: "error",
      exportId,
      error: error.message,
      durationMs: duration,
    });
  }
};
