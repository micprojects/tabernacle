import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cpus, release, totalmem } from 'node:os';

export const exec = promisify(execFile);
export const repositoryRoot = resolve(import.meta.dirname, '../..');

export async function fingerprintSource(root) {
  const files = [];

  async function walk(directory) {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile())
        files.push({ path: relative(root, path), bytes: await readFile(path) });
    }
  }

  await walk(resolve(root, 'extension'));
  const hash = createHash('sha256');
  for (const file of files) hash.update(`${file.path}\0${file.bytes.length}\0`).update(file.bytes);
  let commit = null;
  try {
    const { stdout: top } = await exec('git', ['-C', root, 'rev-parse', '--show-toplevel']);
    if (resolve(top.trim()) === resolve(root)) {
      const { stdout } = await exec('git', ['-C', root, 'rev-parse', 'HEAD']);
      commit = stdout.trim();
    }
  } catch {
    /* Exported baselines need no Git checkout; the content hash is authoritative. */
  }
  const manifest = JSON.parse(await readFile(resolve(root, 'extension/manifest.json'), 'utf8'));
  return {
    root: resolve(root),
    sha256: hash.digest('hex'),
    files: files.length,
    commit,
    manifestVersion: manifest.version,
  };
}

export function machineInfo() {
  return {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    osRelease: release(),
    cpu: cpus()[0]?.model ?? null,
    logicalCpus: cpus().length,
    physicalMemoryBytes: totalmem(),
  };
}

export function percentile(values, fraction) {
  if (!values.length) return null;
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[Math.min(ordered.length - 1, Math.ceil(ordered.length * fraction) - 1)];
}

export function parseOptions(argv) {
  const options = {
    sourceRoot: repositoryRoot,
    tabs: argv.includes('--stress') ? 60000 : 1000,
    windows: argv.includes('--stress') ? 28 : 2,
    readers: 2,
    pairs: 5,
    native: false,
  };
  const strings = new Map([
    ['--source-root', 'sourceRoot'],
    ['--baseline-root', 'baselineRoot'],
    ['--output', 'output'],
    ['--variation-baseline', 'variationBaseline'],
  ]);
  const numbers = new Map([
    ['--tabs', 'tabs'],
    ['--windows', 'windows'],
    ['--readers', 'readers'],
    ['--pairs', 'pairs'],
  ]);
  for (let i = 0; i < argv.length; i++) {
    const argument = argv[i];
    if (argument === '--stress') options.stress = true;
    else if (argument === '--native') options.native = true;
    else if (argument === '--help') options.help = true;
    else if (strings.has(argument) || numbers.has(argument)) {
      const value = argv[++i];
      if (!value || value.startsWith('--')) throw new Error(`Missing value for ${argument}`);
      if (strings.has(argument)) options[strings.get(argument)] = resolve(value);
      else {
        const number = Number(value);
        if (!Number.isSafeInteger(number) || number < 1)
          throw new Error(`Invalid value for ${argument}`);
        options[numbers.get(argument)] = number;
      }
    } else throw new Error(`Unknown argument: ${argument}`);
  }
  if (options.windows > options.tabs) throw new Error('Window count must not exceed tab count.');
  return options;
}

export function memoryGuard(
  {
    pressurePercent,
    pressureLevel,
    lowPressureSamples = 0,
    rssBytes,
    elapsedMs,
    stageMs = 0,
    idleMs = 0,
  },
  { start = false, maxRssBytes = 4 * 1024 ** 3, maxMs = 30 * 60 * 1000 } = {},
) {
  lowerGuardLimits({ maxRssBytes, maxMs });
  if (!Number.isFinite(pressurePercent)) return 'System memory pressure could not be measured.';
  if (![1, 2, 4].includes(pressureLevel))
    return 'System memory pressure level could not be measured.';
  if (start && pressureLevel > 1)
    return 'macOS memory pressure is not normal for a new native run.';
  if (pressureLevel >= 4) return 'macOS reports critical memory pressure.';
  if (
    (start && pressurePercent < 30) ||
    (!start && pressurePercent < 20 && lowPressureSamples >= 3)
  )
    return `System memory free percentage ${pressurePercent}% is below the ${start ? 30 : 20}% guard.`;
  if (rssBytes >= maxRssBytes)
    return `Owned process RSS reached the ${maxRssBytes / 1024 ** 3} GiB guard.`;
  if (elapsedMs >= maxMs) return `Diagnostic reached its ${maxMs / 60000} minute watchdog limit.`;
  if (stageMs >= 10 * 60 * 1000)
    return 'Native diagnostic stage reached its 10 minute watchdog limit.';
  if (idleMs >= 60000) return 'Native diagnostic made no reported progress for 60 seconds.';
  return null;
}

// Iteration workloads may tighten safety limits, never relax the stress ceiling.
export function lowerGuardLimits(overrides = {}) {
  const ceilings = { maxRssBytes: 4 * 1024 ** 3, maxMs: 30 * 60 * 1000 };
  for (const [key, value] of Object.entries(overrides))
    if (!(key in ceilings) || !Number.isFinite(value) || value <= 0 || value > ceilings[key])
      throw new Error(`Invalid or raised diagnostic guard: ${key}`);
  return { ...ceilings, ...overrides };
}

export async function readPressure() {
  if (process.platform !== 'darwin')
    return {
      percent: null,
      error: 'Native memory diagnostics currently require macOS memory_pressure -Q.',
    };
  try {
    const [{ stdout }, level] = await Promise.all([
      exec('/usr/bin/memory_pressure', ['-Q'], { timeout: 5000 }),
      exec('/usr/sbin/sysctl', ['-n', 'kern.memorystatus_vm_pressure_level'], {
        timeout: 5000,
      }).then(
        ({ stdout }) => Number(stdout.trim()),
        () => null,
      ),
    ]);
    const match = stdout.match(/System-wide memory free percentage:\s*(\d+)%/);
    return {
      percent: match ? Number(match[1]) : null,
      level: Number.isFinite(level) ? level : null,
      error: match ? null : 'Unrecognised memory_pressure output.',
    };
  } catch (error) {
    return { percent: null, error: error.message };
  }
}

export function ownedProcesses(text, rootPid, groupId) {
  const processes = text
    .trim()
    .split('\n')
    .map((line) => {
      const [pid, parentPid, rssKiB, processGroup] = line.trim().split(/\s+/).map(Number);
      return { pid, parentPid, rssBytes: rssKiB * 1024, processGroup };
    })
    .filter((entry) => Number.isSafeInteger(entry.pid) && Number.isFinite(entry.rssBytes));
  const owned = new Set([rootPid]);
  // A detached worker owns its process group even after an intermediate parent
  // exits. PPID-only traversal loses those descendants when they are reparented.
  if (Number.isSafeInteger(groupId) && groupId > 0)
    for (const entry of processes) if (entry.processGroup === groupId) owned.add(entry.pid);
  let changed = true;
  while (changed) {
    changed = false;
    for (const entry of processes)
      if (owned.has(entry.parentPid) && !owned.has(entry.pid)) {
        owned.add(entry.pid);
        changed = true;
      }
  }
  return processes.filter((entry) => owned.has(entry.pid));
}
