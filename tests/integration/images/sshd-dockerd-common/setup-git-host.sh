#!/bin/sh
# Build-time Git host provisioning for the sshd+dockerd fixture (11-03, D-12).
# Runs after sshd-common/setup-users.sh, so `deployer` already exists.
#   git                   - system user whose login shell is git-shell: it can serve fetch/push
#                           over SSH and nothing else. authorized_keys is written at container
#                           start from the per-run deploy public key (entrypoint.sh).
#   /srv/git              - bare repositories, owned by git.
#   The deploy workspace needs no provisioning: it lives under the SSH user's home (14-30).
set -eu

useradd --system --create-home --home-dir /home/git --shell /usr/bin/git-shell git
# '*' instead of useradd's locked '!': no password login is possible either way, but a locked
# account can be refused for pubkey auth by sshd builds that check the shadow field.
usermod -p '*' git

mkdir -p /home/git/.ssh
: > /home/git/.ssh/authorized_keys
chmod 0700 /home/git/.ssh
chmod 0600 /home/git/.ssh/authorized_keys
chown -R git:git /home/git/.ssh

mkdir -p /srv/git
chown git:git /srv/git
chmod 0755 /srv/git
