# Runtime test matrix

What each browser actually did, measured, with the date. Not what the specification says, and not
what a user-agent string implies.

The distinction that matters throughout: **the hub's federation leg is executed by the hub's own
JavaScript, not by the agent.** An agent being able to see the hub's tools tells you nothing about
whether the hub can reach a provider's. Those are two capabilities and they are probed separately.

## Results

| | Chrome 151.0.7922.34 (Playwright Chromium, `--enable-features=WebMachineLearningModelContext,WebMCPTesting`) |
|---|---|
| Measured | 2026-08-27 |
| `document.modelContext` | present |
| `registerTool` | works |
| `registerTool` with `exposedTo` | works |
| `registerTool` with `signal` (abort unregisters) | works |
| `getTools()` same-origin | works |
| `getTools({ fromOrigins })` cross-origin | **works** |
| `executeTool` cross-origin | **works** |
| Argument encoding accepted | **JSON string only** |
| `ontoolchange` on a cross-origin withdrawal | works |
| `RegisteredTool.origin` populated | yes |
| Transport selected | `webmcp` |
| Full golden path | passes |

Reproduce with `pnpm test:e2e`, or open <http://localhost:5100/verify.html> in any browser and read
the verdict.

## Two findings worth reporting

### 1. `getTools({ fromOrigins: [X] })` also returns the calling document's own tools

`fromOrigins` widens the default allowlist of `['self']` rather than replacing it. Querying one
provider origin from the hub returned five tools where the provider publishes four; the fifth was
the hub's own `find_support`.

Left alone this is not cosmetic. The hub and every provider both publish a tool named
`release_hold`, so excluding by name would drop a real provider tool, and attributing the hub's own
tools to a provider origin would make `/verify` print a false statement about federation on the one
page whose entire job is to be true.

Chrome does populate `RegisteredTool.origin`, so discovery filters on it and falls back to the
queried origin where the field is absent. That fallback is correct only because discovery queries
one origin at a time, which was already the design for indexing reasons.

Measured in `tests/e2e`, handled in `packages/webmcp-adapter/src/discover.ts`.

### 2. `executeTool` rejects the IDL's `object` form

The IDL declares `optional object inputObject`. Chrome's prose says arguments are passed as a valid
JSON string. Passing an object produced:

```
executeTool retrying with json-string encoding after: Failed to parse input arguments
executeTool accepted arguments as json-string
```

The adapter tries the IDL form, falls back once on a shape-related failure, and latches whichever
worked so the cost is paid once per session. The latch value is reported on `/verify`.

The retry is deliberately narrow: it fires only on failures that look like the browser disagreeing
about the argument *shape*, never on a provider's legitimate validation failure. Retrying a clean
rejection would turn one refusal into two calls, and against a mutating tool that is worse than
confusing.

Handled in `packages/webmcp-adapter/src/execute.ts`.

## Not yet measured

| Runtime | Why it matters | Status |
|---|---|---|
| Chrome stable with the origin trial token | The deployment path, as opposed to the local flag | not run |
| ChatGPT desktop in-app browser | The challenge tells judges they may use it, and nothing published confirms it exposes `getTools`/`executeTool` to page script | **not run.** This is the reason the `postMessage` fallback exists |
| Chrome 153+ | Changes in-flight execution behaviour when a tool is unregistered mid-call | not run. Threshold never unregisters during execution (§13.3), so it should not be exposed to this |
| Safari, Firefox | No WebMCP | expected to take the fallback; `/verify` will say so |

If a runtime lacks page-script federation, that is a platform finding worth reporting rather than
hiding. The fallback keeps the product working and the page keeps saying which leg ran.

## The `null` branch

`executeTool` is declared `Promise<DOMString>` and returns `null` when the call triggers a
navigation. Not observed in these runs, because no provider tool navigates. It is handled as a
contract violation rather than an empty success: read as "the provider answered with nothing", a
`null` silently deletes an organisation from a person's options.

Covered by a unit test against the firewall directly (`tests/integration/firewall.test.ts`), since
provoking a real navigation mid-call would only assert the harness.
