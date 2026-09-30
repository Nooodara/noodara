#!/bin/sh
# Container-start entrypoint for the sshd+dockerd deploy-host fixture (11-03, D-12).
# Inputs (all optional, all per run, never echoed):
#   NOODARA_TEST_LOGIN_PUBKEY        public key appended to deployer's authorized_keys
#   NOODARA_TEST_DEPLOY_PUBKEY       public key allowed to reach the git user (git-shell only)
#   NOODARA_TEST_DOCKER_DAEMON_JSON  full /etc/docker/daemon.json (registry mirrors, insecure hosts)
set -eu

NOODARA_DEPLOY_HOST_DOCKERD_LOG=/var/log/noodara-dockerd.log
NOODARA_DEPLOY_HOST_MAX_ATTEMPTS=120

# Fresh host keys on every start, like sshd-common.
rm -f /etc/ssh/ssh_host_*
ssh-keygen -A >/dev/null

if [ "${NOODARA_TEST_DEPLOY_PUBKEY:-}" != "" ]; then
  printf 'no-port-forwarding,no-agent-forwarding,no-X11-forwarding,no-pty %s\n' \
    "$NOODARA_TEST_DEPLOY_PUBKEY" > /home/git/.ssh/authorized_keys
  chown git:git /home/git/.ssh/authorized_keys
  chmod 0600 /home/git/.ssh/authorized_keys
fi

if [ "${NOODARA_TEST_LOGIN_PUBKEY:-}" != "" ]; then
  printf '%s\n' "$NOODARA_TEST_LOGIN_PUBKEY" >> /home/deployer/.ssh/authorized_keys
fi

if [ "${NOODARA_TEST_DOCKER_DAEMON_JSON:-}" != "" ]; then
  mkdir -p /etc/docker
  printf '%s\n' "$NOODARA_TEST_DOCKER_DAEMON_JSON" > /etc/docker/daemon.json
fi

# Same cgroup v2 nesting fix and dockerd start as installer-dind-common/entrypoint.sh (see the
# long comment there): move root-cgroup processes into a leaf and delegate every controller.
if [ -f /sys/fs/cgroup/cgroup.controllers ]; then
  mkdir -p /sys/fs/cgroup/init
  xargs -rn1 < /sys/fs/cgroup/cgroup.procs > /sys/fs/cgroup/init/cgroup.procs 2>/dev/null || :
  sed -e 's/ / +/g' -e 's/^/+/' < /sys/fs/cgroup/cgroup.controllers \
    > /sys/fs/cgroup/cgroup.subtree_control 2>/dev/null || :
fi

dockerd >"$NOODARA_DEPLOY_HOST_DOCKERD_LOG" 2>&1 &

_noodara_attempt=0
until docker info >/dev/null 2>&1; do
  _noodara_attempt=$((_noodara_attempt + 1))
  if [ "$_noodara_attempt" -ge "$NOODARA_DEPLOY_HOST_MAX_ATTEMPTS" ]; then
    echo "noodara-deploy-host: dockerd did not become ready after ${NOODARA_DEPLOY_HOST_MAX_ATTEMPTS}s" >&2
    cat "$NOODARA_DEPLOY_HOST_DOCKERD_LOG" >&2
    exit 1
  fi
  sleep 1
done

mkdir -p /run/sshd
/usr/sbin/sshd -D -e &

echo 'NOODARA_DEPLOY_HOST_READY'

wait
