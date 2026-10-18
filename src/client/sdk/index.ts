// tassello/sdk: what the plugins' widgets are made with. The page provides it
// at run time, through its import map, so that the plugins share the page's
// connection, dialogs and React: plugins build it as an external module (the
// tassello/vite plugin does), and get its types from the tassello package.
//
//   import { connection, defineWidget, definePlugin, useTopic } from 'tassello/sdk';

// Widgets and plugins
export {
  defineWidget,
  definePlugin,
  type WidgetDefinition,
  type WidgetProps,
  type PropertySchema,
  type Property,
  type RegisteredWidget,
  type TasselloClientPlugin,
} from '../widgets/types.ts';

// The robot: ROS topics, services and TF, the plugins' server sides, commands
export {
  connection,
  useConnectionStatus,
  useTopic,
  useTf,
  useCommandState,
  type Connection,
  type ConnectionStatus,
  type TopicState,
  type TopicHandlers,
  type TopicOptions,
  type PluginStreamHandlers,
  type StreamHandlers,
  type FrameInfo,
  type ImageOptions,
  type TfOptions,
} from '../connection.ts';
export { imageUrl } from '../api.ts';

// The page
export { useDialogs, Modal, type Dialogs, type ConfirmOptions, type PromptOptions } from '../dialogs.tsx';
export { notify } from '../notifications.tsx';
export { Joystick, type JoystickProps } from '../widgets/Joystick.tsx';
export * from '../icons.tsx';

export type { CommandState, ClientMessage, ServerMessage, StreamStatus, TfUpdate, Transform2D } from '../../shared/protocol.ts';
export type { Panel, WidgetInstance } from '../../shared/panel.ts';
