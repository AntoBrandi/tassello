import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { DiagnosticChange, DiagnosticEntry, DiagnosticsUpdate } from '../../../shared/protocol.ts';
import { textMatch } from '../logs/model.ts';
import {
  AUTO_FOLDING,
  buildTree,
  changeLine,
  displayed,
  EMPTY,
  filterChanges,
  isForgotten,
  keepUnfolded,
  levelOf,
  levelsFrom,
  reduce,
  rowMessage,
  statusLevel,
  statusPath,
  statusScope,
  statusText,
  viewDiagnostics,
  type DiagnosticNode,
  type Filter,
  type Model,
} from './model.ts';

let lastId = 0;
const entry = (name: string, level = 0, fields: Partial<DiagnosticEntry> = {}): DiagnosticEntry => ({
  id: ++lastId,
  name,
  level,
  message: ['OK', 'Warning', 'Error', 'Stale'][level] ?? '',
  hardwareId: '',
  values: [],
  stale: false,
  updated: 1000,
  since: 1000,
  ...fields,
});

const ALL: Filter = { scope: null, levels: levelsFrom('ok'), text: null };

function update(fields: Partial<DiagnosticsUpdate>): DiagnosticsUpdate {
  return { type: 'diagnostics', id: 1, reset: false, started: 100, statuses: [], changes: [], ...fields };
}

function opened(statuses: DiagnosticEntry[], changes: DiagnosticChange[] = []): Model {
  return reduce(EMPTY, { type: 'update', update: update({ reset: true, statuses, changes }) });
}

// The rows as text: indented labels, + unfolded, - folded, * dim
const rows = (entries: DiagnosticEntry[], filter = ALL, folding = AUTO_FOLDING) =>
  viewDiagnostics(entries, filter, folding).rows.map(
    ({ node, depth, open, dim }) =>
      `${'  '.repeat(depth)}${open === null ? '' : open ? '+' : '-'}${node.label}${dim ? '*' : ''}`,
  );

// An aggregator's tree: /Robot, its sensors and motors
function aggregated(lidar = 0, left = 0): DiagnosticEntry[] {
  const worst = Math.max(lidar, left);
  return [
    entry('/Robot', worst),
    entry('/Robot/Sensors', lidar),
    entry('/Robot/Sensors/Lidar', lidar, { message: lidar ? 'No scan' : 'OK', hardwareId: 'hokuyo_123' }),
    entry('/Robot/Sensors/IMU'),
    entry('/Robot/Motors', left),
    entry('/Robot/Motors/Left', left),
    entry('/Robot/Motors/Right'),
  ];
}

test('levels, from diagnostic_msgs/msg/DiagnosticStatus, stale when no longer received', () => {
  assert.deepEqual([0, 1, 2, 3, 7].map(levelOf), ['ok', 'warn', 'error', 'stale', 'error']);
  assert.equal(statusLevel(entry('a', 1, { stale: true })), 'stale');
  assert.deepEqual([...levelsFrom('warn')], ['warn', 'error', 'stale']);
  assert.deepEqual([...levelsFrom('stale')], ['error', 'stale']);
});

test('paths: the aggregator’s, and diagnostic_updater’s node then task', () => {
  assert.deepEqual(statusPath('/Robot/Sensors/Tilt Hokuyo'), ['Robot', 'Sensors', 'Tilt Hokuyo']);
  assert.deepEqual(statusPath('/Diagnostics/Lidar: '), ['Diagnostics', 'Lidar']);
  assert.deepEqual(statusPath('amcl: Localization'), ['amcl', 'Localization']);
  assert.deepEqual(statusPath('hokuyo_node: /scan topic status'), ['hokuyo_node', '/scan topic status']);
  assert.deepEqual(statusPath('Battery'), ['Battery']);
  assert.deepEqual(statusPath(''), ['(no name)']);
  assert.deepEqual(statusPath('/'), ['/']);
});

test('the scope: names and globs, from the root or at any depth, with those under them', () => {
  const scope = statusScope('Sensors, motor_*; amcl')!;
  assert.equal(scope(['Robot', 'Sensors', 'Lidar']), true);
  assert.equal(scope(['Robot', 'sensors']), true);
  assert.equal(scope(['Robot', 'Motors']), false);
  assert.equal(scope(['base', 'motor_left']), true);
  assert.equal(scope(['amcl', 'Localization']), true);
  assert.equal(scope(['amcl_bis', 'Localization']), false);

  const rooted = statusScope('/Robot/Sensors')!;
  assert.equal(rooted(['Robot', 'Sensors', 'IMU']), true);
  assert.equal(rooted(['Other', 'Robot', 'Sensors']), false);
  assert.equal(rooted(['Robot']), false);

  // A status as diagnostic_updater names it
  const task = statusScope('hokuyo_node: Connection')!;
  assert.equal(task(['hokuyo_node', 'Connection']), true);
  assert.equal(task(['hokuyo_node', 'Frequency']), false);

  assert.equal(statusScope(' , ;'), null);
});

