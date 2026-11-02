/**
 * One .env value as a shell would read it: a value in a matching pair of quotes is the text
 * between them, with anything after the closing quote only a `# comment`; an unquoted value ends
 * at a whitespace-led `#`. Inside double quotes a backslash escapes `"`, `\`, `$` and `` ` ``
 * (GY-1071), so `"a\"b"` is `a"b`. In an unquoted value a backslash escapes the following
 * character as in sh (GY-1071 finding 26), so `a\ b` is `a b` and `a\\b` is `a\b`. A value whose
 * quotes do not pair or with a trailing unescaped backslash is refused, never altered.
 */
export function parseEnvValue(raw: string): string | null {
  const text = raw.trim(), quote = text[0];
  if (quote === "'") {
    const close = text.indexOf(quote, 1);
    if (close < 0 || !/^(\s+#.*)?$/.test(text.slice(close + 1).trimEnd())) return null;
    return text.slice(1, close);
  }
  if (quote === '"') {
    // Inside double quotes a backslash escapes ", \, $ and ` as in sh, and is kept before anything else.
    let value = '', close = -1;
    for (let at = 1; at < text.length; at++) {
      const char = text[at];
      if (char === '\\' && at + 1 < text.length && '"\\$`'.includes(text[at + 1])) value += text[++at];
      else if (char === '"') { close = at; break; } else value += char;
    }
    if (close < 0 || !/^(\s+#.*)?$/.test(text.slice(close + 1).trimEnd())) return null;
    return value;
  }
  let value = '';
  for (let at = 0; at < text.length; at++) {
    const char = text[at];
    if (char === '\\') {
      if (at + 1 >= text.length) return null;
      value += text[++at];
    } else if (char === '"' || char === "'") {
      return null;
    } else if (/\s/.test(char)) {
      if (/^\s+#/.test(text.slice(at))) break;
      value += char;
    } else {
      value += char;
    }
  }
  return value.trimEnd();
}
