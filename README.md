# Threshold

**One web page where several independent care organisations answer a person's agent at the same
time, and compose one plan between them.**

Threshold is a browser-side WebMCP broker. Independent providers expose narrow tools to the hub
origin. The hub discovers and executes those tools from cross-origin iframes, validates the results,
and exposes a smaller normalised tool surface to the user's agent. Providers do not share a database
and do not call one another.

---

## The twenty seconds it exists for

It is eleven at night. A carer's mother has dementia, cannot be left alone overnight, needs a hoist,
and the carer has surgery at eight tomorrow morning. Arranging cover means a respite bed, transport
to it, and someone at the house until the van comes. Three organisations. Three phone calls that
cannot be made at this hour, each of which depends on the answer to the other two.

Her agent asks Threshold once. Three organisations answer at the same time. The obvious combination
comes back **infeasible on exactly one link**:

```
arrival_before_admission   required 06:40   offered 07:10   renegotiate_with: transport-a
```

The bed admits until 06:40. The earliest that van arrives is 07:10. Nothing at either organisation
knows this, because neither can see the other. A different van closes the plan, three leases are
taken one organisation at a time, and one panel asks the carer to check four fields before anything
with her mother's name on it leaves the page.

**That failing link is the product.** A federated search returns several independent answers, which
one vendor with three product categories could serve just as well. Asking whether several offers,
held at organisations that cannot see each other, satisfy *each other* has no non-federated
implementation.

---

## Architecture

```
                       the person's own agent
                                │
                       9 WebMCP tools, of which only
                       the ones valid for the current
                       state are ever registered
                                │
        ┌───────────────────────▼───────────────────────┐
        │  HUB  ·  localhost:5100                       │
        │                                               │
        │   state machine ──► tool lifecycle            │
        │   composition engine (deterministic)          │
        │   lease orchestrator + compensating release   │
        │   consent controller (a pending Promise)      │
        │   ─────────── trust firewall ───────────      │
        │   parse → Ajv strict → projection → rank      │
        └───┬───────────────┬───────────────┬───────────┘
            │ getTools({fromOrigins}) + executeTool
            │               │               │
     ┌──────▼─────┐  ┌──────▼─────┐  ┌──────▼─────┐
     │ respite-a  │  │ homecare-a │  │transport-a │   separate origins,
     │   :5101    │  │   :5102    │  │   :5103    │   `exposedTo: [hub]`
     ├────────────┤  ├────────────┤  ├────────────┤
     │ lease store│  │ lease store│  │ lease store│   separate processes,
     │   :6101    │  │   :6102    │  │   :6103    │   separate inventories
     └────────────┘  └────────────┘  └────────────┘
```

Each provider is a real website on its own origin, with its own inventory and its own booking
backend. There is no code path from any provider to any other.

---

## What WebMCP is doing here

| Mechanism | Where | Why it is load-bearing |
|---|---|---|
| `registerTool` with `exposedTo` | every provider | A provider publishes its four tools to exactly one origin. Never a wildcard. |
| `registerTool` with `signal` | hub and providers | Aborting the signal unregisters. The hub's tool surface is a function of its state; a provider going offline is an abort. |
| `getTools({ fromOrigins })` | hub broker | Discovery, one origin at a time, indexed by `(origin, name)`. Three organisations all publishing `hold` is the normal case. |
| `executeTool` | hub broker | The federation leg. Returns a string, or `null` on navigation, which is handled as a contract violation rather than an empty success. |
| `ontoolchange` | hub | How the hub learns a provider has withdrawn. It notices; it does not catch an error. |
| Permissions Policy `allow="tools"` | hub iframes | The embedder's half of the two-gate rule. `exposedTo` is the embeddee's half. |
| A tool that does not resolve | `make_referral` | The agent's call stays genuinely pending while a person reads and edits the payload. |
| `annotations` | every tool | `readOnlyHint` where true, and `untrustedContentHint: false` only because a test proves no provider-authored string can reach the output. |

---

## The five mechanisms worth reading the code for

### 1. Composition, not search (`packages/domain/src/composition.ts`)

Five link kinds describe how parts of a plan held at *different* organisations fail to fit each
other: same area, equipment at both ends of the journey, transport arriving before the admission
cut-off, cover lasting until collection, placement in effect before the deadline. `check_plan`
returns every failing link, in a fixed order, each naming the field, what was required, what was
offered, and **which organisation to go back to**.

