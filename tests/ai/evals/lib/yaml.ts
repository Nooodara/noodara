// 29-01: a strict YAML subset for the eval dataset. The repo root has no YAML dependency, and a
// closed subset keeps the dataset reviewable: block maps and sequences, quoted and plain scalars,
// flow sequences of scalars, `{}`/`[]`, comments. Anchors, aliases, tags, block scalars, flow maps
// and multi-document streams are rejected with the line number, never guessed.

export type YamlValue = string | number | boolean | null | YamlValue[] | { [key: string]: YamlValue };

export class YamlError extends Error {
  constructor(
    message: string,
    readonly line: number,
  ) {
    super(`line ${String(line)}: ${message}`);
    this.name = 'YamlError';
  }
}

interface Line {
  readonly indent: number;
  readonly text: string;
  readonly no: number;
}

const KEY_PATTERN = /^([A-Za-z0-9_][A-Za-z0-9_.-]*|"(?:[^"\\]|\\.)*"|'(?:[^']|'')*')[ \t]*:(?:[ \t]+|$)/;
const INT_PATTERN = /^-?(?:0|[1-9][0-9]*)$/;
const FLOAT_PATTERN = /^-?(?:0|[1-9][0-9]*)\.[0-9]+$/;
const FORBIDDEN_START = /^[&*!|>%@`]/;

/** Drops a `#` comment that starts the line or follows whitespace, outside quotes. */
function stripComment(raw: string): string {
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (quote === '"') {
      if (ch === '\\') i += 1;
      else if (ch === '"') quote = null;
    } else if (quote === "'") {
      if (ch === "'") quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '#' && (i === 0 || raw[i - 1] === ' ' || raw[i - 1] === '\t')) {
      return raw.slice(0, i);
    }
  }
  return raw;
}

function tokenize(source: string): Line[] {
  const lines: Line[] = [];
  source.split(/\r?\n/).forEach((raw, index) => {
    const no = index + 1;
    const body = stripComment(raw).replace(/[ \t]+$/, '');
    if (body.trim() === '') return;
    const indentMatch = /^ */.exec(body);
    const indent = indentMatch === null ? 0 : indentMatch[0].length;
    if (body[indent] === '\t') throw new YamlError('tabs are not allowed for indentation', no);
    const text = body.slice(indent);
    if (indent === 0 && (text === '---' || text === '...')) throw new YamlError('multi-document streams are not supported', no);
    lines.push({ indent, text, no });
  });
  return lines;
}

function parseQuoted(text: string, no: number): string {
  if (text.startsWith('"')) {
    try {
      return JSON.parse(text) as string;
    } catch {
      throw new YamlError('invalid double-quoted string', no);
    }
  }
  if (!text.endsWith("'") || text.length < 2) throw new YamlError('unterminated single-quoted string', no);
  const inner = text.slice(1, -1);
  if (/'(?!')/.test(inner.replace(/''/g, ''))) throw new YamlError('invalid single-quoted string', no);
  return inner.replace(/''/g, "'");
}

/** Splits a flow sequence body on commas outside quotes. */
function splitFlow(body: string, no: number): string[] {
  const parts: string[] = [];
  let quote: '"' | "'" | null = null;
  let start = 0;
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (quote === '"') {
      if (ch === '\\') i += 1;
      else if (ch === '"') quote = null;
    } else if (quote === "'") {
      if (ch === "'") quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '[' || ch === ']' || ch === '{' || ch === '}') {
      throw new YamlError('nested flow collections are not supported', no);
    } else if (ch === ',') {
      parts.push(body.slice(start, i));
      start = i + 1;
    }
  }
  if (quote !== null) throw new YamlError('unterminated string in flow sequence', no);
  parts.push(body.slice(start));
  return parts.map((part) => part.trim());
}

