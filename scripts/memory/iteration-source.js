import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, readdir, lstat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { exec, fingerprintSource, repositoryRoot } from './common.js';

export const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export async function resolveBenchmarkRef(ref, root = repositoryRoot) {
  const git = (...args) => exec('git', ['-C', root, ...args], { maxBuffer: 10 * 1024 ** 2 });
  const requestedRef = ref;
  if (ref === 'latest-release') {
    const tags = (await git('tag', '--list')).stdout
      .split('\n')
      .filter((tag) => /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(tag));
    tags.sort((a, b) => {
      const left = a.replace(/^v/, '').split('.').map(BigInt);
      const right = b.replace(/^v/, '').split('.').map(BigInt);
      for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i] > right[i] ? -1 : 1;
      return a.localeCompare(b);
    });
    if (!tags.length)
      throw new Error(
        'No local stable release tag (vMAJOR.MINOR.PATCH). Fetch release tags or specify --baseline REF.',
      );
    ref = `refs/tags/${tags[0]}`;
  }
  const commit = (
    await git('rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`)
  ).stdout.trim();
  return { commit, ref, requestedRef };
}

export async function freezeSource(destination, ref, root = repositoryRoot) {
  const revision = await resolveBenchmarkRef(ref || 'HEAD', root);
  await mkdir(destination, { recursive: true });
  const git = (...args) => exec('git', ['-C', root, ...args], { maxBuffer: 10 * 1024 ** 2 });
  let changes = '';
  if (ref) {
    const archive = resolve(destination, 'source.tar');
    await git(
      'archive',
      '--format=tar',
      '--output',
      archive,
      revision.commit,
      '--',
      'extension',
      'package.json',
    );
    await exec('/usr/bin/tar', ['-xf', archive, '-C', destination]);
  } else {
    changes = (await git('status', '--short', '--', 'extension', 'package.json')).stdout;
    const files = (
      await git(
        'ls-files',
        '-z',
        '--cached',
        '--others',
        '--exclude-standard',
        '--',
        'extension',
        'package.json',
      )
    ).stdout
      .split('\0')
      .filter(Boolean);
    for (const file of new Set(files)) {
      const path = resolve(root, file);
      let info;
      try {
        info = await lstat(path);
      } catch (error) {
        if (error.code === 'ENOENT') continue;
        throw error;
      }
      if (!info.isFile()) throw new Error(`Benchmark source must be a regular file: ${file}`);
      const target = resolve(destination, file);
      await mkdir(dirname(target), { recursive: true });
      await copyFile(path, target);
    }
  }
  return {
    ...(await fingerprintSource(destination)),
    ...revision,
    ref: ref ? revision.ref : 'working tree',
    requestedRef: ref || 'working tree',
    changes,
  };
}

export async function iterationHarness() {
  const files = [
    'scripts/benchmark-optimisation.js',
    'scripts/firefox-session.js',
    'preview/performance-fixture.js',
    'package-lock.json',
  ];

  async function walk(path) {
    for (const entry of await readdir(resolve(repositoryRoot, path), { withFileTypes: true })) {
      const name = `${path}/${entry.name}`;
      if (entry.isDirectory()) await walk(name);
      else files.push(name);
    }
  }

  await walk('scripts/memory');
  files.sort();
  const hash = createHash('sha256');
  for (const path of files) {
    const bytes = await readFile(resolve(repositoryRoot, path));
    hash.update(`${path}\0${bytes.length}\0`).update(bytes);
  }
  return { sha256: hash.digest('hex'), files };
}
