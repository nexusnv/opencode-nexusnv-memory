import { describe, expect, it } from "vitest";
import { commandFlagValue, tokenizeCommandArgs } from "../src/args.js";

describe("tokenizeCommandArgs", () => {
  it("handles double quotes, escapes, and empty values", () => {
    expect(
      tokenizeCommandArgs('--match "two words" --reason=clean').tokens,
    ).toEqual(["--match", "two words", "--reason=clean"]);
    expect(tokenizeCommandArgs("--match two\\ words").tokens).toEqual([
      "--match",
      "two words",
    ]);
  });

  it("keeps backslashes literal inside single quotes", () => {
    expect(tokenizeCommandArgs("--match 'C:\\temp'").tokens).toEqual([
      "--match",
      "C:\\temp",
    ]);
  });

  it("rejects an unterminated quote", () => {
    expect(tokenizeCommandArgs('--match "open')).toMatchObject({
      error: "unterminated quote",
    });
  });
});

describe("commandFlagValue", () => {
  it("resolves separate and equals forms", () => {
    expect(commandFlagValue("--keep", "--keep", ["--keep", "2"], 0)).toEqual({
      value: "2",
      index: 1,
    });
    expect(commandFlagValue("--keep=0", "--keep", ["--keep=0"], 0)).toEqual({
      value: "0",
      index: 0,
    });
  });

  it("refuses to swallow the next flag as a value", () => {
    expect(
      commandFlagValue("--reason", "--reason", ["--reason", "--confirm"], 0),
    ).toMatchObject({ error: /got --confirm/ });
  });
});
