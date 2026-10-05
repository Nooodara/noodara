import { describe, expect, it } from "vitest";
import {
  LOG_BINARY_PLACEHOLDER,
  sanitizeLogBytes,
  sanitizeLogText,
} from "./log-sanitize.js";

const ESC = "\u001B";
const P = LOG_BINARY_PLACEHOLDER;

function bytes(...values: number[]): Uint8Array {
  return Uint8Array.from(values);
}

function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

// Deterministic PRNG (mulberry32): the property test is reproducible from its seed.
function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Biased towards the bytes that matter: escapes, CSI/OSC introducers, control bytes, UTF-8 lead
// and continuation bytes, and plain ASCII.
const INTERESTING_BYTES = [
  0x1b, 0x5b, 0x5d, 0x50, 0x5c, 0x07, 0x00, 0x08, 0x09, 0x0a, 0x0d, 0x7f, 0x9b,
  0xc2, 0xe2, 0xf0, 0xf4, 0xf8, 0xff, 0x80, 0xbf, 0x3b, 0x6d, 0x41, 0x31, 0x20,
];

function randomBytes(next: () => number, length: number): Uint8Array {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i += 1) {
    out[i] =
      next() < 0.6
        ? (INTERESTING_BYTES[Math.floor(next() * INTERESTING_BYTES.length)] ??
          0)
        : Math.floor(next() * 256);
  }
  return out;
}

function hasLoneSurrogate(text: string): boolean {
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (code >= 0xd800 && code <= 0xdfff) return true;
  }
  return false;
}

// Every C0/C1 control except newline and tab, plus DEL.
// eslint-disable-next-line no-control-regex -- deliberately matching control characters
const FORBIDDEN_CONTROL = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/;

describe("sanitizeLogText", () => {
  it("leaves plain text, newlines and tabs unchanged", () => {
    const input = "Step 1/4 : FROM node:22\n\tok — ✓ 日本語 🚀\n";

    expect(sanitizeLogText(input)).toBe(input);
  });

  it("strips SGR colour sequences", () => {
    expect(
      sanitizeLogText(`${ESC}[31mred${ESC}[0m and ${ESC}[1;32mgreen${ESC}[m`),
    ).toBe("red and green");
  });

  it("strips cursor and erase CSI sequences, including private-mode parameters", () => {
    expect(sanitizeLogText(`a${ESC}[2K${ESC}[1A${ESC}[?25lb${ESC}[?25h`)).toBe(
      "ab",
    );
  });

  it("strips OSC sequences terminated by BEL or by ST", () => {
    expect(
      sanitizeLogText(`${ESC}]0;title\u0007x${ESC}]8;;https://e.x${ESC}\\y`),
    ).toBe("xy");
  });

  it("strips an unterminated OSC sequence to the end of the text", () => {
    expect(sanitizeLogText(`keep${ESC}]0;never closed`)).toBe("keep");
  });

  it("strips DCS, SOS, PM and APC strings", () => {
    expect(
      sanitizeLogText(
        `a${ESC}Pq#0${ESC}\\b${ESC}Xs${ESC}\\c${ESC}^p${ESC}\\d${ESC}_a${ESC}\\e`,
      ),
    ).toBe("abcde");
  });

  it("strips two-character escapes and the 8-bit CSI introducer", () => {
    expect(sanitizeLogText(`a${ESC}Mb${ESC}7c\u009B31md`)).toBe("abcd");
  });

  it("drops a lone escape byte without leaving a placeholder", () => {
    expect(sanitizeLogText(`a${ESC}`)).toBe("a");
    expect(sanitizeLogText(`a${ESC}${ESC}[0m[31m`)).toBe("a[31m");
  });

  it("normalises CRLF and lone CR to LF", () => {
    expect(sanitizeLogText("a\r\nb\rc")).toBe("a\nb\nc");
  });

  it("replaces other control characters with one placeholder per run", () => {
    expect(sanitizeLogText("a\u0000\u0001\u0002b\u007Fc\u0085d")).toBe(
      `a${P}b${P}c${P}d`,
    );
  });

  it("replaces lone surrogates with the placeholder", () => {
    expect(sanitizeLogText("a\uD800b\uDC00\uDBFFc")).toBe(`a${P}b${P}c`);
  });

  it("collapses an existing replacement character into an adjacent placeholder run", () => {
    expect(sanitizeLogText(`a${P}\u0000${P}b`)).toBe(`a${P}b`);
  });

  it("returns an empty string for empty input", () => {
    expect(sanitizeLogText("")).toBe("");
  });
});

describe("sanitizeLogBytes", () => {
  it("decodes valid UTF-8 including multi-byte characters", () => {
    expect(sanitizeLogBytes(utf8("héllo ✓ 🚀\n"))).toBe("héllo ✓ 🚀\n");
  });

  it("replaces invalid UTF-8 with a single placeholder per run", () => {
    expect(sanitizeLogBytes(bytes(0x61, 0xff, 0xfe, 0xc3, 0x62))).toBe(
      `a${P}b`,
    );
  });

  it("replaces a truncated multi-byte sequence at the end", () => {
    expect(sanitizeLogBytes(bytes(0x61, 0xe2, 0x9c))).toBe(`a${P}`);
  });

  it("replaces binary content with placeholders and keeps surrounding text", () => {
    const binary = bytes(
      0x7f,
      0x45,
      0x4c,
      0x46,
      0x02,
      0x01,
      0x01,
      0x00,
      0x00,
      0x00,
    );

    expect(sanitizeLogBytes(binary)).toBe(`${P}ELF${P}`);
  });

  it("strips ANSI sequences that arrive as bytes", () => {
    expect(sanitizeLogBytes(utf8(`${ESC}[33mwarn${ESC}[0m\n`))).toBe("warn\n");
  });

  it("never throws and never emits escapes, forbidden controls or lone surrogates (property)", () => {
    const next = prng(0x5eed_12_03);

    for (let run = 0; run < 2000; run += 1) {
      const input = randomBytes(next, Math.floor(next() * 96));

      const output = sanitizeLogBytes(input);

      expect(output.includes(ESC)).toBe(false);
      expect(FORBIDDEN_CONTROL.test(output)).toBe(false);
      expect(hasLoneSurrogate(output)).toBe(false);
      expect(output.includes(`${P}${P}`)).toBe(false);
      expect(sanitizeLogText(output)).toBe(output);
    }
  });

  it("never throws on arbitrary UTF-16 strings, including lone surrogates (property)", () => {
    const next = prng(0x1234_abcd);

    for (let run = 0; run < 2000; run += 1) {
      const units = Array.from({ length: Math.floor(next() * 64) }, () =>
        next() < 0.3
          ? 0xd800 + Math.floor(next() * 0x800)
          : Math.floor(next() * 0x200),
      );
      const input = String.fromCharCode(...units);

      const output = sanitizeLogText(input);

      expect(output.includes(ESC)).toBe(false);
      expect(FORBIDDEN_CONTROL.test(output)).toBe(false);
      expect(hasLoneSurrogate(output)).toBe(false);
      expect(sanitizeLogText(output)).toBe(output);
    }
  });
});
