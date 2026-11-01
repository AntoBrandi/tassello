// How an interactive marker moves as its control is dragged, as RViz moves it
// (interactive_marker_control.cpp), in the marker's frame: along the
// control's axis (its x), in the plane across it, around it, or freely in 3D,
// after the ray from the camera through the pointer.

import { Plane, Quaternion, Ray, Sphere, Vector3 } from 'three';

import { InteractionMode, OrientationMode } from '../interactive_markers.ts';

export interface MarkerPose {
  position: Vector3;
  quaternion: Quaternion;
}

export interface DragStart {
  mode: number;
  // The marker's, as the drag starts
  pose: MarkerPose;
  // The control's axis: its frame's x (its orientation, in the marker's
  // orientation if inherited), unit
  axis: Vector3;
  // Where the control was pressed
  grab: Vector3;
  // Where the camera looks, unit: the plane of free moves faces it
  view: Vector3;
}

const X = new Vector3(1, 0, 0);
// Rays nearly along an axis, or nearly in a plane, move it too far
const MIN_ANGLE_COS = 0.02;

// A drag of a control: move() gives the marker's pose for each ray
export class MarkerDrag {
  private readonly start: DragStart;
  // Of the current part of the drag: moving and rotating (MOVE_ROTATE_3D)
  // switch as a modifier is held, from where the marker is
  private base: { pose: MarkerPose; grab: Vector3 };
  private pose: MarkerPose;
  private rotating = false;

  constructor(start: DragStart) {
    this.start = {
      ...start,
      pose: copy(start.pose),
      axis: start.axis.clone().normalize(),
      grab: start.grab.clone(),
      view: start.view.clone().normalize(),
    };
    this.base = { pose: copy(start.pose), grab: start.grab.clone() };
    this.pose = copy(start.pose);
  }

  get current(): MarkerPose {
    return copy(this.pose);
  }

  // The marker's pose for the ray (in its frame), null if the ray tells
  // nothing (along the axis, in the plane): it stays where it is. rotate:
  // a modifier is held (MOVE_ROTATE_3D rotates then).
  move(ray: Ray, rotate = false): MarkerPose | null {
    const { mode } = this.start;
    let pose: MarkerPose | null = null;
    switch (mode) {
      case InteractionMode.MOVE_AXIS:
        pose = this.moveAxis(ray);
        break;
      case InteractionMode.MOVE_PLANE:
        pose = this.movePlane(ray, this.start.axis);
        break;
      case InteractionMode.ROTATE_AXIS:
        pose = this.rotateAxis(ray);
        break;
      case InteractionMode.MOVE_ROTATE:
        pose = this.moveRotate(ray);
        break;
      case InteractionMode.MOVE_3D:
        pose = this.movePlane(ray, this.start.view);
        break;
      case InteractionMode.ROTATE_3D:
        pose = this.rotate3d(ray);
        break;
      case InteractionMode.MOVE_ROTATE_3D:
        if (rotate !== this.rotating) {
          this.rebase();
          this.rotating = rotate;
        }
        pose = rotate ? this.rotate3d(ray) : this.movePlane(ray, this.start.view);
        break;
      default:
        return null;
    }
    if (pose) {
      this.pose = pose;
    }
    return pose && copy(pose);
  }

  // The part of the drag from here: the grab point moved with the marker
  private rebase(): void {
    this.base = { pose: copy(this.pose), grab: this.grabNow() };
  }

  private grabNow(): Vector3 {
    const { pose, grab } = this.base;
    const turn = this.pose.quaternion.clone().multiply(pose.quaternion.clone().invert());
    return grab.clone().sub(pose.position).applyQuaternion(turn).add(this.pose.position);
  }

  // Along the axis through the grab point: its closest point to the ray
  private moveAxis(ray: Ray): MarkerPose | null {
    const { pose, grab } = this.base;
    const axis = this.start.axis;
    const b = axis.dot(ray.direction);
    const denominator = 1 - b * b;
    if (denominator < MIN_ANGLE_COS * MIN_ANGLE_COS) {
      return null;
    }
    const w = grab.clone().sub(ray.origin);
    const d = axis.dot(w);
    const e = ray.direction.dot(w);
    // Along the axis, and along the ray: in front of the camera
    const t = (b * e - d) / denominator;
    const s = (e - b * d) / denominator;
    if (s < 0) {
      return null;
    }
    return { position: pose.position.clone().addScaledVector(axis, t), quaternion: pose.quaternion.clone() };
  }

  // In the plane through the grab point across normal
  private movePlane(ray: Ray, normal: Vector3): MarkerPose | null {
    const { pose, grab } = this.base;
    const hit = intersect(ray, normal, grab);
    if (!hit) {
      return null;
    }
    return { position: pose.position.clone().add(hit.sub(grab)), quaternion: pose.quaternion.clone() };
  }

  // Around the axis through the marker: by the angle from the grab point to
  // where the ray meets the plane across it
  private rotateAxis(ray: Ray): MarkerPose | null {
    const { pose, grab } = this.base;
    const axis = this.start.axis;
    const hit = intersect(ray, axis, pose.position);
    if (!hit) {
      return null;
    }
    const from = inPlane(grab.clone().sub(pose.position), axis);
    const to = inPlane(hit.sub(pose.position), axis);
    if (from.lengthSq() < 1e-12 || to.lengthSq() < 1e-12) {
      return null;
    }
    const angle = Math.atan2(axis.dot(from.clone().cross(to)), from.dot(to));
    const turn = new Quaternion().setFromAxisAngle(axis, angle);
    return { position: pose.position.clone(), quaternion: turn.multiply(pose.quaternion) };
  }

