import { normalizeUrl, UrlValidationError } from '@crawler/shared/url';

/**
 * Validates the URL field as the user types, with the same rules the API applies.
 * Returns the problem to show, or `null` when the URL can be submitted.
 */
export function validateUrlInput(value: string): string | null {
  const input = value.trim();
  if (!input) return 'Inserisci l’URL della pagina da analizzare.';

  try {
    normalizeUrl(input);
    return null;
  } catch (error) {
    if (error instanceof UrlValidationError && error.code === 'unsupported_scheme') {
      return 'Sono supportati solo indirizzi http:// e https://.';
    }
    return 'Inserisci un URL completo, ad esempio https://example.com.';
  }
}
