# A relay, without a toolchain.
#
# Self-hosting used to mean cloning the repository, having the right Node, and
# running a workspace build — three things that can each be wrong before the
# thing has a chance to work. This is deliberately not tied to any one host:
# the same image runs on Railway, Fly, Render, a VPS, or a laptop behind a
# tunnel, which is the point. The relay learns its own public address from the
# proxy in front of it rather than from a platform's environment variables.
#
#   docker build -t ripieno-relay .
#   docker run -p 8787:8787 -v ripieno-data:/data ripieno-relay
#
# It prints a token and the address to share on startup. Both survive a restart
# because /data is a volume.

# ---------------------------------------------------------------------------
# Build
# ---------------------------------------------------------------------------
FROM node:20-alpine AS build
WORKDIR /app

# Every workspace's manifest, because `npm ci` validates the whole set against
# the lockfile and fails on any it cannot find — even ones this image will
# never build. Copying manifests before sources keeps the install layer cached
# across ordinary source edits.
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/protocol/package.json      packages/protocol/
COPY packages/relay-client/package.json  packages/relay-client/
COPY packages/workspace-core/package.json packages/workspace-core/
COPY packages/mcp/package.json           packages/mcp/
COPY packages/relay/package.json         packages/relay/
COPY packages/workspace-host/package.json packages/workspace-host/
COPY packages/extension/package.json     packages/extension/

RUN npm ci --ignore-scripts

# Only the two packages a relay is made of. The extension, the MCP server and
# the workspace host are not part of this image and their sources never enter it.
COPY packages/protocol packages/protocol
COPY packages/relay    packages/relay

RUN npm run build:relay

# ---------------------------------------------------------------------------
# Run
# ---------------------------------------------------------------------------
FROM node:20-alpine
WORKDIR /app

ENV NODE_ENV=production
# Containers are reached from outside by definition, so the loopback default
# that protects a laptop would make this image useless.
ENV RIPIENO_HOST=0.0.0.0
ENV RIPIENO_PORT=8787
# Somewhere to keep room history and the generated token, so neither is lost on
# restart. Mount a volume here or an invite link stops working on redeploy.
ENV RIPIENO_DATA_DIR=/data

COPY --from=build /app/node_modules            ./node_modules
COPY --from=build /app/package.json            ./package.json
COPY --from=build /app/packages/protocol/dist  ./packages/protocol/dist
COPY --from=build /app/packages/protocol/package.json ./packages/protocol/package.json
COPY --from=build /app/packages/relay/dist     ./packages/relay/dist
COPY --from=build /app/packages/relay/package.json    ./packages/relay/package.json

RUN mkdir -p /data && chown -R node:node /data
USER node

EXPOSE 8787
VOLUME ["/data"]

# The relay answers /health without authentication and reveals nothing about
# rooms or members, which is exactly what a healthcheck should be able to see.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||process.env.RIPIENO_PORT||8787)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "packages/relay/dist/src/index.js"]
