// visualization_msgs/Marker as three.js objects, as RViz draws them: arrows,
// cubes, spheres and cylinders, their lists, lines of a width in meters,
// points (as small squares), text facing the view, meshes from the robot's
// packages, triangles. What the Interactive Markers display's controls are
// made of.

import {
  BoxGeometry,
  BufferGeometry,
  CanvasTexture,
  Color,
  DoubleSide,
  Float32BufferAttribute,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshLambertMaterial,
  Quaternion,
  SphereGeometry,
  CylinderGeometry,
  Sprite,
  SpriteMaterial,
  SRGBColorSpace,
  Vector3,
  type Material,
  type Object3D,
} from 'three';

import { MarkerType, type ColorMsg, type MarkerMsg } from '../interactive_markers.ts';
import { LinesLayer } from './lines.ts';
import { toLinear } from './points.ts';
import { arrowObject, setOpacity } from './shapes.ts';

export interface MarkerObject {
  // At the marker's pose, in its frame
  readonly object: Object3D;
  // Its surfaces brighter: 0 as they are, e.g. 0.3 hovered, 0.5 dragged
  highlight(amount: number): void;
  // Frees what it made (not the meshes' geometries, which are shared)
  dispose(): void;
}

export interface MarkerResources {
  // A mesh resource's object, to clone, its geometries shared and kept
  mesh(url: string): Promise<Object3D>;
  // A mesh came (error: could not be loaded): draw again
  loaded(url: string, error?: unknown): void;
}

// The material the meshes are loaded with: the marker's colour stands for it
export const PLACEHOLDER = 'markerPlaceholder';

const X = new Vector3(1, 0, 0);
// Of a pose's arrow (scale 1): its shaft is 0.77 of its length, the head the rest
const UNIT_ARROW = { shaftLength: 0.77, shaftRadius: 0.25, headLength: 0.23, headRadius: 0.5 };
// A text's capital letters, of a font this many pixels high, drawn this high
const FONT_PX = 64;
const CAP_HEIGHT = 0.72;

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0));
}

function srgb(color: ColorMsg): Color {
  return new Color().setRGB(clamp01(color.r), clamp01(color.g), clamp01(color.b), SRGBColorSpace);
}

function hex(color: ColorMsg): string {
  return `#${[color.r, color.g, color.b].map((v) => Math.round(clamp01(v) * 255).toString(16).padStart(2, '0')).join('')}`;
}

function meanAlpha(colors: ColorMsg[]): number {
  return colors.length === 0 ? 1 : colors.reduce((sum, c) => sum + clamp01(c.a), 0) / colors.length;
}

