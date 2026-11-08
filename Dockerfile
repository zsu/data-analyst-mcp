# The hosted (remote) mode: data-analyst-mcp serve --http, for a claude.ai custom connector.
# Build:  docker build -t data-analyst-mcp .
# Run:    docker run -p 8080:8080 -e DATA_ANALYST_PUBLIC_URL=https://data.example.org \
#           -e DATA_ANALYST_ACCOUNTS=1 --env-file da.env -v da-state:/state data-analyst-mcp
#         (da.env holds DATA_ANALYST_SECRET=<32+ random characters>; see docs/hosting.md)
# Local only (no auth, reachable from this machine only):
#         docker run -p 127.0.0.1:8080:8080 -e DATA_ANALYST_OPEN=1 data-analyst-mcp
# Without an auth mode the server refuses to start, because the image listens on 0.0.0.0 (see docs/hosting.md).
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production DATA_ANALYST_MODE=remote DATA_ANALYST_OUT=/tmp/data-analyst-mcp \
    DATA_ANALYST_STATE_DIR=/state PORT=8080 HOST=0.0.0.0 DATA_ANALYST_TRUST_PROXY=1
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY packs ./packs
COPY guide ./guide
RUN mkdir -p /state /tmp/data-analyst-mcp && chown -R node:node /state /tmp/data-analyst-mcp
USER node
VOLUME ["/state"]
EXPOSE 8080
HEALTHCHECK CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/bin/cli.js", "serve", "--http"]