It is a pure function. No model, no clock, no I/O. A person can argue with it.

Every link kind has a seeded scenario that fails it, and a coverage test fails if a link kind is
added without one.

### 2. Compensating release across origins (`apps/hub/src/orchestration/orchestrator.ts`)

Three parts of one plan live at three organisations with no shared transaction manager. There is no
two-phase commit available and anything claiming atomicity across those origins is lying. What is
available is short provider-authoritative leases with a TTL, sequential acquisition, and
compensation.

Acquisition is **sequential and scarcest-first**. Concurrent acquisition takes leases it is about to
throw away, and against a genuinely scarce humanitarian resource that is the antisocial
machine-speed behaviour this project argues against. It is slower on purpose.

Partial success is never reported as success. If a leg is refused, every lease already taken is
released in reverse order before the call returns, and the agent is told truthfully that nothing is
being held. A provider unreachable during the unwind is recorded as `unreachable`, and the TTL is
the backstop. `expired` is reported separately from `released`, because they are different
statements about a scarce resource.

### 3. The typed trust firewall (`apps/hub/src/broker/firewall.ts`)

No provider result is trusted because it came through WebMCP. WebMCP controls discoverability and
execution; it says nothing about whether the bytes coming back are true.

```
ExecuteOutcome → raw string → JSON.parse → Ajv strict → projection → hub data
```

A rejected payload is never carried forward: not into a return value, not into a log line, not into
an exception message. Only the rule that rejected it and the offending field *name* survive.

**Threshold does not claim that prompt injection is impossible.** What it does is refuse to
propagate arbitrary provider-authored text through its WebMCP tool results. The stronger version of
that claim is structural: every field in every provider output contract is an enum, a boolean, an
integer, or a string under a pattern, so there is no free-form surface for an instruction to live
in. `tests/security/no-free-form-surface.test.ts` walks the whole contract registry and proves it,
and fails on purpose six ways so that its passing means something.

The malicious fixture tries four times. An added field is caught by `additionalProperties: false`,
an instruction in a `resource_id` by `^[A-Z]{1,3}[0-9]{1,4}$`, an instruction in a language list by
the enum. The fourth attempt sends a valid offer, because there is nowhere left to put a sentence.

### 4. The consent gate (`apps/hub/src/consent/controller.ts`)

`make_referral` returns a Promise that does not resolve on its own. It resolves when a person acts.

The judged environment already safety-reviews every tool invocation, so a panel whose only job is to
ask is the second dialog a person sees and adds nothing. What a host-level dialog structurally
cannot do is show the person the payload and let them **change it**. It can approve or refuse an
opaque call; it cannot offer to correct the phone number inside it. Editing is the reason this gate
exists.

Five events race for one Promise: Send, Cancel, the agent's `AbortSignal`, the lease lapsing, and a
provider failure. Exactly one may win. The one exception is that once Send is on the wire nothing
else may settle the panel, because a cancel cannot un-send a referral and reporting one as cancelled
would be a lie.

### 5. Order enforced by absence (`apps/hub/src/session/machine.ts`)

The tool surface is a function of state. `place_plan_holds` does not exist until `check_plan` has
returned feasible. `make_referral` does not exist until a lease does. `get_plan` does not exist
until a referral does. During `COMPENSATING`, when the hub is releasing other people's beds back to
them, no mutating tool is registered at all.

An agent cannot call step three before step two, because step three is not in its list.

Concurrency is handled by the state machine returning `STATE_CONFLICT`, **not** by unregistering a
tool during its own execution. That is the Chrome 153 in-flight-execution edge, and a host agent
that watches a tool vanish mid-conversation can behave in ways no local test reveals.

---

## Data boundaries

The user's free-form narrative is not an input to Threshold's search tools. The external agent
converts that narrative into a small capability vector. These typed requirements can still be
sensitive, so Threshold minimises them and sends only provider-relevant projections. Identifying
referral information is transmitted only after an explicit human confirmation step.

Two rules make that checkable rather than stated:

- **A capability a provider does not deal in is omitted, never sent as `false`.** A transport
  service is not told the person needs dementia-trained staff. Sending `false` would still disclose
  that the question was asked, and "does this person need same-gender staff: no" is information
  about the person.
- **The boundary log records field names and has nowhere to put a value.** `referralSent` takes a
  list of field names and has no parameter that could carry one, which is stronger than remembering
  not to pass one. A test asserts the person's name and phone number appear nowhere in it.

