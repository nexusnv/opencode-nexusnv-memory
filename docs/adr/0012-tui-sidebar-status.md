# ADR-0012 — TUI sidebar status indicator

**Status:** accepted. **Date:** 2026-11-03. **Related:** ADR-0008 (rich TUI panel deferred), ADR-0011 (explicit initialization gate); design-spec §5.15. **Amended:** 2026-11-03 — the TUI-only visibility option was removed before release (see Decision).

## Context

Issue #29 asks for a minimal, always-visible memory status in the OpenCode TUI. The plugin already
exposes `/memory-status`, but a command must be invoked. The TUI publishes a `sidebar.footer` slot
and a typed, location-scoped RPC, so one passive line can show installed, healthy, pending, or
attention without creating a second source of truth. The line must not become the rich metrics
panel deferred by ADR-0008, and it must not weaken the initialization gate in ADR-0011.

## Decision

- Ship a second plugin part, `memory.tui`, exported at `./tui`. It appends exactly one line to
  `sidebar.footer` and never wraps, expands, or replaces other content.
- The TUI never reads memory files or `ctx.storage`. It calls one read-only RPC,
  `nexusnv.memory.sidebarStatus`, registered unconditionally by the server part. The method accepts
  no input and returns only `{ state, pending }`.
- The server collector checks `isInitialized` first. An uninitialized project returns
  `{ state: "not-initialized", pending: 0 }` without a storage read, so the `/memory-init` reminder
  survives a storage outage. For an initialized project the collector reads the existing INDEX line
  count, pending counter, and three unconsumed notice markers. It never calls `set`/`remove`, never
  consumes a notice, and never bumps a metric.
- Four states with fixed precedence: `not-initialized` > `attention` > `pending` > `healthy`.
  `attention` covers an uninspectable or over-cap INDEX and an unconsumed `indexOverCap`,
  `indexStale`, or `captureFailed` notice. `pending` means `pending > 0`; the prompt review-due
  threshold stays at 5.
- No visibility option: the line renders while the plugin is installed. (A TUI-only
  `showSidebarStatus` flag was specified originally and removed after live-host verification:
  OpenCode 2.2.5 delivers package `options` to the server part but passes `{}` to TUI plugin parts,
  so the flag could never take effect. Hiding the line means removing the plugin.)
- Fail closed: a rejected, invalid, transport-failed, or timed-out (4 s) snapshot clears the line.
  Polling resumes on a later successful call; the in-flight guard clears in `finally` and on timeout.
  A late response after unmount is ignored.
- The indicator adds no storage key, memory file, metric name, model-facing tool, or server behavior
  option.

## Consequences

- Positive: pre-init discovery improves without a command, and install health is visible at a glance.
  The server remains the only reader, so the TUI cannot leak or corrupt memory state.
- Negative: one read-only RPC per mounted footer every 5 seconds, and the line is project-wide rather
  than per-session. Notices remain consumable by the prompt status line, so `attention` can clear when
  the model reports the same condition; the sidebar is a read-only mirror, not the actionable report.
- The line cannot be hidden while the plugin is installed (a visibility option requires working TUI
  plugin options, which this host does not deliver). Users who do not want the line remove the
  plugin. The rich metrics panel stays deferred (ADR-0008). The server option contract stays at
  exactly five.