test('the tree of the paths, sorted, the nodes’ tasks under them', () => {
  const { roots } = buildTree([
    entry('lidar_10: Frequency'),
    entry('lidar_9: Connection'),
    entry('lidar_9: Frequency', 1),
    entry('Battery'),
  ]);
  const shape = (nodes: DiagnosticNode[]): unknown =>
    nodes.map((node) => (node.children.length ? { [node.label]: shape(node.children) } : node.label));
  assert.deepEqual(shape(roots), ['Battery', { lidar_9: ['Connection', 'Frequency'] }, { lidar_10: ['Frequency'] }]);
  const lidar9 = roots[1];
  assert.equal(lidar9.entry, null);
  assert.equal(lidar9.own, null);
  assert.equal(lidar9.worst, 'warn');
  assert.equal(lidar9.counted, false);
  assert.equal(lidar9.children[1].counted, true);
});

test('a group in error because of stale statuses under it is stale; one with a problem of its own counts', () => {
  const { nodes } = buildTree([
    entry('/Sensors', 2),
    entry('/Sensors/Lidar', 0, { stale: true }),
    entry('/Sensors/IMU', 0),
    entry('/Motors', 2, { message: 'Missing: Left' }),
    entry('/Motors/Right', 1),
    entry('/Arm', 2),
    entry('/Arm/Joint', 2),
    entry('/Arm/Gripper', 3),
  ]);
  const sensors = nodes.get('\nSensors')!;
  assert.equal(sensors.own, 'stale');
  assert.equal(sensors.worst, 'stale');
  assert.equal(sensors.counted, false);
  // Its error is its own: those under it only warn
  const motors = nodes.get('\nMotors')!;
  assert.equal(motors.own, 'error');
  assert.equal(motors.counted, true);
  // An error under it: an error
  assert.equal(nodes.get('\nArm')!.own, 'error');
  assert.equal(nodes.get('\nArm')!.counted, false);
});

test('statuses of the same path stay apart', () => {
  const { roots, nodes } = buildTree([entry('/amcl/Localization', 0), entry('amcl: Localization', 2)]);
  assert.equal(roots.length, 1);
  assert.deepEqual(
    roots[0].children.map((node) => [node.label, node.own]),
    [
      ['Localization', 'ok'],
      ['Localization', 'error'],
    ],
  );
  assert.equal(nodes.size, 3);
});

test('counts: of the statuses, not of the groups the aggregator sums them in', () => {
  const view = viewDiagnostics(aggregated(2, 1), ALL, AUTO_FOLDING);
  assert.deepEqual(view.counts, { ok: 2, warn: 1, error: 1, stale: 0 });
  assert.deepEqual(view.totals, view.counts);
  assert.equal(view.total, 4);
  assert.equal(view.worst, 'error');
  assert.equal(view.filtering, false);
});

test('unfolded: the lone root, and the groups with problems under them', () => {
  assert.deepEqual(rows(aggregated(2, 0)), ['+Robot', '  -Motors', '  +Sensors', '    IMU', '    Lidar']);
  assert.deepEqual(rows(aggregated(0, 0)), ['+Robot', '  -Motors', '  -Sensors']);
});

test('folding as chosen: all, or each group', () => {
  const entries = aggregated(2, 0);
  assert.equal(rows(entries, ALL, { mode: 'all', chosen: new Map() }).length, 7);
  assert.deepEqual(rows(entries, ALL, { mode: 'all', chosen: new Map([['\nRobot', false]]) }), ['-Robot']);
  assert.deepEqual(rows(entries, ALL, { mode: 'auto', chosen: new Map([['\nRobot\nSensors', false]]) }), [
    '+Robot',
    '  -Motors',
    '  -Sensors',
  ]);
});

