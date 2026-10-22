import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  addSamples,
  clockTime,
  csvText,
  fieldLabel,
  MAX_POINTS,
  numericFields,
  panView,
  parseSeries,
  pointsIn,
  relativeTime,
  SeriesBuffer,
  seriesText,
  tickText,
  timeTicks,
  topicFields,
  valueText,
  valueTicks,
  zoomView,
} from './model.ts';

test('series, one a line: the topic, its field, a label', () => {
  const { series, invalid } = parseSeries(
    ' /odom.twist.twist.linear.x\nbattery_state.voltage  Battery\n\n/joint_states.effort[2] elbow effort\n/odom\n/odom.twist.twist.linear.x again\n/data[0]',
  );
  assert.deepEqual(
    series.map((s) => [s.path, s.topic, s.field, s.label]),
    [
      ['/odom.twist.twist.linear.x', '/odom', 'twist.twist.linear.x', ''],
      ['/battery_state.voltage', '/battery_state', 'voltage', 'Battery'],
      ['/joint_states.effort[2]', '/joint_states', 'effort[2]', 'elbow effort'],
      ['/data[0]', '/data', '[0]', ''],
    ],
  );
  assert.deepEqual(invalid, ['/odom']);
  assert.equal(seriesText(series.slice(0, 2)), '/odom.twist.twist.linear.x\n/battery_state.voltage Battery');
  assert.deepEqual([...topicFields(series)], [
    ['/odom', ['twist.twist.linear.x']],
    ['/battery_state', ['voltage']],
    ['/joint_states', ['effort[2]']],
    ['/data', ['[0]']],
  ]);
  assert.equal(parseSeries(Array.from({ length: 10 }, (_, n) => `/t.f${n}`).join('\n')).invalid.length, 2);
});

test('samples: kept in order, the line broken where the topic stopped', () => {
  const buffer = new SeriesBuffer();
  addSamples([buffer, undefined], { at: [1000, 1010, 1020], values: [[1, null, 3], [9, 9, 9]] });
  assert.deepEqual([...buffer.values.subarray(buffer.start, buffer.end)], [1, Number.NaN, 3]);
  assert.equal(buffer.numbers, true);
  // 10 ms apart, then 3 s: a break, at the last sample's time
  buffer.push(4020, 4);
  assert.deepEqual([...buffer.times.subarray(buffer.start, buffer.end)], [1000, 1010, 1020, 1020, 4020]);
  assert.equal(buffer.valueAt(1015), null);
  assert.equal(buffer.valueAt(1020), 3);
  assert.equal(buffer.valueAt(3000), null);
  assert.equal(buffer.valueAt(5000), 4);
  assert.equal(buffer.valueAt(500), null);
  // A battery's, once a second: joined
  const slow = new SeriesBuffer();
  [0, 1000, 2000, 3100].forEach((at) => slow.push(at, 24));
  assert.equal(slow.length, 4);
  // The server's clock set back
  slow.push(-50_000, 1);
  assert.equal(slow.length, 1);
});

test('samples: the latest kept, in arrays that grow', () => {
  const buffer = new SeriesBuffer();
  for (let n = 0; n < 5000; n++) {
    buffer.push(n, n);
  }
  buffer.trim(4000);
  assert.equal(buffer.length, 1000);
  assert.equal(buffer.valueAt(4000), 4000);
  for (let n = 5000; n < MAX_POINTS + 10_000; n++) {
    buffer.push(n, n);
  }
  buffer.trim(0);
  assert.equal(buffer.length, MAX_POINTS);
  assert.equal(buffer.times[buffer.end - 1], MAX_POINTS + 9999);
});

test('points drawn: all of few samples, the shape of many', () => {
  const buffer = new SeriesBuffer();
  for (let n = 0; n <= 100; n++) {
    buffer.push(n * 10, n === 55 ? 50 : 0);
  }
  // With the samples just outside
  assert.deepEqual(pointsIn(buffer, 200, 300, 100).times, [190, 200, 210, 220, 230, 240, 250, 260, 270, 280, 290, 300]);
  assert.deepEqual(pointsIn(buffer, 200, 295, 100).times.slice(-2), [290, 300]);
  // 4 columns of 250 ms: their first, lowest, highest and last; the spike kept
  const points = pointsIn(buffer, 0, 1000, 4);
  assert.deepEqual(points.times, [0, 240, 250, 490, 500, 550, 740, 750, 990, 1000]);
  assert.equal(Math.max(...points.values), 50);
});

