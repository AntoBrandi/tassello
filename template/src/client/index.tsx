// The page's side of the plugin: its widgets, and its status widgets (of the
// panels' status bars, above their boards). A widget is a React component and
// its definition: name, icon, size, and the properties edited in the side
// panel, whose values it gets as its config.

import { useEffect, useState } from 'react';
import {
  connection,
  definePlugin,
  defineStatusWidget,
  defineWidget,
  notify,
  StatusReadout,
  TerminalIcon,
  useTopic,
  type PropertySchema,
  type StatusWidgetProps,
  type WidgetProps,
} from 'tassello/sdk';

import './style.css';

// The package's name: what the page addresses the server's side by
const PLUGIN = '__PLUGIN_NAME__';

interface HelloConfig {
  topic: string;
}

function HelloWidget({ config, editing }: WidgetProps<HelloConfig>) {
  // The latest message of the topic, as JSON
  const { message, status, error } = useTopic<{ data: string }>(config.topic);

  // A stream of the server's side (ctx.stream in src/server/index.ts)
  const [serverTime, setServerTime] = useState<number | null>(null);
  useEffect(
    () => connection.subscribePlugin(PLUGIN, 'clock', null, { data: (time) => setServerTime(time as number) }),
    [],
  );

  const publish = () =>
    connection.publish(config.topic, 'std_msgs/msg/String', { data: `Hello at ${new Date().toLocaleTimeString()}` });

  // A request to the server's side (ctx.handle)
  const greet = async () => {
    try {
      notify(await connection.request<string>(PLUGIN, 'greet', { name: 'Tassello' }));
    } catch (e) {
      notify(`No greeting: ${(e as Error).message}`, 'error');
    }
  };

  return (
    <div className="hello">
      <p className="hello-message">
        {message ? message.data : status === 'error' ? error : `Waiting for ${config.topic}…`}
      </p>
      <p className="hello-time">
        {serverTime === null ? '' : `The robot's clock: ${new Date(serverTime).toLocaleTimeString()}`}
      </p>
      <div className="hello-actions">
        <button type="button" className="button" disabled={editing} onClick={publish}>
          Publish
        </button>
        <button type="button" className="button primary" disabled={editing} onClick={greet}>
          Ask the robot
        </button>
      </div>
    </div>
  );
}

// Edited in the side panel; the config has their values
const HELLO_PROPERTIES: PropertySchema<HelloConfig>[] = [
  {
    key: 'topic',
    label: 'Topic',
    kind: 'topic',
    default: '/chatter',
    topicTypes: ['std_msgs/msg/String'],
  },
];

const helloWidget = defineWidget<HelloConfig>({
  // Stored in the panels: prefixed with the plugin's name, never changed
  type: `${PLUGIN}.hello`,
  name: 'Hello',
  description: 'Shows and publishes the messages of a String topic, and greets the robot.',
  icon: TerminalIcon,
  // In grid cells
  defaultSize: { w: 4, h: 3 },
  minSize: { w: 3, h: 2 },
  component: HelloWidget,
  properties: HELLO_PROPERTIES,
});

// A status widget: the latest message of the topic, at a glance.
// StatusReadout shows what fits its width: the icon, the value, the label.
function HelloStatus({ config }: StatusWidgetProps<HelloConfig>) {
  const { message } = useTopic<{ data: string }>(config.topic);
  return (
    <StatusReadout
      icon={<TerminalIcon />}
      value={message ? message.data : '…'}
      tone={message ? 'ok' : 'off'}
      title={message ? `${config.topic}: ${message.data}` : `Waiting for ${config.topic}…`}
    />
  );
}

const helloStatusWidget = defineStatusWidget<HelloConfig>({
  // Stored in the panels' status bars: prefixed with the plugin's name, never
  // changed, and not a widget's type
  type: `${PLUGIN}.hello-status`,
  name: 'Hello',
  description: 'The latest message of a String topic.',
  icon: TerminalIcon,
  // In the status bar's columns (24 across it)
  defaultWidth: 3,
  minWidth: 2,
  component: HelloStatus,
  properties: HELLO_PROPERTIES,
});

export default definePlugin({
  widgets: [helloWidget],
  statusWidgets: [helloStatusWidget],
  // New defaults for any widget's properties, e.g. this robot's velocity topic:
  // defaults: { teleop: { topic: '/my_robot/cmd_vel', maxLinear: 0.3 } },
});
