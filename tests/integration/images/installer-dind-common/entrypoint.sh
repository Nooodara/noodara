#!/bin/sh
# Entrypoint for the privileged installer Docker-in-Docker fixture (06-10-PLAN.md Task 1, D-18
# layer 2). Starts a nested dockerd (when Docker Engine is actually present -- see WITH_DOCKER
# below), waits for its own socket to answer a real `docker version`, then emits a single
# deterministic readiness line that tests/integration/helpers/installer-dind.ts's Testcontainers
# wait strategy (Wait.forLogMessage) matches on, and finally blocks forever so the fixture stays
# alive for exec()-driven tests.
set -eu

NOODARA_DIND_LOG=/var/log/noodara-dockerd.log
NOODARA_DIND_READY_LINE='NOODARA_DIND_READY'
NOODARA_DIND_MAX_ATTEMPTS=120

# WITH_DOCKER=false (06-10-PLAN.md Task 1) ships a fixture with no Docker Engine at all, so
# install.sh's own real apt-repo installation path can be exercised. In that case there is no
# dockerd to start or wait for -- the fixture is ready to be exec()'d into the moment this script
# reaches here, matching install.sh's own real "Docker missing" starting condition.
if command -v dockerd >/dev/null 2>&1; then
  dockerd >"$NOODARA_DIND_LOG" 2>&1 &

  _noodara_dind_attempt=0
  while [ "$_noodara_dind_attempt" -lt "$NOODARA_DIND_MAX_ATTEMPTS" ]; do
    if docker version >/dev/null 2>&1; then
      break
    fi
    _noodara_dind_attempt=$((_noodara_dind_attempt + 1))
    sleep 1
  done

  if ! docker version >/dev/null 2>&1; then
    echo "noodara-dind: dockerd did not become ready after ${NOODARA_DIND_MAX_ATTEMPTS}s" >&2
    cat "$NOODARA_DIND_LOG" >&2
    exit 1
  fi
fi

echo "$NOODARA_DIND_READY_LINE"

# Keeps the container alive for exec()-driven tests. `sleep infinity` is a real coreutils builtin
# on both Ubuntu 22.04 and 24.04 and is the more direct "block forever" primitive -- chosen over
# `tail -f /dev/null`, which relies on tail's follow behaviour over a file nothing ever writes to,
# an indirection this fixture does not need.
exec sleep infinity
