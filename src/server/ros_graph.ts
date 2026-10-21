// The ROS graph for the monitor widgets, as ros2 topic, service and action
// list and info show it: its topics with their publishers and subscribers,
// its services and actions with the nodes serving and using them, and the
// endpoints of a topic with their QoS. Polled every GRAPH_PERIOD_MS while a
// page watches, sent again whenever it changes.
//
// Which nodes serve and use services and actions is asked node by node, as
// ros2 action info does: the middleware tells nothing more on Humble.

import rclnodejs from 'rclnodejs';

import { GRAPH_PERIOD_MS, type GraphSnapshot, type TopicDetails } from '../shared/monitor.ts';
import {
  graphSnapshot,
  nodeFullName,
  qosProblems,
  sortEndpoints,
  topicEndpoint,
  type GraphNode,
  type NamesAndTypes,
  type RawEndpoint,
} from './ros_graph_format.ts';
import { absoluteTopic, errorMessage, type Logger } from './util.ts';

type GraphWatcher = (graph: GraphSnapshot) => void;

interface TopicWatcher {
  topic: string;
  onDetails: (details: TopicDetails) => void;
  // Of the details last sent, to send them again only when they change
  last: string;
}

export class RosGraph {
  private readonly node: rclnodejs.Node;
  private readonly logger: Logger;
  private readonly watchers = new Map<GraphWatcher, string>();
  private readonly topicWatchers = new Set<TopicWatcher>();
  private timer: NodeJS.Timeout | null = null;
  private latest: { graph: GraphSnapshot; json: string } | null = null;
  private lastError = '';

  constructor(node: rclnodejs.Node, logger: Logger) {
    this.node = node;
    this.logger = logger;
  }

  // The graph now, then whenever it changes, until the returned function is
  // called
  watch(onGraph: GraphWatcher): () => void {
    // Polled for others: as of the last poll; else read now
    const latest = (this.watchers.size > 0 && this.latest) || this.read();
    this.watchers.set(onGraph, latest?.json ?? '');
    if (latest) {
      onGraph(latest.graph);
    }
    this.start();
    return () => {
      this.watchers.delete(onGraph);
      this.stopIfUnwatched();
    };
  }

  // A topic's endpoints (ros2 topic info --verbose), now, then whenever they
  // change
  watchTopic(topic: string, onDetails: (details: TopicDetails) => void): () => void {
    const watcher: TopicWatcher = { topic: absoluteTopic(topic), onDetails, last: '' };
    this.topicWatchers.add(watcher);
    this.sendTopic(watcher);
    this.start();
    return () => {
      this.topicWatchers.delete(watcher);
      this.stopIfUnwatched();
    };
  }

  // The graph now, if it can be read
  snapshot(): GraphSnapshot | null {
    return (this.latest ?? this.read())?.graph ?? null;
  }

  private start(): void {
    this.timer ??= setInterval(() => this.poll(), GRAPH_PERIOD_MS);
  }

  private stopIfUnwatched(): void {
    if (this.watchers.size === 0 && this.topicWatchers.size === 0 && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      this.latest = null;
    }
  }

  private poll(): void {
    if (this.watchers.size > 0) {
      const latest = this.read();
      if (latest) {
        for (const [watcher, sent] of this.watchers) {
          if (sent !== latest.json) {
            this.watchers.set(watcher, latest.json);
            watcher(latest.graph);
          }
        }
      }
    }
    for (const watcher of this.topicWatchers) {
      this.sendTopic(watcher);
    }
  }

  private read(): { graph: GraphSnapshot; json: string } | null {
    try {
      const graph = graphSnapshot({
        topics: this.node.getTopicNamesAndTypes().map(({ name, types }) => ({
          name,
          types,
          publishers: this.node.countPublishers(name),
          subscribers: this.node.countSubscribers(name),
        })),
        services: this.node.getServiceNamesAndTypes(),
        actions: rclnodejs.getActionNamesAndTypes(this.node) as unknown as NamesAndTypes[],
        nodes: this.nodes(),
        self: nodeFullName(this.node.name(), this.node.namespace()),
      });
      this.latest = { graph, json: JSON.stringify(graph) };
      this.lastError = '';
      return this.latest;
    } catch (e) {
      this.warnOnce(`Cannot read the ROS graph: ${errorMessage(e)}`);
      return null;
    }
  }

  private nodes(): GraphNode[] {
    const nodes: GraphNode[] = [];
    for (const { name, namespace } of this.node.getNodeNamesAndNamespaces()) {
      // Gone since listed, or of a middleware that cannot tell: left out
      try {
        nodes.push({
          name,
          namespace,
          servers: this.node.getServiceNamesAndTypesByNode(name, namespace),
          clients: this.node.getClientNamesAndTypesByNode(name, namespace),
          actionServers: rclnodejs.getActionServerNamesAndTypesByNode(this.node, name, namespace) as unknown as NamesAndTypes[],
          actionClients: rclnodejs.getActionClientNamesAndTypesByNode(this.node, name, namespace) as unknown as NamesAndTypes[],
        });
      } catch {
        nodes.push({ name, namespace, servers: [], clients: [], actionServers: [], actionClients: [] });
      }
    }
    return nodes;
  }

  private sendTopic(watcher: TopicWatcher): void {
    let details: TopicDetails;
    try {
      const publishers = sortEndpoints(
        (this.node.getPublishersInfoByTopic(watcher.topic, false) as RawEndpoint[]).map(topicEndpoint),
      );
      const subscriptions = sortEndpoints(
        (this.node.getSubscriptionsInfoByTopic(watcher.topic, false) as RawEndpoint[]).map(topicEndpoint),
      );
      details = { topic: watcher.topic, publishers, subscriptions, problems: qosProblems(publishers, subscriptions) };
    } catch (e) {
      this.warnOnce(`Cannot read the endpoints of ${watcher.topic}: ${errorMessage(e)}`);
      return;
    }
    const json = JSON.stringify(details);
    if (json !== watcher.last) {
      watcher.last = json;
      watcher.onDetails(details);
    }
  }

  private warnOnce(message: string): void {
    if (message !== this.lastError) {
      this.lastError = message;
      this.logger.warn(message);
    }
  }
}
