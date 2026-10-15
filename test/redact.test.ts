import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { redact } from "../src/redact.js";

const fixturePath = resolve(import.meta.dirname!, "fixtures/secrets.txt");
const secrets = readFileSync(fixturePath, "utf8")
  .split("\n")
  .map((l) => l.trim())
  .filter((l) => l.length > 0);

describe("strips_blocklist_and_private_variants", () => {
  it("redacts every blocklisted secret from the fixture", () => {
    expect(secrets.length).toBeGreaterThan(5);
    for (const secret of secrets) {
      const out = redact(`prefix ${secret} suffix`);
      expect(out, `secret leaked: ${secret}`).not.toContain(secret);
      expect(out.toLowerCase()).toContain("[redacted");
    }
  });

  it("strips <private> case-insensitive multiline", () => {
    expect(redact("a <private>secret-body</private> b")).not.toContain(
      "secret-body",
    );
    expect(redact("a <PRIVATE>secret-body</PRIVATE> b")).not.toContain(
      "secret-body",
    );
    expect(redact("a <Private>secret-body</Private> b")).not.toContain(
      "secret-body",
    );
    const multi = "keep\n<private>\nline1\nline2\n</private>\nafter";
    const out = redact(multi);
    expect(out).not.toContain("line1");
    expect(out).not.toContain("line2");
    expect(out).toContain("keep");
    expect(out).toContain("after");
  });

  it("outermost-wins for nested private blocks", () => {
    const nested = "<private>outer <private>inner</private> still-outer</private> after";
    const out = redact(nested);
    expect(out).not.toContain("outer");
    expect(out).not.toContain("inner");
    expect(out).not.toContain("still-outer");
    expect(out).toContain("after");
  });

  it("unclosed tag strips to EOF", () => {
    const out = redact("keep this <private>secret to eof");
    expect(out).toContain("keep this");
    expect(out).not.toContain("secret to eof");
    const upper = redact("keep this <PRIVATE>secret to eof");
    expect(upper).toContain("keep this");
    expect(upper).not.toContain("secret to eof");
  });

  it("redacts a full private-key block including its body", () => {
    const block = [
      "header",
      "-----BEGIN RSA PRIVATE KEY-----",
      "MIIEpAIBAAKCAQEA7bq2W1vR4J6m9K0vR4J6m9K0vR4J6m9K0vR4J6m9K0vR4J6",
      "-----END RSA PRIVATE KEY-----",
      "trailer",
    ].join("\n");
    const out = redact(block);
    expect(out).toContain("header");
    expect(out).toContain("trailer");
    expect(out).not.toContain("MIIEpAIBAAKCAQEA");
    expect(out).not.toContain("BEGIN RSA PRIVATE KEY");
  });

  it("redaction is idempotent and never throws on empty", () => {
    expect(redact("")).toBe("");
    const once = redact("key AKIAIOSFODNN7EXAMPLE <private>x</private>");
    expect(redact(once)).toBe(once);
  });
});

describe("quoted_env_values_with_spaces", () => {
  it("redacts double-quoted values through the closing quote", () => {
    const out = redact('API_KEY="with spaces inside"');
    expect(out).not.toContain("with spaces inside");
    expect(out).toContain("API_KEY=[redacted]");
  });

  it("redacts single-quoted values through the closing quote", () => {
    const out = redact("PASSWORD='correct horse battery staple'");
    expect(out).not.toContain("correct horse");
    expect(out).toContain("PASSWORD=[redacted]");
  });

  it("still redacts unquoted values", () => {
    const out = redact("TOKEN=abc123XYZ");
    expect(out).not.toContain("abc123XYZ");
    expect(out).toContain("TOKEN=[redacted]");
  });

  it("fail-closed on unterminated quotes (no leak to end of line)", () => {
    const out = redact('SECRET="starts here but never ends');
    expect(out).not.toContain("starts here");
  });
});