function parseScalar(text: string, no: number): YamlValue {
  if (text === '[]') return [];
  if (text === '{}') return {};
  if (text.startsWith('[')) {
    if (!text.endsWith(']')) throw new YamlError('unterminated flow sequence', no);
    const parts = splitFlow(text.slice(1, -1), no);
    if (parts.some((part) => part === '')) throw new YamlError('empty item in flow sequence', no);
    return parts.map((part) => parseScalar(part, no));
  }
  if (text.startsWith('{')) throw new YamlError('flow mappings are not supported', no);
  if (text.startsWith('"') || text.startsWith("'")) return parseQuoted(text, no);
  if (FORBIDDEN_START.test(text)) throw new YamlError(`unsupported YAML feature at "${text.slice(0, 1)}"`, no);
  if (text === 'null' || text === '~') return null;
  if (text === 'true') return true;
  if (text === 'false') return false;
  if (INT_PATTERN.test(text) || FLOAT_PATTERN.test(text)) return Number(text);
  if (/:(\s|$)/.test(text)) throw new YamlError('a plain scalar cannot contain ": "; quote it', no);
  return text;
}

function isSeqItem(text: string): boolean {
  return text === '-' || text.startsWith('- ');
}

class Parser {
  private pos = 0;

  constructor(private readonly lines: Line[]) {}

  parseDocument(): YamlValue {
    if (this.lines.length === 0) return null;
    const first = this.lines[0] as Line;
    if (first.indent !== 0) throw new YamlError('the document must start at column 0', first.no);
    const value = this.parseBlock(0);
    const rest = this.lines[this.pos];
    if (rest !== undefined) throw new YamlError('unexpected content', rest.no);
    return value;
  }

  private peek(): Line | undefined {
    return this.lines[this.pos];
  }

  private parseBlock(indent: number): YamlValue {
    const line = this.peek();
    if (line === undefined) return null;
    return isSeqItem(line.text) ? this.parseSeq(indent) : this.parseMap(indent);
  }

  /** The value of `key:` or `-` with nothing after it: a nested block, or null. */
  private parseNested(parentIndent: number, allowSameIndentSeq: boolean): YamlValue {
    const next = this.peek();
    if (next === undefined) return null;
    if (next.indent > parentIndent) return this.parseBlock(next.indent);
    if (allowSameIndentSeq && next.indent === parentIndent && isSeqItem(next.text)) return this.parseSeq(parentIndent);
    return null;
  }

  private parseSeq(indent: number): YamlValue[] {
    const items: YamlValue[] = [];
    for (let line = this.peek(); line !== undefined && line.indent === indent && isSeqItem(line.text); line = this.peek()) {
      const rest = line.text.slice(1).replace(/^ +/, '');
      if (rest === '') {
        this.pos += 1;
        items.push(this.parseNested(indent, false));
      } else if (KEY_PATTERN.test(rest)) {
        // `- key: value` opens a mapping whose keys sit at the column of `key`.
        const column = indent + (line.text.length - rest.length);
        this.lines[this.pos] = { indent: column, text: rest, no: line.no };
        items.push(this.parseMap(column));
      } else {
        this.pos += 1;
        items.push(parseScalar(rest, line.no));
      }
    }
    const stray = this.peek();
    if (stray !== undefined && stray.indent > indent) throw new YamlError('unexpected indentation', stray.no);
    return items;
  }

  private parseMap(indent: number): { [key: string]: YamlValue } {
    const map: { [key: string]: YamlValue } = {};
    for (let line = this.peek(); line !== undefined && line.indent === indent; line = this.peek()) {
      if (isSeqItem(line.text)) throw new YamlError('a sequence item cannot follow a mapping key at the same level', line.no);
      if (line.text.startsWith('? ')) throw new YamlError('complex keys are not supported', line.no);
      const match = KEY_PATTERN.exec(line.text);
      if (match === null) throw new YamlError('expected "key: value"', line.no);
      const rawKey = match[1] as string;
      const key = rawKey.startsWith('"') || rawKey.startsWith("'") ? parseQuoted(rawKey, line.no) : rawKey;
      if (Object.prototype.hasOwnProperty.call(map, key)) throw new YamlError(`duplicate key "${key}"`, line.no);
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') throw new YamlError(`reserved key "${key}"`, line.no);
      const valueText = line.text.slice(match[0].length);
      this.pos += 1;
      map[key] = valueText === '' ? this.parseNested(indent, true) : parseScalar(valueText, line.no);
    }
    const stray = this.peek();
    if (stray !== undefined && stray.indent > indent) throw new YamlError('unexpected indentation', stray.no);
    return map;
  }
}

/** Parses one YAML document of the supported subset; throws YamlError with a line number. */
export function parseYaml(source: string): YamlValue {
  return new Parser(tokenize(source)).parseDocument();
}
