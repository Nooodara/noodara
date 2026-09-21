# Privileged Ubuntu fixture image hosting its own nested dockerd (06-10-PLAN.md Task 1, D-18
# layer 2) -- so the real install.sh can finally be executed end to end under genuine Ubuntu dash.
#
# Build context is tests/integration/images/, so this Dockerfile shares
# tests/integration/images/installer-dind-common/entrypoint.sh with its sibling Ubuntu-version
# variant without duplicating any script. The two installer-dind-ubuntu-*/Dockerfile files are
# identical except for the FROM line.
FROM ubuntu:24.04

# WITH_DOCKER: the fixture deliberately pre-installs Docker Engine by default, so most scenarios
# exercise install.sh's already-installed no-op path (D-14); set to "false" to exercise
# install.sh's own real apt-repo installation path instead. WITH_SNAP_DOCKER: installs a tiny
# `snap` stub (never a real snapd) whose `snap list docker` exits 0, so the snap-Docker preflight
# branch can be exercised in isolation from whether Docker Engine itself is snap-packaged.
ARG WITH_DOCKER=true
ARG WITH_SNAP_DOCKER=false

# install.sh's own base-command preflight (curl, openssl, ss, ip, awk, grep) plus what the fixture
# itself needs to host a nested daemon, plus netcat-openbsd (06-12-PLAN.md Task 2: a real listener
# tests/integration/installer/preflight-scenarios.test.ts binds to occupy the panel port for real).
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl gnupg iproute2 openssl sudo netcat-openbsd \
    && rm -rf /var/lib/apt/lists/*

# Docker Engine + compose plugin from Docker's own apt repository -- the exact same apt-repo
# sequence tests/integration/images/sshd-ubuntu-22.04/Dockerfile already uses for docker-ce-cli,
# extended here to the full daemon (docker-ce, containerd.io) since this fixture must host a real
# nested dockerd, not merely a CLI reaching an external one. A single RUN with an `if` guard keeps
# both the WITH_DOCKER=true and WITH_DOCKER=false variants sharing every earlier layer.
RUN if [ "$WITH_DOCKER" = "true" ]; then \
        apt-get update \
        && install -m 0755 -d /etc/apt/keyrings \
        && curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc \
        && chmod a+r /etc/apt/keyrings/docker.asc \
        && . /etc/os-release \
        && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${VERSION_CODENAME} stable" > /etc/apt/sources.list.d/docker.list \
        && apt-get update \
        && apt-get install -y --no-install-recommends docker-ce docker-ce-cli containerd.io docker-compose-plugin \
        && rm -rf /var/lib/apt/lists/*; \
    fi

# A stub, not a real snapd: just enough for `snap list docker` to succeed so the snap-Docker
# preflight detection branch can be exercised without installing snapd itself.
RUN if [ "$WITH_SNAP_DOCKER" = "true" ]; then \
        printf '#!/bin/sh\ncase "$1 $2" in\n  "list docker") exit 0 ;;\n  *) exit 1 ;;\nesac\n' > /usr/local/bin/snap \
        && chmod 0755 /usr/local/bin/snap; \
    fi

COPY installer-dind-common/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod 0755 /usr/local/bin/entrypoint.sh

# No EXPOSE: nothing outside this container reaches it over the network; tests drive it entirely
# through exec().
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
