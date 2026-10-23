/** Small shell-like tokenizer for command flags (quotes + backslash escape). */
export interface TokenizeResult {
  readonly tokens: readonly string[];
  readonly error?: string;
}

export function tokenizeCommandArgs(input: string): TokenizeResult {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  let escaped = false;
  let inToken = false;
  for (const char of input) {
    if (escaped) {
      current += char;
      escaped = false;
      inToken = true;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      escaped = true;
      inToken = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = undefined;
      else {
        current += char;
        inToken = true;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      inToken = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (inToken) {
        tokens.push(current);
        current = "";
        inToken = false;
      }
      continue;
    }
    current += char;
    inToken = true;
  }
  if (escaped) current += "\\";
  if (quote) return { tokens: [], error: "unterminated quote" };
  if (inToken) tokens.push(current);
  return { tokens };
}

/** Resolve `--name value` or `--name=value` without swallowing a flag. */
export function commandFlagValue(
  token: string,
  name: string,
  tokens: readonly string[],
  index: number,
): {
  readonly value?: string;
  readonly index: number;
  readonly error?: string;
} {
  if (token === name) {
    const value = tokens[index + 1];
    if (value === undefined)
      return { index, error: `${name} requires a value` };
    if (value.startsWith("--")) {
      return { index, error: `${name} requires a value, got ${value}` };
    }
    return { value, index: index + 1 };
  }
  const prefix = `${name}=`;
  if (token.startsWith(prefix)) {
    const value = token.slice(prefix.length);
    if (value.length === 0) return { index, error: `${name} requires a value` };
    return { value, index };
  }
  return { index };
}
