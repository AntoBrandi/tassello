import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Panel, WidgetInstance } from '../shared/panel.ts';
import { freeName, panelFile, panelFileName, panelFileText, readPanelFile } from './panel_files.ts';

function widget(id: string, x: number, y: number, w: number, h: number): WidgetInstance {
  return { id, type: 'test', title: '', x, y, w, h, config: { topic: `/${id}` } };
}

// Arranged for each device: the camera hidden on phones
const panel: Panel = {
  id: 'drive',
  name: 'Drive',
  widgets: [widget('map', 0, 0, 12, 10), widget('camera', 12, 0, 6, 4)],
  layouts: {
    tablet: { rects: { map: { x: 0, y: 0, w: 8, h: 8 }, camera: { x: 8, y: 0, w: 4, h: 4 } }, hidden: [] },
    phone: { rects: { map: { x: 0, y: 0, w: 6, h: 6 } }, hidden: ['camera'] },
  },
};

test('a panel file has the name, the widgets and the layouts of every device', () => {
  assert.deepEqual(panelFile(panel), { name: 'Drive', widgets: panel.widgets, layouts: panel.layouts });
  assert.equal(panelFileName(panel), 'drive.json');
  assert.deepEqual(readPanelFile(panelFileText(panel)), panelFile(panel));
  assert.ok(panelFileText(panel).endsWith('}\n'));
});

test('a panel file has its status bar, if it has one', () => {
  const statusBar = [{ id: 'wifi', type: 'wifi-status', x: 20, w: 4, config: { warnBelow: 40 } }];
  assert.deepEqual(panelFile({ ...panel, statusBar }), { name: 'Drive', widgets: panel.widgets, layouts: panel.layouts, statusBar });
  assert.deepEqual(readPanelFile(panelFileText({ ...panel, statusBar })).statusBar, statusBar);
  assert.equal('statusBar' in panelFile({ ...panel, statusBar: [] }), false);
});

test('a panel file is named after the panel, renamed or not', () => {
  assert.equal(panelFileName({ ...panel, name: 'Drive & Dock' }), 'drive-dock.json');
});

test('a panel file leaves out the places of widgets removed, and layouts if none', () => {
  const removed: Panel = { ...panel, widgets: [panel.widgets[0]] };
  assert.deepEqual(panelFile(removed).layouts, {
    tablet: { rects: { map: { x: 0, y: 0, w: 8, h: 8 } }, hidden: [] },
    phone: { rects: { map: { x: 0, y: 0, w: 6, h: 6 } }, hidden: [] },
  });
  assert.equal('layouts' in panelFile({ id: 'p', name: 'P', widgets: [] }), false);
});

test('only panels are read from files', () => {
  assert.throws(() => readPanelFile('{"name": '), /not a JSON file/);
  assert.throws(() => readPanelFile('{"name": "tassello", "version": "0.9.0"}'), /not a Tassello panel/);
  assert.throws(() => readPanelFile('[]'), /not a Tassello panel/);
  assert.throws(() => readPanelFile('null'), /not a Tassello panel/);
  assert.deepEqual(readPanelFile('{"name": "Empty", "widgets": []}'), { name: 'Empty', widgets: [] });
});

test('free names', () => {
  assert.equal(freeName('Drive', ['Navigation']), 'Drive');
  assert.equal(freeName(' Drive ', ['Drive']), 'Drive (2)');
  assert.equal(freeName('Drive', ['Drive', 'Drive (2)']), 'Drive (3)');
});
