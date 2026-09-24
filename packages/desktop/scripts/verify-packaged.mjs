/**
 * Drive a packaged PalSentry build through the checks that matter to a user.
 *
 * This is the desktop counterpart of `npm run test:smoke`: it runs against a real installer output
 * on a real OS, because most of what can go wrong in the desktop app — the native SQLite addon, the
 * tray, the embedded server's port, the update handoff — cannot be exercised from unit tests.
 *
 * ```
 * node scripts/verify-packaged.mjs --app release/mac-arm64/PalSentry.app/Contents/MacOS/PalSentry
 * node scripts/verify-packaged.mjs --app release/win-unpacked/PalSentry.exe --feed-dir /tmp/next
 * ```
 *
 * Options: `--app` (defaults to the unpacked build for this platform), `--expect-version` (defaults
 * to the desktop package version), `--feed-dir` (serve this directory as an update feed and run the
 * N → N+1 check), `--extra-arg` (repeatable, passed to the app), `--keep` (leave the temporary data
 * directory behind for inspection).
 *
 * Checks: launch and embedded server, SPA served, first-run connection screen, SQLite schema (so the
 * native addon loaded), tray creation, external-window isolation, connecting to a Palworld server and
 * recording samples, the dashboard rendering live players, recording continuing after the window is
 * closed, and — when `--feed-dir` points at a newer build's `release/` directory — a real N → N+1
 * update. macOS skips the update check, because unsigned builds cannot install one by design.
 *
 * The app is launched with `--user-data-dir` pointing at a temporary directory, so nothing here
 * touches real recorded history.
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');

const MOCK_PASSWORD = 'verify-packaged-password';

// ---------------------------------------------------------------------------
// Arguments and small helpers
// ---------------------------------------------------------------------------

const options = parseArguments(process.argv.slice(2));
const results = [];

function parseArguments(argv) {
  const parsed = new Map();

  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith('--')) continue;

    const value = argv[index + 1];
    const name = key.slice(2);
    const entry = value === undefined || value.startsWith('--') ? true : value;
    if (value !== undefined && !value.startsWith('--')) index += 1;

    // Repeatable options (--extra-arg) accumulate instead of overwriting.
    parsed.set(name, parsed.has(name) ? [].concat(parsed.get(name), entry) : entry);
  }

  return parsed;
}

function defaultAppPath() {
  const release = path.join(here, '..', 'release');

  if (process.platform === 'darwin') {
    return path.join(release, 'mac-arm64', 'PalSentry.app', 'Contents', 'MacOS', 'PalSentry');
  }
  if (process.platform === 'win32') return path.join(release, 'win-unpacked', 'PalSentry.exe');

  return path.join(release, 'linux-unpacked', 'palsentry');
}

/** Where an installed build keeps its data, for the post-update check. */
function installedDataDir() {
  const app = process.platform === 'darwin' ? 'PalSentry' : 'PalSentry';

  if (process.platform === 'darwin')
    return path.join(os.homedir(), 'Library', 'Application Support', app);
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), app);
  }

  return path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'), app);
}

function record(label, passed, detail) {
  results.push({ label, passed, detail });
  const mark = passed ? '  ok  ' : ' FAIL ';
  console.log(`${mark} ${label}${detail === undefined ? '' : ` — ${detail}`}`);

  // GitHub job logs need admin rights to read, but annotations are public through the API, so a
  // failing check reports itself instead of needing someone to copy the log out of the browser.
  if (!passed && process.env.GITHUB_ACTIONS === 'true') {
    console.log(
      `::error::${annotationText(detail === undefined ? label : `${label} — ${detail}`)}`,
    );
  }
}

// Workflow commands are line-based and GitHub truncates long annotations, so flatten and escape.
function annotationText(text) {
  return text.replace(/%/g, '%25').replace(/\r?\n/g, ' · ').replace(/\r/g, '%0D').slice(0, 1000);
}

