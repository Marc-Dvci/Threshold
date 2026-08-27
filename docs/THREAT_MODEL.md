# Threat model

Threshold coordinates care arrangements for people who cannot arrange them for themselves, across
organisations that do not trust each other and cannot see each other. This document says what is
controlled, how, and what remains.

The last four rows are the ones worth reading. An entry that lists only threats it defeats has not
finished thinking.

## Assets

| Asset | Why it matters |
|---|---|
| The person's identifying details | Name and contact route for someone who is unwell. The only data that ever crosses an origin with a name attached. |
| The person's capability profile | Typed, but it reconstructs a clinical picture. Dementia, hoist, overnight supervision, language. |
| Scarce inventory | One bed, one accessible van at six in the morning. A lease taken wrongly is taken from somebody. |
| The agent's context window | Anything a provider can put in front of a model is an instruction channel. |

## Trust boundaries

1. **agent → hub.** Tool input from a language model. Never trusted, always validated. An identifier
   from a model is a lookup key, never a source of facts.
2. **hub → provider.** Outbound projection. Validated before it leaves, so a hub bug fails at the
   boundary with the field named rather than as three separate provider rejections.
3. **provider → hub.** *The* trust boundary. Data authored outside this system, by an organisation
   whose incentives are its own.
4. **hub → person.** The consent panel. The one place identifying data is staged, and it is staged
   in memory for as long as the panel is open.

## Threats and controls

| Threat | Control | Residual risk |
|---|---|---|
| A provider returns model instructions | Strict output schema with `additionalProperties: false` at every layer, plus projection onto the hub's own types. No unconstrained string exists in any provider output contract, which is asserted structurally over the whole registry rather than tested attack by attack. | A browser agent may still read human-visible web content outside this WebMCP result path. Threshold governs its own tool results and claims nothing wider. |
| A provider hides an instruction in an identifier or a list | `resource_id` is `^[A-Z]{1,3}[0-9]{1,4}$`; `spoken_languages` is an array of enums with `maxItems`; `provider_id` is an enum; `generated_at` is a bounded `date-time`. | None known for these fields. Adding a fifth provider output contract without constraining its strings fails a test. |
| A provider authors the failure path instead | `error_code` is an enum, not a message. The hub owns every sentence a person reads. | A provider can choose *which* error to report, and therefore influence what a person is told, within a fixed vocabulary. |
| An agent submits an unexpected search field | Ajv strict, `additionalProperties: false`, no coercion, no partial acceptance. | Typed capability data is still sensitive. Minimisation, not impossibility. |
| A cross-origin tool is exposed to the wrong hub | Exact `exposedTo` allowlist at the provider, `allow="tools"` at the embedder, secure origins only. Wildcards are rejected at registration. | Compromise of the hub origin defeats this, as it defeats everything. |
| The hub misattributes a tool to the wrong origin | Discovery queries one origin at a time and filters on `RegisteredTool.origin`; the index is keyed by `(origin, name)`. Chrome returns the calling document's own tools alongside the requested origin's, and `release_hold` exists at both, so name-based handling would be wrong. | A browser that populates neither `origin` nor a per-origin result would degrade to trusting the query. |
| A provider claims to be another provider | `provider_id` comes from the registry entry the hub called, never from the payload, even when the payload validates. | None. The mismatch is logged because a provider disagreeing with its own origin is worth knowing. |
| Double booking | Provider-authoritative atomic hold. The read-modify-write has no `await` in its critical section, which is a real guarantee on a single-threaded runtime. TTL expiry decided at read time. | **One process per provider.** Horizontal scaling breaks the guarantee, and the fix is a row lock or a Durable Object, not a mutex in that file. |
| A retry after an ambiguous network result takes a second unit | `client_request_id` derived from `(plan_id, role)`, so the provider returns the lease it already granted. | A provider implementing idempotency incorrectly. The hub cannot verify another organisation's storage. |
| A referral is sent without deliberate human action | The tool's Promise does not resolve until a person acts. The provider re-checks the lease server-side before recording anything. | The host agent may add its own confirmation. That is a second dialog, and this gate's value is the editing, not the asking. |
| A duplicate referral after a retry | Idempotency key on conversion; a second attempt returns the first referral. | As above, at the provider. |
| Identifying data leaks into a log | The boundary log's typed entry points take field *names*. There is no parameter on any of them that could carry a value. | Developer mistake in a new entry point. A test asserts the seeded name and phone number appear nowhere in the log after a full referral. |
| A rejected payload leaks through an error message | `ContractError` carries a JSON Pointer and a keyword. Ajv's `data` and its interpolated message are dropped. A non-identifier property name is reported as `<non-identifier>` rather than echoed. | None known. |
| An agent calls a tool that no longer applies | Dynamic registration by state, plus a server-side state check returning `STATE_CONFLICT` with the current state named. The registration rule and the refusal rule are computed from one table. | A race between a state change and an in-flight execution. Handled by refusing, never by unregistering mid-execution. |
| A cancel arrives after Send is on the wire | Once a submission is in flight, no other event may settle the panel. | The person waits for the provider's answer. Reporting a cancel would say nothing was sent when it had been. |
| **A provider returns a schema-valid lie** (`hoist_available: true`, no hoist) | **None available in this architecture.** Surfaced as `self_asserted` versus `directory_attested`, set by the hub from its registry so an organisation cannot promote its own claims. | **Unsolved, and stated as unsolved.** WebMCP does not attest provider truthfulness and nothing in a browser can. A person arrives to find no hoist. |
| **A lease is stranded when a plan fails and a provider is unreachable during unwind** | Compensation reports it as `unreachable` rather than released. The provider-authoritative TTL expires it regardless. | The resource is blocked from other people until its TTL elapses, up to twenty minutes. |
| The hub page runs injected script | A Content-Security-Policy naming its own origin, plus `frame-src` limited to the three registered provider origins and `frame-ancestors 'none'`. | **`script-src` allows `unsafe-eval`.** Ajv compiles each schema into a validator with `new Function` at module load, and without the allowance the page does not boot at all. Ajv standalone code generation would remove it, at the cost of the browser running validators the test suite never executes unless the codegen is wired into the test pipeline too. Named here rather than left in a header nobody reads. |
| **Federation is unavailable in the judged browser** | A typed `postMessage` transport reaching the same provider apps on the same separate origins. Selected by probing a real origin, never by a version string. | The fallback is not WebMCP. The page and `/verify` say which leg ran, in words, every time. |
| **An agent composes a plan whose legs individually pass but jointly do not** | Deterministic joint feasibility in `check_plan`, not model judgement. Every failing link names the field, the requirement, the offer and the organisation to renegotiate with. | The rules are only as good as the seeded link vocabulary. Five kinds cover this scenario; a real deployment would find more. |

