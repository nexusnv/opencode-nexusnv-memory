/**
 * Secrets redaction (spec §§5.7, 6).
 *
 * Applied before every write and every inject. Two layers:
 * 1. `<private>…</private>` strip (case-insensitive, multiline,
 *    outermost-wins, unclosed tag strips to EOF).
 * 2. Secrets blocklist by pattern (patterns enumerated in
 *    `test/fixtures/secrets.txt`).
 */

/**
 * Opening `<private>` (attributes allowed: `<private note="x">`) vs exact
 * closing `</private>` (no attributes). An attributed closer such as
 * `</private note>` is NOT a close — inside a block it must not resume
 * copying (fail-closed to EOF redaction); outside a block it is left as-is.
 */
const PRIVATE_TAG =
  /<\s*(\/?)\s*private((?:\s+[^>]*)?)\s*>/gi;

const REDACTED = "[redacted]";

/**
 * Strip `<private>…</private>` blocks. Outermost-wins: nested opens deepen a
 * counter and only the outermost close ends the block. An unclosed opener
 * strips to EOF. Stray closers with no opener are left as-is.
 *
 * With `preserveLines`, the stripped span is replaced by `[redacted]` plus one
 * newline per newline in the span, so line numbers after the block still match
 * the on-disk file (`memory_search` hit locations).
 */
function stripPrivateBlocks(text: string, preserveLines: boolean): string {
  PRIVATE_TAG.lastIndex = 0;
  let result = "";
  let pos = 0;
  let depth = 0;
  let blockStart = 0;
  let match: RegExpExecArray | null;
  // Reset lastIndex on each exec via the shared regex; single-threaded use is
  // safe because the function is synchronous.
  while ((match = PRIVATE_TAG.exec(text)) !== null) {
    const isClose = match[1] === "/";
    const hasAttrs = (match[2] ?? "").trim().length > 0;
    if (!isClose) {
      if (depth === 0) {
        result += text.slice(pos, match.index);
        if (!preserveLines) result += REDACTED;
        blockStart = match.index;
      }
      depth += 1;
      pos = match.index + match[0].length;
    } else if (!hasAttrs) {
      if (depth > 0) {
        depth -= 1;
        pos = match.index + match[0].length;
        if (depth === 0 && preserveLines) {
          const block = text.slice(blockStart, pos);
          result += `${REDACTED}${"\n".repeat(newlineCount(block))}`;
        }
      } else {
        // Stray closer: leave it in the output (pos untouched).
      }
    } else {
      // Attributed closer (`</private ...>`): not a tag — leave the text in
      // the output when outside a block; inside a block it stays redacted.
    }
  }
  if (depth > 0) {
    // Unclosed opener: everything from the outermost open to EOF is gone;
    // the placeholder was already emitted (or is emitted with preserved
    // newlines for search).
    if (preserveLines) {
      const block = text.slice(blockStart);
      result += `${REDACTED}${"\n".repeat(newlineCount(block))}`;
    }
    return result;
  }
  result += text.slice(pos);
  return result;
}

function newlineCount(text: string): number {
  let count = 0;
  for (const char of text) {
    if (char === "\n") count += 1;
  }
  return count;
}

/** Expand `$1`/`$3`-style templates against a regex match's captures. */
function expandReplacement(
  template: string,
  groups: readonly unknown[],
): string {
  return template.replace(
    /\$(\d)/g,
    (_match, digit: string) => String(groups[Number(digit) - 1] ?? ""),
  );
}

interface Pattern {
  readonly re: RegExp;
  readonly replacement: string;
}

