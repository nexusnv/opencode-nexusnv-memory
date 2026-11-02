# TUI sidebar status indicator — design

**Status:** approved design, 2026-11-03
**Issue:** #29 — OpenCode TUI minimal status
**Related:** ADR-0008 (rich metrics panel deferred), ADR-0011 (explicit initialization gate)

## Goal

Show a minimal, read-only memory status line in the OpenCode TUI sidebar so a
user can see at a glance whether this project's memory is installed, healthy,
waiting for review, or needs attention. Before initialization, the line is the
persistent in-TUI reminder to run `/memory-init`. Users who do not want the
line can hide it entirely.

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
4. **TUI-only visibility option.** `showSidebarStatus` defaults to `true` and
   is parsed only by the TUI part. The server keeps exactly five behavior
   options (`indexLines`, `fileLines`, `injectBudgetLines`, `captureFailures`,
   `snapshotThrottleMinutes`).
5. **Hidden means absent.** `showSidebarStatus: false` registers no slot,
   starts no polling, and makes no RPC calls. No blank row or placeholder
   remains.
6. **No writes and no new vocabulary.** The RPC handler reads existing
   initialization state, line counts, notices, and the pending counter. It
   never calls `set`, `remove`, `takeNotice`, `takeRotated`, or a metric bump.
7. **Fail closed visually.** If the snapshot cannot be obtained or validated,
   the line is hidden. The TUI never shows a stale `healthy` claim.
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
| `not-initialized` | `.opencode/memory/INDEX.md` is not an existing regular file. | `○ memory · run /memory-init` | `text.feedback.warning` |
| `attention` | Initialized, and at least one actionable problem exists (see below). | `▲ memory · needs attention` | `text.feedback.error` |
| `pending` | Initialized, no attention state, and `curation.pending > 0`. | `◐ memory · {n} pending` | `text.feedback.warning` |
| `healthy` | Initialized, INDEX is within cap and inspectable, no actionable notice, pending is zero. | `● memory · healthy` | `text.feedback.success` |

`{n}` is the decimal pending count. The line uses one `<text>` element with
`wrapMode: "none"` and is clipped by the host if the footer is narrower than
the label. The prefix `memory` is fixed.

### Actionable attention signals

`attention` wins over `pending` when any of these is true:

- `INDEX.md` line count is greater than the configured `indexLines`, or the
  file exists but cannot be line-counted (unreadable or too large to inspect).
- The unconsumed `indexStale` notice count is greater than zero.
- The unconsumed `captureFailed` notice count is greater than zero.

The `forgotten` and `rotated` notices are informational and do not produce
`attention`.

### Visibility option

The TUI part reads `context.options.showSidebarStatus`:

| Value | Behavior |
| --- | --- |
| missing or `true` | Register the footer slot. |
| `false` | Register nothing: no slot, no polling, no RPC calls. |
| any other value | Warn once and fall back to `true`. |

The option is only read by the TUI part. The server's `parseMemoryOptions`
continues to ignore unknown keys, so the same `options` object can carry both
surfaces without expanding the five-option contract.

Configuration example:

```jsonc
{
  "plugins": [
    {
      "package": "opencode-nexusnv-memory",
      "options": {
        "showSidebarStatus": false
      }
    }
  ]
}
```

## State derivation

The server collector gathers existing facts and applies one pure precedence
function. It never derives state from prose or file contents.

| Fact | Source | Notes |
| --- | --- | --- |
| initialized | `isInitialized(memoryRoot)` | Existing regular-file probe for `INDEX.md`. Never throws. |
| index line count | `indexLineCount(join(memoryRoot, "INDEX.md"), memoryRoot, indexLines)` | Returns `undefined` for missing/unreadable/too-large files. Initialization is checked first. |
| pending | `getPending(storage, projectID)` | Existing counter; invalid values coerce to `0`. |
| stale pointers | `getNotice(storage, projectID, "indexStale")` | Read only; not consumed. |
| failed captures | `getNotice(storage, projectID, "captureFailed")` | Read only; not consumed. |

