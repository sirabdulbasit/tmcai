-- HaseebOS v15 L2+ — OpenItem vector memory (similar-items lookup)
CREATE TABLE IF NOT EXISTS "open_item_embeddings" (
  "id" SERIAL PRIMARY KEY,
  "client_number" VARCHAR(20) NOT NULL,
  "open_item_id" TEXT NOT NULL UNIQUE,
  "model" VARCHAR(50) NOT NULL,
  "dim" INTEGER NOT NULL,
  "embedding" JSONB NOT NULL,
  "text_hash" VARCHAR(64) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS "open_item_embeddings_client_created_idx"
  ON "open_item_embeddings"("client_number", "created_at");
