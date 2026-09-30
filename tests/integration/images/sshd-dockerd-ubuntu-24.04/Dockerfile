# Combined deploy-host fixture (11-03-PLAN.md Task 1, D-12): sshd + nested dockerd + bare Git host.
#
# Build context is tests/integration/images/. Extends installer-dind (Docker from Docker's apt
# repo) and sshd-common (users, sshd config). Unlike installer-dind it installs the exact
# install.sh package set, docker-buildx-plugin included, so the deploy engine measures the Docker
# Noodara really provisions. The two sshd-dockerd-ubuntu-*/Dockerfile files differ only in FROM.
# No private key or password is baked in: login and deploy keys are injected per run.
FROM ubuntu:24.04

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl gnupg iproute2 openssh-server git sudo procps apache2-utils \
    && rm -rf /var/lib/apt/lists/*

RUN apt-get update \
    && install -m 0755 -d /etc/apt/keyrings \
    && curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc \
    && chmod a+r /etc/apt/keyrings/docker.asc \
    && . /etc/os-release \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${VERSION_CODENAME} stable" > /etc/apt/sources.list.d/docker.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin \
    && rm -rf /var/lib/apt/lists/*

# setup-users.sh expects public keys under /keys. Throwaway keys satisfy it, then every trace is
# removed in the same layer so no key material ships in the image; authorized_keys start empty.
COPY sshd-common/setup-users.sh /usr/local/bin/setup-users.sh
RUN chmod 0755 /usr/local/bin/setup-users.sh \
    && mkdir -p /keys \
    && for k in ed25519 rsa3072 ecdsa; do ssh-keygen -q -N '' -t ed25519 -f "/keys/$k"; done \
    && /usr/local/bin/setup-users.sh \
    && rm -rf /keys \
    && for home in /root /home/deployer /home/restricted; do : > "$home/.ssh/authorized_keys"; done

COPY sshd-common/sshd_config.d/noodara-test.conf /etc/ssh/sshd_config.d/noodara-test.conf

COPY sshd-dockerd-common/setup-git-host.sh /usr/local/bin/setup-git-host.sh
RUN chmod 0755 /usr/local/bin/setup-git-host.sh \
    && /usr/local/bin/setup-git-host.sh

COPY sshd-dockerd-common/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod 0755 /usr/local/bin/entrypoint.sh

EXPOSE 22
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
