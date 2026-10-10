# 14-15 gate run: leaked containers (2026-10-09)

Session org.testcontainers.session-id=00436822fb1d. Ryuk did not reap them. Gate order: test, typecheck, lint, boundaries, build, it-full (FAIL 9 strays), e2e-full (pass), installer (FAIL 7), security-leaks (FAIL 7), ui-safety, it-soak.

```
localhost/37661cdc29de:63581c388849 | Created | 2026-10-09 16:33:56 -0600 CST | noodara-sshd-24.04-a0b7dd87-d8f3-4532-aa56-ffbd9ee30691
redis:7-alpine | Up 5 hours | 2026-10-09 15:42:18 -0600 CST | lucid_galois
postgres:17-alpine | Up 5 hours (healthy) | 2026-10-09 15:42:18 -0600 CST | xenodochial_gates
redis:7-alpine | Up 5 hours | 2026-10-09 15:41:37 -0600 CST | agitated_babbage
postgres:17-alpine | Up 5 hours (healthy) | 2026-10-09 15:41:36 -0600 CST | nifty_einstein
registry:2 | Up 6 hours | 2026-10-09 15:22:20 -0600 CST | noodara-registry-0a951f77-894d-4712-bbf6-5f477ee5f838
localhost/72173feef380:cb8a77b85e1a | Up 6 hours | 2026-10-09 15:22:17 -0600 CST | noodara-deploy-host-24.04-3ebec144-ff01-4b97-b58a-2e9b87e725e7
registry:2 | Up 6 hours | 2026-10-09 15:22:14 -0600 CST | noodara-mirror-b98d693d-ca45-43f3-8541-f43a8658ac1f
```

Ryuk containers present now:
```
testcontainers-ryuk-1ccc9d7195da Up 8 minutes desktop.docker.io/binds/0/Source=/var/run/docker.sock,desktop.docker.io/binds/0/SourceKind=dockerSocketProxied,desktop.docker.io/binds/0/Target=/var/run/d
```
