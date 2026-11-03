/** @jsxImportSource @opentui/solid */
/**
 * TUI half of the memory plugin (ADR-0012).
 *
 * Claims exactly one additive `sidebar.footer` line. The component never reads
 * memory files or `ctx.storage`; it asks the server half for a bounded
 * `{ state, pending }` snapshot through the typed RPC and hides the line on
 * any failure. `showSidebarStatus: false` registers nothing at all.
 */
import type { Context } from "@opencode/plugin/tui/context";
import { Plugin } from "@opencode/plugin/tui";
import type { RGBA } from "@opentui/core";
import { Show, createSignal, onCleanup, onMount } from "solid-js";
import { MemoryRpc } from "./rpc.js";
import {
  isSidebarSnapshot,
  parseSidebarOptions,
  renderSidebarLabel,
  type SidebarSnapshot,
  type SidebarTone,
} from "./sidebar.js";

const POLL_INTERVAL_MS = 5_000;
const REQUEST_TIMEOUT_MS = 4_000;

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

export function MemoryStatusLine(props: { readonly context: Context }) {
  const [snapshot, setSnapshot] = createSignal<SidebarSnapshot>();
  let disposed = false;
  let inFlight: AbortController | undefined;

  async function refresh(): Promise<void> {
    if (disposed || inFlight) return;
    const controller = new AbortController();
    inFlight = controller;
    const timeout = setTimeout(() => {
      controller.abort();
      // Recover even if the client never settles the aborted request; a late
      // result is ignored by the aborted check below.
      if (inFlight === controller) inFlight = undefined;
    }, REQUEST_TIMEOUT_MS);

    try {
      const location =
        props.context.location ?? props.context.data.location.default();
      const result = await props.context.client
        .rpc(MemoryRpc)
        .sidebarStatus({}, { location, signal: controller.signal });
      if (disposed || controller.signal.aborted) return;
      setSnapshot(isSidebarSnapshot(result) ? result : undefined);
    } catch {
      if (!disposed) setSnapshot(undefined);
    } finally {
      clearTimeout(timeout);
      if (inFlight === controller) inFlight = undefined;
    }
  }

  onMount(() => {
    void refresh();
    const timer = setInterval(() => {
      void refresh();
    }, POLL_INTERVAL_MS);
    const offSynthetic = props.context.data.on("session.synthetic", () => {
      void refresh();
    });
    const offIdle = props.context.data.on("session.idle", () => {
      void refresh();
    });

    onCleanup(() => {
      disposed = true;
      clearInterval(timer);
      inFlight?.abort();
      offSynthetic();
      offIdle();
    });
  });

  return (
    <Show when={snapshot()}>
      {(current) => {
        const label = () => renderSidebarLabel(current());
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
  setup(context) {
    if (!parseSidebarOptions(context.options).showSidebarStatus) return;
    const unregister = context.ui.slot({
      append: "sidebar.footer",
      render: () => <MemoryStatusLine context={context} />,
    });
    return () => unregister();
  },
});
