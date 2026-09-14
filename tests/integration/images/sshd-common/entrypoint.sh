#!/bin/sh
# Container-start entrypoint for the noodara SSH test fixture images (02-02-PLAN.md Task 1).
set -eu

# Fresh host keys on every start (SEC-03 / T-2-07): deleting and regenerating means two
# containers started from the same image present different host keys with no in-place sshd
# restart and no image rebuild — the deterministic basis for the HOST_KEY_CHANGED scenario.
rm -f /etc/ssh/ssh_host_*
ssh-keygen -A >/dev/null

# pwuser's password-auth fixture (D-03). The helper supplies a fresh random value per run via
# SSH_TEST_PASSWORD, so no password is ever committed; if it's absent, the account stays locked
# and password login is impossible.
if [ "${SSH_TEST_PASSWORD:-}" != "" ]; then
  echo "pwuser:${SSH_TEST_PASSWORD}" | chpasswd
else
  passwd -l pwuser >/dev/null
fi

# D-02's passphrase-protected key fixture. Generated here, at start time, from a per-run random
# passphrase, so neither the key nor the passphrase is ever committed to the repository.
if [ "${SSH_TEST_KEY_PASSPHRASE:-}" != "" ]; then
  ssh-keygen -q -t ed25519 -N "$SSH_TEST_KEY_PASSPHRASE" -f /keys/ed25519_locked
  cat /keys/ed25519_locked.pub >> /root/.ssh/authorized_keys
  cat /keys/ed25519_locked.pub >> /home/deployer/.ssh/authorized_keys
fi

mkdir -p /run/sshd

# `-e` sends sshd's log output (including the "Server listening on ... port 22" readiness line)
# to stderr instead of syslog, where Testcontainers' log-based wait strategy can see it.
exec /usr/sbin/sshd -D -e
