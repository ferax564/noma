FROM node:20-bookworm-slim AS build

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
COPY packages ./packages
COPY tools ./tools
COPY tsconfig.json ./
COPY src ./src
RUN npm ci --include=dev --ignore-scripts
RUN npm rebuild better-sqlite3

COPY . .
RUN npm run build:cloud
RUN npm prune --omit=dev --ignore-scripts --workspaces=false

FROM node:20-bookworm-slim AS runtime

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000
ENV NOMA_PUBLIC_DIR=/app/dist
ENV NOMA_CLOUD_DATA_DIR=/data/noma/documents
ENV NOMA_CLOUD_DB=/data/noma/noma-cloud.sqlite

COPY package.json package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist

EXPOSE 3000

CMD ["node", "dist/cloud-server.js"]
