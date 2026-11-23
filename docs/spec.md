> **Info**
>
> Questo esercizio serve sia a valutare le tue capacità tecniche, sia a mostrarti concretamente con quali tecnologie lavoriamo e come di solito vengono scritte le nostre specifiche. Non è quindi un compito teorico, ma un piccolo esempio di come potrebbe apparire un vero task nel lavoro quotidiano.

> **Warning**
>
> L’uso di strumenti basati su AI è consentito, ma il candidato deve dimostrare di saper padroneggiare in pieno il codice prodotto. Alla consegna il repository verrà analizzato per stimare quanto codice sia stato generato automaticamente e quanto presenti segni di “AI slob” (cioè parti incollate senza reale comprensione). Durante la successiva call tecnica con il CTO e/o il lead developer, **sarà importante saper spiegare le scelte fatte in modo chiaro e coerente**. Anche la storia dei commit avrà peso nella valutazione: **preferiamo più commit piccoli e ragionati piuttosto che un unico grande commit finale**.

# Mini Crawler: API + Frontend statico + Worker

## Obiettivo

Un monorepo con:

- **API Express** che serve anche lo **static frontend Vue 3 + TS** (compilato in `public/` via `yarn build-frontend`).
- **Endpoint**:
  - `POST /crawl` → accetta `{ url }`, valida, pubblica su **RabbitMQ**, ritorna `{ uid }`.
  - `GET /crawl/:uid` → ritorna `{ status: "pending|done|error", result? }`.
- **Worker** Node che consuma la coda, apre **Playwright/Puppeteer** headless, fa **full-page screenshot JPEG qualità 50**, chiama **OpenAI** per una **descrizione orientata al design**, salva in **MongoDB** collezione `pages` (blob immagine + testo + uid).
- Tutto lanciabile con **docker-compose**.

## Requisiti tecnici

### 1) Repo layout

```bash
/app
  /api
    src/
    package.json
  /web
    src/
    vite.config.ts
    package.json
  /worker
    src/
    package.json
  docker-compose.yml
  Dockerfile.api
  Dockerfile.worker
  .env.example
  README.md
```

### 2) Frontend (Vue 3 + TS)

- Pagina unica con:
  - Input per URL (validazione immediata).
  - CTA “Crawl”.
  - **Loader bloccante** durante l’elaborazione.
  - Polling ogni 2s su `GET /crawl/:uid` con **exponential backoff** fino a 30s max.
  - Stato finale:
    - **Success**: mostra screenshot (img) + descrizione testuale.
    - **Error**: messaggio chiaro + bottone “Riprova”.
- Script `yarn build-frontend` nella root che:
  - `cd web && yarn && yarn build`
  - copia `web/dist/**` in `api/public/`.

### 3) API (Express)

- Serve statici da `public/`.
- `POST /crawl`:
  - Body `{ url: string }`.
  - **Validazione**: URL assoluto, schema http/https, no `data:`/`file:`.
  - **Normalizzazione** (punycode, rimozione frammenti).
  - Genera `uid` (ulid).
  - Scrive in Mongo `pages` un **placeholder** (`status: "pending"`, url, uid, createdAt).
  - Pubblica messaggio su RabbitMQ: `{ uid, url, requestedAt }` su coda `crawl.requests`.
  - Ritorna `{ uid }`.
  - **Idempotenza e cache**: due comportamenti distinti, entrambi sulla `url` normalizzata.
    - **Crawl in corso**: se esiste un job `pending` per quella url creato da meno di 5 minuti, non avviare un nuovo crawl e riusa lo stesso `uid`. Oltre i 5 minuti il `pending` è considerato bloccato e si riparte da zero.
    - **Crawl completato (cache)**: se esiste un job `done` per quella url completato da meno di **60 secondi**, ritorna lo stesso `uid` senza pubblicare nulla su RabbitMQ. Il TTL si misura dal momento del completamento, non dalla creazione.
    - Passati i 60 secondi dal completamento, una nuova richiesta sulla stessa url avvia un crawl nuovo con un `uid` nuovo.
- `GET /crawl/:uid`:
  - Cerca in `pages` per uid.
  - Risponde con:
    - `pending`: `{ status: "pending" }`
    - `done`: `{ status: "done", result: { image: "data:image/jpeg;base64,...", description, url, tookMs } }`
    - `error`: `{ status: "error", message }`
- **Rate-limit** basic (es. 10/min per IP) e **request-id** nei log.
- **Health**: `GET /healthz` (ok se Mongo e Rabbit raggiungibili).

### 4) Worker

- Consuma `crawl.requests` con **prefetch 1**.
- Per ogni messaggio:
  - **Timeout hard** 30s per pagina.
  - **Browser**: Playwright (consigliato in Docker) o Puppeteer.
  - **Robo-etica**: se `robots.txt` vieta `User-agent: *` per `/`, segna `error` “disallowed by robots”.
    - Basta una GET veloce a `/robots.txt` e un parser minimale per `Disallow: /`.
  - `page.goto(url, waitUntil: "networkidle")`, **viewport ampio** e `fullPage: true`.
  - Screenshot `jpeg` qualità **50**.
  - Chiama OpenAI (Vision) passando lo screenshot inline e **prompt**:

    > “Descrivi layout, gerarchia visiva, palette, tipografia, pattern UI, densità contenuti. Evita contenuti testuali del sito; concentrati su design e UX.”
    >
  - Salva su Mongo `pages` (update by uid):
    - `status: "done"`
    - `description` (string)
    - `image` (GridFS oppure `Buffer` binario nel doc; scegli e motiva in `design.md`)
    - `tookMs`
    - `meta`: { viewport, userAgent, timestamp }
  - In caso di errore: `status: "error"`, `message`.
  - **Ack/Nack** corretto; **retry** massimo 2 volte con `x-dead-letter-exchange`.

