# TUI sidebar status indicator — design

**Status:** approved design, 2026-11-03
**Issue:** #29 — OpenCode TUI minimal status
**Related:** ADR-0008 (rich metrics panel deferred), ADR-0011 (explicit initialization gate; its pre-init surface list is amended by this design)

## Goal

Show a minimal, read-only memory status line in the OpenCode TUI sidebar so a
user can see at a glance whether this project's memory is installed, healthy,
waiting for review, or needs attention. Before initialization, the line is the
persistent in-TUI reminder to run `/memory-init`. Users who do not want the
line can remove the plugin from their config.

## Non-goals

- A rich TUI metrics panel, dashboard, or interactive page. ADR-0008 keeps
  that deferred.
- Per-session memory state. Memory is project-scoped; the line is project-wide.
- Click actions, keybindings, or automatic `/memory-init`.
- Memory file reads or writes from the TUI process.
- New metrics counters, storage keys, memory files, or model-facing tools.
- Consuming or reordering status-line notices.
- Changing the existing five server behavior options.

## Locked decisions

1. **One line in `sidebar.footer`.** The TUI part appends one passive status
   line. It never wraps, expands, or takes over another slot.
2. **Four states with fixed precedence.** `not-initialized` > `attention` >
   `pending` > `healthy`.
3. **Read-only RPC snapshot.** The TUI asks the server part for a bounded
   `{ state, pending }` snapshot through a typed RPC method. The TUI does not
   read memory files or the ledger directly.
4. **No visibility option.** The line renders whenever the plugin is installed.
   (A TUI-only `showSidebarStatus` option was specified originally and removed
   after live-host verification: OpenCode 2.2.5 does not deliver package
   `options` to TUI plugin parts, so the flag could never take effect.)
5. **Hidden means absent.** When the plugin is not installed, no slot exists —
   no polling, no RPC calls, no blank row or placeholder.
6. **No writes and no new vocabulary.** The RPC handler reads existing
   initialization state, line counts, notices, and the pending counter. It
   never calls `set`, `remove`, `takeNotice`, `takeRotated`, or a metric bump.
7. **Fail closed visually.** If the snapshot cannot be obtained or validated,
   or the request stalls past its timeout, the line is hidden. The TUI never
   shows a stale `healthy` claim.
8. **Pending means `pending > 0`.** The existing prompt review-due nudge at
   `pending >= 5` is unchanged; the sidebar does not add a second threshold.

## UX contract

### Placement

`context.ui.slot({ append: "sidebar.footer", render: ... })`.

The footer is status furniture, so the line does not disturb sidebar content
ordering or compete with session rows. It is project-scoped: switching sessions
within one project shows the same state.

### States

| State | Condition | Label | Theme tone |
| --- | --- | --- | --- |
| `not-initialized` | `.opencode/memory/INDEX.md` is not an existing regular file. | `○ memory · run /memory-init` | `text.feedback.warning.base` |
| `attention` | Initialized, and at least one actionable problem exists (see below). | `▲ memory · needs attention` | `text.feedback.error.base` |
| `pending` | Initialized, no attention state, and `curation.pending > 0`. | `◐ memory · {n} pending` | `text.feedback.warning.base` |
| `healthy` | Initialized, INDEX is within cap and inspectable, no actionable notice, pending is zero. | `● memory · healthy` | `text.feedback.success.base` |

`{n}` is the decimal pending count. The line uses one `<text>` element with
`wrapMode: "none"` and is clipped by the host if the footer is narrower than
the label. The prefix `memory` is fixed.

Theme tones name the `.base` RGBA tokens on `context.theme`; for example,
`context.theme.text.feedback.warning.base`. The TUI passes that color to
`<text fg={...}>`. The bare token object is not a color value.

### Actionable attention signals

`attention` wins over `pending` when any of these is true:

- `INDEX.md` cannot be line-counted (missing after initialization or
  unreadable), or its line count is greater than the configured `indexLines`.
  A too-large file is reported by `indexLineCount` as `indexLines + 1` and
  therefore also counts as over-cap.
