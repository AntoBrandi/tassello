// The widgets the dashboard offers: Tassello's own, then those of the plugins
// (see ../plugins.ts), which may also change the defaults of any widget's
// properties, e.g. a robot's topic names and speed limits.
//
// To add one to Tassello: write its component and its definition
// (defineWidget, see types.ts) in a file of this folder, and list it in CORE.
// Its config is whatever its properties declare; it reaches ROS through
// connection.ts, whose protocol (src/shared/protocol.ts) the server implements.
// A status widget, of the status bar above the panels, the same way:
// defineStatusWidget, listed in CORE_STATUS (see status/). A display of the
// Robot Viewer too: defineDisplay, listed in CORE_DISPLAYS (see
// robot_viewer/displays/).

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
import { plotWidget } from './plot/PlotWidget.tsx';
import { CORE_DISPLAYS } from './robot_viewer/displays/index.ts';
import { robotViewerWidget } from './robot_viewer/RobotViewerWidget.tsx';
import { rosbagsWidget } from './rosbags/RosbagsWidget.tsx';
import { speedometerWidget } from './speedometer/SpeedometerWidget.tsx';
import { systemMonitorWidget } from './system/SystemMonitorWidget.tsx';
import { teleopWidget } from './TeleopWidget.tsx';
import { terminalWidget } from './terminal/TerminalWidget.tsx';
import { cpuStatusWidget } from './status/CpuStatus.tsx';
import { wifiStatusWidget } from './status/WifiStatus.tsx';
import type { RegisteredDisplay, RegisteredStatusWidget, RegisteredWidget, TasselloClientPlugin } from './types.ts';
import { webPageWidget } from './web_page/WebPageWidget.tsx';
import { DisplayRegistry, StatusWidgetRegistry, WidgetRegistry } from './widget_registry.ts';

export { resolveConfig, type DisplayEntry, type StatusWidgetEntry, type WidgetEntry } from './widget_registry.ts';

const CORE: RegisteredWidget[] = [
  teleopWidget,
  speedometerWidget,
  navigationWidget,
  robotViewerWidget,
  armTeleopWidget,
  cameraWidget,
  imageWidget,
  webPageWidget,
  buttonWidget,
  applicationsWidget,
  behaviorTreeWidget,
  behaviorTreeEditorWidget,
  logsWidget,
  diagnosticsWidget,
  monitorWidget,
  plotWidget,
  parametersWidget,
  rosbagsWidget,
  fileManagerWidget,
  terminalWidget,
  networkingWidget,
  systemMonitorWidget,
];

const CORE_STATUS: RegisteredStatusWidget[] = [wifiStatusWidget, cpuStatusWidget];

// Types are unique across the three registries, as the defaults are by type
const registry = new WidgetRegistry(CORE, (type) => statusRegistry.owner(type) ?? displayRegistry.owner(type));
const statusRegistry = new StatusWidgetRegistry(CORE_STATUS, (type) => registry.owner(type) ?? displayRegistry.owner(type));
const displayRegistry = new DisplayRegistry(CORE_DISPLAYS, (type) => registry.owner(type) ?? statusRegistry.owner(type));

// Adds a plugin's widgets, status widgets, displays and defaults; returns
// what was wrong with them
export function registerPlugin(name: string, plugin: TasselloClientPlugin): string[] {
  return [
    ...registry.registerPlugin(name, plugin),
    ...statusRegistry.registerPlugin(name, plugin),
    ...displayRegistry.registerPlugin(name, plugin),
  ];
}

export function widgetEntries() {
  return registry.entries();
}

export function widgetDefinition(type: string): RegisteredWidget | undefined {
  return registry.definition(type);
}

export function statusWidgetEntries() {
  return statusRegistry.entries();
}

export function statusWidgetDefinition(type: string): RegisteredStatusWidget | undefined {
  return statusRegistry.definition(type);
}

// The Robot Viewer's displays, Tassello's then the plugins'
export function displayEntries() {
  return displayRegistry.entries();
}

export function displayDefinition(type: string): RegisteredDisplay | undefined {
  return displayRegistry.definition(type);
}
