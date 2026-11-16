// Tassello's server: a ROS node serving the dashboard's page, the REST API
// (/api, see http.ts), the plugins' client files (/plugins/<name>/) and the
// WebSocket (/ws, see ../shared/protocol.ts) through which the widgets reach
// ROS and the shell. Started by the command line (cli.ts).
//
// The port and the panels directory are also ROS parameters, whose defaults
// are the options given: --ros-args -p port:=8000 -p panels_dir:=<dir>
//
// Who may do what is auth.ts's: a page's WebSocket opens only for a signed-in
// user, from the dashboard's own pages, and each of its messages needs a role
// (src/shared/auth.ts).
//
// A page connects on its panel's ROS domain (/ws?domain=<id>, the server's own
// without one): its widgets reach the ROS node the server keeps on that domain
// (domains.ts), the rest (terminals, services, files) being shared.

import { existsSync, readFileSync } from 'node:fs';
import { createServer, type IncomingMessage } from 'node:http';
import { createServer as createTlsServer } from 'node:https';
import os from 'node:os';
import path from 'node:path';

import rclnodejs from 'rclnodejs';
import { WebSocketServer } from 'ws';

import type { AuthUser, Role } from '../shared/auth.ts';
import { isDomainId, MAX_DOMAIN_ID } from '../shared/panel.ts';
import { Auth, type Identity } from './auth.ts';
import { BehaviorTreeFiles } from './behavior_tree_files.ts';
import { CommandRunner } from './commands.ts';
import { RosDomains, type RosDomain } from './domains.ts';
import { createRequestHandler } from './http.ts';
import { makeMessageCode } from './message_code.ts';
import { Networking } from './networking.ts';
import { HttpError, mayUseDomain, PanelRoles, PanelStore, seesPanel } from './panels.ts';
import { findPlugins, PluginHost, readPlugin, type Plugin } from './plugins.ts';
import { Session } from './session.ts';
import { SystemMonitor } from './system.ts';
import { SystemdServices } from './systemd.ts';
import { Terminals } from './terminals.ts';
import { UserStore } from './users.ts';
import { defaultAuthDirectory, defaultPanelsDirectory, errorMessage, keepSecret, tasselloRoot } from './util.ts';

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
  // Sign-in, on unless false
  auth: boolean;
  // The users and the sessions, ~/.local/share/tassello/auth if not given
  authDir?: string;
  // Hours without a request or a message after which a session ends
  sessionIdleHours: number;
  // HTTPS with this certificate and its key (PEM files), else HTTP
  tls?: { cert: string; key: string };
  // Who has not signed in: a viewer, or nobody (null, the default)
  anonymousRole?: 'viewer' | null;
  // The sites that may frame the page (util.ts checkFrameAncestors)
  frameAncestors?: string;
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

  // Next to the panels
  const uploadsDir = path.join(path.dirname(panelsDir), 'images');
  // The ROS side of the widgets, on the server's domain and on those of the
  // panels
  const domains = new RosDomains(node, logger, uploadsDir);
  logger.info(`ROS domain ${domains.serverDomainId}`);
  const commands = new CommandRunner(store, logger);
  const systemd = new SystemdServices(logger);
  const terminals = new Terminals(logger);
  const networking = new Networking(logger);
  const system = new SystemMonitor(logger);
  const behaviorTreeFiles = new BehaviorTreeFiles(uploadsDir, logger);
  const authDir = options.authDir ?? defaultAuthDirectory();
  const auth = new Auth({
    enabled: options.auth,
    users: new UserStore(path.join(authDir, 'users.json')),
    dir: authDir,
    port,
    tls: options.tls !== undefined,
    idleHours: options.sessionIdleHours,
    anonymousRole: options.anonymousRole ?? null,
    hostname: os.hostname(),
    logger,
  });
  await auth.init();
  // The password hashes: never in a page, whatever reads files for one
  keepSecret(authDir);
  if (auth.enabled) {
    logger.info(`Users in ${authDir}`);
    if (options.anonymousRole === 'viewer') {
      logger.warn('--anonymous-role viewer: anyone who opens the page watches the robot without signing in');
    }
  } else {
    logger.warn('Sign-in is turned off (--no-auth): anyone who opens the page can do anything');
  }
  if (!options.tls && auth.enabled) {
    logger.warn('Served over HTTP: passwords and sessions cross the network readable, use HTTPS (--tls-cert, --tls-key) or a proxy');
  }
  const host = new PluginHost(plugins);
  await host.activate({
    node,
    nodeOf: (domainId) => domains.madeDomain(domainId).node,
    rclnodejs,
    logger,
    commandWidget: (type, command) => commands.registerWidget(type, command),
  });
  const sessions = new Set<Session>();

  // Who sees each panel: a panel's changes and its commands' states reach
  // only the pages of those
  const panelRoles = new PanelRoles(store);
  await panelRoles.load();
  store.on('changed', (id, deleted, origin, { before, after }) => {
    for (const session of sessions) {
      const role = session.user.role;
      if (seesPanel(role, after)) {
        session.send({ type: 'panels.changed', id, deleted, origin });
      } else if (before !== null && seesPanel(role, before)) {
        // Hidden from them now: gone, as far as they know
        session.send({ type: 'panels.changed', id, deleted: true, origin });
      }
    }
  });
  commands.on('state', (state) => {
    const send = (minRole: Role | null) => {
      for (const session of sessions) {
        if (seesPanel(session.user.role, minRole)) {
          session.send({ type: 'command', state });
        }
      }
    };
    const known = panelRoles.known(state.panelId);
    if (known === undefined) {
      void panelRoles.of(state.panelId).then(send);
    } else {
      send(known);
    }
  });

  // The domain a page asks for (/ws?domain=<id>, /api/topics?domain=<id>),
  // made the first time: the server's own if none
  async function domainFor(user: AuthUser, value: string | null): Promise<RosDomain> {
    if (value === null || value.trim() === '') {
      return domains.serverDomain;
    }
    const id = Number(value);
    if (!isDomainId(id)) {
      throw new HttpError(400, `The ROS domain must be an integer between 0 and ${MAX_DOMAIN_ID}`);
    }
    const reachable =
      id === domains.serverDomainId ||
      user.role === 'admin' ||
      mayUseDomain(user.role, id, domains.serverDomainId, await store.list());
    if (!reachable) {
      throw new HttpError(403, `None of your panels is on ROS domain ${id}`);
    }
    try {
      return await domains.get(id);
    } catch (e) {
      logger.error(`ROS domain ${id}: ${errorMessage(e)}`);
      throw new HttpError(500, `Could not reach ROS domain ${id}: ${errorMessage(e)}`);
    }
  }

  const handler = createRequestHandler({
    store,
    wwwDir,
    logger,
    plugins: host,
    auth,
    tls: options.tls !== undefined,
    frameAncestors: options.frameAncestors,
    uploadsDir,
    topics: async (user, domain) =>
      (await domainFor(user, domain)).node
        .getTopicNamesAndTypes()
        .map(({ name, types }) => ({ name, types }))
        .sort((a, b) => a.name.localeCompare(b.name)),
  });
  const server = options.tls
    ? createTlsServer({ cert: readFileSync(options.tls.cert), key: readFileSync(options.tls.key) }, handler)
    : createServer(handler);

  // Who each connection is, and on which ROS domain, from its upgrade request
  const identities = new WeakMap<IncomingMessage, { identity: Identity; domain: RosDomain }>();
  // The pages' messages are small: velocities, subscriptions
  const wss = new WebSocketServer({
    server,
    path: '/ws',
    maxPayload: 1024 * 1024,
    verifyClient: ({ req }, done) => {
      auth.verifyUpgrade(req).then(
        async (result) => {
          if (!('user' in result)) {
            done(false, result.status, result.reason);
            return;
          }
          // Before the connection opens: its first messages need the domain
          try {
            const query = new URL(req.url ?? '/', 'http://localhost').searchParams;
            identities.set(req, { identity: result, domain: await domainFor(result.user, query.get('domain')) });
            done(true);
          } catch (e) {
            done(false, e instanceof HttpError ? e.status : 500, errorMessage(e));
          }
        },
        () => done(false, 500),
      );
    },
  });
  // Pages connected, with who they are
  const signedIn = new Map<Session, Identity>();
  wss.on('connection', (ws, req) => {
    const upgrade = identities.get(req);
    if (!upgrade) {
      ws.close(4401, 'Sign in first');
      return;
    }
    const { identity, domain } = upgrade;
    const session = new Session(
      ws,
      {
        ...domain.services,
        domainId: domain.id,
        domainEnv: domain.env,
        serverDomainId: domains.serverDomainId,
        commands,
        systemd,
        terminals,
        networking,
        behaviorTreeFiles,
        system,
        plugins: host,
        panelRoles,
        hostname: os.hostname(),
      },
      identity.user,
      () => identity.session && auth.touch(identity.session),
      req.socket.localAddress ?? null,
    );
    sessions.add(session);
    signedIn.set(session, identity);
    logger.debug(`Page connected from ${req.socket.remoteAddress}, on ROS domain ${domain.id}`);
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
      signedIn.delete(session);
      if (sessions.delete(session)) {
        session.close();
      }
    });
    ws.on('error', (e) => logger.warn(`WebSocket error: ${errorMessage(e)}`));
  });

  // Signed out, or no longer allowed what they were: their pages connect again
  // (or go back to the sign-in), as who they are now
  async function recheck(only: string | null): Promise<void> {
    for (const [session, identity] of signedIn) {
      if (!identity.session || (only !== null && identity.user.username !== only)) {
        continue;
      }
      const user = await auth.lookup(identity.session);
      if (!user) {
        session.end(4401, 'Signed out');
      } else if (user.role !== identity.user.role) {
        session.end(4403, 'Role changed');
      }
    }
  }
  auth.on('changed', (username) => void recheck(username));
  // Sessions that expired meanwhile
  const sweep = setInterval(() => void recheck(null), 60_000);
  sweep.unref();

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
    system.stop();
    clearInterval(sweep);
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
    for (const domain of domains.all()) {
      domain.services.actions.stopAll();
    }
    // Time for those last zero velocities to leave, and for the bags being
    // recorded to be completed
    void Promise.all([
      host.shutdown(logger),
      ...domains.all().map((domain) => domain.services.rosbags.stopAll()),
      auth.stop(),
      new Promise((resolve) => setTimeout(resolve, 200)),
    ]).finally(() => {
      domains.destroyOthers();
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
  logger.info(`Dashboard at ${options.tls ? 'https' : 'http'}://${os.hostname()}:${port}`);
}
