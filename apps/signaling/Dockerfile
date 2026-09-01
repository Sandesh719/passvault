# The signaling server, and nothing else.
#
# It is one stateless process: no database, no volume, nothing to back up. It
# introduces two peers to each other and forgets them. That is what makes it
# safe to restart at any moment, and why it scales by running more of them.
#
# Built from the repository root, because the server depends on a workspace
# package:
#   docker build -f apps/signaling/Dockerfile -t passvault-signaling .

FROM node:22-alpine AS build
WORKDIR /repo

RUN corepack enable
# pnpm asks before purging a modules directory; with no TTY it assumes yes, but
# a build should never depend on what a prompt defaults to.
ENV CI=true

# Manifests first: these change far less often than source, so the install
# layer survives most rebuilds.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json tsconfig.json ./
COPY packages/core/package.json packages/core/
COPY apps/signaling/package.json apps/signaling/
RUN pnpm install --frozen-lockfile --filter @passvault/signaling...

COPY packages/core packages/core
COPY apps/signaling apps/signaling
RUN pnpm --filter @passvault/signaling... build

# Drop everything that only mattered while compiling.
RUN pnpm install --frozen-lockfile --prod --filter @passvault/signaling...

FROM node:22-alpine AS runtime
WORKDIR /repo

# Node's own signal handling is what stops the container; PID 1 without an init
# would ignore SIGTERM and be killed instead of shutting down.
RUN apk add --no-cache tini

COPY --from=build /repo/node_modules node_modules
COPY --from=build /repo/packages/core/package.json packages/core/
COPY --from=build /repo/packages/core/dist packages/core/dist
# No node_modules for core: it has no runtime dependencies, so the production
# install prunes the directory out of existence.
COPY --from=build /repo/apps/signaling/package.json apps/signaling/
COPY --from=build /repo/apps/signaling/dist apps/signaling/dist
COPY --from=build /repo/apps/signaling/node_modules apps/signaling/node_modules

ENV NODE_ENV=production
ENV PORT=8787
# Behind the proxy in docker-compose.yml, the socket address is the proxy's.
ENV TRUST_PROXY=1
EXPOSE 8787

# Nothing here needs to write to disk or bind a privileged port.
USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "apps/signaling/dist/main.js"]
