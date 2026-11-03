import { describe, expect, it } from "vitest";
import { MEMORY_RPC_ID, MemoryRpc } from "../src/rpc.js";

describe("MemoryRpc", () => {
  it("defines one read-only sidebar status method", () => {
    expect(MEMORY_RPC_ID).toBe("nexusnv.memory");
    expect(MemoryRpc.id).toBe(MEMORY_RPC_ID);
    expect(Object.keys(MemoryRpc.methods)).toEqual(["sidebarStatus"]);
    expect(MemoryRpc.events).toEqual({});
  });

  it("accepts no input and returns only state plus pending", () => {
    const method = MemoryRpc.methods.sidebarStatus;
    expect(method.input).toEqual({
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    });
    expect(method.output).toEqual({
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
    });
  });
});