test('axes: round ticks, times before now or of the clock', () => {
  assert.deepEqual(valueTicks(0.12, 0.87, 4), { min: 0, max: 1, step: 0.2, ticks: [0, 0.2, 0.4, 0.6000000000000001, 0.8, 1] });
  assert.deepEqual(valueTicks(24, 24, 4).ticks, [20, 22, 24, 26, 28]);
  assert.deepEqual(valueTicks(0, 0, 4).ticks, [-1, -0.5, 0, 0.5, 1]);
  assert.equal(tickText(0.6000000000000001, 0.2), '0.6');
  assert.equal(tickText(-1e-17, 0.5), '0.0');
  assert.deepEqual(timeTicks(1_000_000 - 30_000, 1_000_000, 6, true), {
    step: 5000,
    ticks: [970_000, 975_000, 980_000, 985_000, 990_000, 995_000, 1_000_000],
  });
  assert.deepEqual(timeTicks(1_001_234, 1_003_000, 5, false).ticks, [1_001_500, 1_002_000, 1_002_500, 1_003_000]);
  assert.equal(relativeTime(20_000, 5000), '−20 s');
  assert.equal(relativeTime(1500, 500), '−1.5 s');
  assert.equal(relativeTime(120_000, 60_000), '−2 min');
  assert.equal(relativeTime(0, 5000), 'now');
  assert.match(clockTime(Date.UTC(2026, 9, 22, 12, 3, 21, 250), 500), /^\d\d:03:21\.2$/);
  assert.equal(valueText(0.213456), '0.2135');
  assert.equal(valueText(24.1), '24.1');
  assert.equal(valueText(1729612345.25), '1729612345.3');
  assert.equal(valueText(-0.0000173), '-1.73e-5');
  assert.equal(valueText(null), '–');
});

test('zoom and pan: live, a span to now; else around a point, not past now', () => {
  assert.deepEqual(zoomView({ live: true, span: 30_000 }, 100_000, 0.5, 0.3), { live: true, span: 15_000 });
  assert.deepEqual(zoomView({ live: false, from: 0, to: 10_000 }, 100_000, 0.5, 0.2), { live: false, from: 1000, to: 6000 });
  assert.deepEqual(panView({ live: true, span: 10_000 }, 100_000, -0.5), { live: false, from: 85_000, to: 95_000 });
  assert.deepEqual(panView({ live: false, from: 80_000, to: 90_000 }, 100_000, 2), { live: false, from: 90_000, to: 100_000 });
});

test('CSV: a row a message, the series of a topic together', () => {
  const [x, z, volts] = [new SeriesBuffer(), new SeriesBuffer(), new SeriesBuffer()];
  addSamples([x, z], { at: [1000, 1000, 1500], values: [[0.5, 0.75, 1], [0, 0.1, null]] });
  addSamples([volts], { at: [1200], values: [[24.25]] });
  assert.equal(
    csvText(
      [
        { name: '/odom.twist.twist.linear.x', topic: '/odom', buffer: x },
        { name: 'yaw "rate", rad/s', topic: '/odom', buffer: z },
        { name: 'Battery', topic: '/battery', buffer: volts },
      ],
      1000,
      1500,
    ),
    'time,/odom.twist.twist.linear.x,"yaw ""rate"", rad/s",Battery\n1.000,0.5,0,\n1.000,0.75,0.1,\n1.200,,,24.25\n1.500,1,,\n',
  );
});

test('the fields to plot of a message: numbers, booleans, times; joints by name', () => {
  const { fields, cut } = numericFields({
    header: { stamp: { sec: 10, nanosec: 500_000_000 }, frame_id: 'base' },
    name: ['shoulder', 'elbow'],
    position: [0.1, 0.2],
    effort: { $truncated: 2, head: [1.5] },
    present: true,
    big: { $int: '9007199254740993' },
    nan: { $number: 'nan' },
    covariance: { $truncated: 36, head: [0, 1] },
  });
  assert.deepEqual(
    fields.map((f) => [f.field, f.value, f.name]),
    [
      ['header.stamp', 10.5, null],
      ['position[0]', 0.1, 'shoulder'],
      ['position[1]', 0.2, 'elbow'],
      ['effort[0]', 1.5, 'shoulder'],
      ['present', 1, null],
      ['big', 9007199254740992, null],
      ['nan', null, null],
      ['covariance[0]', 0, null],
      ['covariance[1]', 1, null],
    ],
  );
  assert.equal(cut, true);
  assert.equal(fieldLabel(fields[2]), 'elbow position');
  assert.equal(fieldLabel(fields[0]), '');
});
