/** @jsxImportSource @opentui/solid */
/**
 * TUI half of the memory plugin (ADR-0012).
 *
 * Claims exactly one additive `sidebar.footer` line. The component never reads
 * memory files or `ctx.storage`; it asks the server half for a bounded
 * `{ state, pending }` snapshot through the typed RPC and hides the line on
 * any failure. The line is always visible while the plugin is installed.
 */
import type { Context } from "@opencode/plugin/tui/context";
import { Plugin } from "@opencode/plugin/tui";
import type { RGBA } from "@opentui/core";
import { Show, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { MemoryRpc } from "./rpc.js";
import { createSidebarPoller } from "./sidebar-poll.js";
import {
  renderSidebarLabel,
  type SidebarSnapshot,
  type SidebarTone,
} from "./sidebar.js";

/** Map a status tone name to the theme's concrete RGBA token. */
function toneColor(context: Context, tone: SidebarTone): RGBA {
  switch (tone) {
    case "error":
      return context.theme.text.feedback.error.base;
    case "warning":
      return context.theme.text.feedback.warning.base;
    case "success":
      return context.theme.text.feedback.success.base;
  }
}

/**
 * One sidebar line backed by the server's read-only status RPC.
 *
 * Owns the Solid signal only; the poller owns timing, overlap suppression,
 * failure clearing, and cleanup. The rendered label is derived purely from the
 * validated snapshot.
 */
export function MemoryStatusLine(props: { readonly context: Context }) {
  const [snapshot, setSnapshot] = createSignal<SidebarSnapshot>();

  onMount(() => {
    const poller = createSidebarPoller({
      request: (signal) => {
        const location =
          props.context.location ?? props.context.data.location.default();
        return props.context.client
          .rpc(MemoryRpc)
          .sidebarStatus({}, { location, signal });
      },
      onSnapshot: (next) => setSnapshot(next),
    });
    poller.start();
    const offSynthetic = props.context.data.on("session.synthetic", () => {
      poller.requestRefresh();
    });
    const offIdle = props.context.data.on("session.idle", () => {
      poller.requestRefresh();
    });

    onCleanup(() => {
      poller.dispose();
      offSynthetic();
      offIdle();
    });
  });

  return (
    <Show when={snapshot()}>
      {(current) => {
        const label = createMemo(() => renderSidebarLabel(current()));
        return (
          <text
            fg={toneColor(props.context, label().tone)}
            wrapMode="none"
            truncate
          >
            {label().text}
          </text>
        );
      }}
    </Show>
  );
}

export default Plugin.define({
  id: "memory.tui",
  /** Claim one additive footer line; the host owns the returned cleanup. */
  setup(context) {
    const unregister = context.ui.slot({
      append: "sidebar.footer",
      render: () => <MemoryStatusLine context={context} />,
    });
    return () => unregister();
  },
});
