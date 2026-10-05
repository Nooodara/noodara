# 12-17 leak-canary fixture: the build prints a per-run canary (canary.txt, written by the test
# into its temp copy, never committed) on stdout and stderr, split across writes, then stays in
# BUILDING long enough for the test to read the workspace's .git/config.
FROM node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402
WORKDIR /app
COPY print-canary.js canary.txt ./
RUN node print-canary.js
CMD ["node","-e","setInterval(() => {}, 1000)"]
