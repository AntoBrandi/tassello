// The server's side of the plugin, running in Tassello's server on the robot:
// requests and streams for its widgets, with the server's ROS node at hand
// (ctx.node: create publishers, subscriptions, service clients on it).
//
// Type imports only: the server gives the plugin all it needs at run time.

import type { TasselloPlugin } from 'tassello/server';

export default {
  activate(ctx) {
    // connection.request(PLUGIN, 'greet', params) on the page
    ctx.handle('greet', (params) => {
      const { name } = (params ?? {}) as { name?: string };
      return `Hello ${name ?? 'there'}, from the node ${ctx.node.name()}`;
    });

    // connection.subscribePlugin(PLUGIN, 'clock', params, handlers): until
    // the page unsubscribes or goes away, when the function returned is called
    ctx.stream('clock', (_params, emit) => {
      const timer = setInterval(() => emit(Date.now()), 1000);
      return () => clearInterval(timer);
    });

    ctx.logger.info('Ready');
  },
} satisfies TasselloPlugin;
