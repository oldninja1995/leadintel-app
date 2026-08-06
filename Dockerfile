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

# Tini, so SIGTERM reaches node rather than being swallowed by PID 1. The
# graceful shutdown in server.js is worth nothing if the signal never arrives.
RUN apk add --no-cache tini

WORKDIR /app

# Dependencies first, so a code change does not reinstall them.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

# `var/` is state, not build output. Mount a volume here or every restart is a
# cold start with an empty raw store.
VOLUME ["/app/var"]

# Not root. The app writes only to /app/var, which the volume owns.
RUN chown -R node:node /app
USER node

ENV NODE_ENV=production
EXPOSE 3000

# /health needs no credentials and carries no tenant data, precisely so a
# platform can call it.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||3000)+'/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server.js"]
