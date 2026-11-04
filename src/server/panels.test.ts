import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { slugify } from '../shared/panel.ts';
import { HttpError, PanelRoles, PanelStore, sanitizePanel, seesPanel } from './panels.ts';

const silent = { debug() {}, info() {}, warn() {}, error() {} };

const widget = { id: 'w1', type: 'button', x: 0, y: 0, w: 2, h: 1 };

test('slugify makes file names of panel names', () => {
  assert.equal(slugify('Pick & Place #2'), 'pick-place-2');
  assert.equal(slugify('Navigazione è città'), 'navigazione-e-citta');
  assert.equal(slugify('  ***  '), 'panel');
});

test('sanitizePanel keeps the known fields and fills defaults', () => {
  const panel = sanitizePanel({ name: ' Drive ', widgets: [{ ...widget, extra: 1 }], other: true }, 'drive');
  assert.deepEqual(panel, {
    id: 'drive',
    name: 'Drive',
    // Panels of before are everyone's
    minRole: 'viewer',
    widgets: [{ ...widget, title: '', config: {} }],
  });
  assert.equal(sanitizePanel({ name: 'Arm', minRole: 'operator' }, 'arm').minRole, 'operator');
  assert.throws(() => sanitizePanel({ name: 'Arm', minRole: 'root' }, 'arm'), /minRole must be/);
});

test('sanitizePanel keeps the device layouts of the widgets it has', () => {
  const panel = sanitizePanel(
    {
      name: 'Drive',
      widgets: [widget],
      layouts: {
        phone: { rects: { w1: { x: 0, y: 2, w: 6, h: 3 }, gone: { x: 0, y: 0, w: 1, h: 1 } }, hidden: ['gone', 'w1', 'w1'] },
        tv: { rects: {} },
      },
    },
    'drive',
  );
  assert.deepEqual(panel.layouts, { phone: { rects: { w1: { x: 0, y: 2, w: 6, h: 3 } }, hidden: ['w1'] } });
  assert.equal(sanitizePanel({ name: 'Drive', widgets: [widget] }, 'drive').layouts, undefined);
  assert.throws(
    () => sanitizePanel({ name: 'x', widgets: [widget], layouts: { phone: { rects: { w1: { x: -1, y: 0, w: 1, h: 1 } } } } }, 'x'),
    HttpError,
  );
});

test('sanitizePanel refuses malformed panels', () => {
  const bad = [
    null,
    { widgets: [] },
    { name: 'x', widgets: {} },
    { name: 'x', widgets: [{ ...widget, id: '../x' }] },
    { name: 'x', widgets: [widget, widget] },
    { name: 'x', widgets: [{ ...widget, w: 0 }] },
    { name: 'x', widgets: [{ ...widget, x: 1.5 }] },
    { name: 'x', widgets: [{ ...widget, config: [] }] },
  ];
  for (const value of bad) {
    assert.throws(() => sanitizePanel(value, 'x'), HttpError, JSON.stringify(value));
  }
});