async function check(label, run) {
  try {
    const detail = await run();
    record(label, true, typeof detail === 'string' ? detail : undefined);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    record(label, false, `${message} (${await appLogTail()})`);
    return false;
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(label, run, { timeoutMs = 30_000, intervalMs = 500 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError;

  while (Date.now() < deadline) {
    try {
      const value = await run();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await sleep(intervalMs);
  }

  throw new Error(
    `${label} timed out after ${timeoutMs}ms${lastError ? ` (${lastError.message})` : ''}`,
  );
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

// Every request asks for `Connection: close`. The app's shutdown waits for keep-alive sockets to
// drain, so a pooled socket of our own would make Fastify's close() run into the shell's 5-second
// grace period instead of finishing — which skips the 'Embedded server stopped' line asserted below
// and can leave the database without its checkpoint.
const CLOSE = { connection: 'close' };

async function getJson(url) {
  const response = await fetch(url, { headers: CLOSE });
  return { status: response.status, body: await response.json().catch(() => null) };
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...CLOSE },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json().catch(() => null) };
}

async function readLogLines(logPath) {
  if (!existsSync(logPath)) return [];

  return (await readFile(logPath, 'utf8'))
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return { msg: line };
      }
    });
}

async function logMessages(logPath) {
  return (await readLogLines(logPath)).map((entry) => String(entry.msg ?? ''));
}

/** One log line as text: the interesting parts are usually fields, not `msg`. */
function describeEntry(entry) {
  const parts = [
    entry.msg,
    entry.status,
    entry.message,
    entry.error,
    entry.err?.message,
    entry.code,
  ].filter((part) => typeof part === 'string' && part !== '');
  return parts.length > 0 ? parts.join(' · ') : JSON.stringify(entry).slice(0, 200);
}

/**
 * The app's own account of a failure. A check that can only report "timed out" says nothing about
 * why, and CI job logs need admin rights to read afterwards: the shell writes to main.log and the
 * embedded server to palsentry.log, and both are worth quoting here.
 */
async function appLogTail() {
  const parts = [`app ${exitDescription}`];

  for (const logPath of [mainLogPath, path.join(userDataDir, 'logs', 'palsentry.log')]) {
    const tail = (await readLogLines(logPath)).slice(-3).map(describeEntry);
    parts.push(`${path.basename(logPath)}: ${tail.length === 0 ? 'no lines' : tail.join(' · ')}`);
  }

  return parts.join(' | ');
}

const CDP_TIMEOUT_MS = 15_000;

// ---------------------------------------------------------------------------
// Chrome DevTools Protocol clients: the renderer page, and the main process
// ---------------------------------------------------------------------------

