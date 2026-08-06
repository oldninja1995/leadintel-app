# LeadIntel AI — a long-running process with a disk.
#
# Read this before choosing where to run it. The app is **not** serverless-
# compatible as built, and the three reasons are all deliberate rather than
# oversights:
#
#   sessions      held in memory (lib/auth/sessions.js), so a new invocation
#                 signs everybody out
#   the sync loop a setInterval that polls each source on its own cadence
#                 (lib/ingest/runner.js) — there is no background execution in
#                 a function that only lives for one request
#   state         everything persists to files under /app/var — the raw store,
#                 run log, audit trail, dispatches, evaluations
#
# So it wants a platform with an always-on process and a persistent volume:
# Railway, Render, Fly.io, or any VM. On Vercel or Netlify functions it would
# start, serve a page, and quietly lose every session and every synced record.
#
# Making it serverless is real work, not a config change: a session store, a
# database behind the repository contract, and the sync loop moved to a cron
# invocation. The seams for all three exist — that is what Phase 3's contract
# and Phase 4's injected store were for — but none of it is done.

FROM node:22-alpine

# tini    so SIGTERM reaches node rather than being swallowed by PID 1 — the
#         graceful shutdown in server.js is worth nothing if it never arrives
# su-exec so the entrypoint can fix the volume's ownership as root and then
#         drop to `node` before exec'ing the app
RUN apk add --no-cache tini su-exec

WORKDIR /app

# Dependencies first, so a code change does not reinstall them.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

# `var/` is state, not build output. **A volume must be mounted at /app/var** or
# every restart is a cold start with an empty raw store.
#
# Declared as a comment rather than a `VOLUME` instruction: Railway rejects
# `VOLUME` outright ("use Railway Volumes"), because it manages the mount
# itself, and other platforms want it declared in their own config too. The
# requirement is the same everywhere; only who declares it changes.
#
#   railway   railway volume add --mount-path /app/var
#   fly       [mounts] destination = "/app/var" in fly.toml
#   compose   volumes: ["leadintel-var:/app/var"]
#   docker    -v leadintel-var:/app/var

# The app writes only to /app/var. It does **not** run as root — but it cannot
# simply `USER node` either, because the volume is mounted over /app/var at
# runtime and arrives root-owned whatever the image did at build time. The
# entrypoint fixes that after the mount exists and then drops privileges. See
# docker-entrypoint.sh.
RUN chown -R node:node /app
COPY --chmod=755 docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

ENV NODE_ENV=production
EXPOSE 3000

# /health needs no credentials and carries no tenant data, precisely so a
# platform can call it.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||3000)+'/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--", "/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "server.js"]
