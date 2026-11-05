// 29-01: the dataset's YAML subset parser. It accepts exactly what the scenarios and fixtures use
// and rejects every other YAML feature with a line number, so a file never means something other
// than what a reviewer reads.
import { describe, expect, it } from 'vitest';
import { YamlError, parseYaml } from './yaml.js';

const doc = (...lines: string[]) => lines.join('\n');

function rejects(source: string, message: RegExp, line: number): void {
  let caught: unknown;
  try {
    parseYaml(source);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(YamlError);
  expect((caught as YamlError).message).toMatch(message);
  expect((caught as YamlError).line).toBe(line);
}

describe('parseYaml accepts the supported subset', () => {
  it('parses nested block maps and sequences, including sequences of maps', () => {
    const source = doc(
      '# a comment line',
      'id: shop-single',
      'servers:',
      '  - name: web-1',
      '    cpuCores: 4',
      '    tags:',
      '      - edge',
      '  - name: web-2',
      'nested:',
      '  inner:',
      '    deep: yes',
      'items:',
      '- a',
      '- b',
    );
    expect(parseYaml(source)).toEqual({
      id: 'shop-single',
      servers: [{ name: 'web-1', cpuCores: 4, tags: ['edge'] }, { name: 'web-2' }],
      nested: { inner: { deep: 'yes' } },
      items: ['a', 'b'],
    });
  });

  it('types scalars: integers, floats, booleans, null, and keeps the rest as strings', () => {
    expect(parseYaml(doc('a: 42', 'b: -3', 'c: 1.5', 'd: true', 'e: false', 'f: null', 'g: ~', 'h: 1.2.3', 'i: 007', 'j:'))).toEqual({
      a: 42,
      b: -3,
      c: 1.5,
      d: true,
      e: false,
      f: null,
      g: null,
      h: '1.2.3',
      i: '007',
      j: null,
    });
  });

  it('parses double and single quoted strings, with escapes and inline comments', () => {
    expect(parseYaml(doc('a: "x: y # not a comment"  # comment', "b: 'it''s'", 'c: "line\\nnext"', 'd: plain # trailing'))).toEqual({
      a: 'x: y # not a comment',
      b: "it's",
      c: 'line\nnext',
      d: 'plain',
    });
  });

  it('parses flow sequences of scalars and the empty collections', () => {
    expect(parseYaml(doc('a: [one, "two, three", 4]', 'b: []', 'c: {}'))).toEqual({ a: ['one', 'two, three', 4], b: [], c: {} });
  });

  it('accepts quoted keys and an empty document', () => {
    expect(parseYaml('"odd key": 1')).toEqual({ 'odd key': 1 });
    expect(parseYaml('# only a comment\n')).toBeNull();
  });
});

describe('parseYaml rejects everything outside the subset', () => {
  it.each([
    ['anchors', doc('a: &anchor 1'), /unsupported YAML feature at "&"/, 1],
    ['aliases', doc('a: 1', 'b: *anchor'), /unsupported YAML feature at "\*"/, 2],
    ['tags', doc('a: !!str 1'), /unsupported YAML feature at "!"/, 1],
    ['literal block scalars', doc('a: |', '  text'), /unsupported YAML feature at "\|"/, 1],
    ['folded block scalars', doc('a: >', '  text'), /unsupported YAML feature at ">"/, 1],
    ['flow mappings', doc('a: {b: 1}'), /flow mappings are not supported/, 1],
    ['nested flow collections', doc('a: [[1]]'), /nested flow collections are not supported/, 1],
    ['document markers', doc('---', 'a: 1'), /multi-document streams/, 1],
    ['document end markers', doc('a: 1', '...'), /multi-document streams/, 2],
    ['tab indentation', doc('a:', '\tb: 1'), /tabs are not allowed/, 2],
    ['complex keys', doc('? a', ': b'), /complex keys are not supported/, 1],
    ['plain scalars with ": "', doc('a: b: c'), /cannot contain ": "/, 1],
    ['unterminated flow sequences', doc('a: [1, 2'), /unterminated flow sequence/, 1],
    ['empty flow items', doc('a: [1, , 2]'), /empty item in flow sequence/, 1],
    ['invalid double-quoted strings', doc('a: "bad'), /invalid double-quoted string/, 1],
    ['unexpected indentation', doc('a: 1', '    b: 2'), /unexpected indentation/, 2],
    ['a document not at column 0', doc('  a: 1'), /must start at column 0/, 1],
    ['a sequence item among mapping keys', doc('a: 1', '- b'), /sequence item cannot follow a mapping key/, 2],
  ])('%s', (_name, source, message, line) => {
    rejects(source, message, line);
  });

  it('duplicate keys', () => {
    rejects(doc('a: 1', 'b: 2', 'a: 3'), /duplicate key "a"/, 3);
    rejects(doc('"a": 1', 'a: 2'), /duplicate key "a"/, 2);
  });

  it.each(['__proto__', 'constructor', 'prototype'])('the prototype-polluting key %s', (key) => {
    rejects(doc('safe: 1', `${key}:`, '  polluted: true'), new RegExp(`reserved key "${key}"`), 2);
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });
});
