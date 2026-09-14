# Project-owned Ubuntu 22.04 sshd fixture image (02-02-PLAN.md Task 1, QA-03).
#
# Build context is tests/integration/images/, so this Dockerfile shares tests/integration/images/
# sshd-common/** with the 24.04 variant without duplicating any script. This file is identical to
# ../sshd-ubuntu-24.04/Dockerfile except for the FROM line.
FROM ubuntu:22.04

# WITH_DOCKER_CLI: installs a real `docker` CLI + compose plugin with NO daemon running, so D-12's
# "CLI present, daemon unreachable" detection path can be exercised. WITH_SLOW_DF: installs the
# blocking-`df` shim used by the mid-exec CONNECTION_LOST scenario (plan 02-10). Both default off
# so every other scenario, and every image built without these args, is byte-identical to today.
ARG WITH_DOCKER_CLI=false
ARG WITH_SLOW_DF=false

RUN apt-get update \
    && apt-get install -y --no-install-recommends openssh-server sudo ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Docker CLI only, from Docker's own apt repository — docker-ce-cli ships no daemon binary at
# all, unlike Ubuntu's docker.io package. A single RUN with an `if` guard keeps both variants
# sharing every earlier layer; when WITH_DOCKER_CLI is false this layer is a no-op.
RUN if [ "$WITH_DOCKER_CLI" = "true" ]; then \
        apt-get update \
        && apt-get install -y --no-install-recommends curl gnupg \
        && install -m 0755 -d /etc/apt/keyrings \
        && curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc \
        && chmod a+r /etc/apt/keyrings/docker.asc \
        && . /etc/os-release \
        && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${VERSION_CODENAME} stable" > /etc/apt/sources.list.d/docker.list \
        && apt-get update \
        && apt-get install -y --no-install-recommends docker-ce-cli docker-compose-plugin \
        && rm -rf /var/lib/apt/lists/*; \
    fi

# Build-time keypairs (never committed — generated fresh on every `docker build`). ed25519_locked
# is generated at container *start* time by entrypoint.sh instead, from a per-run passphrase.
RUN mkdir -p /keys \
    && ssh-keygen -q -N '' -t ed25519 -f /keys/ed25519 \
    && ssh-keygen -q -N '' -t rsa -b 3072 -f /keys/rsa3072 \
    && ssh-keygen -q -N '' -t ecdsa -b 256 -f /keys/ecdsa \
    && ssh-keygen -q -N '' -t ed25519 -f /keys/ed25519_unauthorized

# The slow-df shim is always copied in but only ever installed onto the `df` PATH entry when
# WITH_SLOW_DF is true, so the default image's `df` stays the untouched coreutils binary.
COPY sshd-common/slow-df.sh /opt/noodara/slow-df.sh
RUN chmod 0755 /opt/noodara/slow-df.sh \
    && if [ "$WITH_SLOW_DF" = "true" ]; then \
        cp /opt/noodara/slow-df.sh /usr/local/bin/df \
        && chmod 0755 /usr/local/bin/df; \
    fi

COPY sshd-common/setup-users.sh /usr/local/bin/setup-users.sh
RUN chmod 0755 /usr/local/bin/setup-users.sh \
    && /usr/local/bin/setup-users.sh

COPY sshd-common/sshd_config.d/noodara-test.conf /etc/ssh/sshd_config.d/noodara-test.conf

COPY sshd-common/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod 0755 /usr/local/bin/entrypoint.sh

EXPOSE 22
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
