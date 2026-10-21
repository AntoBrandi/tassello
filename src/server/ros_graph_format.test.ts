import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { TopicEndpoint } from '../shared/monitor.ts';
import { graphSnapshot, qosIncompatibility, qosProblems, qosProfile, type GraphNode } from './ros_graph_format.ts';

const node = (name: string, namespace: string, parts: Partial<GraphNode> = {}): GraphNode => ({
  name,
  namespace,
  servers: [],
  clients: [],
  actionServers: [],
  actionClients: [],
  ...parts,
});

test('the graph: sorted, services and actions with the nodes serving and using them', () => {
  const graph = graphSnapshot({
    topics: [
      { name: '/scan', types: ['sensor_msgs/msg/LaserScan'], publishers: 1, subscribers: 2 },
      { name: '/cmd_vel', types: ['geometry_msgs/msg/Twist'], publishers: 0, subscribers: 1 },
    ],
    services: [{ name: '/map_server/load_map', types: ['nav2_msgs/srv/LoadMap'] }],
    actions: [{ name: '/navigate_to_pose', types: ['nav2_msgs/action/NavigateToPose'] }],
    nodes: [
      node('map_server', '/', { servers: [{ name: '/map_server/load_map', types: ['nav2_msgs/srv/LoadMap'] }] }),
      node('bt_navigator', '/robot1', {
        actionServers: [{ name: '/navigate_to_pose', types: ['nav2_msgs/action/NavigateToPose'] }],
        // Of a service nobody serves
        clients: [{ name: '/reset', types: ['std_srvs/srv/Empty'] }],
      }),
      node('rviz', '/', {
        actionClients: [{ name: '/navigate_to_pose', types: ['nav2_msgs/action/NavigateToPose'] }],
      }),
    ],
    self: '/tassello',
  });
  assert.deepEqual(
    graph.topics.map((t) => t.name),
    ['/cmd_vel', '/scan'],
  );
  assert.deepEqual(graph.services, [
    { name: '/map_server/load_map', types: ['nav2_msgs/srv/LoadMap'], servers: ['/map_server'], clients: [] },
    { name: '/reset', types: ['std_srvs/srv/Empty'], servers: [], clients: ['/robot1/bt_navigator'] },
  ]);
  assert.deepEqual(graph.actions, [
    {
      name: '/navigate_to_pose',
      types: ['nav2_msgs/action/NavigateToPose'],
      servers: ['/robot1/bt_navigator'],
      clients: ['/rviz'],
    },
  ]);
  assert.deepEqual(graph.nodes, ['/map_server', '/robot1/bt_navigator', '/rviz']);
  assert.equal(graph.self, '/tassello');
});

const INFINITE = { seconds: 9223372036n, nanoseconds: 854775807 };

test('QoS as rclnodejs reports it: named policies, infinite durations as null', () => {
  assert.deepEqual(
    qosProfile({
      depth: 0,
      history: 3,
      reliability: 2,
      durability: 1,
      lifespan: INFINITE,
      deadline: { seconds: 0n, nanoseconds: 100_000_000 },
      liveliness: 1,
      liveliness_lease_duration: { seconds: 0n, nanoseconds: 0 },
    }),
    {
      reliability: 'best_effort',
      durability: 'transient_local',
      history: 'unknown',
      depth: 0,
      deadline: 0.1,
      lifespan: null,
      liveliness: 'automatic',
      leaseDuration: null,
    },
  );
});

const endpoint = (qos: Partial<TopicEndpoint['qos']> = {}, type = 'nav_msgs/msg/OccupancyGrid'): TopicEndpoint => ({
  node: '/n',
  type,
  qos: {
    reliability: 'reliable',
    durability: 'volatile',
    history: 'unknown',
    depth: 0,
    deadline: null,
    lifespan: null,
    liveliness: 'automatic',
    leaseDuration: null,
    ...qos,
  },
});

test('QoS incompatibilities, as rmw tells them', () => {
  assert.equal(qosIncompatibility(endpoint(), endpoint()), null);
  // A reliable publisher serves best effort subscriptions, not the reverse
  assert.equal(qosIncompatibility(endpoint(), endpoint({ reliability: 'best_effort' })), null);
  assert.match(
    qosIncompatibility(endpoint({ reliability: 'best_effort' }), endpoint()) ?? '',
    /best effort, the subscription wants reliable/,
  );
  // A latched subscription (a map's) misses a volatile publisher
  assert.match(
    qosIncompatibility(endpoint(), endpoint({ durability: 'transient_local' })) ?? '',
    /volatile, the subscription wants transient local/,
  );
  assert.equal(qosIncompatibility(endpoint({ durability: 'transient_local' }), endpoint()), null);
  assert.match(qosIncompatibility(endpoint(), endpoint({ deadline: 0.5 })) ?? '', /deadline \(0.5 s\) is shorter/);
  assert.equal(qosIncompatibility(endpoint({ deadline: 0.1 }), endpoint({ deadline: 0.5 })), null);
  assert.match(qosIncompatibility(endpoint({}, 'a/msg/A'), endpoint({}, 'b/msg/B')) ?? '', /a\/msg\/A.*b\/msg\/B/);
  // Not reported: not judged
  assert.equal(qosIncompatibility(endpoint({ reliability: 'unknown' }), endpoint()), null);
});

test('the problems of a topic name its publisher and subscription', () => {
  const problems = qosProblems(
    [endpoint(), endpoint({ reliability: 'best_effort' })],
    [endpoint({ reliability: 'best_effort' }), endpoint()],
  );
  assert.deepEqual(
    problems.map(({ publisher, subscription }) => [publisher, subscription]),
    [[1, 1]],
  );
});
