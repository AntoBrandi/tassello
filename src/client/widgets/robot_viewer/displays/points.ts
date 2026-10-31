// Points as the Robot Viewer draws them: a laser scan's, a point cloud's, or
// a plugin's, squares of a size in pixels, of one colour or coloured by their
// own colours, intensities (RViz's rainbow) or heights in the fixed frame.

import { BufferAttribute, BufferGeometry, Points, PointsMaterial, SRGBColorSpace } from 'three';

import type { PointsFrame } from '../../../connection.ts';
import { parseColor, rainbow } from '../model.ts';

export type PointsColoring = 'auto' | 'flat' | 'rgb' | 'intensity' | 'height';

export interface PointsStyle {
  // 'auto': their colours if they have them, else their intensities, else
  // their heights
  coloring: PointsColoring;
  // '#rrggbb', of 'flat'
  color: string;
  // In CSS pixels
  size: number;
}

// sRGB to the linear values three.js renders from
function toLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

const LINEAR = Float32Array.from({ length: 256 }, (_, i) => toLinear(i / 255));

export class PointsLayer {
  // Put it in a display's root: it is placed where the frame's points are
  readonly object: Points;
  private readonly geometry = new BufferGeometry();
  private readonly material = new PointsMaterial({ sizeAttenuation: false });
  private style: PointsStyle = { coloring: 'flat', color: '#ffffff', size: 2 };
  private frame: PointsFrame | null = null;

  constructor() {
    this.object = new Points(this.geometry, this.material);
    this.object.visible = false;
  }

  // pixelRatio: the context's, points being sized in device pixels
  setStyle(style: PointsStyle, pixelRatio: number): void {
    this.style = style;
    this.material.size = style.size * pixelRatio;
    this.recolor();
  }

  // Hidden without a frame, or one not placed (its info's error)
  setFrame(frame: PointsFrame | null): void {
    this.frame = frame;
    const pose = frame?.info.pose;
    if (!frame || !pose || frame.info.count === 0) {
      this.object.visible = false;
      return;
    }
    this.object.position.set(pose[0], pose[1], pose[2]);
    this.object.quaternion.set(pose[3], pose[4], pose[5], pose[6]).normalize();
    // The former frame's buffers freed now, not when collected: a frame or
    // more a second
    this.geometry.dispose();
    this.geometry.setAttribute('position', new BufferAttribute(frame.positions, 3));
    this.geometry.computeBoundingSphere();
    this.recolor();
    this.object.visible = true;
  }

  // How the points are coloured: as asked, if they have what it needs
  coloring(): Exclude<PointsColoring, 'auto'> {
    const { coloring } = this.style;
    const frame = this.frame;
    if (coloring === 'auto') {
      return frame?.colors ? 'rgb' : frame?.values ? 'intensity' : 'height';
    }
    if ((coloring === 'rgb' && !frame?.colors) || (coloring === 'intensity' && !frame?.values)) {
      return 'flat';
    }
    return coloring;
  }

  private recolor(): void {
    const frame = this.frame;
    const mode = frame ? this.coloring() : 'flat';
    const vertexColors = mode !== 'flat';
    if (this.material.vertexColors !== vertexColors) {
      this.material.vertexColors = vertexColors;
      this.material.needsUpdate = true;
    }
    if (!vertexColors || !frame) {
      this.material.color.setRGB(...parseColor(this.style.color), SRGBColorSpace);
      this.geometry.deleteAttribute('color');
      return;
    }
    this.material.color.setRGB(1, 1, 1);
    const count = frame.info.count;
    const colors = new Float32Array(count * 3);
    const rgb: [number, number, number] = [0, 0, 0];
    const paint = (i: number, value: number) => {
      rainbow(value, rgb);
      colors[i * 3] = toLinear(rgb[0]);
      colors[i * 3 + 1] = toLinear(rgb[1]);
      colors[i * 3 + 2] = toLinear(rgb[2]);
    };
    if (mode === 'rgb') {
      for (let i = 0; i < count * 3; i++) {
        colors[i] = LINEAR[frame.colors![i]];
      }
    } else if (mode === 'intensity') {
      for (let i = 0; i < count; i++) {
        paint(i, frame.values![i]);
      }
    } else {
      // Heights in the fixed frame: the third row of the frame's rotation
      const [, , tz, x, y, z, w] = frame.info.pose!;
      const m20 = 2 * (x * z - w * y);
      const m21 = 2 * (y * z + w * x);
      const m22 = 1 - 2 * (x * x + y * y);
      const heights = new Float32Array(count);
      let low = Infinity;
      let high = -Infinity;
      for (let i = 0; i < count; i++) {
        const p = frame.positions;
        const h = m20 * p[i * 3] + m21 * p[i * 3 + 1] + m22 * p[i * 3 + 2] + tz;
        heights[i] = h;
        low = Math.min(low, h);
        high = Math.max(high, h);
      }
      const span = high - low;
      for (let i = 0; i < count; i++) {
        paint(i, span > 0 ? (heights[i] - low) / span : 0);
      }
    }
    this.geometry.setAttribute('color', new BufferAttribute(colors, 3));
  }
}