// Throws nothing: a marker of a type not drawn (ARROW_STRIP, or later ones)
// is null
export function markerObject(marker: MarkerMsg, resources: MarkerResources): MarkerObject | null {
  const owned: { dispose(): void }[] = [];
  const lit: { material: Material & { emissive: Color }; base: Color }[] = [];
  let disposed = false;

  const surface = (color: ColorMsg, options: { doubleSide?: boolean; vertexColors?: boolean; alpha?: number } = {}) => {
    const material = new MeshLambertMaterial({
      color: options.vertexColors ? new Color(1, 1, 1) : srgb(color),
      vertexColors: options.vertexColors === true,
      side: options.doubleSide ? DoubleSide : undefined,
    });
    setOpacity(material, options.alpha ?? color.a);
    own(material);
    return material;
  };
  const own = <T extends { dispose(): void }>(resource: T): T => {
    owned.push(resource);
    if ((resource as unknown as { emissive?: unknown }).emissive instanceof Color) {
      const material = resource as unknown as Material & { emissive: Color };
      lit.push({ material, base: material.emissive.clone() });
    }
    return resource;
  };

  const object = new Group();
  const { position: p, orientation: q } = marker.pose;
  object.position.set(p.x, p.y, p.z);
  object.quaternion.set(q.x, q.y, q.z, q.w).normalize();
  const { scale } = marker;

  let content: Object3D | null;
  switch (marker.type) {
    case MarkerType.ARROW:
      content = arrow(marker, surface(marker.color), own);
      break;
    case MarkerType.CUBE:
    case MarkerType.SPHERE:
    case MarkerType.CYLINDER: {
      const mesh = new Mesh(own(shapeGeometry(marker.type)), surface(marker.color));
      mesh.scale.set(scale.x, scale.y, scale.z);
      content = mesh;
      break;
    }
    case MarkerType.CUBE_LIST:
    case MarkerType.SPHERE_LIST:
    case MarkerType.POINTS: {
      const size =
        marker.type === MarkerType.POINTS
          ? new Vector3(scale.x, scale.y, Math.min(scale.x, scale.y))
          : new Vector3(scale.x, scale.y, scale.z);
      const geometry = own(shapeGeometry(marker.type === MarkerType.SPHERE_LIST ? MarkerType.SPHERE : MarkerType.CUBE));
      content = list(marker, geometry, size, surface, own);
      break;
    }
    case MarkerType.LINE_STRIP:
    case MarkerType.LINE_LIST:
      content = lines(marker, marker.type === MarkerType.LINE_STRIP, own);
      break;
    case MarkerType.TEXT_VIEW_FACING:
      content = text(marker, own);
      break;
    case MarkerType.TRIANGLE_LIST:
      content = triangles(marker, surface, own);
      break;
    case MarkerType.MESH_RESOURCE: {
      const holder = new Group();
      holder.scale.set(scale.x, scale.y, scale.z);
      const url = marker.mesh_resource;
      const material = surface(marker.color);
      const { r, g, b, a } = marker.color;
      const tint = r !== 0 || g !== 0 || b !== 0 || a !== 0;
      resources.mesh(url).then(
        (source) => {
          if (disposed) {
            return;
          }
          const mesh = source.clone(true);
          mesh.traverse((child) => {
            if (!(child instanceof Mesh)) {
              return;
            }
            child.userData.sharedGeometry = true;
            const materials = Array.isArray(child.material) ? child.material : [child.material];
            const replaced = materials.map((m: Material) => {
              if (!marker.mesh_use_embedded_materials || m.userData[PLACEHOLDER]) {
                return material;
              }
              // Its own colours, tinted by the marker's if set
              const copy = own(m.clone());
              const colored = copy as Material & { color?: Color };
              if (tint && colored.color instanceof Color) {
                colored.color.multiply(srgb(marker.color));
                setOpacity(copy, copy.opacity * clamp01(a));
              }
              return copy;
            });
            child.material = Array.isArray(child.material) ? replaced : replaced[0];
          });
          holder.add(mesh);
          resources.loaded(url);
        },
        (error: unknown) => {
          if (!disposed) {
            resources.loaded(url, error);
          }
        },
      );
      content = holder;
      break;
    }
    default:
      content = null;
  }
  if (!content) {
    for (const resource of owned) {
      resource.dispose();
    }
    return null;
  }
  object.add(content);
  return {
    object,
    highlight(amount: number) {
      for (const { material, base } of lit) {
        material.emissive.copy(base).addScalar(amount);
      }
    },
    dispose() {
      disposed = true;
      for (const resource of owned) {
        resource.dispose();
      }
    },
  };
}

function shapeGeometry(type: number): BufferGeometry {
  if (type === MarkerType.SPHERE) {
    return new SphereGeometry(0.5, 24, 16);
  }
  if (type === MarkerType.CYLINDER) {
    // Along z, as ROS's
    return new CylinderGeometry(0.5, 0.5, 1, 24).rotateX(Math.PI / 2);
  }
  return new BoxGeometry(1, 1, 1);
}

// From its first point to its second (scale: the shaft's and head's
// diameters, the head's length), else along x of its pose (scale: its
// length, width and height)
function arrow(marker: MarkerMsg, material: Material, own: <T extends { dispose(): void }>(r: T) => T): Object3D | null {
  const { scale, points } = marker;
  let shape: Group;
  if (points.length >= 2) {
    const start = new Vector3(points[0].x, points[0].y, points[0].z);
    const direction = new Vector3(points[1].x, points[1].y, points[1].z).sub(start);
    const distance = direction.length();
    if (distance < 1e-9) {
      return new Group();
    }
    const headLength = scale.z !== 0 ? Math.min(distance, Math.max(0, scale.z)) : 0.23 * distance;
    shape = arrowObject(
      { shaftLength: distance - headLength, shaftRadius: scale.x / 2, headLength, headRadius: scale.y / 2 },
      material,
    );
    shape.position.copy(start);
    shape.quaternion.setFromUnitVectors(X, direction.normalize());
  } else {
    shape = arrowObject(UNIT_ARROW, material);
    shape.scale.set(scale.x, scale.y, scale.z);
  }
  shape.traverse((child) => {
    if (child instanceof Mesh) {
      own(child.geometry);
    }
  });
  return shape;
}

// A shape at each point, of the marker's colour or of each point's
function list(
  marker: MarkerMsg,
  geometry: BufferGeometry,
  size: Vector3,
  surface: (color: ColorMsg, options?: { alpha?: number }) => Material,
  own: <T extends { dispose(): void }>(r: T) => T,
): Object3D {
  const { points, colors } = marker;
  if (points.length === 0) {
    return new Group();
  }
  const colored = colors.length === points.length;
  const material = surface(colored ? { r: 1, g: 1, b: 1, a: 1 } : marker.color, colored ? { alpha: meanAlpha(colors) } : {});
  const mesh = own(new InstancedMesh(geometry, material, points.length));
  const matrix = new Matrix4();
  const position = new Vector3();
  const rotation = new Quaternion();
  points.forEach((point, i) => {
    mesh.setMatrixAt(i, matrix.compose(position.set(point.x, point.y, point.z), rotation, size));
    if (colored) {
      mesh.setColorAt(i, srgb(colors[i]));
    }
  });
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) {
    mesh.instanceColor.needsUpdate = true;
  }
  mesh.computeBoundingSphere();
  return mesh;
}

