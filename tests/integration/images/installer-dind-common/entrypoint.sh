#!/bin/sh
# Entrypoint for the privileged installer Docker-in-Docker fixture (06-10-PLAN.md Task 1, D-18
# layer 2). Starts a nested dockerd (when Docker Engine is actually present -- see WITH_DOCKER
# below), waits for its own socket to answer a real `docker version`, then emits a single
# deterministic readiness line that tests/integration/helpers/installer-dind.ts's Testcontainers
# wait strategy (Wait.forLogMessage) matches on, and finally blocks forever so the fixture stays
# alive for exec()-driven tests.
set -eu

NOODARA_DIND_LOG=/var/log/noodara-dockerd.log
NOODARA_DIND_WATCHER_LOG=/var/log/noodara-dockerd-watcher.log
NOODARA_DIND_READY_LINE='NOODARA_DIND_READY'
NOODARA_DIND_MAX_ATTEMPTS=120
# Bounds the background watcher's own wait for the `dockerd` BINARY to even exist on disk
# (06-12-PLAN.md Task 2, D-14/INST-01 no-Docker scenario, see the comment below) -- generous (10
# minutes) since the one test that exercises this path installs several real packages over the
# real network.
NOODARA_DIND_WATCHER_MAX_ATTEMPTS=600

# Applies the cgroup v2 nesting fix (see the comment below) and starts dockerd in the background,
# waiting up to NOODARA_DIND_MAX_ATTEMPTS x 1s for a real `docker version` to succeed. Shared by
# both the immediate (WITH_DOCKER=true, called directly below) and deferred (WITH_DOCKER=false,
# called from the background watcher once install.sh's own apt-get makes the binary appear)
# startup paths, so the cgroup fix and the readiness wait are never duplicated.
noodara_dind_start_and_wait() {
  # Post-execution fix (06-11-PLAN.md, discovered by the first-ever real `docker compose up`
  # inside this fixture): on a cgroup v2 host (confirmed: this fixture's own
  # /sys/fs/cgroup/cgroup.controllers reports "cpuset cpu io memory hugetlb pids rdma", one
  # unified hierarchy) every process in this container -- including this entrypoint's own shell --
  # starts life directly inside the root cgroup. cgroup v2's "no internal process" constraint
  # forbids a cgroup from both containing member processes AND enabling "domain" controllers
  # (cpu/memory/...) for its own children at the same time. The nested dockerd/runc need exactly
  # that -- a child cgroup per container, with domain controllers enabled -- so without this fix
  # every `docker compose up`/`docker run` inside this fixture fails with runc's own
  # "cannot enter cgroupv2 ... with domain controllers -- it is in an invalid state" (reproduced
  # empirically, not theorized: this exact error surfaced install.sh's own noodara_compose_up
  # reporting exit 51 against a completely correct docker-compose.yml). This is the standard,
  # widely-documented Docker-in-Docker cgroup v2 workaround (moby/moby's own hack/dind script):
  # move every process currently in the root cgroup into a leaf "init" subcgroup (root then has no
  # member processes), then enable every available controller on the root's own
  # cgroup.subtree_control so its children (the cgroups dockerd creates per container) can use
  # them. A fixture-only fix (hard_rule #11c): this is a genuine nested-cgroup limitation of the
  # privileged-container harness itself, not a defect in install.sh or docker-compose.yml.
  if [ -f /sys/fs/cgroup/cgroup.controllers ]; then
    mkdir -p /sys/fs/cgroup/init
    xargs -rn1 < /sys/fs/cgroup/cgroup.procs > /sys/fs/cgroup/init/cgroup.procs 2>/dev/null || :
    sed -e 's/ / +/g' -e 's/^/+/' < /sys/fs/cgroup/cgroup.controllers \
      > /sys/fs/cgroup/cgroup.subtree_control 2>/dev/null || :
  fi

  dockerd >"$NOODARA_DIND_LOG" 2>&1 &

  _noodara_dind_attempt=0
  while [ "$_noodara_dind_attempt" -lt "$NOODARA_DIND_MAX_ATTEMPTS" ]; do
    if docker version >/dev/null 2>&1; then
      return 0
    fi
    _noodara_dind_attempt=$((_noodara_dind_attempt + 1))
    sleep 1
  done
  return 1
}

