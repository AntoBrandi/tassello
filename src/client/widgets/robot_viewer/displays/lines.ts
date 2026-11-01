// Lines as the Robot Viewer draws them: a path, a polygon, a camera's
// frustum, or a plugin's, a width in pixels whatever the zoom (WebGL's own
// lines are always 1 pixel wide), or in meters, of one colour or of a colour
// per segment's end.

import { SRGBColorSpace } from 'three';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';

import { parseColor } from '../model.ts';

export interface LinesStyle {
  // '#rrggbb', unless the segments have colours of their own
  color: string;
  // In CSS pixels, or in meters if worldUnits (e.g. a marker's lines)
  width: number;
  // 0-1
  opacity: number;
  // Drawn over everything, e.g. a frustum inside the robot
  overlay?: boolean;
  worldUnits?: boolean;
}

export class LinesLayer {
  // Put it in a display's root, or in a group placed in a frame
  readonly object: LineSegments2;
  private readonly material = new LineMaterial({ linewidth: 2, transparent: true, depthWrite: false });
  private geometry = new LineSegmentsGeometry();
  private color: [number, number, number] = [1, 1, 1];

  constructor(style?: LinesStyle) {
    this.object = new LineSegments2(this.geometry, this.material);
    this.object.visible = false;
    if (style) {
      this.setStyle(style);
    }
  }

  setStyle({ color, width, opacity, overlay = false, worldUnits = false }: LinesStyle): void {
    this.color = parseColor(color);
    this.applyColor();
    this.material.worldUnits = worldUnits;
    this.material.linewidth = width;
    this.material.opacity = opacity;
    this.material.depthTest = !overlay;
    this.object.renderOrder = overlay ? 9 : 0;
  }

  // x, y, z of each segment's start, then of its end; colours: r, g, b
  // (0-1, linear) of each end, else the style's colour. Hidden if none.
  setSegments(segments: ArrayLike<number>, colors: ArrayLike<number> | null = null): void {
    // The former segments' buffers freed now, not when collected; a geometry
    // anew, as the instanced attributes have a size of their own
    this.geometry.dispose();
    this.geometry = new LineSegmentsGeometry();
    this.object.geometry = this.geometry;
    const vertexColors = colors !== null;
    if (this.material.vertexColors !== vertexColors) {
      this.material.vertexColors = vertexColors;
      this.material.needsUpdate = true;
      this.applyColor();
    }
    if (segments.length < 6) {
      this.object.visible = false;
      return;
    }
    this.geometry.setPositions(Float32Array.from(segments));
    if (colors) {
      this.geometry.setColors(Float32Array.from(colors));
    }
    this.object.visible = true;
  }

  // The segments' own colours are multiplied by the material's: white then
  private applyColor(): void {
    if (this.material.vertexColors) {
      this.material.color.setRGB(1, 1, 1);
    } else {
      this.material.color.setRGB(...this.color, SRGBColorSpace);
    }
  }

  // Through points (x, y, z each), back to the first if closed
  setPolyline(points: ArrayLike<number>, closed = false): void {
    const count = Math.floor(points.length / 3);
    const ends = closed && count > 2 ? count : count - 1;
    const segments = new Float32Array(Math.max(0, ends) * 6);
    for (let i = 0; i < ends; i++) {
      const j = (i + 1) % count;
      segments.set([points[i * 3], points[i * 3 + 1], points[i * 3 + 2], points[j * 3], points[j * 3 + 1], points[j * 3 + 2]], i * 6);
    }
    this.setSegments(segments);
  }
}
