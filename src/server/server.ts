// Tassello's server: a ROS node serving the dashboard's page, the REST API
// (/api, see http.ts), the plugins' client files (/plugins/<name>/) and the
// WebSocket (/ws, see ../shared/protocol.ts) through which the widgets reach
// ROS and the shell. Started by the command line (cli.ts).
//
// The port and the panels directory are also ROS parameters, whose defaults
// are the options given: --ros-args -p port:=8000 -p panels_dir:=<dir>

import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';

import rclnodejs from 'rclnodejs';
import { WebSocketServer } from 'ws';

import type { ServerMessage } from '../shared/protocol.ts';
import { Actions } from './actions.ts';
import { Arm } from './arm.ts';
import { BehaviorTreeFiles } from './behavior_tree_files.ts';
import { BehaviorTrees } from './behavior_trees.ts';
import { CommandRunner } from './commands.ts';
import { Diagnostics } from './diagnostics.ts';
import { createRequestHandler } from './http.ts';
import { Interfaces } from './interfaces.ts';
import { makeMessageCode } from './message_code.ts';
import { Networking } from './networking.ts';
import { PanelStore } from './panels.ts';
import { Paths } from './paths.ts';
import { findPlugins, PluginHost, readPlugin, type Plugin } from './plugins.ts';
import { Poses } from './poses.ts';
import { Ros } from './ros.ts';
import { RosGraph } from './ros_graph.ts';
import { Rosout } from './rosout.ts';
import { Session } from './session.ts';
import { FrameStreams } from './streams.ts';
import { SystemdServices } from './systemd.ts';
import { Teleop } from './teleop.ts';
import { Terminals } from './terminals.ts';
import { Tf } from './tf.ts';
import { TopicMonitors } from './topic_monitor.ts';
import { TopicPublishing } from './topic_publishing.ts';
import { Topics } from './topics.ts';
import { defaultPanelsDirectory, errorMessage, ownPage, tasselloRoot } from './util.ts';

export interface ServerOptions {
  port: number;
  // Of the HTTP server, every interface if not given
  host?: string;
  // ~/.local/share/tassello/panels if not given: created on first start, with
  // the example panels of Tassello and of the plugins
  panelsDir?: string;
  // Folders or package names of plugins to load, before those found
  plugins: string[];
  // Also load the plugins found in the ament index and in node_modules
  discoverPlugins: boolean;
  nodeName: string;
}

// Connections that miss a ping for this long are dropped: a page whose
// network vanished never closes its socket by itself
const HEARTBEAT_MS = 10_000;

