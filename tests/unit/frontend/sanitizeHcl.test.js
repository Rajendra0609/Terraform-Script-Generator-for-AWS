/**
 * tests/unit/frontend/sanitizeHcl.test.js
 *
 * Unit tests for frontend/src/utils/sanitizeHcl.js
 * (runs in Node via Jest — no browser needed)
 */
'use strict';

const path = require('path');
const sanitizeHcl = require(path.join(__dirname, '../../../frontend/src/utils/sanitizeHcl')).default; // ES default export

describe('sanitizeHcl()', () => {
  test('strips <script> injection from HCL string', () => {
    const input  = '<script>alert(1)</script>resource "aws_vpc" "main" {}';
    const result = sanitizeHcl(input);
    expect(result).not.toMatch(/<script>/i);
    expect(result).toMatch(/aws_vpc/);
  });

  // Realistic leak: colorized HTML copied out of the editor. Bare text with no
  // markup deliberately takes sanitizeHcl's fast path and is returned unchanged,
  // because `color: "x"` can be valid HCL object syntax.
  test('removes inline CSS style attributes leaked from highlighted HTML', () => {
    const input  = 'resource "aws_s3_bucket" "b" { <span style="color: red;">bucket = "x"</span> }';
    const result = sanitizeHcl(input);
    expect(result).not.toMatch(/color:\s*red/i);
    expect(result).toMatch(/aws_s3_bucket/);
  });

  test('returns the original string when input is already clean', () => {
    const hcl = `
      resource "aws_instance" "web" {
        ami           = "ami-12345678"
        instance_type = "t3.micro"
      }
    `;
    expect(sanitizeHcl(hcl)).toContain('aws_instance');
  });

  test('handles empty string without throwing', () => {
    expect(() => sanitizeHcl('')).not.toThrow();
    expect(sanitizeHcl('')).toBe('');
  });

  test('handles null/undefined gracefully', () => {
    expect(() => sanitizeHcl(null)).not.toThrow();
    expect(() => sanitizeHcl(undefined)).not.toThrow();
  });

  test('preserves multi-line HCL structure', () => {
    const hcl = `
resource "aws_security_group" "web" {
  name = "web-sg"
  ingress {
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }
}`;
    const result = sanitizeHcl(hcl);
    expect(result).toMatch(/aws_security_group/);
    expect(result).toMatch(/443/);
  });
});
