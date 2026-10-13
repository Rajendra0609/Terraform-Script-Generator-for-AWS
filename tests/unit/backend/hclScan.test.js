/**
 * tests/unit/backend/hclScan.test.js
 * Structural HCL scanner: comments, strings, heredocs, nesting, line numbers.
 */
'use strict';
const path = require('path');
const {
  parseBlocks, parseAttributes, makeLineIndex, stringLiteral, matchBrace, scanHcl,
} = require(path.join(__dirname, '../../../backend/services/hclScan'));

describe('hclScan: comments and strings never create structure', () => {
  test('a resource header inside a # comment is ignored', () => {
    const src = '# resource "aws_s3_bucket" "fake" {\nresource "aws_s3_bucket" "real" {\n}\n';
    const names = parseBlocks(src).map((b) => b.name);
    expect(names).toEqual(['real']);
  });

  test('a resource header inside a // or /* */ comment is ignored', () => {
    const src = '// resource "a" "x" {\n/* resource "b" "y" {\n */\nresource "c" "z" {\n}\n';
    expect(parseBlocks(src).map((b) => b.name)).toEqual(['z']);
  });

  test('braces inside string literals do not change nesting', () => {
    const src = 'resource "aws_s3_bucket" "b" {\n  bucket = "my-{weird}-bucket"\n  tags = { k = "}" }\n}\nresource "aws_s3_bucket" "c" {\n}\n';
    const blocks = parseBlocks(src);
    expect(blocks.map((b) => b.name)).toEqual(['b', 'c']);
  });

  test('interpolation with nested quotes is balanced', () => {
    const src = 'resource "x" "a" {\n  name = "pre-${lookup({ a = "b" }, "a")}-post"\n}\nresource "x" "b" {\n}\n';
    expect(parseBlocks(src).map((b) => b.name)).toEqual(['a', 'b']);
  });

  test('heredoc bodies are opaque to structure but preserved in text', () => {
    const src = [
      'resource "aws_instance" "web" {',
      '  user_data = <<-EOF',
      '    resource "aws_s3_bucket" "in_heredoc" {',
      '    EOF',
      '}',
    ].join('\n');
    const blocks = parseBlocks(src);
    expect(blocks.map((b) => b.name)).toEqual(['web']);
    const attrs = parseAttributes(blocks[0].body, { base: blocks[0].bodyStart });
    expect(attrs[0].value).toBe('<<-EOF');
    expect(src).toContain('resource "aws_s3_bucket" "in_heredoc"');
  });
});

describe('hclScan: structure', () => {
  test('finds nested child blocks and reports absolute offsets', () => {
    const src = 'resource "aws_security_group" "sg" {\n  ingress {\n    from_port = 22\n  }\n}\n';
    const [sg] = parseBlocks(src);
    expect(sg.type).toBe('resource');
    expect(sg.labels).toEqual(['aws_security_group', 'sg']);
    expect(src.slice(sg.bodyStart, sg.bodyEnd)).toContain('ingress {');
    const [ingress] = parseBlocks(sg.body, { base: sg.bodyStart, lineOf: makeLineIndex(src) });
    expect(ingress.type).toBe('ingress');
    expect(src.slice(ingress.start, ingress.start + 7)).toBe('ingress');
  });

  test('line numbers are 1-based and absolute', () => {
    const src = 'a\nb\nresource "x" "y" {\n  k = 1\n}\n';
    const lineOf = makeLineIndex(src);
    const [blk] = parseBlocks(src, { lineOf });
    expect(blk.line).toBe(3);
    expect(blk.endLine).toBe(5);
  });

  test('attributes report their line and full value (multi-line lists included)', () => {
    const src = 'resource "x" "y" {\n  first = 1\n  list = [\n    "a",\n    "b",\n  ]\n  last = "z"\n}\n';
    const [blk] = parseBlocks(src);
    const attrs = parseAttributes(blk.body, { base: blk.bodyStart, lineOf: makeLineIndex(src) });
    expect(attrs.map((a) => a.name)).toEqual(['first', 'list', 'last']);
    expect(attrs[1].value).toContain('"a"');
    expect(attrs[2].line).toBe(7);
  });

  test('attributes inside nested blocks are not reported at top level', () => {
    const src = 'resource "x" "y" {\n  outer {\n    inner = true\n  }\n}\n';
    const [blk] = parseBlocks(src);
    const names = parseAttributes(blk.body).map((a) => a.name);
    expect(names).toEqual([]);
  });

  test('matchBrace returns -1 for unbalanced input', () => {
    const scanned = scanHcl('resource "x" "y" {\n  a = 1\n');
    expect(matchBrace(scanned, scanned.code.indexOf('{'))).toBe(-1);
  });
});

describe('hclScan: stringLiteral', () => {
  test('unwraps quoted literals and rejects interpolation and expressions', () => {
    expect(stringLiteral('"abc"')).toBe('abc');
    expect(stringLiteral('"a${var.x}"')).toBeNull();
    expect(stringLiteral('var.password')).toBeNull();
    expect(stringLiteral('42')).toBeNull();
  });
});
