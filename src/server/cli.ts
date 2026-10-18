#!/usr/bin/env node
// The tassello command: starts the server, or creates a plugin.
//
//   tassello [options] [--ros-args ...]
//   tassello create-plugin <folder> [--name <package name>]

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { createPlugin } from './create_plugin.ts';
import { errorMessage, tasselloRoot } from './util.ts';

const USAGE = `Usage: tassello [options] [--ros-args ...]
       tassello create-plugin <folder> [--name <package name>]

Serves the dashboard at http://<host>:<port>, as a ROS 2 node: source your
ROS 2 setup (e.g. /opt/ros/jazzy/setup.bash) first.

Options:
  -p, --port <port>         HTTP port (8080)
      --host <address>      the address to listen on (all of them)
      --panels-dir <dir>    where the panels are kept, created with the example
                            panels on first start (~/.local/share/tassello/panels)
      --plugin <plugin>     loads the plugin: a folder, or an installed package's
                            name. Repeatable
      --no-discover         loads only those plugins, not the ones installed
                            (ROS packages of the sourced workspaces, npm packages
                            named tassello-plugin-*)
      --node-name <name>    the ROS node's name (tassello)
  -v, --version
  -h, --help

After --ros-args, ROS arguments, e.g. -p use_sim_time:=true. The port and
the panels directory are also the node's parameters port and panels_dir.`;

function version(): string {
  const pkg = JSON.parse(readFileSync(path.join(tasselloRoot(), 'package.json'), 'utf8')) as { version: string };
  return pkg.version;
}

async function main(argv: string[]): Promise<void> {
  const rosArgs = argv.indexOf('--ros-args');
  const args = rosArgs < 0 ? argv : argv.slice(0, rosArgs);

  if (args[0] === 'create-plugin') {
    const { values, positionals } = parseArgs({
      args: args.slice(1),
      options: { name: { type: 'string' }, help: { type: 'boolean', short: 'h' } },
      allowPositionals: true,
    });
    if (values.help || positionals.length !== 1) {
      console.log(USAGE);
      process.exitCode = values.help ? 0 : 2;
      return;
    }
    await createPlugin(positionals[0], values.name, version());
    return;
  }

  const { values, positionals } = parseArgs({
    args,
    options: {
      port: { type: 'string', short: 'p', default: '8080' },
      host: { type: 'string' },
      'panels-dir': { type: 'string' },
      plugin: { type: 'string', multiple: true, default: [] },
      'no-discover': { type: 'boolean', default: false },
      'node-name': { type: 'string', default: 'tassello' },
      version: { type: 'boolean', short: 'v' },
      help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: true,
  });
  if (values.help) {
    console.log(USAGE);
    return;
  }
  if (values.version) {
    console.log(version());
    return;
  }
  const port = Number(values.port);
  if (positionals.length > 0 || !Number.isInteger(port) || port < 0 || port > 65535) {
    console.error(positionals.length > 0 ? `Unexpected argument "${positionals[0]}"` : `Invalid port "${values.port}"`);
    console.error(USAGE);
    process.exitCode = 2;
    return;
  }
  // rclnodejs, loaded without a ROS environment, tries to rebuild itself
  if (!process.env.ROS_DISTRO || !process.env.AMENT_PREFIX_PATH) {
    throw new Error('no ROS 2 environment: source its setup first, e.g. source /opt/ros/jazzy/setup.bash');
  }
  const { startServer } = await import('./server.ts');
  await startServer({
    port,
    host: values.host,
    panelsDir: values['panels-dir'] && path.resolve(values['panels-dir']),
    plugins: values.plugin,
    discoverPlugins: !values['no-discover'],
    nodeName: values['node-name'],
  });
}

main(process.argv.slice(2)).catch((e: unknown) => {
  console.error(`tassello: ${errorMessage(e)}`);
  process.exit(1);
});
