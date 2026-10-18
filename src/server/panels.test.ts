import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { HttpError, PanelStore, sanitizePanel, slugify } from './panels.ts';

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
    widgets: [{ ...widget, title: '', config: {} }],
  });
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
    await store.save('demo-2', { name: 'Renamed', widgets: [widget] }, null);
    assert.deepEqual(await store.list(), [
      { id: 'demo', name: 'Demo' },
      { id: 'demo-2', name: 'Renamed' },
    ]);
    // The id is the file name, not part of the content
    const saved = JSON.parse(await readFile(path.join(root, 'panels', 'demo-2.json'), 'utf8'));
    assert.equal(saved.id, undefined);

    assert.equal(await store.remove('demo-2', null), true);
    assert.equal(await store.remove('demo-2', null), false);
    assert.equal(await store.get('../demo'), null);
    assert.deepEqual(changes, [
      ['demo-2', false, 'me'],
      ['demo-2', false, null],
      ['demo-2', true, null],
    ]);

    // A broken file is skipped by the list, and reported by get
    await writeFile(path.join(root, 'panels', 'broken.json'), '{');
    assert.deepEqual(await store.list(), [{ id: 'demo', name: 'Demo' }]);
    await assert.rejects(store.get('broken'), HttpError);
    assert.deepEqual((await readdir(path.join(root, 'panels'))).sort(), ['broken.json', 'demo.json']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