# WITH_DOCKER=false (06-10-PLAN.md Task 1) ships a fixture with no Docker Engine at all, so
# install.sh's own real apt-repo installation path can be exercised (06-12-PLAN.md Task 2, the
# no-Docker/D-14 scenario). In that case there is no dockerd to start or wait for HERE -- the
# fixture is ready to be exec()'d into the moment this script reaches the readiness line below,
# matching install.sh's own real "Docker missing" starting condition.
if command -v dockerd >/dev/null 2>&1; then
  if ! noodara_dind_start_and_wait; then
    echo "noodara-dind: dockerd did not become ready after ${NOODARA_DIND_MAX_ATTEMPTS}s" >&2
    cat "$NOODARA_DIND_LOG" >&2
    exit 1
  fi
else
  # A real VPS has systemd to start docker.service the moment install.sh's own `apt-get install
  # docker-ce ...` configures the package -- this bare privileged container has no init system of
  # its own to do that, so nothing would ever start the daemon install.sh itself just installed.
  # This background watcher polls dpkg's own record of docker-ce's install state (see below), then
  # runs the exact same start-and-wait sequence noodara_dind_start_and_wait already provides for
  # the WITH_DOCKER=true path above -- entirely independent of, and unsynchronized with, install.sh's
  # own execution. It never loads any image and never touches /opt/noodara: the no-Docker scenario
  # test itself pre-populates this fixture's own /var/lib/docker volume (via a "donor" fixture
  # sharing the same volume, see tests/integration/installer/preflight-scenarios.test.ts) BEFORE
  # this daemon ever starts, so there is no image-loading race to solve here -- only "start the
  # daemon once Docker Engine is genuinely, fully installed" (hard_rule #11c: a genuine fixture
  # limitation, solved entirely in the fixture -- never a test-only branch inside install.sh itself).
  #
  # Real DinD discovery (06-12-PLAN.md Task 2, first real run of this watcher): polling for the
  # `dockerd` BINARY alone (`command -v dockerd`) is too eager -- `apt-get install docker-ce
  # docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin` downloads every package
  # first, then unpacks and configures each one in dependency order; dpkg drops the dockerd binary
  # onto disk during docker-ce's own UNPACK step, well before docker-ce's postinst script has
  # finished running. Starting a competing `dockerd` while that postinst script is still executing
  # raced it in the very first real run of this fixture (`docker version` never became reachable
  # within install.sh's own bounded retry). Polling `dpkg-query`'s own Status field for docker-ce
  # specifically -- "install ok installed" is dpkg's own definitive "this package is fully
  # configured, not merely unpacked" signal -- avoids the race entirely by waiting for exactly the
  # same condition a real systemd host's own docker.service unit-file trigger would wait for.
  (
    _noodara_watcher_attempt=0
    while [ "$_noodara_watcher_attempt" -lt "$NOODARA_DIND_WATCHER_MAX_ATTEMPTS" ]; do
      if [ "$(dpkg-query -W -f '${Status}' docker-ce 2>/dev/null)" = "install ok installed" ]; then
        if ! noodara_dind_start_and_wait; then
          echo "noodara-dind: watcher's dockerd start did not become ready" >&2
        fi
        exit 0
      fi
      _noodara_watcher_attempt=$((_noodara_watcher_attempt + 1))
      sleep 1
    done
    echo "noodara-dind: watcher gave up waiting for docker-ce to be configured after ${NOODARA_DIND_WATCHER_MAX_ATTEMPTS}s" >&2
  ) >"$NOODARA_DIND_WATCHER_LOG" 2>&1 &
fi

echo "$NOODARA_DIND_READY_LINE"

# Keeps the container alive for exec()-driven tests. `sleep infinity` is a real coreutils builtin
# on both Ubuntu 22.04 and 24.04 and is the more direct "block forever" primitive -- chosen over
# `tail -f /dev/null`, which relies on tail's follow behaviour over a file nothing ever writes to,
# an indirection this fixture does not need.
exec sleep infinity
