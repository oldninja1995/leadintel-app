#!/bin/sh
set -e

# The image chowns /app at build time, but a volume is mounted at /app/var at
# *runtime*, root-owned, on top of that — so the build-time ownership is
# replaced by the mount and the app cannot write its raw store, run log or
# audit trail. It reports the EACCES rather than crashing, which is worse in
# one way: a container that starts and then silently records nothing looks
# healthy.
#
# So ownership is fixed here, after the mount exists, and privileges are then
# dropped. Running as root the whole time would be the easy fix and the wrong
# one: this process parses payloads from five external systems.

if [ "$(id -u)" = "0" ]; then
  chown -R node:node /app/var 2>/dev/null || true
  exec su-exec node "$@"
fi

exec "$@"
