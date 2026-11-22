import { describe, expect, it } from 'vitest';

import { normalizeUrl, UrlValidationError } from '../src/url.js';
import type { UrlErrorCode } from '../src/url.js';

function errorCodeOf(input: string): UrlErrorCode | undefined {
  try {
    normalizeUrl(input);
    return undefined;
  } catch (error) {
    expect(error).toBeInstanceOf(UrlValidationError);
    return (error as UrlValidationError).code;
  }
}

describe('normalizeUrl', () => {
  it.each([
    ['https://example.com', 'https://example.com/'],
    ['https://münich.example/path', 'https://xn--mnich-kva.example/path'],
    ['https://example.com/page#section', 'https://example.com/page'],
    ['https://example.com/page#', 'https://example.com/page'],
    ['HTTPS://Example.COM/Path', 'https://example.com/Path'],
    ['http://example.com:80/', 'http://example.com/'],
    ['https://example.com:443/', 'https://example.com/'],
    ['https://example.com:8443/', 'https://example.com:8443/'],
    ['https://example.com/a/../b/./c', 'https://example.com/b/c'],
    ['https://example.com/?b=2&a=1', 'https://example.com/?b=2&a=1'],
    ['  https://example.com/  ', 'https://example.com/'],
    ['http://127.0.0.1:3000/x', 'http://127.0.0.1:3000/x'],
  ])('normalizes %s to %s', (input, expected) => {
    expect(normalizeUrl(input)).toBe(expected);
  });

  it('is idempotent', () => {
    const once = normalizeUrl('https://Münich.example/a/../b#x');
    expect(normalizeUrl(once)).toBe(once);
  });

  it.each([
    '',
    '   ',
    'not a url',
    '/relative/path',
    'example.com',
    '//example.com/path',
    'http://',
  ])('rejects %j as invalid_url', (input) => {
    expect(errorCodeOf(input)).toBe('invalid_url');
  });

  it.each([
    'file:///etc/passwd',
    'data:text/html,<h1>hi</h1>',
    'ftp://example.com/file',
    'javascript:alert(1)',
    'mailto:someone@example.com',
    'ws://example.com/',
  ])('rejects %s as unsupported_scheme', (input) => {
    expect(errorCodeOf(input)).toBe('unsupported_scheme');
  });

  it.each([
    'https://user:secret@example.com/',
    'https://user@example.com/',
    'https://:secret@example.com/',
  ])('rejects credentials in %s as invalid_url', (input) => {
    expect(errorCodeOf(input)).toBe('invalid_url');
  });
});
