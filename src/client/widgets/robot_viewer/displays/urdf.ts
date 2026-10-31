// A robot's description (URDF) as three.js objects: its meshes, from the
// robot's ROS packages, its materials as ROS reads them, and the arrows that
// show a joint's motion (an arc around a revolute joint's axis, a straight
// arrow along a prismatic one's).

import {
  ConeGeometry,
  CylinderGeometry,
  Group,
  LoadingManager,
  Mesh,
  TorusGeometry,
  Vector3,
  type Material,
  type Object3D,
} from 'three';
import { ColladaLoader } from 'three/examples/jsm/loaders/ColladaLoader.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import URDFLoader, { type URDFJoint, type URDFLink, type URDFRobot } from 'urdf-loader';

// package:// is resolved by URDFLoader.packages; a file:// path into a ROS
// package's share directory (xacro's $(find ...)) is mapped to its package
function meshUrl(url: string): string {
  const shared = /^file:\/\/.*\/share\/([^/]+)\/(.+)$/.exec(url);
  return shared ? `/api/packages/${shared[1]}/${shared[2]}` : url;
}

type MeshDone = (mesh: Object3D, error?: Error) => void;

function loadMesh(url: string, manager: LoadingManager, material: Material, done: MeshDone): void {
  const fail = (error: unknown) => done(null as unknown as Object3D, error instanceof Error ? error : new Error(String(error)));
  const extension = url.split('?')[0].split('.').pop()?.toLowerCase();
  if (extension === 'stl') {
    new STLLoader(manager).load(url, (geometry) => done(new Mesh(geometry, material)), undefined, fail);
  } else if (extension === 'dae') {
    // Collada meshes carry their own materials
    new ColladaLoader(manager).load(
      url,
      (collada) => (collada ? done(collada.scene) : fail(new Error(`Invalid Collada file ${url}`))),
      undefined,
      fail,
    );
  } else if (extension === 'obj') {
    new OBJLoader(manager).load(
      url,
      (group) => {
        group.traverse((child) => {
          if (child instanceof Mesh) {
            child.material = material;
          }
        });
        done(group);
      },
      undefined,
      fail,
    );
  } else {
    fail(new Error(`No loader for ${url}`));
  }
}

// As ROS's URDF parser (and so RViz) does, unlike urdf-loader: a material
// defined with its colour in one link's visual, then named alone in others,
// e.g. <material name="black"/>, has that colour everywhere
function resolveMaterials(urdf: string): Document {
  const document = new DOMParser().parseFromString(urdf, 'text/xml');
  const defined = new Map<string, Element>();
  for (const material of document.querySelectorAll('material[name]')) {
    if (material.children.length > 0 && !defined.has(material.getAttribute('name')!)) {
      defined.set(material.getAttribute('name')!, material);
    }
  }
  for (const material of document.querySelectorAll('material[name]')) {
    const definition = defined.get(material.getAttribute('name')!);
    if (material.children.length === 0 && definition) {
      for (const child of definition.children) {
        material.append(child.cloneNode(true));
      }
    }
  }
  return document;
}

export interface LoadedRobot {
  robot: URDFRobot;
  // Resolves with the meshes that could not be loaded, once all the others are
  meshes: Promise<string[]>;
}

// Throws if the description is not a robot's. onMesh: a mesh came, or failed.
export function loadRobot(
  urdf: string,
  onProgress: (loaded: number, total: number) => void,
  onMesh: () => void,
): LoadedRobot {
  const manager = new LoadingManager();
  const loader = new URDFLoader(manager);
  loader.parseCollision = false;
  loader.packages = (name: string) => `/api/packages/${encodeURIComponent(name)}`;
  const failed: string[] = [];
  let meshes = 0;
  loader.loadMeshCb = (url, meshManager, material, done) => {
    meshes++;
    loadMesh(meshUrl(url), meshManager, material, (mesh, error) => {
      if (error) {
        failed.push(url);
      }
      done(mesh, error);
      onMesh();
    });
  };
  const robot = loader.parse(resolveMaterials(urdf));
  if (Object.keys(robot.links).length === 0) {
    throw new Error('it has no links');
  }
  if (meshes === 0) {
    return { robot, meshes: Promise.resolve(failed) };
  }
  return {
    robot,
    meshes: new Promise((resolve) => {
      manager.onProgress = (_url, loaded, total) => onProgress(loaded, total);
      manager.onLoad = () => resolve(failed);
      manager.onError = () => {
        // Reported by the mesh's own callback; onLoad still comes
      };
    }),
  };
}

export function isJoint(object: Object3D): object is URDFJoint {
  return (object as URDFJoint).isURDFJoint === true;
}

export function childLink(joint: URDFJoint): URDFLink | undefined {
  return joint.children.find((child) => (child as URDFLink).isURDFLink) as URDFLink | undefined;
}

// The meshes of the link itself: not those of the links below its joints, nor
// the display's own helpers
export function linkMeshes(link: Object3D): Mesh[] {
  const meshes: Mesh[] = [];
  const visit = (object: Object3D) => {
    for (const child of object.children) {
      if (isJoint(child) || child.userData.helper) {
        continue;
      }
      if (child instanceof Mesh) {
        meshes.push(child);
      }
      visit(child);
    }
  };
  visit(link);
  return meshes;
}

// An arc of a circle in the xy plane, turning counterclockwise about +z
export function turnArrow(radius: number, material: Material): Object3D {
  const arrow = new Group();
  const tube = radius * 0.07;
  const arc = 1.5 * Math.PI;
  arrow.add(new Mesh(new TorusGeometry(radius, tube, 8, 48, arc), material));
  const head = new Mesh(new ConeGeometry(tube * 2.8, tube * 7, 16), material);
  // Its +y along the arc's tangent at its end
  const tangent = new Vector3(-Math.sin(arc), Math.cos(arc), 0);
  head.position.set(radius * Math.cos(arc), radius * Math.sin(arc), 0).addScaledVector(tangent, tube * 3);
  head.rotation.z = arc;
  arrow.add(head);
  return arrow;
}

// Along +z, from the joint
export function straightArrow(length: number, material: Material): Object3D {
  const arrow = new Group();
  // Built along +y, then turned to +z
  const shape = new Group();
  shape.rotation.x = Math.PI / 2;
  const shaft = new Mesh(new CylinderGeometry(length * 0.05, length * 0.05, length * 0.7, 12), material);
  shaft.position.y = length * 0.35;
  const head = new Mesh(new ConeGeometry(length * 0.14, length * 0.3, 16), material);
  head.position.y = length * 0.85;
  shape.add(shaft, head);
  arrow.add(shape);
  return arrow;
}

// Frees an object's geometries, and its materials but those kept
export function disposeObject(object: Object3D, keep: Set<Material>): void {
  object.traverse((child) => {
    if (child instanceof Mesh) {
      child.geometry.dispose();
      for (const material of Array.isArray(child.material) ? child.material : [child.material]) {
        if (!keep.has(material)) {
          material.dispose();
        }
      }
    }
  });
}
