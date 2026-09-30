# G2 contract fixture (11-06): a RUN step that stays alive long enough to be cancelled mid-build.
# Same digest-pinned base as fixtures/node-api, preloaded by the deploy-engine harness.
FROM node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402
RUN echo NOODARA_SLOW_BUILD_STARTED && sleep 300