async function cdp(port, expression, { method = 'Runtime.evaluate', params = {} } = {}) {
  const list = await waitFor(
    `devtools target on ${port}`,
    async () => {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      const targets = await response.json();
      const page = targets.find((target) => target.type === 'page') ?? targets[0];
      return page?.webSocketDebuggerUrl ? page : null;
    },
    { timeoutMs: 15_000 },
  );

  const socket = new WebSocket(list.webSocketDebuggerUrl);
  let nextId = 0;
  const pending = new Map();

  // Every wait is bounded, and a closing socket fails the calls in flight: an app that dies (or is
  // replaced by an installer) must fail the check in seconds rather than hanging it forever.
  function send(command, commandParams) {
    return new Promise((resolve, reject) => {
      const id = (nextId += 1);
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${command} timed out after ${CDP_TIMEOUT_MS}ms`));
      }, CDP_TIMEOUT_MS);

      pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });

      socket.send(JSON.stringify({ id, method: command, params: commandParams }));
    });
  }

  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    const entry = pending.get(message.id);
    if (entry === undefined) return;
    pending.delete(message.id);
    if (message.error) entry.reject(new Error(JSON.stringify(message.error)));
    else entry.resolve(message.result);
  });

  socket.addEventListener('close', () => {
    for (const [id, entry] of pending) {
      pending.delete(id);
      entry.reject(new Error('the DevTools socket closed before the app answered'));
    }
  });

  await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`DevTools socket on ${port} did not open`)),
      CDP_TIMEOUT_MS,
    );
    socket.addEventListener('open', () => {
      clearTimeout(timer);
      resolve();
    });
    socket.addEventListener('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });

  try {
    await send('Runtime.enable', {});
    if (method === 'Page.navigate') await send('Page.enable', {});

    const result = await send(
      method,
      method === 'Runtime.evaluate'
        ? { expression, awaitPromise: true, returnByValue: true }
        : params,
    );

    if (method !== 'Runtime.evaluate') return result;
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description ?? 'evaluation failed');
    }

    return result.result?.value;
  } finally {
    socket.close();
  }
}

/** Evaluate in the renderer. */
function rendererEval(port, expression) {
  return cdp(port, expression);
}

/** Evaluate in the Electron main process, which has no global `require` in ESM. */
function mainEval(port, expression) {
  const bootstrap = `process.getBuiltinModule('module').createRequire(process.getBuiltinModule('path').join(process.resourcesPath, 'app.asar', 'dist', 'main.js'))`;

  return cdp(port, `(() => { const req = ${bootstrap}; ${expression} })()`);
}

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------

function openDatabase(databasePath) {
  const Database = require('better-sqlite3');
  return new Database(databasePath, { readonly: true, fileMustExist: true });
}

function tableCount(databasePath, table) {
  const database = openDatabase(databasePath);
  try {
    return database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count;
  } finally {
    database.close();
  }
}

// ---------------------------------------------------------------------------
// Side processes: a Palworld server to connect to, and an update feed to read
// ---------------------------------------------------------------------------

async function startMockPalworld() {
  const port = await freePort();
  const child = spawn(
    process.execPath,
    [path.join(repoRoot, 'packages', 'server', 'scripts', 'mock-palworld.mjs')],
    {
      env: { ...process.env, MOCK_PORT: String(port), MOCK_ADMIN_PASSWORD: MOCK_PASSWORD },
      stdio: 'ignore',
    },
  );

  await waitFor(
    'mock Palworld server',
    () =>
      new Promise((resolve) => {
        const socket = net.connect(port, '127.0.0.1');
        socket.on('connect', () => {
          socket.destroy();
          resolve(true);
        });
        socket.on('error', () => resolve(false));
      }),
    { timeoutMs: 15_000 },
  );

  return {
    restUrl: `http://127.0.0.1:${port}`,
    password: MOCK_PASSWORD,
    stop: () => child.kill('SIGKILL'),
  };
}

/** Serve a `release/` directory as a generic electron-updater feed. */
/**
 * Read a file from the feed directory.
 *
 * electron-builder writes an artifact's name with spaces but the update metadata's url with dashes, so
 * Windows asks for "PalSentry-Setup-1.0.1.exe" while the file on disk is "PalSentry Setup 1.0.1.exe".
 * The exact name wins; otherwise names are matched with dashes and spaces treated alike.
 */
async function readFeedFile(directory, name) {
  try {
    return await readFile(path.join(directory, name));
  } catch {
    // Fall through to the normalised lookup.
  }

  const wanted = name.replace(/-/g, ' ');
  for (const entry of await readdir(directory).catch(() => [])) {
    if (entry.replace(/-/g, ' ') === wanted) return await readFile(path.join(directory, entry));
  }

  return null;
}

async function startFeedServer(directory) {
  const port = await freePort();
  const server = createServer(async (request, response) => {
    const name = path.basename(new URL(request.url ?? '/', 'http://localhost').pathname);

    const body = await readFeedFile(directory, name);
    if (body === null) {
      response.writeHead(404).end('not found');
      return;
    }

    const type = name.endsWith('.yml') ? 'text/yaml' : 'application/octet-stream';

    // electron-updater downloads differentially by default, asking for byte ranges of the artifact
    // and of its .blockmap. Answering those with the whole file (200) corrupts the download, which
    // then fails its checksum and never reaches the ready state the update check waits for.
    const match = /^bytes=(\d*)-(\d*)$/.exec(String(request.headers.range ?? ''));
    if (match !== null && (match[1] !== '' || match[2] !== '')) {
      const start =
        match[1] === '' ? Math.max(0, body.length - Number(match[2])) : Number(match[1]);
      const end =
        match[1] === '' || match[2] === ''
          ? body.length - 1
          : Math.min(Number(match[2]), body.length - 1);

      if (start > end || start >= body.length) {
        response.writeHead(416, { 'Content-Range': `bytes */${body.length}` }).end();
        return;
      }

      const slice = body.subarray(start, end + 1);
      response.writeHead(206, {
        'Content-Type': type,
        'Content-Length': slice.length,
        'Accept-Ranges': 'bytes',
        'Content-Range': `bytes ${start}-${end}/${body.length}`,
      });
      response.end(slice);
      return;
    }

    response.writeHead(200, {
      'Content-Type': type,
      'Content-Length': body.length,
      'Accept-Ranges': 'bytes',
    });
    response.end(request.method === 'HEAD' ? undefined : body);
  });

  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));

  return {
    url: `http://127.0.0.1:${port}`,
    stop: () => new Promise((resolve) => server.close(resolve)),
  };
}