  // Pulled by the grab point, as by a rope, in the plane across the axis:
  // turned to face where the ray meets it, moved for the grab point to be
  // there
  private moveRotate(ray: Ray): MarkerPose | null {
    const axis = this.start.axis;
    const current = this.pose;
    const grab = this.grabNow();
    const hit = intersect(ray, axis, current.position);
    if (!hit) {
      return null;
    }
    const from = inPlane(grab.clone().sub(current.position), axis);
    const to = inPlane(hit.clone().sub(current.position), axis);
    if (from.lengthSq() < 1e-12 || to.lengthSq() < 1e-12) {
      return null;
    }
    const angle = Math.atan2(axis.dot(from.clone().cross(to)), from.dot(to));
    const turn = new Quaternion().setFromAxisAngle(axis, angle);
    const position = current.position.clone().addScaledVector(to.clone().normalize(), to.length() - from.length());
    const quaternion = turn.multiply(current.quaternion.clone());
    // The grab point, where the ray meets the plane now
    this.base = { pose: { position: position.clone(), quaternion: quaternion.clone() }, grab: hit.clone() };
    return { position, quaternion };
  }

  // As a trackball: the grab point turned, about the marker, to where the ray
  // meets the sphere it is on (or the nearest point of the sphere to it)
  private rotate3d(ray: Ray): MarkerPose | null {
    const { pose, grab } = this.base;
    const center = pose.position;
    const from = grab.clone().sub(center);
    const radius = Math.max(from.length(), 1e-3);
    const sphere = new Sphere(center.clone(), radius);
    const hit = ray.intersectSphere(sphere, new Vector3()) ?? nearestOnSphere(ray, sphere);
    if (!hit || from.lengthSq() < 1e-12) {
      return null;
    }
    const to = hit.sub(center);
    const turn = new Quaternion().setFromUnitVectors(from.normalize(), to.normalize());
    return { position: center.clone(), quaternion: turn.multiply(pose.quaternion.clone()) };
  }
}

function copy(pose: MarkerPose): MarkerPose {
  return { position: pose.position.clone(), quaternion: pose.quaternion.clone() };
}

// Where the ray meets the plane through point across normal, in front of the
// camera; null if (nearly) along it
function intersect(ray: Ray, normal: Vector3, point: Vector3): Vector3 | null {
  if (Math.abs(ray.direction.dot(normal)) < MIN_ANGLE_COS) {
    return null;
  }
  return ray.intersectPlane(new Plane().setFromNormalAndCoplanarPoint(normal, point), new Vector3());
}

function inPlane(vector: Vector3, normal: Vector3): Vector3 {
  return vector.addScaledVector(normal, -vector.dot(normal));
}

function nearestOnSphere(ray: Ray, sphere: Sphere): Vector3 | null {
  const closest = ray.closestPointToPoint(sphere.center, new Vector3());
  const offset = closest.sub(sphere.center);
  if (offset.lengthSq() < 1e-12) {
    return null;
  }
  return offset.setLength(sphere.radius).add(sphere.center);
}

// The control's frame, as RViz turns it, in the axes of the marker's frame:
// the marker's orientation (INHERIT), none (FIXED: the frame's own axes), or
// facing the view (VIEW_FACING: the control's x where the camera looks, its z
// the view's up). Its markers are in it; its axis is controlAxis.
export function controlFrame(
  orientationMode: number,
  markerOrientation: Quaternion,
  controlOrientation: Quaternion,
  view: { direction: Vector3; up: Vector3 },
): Quaternion {
  if (orientationMode === OrientationMode.VIEW_FACING) {
    return viewFacing(controlOrientation, view.direction, view.up);
  }
  return orientationMode === OrientationMode.FIXED ? new Quaternion() : markerOrientation.clone();
}

// The x of the control's orientation, in its frame: what it moves along,
// rotates around, or moves across
export function controlAxis(frame: Quaternion, controlOrientation: Quaternion): Vector3 {
  return X.clone().applyQuaternion(frame.clone().multiply(controlOrientation)).normalize();
}

// The rotation that turns the control's x to where the camera looks, and its
// z to the view's up (as near as it can), as RViz's view facing controls
export function viewFacing(controlOrientation: Quaternion, direction: Vector3, up: Vector3): Quaternion {
  const forward = direction.clone().normalize();
  const x = X.clone().applyQuaternion(controlOrientation);
  const toView = new Quaternion().setFromUnitVectors(x, forward);
  const z = new Vector3(0, 0, 1).applyQuaternion(controlOrientation).applyQuaternion(toView);
  const upAcross = inPlane(up.clone(), forward);
  const zAcross = inPlane(z, forward);
  if (upAcross.lengthSq() < 1e-12 || zAcross.lengthSq() < 1e-12) {
    return toView;
  }
  upAcross.normalize();
  zAcross.normalize();
  const angle = Math.atan2(forward.dot(zAcross.clone().cross(upAcross)), zAcross.dot(upAcross));
  return new Quaternion().setFromAxisAngle(forward, angle).multiply(toView);
}