### 5) MongoDB (Mongoose)

- DB: `crawler`.
- Collezione: `pages`.
- Schema consigliato:

```javascript
{
  uid: String, // unique, indexed
  url: String, // indexed
  status: "pending"|"done"|"error",
  description?: String,
  imageRef?: ObjectId, // se GridFS
  image?: Buffer,      // alternativa
  errorMessage?: String,
  tookMs?: Number,
  createdAt: Date,
  updatedAt: Date,
  meta: {
    viewport: { w: Number, h: Number },
    userAgent: String
  }
}
```

- **Indici**: `{ uid: 1 } unique`, `{ createdAt: -1 }`, `{ url: 1, status: 1 }`.

### 6) RabbitMQ

- Exchange `crawl` (direct), coda `crawl.requests` binding `crawl.requests`.
- Dead-letter: exchange `crawl.dlx`, coda `crawl.dead`.

### 7) OpenAI

- Variabile

```bash
OPENAI_API_KEY=sk-proj-REDACTED
```

## Docker & Compose

### docker-compose.yml (specifica attesa)

- Servizi:
  - `api`: build `Dockerfile.api`, dipende da `mongo`, `rabbit`, espone `:8080`, monta niente.
  - `worker`: build `Dockerfile.worker`, dipende da `mongo`, `rabbit`.
  - `mongo`: immagine `mongo:7`, volume persistente.
  - `rabbit`: immagine `rabbitmq:3-management`, porta `15672` per UI.
- Reti: default bridge.
- Env da `.env`:
  - `MONGO_URI=mongodb://mongo:27017/crawler`
  - `RABBIT_URL=amqp://rabbit:5672`
  - `PORT=8080`
  - `OPENAI_API_KEY=...`
  - `OPENAI_MOCK=1|0`
  - `BASE_URL=http://api:8080` (se serve)
- **Dockerfile.api**: Node 20-alpine, copia `api/`, `public/`, `yarn install --production`, `node dist/index.js`.
- **Dockerfile.worker**: usare base **mcr.microsoft.com/playwright:v1.47.0-jammy** (semplifica i deps) o aggiungere dipendenze Chromium se Puppeteer.

## Contratti API (chiari e testabili)

- `POST /crawl`
  - Req: `Content-Type: application/json`, `{ "url": "https://example.com" }`
  - 202: `{ "uid": "01J..." }`
  - 400: `{ "error": "invalid_url" }`, `{ "error": "unsupported_scheme" }`
- `GET /crawl/:uid`
  - 200:
    - `{ "status": "pending" }`
    - `{ "status": "done", "result": { "url": "...", "description": "...", "image": "data:image/jpeg;base64,..." , "tookMs": 1234 } }`
    - `{ "status": "error", "message": "..." }`
  - 404 se uid inesistente.

---

## Casi limite obbligatori

- URL con **redirect 301/302** (mantieni la descrizione della pagina finale).
- Pagine **SPA**: usa `networkidle` + **timeout**; se non “si ferma” entro 10s, fallback a `domcontentloaded`.
- **robots.txt** che vieta: marcato `error`.
- Pagine che richiedono **basic auth**: marcato `error` “auth_required”.
- **Certificati TLS** strani: gestisci con messaggio chiaro, non spegnere la verifica TLS.
- **Concurrency**: invia 3 crawl della stessa URL quasi in contemporanea → deve esistere **un solo** job (idempotenza).
- **Cache hit**: richiedi di nuovo la stessa URL entro 60 secondi dal completamento del primo crawl → stesso `uid`, risposta immediata, **nessun** nuovo messaggio su RabbitMQ e **nessun** nuovo screenshot.
- **Cache miss**: richiedi la stessa URL dopo più di 60 secondi dal completamento → `uid` nuovo e crawl nuovo. Il TTL parte dal completamento, non dalla creazione del job.

## Cosa consegnare

- **README** con:
  - `yarn build-frontend`
  - `docker compose up --build`
  - Credenziali Rabbit UI (default).
  - Variabili `.env`.
- **design.md** (max 1-2 pagine): decisioni chiave, trade-off, failure modes.
- **Tests**:
  - Script `yarn test:e2e` che:
    - Avvia stack.
    - `POST /crawl` su 3 URL (uno vietato da robots).
    - Polling e asserzioni sugli esiti.
    - Verifica idempotenza: 3 `POST /crawl` sulla stessa URL in contemporanea → un solo `uid`.
    - Verifica **cache hit**: ripetere la stessa URL entro 60s dal `done` → stesso `uid`, nessun nuovo job in coda.
    - Verifica **cache miss**: attendere oltre 60s dal `done` e ripetere → `uid` diverso.
- **Git hygiene**: **3-6 commit chiari, non un dump monolitico.**