The pure state function:

```ts
type SidebarState =
  | "not-initialized"
  | "healthy"
  | "pending"
  | "attention";

interface SidebarFacts {
  readonly initialized: boolean;
  /** True only when INDEX was read and its line count is within the cap. */
  readonly indexWithinCap: boolean;
  readonly stalePointers: number;
  readonly failedCaptures: number;
  readonly pending: number;
}

interface SidebarSnapshot {
  readonly state: SidebarState;
  readonly pending: number;
}

function deriveSidebarState(facts: SidebarFacts): SidebarState;
```

Rules, in order:

1. If not initialized, return `{ state: "not-initialized", pending: 0 }`
   without reading storage.
2. If the INDEX line count is `undefined` after initialization, or is greater
   than `indexLines`, return `attention`.
3. If `indexStale` or `captureFailed` is present, return `attention`.
4. If `pending > 0`, return `pending` with the count.
5. Otherwise return `healthy`.

The snapshot always includes `pending`, even when the state is `attention` or
`not-initialized`; the label renderer uses it only for `pending`.

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
| `src/sidebar.ts` | Pure state types, `deriveSidebarState`, `parseSidebarOptions`, and `renderSidebarLabel`. No fs/storage imports. |
| `src/sidebar-status.ts` | Server collector (`collectSidebarStatus`) and RPC registration (`registerSidebarRpc`). Imports the existing init, brief, and ledger helpers. |
| `src/tui.tsx` | TUI plugin definition, visibility check, footer slot, Solid status-line component, polling, event refreshes, and cleanup. |

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

The TUI calls:

```ts
context.client
  .rpc(MemoryRpc)
  .sidebarStatus({}, { location: context.location ?? context.data.location.default() });
```

RPC validation failure, transport failure, or a rejected handler all follow the
same TUI path: clear the rendered snapshot and hide the line until a later
successful poll.

### Wiring

- `src/index.ts`: after the existing tool/command registrations, register the
  sidebar RPC. No hook guard changes; the status method must work before and
  after initialization.
- `src/tui.tsx`:

```ts
export default Plugin.define({
  id: "memory.tui",
  setup(context) {
    if (!parseSidebarOptions(context.options).showSidebarStatus) return;
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
4. Guard against overlapping fetches.
5. Clear the interval, unsubscribe the event listeners, and ignore late
   results after cleanup.

Each mounted footer line owns its own poll. The snapshot is project-wide, so
multiple sessions or TUI instances cannot corrupt each other.

### Data flow

```text
TUI setup
  -> read showSidebarStatus
  -> hidden? stop
  -> register sidebar.footer
  -> component mounts
  -> RPC nexusnv.memory.sidebarStatus(location)
  -> server collector reads INDEX state, line count, pending, notices
  -> { state, pending }
  -> TUI renders one line
  -> poll / session.synthetic / session.idle refresh