## What is out of scope

- **Authentication and authorisation.** There are no accounts. A deployment would need both, and the
  referral path is where they would go.
- **The agent itself.** Threshold does not control what model the person uses or what it does with
  what it is told. It controls what it hands over.
- **Provider-side security.** Each organisation's backend is its own. The hub reaches providers
  through WebMCP or the bridge, never by calling their APIs across origins, and the provider APIs
  emit no CORS headers so that this stays true by construction.
- **Denial of service.** Per-call timeouts and a bounded fan-out keep one slow organisation from
  stalling a person's search. Nothing here defends a provider against load.

## Invariants asserted by tests

| | Invariant | Where |
|---|---|---|
| A | No hub search schema contains a free-form narrative field | `tests/security` |
| B | Every external input and output is validated before use | `tests/unit/contracts.test.ts` |
| C | Provider-authored text does not propagate | `tests/integration/firewall.test.ts` |
| D | Identity disclosure is gated on a human action | `tests/integration/consent.test.ts` |
| E | Hold truth is server-side | `tests/unit/lease-store.test.ts` |
| F | A scarce resource has one active holder | `tests/e2e/hub.spec.ts` |
| G | Tools reflect state | `tests/unit/tool-surface.test.ts` |
| H | One provider's failure is isolated | `tests/integration/firewall.test.ts` |
| I | No lease outlives its plan | `tests/integration/orchestration.test.ts` |
| J | Plan feasibility is deterministic and explained | `tests/unit/composition.test.ts` |
| K | Real organisations are read-only | enforced in `place_hold` and the orchestrator |
| L | The judged path is named honestly | `/verify`, and the transport badge on the page |
