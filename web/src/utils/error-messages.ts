/**
 * Readable (Italian) text for the stable error codes the API, the worker and the frontend
 * itself produce. Codes are the contract; the text is product copy.
 */
const MESSAGES: Readonly<Record<string, string>> = {
  // Crawl failures stored by the worker.
  robots_disallowed: 'Il robots.txt del sito non consente di analizzare questa pagina.',
  robots_unavailable: 'Non è stato possibile leggere il robots.txt del sito. Riprova tra poco.',
  auth_required: 'La pagina richiede un’autenticazione e non può essere analizzata.',
  tls_error: 'Il certificato TLS del sito non è valido: la connessione sicura non è riuscita.',
  unsafe_target: 'L’indirizzo punta a una rete privata o non raggiungibile dal crawler.',
  dns_failed: 'Il dominio non esiste o non è raggiungibile.',
  navigation_failed: 'Non è stato possibile aprire la pagina.',
  page_timeout: 'La pagina ha impiegato troppo tempo a caricarsi.',
  analysis_failed: 'L’analisi del design non è riuscita.',
  crawl_failed: 'Si è verificato un errore durante l’analisi della pagina.',
  // API.
  stale_job: 'L’elaborazione precedente si è interrotta. Riprova.',
  queue_unavailable: 'Il servizio di elaborazione non è disponibile. Riprova tra poco.',
  storage_unavailable: 'Il database non è disponibile. Riprova tra poco.',
  internal_error: 'Errore interno del server. Riprova tra poco.',
  rate_limited: 'Troppe richieste: attendi un minuto e riprova.',
  invalid_url: 'L’URL non è valido.',
  unsupported_scheme: 'Sono supportati solo indirizzi http e https.',
  not_found: 'La richiesta non esiste più. Riprova.',
  // Frontend.
  poll_timeout: 'L’analisi sta richiedendo più di 30 secondi. Riprova tra poco.',
  network_error: 'Impossibile contattare il server. Controlla la connessione e riprova.',
  invalid_response: 'Il server ha inviato una risposta inattesa.',
};

const FALLBACK = 'Qualcosa è andato storto. Riprova.';
const HTTP_STATUS = /^http_(\d{3})$/;

export function describeError(code: string): string {
  // `hasOwn`: codes come from the server and must never match `toString` and friends.
  if (Object.hasOwn(MESSAGES, code)) return MESSAGES[code] as string;

  const status = HTTP_STATUS.exec(code)?.[1];
  if (status) return `La pagina ha risposto con un errore HTTP ${status}.`;

  return FALLBACK;
}