// Resolves once the server listens; the process exits when it stops
export async function startServer(options: ServerOptions): Promise<void> {
  await rclnodejs.init();
  // Shut down below instead, after closing the connections
  rclnodejs.removeSignalHandlers();
  const node = new rclnodejs.Node(options.nodeName);
  const logger = node.getLogger();
  // Before anything uses them
  await makeMessageCode(logger);

  function parameter(name: string, type: rclnodejs.ParameterType, value: unknown): unknown {
    return node.declareParameter(new rclnodejs.Parameter(name, type, value)).value;
  }
  const port = Number(parameter('port', rclnodejs.ParameterType.PARAMETER_INTEGER, BigInt(options.port)));
  const panelsDir =
    String(parameter('panels_dir', rclnodejs.ParameterType.PARAMETER_STRING, options.panelsDir ?? '')) ||
    defaultPanelsDirectory();

  const root = tasselloRoot();
  const wwwDir = existsSync(path.join(root, 'dist', 'www', 'index.html')) ? path.join(root, 'dist', 'www') : null;
  if (!wwwDir) {
    logger.warn('The dashboard page is not built (npm run build): serving the API only');
  }

  const plugins: Plugin[] = [];
  for (const location of await findPlugins(options.plugins, options.discoverPlugins, root)) {
    try {
      const plugin = await readPlugin(location);
      if (plugins.some((p) => p.name === plugin.name)) {
        logger.warn(`Plugin ${plugin.name} found twice: ignoring the one in ${plugin.dir}`);
        continue;
      }
      plugins.push(plugin);
      logger.info(`Plugin ${plugin.name} ${plugin.version} (${location.source}: ${plugin.dir})`);
    } catch (e) {
      // Named on the command line: not to be missed
      if (location.source === 'command line') {
        throw e;
      }
      logger.warn(`Skipping a plugin: ${errorMessage(e)}`);
    }
  }

  const store = new PanelStore(
    panelsDir,
    // A robot's own examples first
    [...plugins.flatMap((p) => (p.panelsDir ? [p.panelsDir] : [])), path.join(root, 'panels')],
    logger,
  );
  const examples = await store.init();
  if (examples > 0) {
    logger.info(`Created ${panelsDir} with ${examples} example panel(s)`);
  }
  logger.info(`Panels in ${panelsDir}`);

  const teleop = new Teleop(node, logger);
  const streams = new FrameStreams(node, logger);
  const tf = new Tf(node, logger);
  const paths = new Paths(node, logger);
  const topics = new Topics(node, logger);
  const poses = new Poses(node);
  const commands = new CommandRunner(store, logger);
  const systemd = new SystemdServices(logger);
  const arm = new Arm(node, topics, logger);
  const interfaces = new Interfaces(node);
  const ros = new Ros(node, interfaces);
  const graph = new RosGraph(node, logger);
  const topicMonitors = new TopicMonitors(node, logger, interfaces);
  const publishing = new TopicPublishing(node, interfaces);
  const actions = new Actions(node, interfaces, logger);
  const rosout = new Rosout(node, logger);
  const diagnostics = new Diagnostics(node, logger);
  const terminals = new Terminals(logger);
  const networking = new Networking(logger);
  // Next to the panels
  const uploadsDir = path.join(path.dirname(panelsDir), 'images');
  const behaviorTrees = new BehaviorTrees(node, logger, uploadsDir);
  const behaviorTreeFiles = new BehaviorTreeFiles(uploadsDir, logger);
  const host = new PluginHost(plugins);
  await host.activate({
    node,
    rclnodejs,
    logger,
    commandWidget: (type, command) => commands.registerWidget(type, command),
  });
  const sessions = new Set<Session>();

  function broadcast(message: ServerMessage): void {
    for (const session of sessions) {
      session.send(message);
    }
  }
  store.on('changed', (id, deleted, origin) => broadcast({ type: 'panels.changed', id, deleted, origin }));
  commands.on('state', (state) => broadcast({ type: 'command', state }));

  const server = createServer(
    createRequestHandler({
      store,
      wwwDir,
      logger,
      plugins: host,
      uploadsDir,
      topics: () =>
        node
          .getTopicNamesAndTypes()
          .map(({ name, types }) => ({ name, types }))
          .sort((a, b) => a.name.localeCompare(b.name)),
    }),
  );

  // The pages' messages are small: velocities, subscriptions
  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 1024 * 1024 });
  wss.on('connection', (ws, req) => {
    const session = new Session(
      ws,
      {
        teleop,
        streams,
        tf,
        paths,
        topics,
        poses,
        commands,
        systemd,
        arm,
        ros,
        rosout,
        diagnostics,
        terminals,
        networking,
        behaviorTrees,
        behaviorTreeFiles,
        graph,
        topicMonitors,
        publishing,
        interfaces,
        actions,
        plugins: host,
        hostname: os.hostname(),
      },
      ownPage(req.headers),
      req.socket.localAddress ?? null,
    );
    sessions.add(session);
    logger.debug(`Page connected from ${req.socket.remoteAddress}`);
    let alive = true;
    ws.on('pong', () => {
      alive = true;
    });
    const heartbeat = setInterval(() => {
      if (!alive) {
        logger.warn(`Page at ${req.socket.remoteAddress} stopped answering: dropping it`);
        ws.terminate();
        return;
      }
      alive = false;
      ws.ping();
    }, HEARTBEAT_MS);
    ws.on('close', () => {
      clearInterval(heartbeat);
      if (sessions.delete(session)) {
        session.close();
      }
    });
    ws.on('error', (e) => logger.warn(`WebSocket error: ${errorMessage(e)}`));
  });

  let stopping = false;
  function shutdown(code: number): void {
    if (stopping) {
      return;
    }
    stopping = true;
    commands.stopAll();
    systemd.stopAll();
    terminals.stopAll();
    networking.stopAll();
    // Stops the robot if a page was driving it, while the node still runs
    for (const session of sessions) {
      session.close();
    }
    sessions.clear();
    for (const ws of wss.clients) {
      ws.terminate();
    }
    wss.close();
    server.close();
    behaviorTreeFiles.stopAll();
    actions.stopAll();
    // Time for those last zero velocities to leave, and for the bags being
    // recorded to be completed
    void Promise.all([
      host.shutdown(logger),
      behaviorTrees.stopAll(),
      new Promise((resolve) => setTimeout(resolve, 200)),
    ]).finally(() => {
      node.destroy();
      rclnodejs.shutdown();
      process.exit(code);
    });
  }
  process.on('SIGINT', () => shutdown(0));
  process.on('SIGTERM', () => shutdown(0));

  server.on('error', (e) => {
    logger.error(`HTTP server: ${errorMessage(e)}`);
    shutdown(1);
  });
  // The WebSocket server repeats the HTTP server's errors, handled above: the
  // process would die of an unhandled 'error' event first
  wss.on('error', () => {});
  node.spin();
  await new Promise<void>((resolve) => server.listen(port, options.host, resolve));
  logger.info(`Dashboard at http://${os.hostname()}:${port}`);
}
