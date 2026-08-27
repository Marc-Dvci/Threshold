/**
 * One command to run the whole federation locally.
 *
 * Seven processes, because the topology is the product: four web origins and three organisations'
 * booking systems. A judge should not have to open seven terminals to see that, and a demo that
 * needs a setup ritual is a demo that fails on the day.
 *
 *   5100  hub                  the coordinating page
 *   5101  respite-a page       Meadowbank Respite Unit
 *   6101  respite-a backend    its lease store
 *   5102  homecare-a page      Selwyn Overnight Care
 *   6102  homecare-a backend
 *   5103  transport-a page     Northgate Accessible Transport
 *   6103  transport-a backend
 *
 * The page and the backend are separate processes on purpose (§5.4): an organisation's booking
 * system is not its web server, and modelling them as one was a convenience that happened also to be
 * a fiction. The page reaches its own backend over HTTP in development exactly as it does in
 * production, so there is one code path rather than two that agree until they do not.
 *
 * Dependency-free. `concurrently` would be one more thing to install before anything runs.
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** ANSI colours, one per origin, so seven interleaved logs stay readable. */
const COLOURS = ['36', '34', '35', '32', '33', '31', '90'];

const TASKS = [
  { label: 'hub       :5100', filter: '@threshold/hub', script: 'dev' },
  { label: 'respite   :5101', filter: '@threshold/provider-respite', script: 'dev' },
  { label: 'respite   :6101', filter: '@threshold/provider-respite', script: 'api' },
  { label: 'homecare  :5102', filter: '@threshold/provider-homecare', script: 'dev' },
  { label: 'homecare  :6102', filter: '@threshold/provider-homecare', script: 'api' },
  { label: 'transport :5103', filter: '@threshold/provider-transport', script: 'dev' },
  { label: 'transport :6103', filter: '@threshold/provider-transport', script: 'api' },
];

const children = [];

for (const [index, task] of TASKS.entries()) {
  const colour = COLOURS[index % COLOURS.length];
  const child = spawn('pnpm', ['--filter', task.filter, task.script], {
    cwd: root,
    shell: process.platform === 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      // The provider pages run on a different port from their own backends in development, so the
      // backend answers exactly one page origin. Never `*`.
      THRESHOLD_PAGE_ORIGIN: process.env.THRESHOLD_PAGE_ORIGIN ?? '',
    },
  });
  children.push(child);

  const prefix = `[${colour}m${task.label}[0m │ `;
  const pipe = (stream) => {
    let buffer = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) process.stdout.write(`${prefix}${line}\n`);
    });
  };
  pipe(child.stdout);
  pipe(child.stderr);

  child.on('exit', (code) => {
    process.stdout.write(`${prefix}exited with code ${code}\n`);
  });
}

const shutdown = () => {
  for (const child of children) child.kill();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

process.stdout.write(
  '\nThreshold is starting.\n' +
    '  hub          http://localhost:5100\n' +
    '  verify       http://localhost:5100/verify.html\n' +
    '  respite      http://localhost:5101?control   (the offline switch)\n' +
    '  homecare     http://localhost:5102?control\n' +
    '  transport    http://localhost:5103?control\n\n',
);