```

### Error handling

- `isInitialized` and `indexLineCount` already fail closed and never throw.
- `getPending` / `getNotice` rejections propagate through the RPC handler.
- The TUI catches every rejection, clears the snapshot, and renders nothing.
- Late responses after unmount are ignored.
- The server handler never writes, never consumes notices, and never bumps
  metrics.
- A hidden indicator never starts a poll or an event subscription.

## Test plan

### Unit tests

`test/sidebar.test.ts`:

- `parseSidebarOptions`: missing/true/false/unknown keys, invalid types warn
  once and default to visible, non-object input defaults to visible.
- `deriveSidebarState`: every precedence combination, including
  initialization beating pending, over-cap beating pending, notices beating
  pending, and pending beating healthy.
- `renderSidebarLabel`: exact text and tone for all four states; pending count
  is rendered only for `pending`.

`test/sidebar-status.test.ts`:

- Temp memory root + fake `LedgerStorage`.
- Not-initialized wins even when pending is set.
- Healthy when INDEX is within cap, pending is zero, and no actionable notice
  exists.
- Pending count is returned unchanged.
- Over-cap INDEX, unreadable INDEX, stale-pointer notice, and failed-capture
  notice each produce attention.
- Rotated and forgotten notices are ignored.
- Notices remain readable after collection (not consumed).
- The collector performs no `set` or `remove`.
- Storage rejection propagates.
- RPC registration wires the handler and returns the same snapshot.

### TUI verification

Vitest does not host the OpenTUI renderer faithfully. The TUI adapter stays
thin; its pure visibility and label logic is unit-tested, and the slot/RPC
wiring is covered by typecheck plus a local smoke check:

1. Fresh project → `○ memory · run /memory-init`.
2. Run `/memory-init` → `● memory · healthy` without a long delay.
3. Trigger a failure capture → `◐ memory · 1 pending`.
4. Push `INDEX.md` over its cap → `▲ memory · needs attention`.
5. `showSidebarStatus: false` → no line and no blank footer space.
6. Invalid `showSidebarStatus` → visible with one warning.
7. Two projects open → each footer follows its own location.
8. Stop/unload the server plugin → the line hides rather than showing a stale
   state.

### Existing suites

- `npm run typecheck`
- `npm test`
- `npm run test:coverage`

The existing coverage thresholds must remain met. The new pure modules are
fully unit-tested. The `.tsx` adapter falls outside the existing
`src/**/*.ts` coverage glob and is verified by the smoke check above instead.

## Documentation updates

- New ADR `docs/adr/0012-tui-sidebar-status.md`.
- This spec.
- `docs/design-spec-v2-production.md`:
  - Add a concise sidebar-status contract.
  - Update §8 D-G and §10 to distinguish this minimal indicator from the
    still-deferred rich metrics panel.
- `docs/c4-03-components.md`, `docs/c4-04-interfaces.md`, and
  `docs/c4-06-code.md`: add the TUI part, RPC method, slot claim, and new
  source modules.
- `README.md`: indicator states, `showSidebarStatus`, and troubleshooting
  (missing line means the TUI part or RPC is unavailable).
- `CHANGELOG.md`: unreleased entry.
- `docs/user-stories.md`: one user story and one harness story.

## Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| `context.options` is not delivered through some TUI load path. | The fallback is visible-by-default. The local smoke test must prove the hidden path before release. |
| OpenTUI peer drift. | Declare the peer ranges, typecheck against the host versions, and smoke-test the published package shape. |
| RPC location routing sends the wrong project state. | Always pass `context.location`; verify with two open projects. |
| Attention is transient because the prompt status line consumes notices. | Document that the sidebar is a read-only mirror; the status line remains the actionable report. |
| Polling cost or leaked intervals. | One 5-second read-only call per mounted line; cleanup clears the timer and subscriptions; hidden mode does no work. |
| Scope creep into a dashboard. | The line is passive, single-state, and bounded to `{ state, pending }`; the rich panel stays deferred. |

## Acceptance criteria

- `sidebar.footer` shows exactly one of the four fixed lines after a successful
  snapshot.
- State precedence is deterministic and matches the table above.
- `/memory-init` makes the line move from not-initialized to healthy/pending
  without restarting the TUI.
- `showSidebarStatus: false` removes the line and produces no polling or RPC
  traffic.
- The server still accepts exactly the five existing behavior options; the TUI
  option is ignored by server parsing.
- No memory file, ledger key, metric, or notice is written or consumed by the
  indicator.
- The full test suite, typecheck, and coverage gates pass.

## Alternatives considered

- **TUI-only filesystem probe.** Rejected because `curation.pending` and the
  notice markers live in server storage; the probe would lose two of the four
  states or approximate them from files.
- **RPC push events after every write.** Rejected for this minimal indicator:
  it would instrument init, capture, apply, review, forget, and external edits
  to save at most five seconds of latency.
- **Adding `showSidebarStatus` to `MemoryPluginOptions`.** Rejected because it
  would amend the five-option behavior contract for a presentation concern.
  The TUI parser owns the option instead.
- **Showing a fifth `unavailable` state.** Rejected to keep the line honest
  and minimal: no data means no line, not a new visible state.

## Open questions

None.
