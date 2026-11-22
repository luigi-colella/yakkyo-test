// Fixture website for the end-to-end tests. One server, reached on the Compose network under two
// host names: `fixture-site` allows crawling, `fixture-robots-denied` forbids it in robots.txt.
import http from 'node:http';

const PORT = 8081;
const ROBOTS_DENIED_HOST = 'fixture-robots-denied';

const STATIC_BODY = `<main class="card">
  <p class="eyebrow">Fixture</p>
  <h1>A stable page to capture</h1>
  <p>Static content with a clear hierarchy.</p>
  <button>Primary action</button>
</main>`;

// Rendered by a script after one request, so the network goes idle quickly.
const SPA_BODY = `<main class="card" id="app">Loading…</main>
<script>
  fetch('/spa/data.json')
    .then((response) => response.json())
    .then(({ title }) => {
      document.querySelector('#app').innerHTML = '<h1></h1><p>Client-side rendering.</p>';
      document.querySelector('#app h1').textContent = title;
    });
</script>`;

/** Static responses by path, each with the e2e scenario it serves. */
const ROUTES = {
  '/': html('Fixture page', STATIC_BODY), // plain page
  '/redirect': { status: 301, headers: { Location: '/spa' } }, // redirect to the SPA
  '/spa': html('SPA fixture', SPA_BODY), // where the redirect lands
  '/spa/data.json': json({ title: 'Rendered on the client' }), // fetched by the SPA
  '/auth': { status: 401, headers: { 'WWW-Authenticate': 'Basic realm="fixture"' } }, // basic auth
  '/healthz': text(200, 'ok'), // Compose healthcheck
};

const server = http.createServer((request, response) => {
  const { pathname } = new URL(request.url ?? '/', 'http://fixture');
  if (pathname === '/robots.txt') return respond(response, robotsTxt(request));
  respond(response, ROUTES[pathname] ?? text(404, 'not found'));
});

server.listen(PORT, '0.0.0.0', () => console.log(`Fixture site listening on :${PORT}`));
// PID 1 in its container: exit on the stop signal instead of waiting for the kill.
process.on('SIGTERM', () => process.exit(0));

/** The only dynamic route: the robots-denied host forbids everything, the other allows it. */
function robotsTxt(request) {
  const hostname = (request.headers.host ?? '').replace(/:\d+$/, '');
  return text(
    200,
    hostname === ROBOTS_DENIED_HOST ? 'User-agent: *\nDisallow: /\n' : 'User-agent: *\nDisallow:\n',
  );
}

function respond(response, { status, headers = {}, body }) {
  response.writeHead(status, headers);
  response.end(body);
}

function text(status, body) {
  return { status, headers: { 'Content-Type': 'text/plain; charset=utf-8' }, body };
}

function json(value) {
  return {
    status: 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(value),
  };
}

function html(title, body) {
  return {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
    body: page(title, body),
  };
}

function page(title, body) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>${title}</title>
    <style>
      body { margin: 0; padding: 64px; min-height: 1400px; background: #f4f1ea; color: #1d2421; font-family: sans-serif; }
      .card { max-width: 720px; padding: 48px; border-radius: 16px; background: #fff; }
      .eyebrow { text-transform: uppercase; letter-spacing: 0.1em; color: #5b6f62; }
      h1 { font-size: 56px; line-height: 1.05; }
      button { padding: 14px 20px; border: 0; border-radius: 8px; background: #1f4d3f; color: #fff; }
    </style>
  </head>
  <body>
${body}
  </body>
</html>`;
}
