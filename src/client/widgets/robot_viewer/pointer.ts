// Where the pointer is, for the displays that take pointer input: the point on
// the ground (z = 0 of the fixed frame) under it. The viewer's scene is
// three.js's y up; its world group turns ROS's z up into it (x stays, ROS y is
// three.js -z).

import { Vector3 } from 'three';

// The ground point, in the fixed frame with ROS's axes, that a ray (in the
// scene, y up) hits; null if it points away from the ground or along it
export function groundPoint(origin: Vector3, direction: Vector3): Vector3 | null {
  if (direction.y >= -1e-9) {
    return null;
  }
  const t = -origin.y / direction.y;
  if (t < 0) {
    return null;
  }
  const hit = origin.clone().addScaledVector(direction, t);
  return new Vector3(hit.x, -hit.z, 0);
}
