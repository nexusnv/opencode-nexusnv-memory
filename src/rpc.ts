/**
 * Shared read-only RPC contract for the TUI sidebar status indicator.
 *
 * The server half registers the handler under `nexusnv.memory`; the TUI half
 * calls `client.rpc(MemoryRpc).sidebarStatus(...)`. The method returns only
 * `{ state, pending }`, so the wire surface cannot grow into a metrics panel
 * by accident (ADR-0012).
 */
import { Rpc } from "@opencode/plugin/rpc";

export const MEMORY_RPC_ID = "nexusnv.memory";

export const MemoryRpc = Rpc.define({
  id: MEMORY_RPC_ID,
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
