FROM node:22-bookworm-slim

WORKDIR /app
COPY sandbox-service/package.json sandbox-service/package-lock.json ./
RUN npm ci --omit=dev
COPY sandbox-service/server.mjs sandbox-service/worker.mjs sandbox-service/sql-safety.mjs ./

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080
CMD ["node", "server.mjs"]
