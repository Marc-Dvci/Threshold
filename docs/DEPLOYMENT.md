# Deployment

Threshold needs **four separate origins on HTTPS**. That is not a preference: WebMCP is
secure-context only, and cross-origin tools require an origin-keyed document, an `allow="tools"`
grant from the embedder and an `exposedTo` allowlist at the embeddee. Four apps behind four paths of
one origin would not be this product; it would be a mock of it.

## What runs where

| Service | Serves | Holds state |
|---|---|---|
| `threshold-hub` | the coordinating page and `/verify.html` | nothing. In-memory session only, for the length of one visit |
| `threshold-respite` | Meadowbank Respite Unit's page **and** its lease store | its own inventory and leases |
| `threshold-homecare` | Selwyn Overnight Care's page and lease store | its own |
| `threshold-transport` | Northgate Accessible Transport's page and lease store | its own |

One process per organisation, and that is load-bearing rather than incidental: `LeaseStore.acquire`
is atomic because its read-modify-write has no `await` in the critical section, which is a real
guarantee on one event loop and no guarantee at all across two. **Do not scale a provider service
horizontally.** The fix at that point is a row lock or a Durable Object, not more instances. See
`docs/THREAT_MODEL.md`.

## The one thing that goes wrong

**Origins are baked in at build time.** `import.meta.env` is read when the bundle is built, so every
service must be *built* knowing all four URLs, not merely started with them. A deployment whose
origins are stale does not error: it sits there timing out on discovery, which looks like a network
problem and is not one.

`/verify.html` on the hub prints the origins it actually reached, with the tools it found grouped
under each. That check takes ten seconds and is the first thing to do after any deploy.

## Render

In the Render dashboard: **New > Blueprint**, pick this repository, and Render reads
`render.yaml`. `render blueprint launch` does the same thing from the CLI.

`render.yaml` brings up all four services on four `*.onrender.com` hostnames, which are four
genuinely distinct origins on HTTPS. Service names decide hostnames, so if you rename a service you
must change every URL in that file and redeploy everything: the hub's registry, the hub's
`frame-src`, and each provider's `exposedTo` all have to agree.

Everything the build needs is under `envVars`, `APP` included, because Render translates a service's
environment variables into Docker build arguments. There is no separate build-argument field in a
Blueprint, so a value that lives anywhere else never reaches the build, and the bundle ships pointing
at `localhost`.

The blueprint uses a paid instance (`0.5c-512mb`, the plan formerly named `starter`) rather than
`free` deliberately. Free services sleep after inactivity, and a judge who opens the link to find
three organisations unreachable has seen a broken product, not a sleeping one.

## Anywhere that runs a container

One image, four apps, selected by build argument:

```bash
docker build --build-arg APP=hub \
  --build-arg VITE_HUB_ORIGIN=https://hub.example \
  --build-arg VITE_ORIGIN_RESPITE=https://respite.example \
  --build-arg VITE_ORIGIN_HOMECARE=https://homecare.example \
  --build-arg VITE_ORIGIN_TRANSPORT=https://transport.example \
  -t threshold-hub .

docker build --build-arg APP=provider-respite \
  --build-arg VITE_HUB_ORIGIN=https://hub.example \
  -t threshold-respite .
```

Runtime environment:

| Variable | Service | Why |
|---|---|---|
| `PORT` | all | the platform's assigned port |
| `VITE_ORIGIN_RESPITE` / `_HOMECARE` / `_TRANSPORT` | hub | the `frame-src` in the hub's CSP, kept in step with the registry the bundle was built against |
| `VITE_HUB_ORIGIN` | providers | the single origin allowed to frame that organisation's page, via `frame-ancestors` |
| `THRESHOLD_RESET_TOKEN` | providers | guards the demo reset route. Without it the route refuses outright |

Verified end to end: four containers on four localhost ports, real WebMCP federation in Chrome 151,
a plan composed and three leases taken across three origins, no console errors.

## Headers, and the one compromise in them

The hub sends:

```
origin-agent-cluster: ?1
content-security-policy: default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval';
  style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self';
  frame-src <the three provider origins>; frame-ancestors 'none'; base-uri 'none'; form-action 'none'
x-content-type-options: nosniff
referrer-policy: no-referrer
```

`origin-agent-cluster: ?1` is not optional. Without it WebMCP is simply absent, with no error to
read.

`frame-src` names the three organisations and nothing else. It is the deployment-level statement of
the same rule `exposedTo` makes at the tool level: this page talks to a fixed list of origins, and a
compromise of the page cannot introduce a fourth.

**`unsafe-eval` is a real compromise and it is here for a reason.** Ajv compiles each JSON Schema
into a JavaScript validator with `new Function` at module load. Without the allowance the page does
not lose a defence, it fails to boot — and it fails *in production only*, because a dev server sends
no CSP at all. This was found by running the container and driving it in a browser, which is the
only place it could have been found.

The alternative is Ajv's standalone code generation, which emits the validators at build time and
would let both `unsafe-eval` and `unsafe-inline` go. It is the better end state. It is not free: the
generated validators would have to be what the test suite runs against too, or the browser would be
executing validators that no test has ever run, which is a worse problem than the one being solved.
Recorded in the threat model rather than left as a surprise.

Each provider sends `origin-agent-cluster: ?1` and `content-security-policy: frame-ancestors 'self'
<hub origin>`, and no CORS headers at all. That last absence is deliberate: the provider API answers
its own page and nothing else. The hub reaches providers over WebMCP or the bridge, never by calling
their HTTP APIs across origins, and an `Access-Control-Allow-Origin` here would quietly turn a
federated design into a REST client.

## After deploying

1. Open `https://<hub>/verify.html`. It should say WebMCP federation is working and list four tools
   under each of the three provider origins.
2. Open the hub. Three organisations connected, and the transport badge naming which wire is in use.
3. Open a provider with `?control`, take it offline, and watch the hub's panel change.

If step 1 says the fallback is running, the page will say so everywhere and the product still works.
That is a platform finding worth reporting, not something to hide: see
`docs/RUNTIME_TEST_MATRIX.md`.
