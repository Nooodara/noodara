# ADR 0012 A3 fixture: exits 3 right after start, so --restart on-failure loops with backoff.
FROM node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402
COPY crash.sh /noodara/crash.sh
CMD ["sh", "/noodara/crash.sh"]
