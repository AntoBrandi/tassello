// Subscribing with the QoS of a topic's publishers, as RViz does: latched
// topics (transient local, e.g. maps) are only received by transient local
// subscriptions, which volatile publishers do not match; reliable
// subscriptions do not match best effort publishers.

import rclnodejs from 'rclnodejs';

const { HistoryPolicy, ReliabilityPolicy, DurabilityPolicy } = rclnodejs.QoS;

interface PublisherInfo {
  topic_type: string;
  qos_profile: { reliability: number; durability: number };
}

// The QoS matching every publisher of the topic, and its type, or why there
// is none: no publisher yet, or one of another type than expected (type null:
// any, as long as the publishers agree)
export function publishersQos(
  node: rclnodejs.Node,
  topic: string,
  type: string | null,
  depth: number,
): { qos: rclnodejs.QoS; type: string } | { state: 'waiting' | 'error'; message: string } {
  const publishers = node.getPublishersInfoByTopic(topic, false) as PublisherInfo[];
  if (publishers.length === 0) {
    return { state: 'waiting', message: `Waiting for ${topic} to be published` };
  }
  const types = [...new Set(publishers.map((p) => p.topic_type))];
  if (type === null && types.length > 1) {
    return { state: 'error', message: `${topic} is published with several types: ${types.join(', ')}` };
  }
  if (type !== null && !types.includes(type)) {
    return { state: 'error', message: `${topic} is a ${types.join(', ')}, not a ${type}` };
  }
  const latched = publishers.every(
    (p) => p.qos_profile.durability === DurabilityPolicy.RMW_QOS_POLICY_DURABILITY_TRANSIENT_LOCAL,
  );
  const reliable = publishers.every(
    (p) => p.qos_profile.reliability === ReliabilityPolicy.RMW_QOS_POLICY_RELIABILITY_RELIABLE,
  );
  return {
    type: type ?? types[0],
    qos: new rclnodejs.QoS(
      HistoryPolicy.RMW_QOS_POLICY_HISTORY_KEEP_LAST,
      depth,
      reliable
        ? ReliabilityPolicy.RMW_QOS_POLICY_RELIABILITY_RELIABLE
        : ReliabilityPolicy.RMW_QOS_POLICY_RELIABILITY_BEST_EFFORT,
      latched
        ? DurabilityPolicy.RMW_QOS_POLICY_DURABILITY_TRANSIENT_LOCAL
        : DurabilityPolicy.RMW_QOS_POLICY_DURABILITY_VOLATILE,
    ),
  };
}
