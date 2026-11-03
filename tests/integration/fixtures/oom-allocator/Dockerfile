# ADR 0012 A3 fixture: grows memory until a --memory limit OOM-kills the container.
# Same digest-pinned base the deploy-engine harness preloads; never a floating tag.
FROM node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402
COPY allocate.sh /noodara/allocate.sh
CMD ["sh", "/noodara/allocate.sh"]
