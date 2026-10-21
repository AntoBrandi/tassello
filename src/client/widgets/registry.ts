// The widgets the dashboard offers: Tassello's own, then those of the plugins
// (see ../plugins.ts), which may also change the defaults of any widget's
// properties, e.g. a robot's topic names and speed limits.
//
// To add one to Tassello: write its component and its definition
// (defineWidget, see types.ts) in a file of this folder, and list it in CORE.
// Its config is whatever its properties declare; it reaches ROS through
// connection.ts, whose protocol (src/shared/protocol.ts) the server implements.

import { applicationsWidget } from './ApplicationsWidget.tsx';
import { armTeleopWidget } from './ArmTeleopWidget.tsx';
import { behaviorTreeEditorWidget } from './behavior_tree/BehaviorTreeEditorWidget.tsx';
import { behaviorTreeWidget } from './behavior_tree/BehaviorTreeWidget.tsx';
import { buttonWidget } from './ButtonWidget.tsx';
import { cameraWidget } from './CameraWidget.tsx';
import { diagnosticsWidget } from './diagnostics/DiagnosticsWidget.tsx';
import { fileManagerWidget } from './file_manager/FileManagerWidget.tsx';
import { imageWidget } from './ImageWidget.tsx';
import { logsWidget } from './logs/LogsWidget.tsx';
import { monitorWidget } from './monitor/MonitorWidget.tsx';
import { navigationWidget } from './NavigationWidget.tsx';
import { networkingWidget } from './networking/NetworkingWidget.tsx';
import { parametersWidget } from './parameters/ParametersWidget.tsx';
import { robotModelWidget } from './robot_model/RobotModelWidget.tsx';
import { teleopWidget } from './TeleopWidget.tsx';
import { terminalWidget } from './terminal/TerminalWidget.tsx';
import type { RegisteredWidget, TasselloClientPlugin } from './types.ts';
import { WidgetRegistry } from './widget_registry.ts';

export { resolveConfig, type WidgetEntry } from './widget_registry.ts';

const CORE: RegisteredWidget[] = [
  teleopWidget,
  navigationWidget,
  robotModelWidget,
  armTeleopWidget,
  cameraWidget,
  imageWidget,
  buttonWidget,
  applicationsWidget,
  behaviorTreeWidget,
  behaviorTreeEditorWidget,
  logsWidget,
  diagnosticsWidget,
  monitorWidget,
  parametersWidget,
  fileManagerWidget,
  terminalWidget,
  networkingWidget,
];

const registry = new WidgetRegistry(CORE);

// Adds a plugin's widgets and defaults; returns what was wrong with them
export function registerPlugin(name: string, plugin: TasselloClientPlugin): string[] {
  return registry.registerPlugin(name, plugin);
}

export function widgetEntries() {
  return registry.entries();
}

export function widgetDefinition(type: string): RegisteredWidget | undefined {
  return registry.definition(type);
}
