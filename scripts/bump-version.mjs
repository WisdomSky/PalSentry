#!/usr/bin/env node
/**
 * Bump every place PalSentry's version is written, and repoint the README's download buttons at the
 * matching release assets.
 *
 * The version is not one value in one file. The desktop package names the release tag and therefore
 * the update feed, the server reports `APP_VERSION` through `/api/health` and `/api/meta`, and the
 * npm workspaces and lockfile each carry their own copy. `.github/workflows/desktop-release.yml`
 * refuses to release when they disagree — and a drifted desktop version would publish an update no
 * installed app can ever see — so they move together, from one command:
 *
 * ```
 * npm run version:bump -- 1.3.0      # or: node scripts/bump-version.mjs v1.3.0
 * npm run version:bump -- --check    # report drift without writing anything
 * ```
 *
 * The script only edits files: committing, tagging and pushing stay with you, and it prints the
 * commands to do them.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The repository whose releases the README's download buttons point at. */
const REPO = 'WisdomSky/PalSentry';

/** The manifest that names a release: its version is the tag, and the tag is the update feed. */
const AUTHORITY = 'packages/desktop/package.json';

const ROOT_MANIFEST = 'package.json';
const LOCKFILE = 'package-lock.json';
const SERVER_VERSION_FILE = 'packages/server/src/version.ts';
const README = 'README.md';

const DOWNLOAD_START = '<!-- downloads:start -->';
const DOWNLOAD_END = '<!-- downloads:end -->';

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const APP_VERSION = /APP_VERSION\s*=\s*'([^']+)'/;

/**
 * The installers the README offers. `artifact` is the name GitHub publishes, which is the name
 * electron-builder writes with its spaces turned into dashes, and `label` is what matches a button
 * in the README to its artifact.
 */
const DOWNLOADS = [
  { label: 'Windows', artifact: (version) => `PalSentry-Setup-${version}.exe` },
  { label: 'macOS', artifact: (version) => `PalSentry-${version}-arm64.dmg` },
  { label: 'Linux', artifact: (version) => `PalSentry-${version}.AppImage` },
];

function downloadUrl(download, version) {
  return `https://github.com/${REPO}/releases/download/v${version}/${download.artifact(version)}`;
}

function read(relative) {
  return readFileSync(path.join(repoRoot, relative), 'utf8');
}

function write(relative, contents) {
  writeFileSync(path.join(repoRoot, relative), contents);
}

/**
 * Every file that states a version: `read()` reports the version it states now (null when it states
 * none) and `render(version)` returns the contents it should have, so one comparison covers both
 * "is anything out of step?" and "what would change?".
 *
 * Rendering the JSON files is safe because they are already in exactly this shape — two-space indent,
 * trailing newline — so a bump changes the version line and nothing else.
 */
function surfaces() {
  const workspaces = JSON.parse(read(ROOT_MANIFEST)).workspaces ?? [];

  const manifest = (file) => ({
    file,
    read: () => JSON.parse(read(file)).version ?? null,
    render: (version) => {
      const value = JSON.parse(read(file));
      value.version = version;
      return `${JSON.stringify(value, null, 2)}\n`;
    },
  });

  const manifests = [ROOT_MANIFEST, ...workspaces.map((dir) => `${dir}/package.json`), AUTHORITY];

  return [
    ...[...new Set(manifests)].map(manifest),
    {
      file: LOCKFILE,
      read: () => JSON.parse(read(LOCKFILE)).version ?? null,
      render: (version) => {
        const lock = JSON.parse(read(LOCKFILE));
        lock.version = version;
        // npm also records each workspace's version in the lockfile. Those copies sat at 1.0.0
        // unnoticed because `npm ci` only checks that the lock resolves the manifests'
        // dependencies, so they are bumped here to keep the file honest.
        lock.packages[''].version = version;
        for (const dir of workspaces) {
          const entry = lock.packages[dir];
          if (entry === undefined) {
            throw new Error(`${LOCKFILE} has no entry for the ${dir} workspace; run npm install`);
          }
          entry.version = version;
        }
        return `${JSON.stringify(lock, null, 2)}\n`;
      },
    },
    {
      file: SERVER_VERSION_FILE,
      read: () => read(SERVER_VERSION_FILE).match(APP_VERSION)?.[1] ?? null,
      render: (version) => {
        const contents = read(SERVER_VERSION_FILE);
        if (!APP_VERSION.test(contents)) {
          throw new Error(`${SERVER_VERSION_FILE} has no APP_VERSION literal to bump`);
        }
        return contents.replace(APP_VERSION, `APP_VERSION = '${version}'`);
      },
    },
    {
      file: README,
      read: () => read(README).match(/releases\/download\/v([^/)]+)\//)?.[1] ?? null,
      render: (version) => replaceDownloadBlock(read(README), version),
    },
  ];
}

