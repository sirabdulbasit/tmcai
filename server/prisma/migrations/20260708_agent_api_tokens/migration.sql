-- E1: tenant-bound agent API tokens. Raw tokens never stored (sha256 hex).
CREATE TABLE "agent_api_tokens" (
    "id" TEXT NOT NULL,
    "token_hash" VARCHAR(64) NOT NULL,
    "client_number" VARCHAR(50) NOT NULL,
    "label" VARCHAR(120),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" TIMESTAMP(3),

    CONSTRAINT "agent_api_tokens_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "agent_api_tokens_token_hash_client_number_key" ON "agent_api_tokens"("token_hash", "client_number");

CREATE INDEX "agent_api_tokens_client_number_idx" ON "agent_api_tokens"("client_number");
