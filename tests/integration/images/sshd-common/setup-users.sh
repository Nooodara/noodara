#!/bin/sh
# Build-time user provisioning for the noodara SSH test fixture images (02-02-PLAN.md Task 1).
#
# Four principals, exactly matching the SERV-08 / D-13 user matrix every QA-03 scenario assumes:
#   root       - key-only login (sshd_config: PermitRootLogin prohibit-password). Gets all three
#                build-time public keys. SERV-08's sudo/docker-group checks report `not_applicable`
#                for root (that mapping lives in packages/ssh, not here).
#   deployer   - non-root, member of the `docker` group and granted passwordless sudo, so both
#                SERV-08 checks (`sudo -n true`, `id -nG` docker membership) must PASS.
#   restricted - non-root, NOT in `docker`, no sudoers entry at all, so both SERV-08 checks must
#                FAIL.
#   pwuser     - password-authentication fixture (D-03). Gets no `authorized_keys` file at all;
#                its password is set (or the account locked) at container *start* time by
#                entrypoint.sh from the per-run SSH_TEST_PASSWORD env var, never baked in here.
set -eu

# The `docker` group must exist even though no daemon does in the plain variant — `id -nG`
# membership is the only thing SERV-08's docker-group check inspects.
groupadd docker

useradd -m -s /bin/bash deployer
usermod -aG docker deployer
echo 'deployer ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/deployer
chmod 0440 /etc/sudoers.d/deployer

useradd -m -s /bin/bash restricted

useradd -m -s /bin/bash pwuser

for user in root deployer restricted; do
  home=$(getent passwd "$user" | cut -d: -f6)
  mkdir -p "$home/.ssh"
  cat /keys/ed25519.pub /keys/rsa3072.pub /keys/ecdsa.pub > "$home/.ssh/authorized_keys"
  chmod 0700 "$home/.ssh"
  chmod 0600 "$home/.ssh/authorized_keys"
  chown -R "$user":"$user" "$home/.ssh"
done