The hub has no database and no backend. Everything it knows lives in memory for the length of one
page visit. After the consent panel settles, the identifying values are dropped on every path,
including the successful one: the phone number exists at the organisation that needs it, and nowhere
in the coordinating page.

**A claim this project does not make.** The capability enums reconstruct a clinical picture fairly
precisely. This is narrative minimisation, verifiable by reading the schema. It is not impossibility.

---

## Hold semantics

A hold is a lease at the organisation, and the organisation is the authority on it (Invariant E).
The hub renders a countdown from the provider's absolute expiry and never treats its own arithmetic
as the truth.

- Acquisition is atomic within the provider's process: the read-modify-write in `LeaseStore.acquire`
  has no `await` inside the critical section, which is a real guarantee on a single-threaded runtime
  and is stated rather than assumed. Running more than one instance of a provider would break it,
  and the fix is a row lock, not a mutex. Recorded in `docs/THREAT_MODEL.md`.
- Expiry is decided at read time, not swept by a timer. A timer is a second source of truth about
  when a lease ended, and it drifts.
- `client_request_id` is derived from `(plan_id, role)`, so a retry after an ambiguous network result
  returns the existing lease instead of taking a second unit of something scarce.
- Before a referral is recorded, the provider re-checks the lease server-side. If it lapsed while
  the person was reading the panel, nothing is sent.

---

## Running it

```bash
pnpm install
pnpm dev        # seven processes: four web origins, three provider backends
```

| | |
|---|---|
| Hub | <http://localhost:5100> |
| Does federation work in this browser? | <http://localhost:5100/verify.html> |
| Meadowbank Respite Unit | <http://localhost:5101> |
| Selwyn Overnight Care | <http://localhost:5102> |
| Northgate Accessible Transport | <http://localhost:5103> |

### The three switches a judge should throw

Append `?control` to any provider URL, or to the hub's. Everything is behind a query flag on
purpose: a public button that takes a care provider offline, or makes one answer with an attack, is
not something to leave on a deployed page.

| Where | Control | What to watch |
|---|---|---|
| any provider `?control` | **Take this organisation offline** | The hub's panel turns unavailable because the *tool set changed*, not because a request failed. Search again: the other two answer, the missing role is named. |
| respite `?control` | **Answer with a hostile payload** | The hub refuses the whole response, names the rule and the field, keeps the other two, and prints none of the attacker's text. Check the DOM. |
| any provider `?control` | **Restore seeded availability** | Releases every hold that organisation holds. The hub cannot do this for them, and that is the point. |
| hub `?control` | **Forget this session** | Clears the search, the plan and the log. It does not touch anybody's inventory. |

Each switch reaches every open tab of *that origin only*, including the copy the hub has framed, over
a same-origin `BroadcastChannel`. One organisation cannot flip a switch inside another.

### Tests

```bash
pnpm test        # 180 tests, no browser
pnpm test:e2e    # 16 tests, four origins, a real browser
pnpm typecheck
```

The Node suite proves the hub's logic without a browser: the firewall, the links, the leases, the
compensation, the consent races. The browser suite proves the things it structurally cannot, which
is that the page works: four cross-origin frames really load, the consent gate can be completed with
a keyboard alone, an organisation can genuinely withdraw, two sessions genuinely contend for one
bed, and axe finds no WCAG 2.1 AA violation on any page in any state including the consent panel
with an error showing.

One of those tests earns its place by construction. Every other browser test reaches the handlers
through `window.threshold.core`, which skips the one step that exists only for agents: the
registered `execute` wrapper that `document.modelContext.executeTool` invokes. So one test calls the
tools the way an agent calls them and no other way — through `getTools` and `executeTool`, with the
arguments as a JSON string. A wrapper can be broken for every agent while the page itself works
perfectly, and that is not a failure any amount of clicking will find.

### Deploying it

Four origins on HTTPS, because WebMCP is secure-context only and cross-origin tools need an
origin-keyed document at both ends. One Docker image builds all four apps, selected by build
argument, and `render.yaml` brings the whole thing up as four services in one command.

```bash
render blueprint launch
```

The one thing that goes wrong: **origins are baked in at build time**, because `import.meta.env` is
read when the bundle is built. A deployment with stale origins does not error, it sits there timing
out on discovery. `/verify.html` prints the origins it actually reached, which makes that a
ten-second check. Full detail, including the header set and the one compromise in it, is in
`docs/DEPLOYMENT.md`.

