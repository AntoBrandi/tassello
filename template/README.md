# __PLUGIN_NAME__

A [Tassello](https://www.npmjs.com/package/tassello) plugin: widgets for the robot's web dashboard.

```bash
npm install
npm run build       # dist/client: the widgets; dist/server: the server's side
tassello --plugin . # with ROS sourced: http://localhost:8080
```

Then edit a panel, **Add widget**: the plugin's widgets have a section of their own, as its
status widgets have in the status bar's **＋ Status**. After a change, `npm run build` and reload
the page; restart Tassello for a change of the server's side.

- `src/client/index.tsx`: the widgets and status widgets, exported by
  `definePlugin({ widgets, statusWidgets })`.
- `src/client/style.css`: their styles.
- `src/server/index.ts`: the server's side, `activate(ctx)`: requests (`ctx.handle`) and streams
  (`ctx.stream`) for the widgets, with the server's ROS node. Delete it, and `"server"` in
  `package.json`, if the widgets need none: from the page they can already publish, subscribe and
  call services (`connection` of `tassello/sdk`).
- `package.json`'s `"tassello"` field tells Tassello where they are.

Publish it to npm as `tassello-plugin-<name>`: installed next to Tassello, it loads by itself.
See [Writing a Tassello plugin](https://github.com/AntoBrandi/tassello/blob/main/docs/plugins.md).
