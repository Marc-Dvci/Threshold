# One image, four apps.
#
# Threshold needs four separate origins, and the point of the entry is that they really are separate:
# separate documents, separate inventories, separate booking systems, no code path between them. What
# they can share is a build, because sharing a build is not sharing a runtime.
#
#   docker build --build-arg APP=hub -t threshold-hub .
#   docker build --build-arg APP=provider-respite -t threshold-respite .
#
# The origins are baked in at build time and not at run time, deliberately. `import.meta.env` is read
# when the bundle is built, so a deployment that changed an origin without rebuilding would ship a
# page pointing at the wrong organisations, and it would fail as a silent discovery timeout rather
# than as an error anybody could read.

FROM node:22-alpine AS build
WORKDIR /app

ARG APP=hub

# Where the four origins live. Every one of these must be HTTPS in a real deployment: WebMCP is
# secure-context only, and cross-origin tools are refused outright otherwise.
ARG VITE_HUB_ORIGIN=http://localhost:5100
ARG VITE_ORIGIN_RESPITE=http://localhost:5101
ARG VITE_ORIGIN_HOMECARE=http://localhost:5102
ARG VITE_ORIGIN_TRANSPORT=http://localhost:5103
ENV VITE_HUB_ORIGIN=$VITE_HUB_ORIGIN \
    VITE_ORIGIN_RESPITE=$VITE_ORIGIN_RESPITE \
    VITE_ORIGIN_HOMECARE=$VITE_ORIGIN_HOMECARE \
    VITE_ORIGIN_TRANSPORT=$VITE_ORIGIN_TRANSPORT

RUN corepack enable

COPY pnpm-workspace.yaml pnpm-lock.yaml package.json .npmrc tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps

RUN pnpm install --frozen-lockfile
RUN pnpm --filter "@threshold/${APP}" build

# ---------------------------------------------------------------------------

FROM node:22-alpine AS runtime
WORKDIR /app

ARG APP=hub
ENV APP=$APP
ENV NODE_ENV=production

# The provider frames must be reachable from the hub, so the hub's CSP needs the same origins the
# bundle was built against. Passed through rather than re-derived.
ARG VITE_HUB_ORIGIN=http://localhost:5100
ARG VITE_ORIGIN_RESPITE=http://localhost:5101
ARG VITE_ORIGIN_HOMECARE=http://localhost:5102
ARG VITE_ORIGIN_TRANSPORT=http://localhost:5103
ENV VITE_HUB_ORIGIN=$VITE_HUB_ORIGIN \
    VITE_ORIGIN_RESPITE=$VITE_ORIGIN_RESPITE \
    VITE_ORIGIN_HOMECARE=$VITE_ORIGIN_HOMECARE \
    VITE_ORIGIN_TRANSPORT=$VITE_ORIGIN_TRANSPORT

RUN corepack enable

COPY --from=build /app /app

# `serve` is `tsx server.ts` for every app: the hub serves static files with the WebMCP headers, a
# provider serves its page and runs its own lease store in the same process. One process per
# organisation is what makes its atomic hold a real guarantee; see docs/THREAT_MODEL.md.
EXPOSE 8080
ENV PORT=8080
CMD ["sh", "-c", "pnpm --filter @threshold/${APP} serve"]