/** Read the version a feed advertises, so the update check knows what to expect. */
async function feedVersion(directory) {
  const candidates = ['latest.yml', 'latest-mac.yml', 'latest-linux.yml'];

  for (const candidate of candidates) {
    const file = path.join(directory, candidate);
    if (!existsSync(file)) continue;

    const contents = await readFile(file, 'utf8');
    const version = contents.match(/^version:\s*(.+)$/m)?.[1]?.trim();
    if (version) {
      return {
        version,
        file: candidate,
        payload: contents.match(/^path:\s*(.+)$/m)?.[1]?.trim() ?? null,
      };
    }
  }

  throw new Error(`no latest*.yml with a version in ${directory}`);
}

/** sha512 of a file, so a replaced AppImage can be told apart from the one we launched. */
async function digestFile(file) {
  return createHash('sha512')
    .update(await readFile(file))
    .digest('hex');
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

const appPath = typeof options.get('app') === 'string' ? options.get('app') : defaultAppPath();
// Extra Chromium/Electron switches for the app under test: CI needs --no-sandbox and --disable-gpu
// because a headless Linux runner has neither a user-namespace sandbox nor a GPU.
const extraArgs = options.has('extra-arg') ? [].concat(options.get('extra-arg')) : [];
const expectVersion =
  typeof options.get('expect-version') === 'string'
    ? options.get('expect-version')
    : JSON.parse(await readFile(path.join(here, '..', 'package.json'), 'utf8')).version;
const feedDir =
  typeof options.get('feed-dir') === 'string' ? path.resolve(options.get('feed-dir')) : null;
const keepData = options.has('keep');

assert(existsSync(appPath), `app not found: ${appPath}`);

const userDataDir = path.join(os.tmpdir(), `palsentry-verify-${process.pid}`);
await rm(userDataDir, { recursive: true, force: true });
await mkdir(userDataDir, { recursive: true });

const rendererPort = await freePort();
const inspectorPort = await freePort();
const databasePath = path.join(userDataDir, 'palsentry.db');
const mainLogPath = path.join(userDataDir, 'logs', 'main.log');
const configPath = path.join(userDataDir, 'desktop.json');

const mock = await startMockPalworld();
const feed = feedDir === null ? null : await startFeedServer(feedDir);
const updateFeed = feedDir === null ? null : await feedVersion(feedDir);
const updateTo = updateFeed?.version ?? null;

if (feed !== null && updateFeed !== null) {
  // The app can only update if it can read the metadata, so fail loudly here rather than waiting for
  // the updater to time out.
  const response = await fetch(`${feed.url}/${updateFeed.file}`);
  assert(
    response.status === 200,
    `the update feed does not serve ${updateFeed.file} (${response.status})`,
  );
  const advertised = (await response.text()).match(/^version:\s*(.+)$/m)?.[1]?.trim();
  assert(advertised === updateTo, `the served feed advertises ${advertised}, expected ${updateTo}`);

  // Differential downloads are the updater's default, and they only work when ranges come back as
  // 206s — so prove that here instead of discovering it as a 120-second timeout later.
  const ranged = await fetch(`${feed.url}/${updateFeed.file}`, {
    headers: { range: 'bytes=0-99' },
  });
  assert(
    ranged.status === 206,
    `a range request returned ${ranged.status}; differential downloads would fail`,
  );
  const rangedBody = Buffer.from(await ranged.arrayBuffer());
  assert(rangedBody.length === 100, `a 100-byte range returned ${rangedBody.length} bytes`);

  // The artifact is named with spaces on disk but with dashes in the metadata's url, so prove the
  // dashed form is served too — only Windows exercises that for real, and it does it 10 minutes in.
  if (updateFeed.payload !== null) {
    const dashed = updateFeed.payload.replace(/ /g, '-');
    const artifact = await fetch(`${feed.url}/${encodeURIComponent(dashed)}`, {
      headers: { range: 'bytes=0-0' },
    });
    assert(
      artifact.status === 200 || artifact.status === 206,
      `the update feed does not serve ${dashed} (${artifact.status})`,
    );
  }
}

console.log(`verifying ${appPath}`);
console.log(`  version ${expectVersion}, data ${userDataDir}`);
if (updateTo !== null) console.log(`  update feed ${feed.url} -> ${updateTo}`);

const child = spawn(
  appPath,
  [
    `--user-data-dir=${userDataDir}`,
    `--remote-debugging-port=${rendererPort}`,
    `--inspect=${inspectorPort}`,
    ...extraArgs,
  ],
  {
    env: {
      ...process.env,
      // Fast cadences: the defaults are a minute for metrics and five seconds for position
      // recording, and this test wants both to move quickly.
      PALSENTRY_SAMPLE_INTERVAL_SECONDS: '5',
      PALSENTRY_WAYBACK_INTERVAL_SECONDS: '5',
      ...(feed === null ? {} : { PALSENTRY_UPDATE_FEED: feed.url }),
    },
    stdio: 'ignore',
  },
);

let origin = null;
let exited = false;
let exitDescription = 'still running';
child.on('exit', (code, signal) => {
  exited = true;
  exitDescription = signal === null ? `exit code ${code}` : `killed by ${signal}`;
});

async function stopApp() {
  if (exited) return;

  // Ask the app to quit the way Cmd+Q does, so the ordered shutdown runs. The inspector can lose a
  // race with a window that is already closing, so retry before falling back to a signal — SIGTERM
  // skips the ordered path and would report a shutdown failure that never happened.
  for (let attempt = 0; attempt < 3 && !exited; attempt += 1) {
    try {
      await mainEval(inspectorPort, "req('electron').app.quit(); return 'quitting';");
      break;
    } catch {
      if (attempt === 2) child.kill('SIGTERM');
      else await sleep(500);
    }
  }

  await waitFor('app exit', () => exited, { timeoutMs: 20_000 }).catch(() => child.kill('SIGKILL'));
}

try {
  // --- launch, embedded server, SPA -----------------------------------------
  await check('app launches and serves its API', async () => {
    const config = await waitFor('desktop.json', async () => {
      try {
        return JSON.parse(await readFile(configPath, 'utf8'));
      } catch {
        return null;
      }
    });

    origin = `http://127.0.0.1:${config.port}`;
    const health = await waitFor('health endpoint', async () => {
      const result = await getJson(`${origin}/api/health`).catch(() => null);
      return result?.body?.status === 'ok' ? result : null;
    });

    return `port ${config.port}, version ${health.body.version}`;
  });

  await check('serves the built SPA', async () => {
    const response = await fetch(`${origin}/`, { headers: CLOSE });
    const html = await response.text();
    assert(response.status === 200, `GET / returned ${response.status}`);
    assert(html.includes('id="app"'), 'the SPA mount point is missing from the served HTML');

    return 'index.html with the app mount point';
  });

  await check('starts in the desktop first-run state', async () => {
    const connection = await getJson(`${origin}/api/connection`);
    assert(connection.body?.desktop === true, 'desktop flag is not reported');
    assert(connection.body?.configured === false, 'a fresh install should not be connected');

    return 'unconnected, desktop flag reported';
  });

  await check('renders the connection screen', async () => {
    const text = await waitFor('connection form', async () => {
      const body = await rendererEval(rendererPort, 'document.body.innerText').catch(() => '');
      return body.includes('Admin password') ? body : null;
    });

    assert(text.includes('Palworld REST URL'), 'the REST URL field is missing');
    assert(text.includes('Connect'), 'the Connect action is missing');

    const title = await rendererEval(rendererPort, 'document.title');
    assert(title === 'Connect · PalSentry', `unexpected window title: ${title}`);

    return `title "${title}"`;
  });

  await check('loads the native SQLite addon and migrates the schema', async () => {
    await waitFor('database file', () => existsSync(databasePath), { timeoutMs: 15_000 });
    const database = openDatabase(databasePath);

    try {
      const tables = database
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all()
        .map((row) => row.name);

      for (const table of [
        'players',
        'metric_samples',
        'player_position_snapshots',
        'wayback_settings',
      ]) {
        assert(tables.includes(table), `table ${table} is missing`);
      }

      return `${tables.length} tables`;
    } finally {
      database.close();
    }
  });

  await check('creates a tray and reports its version', async () => {
    const messages = await waitFor('startup log', async () => {
      const lines = await logMessages(mainLogPath);
      return lines.includes('PalSentry desktop ready') ? lines : null;
    });

    assert(messages.includes('Tray and application menu are ready'), 'the tray was never created');

    const starting = (await readLogLines(mainLogPath)).find(
      (entry) => entry.msg === 'PalSentry desktop starting',
    );
    assert(starting?.version === expectVersion, `app reports version ${starting?.version}`);

    return `tray ready, version ${starting.version}`;
  });

  await check('uses a native window frame, so the title bar drags and double-clicks', async () => {
    const geometry = JSON.parse(
      await mainEval(
        inspectorPort,
        "const win = req('electron').BrowserWindow.getAllWindows()[0]; return JSON.stringify({ outer: win.getBounds(), content: win.getContentBounds(), resizable: win.isResizable() });",
      ),
    );

    assert(geometry.resizable, 'the window is not resizable');

    // A hidden title bar makes the web content cover the whole window, leaving macOS nothing to drag
    // or double-click. Comparing the window with its content area proves the frame is really there.
    const chrome = geometry.outer.height - geometry.content.height;
    if (process.platform === 'darwin') {
      assert(
        chrome >= 20,
        `no native title bar: window is ${geometry.outer.height}px tall, its content ${geometry.content.height}px`,
      );
    }

    return `${chrome}px of window chrome on ${process.platform}`;
  });

  await check('declares why it needs the local network on macOS', async () => {
    if (process.platform !== 'darwin') return `not applicable on ${process.platform}`;

    // macOS 15 and later drop an app's connections to 192.168.x.x, 10.x.x.x and *.local unless the
    // app declares why it needs them. Without the key the denial is silent: no prompt, nothing in
    // System Settings, and a Palworld server that only ever looks unreachable.
    const plist = path.join(path.dirname(path.dirname(appPath)), 'Info.plist');
    const contents = await readFile(plist, 'utf8');
    assert(
      contents.includes('NSLocalNetworkUsageDescription'),
      `${plist} does not declare NSLocalNetworkUsageDescription`,
    );

    return 'Info.plist declares NSLocalNetworkUsageDescription';
  });

  await check('keeps web content out of new windows', async () => {
    const opened = await rendererEval(
      rendererPort,
      "String(window.open('https://example.com/palsentry-verify'))",
    );
    assert(opened === 'null', `window.open returned ${opened}`);

    const before = await rendererEval(rendererPort, 'location.href');
    await rendererEval(rendererPort, "location.href = 'file:///etc/passwd'").catch(() => undefined);
    await sleep(500);
    const after = await rendererEval(rendererPort, 'location.href');
    assert(before === after, `the renderer navigated to ${after}`);

    return 'window.open denied, file:// navigation refused';
  });

  // --- connect to a Palworld server and record ------------------------------
  await check('connects to a Palworld server and starts recording', async () => {
    const connected = await postJson(`${origin}/api/connection`, {
      restUrl: mock.restUrl,
      adminPassword: mock.password,
    });
    assert(
      connected.status === 200,
      `connect returned ${connected.status}: ${JSON.stringify(connected.body)}`,
    );
    assert(connected.body?.configured === true, 'connect did not report a live connection');

    const meta = await getJson(`${origin}/api/meta`);
    assert(meta.status === 200, `/api/meta returned ${meta.status} after connecting`);
    assert(meta.body?.app?.desktop === true, '/api/meta does not report desktop mode');
    assert(
      meta.body?.app?.authEnabled === false,
      'desktop mode must not ask for a PalSentry login',
    );

    await waitFor('metric samples', () => tableCount(databasePath, 'metric_samples') >= 1, {
      timeoutMs: 60_000,
    });
    await waitFor('player positions', () => tableCount(databasePath, 'player_positions') >= 4, {
      timeoutMs: 60_000,
    });

    const players = tableCount(databasePath, 'players');
    assert(players >= 4, `the roster only knows ${players} players`);

    return `${players} roster players, samples and positions written`;
  });

  await check('renders the dashboard with live players', async () => {
    await cdp(rendererPort, '', { method: 'Page.navigate', params: { url: `${origin}/` } });

    // Wait for the dashboard's own card, not for a player's name and not for the navigation's label:
    // the page the previous check left behind can still be on screen when the poll starts, and the
    // navigation drops its labels on a narrow window, which a CI runner's screen produces.
    const text = await waitFor('the dashboard', async () => {
      const body = await rendererEval(rendererPort, 'document.body.innerText').catch(() => '');
      return /online players/i.test(body) ? body : null;
    }).catch(async (error) => {
      const where = await rendererEval(rendererPort, 'location.pathname + location.search').catch(
        () => '?',
      );
      const body = await rendererEval(rendererPort, 'document.body.innerText').catch(() => '');
      throw new Error(
        `${error?.message ?? String(error)} (at ${where}, body: ${body.replace(/\s+/g, ' ').slice(0, 200)})`,
      );
    });

    assert(/alice/i.test(text), 'the dashboard does not list the online players');

    return 'dashboard shows the connected server’s players';
  });

  await check('keeps recording after the window is closed', async () => {
    const before = tableCount(databasePath, 'metric_samples');

    await mainEval(
      inspectorPort,
      "req('electron').BrowserWindow.getAllWindows()[0].close(); return 'closed';",
    );

    await waitFor(
      'window hidden',
      async () =>
        (await logMessages(mainLogPath)).includes('Window hidden; recording continues in the tray'),
      { timeoutMs: 10_000 },
    );

    await waitFor('further samples', () => tableCount(databasePath, 'metric_samples') > before, {
      timeoutMs: 45_000,
    });

    return `still sampling with no window (${before} → ${tableCount(databasePath, 'metric_samples')})`;
  });

  // --- update ---------------------------------------------------------------
  if (updateTo === null) {
    record('installs an N → N+1 update', true, 'skipped: no --feed-dir');
  } else if (process.platform === 'darwin') {
    record('installs an N → N+1 update', true, 'skipped: unsigned macOS builds do not update');
  } else {
    // The AppImage updater installs by deleting the running AppImage and moving the download next to
    // it under the downloaded file's own name, then re-runs it with an empty argv
    // (`spawnLog(destination, [], env)`), so the relaunch cannot carry the --no-sandbox a headless
    // runner needs to start Chromium and dies before it logs anything. Linux therefore asserts the
    // install and leaves the relaunch to Windows, where the platform needs no such switch.
    const updateCheckName =
      process.platform === 'linux'
        ? `installs the ${updateTo} update`
        : `installs the ${updateTo} update and restarts`;
    await check(updateCheckName, async () => {
      // "Restart to update" in the menu is what the user actually sees, and the ready text is logged
      // as a structured field that a message-only reader would miss — so accept either signal.
      const menuFinder = `const { Menu } = req('electron');
         const find = (items) => {
           for (const item of items) {
             if (item.label === 'Restart to update') return item;
             const hit = item.submenu ? find(item.submenu.items) : null;
             if (hit) return hit;
           }
           return null;
         };`;

      // Readiness is the menu item the user can actually click. The item exists from the moment the
      // updater is created but stays disabled until a download is ready, and clicking a disabled item
      // is a silent no-op — which is how the Linux install check failed while the log said "ready".
      const menuState = async () =>
        await mainEval(
          inspectorPort,
          `${menuFinder}
           const item = find(Menu.getApplicationMenu().items);
           return { present: item !== null, enabled: item !== null && item.enabled === true };`,
        ).catch(() => null);

      const logSaysReady = async () =>
        (await readLogLines(mainLogPath)).some(
          (entry) =>
            entry.msg === 'Update status changed' &&
            String(entry.status ?? '').includes('is ready'),
        );

      try {
        await waitFor('downloaded update', async () => (await menuState())?.enabled === true, {
          timeoutMs: 120_000,
          intervalMs: 1_000,
        });
      } catch (error) {
        // A download that fails says why in the app's own log; a bare timeout says nothing, and CI
        // job logs need admin rights to read afterwards.
        const lines = (await readLogLines(mainLogPath))
          .filter((entry) => /update|download|error/i.test(JSON.stringify(entry)))
          .slice(-4)
          .map((entry) =>
            [entry.msg, entry.status, entry.error]
              .filter((part) => typeof part === 'string' && part !== '')
              .join(' · '),
          )
          .join(' | ');
        const state = await menuState();
        const described =
          state === null
            ? 'unreadable'
            : state.present
              ? state.enabled
                ? 'enabled'
                : `present but disabled${(await logSaysReady()) ? ' while the log says ready' : ''}`
              : 'absent';

        throw new Error(
          `${error?.message ?? String(error)} (menu: ${described}; app log: ${lines === '' ? 'no update lines' : lines})`,
        );
      }

      await mainEval(
        inspectorPort,
        `${menuFinder}
         const item = find(Menu.getApplicationMenu().items);
         if (item === null) throw new Error('Restart to update is missing from the menu');
         item.click();
         return 'clicked';`,
      );

      // A click on a disabled item does nothing at all, so prove the shell actually started shutting
      // down rather than letting a later assertion fail for a reason that hides this one.
      const shuttingDown = await waitFor(
        'the shell to start shutting down',
        async () => (await logMessages(mainLogPath)).includes('Shutting down'),
        { timeoutMs: 20_000, intervalMs: 500 },
      )
        .then(() => true)
        .catch(() => false);

      assert(
        shuttingDown,
        `clicking 'Restart to update' did nothing (menu: ${JSON.stringify(await menuState())})`,
      );

      if (process.platform === 'linux') {
        assert(updateFeed.payload !== null, 'the update feed does not name the artifact it serves');

        // "Not replaced" could mean the updater never moved the file or that it moved something else,
        // so report what the path held, what it holds now, and what was served.
        const describeFile = async (file) => {
          try {
            const stats = statSync(file);
            return `${(await digestFile(file)).slice(0, 12)} (${stats.size} bytes)`;
          } catch {
            return 'unreadable';
          }
        };

        // electron-updater deletes the running AppImage and moves the download next to it under the
        // downloaded file's own name, because the running file's name already carries a version.
        const servedPath = path.join(feedDir, updateFeed.payload);
        const installedPath = path.join(path.dirname(appPath), updateFeed.payload);
        const served = await digestFile(servedPath);

        const installed = await waitFor(
          `${path.basename(installedPath)} to appear`,
          async () => (await digestFile(installedPath).catch(() => null)) === served,
          { timeoutMs: 30_000, intervalMs: 1_000 },
        )
          .then(() => true)
          .catch(() => false);

        assert(
          installed,
          `the downloaded update was not installed: ${installedPath} is ${await describeFile(installedPath)}, ${appPath} is ${await describeFile(appPath)}, and the feed served ${await describeFile(servedPath)}`,
        );
        assert(!existsSync(appPath), `the old AppImage ${appPath} was left behind`);

        return `installed ${updateTo} as ${path.basename(installedPath)} (the AppImage relaunch is not asserted here)`;
      }

      // The installer replaces the app and starts it again; the relaunch writes to its own log, and
      // on Windows that is the installed data directory rather than the temporary one.
      const logCandidates = [mainLogPath, path.join(installedDataDir(), 'logs', 'main.log')];
      const started = await waitFor(
        `version ${updateTo} to start`,
        () =>
          Promise.all(
            logCandidates.map(async (logPath) =>
              (await readLogLines(logPath)).some(
                (entry) => entry.msg === 'PalSentry desktop starting' && entry.version === updateTo,
              ),
            ),
          ).then((found) => found.some(Boolean)),
        { timeoutMs: 180_000, intervalMs: 2_000 },
      ).catch(async (error) => {
        // The installer starts the new version itself, so it carries none of our switches and writes
        // to its own log directory: report what each candidate actually holds.
        const seen = [];
        for (const logPath of logCandidates) {
          const entries = await readLogLines(logPath);
          const tail = entries
            .slice(-3)
            .map(
              (entry) =>
                `${String(entry.msg ?? '')}${entry.version === undefined ? '' : ` v${entry.version}`}`,
            )
            .join(' · ');
          seen.push(`${logPath}: ${tail === '' ? 'no log' : tail}`);
        }
        throw new Error(`${error?.message ?? String(error)} (${seen.join(' | ')})`);
      });

      assert(started, 'the updated app never started');
      await waitFor('app exit before install', () => exited, { timeoutMs: 30_000 }).catch(
        () => undefined,
      );

      return `now running ${updateTo}`;
    });
  }

  // --- shutdown -------------------------------------------------------------
  await check('shuts down cleanly', async () => {
    await stopApp();
    const messages = await logMessages(mainLogPath);
    // A process that dies mid-shutdown is what a second quit looks like, and job logs need admin
    // rights to read afterwards, so carry the evidence in the failure itself.
    const tail = (await readLogLines(mainLogPath))
      .slice(-5)
      .map((entry) => String(entry.msg ?? ''))
      .filter((message) => message !== '')
      .join(' | ');
    const detail = `app ${exitDescription}; main.log tail: ${tail === '' ? '(empty)' : tail}`;
    assert(messages.includes('Shutting down'), `no shutdown was logged (${detail})`);
    assert(
      messages.includes('Embedded server stopped'),
      `the embedded server was not closed (${detail})`,
    );
    assert(messages.includes('Goodbye'), `shutdown did not finish (${detail})`);
    assert(!existsSync(`${databasePath}-wal`), `SQLite left a write-ahead log behind (${detail})`);

    return 'ordered shutdown, database checkpointed';
  });
} finally {
  await stopApp();
  mock.stop();
  if (feed !== null) await feed.stop();
  if (!keepData) await rm(userDataDir, { recursive: true, force: true });
}

const failed = results.filter((result) => !result.passed);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);

if (failed.length > 0) {
  const summary = `failed: ${failed.map((result) => result.label).join(', ')}`;
  console.error(summary);
  if (process.env.GITHUB_ACTIONS === 'true') console.error(`::error::${annotationText(summary)}`);
  process.exit(1);
}
