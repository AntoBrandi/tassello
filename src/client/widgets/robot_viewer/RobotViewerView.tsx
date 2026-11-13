// The Robot Viewer widget's content, loaded with three.js only when a panel
// shows one (see RobotViewerWidget.tsx): a ViewerView of the widget's config,
// whose toolbar changes it, and in edit mode, scrolling on it, its zoom.

import type { WidgetProps } from '../types.ts';
import type { RobotViewerConfig } from './RobotViewerWidget.tsx';
import { ViewerView } from './ViewerView.tsx';

export default function RobotViewerView({ config, editing, updateConfig }: WidgetProps<RobotViewerConfig>) {
  return (
    <ViewerView
      fixedFrame={config.fixedFrame}
      view={config.view}
      displays={config.displays}
      onViewChange={(view) => updateConfig({ view })}
      onFixedFrameChange={(fixedFrame) => updateConfig({ fixedFrame })}
      zoom={config.zoom}
      onZoomChange={editing ? (zoom) => updateConfig({ zoom }) : undefined}
      disabled={editing}
      emptyMessage="No displays: add some in edit mode"
    />
  );
}