const BLOCKLIST: readonly Pattern[] = [
  // Private key blocks (full) first, then lone headers (truncated keys).
  {
    re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
    replacement: "[redacted private key]",
  },
  {
    re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/g,
    replacement: "[redacted private key]",
  },
  {
    re: /-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
    replacement: "[redacted private key]",
  },
  // AWS access key ID.
  { re: /\bAKIA[0-9A-Z]{16}\b/g, replacement: REDACTED },
  // GitHub tokens.
  { re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g, replacement: REDACTED },
  { re: /\bgithub_pat_[A-Za-z0-9_]{22,}\b/g, replacement: REDACTED },
  // OpenAI keys (incl. sk-proj-).
  { re: /\bsk-(proj-)?[A-Za-z0-9_-]{20,}\b/g, replacement: REDACTED },
  // Stripe live/test secret keys (underscore form; distinct from sk-).
  { re: /\bsk_(live|test)_[A-Za-z0-9]{10,}\b/g, replacement: REDACTED },
  // Slack tokens.
  { re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, replacement: REDACTED },
  // Bearer tokens: keep the scheme so the header shape stays visible.
  // Scheme is case-insensitive per RFC 7235 (M-1: `bearer`/`BEARER` in logs).
  {
    re: /\bBearer\s+[A-Za-z0-9\-._~+/=]{20,}\b/gi,
    replacement: "Bearer [redacted]",
  },
  // URL credentials (e.g. DATABASE_URL=postgres://user:pass@host/...).
  // Empty user allowed (`redis://:pass@host`); password runs to the last `@`
  // before `/`/whitespace so `user:p@ss@host` redacts `p@ss` (M-1). The
  // username stops at the first colon so `user:alpha:bravo@db` masks the
  // whole `alpha:bravo` instead of leaking `alpha:`.
  //
  // Linear-time guard (Tier-1): bound the scheme and userinfo so the engine
  // cannot backtrack across an arbitrarily long non-matching line. The
  // unbounded form was O(n²) (a 100 KB single-line file took ~14 s; 1 MB
  // would take minutes). RFC 3986 schemes are short; 64 chars is generous,
  // and 2048 covers practical userinfo/passwords. Real URLs are unchanged.
  // No leading `\b`: a URL embedded after word characters (e.g.
  // `foo_postgres://user:pass@host`) must still be redacted; the bounds keep
  // the scan linear.
  {
    re: /([a-zA-Z][a-zA-Z0-9+.-]{0,63}:\/\/[^/?#\s:]{0,2048}:)([^\s/]{1,2048})(@)/g,
    replacement: "$1[redacted]$3",
  },
  // AWS secret access key with label.
  {
    re: /\baws_secret_access_key\s*[:=]\s*['"]?[A-Za-z0-9/+=]{30,}['"]?/gi,
    replacement: "aws_secret_access_key=[redacted]",
  },
  // Generic .env-style assignments for secret-ish keys. The value is
  // replaced with [redacted], preserving the key label. Quoted values match
  // through their closing quote (so values containing spaces are fully
  // covered); quoted alternatives consume backslash escapes first, so an
  // escaped quote cannot end the match early and leak the remainder.
  // Unterminated quotes match to end of line (fail-closed). Key coverage is
  // intentionally broad (M-1: OPENAI_KEY/GITHUB_KEY/AUTH/ENCRYPTION_KEY via
  // the generic KEY/AUTH/CREDENTIAL match — over-redaction like MONKEY= is
  // accepted over a leak).
  {
    re: /\b([A-Z0-9_]*?(?:SECRET|PASSWORD|PASSWD|PWD|TOKEN|PRIVATE|AUTH|CREDENTIALS?|CREDS?|KEY)[A-Z0-9_]*\b\s*[:=]\s*)(?:"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|"(?:[^"\n\\]|\\.)*|'(?:[^'\n\\]|\\.)*|[^\s'";,]+)/gi,
    replacement: "$1[redacted]",
  },
];

/**
 * Apply the secrets blocklist, optionally preserving the newline count of
 * each match so line numbers survive redaction (search locations).
 */
function applyBlocklist(text: string, preserveLines: boolean): string {
  let out = text;
  for (const { re, replacement } of BLOCKLIST) {
    re.lastIndex = 0;
    if (!preserveLines) {
      out = out.replace(re, replacement);
      continue;
    }
    out = out.replace(re, (...args: unknown[]) => {
      const matched = String(args[0] ?? "");
      const groups = args.slice(1, -2);
      const expanded = expandReplacement(replacement, groups);
      const missing = newlineCount(matched) - newlineCount(expanded);
      return missing > 0 ? `${expanded}${"\n".repeat(missing)}` : expanded;
    });
  }
  return out;
}

function redactWith(text: string, preserveLines: boolean): string {
  if (typeof text !== "string" || text.length === 0) return text;
  let out: string;
  try {
    out = stripPrivateBlocks(text, preserveLines);
  } catch {
    return REDACTED;
  }
  try {
    out = applyBlocklist(out, preserveLines);
  } catch {
    return REDACTED;
  }
  return out;
}

/**
 * Redact secrets and `<private>` blocks from text. Pure, synchronous, never
 * throws (fail-closed to the redacted placeholder on unexpected input).
 */
export function redact(text: string): string {
  return redactWith(text, false);
}

/**
 * Redact like `redact`, but preserve the number of newlines removed by each
 * match. `memory_search` uses this so a hit's `line` still points at the
 * on-disk line after a `<private>` block or a multiline secret earlier in the
 * file. The content is still fully redacted; only blank lines are retained.
 */
export function redactPreservingLines(text: string): string {
  return redactWith(text, true);
}