test('the groups unfolded for their problems stay so once these are gone', () => {
  let folding = AUTO_FOLDING;
  folding = keepUnfolded(viewDiagnostics(aggregated(2, 0), ALL, folding), folding);
  assert.deepEqual([...folding.chosen], [
    ['\nRobot', true],
    ['\nRobot\nSensors', true],
  ]);
  assert.deepEqual(rows(aggregated(0, 0), ALL, folding), ['+Robot', '  -Motors', '  +Sensors', '    IMU', '    Lidar']);
  // Nothing new: the same folding
  assert.equal(keepUnfolded(viewDiagnostics(aggregated(0, 0), ALL, folding), folding), folding);
  // Folded by hand, it stays folded
  const folded = { ...folding, chosen: new Map([...folding.chosen, ['\nRobot\nSensors', false]]) };
  assert.equal(keepUnfolded(viewDiagnostics(aggregated(2, 0), ALL, folded), folded), folded);
  // Filtered, everything is unfolded: none kept
  const filtered = { ...ALL, levels: levelsFrom('error') };
  assert.equal(keepUnfolded(viewDiagnostics(aggregated(2, 1), filtered, AUTO_FOLDING), AUTO_FOLDING), AUTO_FOLDING);
});

test('by level: those of the levels, under their groups, which only show them', () => {
  const filter = { ...ALL, levels: levelsFrom('warn') };
  assert.deepEqual(rows(aggregated(2, 1), filter), ['+Robot*', '  +Motors*', '    Left', '  +Sensors*', '    Lidar']);
  const view = viewDiagnostics(aggregated(2, 1), filter, AUTO_FOLDING);
  assert.deepEqual(
    view.list.map((node) => node.entry!.name),
    ['/Robot/Sensors/Lidar', '/Robot/Motors/Left'],
  );
  assert.equal(view.matching, 2);
  // The counts are of every level, for the toolbar
  assert.equal(view.counts.ok, 2);
  assert.equal(view.total, 4);
  // A folded group stays folded
  assert.deepEqual(rows(aggregated(2, 1), filter, { mode: 'auto', chosen: new Map([['\nRobot\nMotors', false]]) }), [
    '+Robot*',
    '  -Motors*',
    '  +Sensors*',
    '    Lidar',
  ]);
});

test('by text: the name, message or hardware id, a group’s with those under it', () => {
  const text = (terms: string) => ({ ...ALL, text: textMatch(terms, false).test });
  assert.deepEqual(rows(aggregated(2, 0), text('no scan')), ['+Robot*', '  +Sensors*', '    Lidar']);
  const view = viewDiagnostics(aggregated(2, 0), text('imu'), AUTO_FOLDING);
  assert.deepEqual(view.counts, { ok: 1, warn: 0, error: 0, stale: 0 });
  // Whatever the filters
  assert.deepEqual(view.totals, { ok: 3, warn: 0, error: 1, stale: 0 });
  assert.deepEqual(rows(aggregated(2, 0), text('HOKUYO_123')), ['+Robot*', '  +Sensors*', '    Lidar']);
  assert.deepEqual(rows(aggregated(0, 0), text('motors')), ['+Robot*', '  +Motors*', '    Left', '    Right']);
  // A node's tasks, by its name
  assert.deepEqual(rows([entry('amcl: Localization'), entry('lidar: Connection')], text('amcl')), [
    '+amcl*',
    '  Localization',
  ]);
});

test('the scope leaves the others out of the tree and its counts', () => {
  const view = viewDiagnostics(aggregated(2, 1), { ...ALL, scope: statusScope('Sensors') }, AUTO_FOLDING);
  assert.deepEqual(view.counts, { ok: 1, warn: 0, error: 1, stale: 0 });
  assert.equal(view.total, 2);
  assert.equal(view.filtering, false);
  assert.deepEqual(
    view.rows.map((row) => row.node.label),
    ['Robot', 'Sensors', 'IMU', 'Lidar'],
  );
});

test('the keys of the statuses, to select them', () => {
  const entries = aggregated();
  const view = viewDiagnostics(entries, ALL, AUTO_FOLDING);
  assert.equal(view.keys.get(entries[2].id), '\nRobot\nSensors\nLidar');
  assert.equal(view.nodes.get('\nRobot\nSensors\nLidar')?.entry, entries[2]);
});

test('the statuses, then those that changed, and their changes', () => {
  const [a, b] = [entry('a'), entry('b', 1)];
  let model = opened([a, b], [{ seq: 1, time: 1000, status: b.id, level: 1, message: 'Warning' }]);
  assert.equal(model.received, true);
  assert.equal(model.statuses.size, 2);
  const changed = { ...a, level: 2, message: 'Broken' };
  const change = { seq: 2, time: 2000, status: a.id, level: 2, message: 'Broken' };
  model = reduce(model, { type: 'update', update: update({ statuses: [changed], changes: [change] }) });
  assert.equal(model.statuses.get(a.id), changed);
  assert.equal(model.statuses.get(b.id), b);
  assert.equal(model.changes.length, 2);
});

