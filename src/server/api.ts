// The server side of a Tassello plugin, published as `tassello/server`: what a
// plugin's server module exports, and what it is given. A plugin extends the
// server with requests and streams its widgets reach through the page's
// connection (connection.request and connection.subscribePlugin of
// `tassello/sdk`), and with widgets that run commands.
//
//   import type { TasselloPlugin } from 'tassello/server';
//
//   export default {
//     activate(ctx) {
//       ctx.handle('greet', (params) => `Hello ${String(params)} from ${ctx.node.name()}`);
//     },
//   } satisfies TasselloPlugin;
//
// Importing only types keeps the module free of `tassello` at run time: the
// server gives the plugin everything it needs, the ROS node included.

import type rclnodejs from 'rclnodejs';

import type { Logger } from './util.ts';

export type { Logger };

// The page a request or stream comes from: one per open page, until it closes
export interface PluginSession {
  readonly id: string;
}

// Answers a request: its result (or a promise of it), sent to the page as
// JSON. What it throws is the page's error.
export type RequestHandler = (params: unknown, session: PluginSession) => unknown;

// Opens a stream for a page: emit sends it data, as often as needed. Returns
// what closes it, called when the page unsubscribes or goes away.
export type StreamHandler = (
  params: unknown,
  emit: (data: unknown) => void,
  session: PluginSession,
) => (() => void) | void;

// A widget type that runs a bash command of its config on the robot, like the
// button: the page asks to run it by panel and widget, the server reads the
// command from the saved panel (never from the page) and broadcasts its state
// and output (useCommandState of `tassello/sdk`).
export interface CommandWidget {
  // The config property holding the command
  property: string;
  // The command when the property is not set, as the widget's default
  fallback?: string;
}

export interface PluginContext {
  // The plugin's package name: what its widgets address it by
  readonly name: string;
  // The plugin's directory, where its package.json is
  readonly dir: string;
  // The server's ROS node, shared by every plugin: create publishers,
  // subscriptions and clients on it
  readonly node: rclnodejs.Node;
  readonly rclnodejs: typeof rclnodejs;
  readonly logger: Logger;
  handle(method: string, handler: RequestHandler): void;
  stream(name: string, handler: StreamHandler): void;
  commandWidget(type: string, command: CommandWidget): void;
  // Called when the server stops, before the node is destroyed
  onShutdown(callback: () => void | Promise<void>): void;
}

export interface TasselloPlugin {
  activate(context: PluginContext): void | Promise<void>;
}

// For plugins that prefer a function to `satisfies TasselloPlugin`
export function definePlugin(plugin: TasselloPlugin): TasselloPlugin {
  return plugin;
}