- The unconsumed `indexOverCap` notice count is greater than zero.
- The unconsumed `indexStale` notice count is greater than zero.
- The unconsumed `captureFailed` notice count is greater than zero.

The `forgotten` and `rotated` notices are informational and do not produce
`attention`.

### Visibility

The line is always shown while the plugin is installed. No visibility flag
exists: live verification on OpenCode 2.2.5 shows package `options` are
delivered to the server part but arrive as `{}` for TUI plugin parts, so a
TUI-only option could never take effect (see ADR-0012). To hide the line,
remove the plugin from your config. The server's `parseMemoryOptions` continues
to ignore unknown keys, so the five-option contract is unchanged.

## State derivation

The server collector gathers existing facts and applies one pure precedence
function. It never derives state from prose or file contents.

The collector checks `isInitialized` first. When it is false, the collector
returns `{ state: "not-initialized", pending: 0 }` without reading storage;
every storage-backed fact below is gathered only after initialization.

| Fact | Source | Notes |
| --- | --- | --- |
| initialized | `isInitialized(memoryRoot)` | Existing regular-file probe for `INDEX.md`. Never throws. |
| index line count | `indexLineCount(join(memoryRoot, "INDEX.md"), memoryRoot, indexLines)` | Returns `undefined` for missing/unreadable files and `indexLines + 1` when the line or byte cap is hit (treated as over-cap). |
| pending | `getPending(storage, projectID)` | Existing counter; invalid values coerce to `0`. |
| over-cap notices | `getNotice(storage, projectID, "indexOverCap")` | Read only; not consumed. |
| stale pointers | `getNotice(storage, projectID, "indexStale")` | Read only; not consumed. |
| failed captures | `getNotice(storage, projectID, "captureFailed")` | Read only; not consumed. |

The pure snapshot function:

```ts
type SidebarState =
  | "not-initialized"
  | "healthy"
  | "pending"
  | "attention";

interface SidebarFacts {
  readonly initialized: boolean;
  /**
   * True only when INDEX was read after initialization and its line count is
   * within the cap. False for missing, unreadable, over-cap, or too-large
   * INDEX files.
   */
  readonly indexWithinCap: boolean;
  readonly overCapNotices: number;
  readonly stalePointers: number;
  readonly failedCaptures: number;
  readonly pending: number;
}

interface SidebarSnapshot {
  readonly state: SidebarState;
  readonly pending: number;
}

function deriveSidebarSnapshot(facts: SidebarFacts): SidebarSnapshot;
```

Rules, in order:

1. If `initialized` is false, return
   `{ state: "not-initialized", pending: 0 }`. The collector guarantees this
   branch is reached without reading storage.
2. If `indexWithinCap` is false, return
   `{ state: "attention", pending: facts.pending }`.
3. If `overCapNotices`, `stalePointers`, or `failedCaptures` is greater than
   zero, return `{ state: "attention", pending: facts.pending }`.
4. If `pending > 0`, return `{ state: "pending", pending: facts.pending }`.
5. Otherwise return `{ state: "healthy", pending: 0 }`.

The snapshot always includes `pending`, even when the state is `attention` or
`not-initialized`; the label renderer uses it only for `pending`. The
`not-initialized` branch reports `0` because it does not read storage; the
`attention` and `pending` branches carry the observed counter.

## Architecture

### Package surface

Add a TUI part and a shared RPC contract beside the existing server part:

```jsonc
{
  "exports": {
    ".": "./src/index.ts",
    "./rpc": "./src/rpc.ts",
    "./tui": "./src/tui.tsx"
  }
}
```

The package already ships `src/` via `files`. Add runtime peers for the host's
TUI stack, aligned with `@opencode/plugin` 2.0.29:

