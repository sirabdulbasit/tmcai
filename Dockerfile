# ── Build stage ────────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

COPY server/package.json server/package-lock.json ./
RUN npm ci

COPY server/ ./
RUN npx prisma generate
RUN npm run build

# ── Runtime stage ──────────────────────────────────────────────
FROM node:20-alpine

WORKDIR /app

# Copy built artifacts and runtime dependencies
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/package.json ./

EXPOSE 4002

CMD ["node", "dist/server.js"]
