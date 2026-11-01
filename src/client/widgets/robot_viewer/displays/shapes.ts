// Solid arrows and axes, as RViz draws a pose: a shaft and a head along +x
// from the origin; three cylinders from it along x, y and z, red, green and
// blue. For the Pose display, and the markers' arrows.

import { Color, ConeGeometry, CylinderGeometry, Group, Mesh, MeshLambertMaterial, SRGBColorSpace, type Material } from 'three';

export interface ArrowSize {
  shaftLength: number;
  shaftRadius: number;
  headLength: number;
  headRadius: number;
}

// Along +x, from the origin to its tip
export function arrowObject({ shaftLength, shaftRadius, headLength, headRadius }: ArrowSize, material: Material): Group {
  const arrow = new Group();
  if (shaftLength > 0 && shaftRadius > 0) {
    // Built along +y, then turned to +x
    const shaft = new CylinderGeometry(shaftRadius, shaftRadius, shaftLength, 20);
    shaft.translate(0, shaftLength / 2, 0);
    shaft.rotateZ(-Math.PI / 2);
    arrow.add(new Mesh(shaft, material));
  }
  if (headLength > 0 && headRadius > 0) {
    const head = new ConeGeometry(headRadius, headLength, 24);
    head.translate(0, Math.max(0, shaftLength) + headLength / 2, 0);
    head.rotateZ(-Math.PI / 2);
    arrow.add(new Mesh(head, material));
  }
  return arrow;
}

const AXES: [number, number, number][] = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
];

// x red, y green, z blue, each length long: their materials their own
export function axesObject(length: number, radius: number, opacity = 1): Group {
  const axes = new Group();
  AXES.forEach((rgb, i) => {
    const geometry = new CylinderGeometry(radius, radius, length, 16);
    geometry.translate(0, length / 2, 0);
    if (i === 0) {
      geometry.rotateZ(-Math.PI / 2);
    } else if (i === 2) {
      geometry.rotateX(Math.PI / 2);
    }
    const material = new MeshLambertMaterial({ color: new Color().setRGB(...rgb, SRGBColorSpace) });
    setOpacity(material, opacity);
    axes.add(new Mesh(geometry, material));
  });
  return axes;
}

// Transparent below 1, not hiding what is behind it then
export function setOpacity(material: Material, opacity: number): void {
  const alpha = Math.min(1, Math.max(0, opacity));
  material.opacity = alpha;
  material.transparent = alpha < 1;
  material.depthWrite = alpha >= 1;
}
