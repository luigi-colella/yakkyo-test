// Runs the end-to-end tests: starts the Compose stack with the e2e override, runs
// e2e/crawl.test.mjs against it and always tears it down. `yarn test:e2e` builds the frontend first.
import { execFile, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const root = fileURLToPath(new URL('..', import.meta.url));
const compose = [
  'compose',
  '--project-name',
  'mini-crawler-e2e',
  '--file',
  'docker-compose.yml',
  '--file',
  'docker-compose.e2e.yml',
  // Also for `${...}` interpolation (e.g. the API healthcheck port) instead of .env.
  '--env-file',
  '.env.e2e-testing',
];

let exitCode = 1;
try {
  // Leftovers of an interrupted run would break the fresh-state assertions.
  await run('docker', [...compose, 'down', '--volumes', '--remove-orphans']);
  await run('docker', [...compose, 'up', '--build', '--detach', '--wait', '--wait-timeout', '180']);

  const testEnv = {
    ...process.env,
    E2E_API_URL: `http://${await publishedAddress('api', 8080)}`,
    E2E_RABBIT_URL: `http://${await publishedAddress('rabbit', 15672)}`,
  };
  exitCode = await run(process.execPath, ['--test', 'e2e/crawl.test.mjs'], {
    env: testEnv,
    check: false,
  });
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
} finally {
  if (exitCode !== 0) {
    await run('docker', [...compose, 'logs', '--no-color', '--timestamps'], { check: false });
  }
  const downCode = await run('docker', [...compose, 'down', '--volumes', '--remove-orphans'], {
    check: false,
  });
  if (downCode !== 0) exitCode ||= downCode;
}
process.exitCode = exitCode;

/** Runs a command with inherited stdio; resolves its exit code, rejects on failure when `check`. */
function run(command, args, { env, check = true } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, env, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      const status = code ?? 1;
      if (check && status !== 0) {
        reject(new Error(`${command} ${args.join(' ')} failed (${signal ?? `exit ${status}`})`));
      } else {
        resolve(status);
      }
    });
  });
}

/** The `host:port` Compose published for a service's container port (ephemeral in e2e). */
async function publishedAddress(service, port) {
  const { stdout } = await execFileAsync('docker', [...compose, 'port', service, String(port)], {
    cwd: root,
  });
  return stdout.trim().split(/\r?\n/)[0];
}
