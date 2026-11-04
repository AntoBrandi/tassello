#!/usr/bin/env node
// The tassello command: starts the server, creates a plugin, or manages the
// users who sign in.
//
//   tassello [options] [--ros-args ...]
//   tassello create-plugin <folder> [--name <package name>]
//   tassello users <list|add|passwd|role|disable|enable|remove> ...

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { DEFAULT_IDLE_HOURS } from './auth.ts';
import { createPlugin } from './create_plugin.ts';
import { usersCommand, USERS_USAGE } from './users_cli.ts';
import { checkFrameAncestors, DEFAULT_FRAME_ANCESTORS, errorMessage, tasselloRoot } from './util.ts';

const USAGE = `Usage: tassello [options] [--ros-args ...]
       tassello create-plugin <folder> [--name <package name>]
       tassello users <command> ...   (tassello users --help)

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
      --no-auth             no sign-in: anyone who opens the page can do
                            anything. Only on a network you trust
      --auth-dir <dir>      where the users and their sessions are kept
                            (~/.local/share/tassello/auth)
      --session-idle <h>    hours without use after which one signs in again
                            (${DEFAULT_IDLE_HOURS})
      --tls-cert <file>     serves HTTPS with this certificate (PEM)...
      --tls-key <file>      ...and its private key (PEM)
      --anonymous-role <role>
                            viewer: anyone who has not signed in watches, as a
                            viewer (kiosk screens); signing in operates. none:
                            everyone signs in (none)
      --frame-ancestors <list>
                            the sites whose pages may show the dashboard in a
                            frame, e.g. 'self' https://ops.example.com (a Web
                            Page widget of another Tassello). ('none')
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

  if (args[0] === 'users') {
    if (args.includes('--help') || args.includes('-h') || args.length === 1) {
      console.log(USERS_USAGE);
      process.exitCode = args.length === 1 ? 2 : 0;
      return;
    }
    process.exitCode = await usersCommand(args.slice(1));
    return;
  }

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
      'no-auth': { type: 'boolean', default: false },
      'auth-dir': { type: 'string' },
      'session-idle': { type: 'string', default: String(DEFAULT_IDLE_HOURS) },
      'tls-cert': { type: 'string' },
      'tls-key': { type: 'string' },
      'anonymous-role': { type: 'string', default: 'none' },
      'frame-ancestors': { type: 'string', default: DEFAULT_FRAME_ANCESTORS },
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
  const idle = Number(values['session-idle']);
  const anonymous = values['anonymous-role'];
  let frameAncestors = DEFAULT_FRAME_ANCESTORS;
  try {
    frameAncestors = checkFrameAncestors(values['frame-ancestors']);
  } catch (e) {
    console.error(errorMessage(e));
    process.exitCode = 2;
    return;
  }
  const problem =
    positionals.length > 0
      ? `Unexpected argument "${positionals[0]}"`
      : !Number.isInteger(port) || port < 0 || port > 65535
        ? `Invalid port "${values.port}"`
        : !(idle > 0 && idle <= 24 * 365)
          ? `Invalid --session-idle "${values['session-idle']}": hours, more than 0`
          : (values['tls-cert'] === undefined) !== (values['tls-key'] === undefined)
            ? '--tls-cert and --tls-key go together'
            : anonymous !== 'viewer' && anonymous !== 'none'
              ? `Invalid --anonymous-role "${anonymous}": viewer or none`
              : null;
  if (problem) {
    console.error(problem);
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
    auth: !values['no-auth'],
    authDir: values['auth-dir'] && path.resolve(values['auth-dir']),
    sessionIdleHours: idle,
    anonymousRole: anonymous === 'viewer' ? 'viewer' : null,
    frameAncestors,
    tls:
      values['tls-cert'] && values['tls-key']
        ? { cert: path.resolve(values['tls-cert']), key: path.resolve(values['tls-key']) }
        : undefined,
  });
}

main(process.argv.slice(2)).catch((e: unknown) => {
  console.error(`tassello: ${errorMessage(e)}`);
  process.exit(1);
});