Verified end to end before writing that down: four containers on four ports, real WebMCP federation
in Chrome 151, a plan composed and three leases taken across three origins, no console errors.

### Browser requirements

WebMCP needs a secure context and an origin-keyed document; both dev servers and the production
server send `Origin-Agent-Cluster: ?1`. Cross-origin tools additionally need `allow="tools"` from
the embedder and `exposedTo` from the embeddee.

Chrome 149+ with `chrome://flags/#enable-webmcp-testing` enabled, or the origin trial. Verified
working on **Chrome 151.0.7922.34**; see `docs/RUNTIME_TEST_MATRIX.md` for what was measured where.

**If your browser cannot do it, Threshold still runs.** The hub probes for cross-origin discovery
against a real provider origin at startup and falls back to a typed `postMessage` protocol reaching
the *same* provider apps on the *same* separate origins, with the same schemas, the same trust
firewall, the same leases and the same consent gate. Only the wire changes.

Whichever leg ran, the page says so in words, and it never calls the fallback WebMCP federation
(Invariant L). `/verify` prints the same verdict in ten seconds with no interaction.

---

## Known limitations

1. **A schema-valid lie is not detectable.** A provider can claim a hoist it does not have and every
   control here passes it, because the payload is well formed. WebMCP does not attest provider
   truthfulness and nothing in a browser can. The available control is labelling claims
   `self_asserted` or `directory_attested`, set by the hub from its registry so an organisation
   cannot promote its own claims. This is stated as unsolved.
2. **Lease atomicity is per process.** One provider instance, one event loop. Horizontal scaling
   needs a row lock or a Durable Object.
3. **The link vocabulary is seeded, not learned.** Five link kinds cover this scenario. A real
   deployment would find more, and the feasibility rules are only as good as the vocabulary.
4. **The provider inventories are hand-written, and there is a reason a real one is not among them.**
   §44 of the build plan specifies a fifth origin reading a pinned public HSDS snapshot, read-only
   and never holdable. A live Open Referral UK feed was checked while building this
   (`bristol.openplace.directory`, 874 services, HSDS v3). It carries organisation names, service
   areas and ESD taxonomies, and for these records it carries no accessibility data, no locations
   and no schedules. Nothing in it can source a hoist, a dementia-training claim or an admission
   window.

   Publishing those services would therefore mean inventing capability claims about **real care
   organisations**, which is the same category of harm as Invariant K's refusal to send them a
   referral they never agreed to receive. So it is not built, and the reason is that the honest
   version of it needs a source that records accessibility, not that it was cut for time.
5. **Compensation can leave a lease stranded** when a provider is unreachable during the unwind. It
   is reported as `unreachable` rather than released, and the TTL frees it within twenty minutes.

---

## Repository

```
packages/contracts        JSON Schema as the single source of truth; types via FromSchema, Ajv
                          validates the same objects. No hand-written second copy of anything.
packages/webmcp-adapter   Every document.modelContext call in the project. Ambient IDL types,
                          registration, tool lifecycle, per-origin discovery, executeTool with the
                          null branch, both transports, the provider host.
packages/domain           Projection, normalisation, matching, composition, ranking, ids. Pure.
packages/lease-store      Provider-side authority: atomic acquire, TTL, idempotency, conversion.
packages/provider-kit     The four-tool provider contract, implemented once.
packages/test-fixtures    Seeded inventories and named scenarios, shared by tests, apps and film.
apps/hub                  The coordinating page.
apps/provider-*           Three organisations, three origins, three backends.
tests/unit                Contracts, composition, matching, leases, tool surface.
tests/integration         The hub against real provider handlers and real lease stores.
tests/security            The structural no-free-form-surface proof.
tests/e2e                 The real pages in a real browser, plus the axe audit.
docs/THREAT_MODEL.md      What is controlled, and what is not.
docs/RUNTIME_TEST_MATRIX.md   What each browser actually did.
docs/DEPLOYMENT.md        Four origins, the headers, and what breaks if they are stale.
Dockerfile, render.yaml   One image, four apps; four services, one command.
```

## Threat model

`docs/THREAT_MODEL.md`. It includes the threats this architecture does not solve, named as such.

## Licence

MIT. See `LICENSE`.