test('the store creates, lists, saves and deletes panels', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'dieletrikbot-web-'));
  try {
    const examples = path.join(root, 'examples');
    await mkdir(examples);
    await writeFile(path.join(examples, 'demo.json'), JSON.stringify({ name: 'Demo', widgets: [] }));
    const store = new PanelStore(path.join(root, 'panels'), [examples], silent);
    assert.equal(await store.init(), 1);
    // Only on the first start
    assert.equal(await store.init(), 0);

    const changes: unknown[] = [];
    store.on('changed', (...args) => changes.push(args));
    const first = await store.create({ name: 'Demo' }, 'me');
    assert.equal(first.id, 'demo-2');
    await store.save('demo-2', { name: 'Renamed', widgets: [widget], minRole: 'operator' }, null);
    assert.deepEqual(await store.list(), [
      { id: 'demo', name: 'Demo', minRole: 'viewer' },
      { id: 'demo-2', name: 'Renamed', minRole: 'operator' },
    ]);
    assert.equal(await store.minRole('demo-2'), 'operator');
    assert.equal(await store.minRole('none'), null);
    // The id is the file name, not part of the content
    const saved = JSON.parse(await readFile(path.join(root, 'panels', 'demo-2.json'), 'utf8'));
    assert.equal(saved.id, undefined);

    assert.equal(await store.remove('demo-2', null), true);
    assert.equal(await store.remove('demo-2', null), false);
    assert.equal(await store.get('../demo'), null);
    // Who saw it before, and who sees it after
    assert.deepEqual(changes, [
      ['demo-2', false, 'me', { before: null, after: 'viewer' }],
      ['demo-2', false, null, { before: 'viewer', after: 'operator' }],
      ['demo-2', true, null, { before: 'operator', after: null }],
    ]);

    // A broken file is skipped by the list, and reported by get
    await writeFile(path.join(root, 'panels', 'broken.json'), '{');
    assert.deepEqual(await store.list(), [{ id: 'demo', name: 'Demo', minRole: 'viewer' }]);
    // A broken panel: an administrator's to see, and mend
    assert.equal(await store.minRole('broken'), 'admin');
    await assert.rejects(store.get('broken'), HttpError);
    assert.deepEqual((await readdir(path.join(root, 'panels'))).sort(), ['broken.json', 'demo.json']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a panel created from a file keeps the layouts of every device, as the file has them', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'dieletrikbot-web-'));
  try {
    const store = new PanelStore(path.join(root, 'panels'), [], silent);
    await store.init();
    const file = {
      name: 'Drive',
      minRole: 'operator',
      widgets: [{ id: 'w1', type: 'button', title: '', x: 0, y: 0, w: 2, h: 1, config: { command: 'true' } }],
      layouts: {
        tablet: { rects: { w1: { x: 4, y: 0, w: 4, h: 2 } }, hidden: [] },
        phone: { rects: {}, hidden: ['w1'] },
      },
    };
    const created = await store.create(file, null);
    assert.deepEqual(await store.get(created.id), { id: 'drive', ...file });
    // A file of before: everyone's
    const { minRole: _, ...before } = file;
    assert.equal((await store.create({ ...before, name: 'Old' }, null)).minRole, 'viewer');
    assert.equal(await readFile(path.join(root, 'panels', 'drive.json'), 'utf8'), `${JSON.stringify(file, null, 2)}\n`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('sanitizePanel keeps the status bar, its widgets in their places, and refuses malformed ones', () => {
  const statusBar = [
    { id: 's1', type: 'cpu-status', x: 20, w: 4, config: {} },
    { id: 's2', type: 'wifi-status', x: 0, w: 3, config: { warnBelow: 40 } },
  ];
  assert.deepEqual(sanitizePanel({ name: 'Drive', widgets: [widget], statusBar: [{ ...statusBar[0], extra: 1 }, statusBar[1]] }, 'drive').statusBar, statusBar);
  // None: not in the file
  assert.equal('statusBar' in sanitizePanel({ name: 'Drive', widgets: [widget], statusBar: [] }, 'drive'), false);
  // Without a place: after the one before, within the bar
  assert.deepEqual(
    sanitizePanel(
      { name: 'Drive', statusBar: [{ id: 'a', type: 't', w: 4 }, { id: 'b', type: 't', x: 10, w: 3 }, { id: 'c', type: 't', w: 2 }, { id: 'd', type: 't', w: 20 }] },
      'drive',
    ).statusBar!.map((status) => [status.x, status.w]),
    [
      [0, 4],
      [10, 3],
      [13, 2],
      [4, 20],
    ],
  );
  const status = { id: 's1', type: 'wifi-status', x: 0, w: 2 };
  const bad = [
    {},
    [{ ...status, id: '../x' }],
    [status, status],
    [{ ...status, type: '' }],
    [{ ...status, w: 0 }],
    [{ ...status, w: 25 }],
    [{ ...status, w: 1.5 }],
    [{ ...status, x: -1 }],
    [{ ...status, x: 24 }],
    [{ ...status, config: [] }],
  ];
  for (const value of bad) {
    assert.throws(() => sanitizePanel({ name: 'x', widgets: [], statusBar: value }, 'x'), HttpError, JSON.stringify(value));
  }
});

test('who sees each panel is kept as they change', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'tassello-panels-'));
  try {
    const store = new PanelStore(path.join(root, 'panels'), [], silent);
    await store.init();
    await store.create({ name: 'Watch' }, null);
    const roles = new PanelRoles(store);
    await roles.load();
    assert.equal(roles.known('watch'), 'viewer');
    assert.equal(roles.known('drive'), undefined);
    await store.create({ name: 'Drive', minRole: 'operator' }, null);
    assert.equal(roles.known('drive'), 'operator');
    await store.remove('drive', null);
    assert.equal(roles.known('drive'), null);
    // A file copied in meanwhile: read when asked
    await writeFile(path.join(root, 'panels', 'arm.json'), JSON.stringify({ name: 'Arm', minRole: 'admin' }));
    assert.equal(await roles.of('arm'), 'admin');

    assert.equal(seesPanel('viewer', 'viewer'), true);
    assert.equal(seesPanel('viewer', 'operator'), false);
    assert.equal(seesPanel('admin', 'admin'), true);
    // No panel: administrators only
    assert.equal(seesPanel('operator', null), false);
    assert.equal(seesPanel('operator', undefined), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