function replaceDownloadBlock(contents, version) {
  const start = contents.indexOf(DOWNLOAD_START);
  const end = contents.indexOf(DOWNLOAD_END);
  if (start === -1 || end < start) {
    throw new Error(
      `${README} has no ${DOWNLOAD_START} … ${DOWNLOAD_END} block around its download buttons`,
    );
  }

  // The buttons are hand-made artwork (`images/download-windows.png`), so a bump leaves the image
  // markdown exactly as written and rewrites only where each button points. Everything else in the
  // block — spacing, line breaks, comments — survives untouched, which keeps the diff to the three
  // URLs.
  const block = contents.slice(start + DOWNLOAD_START.length, end);
  const matched = new Set();
  const updated = block.replace(
    /\[!\[([^\]]+)\]\(([^)]+)\)\]\(([^)]+)\)/g,
    (button, label, image, link) => {
      const download = DOWNLOADS.find((candidate) => candidate.label === label);
      if (download === undefined) return button;

      matched.add(label);
      if (link === downloadUrl(download, version)) return button;
      return `[![${label}](${image})](${downloadUrl(download, version)})`;
    },
  );

  const missing = DOWNLOADS.filter((download) => !matched.has(download.label));
  if (missing.length > 0) {
    throw new Error(
      `${README}'s download block has no ${missing.map((d) => d.label).join(', ')} button; ` +
        'restore it before bumping',
    );
  }

  return `${contents.slice(0, start + DOWNLOAD_START.length)}${updated}${contents.slice(end)}`;
}

function usage() {
  return [
    "Bump every file that states PalSentry's version, and repoint the README download buttons.",
    '',
    'Usage:',
    '  node scripts/bump-version.mjs <version>          e.g. 1.3.0 or v1.3.0',
    '  node scripts/bump-version.mjs --check [version]',
    '',
    'Options:',
    '  --check    Report the surfaces that disagree and exit non-zero, without writing.',
    `             Without a version, everything is compared against ${AUTHORITY}.`,
    '  -h, --help Show this message.',
  ].join('\n');
}

function parseArgs(argv) {
  let check = false;
  let version = null;

  for (const arg of argv) {
    if (arg === '--check') check = true;
    else if (arg === '-h' || arg === '--help') return { help: true };
    else if (arg.startsWith('-')) throw new Error(`unknown option ${arg}`);
    else if (version !== null) throw new Error(`unexpected extra argument ${arg}`);
    else version = arg;
  }

  if (version !== null) {
    version = version.startsWith('v') ? version.slice(1) : version;
    if (!SEMVER.test(version)) throw new Error(`"${version}" is not a version like 1.3.0`);
  }

  if (!check && version === null) throw new Error('a version is required, e.g. 1.3.0');

  return { help: false, check, version };
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    console.log(usage());
    return;
  }

  const targets = surfaces();
  const authority = targets.find((target) => target.file === AUTHORITY);

  if (args.check) {
    const expected = args.version ?? authority.read();
    if (expected === null) {
      console.error(`could not read a version from ${AUTHORITY}`);
      process.exitCode = 1;
      return;
    }

    const drifted = targets.filter((target) => target.read() !== expected);
    if (drifted.length === 0) {
      console.log(`every version surface is ${expected}`);
      return;
    }

    console.error(`version drift against ${AUTHORITY} (${expected}):`);
    for (const target of drifted) {
      console.error(`  ${target.file} says ${target.read() ?? 'nothing'}`);
    }
    process.exitCode = 1;
    return;
  }

  const { version } = args;
  const from = authority.read();
  const changed = [];

  for (const target of targets) {
    const next = target.render(version);
    if (next === read(target.file)) continue;

    write(target.file, next);
    changed.push(target.file);
  }

  if (changed.length === 0) {
    console.log(`already at ${version}; nothing to do`);
    return;
  }

  console.log(
    from === null || from === version ? `updated to ${version}:` : `${from} → ${version}:`,
  );
  for (const file of changed) console.log(`  ${file}`);
  console.log('');
  console.log('Next:');
  console.log(`  git add -A && git commit -m "Release ${version}"`);
  console.log(`  git tag v${version}`);
  console.log(`  git push origin v${version}`);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  console.error('');
  console.error(usage());
  process.exitCode = 1;
}