test('paused, what was shown stays so while the statuses keep coming', () => {
  const a = entry('a');
  let model = reduce(opened([a]), { type: 'pause' });
  model = reduce(model, { type: 'update', update: update({ statuses: [{ ...a, level: 2 }] }) });
  assert.equal(displayed(model).statuses.get(a.id)?.level, 0);
  assert.equal(model.statuses.get(a.id)?.level, 2);
  model = reduce(model, { type: 'resume' });
  assert.equal(displayed(model).statuses.get(a.id)?.level, 2);
});

test('forgotten: the statuses no longer published, until published again', () => {
  const stale = entry('gone', 1, { stale: true, since: 5000 });
  const live = entry('here', 1);
  // Stale as the aggregator publishes it: still published
  const reported = entry('/Sensors/Lidar', 3);
  let model = reduce(opened([stale, live, reported]), { type: 'forget', ids: [stale.id, live.id, reported.id] });
  assert.equal(isForgotten(model.forgotten, model.statuses.get(stale.id)!), true);
  assert.equal(isForgotten(model.forgotten, model.statuses.get(live.id)!), false);
  assert.equal(isForgotten(model.forgotten, model.statuses.get(reported.id)!), false);
  // The connection back, the same diagnostics: still forgotten
  model = reduce(model, { type: 'update', update: update({ reset: true, statuses: [stale, live] }) });
  assert.equal(isForgotten(model.forgotten, stale), true);
  // Fresh again
  const fresh = { ...stale, stale: false, since: 9000 };
  model = reduce(model, { type: 'update', update: update({ statuses: [fresh] }) });
  assert.equal(isForgotten(model.forgotten, fresh), false);
});

test('other diagnostics: another version, nothing forgotten', () => {
  const stale = entry('gone', 1, { stale: true });
  let model = reduce(opened([stale]), { type: 'forget', ids: [stale.id] });
  const version = model.version;
  model = reduce(model, { type: 'update', update: update({ reset: true, started: 200, statuses: [stale] }) });
  assert.equal(model.version, version + 1);
  assert.equal(isForgotten(model.forgotten, stale), false);
});

test('the changes the filters let through, the latest first', () => {
  const [lidar, imu] = [entry('/Sensors/Lidar'), entry('/Sensors/IMU')];
  const statuses = new Map([lidar, imu].map((e) => [e.id, e]));
  const changes: DiagnosticChange[] = [
    { seq: 1, time: 1000, status: lidar.id, level: 2, message: 'No scan' },
    { seq: 2, time: 2000, status: imu.id, level: 1, message: 'Drifting' },
    { seq: 3, time: 3000, status: lidar.id, level: 0, message: 'OK' },
    { seq: 4, time: 4000, status: 99, level: 2, message: 'Unknown status' },
  ];
  const seqs = (filter: Filter) => filterChanges(changes, statuses, filter).map((c) => c.seq);
  assert.deepEqual(seqs(ALL), [3, 2, 1]);
  assert.deepEqual(seqs({ ...ALL, levels: levelsFrom('warn') }), [2, 1]);
  assert.deepEqual(seqs({ ...ALL, text: textMatch('lidar', false).test }), [3, 1]);
  assert.deepEqual(seqs({ ...ALL, scope: statusScope('IMU') }), [2]);
});

test('a group’s message only if it says more than its level', () => {
  const { nodes } = buildTree([
    entry('/Sensors', 1, { message: 'Warning' }),
    entry('/Sensors/Lidar', 1, { message: 'Warning' }),
    entry('/Motors', 2, { message: 'Missing: Left' }),
    entry('/Motors/Right'),
  ]);
  assert.equal(rowMessage(nodes.get('\nSensors')!), '');
  assert.equal(rowMessage(nodes.get('\nSensors\nLidar')!), 'Warning');
  assert.equal(rowMessage(nodes.get('\nMotors')!), 'Missing: Left');
});

test('a status as text, with the level it had when stale', () => {
  assert.equal(
    statusText(
      entry('/Sensors/Lidar', 1, {
        message: 'Slow',
        hardwareId: 'hokuyo_123',
        values: [{ key: 'Rate', value: '4.9' }],
        stale: true,
      }),
    ),
    '[STALE (WARN)] /Sensors/Lidar: Slow\n    hardware_id: hokuyo_123\n    Rate: 4.9',
  );
  assert.equal(statusText(entry('Battery', 0, { message: '' })), '[OK] Battery');
});

test('a change as a line, at the time of the page', () => {
  const lidar = entry('/Sensors/Lidar');
  const time = new Date(2026, 9, 20, 14, 3, 27, 512).getTime();
  assert.equal(
    changeLine({ seq: 1, time, status: lidar.id, level: 3, message: 'No scan' }, lidar),
    '[14:03:27.512] [STALE] /Sensors/Lidar: No scan',
  );
});