- `@opencode/theme` `2.0.29` (TUI context/theme types; optional, like the host's own peer)
- `@opentui/core` `>=0.5.17`
- `@opentui/solid` `>=0.5.17`
- `solid-js` `>=1.9.0`

Add matching dev dependencies for local typechecking and tests, including
`@opencode/theme` for the TUI context type surface. Enable JSX typechecking
with:

```jsonc
{
  "jsx": "preserve",
  "jsxImportSource": "@opentui/solid"
}
```

### New modules

| Module | Responsibility |
| --- | --- |
| `src/rpc.ts` | `Rpc.define` contract for `nexusnv.memory.sidebarStatus`. Shared by server and TUI. |
| `src/sidebar.ts` | Pure state types, `deriveSidebarSnapshot`, `renderSidebarLabel`, and `isSidebarSnapshot`. No fs/storage imports. |
| `src/sidebar-poll.ts` | Testable polling state machine for the TUI status line: immediate/5-second polls, 4-second abort timeout, trailing event refresh, and cleanup. No Solid, fs, or storage imports. |
| `src/sidebar-status.ts` | Server collector (`collectSidebarStatus`) and RPC registration (`registerSidebarRpc`). Imports the existing init, brief, and ledger helpers. |
| `src/tui.tsx` | TUI plugin definition, footer slot, Solid status-line component, poller wiring, and cleanup. |

### RPC contract

One read-only method with a bounded output:

```ts
import { Rpc } from "@opencode/plugin/rpc";

export const MemoryRpc = Rpc.define({
  id: "nexusnv.memory",
  methods: {
    sidebarStatus: {
      input: {
        type: "object",
        properties: {},
        required: [],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          state: {
            type: "string",
            enum: ["not-initialized", "healthy", "pending", "attention"],
          },
          pending: { type: "integer", minimum: 0 },
        },
        required: ["state", "pending"],
        additionalProperties: false,
      },
    },
  },
  events: {},
});
```

The server registers the handler during `setup` and adds the returned
registration to the existing `registrations` array so cleanup disposes it.
The handler closes over the plugin context and the already-parsed
`indexLines` option. It returns the snapshot or rejects on storage failure.

The TUI calls with a request signal (a short timeout combined with the
component's unmount signal) so a stalled RPC cannot leave the line stale:

```ts
context.client.rpc(MemoryRpc).sidebarStatus({}, {
  location: context.location ?? context.data.location.default(),
  signal: requestSignal,
});
```

RPC validation failure, transport failure, timeout/abort, or a rejected handler
all follow the same TUI path: clear the rendered snapshot and hide the line
until a later successful poll.

### Wiring

- `src/index.ts`: after the existing tool/command registrations, register the
  sidebar RPC. No hook guard changes; the status method must work before and
  after initialization.
- `src/tui.tsx`:

```ts
export default Plugin.define({
  id: "memory.tui",
  setup(context) {
    const unregister = context.ui.slot({
      append: "sidebar.footer",
      render: () => <MemoryStatusLine context={context} />,
    });
    return () => unregister();
  },
});
```

The component owns its lifecycle:

1. Fetch immediately.
2. Poll every 5 seconds while mounted.
3. Refresh immediately on `session.synthetic` and `session.idle`.
4. Guard against overlapping fetches. Each fetch carries a request signal that
   aborts on a short timeout (4 seconds) or when the component is disposed,
   and the in-flight guard clears in `finally`.
5. Clear the interval, abort the in-flight request, unsubscribe the event
   listeners, and ignore late results after cleanup.

Each mounted footer line owns its own poll. The snapshot is project-wide, so
multiple sessions or TUI instances cannot corrupt each other.

### Data flow

```text
TUI setup
  -> register sidebar.footer
  -> component mounts
  -> RPC nexusnv.memory.sidebarStatus(location, signal)
  -> server collector checks initialization first
  -> uninitialized? return not-initialized without storage
  -> initialized? read INDEX state, line count, pending, notices
  -> { state, pending }
  -> TUI renders one line
  -> poll / session.synthetic / session.idle refresh
```

### Error handling

- The collector checks `isInitialized` first; an uninitialized project returns
  `not-initialized` without reading storage, so the pre-init reminder survives
  a storage outage.
- `isInitialized` and `indexLineCount` already fail closed and never throw.
- `getPending` / `getNotice` rejections propagate through the RPC handler for
  initialized projects.
- The TUI catches every rejection and timeout/abort, clears the snapshot, and
  renders nothing.
- Each fetch has a timeout and unmount abort; the in-flight guard clears in
  `finally`, so a stalled request cannot disable later polls.
- Late responses after unmount are ignored.
- The server handler never writes, never consumes notices, and never bumps
  metrics.
- A disposed indicator clears its interval and timers, aborts the in-flight
  request, and ignores late responses.

## Test plan

### Unit tests

`test/sidebar.test.ts`:

- `deriveSidebarSnapshot`: every precedence combination, including
  initialization beating pending, over-cap beating pending, notices beating
  pending, and pending beating healthy.
- `renderSidebarLabel`: exact text and tone for all four states; pending count
  is rendered only for `pending`.
- `isSidebarSnapshot`: exactly the four states with a non-negative integer
  `pending`; malformed payloads are rejected.

`test/sidebar-poll.test.ts`:

- Valid payloads publish; invalid payloads clear the snapshot.
- Start is idempotent; the first fetch is immediate and the interval follows.
- A stalled request hides the line at the timeout, releases the in-flight
  guard, and recovers on a later poll.
- Event refreshes during an in-flight request coalesce into one trailing poll.
- A late result from an aborted request cannot overwrite a newer snapshot.
- Disposal clears timers, aborts the request, and ignores late results.

`test/sidebar-status.test.ts`:

- Temp memory root + fake `LedgerStorage`.
- Not-initialized returns `{ state: "not-initialized", pending: 0 }` without
  reading storage. A fake whose reads reject still yields the pre-init
  reminder, proving the storage short-circuit.
- Healthy when INDEX is within cap, pending is zero, and no actionable notice
  exists.
- Pending count is returned unchanged.
- Over-cap INDEX, unreadable INDEX, `indexOverCap`, stale-pointer, and
  failed-capture inputs each produce attention.
- Rotated and forgotten notices are ignored.
- Notices remain readable after collection (not consumed).
- The collector performs no `set` or `remove`.
- Storage rejection propagates.
- RPC registration wires the handler and returns the same snapshot.

### TUI verification

Vitest does not host the OpenTUI renderer faithfully. The TUI adapter stays
thin; its pure label/validator logic and its polling state machine are
unit-tested, and the slot/RPC wiring is covered by typecheck plus a local smoke
check:

1. Fresh project → `○ memory · run /memory-init`.
2. Run `/memory-init` → `● memory · healthy` without a long delay.
3. Capture a failing shell/build/test output → `◐ memory · 1 pending`.
4. Push `INDEX.md` over its cap → `▲ memory · needs attention`.
5. Plugin removed from the config → no line and no blank footer space.
6. No visibility flag exists by design: the line is never hidden except on
   failure (fail closed), and no option-based toggle can be provided while
   package options do not reach TUI plugin parts.
7. Two projects open → each footer follows its own location.
8. Stop/unload the server plugin → the line hides rather than showing a stale
   state.
9. Stall or block the RPC → the line hides after the timeout, then returns on a
   later successful poll rather than staying disabled.

### Existing suites

`setup()` registers the sidebar RPC unconditionally, because the method must
work before and after initialization and the TUI is a separate plugin. Every
existing setup fake therefore needs an `rpc.register` stub whose result has
the full registration surface (`dispose` and `events.emit`), or a narrow cast
at the fake boundary. The known fakes are:

- `test/hooks.test.ts` (`setupHooks`)
- `test/review.test.ts` (`fakeForSetup`)
- `test/scaffold.test.ts` (inline setup contexts)
- `test/isolation.test.ts` (wiring and gated-event fakes)
- `test/acceptance-metrics.test.ts`

`npm test` is the gate that proves none were missed. Do not make registration
conditional on `ctx.rpc` being present; a missing RPC would silently drop the
indicator instead of failing the host contract.

- `npm run typecheck`
- `npm test`
- `npm run test:coverage`

The existing coverage thresholds must remain met. The new pure modules are
fully unit-tested. The `.tsx` adapter falls outside the existing
`src/**/*.ts` coverage glob and is verified by the smoke check above instead.

## Documentation updates

- New ADR `docs/adr/0012-tui-sidebar-status.md`, recording the precondition,
  fail-closed rules, and the read-only RPC exception.
- Amend ADR-0011's pre-init surface list: add the read-only
  `nexusnv.memory.sidebarStatus` RPC and state that it returns
  `not-initialized` without storage reads, writes, or injection. This is a
  status probe, not an operation, so it does not weaken the init gate.
- This spec.
- `docs/design-spec-v2-production.md`:
  - Add a concise sidebar-status contract.
  - Update §8 D-G and §10 to distinguish this minimal indicator from the
    still-deferred rich metrics panel.
- `docs/c4-03-components.md`, `docs/c4-04-interfaces.md`, and
  `docs/c4-06-code.md`: add the TUI part, RPC method, slot claim, and new
  source modules.
- `README.md`: indicator states and troubleshooting (missing line means the
  TUI part or RPC is unavailable).
- `CHANGELOG.md`: unreleased entry.
- `docs/user-stories.md`: one user story and one harness story.

## Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| `context.options` is not delivered through some TUI load path. | Confirmed on OpenCode 2.2.5: package options reach the server part but not the TUI part, so the visibility option was removed and the line is always shown; fail-closed visuals cover hide-on-failure. Hiding is achieved by removing the plugin. |
| OpenTUI peer drift. | Declare the peer ranges, typecheck against the host versions, and smoke-test the published package shape. |
| RPC location routing sends the wrong project state. | Always pass `context.location`; verify with two open projects. |
| Attention is transient because the prompt status line consumes notices. | Document that the sidebar is a read-only mirror; the status line remains the actionable report. |
| Polling cost or leaked intervals. | One 5-second read-only call per mounted line; cleanup clears the timer and subscriptions. |
| RPC hangs or never settles. | Each call aborts after 4 seconds; the in-flight guard clears in `finally` so the next poll can recover. |
| Scope creep into a dashboard. | The line is passive, single-state, and bounded to `{ state, pending }`; the rich panel stays deferred. |

## Acceptance criteria

- `sidebar.footer` shows exactly one of the four fixed lines after a successful
  snapshot.
- State precedence is deterministic and matches the table above.
- An unconsumed `indexOverCap` notice produces `attention`, like the stale and
  failed-capture notices.
- `/memory-init` makes the line move from not-initialized to healthy/pending
  without restarting the TUI.
- Pre-init collection performs no storage reads; a storage outage cannot hide
  the `/memory-init` reminder.
- A stalled or failed RPC hides the line, and a timed-out request does not
  disable later polls.
- The line hides on an invalid, rejected, or timed-out snapshot, and a later
  successful poll recovers it.
- The server still accepts exactly the five existing behavior options; unknown
  keys are ignored silently.
- No memory file, ledger key, metric, or notice is written or consumed by the
  indicator.
- The full test suite, typecheck, and coverage gates pass, including the
  updated setup fakes.

## Alternatives considered

- **TUI-only filesystem probe.** Rejected because `curation.pending` and the
  notice markers live in server storage; the probe would lose two of the four
  states or approximate them from files.
- **RPC push events after every write.** Rejected for this minimal indicator:
  it would instrument init, capture, apply, review, forget, and external edits
  to save at most five seconds of latency.
- **A TUI-only visibility option (`showSidebarStatus`).** Specified originally,
  removed after live-host verification: OpenCode 2.2.5 delivers package
  `options` to the server part but not to TUI plugin parts (the TUI receives
  `{}`), so the flag could never take effect. A toggle that silently does
  nothing is worse than none. Hiding is instead achieved by removing the
  plugin; absence means no blank row and no traffic.
- **Showing a fifth `unavailable` state.** Rejected to keep the line honest
  and minimal: no data means no line, not a new visible state.

## Open questions

None.
