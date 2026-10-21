// rclnodejs's JavaScript code of the ROS interfaces, without which it cannot
// use them: rclnodejs makes it when installed, for the packages sourced then.
// Those sourced since (a robot's own installation, a workspace), or rebuilt
// with new interfaces, are made here at start, before anything uses them: by
// rclnodejs's own generator, as it makes them when installed, run on a prefix
// of their own (their ament index entries, their share folders linked). Its
// own fallback misses the interfaces of services and actions, and makes a
// whole prefix's while the server waits.

import { spawn } from 'node:child_process';
import { existsSync, promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

import { errorMessage, tasselloRoot, type Logger } from './util.ts';

// Where the ament index lists each package's interfaces
const INDEX = path.join('share', 'ament_index', 'resource_index', 'rosidl_interfaces');
const GENERATION_TIMEOUT_MS = 5 * 60_000;

export interface MissingPackage {
  name: string;
  // The prefix (of AMENT_PREFIX_PATH) it is installed in
  prefix: string;
}

// The files rclnodejs makes of a package's interfaces, from its entry in the
// ament index: msg/Pose.msg, msg/Pose.idl give <pkg>__msg__Pose.js. The
// services' and actions' parts are made with them.
export function expectedFiles(pkg: string, index: string, blocked: (name: string) => boolean = () => false): string[] {
  const files = new Set<string>();
  for (const line of index.split('\n')) {
    const match = /^([\w-]+)\/(\w+)\.(msg|srv|action|idl)$/.exec(line.trim());
    if (match && !blocked(match[2])) {
      // msg-common: msg, as rclnodejs names them
      files.add(`${pkg}__${match[1].split('-')[0]}__${match[2]}.js`);
    }
  }
  return [...files];
}

// The packages of the prefixes whose code is not all made: the first of each
// name, as the prefixes overlay those after them
export async function missingPackages(
  prefixes: string[],
  generatedRoot: string,
  blocklist: { pkgName?: string; interfaceName?: string }[] = [],
): Promise<MissingPackage[]> {
  const seen = new Set<string>();
  const missing: MissingPackage[] = [];
  const filters = blocklist.map((f) => ({
    pkg: f.pkgName ? new RegExp(f.pkgName) : null,
    name: f.interfaceName ? new RegExp(f.interfaceName) : null,
  }));
  for (const prefix of prefixes) {
    let packages: string[];
    try {
      packages = await fs.readdir(path.join(prefix, INDEX));
    } catch {
      continue;
    }
    for (const name of packages.sort()) {
      if (seen.has(name)) {
        continue;
      }
      seen.add(name);
      const applying = filters.filter((f) => !f.pkg || f.pkg.test(name));
      if (applying.some((f) => !f.name)) {
        continue;
      }
      let index: string;
      try {
        index = await fs.readFile(path.join(prefix, INDEX, name), 'utf8');
      } catch {
        continue;
      }
      const expected = expectedFiles(name, index, (interfaceName) => applying.some((f) => f.name?.test(interfaceName)));
      const made = new Set(await fs.readdir(path.join(generatedRoot, name)).catch(() => [] as string[]));
      if (expected.some((file) => !made.has(file))) {
        missing.push({ name, prefix });
      }
    }
  }
  return missing;
}

// What to do when rclnodejs has no code of an interface, after its error
export function missingCodeHint(message: string): string {
  return /message required does not exist/i.test(message)
    ? `${message}. Tassello makes the code of the interfaces sourced when it starts: restart it with their workspace sourced, or run npx generate-ros-messages in ${tasselloRoot()}`
    : message;
}

function rclnodejsRoot(): string {
  return path.dirname(createRequire(import.meta.url).resolve('rclnodejs/package.json'));
}

// Runs rclnodejs's generator on the prefix: rejects with its error output if
// it fails
function generate(worker: string, prefix: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [worker], {
      env: { ...process.env, WORKER_TARGET_PATH: prefix },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (data: Buffer) => {
      stderr = (stderr + data.toString()).slice(-2000);
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), GENERATION_TIMEOUT_MS);
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(stderr.trim() || (signal ? `killed by ${signal}` : `exit code ${code}`)));
      }
    });
  });
}

// Makes the code of the packages sourced whose code is missing; says what it
// did, or why it could not, and goes on: those packages stay unusable then
export async function makeMessageCode(logger: Logger): Promise<void> {
  const prefixes = (process.env.AMENT_PREFIX_PATH ?? '').split(path.delimiter).filter(Boolean);
  let root: string;
  try {
    root = rclnodejsRoot();
  } catch (e) {
    logger.warn(`Cannot find rclnodejs to check its code of the ROS interfaces: ${errorMessage(e)}`);
    return;
  }
  const generatedRoot = path.join(root, 'generated');
  let blocklist: { pkgName?: string; interfaceName?: string }[] = [];
  try {
    blocklist = JSON.parse(await fs.readFile(path.join(root, 'rosidl_gen', 'blocklist.json'), 'utf8'));
  } catch {
    // None
  }
  const missing = await missingPackages(prefixes, generatedRoot, blocklist);
  if (missing.length === 0) {
    return;
  }
  const names = missing.map((p) => p.name).join(', ');
  const worker = path.join(root, 'rosidl_gen', 'generate_worker.cjs');
  if (!existsSync(worker)) {
    logger.warn(
      `rclnodejs has no code of the interfaces of ${names}: run npx generate-ros-messages in ${tasselloRoot()} with them sourced`,
    );
    return;
  }
  logger.info(`Making rclnodejs's code of the ROS interfaces it has not, of ${missing.length} package(s): ${names}`);
  const started = Date.now();
  const prefix = await fs.mkdtemp(path.join(os.tmpdir(), 'tassello-interfaces-'));
  try {
    await fs.mkdir(path.join(prefix, INDEX), { recursive: true });
    for (const pkg of missing) {
      await fs.copyFile(path.join(pkg.prefix, INDEX, pkg.name), path.join(prefix, INDEX, pkg.name));
      await fs.symlink(path.join(pkg.prefix, 'share', pkg.name), path.join(prefix, 'share', pkg.name));
    }
    await generate(worker, prefix);
  } catch (e) {
    logger.warn(
      `Could not make rclnodejs's code of the interfaces of ${names} (${errorMessage(e)}): run npx generate-ros-messages in ${tasselloRoot()} with them sourced, as a user who may write in ${generatedRoot}`,
    );
    return;
  } finally {
    await fs.rm(prefix, { recursive: true, force: true });
  }
  const left = await missingPackages(
    missing.map((p) => p.prefix).filter((p, i, all) => all.indexOf(p) === i),
    generatedRoot,
    blocklist,
  );
  const still = left.filter((p) => missing.some((m) => m.name === p.name));
  if (still.length > 0) {
    logger.warn(`rclnodejs's code of some interfaces of ${still.map((p) => p.name).join(', ')} could not be made`);
  }
  logger.info(`Made in ${((Date.now() - started) / 1000).toFixed(1)} s`);
}