// Through the points (a strip), or between each two (a list), scale.x wide
function lines(marker: MarkerMsg, strip: boolean, own: <T extends { dispose(): void }>(r: T) => T): Object3D {
  const { points, colors } = marker;
  const colored = colors.length === points.length;
  const layer = new LinesLayer();
  own({
    dispose: () => {
      layer.object.geometry.dispose();
      (layer.object.material as Material).dispose();
    },
  });
  layer.setStyle({
    color: hex(marker.color),
    width: Math.max(1e-4, marker.scale.x),
    opacity: colored ? meanAlpha(colors) : clamp01(marker.color.a),
    worldUnits: true,
  });
  const segments: number[] = [];
  const segmentColors: number[] = [];
  const push = (i: number) => {
    segments.push(points[i].x, points[i].y, points[i].z);
    if (colored) {
      segmentColors.push(toLinear(clamp01(colors[i].r)), toLinear(clamp01(colors[i].g)), toLinear(clamp01(colors[i].b)));
    }
  };
  for (let i = 0; i + 1 < points.length; i += strip ? 1 : 2) {
    push(i);
    push(i + 1);
  }
  layer.setSegments(segments, colored ? segmentColors : null);
  return layer.object;
}

// Facing the view, its capital letters scale.z high, centred on its pose
function text(marker: MarkerMsg, own: <T extends { dispose(): void }>(r: T) => T): Object3D {
  const rows = marker.text.split('\n');
  if (!marker.text.trim() || typeof document === 'undefined') {
    return new Group();
  }
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');
  if (!context) {
    return new Group();
  }
  const font = `600 ${FONT_PX}px system-ui, -apple-system, "Segoe UI", sans-serif`;
  const pad = FONT_PX * 0.2;
  const lineHeight = FONT_PX * 1.2;
  context.font = font;
  const width = Math.ceil(Math.max(1, ...rows.map((row) => context.measureText(row).width)) + pad * 2);
  canvas.width = width;
  canvas.height = Math.ceil(lineHeight * rows.length + pad * 2);
  context.font = font;
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.lineJoin = 'round';
  // A dark outline: readable on any background
  context.lineWidth = FONT_PX * 0.14;
  context.strokeStyle = 'rgba(0, 0, 0, 0.6)';
  context.fillStyle = hex(marker.color);
  rows.forEach((row, i) => {
    const y = pad + lineHeight * (i + 0.5);
    context.strokeText(row, width / 2, y);
    context.fillText(row, width / 2, y);
  });
  const texture = own(new CanvasTexture(canvas));
  texture.colorSpace = SRGBColorSpace;
  const material = own(new SpriteMaterial({ map: texture, transparent: true, depthWrite: false }));
  material.opacity = clamp01(marker.color.a);
  const sprite = new Sprite(material);
  const metersPerPixel = Math.max(1e-4, marker.scale.z) / (FONT_PX * CAP_HEIGHT);
  sprite.scale.set(canvas.width * metersPerPixel, canvas.height * metersPerPixel, 1);
  return sprite;
}

// Each three points a triangle, scaled; of the marker's colour, of each
// vertex's, or of each triangle's
function triangles(
  marker: MarkerMsg,
  surface: (color: ColorMsg, options?: { doubleSide?: boolean; vertexColors?: boolean; alpha?: number }) => Material,
  own: <T extends { dispose(): void }>(r: T) => T,
): Object3D {
  const { points, colors, scale } = marker;
  const count = Math.floor(points.length / 3) * 3;
  if (count === 0) {
    return new Group();
  }
  const positions = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    positions.set([points[i].x * scale.x, points[i].y * scale.y, points[i].z * scale.z], i * 3);
  }
  const geometry = own(new BufferGeometry());
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  const perVertex = colors.length === points.length;
  const perFace = !perVertex && colors.length === points.length / 3;
  let opaque = true;
  if (perVertex || perFace) {
    const rgba = new Float32Array(count * 4);
    for (let i = 0; i < count; i++) {
      const c = colors[perVertex ? i : Math.floor(i / 3)];
      rgba.set([toLinear(clamp01(c.r)), toLinear(clamp01(c.g)), toLinear(clamp01(c.b)), clamp01(c.a)], i * 4);
      opaque &&= c.a >= 1;
    }
    geometry.setAttribute('color', new Float32BufferAttribute(rgba, 4));
  }
  geometry.computeVertexNormals();
  const colored = perVertex || perFace;
  const material = surface(marker.color, { doubleSide: true, vertexColors: colored, alpha: colored ? 1 : undefined });
  if (colored && !opaque) {
    material.transparent = true;
    material.depthWrite = false;
  }
  return new Mesh(geometry, material);
}
