// Publishes the poses the navigation widgets set: goals (geometry_msgs/
// PoseStamped, as RViz's Nav2 Goal) and pose estimates (geometry_msgs/
// PoseWithCovarianceStamped, as RViz's 2D Pose Estimate).

import type rclnodejs from 'rclnodejs';

import type { PosePublish } from '../shared/protocol.ts';

const POSE = 'geometry_msgs/msg/PoseStamped';
const POSE_WITH_COVARIANCE = 'geometry_msgs/msg/PoseWithCovarianceStamped';

// RViz's: 0.5 m in x and y, about 15° in yaw (standard deviations)
const COVARIANCE = Array.from({ length: 36 }, (_, i) =>
  i === 0 || i === 7 ? 0.25 : i === 35 ? 0.06853891945200942 : 0,
);

export class Poses {
  private readonly node: rclnodejs.Node;
  private readonly publishers = new Map<string, rclnodejs.Publisher<typeof POSE | typeof POSE_WITH_COVARIANCE>>();

  constructor(node: rclnodejs.Node) {
    this.node = node;
  }

  publish(request: PosePublish): void {
    const type = request.covariance ? POSE_WITH_COVARIANCE : POSE;
    const key = `${type} ${request.topic}`;
    let publisher = this.publishers.get(key);
    if (!publisher) {
      publisher = this.node.createPublisher(type, request.topic);
      this.publishers.set(key, publisher);
    }
    const header = { stamp: this.node.getClock().now().toMsg(), frame_id: request.frameId };
    const pose = {
      position: { x: request.x, y: request.y, z: 0 },
      orientation: { x: 0, y: 0, z: Math.sin(request.yaw / 2), w: Math.cos(request.yaw / 2) },
    };
    publisher.publish(
      request.covariance ? { header, pose: { pose, covariance: COVARIANCE } } : { header, pose },
    );
  }
}
