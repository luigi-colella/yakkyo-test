import { describe, expect, it } from 'vitest';

import { validateUrlInput } from '../../src/utils/url-validation.js';

describe('validateUrlInput', () => {
  it.each([
    'https://example.com',
    'http://example.com/path?q=1#section',
    '  https://example.com  ',
    'https://bücher.example/',
    'https://192.0.2.1:8443/',
  ])('accepts %j', (value) => {
    expect(validateUrlInput(value)).toBeNull();
  });

  it.each(['', '   '])('asks for a URL when the field is %j', (value) => {
    expect(validateUrlInput(value)).toBe('Inserisci l’URL della pagina da analizzare.');
  });

  it.each([
    'example.com',
    'https://',
    'not a url',
    '//example.com',
    'https://user:pass@example.com',
  ])('rejects %j as an incomplete or invalid URL', (value) => {
    expect(validateUrlInput(value)).toBe(
      'Inserisci un URL completo, ad esempio https://example.com.',
    );
  });

  it.each(['ftp://example.com', 'data:text/html,hi', 'file:///etc/passwd', 'javascript:alert(1)'])(
    'rejects the scheme of %j',
    (value) => {
      expect(validateUrlInput(value)).toBe('Sono supportati solo indirizzi http:// e https://.');
    },
  );
});
