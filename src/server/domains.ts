// The ROS domains the server reaches (ROS_DOMAIN_ID): its own, where it
// started, and those its panels ask for (src/shared/panel.ts domainId). Each
// is a ROS node of the server's name in a context of that domain, with the
// ROS side of the widgets on it (RosServices): a page connects on its panel's
// domain and reaches only that one's.
//
// A domain is made when a page first connects on it and kept until the server
// stops: its node is a DDS participant, its services keep what they learned
// (TF, logs, diagnostics), and widgets may come back to it.

import rclnodejs from 'rclnodejs';

import { Actions } from './actions.ts';
import { Arm } from './arm.ts';
import { BehaviorTrees } from './behavior_trees.ts';
import { Diagnostics } from './diagnostics.ts';
import { Interfaces } from './interfaces.ts';
import { Overlays } from './overlays.ts';
import { Parameters } from './parameters.ts';
import { Paths } from './paths.ts';
import { Poses } from './poses.ts';
import { Ros } from './ros.ts';
import { RosGraph } from './ros_graph.ts';
import { Rosbags } from './rosbags.ts';
import { Rosout } from './rosout.ts';
import { FrameStreams } from './streams.ts';
import { Teleop } from './teleop.ts';
import { Tf } from './tf.ts';
import { TopicMonitors } from './topic_monitor.ts';
import { TopicPublishing } from './topic_publishing.ts';
import { Topics } from './topics.ts';
import { TwistMuxes } from './twist_mux.ts';
import { errorMessage, type Logger } from './util.ts';

// What the widgets reach of ROS, on one domain
export interface RosServices {
  teleop: Teleop;
  streams: FrameStreams;
  tf: Tf;
  paths: Paths;
  overlays: Overlays;
  topics: Topics;
  poses: Poses;
  arm: Arm;
  ros: Ros;
  rosout: Rosout;
  diagnostics: Diagnostics;
  twistMuxes: TwistMuxes;
  behaviorTrees: BehaviorTrees;
  graph: RosGraph;
  topicMonitors: TopicMonitors;
  publishing: TopicPublishing;
  interfaces: Interfaces;
  actions: Actions;
  parameters: Parameters;
  rosbags: Rosbags;
}

export interface RosDomain {
  id: number;
  node: rclnodejs.Node;
  services: RosServices;
  // For the programs run for it (ros2 bag, a terminal, a button's command):
  // ROS_DOMAIN_ID, unless it is the server's own, which they inherit
  env: Record<string, string>;
}

// env: what the domain's programs are run with, over the server's
function createServices(node: rclnodejs.Node, logger: Logger, uploadsDir: string, env: Record<string, string>): RosServices {
  const tf = new Tf(node, logger);
  const topics = new Topics(node, logger);
  const interfaces = new Interfaces(node);
  const ros = new Ros(node, interfaces);
  const actions = new Actions(node, interfaces, logger);
  const parameters = new Parameters(node, logger);
  const diagnostics = new Diagnostics(node, logger);
  const rosbags = new Rosbags(ros, logger, env);
  return {
    teleop: new Teleop(node, logger),
    tf,
    streams: new FrameStreams(node, logger, tf),
    paths: new Paths(node, logger),
    overlays: new Overlays(node, logger, tf),
    topics,
    poses: new Poses(node),
    arm: new Arm(node, topics, logger),
    interfaces,
    ros,
    graph: new RosGraph(node, logger),
    topicMonitors: new TopicMonitors(node, logger, interfaces),
    publishing: new TopicPublishing(node, interfaces),
    actions,
    parameters,
    rosout: new Rosout(node, logger),
    diagnostics,
    twistMuxes: new TwistMuxes(node, logger, parameters, diagnostics, actions),
    rosbags,
    behaviorTrees: new BehaviorTrees(node, logger, uploadsDir, rosbags),
  };
}

// The domain of a context: rclnodejs types it as a method, it is a getter
export function contextDomainId(node: rclnodejs.Node): number {
  return Number((node.context as unknown as { domainId: bigint }).domainId);
}

export class RosDomains {
  // The server's own: its node's, ROS_DOMAIN_ID of its environment (0 if none)
  readonly serverDomain: RosDomain;
  private readonly nodeName: string;
  private readonly logger: Logger;
  private readonly uploadsDir: string;
  // The others, by id, once asked for: each made once, however many ask
  private readonly others = new Map<number, Promise<RosDomain>>();
  private readonly made = new Map<number, RosDomain>();

  // node: the server's own, already made (and spinning, or about to)
  constructor(node: rclnodejs.Node, logger: Logger, uploadsDir: string) {
    this.nodeName = node.name();
    this.logger = logger;
    this.uploadsDir = uploadsDir;
    this.serverDomain = { id: contextDomainId(node), node, services: createServices(node, logger, uploadsDir, {}), env: {} };
  }

  get serverDomainId(): number {
    return this.serverDomain.id;
  }

  // The domain, made the first time; null: the server's own
  get(id: number | null): Promise<RosDomain> {
    if (id === null || id === this.serverDomain.id) {
      return Promise.resolve(this.serverDomain);
    }
    let domain = this.others.get(id);
    if (!domain) {
      domain = this.make(id);
      this.others.set(id, domain);
      // Asked again, it is tried again
      domain.catch(() => this.others.delete(id));
    }
    return domain;
  }

  // A domain already made, by id; the server's own if it is not
  madeDomain(id: number): RosDomain {
    return this.made.get(id) ?? this.serverDomain;
  }

  all(): RosDomain[] {
    return [this.serverDomain, ...this.made.values()];
  }

  // The server is stopping: the nodes of the other domains destroyed and
  // their contexts shut down (the server's own is the server's to)
  destroyOthers(): void {
    for (const domain of this.made.values()) {
      const { context } = domain.node;
      try {
        domain.node.destroy();
        rclnodejs.shutdown(context);
      } catch (e) {
        this.logger.warn(`ROS domain ${domain.id}: ${errorMessage(e)}`);
      }
    }
    this.made.clear();
  }

  private async make(id: number): Promise<RosDomain> {
    const context = new rclnodejs.Context(BigInt(id));
    await rclnodejs.init(context);
    let node: rclnodejs.Node;
    try {
      node = new rclnodejs.Node(this.nodeName, '', context);
    } catch (e) {
      rclnodejs.shutdown(context);
      throw e;
    }
    const env = { ROS_DOMAIN_ID: String(id) };
    const domain: RosDomain = { id, node, services: createServices(node, this.logger, this.uploadsDir, env), env };
    node.spin();
    this.made.set(id, domain);
    this.logger.info(`ROS domain ${id}: node ${node.getFullyQualifiedName()} started`);
    return domain;
  }
}
