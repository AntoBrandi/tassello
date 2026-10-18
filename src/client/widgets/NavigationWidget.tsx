// The navigation map: the map, optionally Nav2's global and local costmaps
// and planned path over it, and the robot where TF puts it. Its tools set a pose estimate (as
// RViz's 2D Pose Estimate, for AMCL) and send navigation goals (as RViz's Nav2
// Goal): press on the map where the robot is or should go, drag towards where
// it faces, release. Drag to pan, scroll or pinch to zoom.

import { useCallback, useEffect, useRef, useState, type PointerEvent } from 'react';

import type { GridInfo, GridStyle, PathUpdate, Transform2D, TfUpdate } from '../../shared/protocol.ts';
import { connection, useTf } from '../connection.ts';
import { FitIcon, FlagIcon, LocateIcon, MapIcon, NavigationIcon } from '../icons.tsx';
import { notify } from '../notifications.tsx';
import { defineWidget, type WidgetProps } from './types.ts';

interface NavigationConfig {
  mapTopic: string;
  showGlobalCostmap: boolean;
  globalCostmapTopic: string;
  showLocalCostmap: boolean;
  localCostmapTopic: string;
  showPlan: boolean;
  planTopic: string;
  goalTopic: string;
  poseTopic: string;
  mapFrame: string;
  robotFrame: string;
}

type Tool = 'pose' | 'goal';
type LayerName = 'map' | 'global' | 'local';
// Bottom to top
const LAYERS: LayerName[] = ['map', 'global', 'local'];

interface Layer {
  image: ImageBitmap;
  info: GridInfo;
}

// The map frame's point at the canvas centre, and the zoom in CSS px per meter
interface View {
  x: number;
  y: number;
  scale: number;
}

const MIN_SCALE = 2;
const MAX_SCALE = 2000;
// The robot's marker: its size, unless that is too small to see
const ROBOT_RADIUS_M = 0.25;
const MIN_ROBOT_RADIUS_PX = 8;
const ARROW_PX = 34;
// A press dragged less than this sets the position only, facing +x
const DRAG_PX = 6;
// The robot's pose is shown as stale beyond this age
const STALE_MS = 2000;
// The goal's marker goes once the robot is this close to it
const GOAL_REACHED_M = 0.25;
// The plan leads to the goal: the same colour
const COLORS = { robot: '#4f8cff', stale: '#8b95a7', goal: '#2fbf71', plan: '#2fbf71', pose: '#f0a020' };

const toDegrees = (radians: number) => (radians * 180) / Math.PI;

function describePose(pose: Transform2D): string {
  return `x ${pose.x.toFixed(2)}  y ${pose.y.toFixed(2)}  θ ${Math.round(toDegrees(pose.yaw))}°`;
}

// Map frame (meters, y up) to canvas (CSS px, y down)
function worldToCanvas(view: View, width: number, height: number): DOMMatrix {
  return new DOMMatrix()
    .translate(width / 2, height / 2)
    .scale(view.scale, -view.scale)
    .translate(-view.x, -view.y);
}

// A frame's points to the map frame: placement is where the frame is in it
function frameToWorld(placement: Transform2D): DOMMatrix {
  return new DOMMatrix().translate(placement.x, placement.y).rotate(toDegrees(placement.yaw));
}

// Grid cells to the map frame: placement is where the grid's frame is in it
function gridToWorld(info: GridInfo, placement: Transform2D): DOMMatrix {
  return frameToWorld(placement)
    .translate(info.originX, info.originY)
    .rotate(toDegrees(info.originYaw))
    .scale(info.resolution, info.resolution);
}

function drawArrow(
  context: CanvasRenderingContext2D,
  toCanvas: DOMMatrix,
  pose: Transform2D,
  color: string,
): void {
  const p = toCanvas.transformPoint({ x: pose.x, y: pose.y });
  // y flips on the canvas, so do angles
  const angle = -pose.yaw;
  context.save();
  context.translate(p.x, p.y);
  context.rotate(angle);
  context.strokeStyle = color;
  context.fillStyle = color;
  context.lineWidth = 3;
  context.lineCap = 'round';
  context.beginPath();
  context.moveTo(0, 0);
  context.lineTo(ARROW_PX - 8, 0);
  context.stroke();
  context.beginPath();
  context.moveTo(ARROW_PX, 0);
  context.lineTo(ARROW_PX - 11, -7);
  context.lineTo(ARROW_PX - 11, 7);
  context.closePath();
  context.fill();
  context.beginPath();
  context.arc(0, 0, 5, 0, 2 * Math.PI);
  context.fill();
  context.lineWidth = 2;
  context.strokeStyle = '#fff';
  context.stroke();
  context.restore();
}

function drawRobot(
  context: CanvasRenderingContext2D,
  toCanvas: DOMMatrix,
  pose: Transform2D,
  scale: number,
  stale: boolean,
): void {
  const p = toCanvas.transformPoint({ x: pose.x, y: pose.y });
  const radius = Math.max(MIN_ROBOT_RADIUS_PX, ROBOT_RADIUS_M * scale);
  const color = stale ? COLORS.stale : COLORS.robot;
  context.save();
  context.translate(p.x, p.y);
  context.rotate(-pose.yaw);
  context.beginPath();
  context.arc(0, 0, radius, 0, 2 * Math.PI);
  context.fillStyle = `${color}55`;
  context.fill();
  context.lineWidth = 2;
  context.strokeStyle = color;
  context.stroke();
  // Heading
  context.beginPath();
  context.moveTo(radius + 6, 0);
  context.lineTo(-radius * 0.35, -radius * 0.55);
  context.lineTo(-radius * 0.1, 0);
  context.lineTo(-radius * 0.35, radius * 0.55);
  context.closePath();
  context.fillStyle = color;
  context.fill();
  context.lineWidth = 1.5;
  context.strokeStyle = '#fff';
  context.stroke();
  context.restore();
}

// points: x0, y0, x1, y1, ... in the frame placed by placement
function drawPath(context: CanvasRenderingContext2D, toCanvas: DOMMatrix, points: number[]): void {
  if (points.length < 4) {
    return;
  }
  context.save();
  context.beginPath();
  for (let i = 0; i < points.length; i += 2) {
    const p = toCanvas.transformPoint({ x: points[i], y: points[i + 1] });
    if (i === 0) {
      context.moveTo(p.x, p.y);
    } else {
      context.lineTo(p.x, p.y);
    }
  }
  context.lineCap = 'round';
  context.lineJoin = 'round';
  // A dark edge, to stand out on free (light) and unknown (gray) cells alike
  context.strokeStyle = 'rgb(0 0 0 / 35%)';
  context.lineWidth = 6;
  context.stroke();
  context.strokeStyle = COLORS.plan;
  context.lineWidth = 3;
  context.stroke();
  context.restore();
}

interface Scene {
  layers: Partial<Record<LayerName, Layer>>;
  placements: Partial<Record<LayerName, Transform2D | null>>;
  plan: { points: number[]; placement: Transform2D } | null;
  robot: TfUpdate | null;
  goal: Transform2D | null;
  preview: { tool: Tool; pose: Transform2D } | null;
}

function render(canvas: HTMLCanvasElement, view: View | null, scene: Scene): void {
  const ratio = window.devicePixelRatio || 1;
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) {
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
  }
  const context = canvas.getContext('2d');
  if (!context) {
    return;
  }
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.clearRect(0, 0, canvas.width, canvas.height);
  if (!view) {
    return;
  }
  const toCanvas = worldToCanvas(view, width, height);
  const toDevice = new DOMMatrix().scale(ratio, ratio).multiply(toCanvas);
  for (const name of LAYERS) {
    const layer = scene.layers[name];
    const placement = scene.placements[name];
    if (!layer || !placement) {
      continue;
    }
    // Cells larger than a pixel stay sharp; smaller ones are averaged
    context.imageSmoothingEnabled = layer.info.resolution * view.scale * ratio < 1;
    context.setTransform(toDevice.multiply(gridToWorld(layer.info, placement)));
    context.drawImage(layer.image, 0, 0);
  }
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  if (scene.plan) {
    drawPath(context, toCanvas.multiply(frameToWorld(scene.plan.placement)), scene.plan.points);
  }
  if (scene.goal) {
    drawArrow(context, toCanvas, scene.goal, COLORS.goal);
  }
  if (scene.robot?.transform) {
    drawRobot(context, toCanvas, scene.robot.transform, view.scale, scene.robot.ageMs > STALE_MS);
  }
  if (scene.preview) {
    drawArrow(context, toCanvas, scene.preview.pose, COLORS[scene.preview.tool]);
  }
}

// The view showing what the layer knows, or all of it
function fitLayer(layer: Layer, placement: Transform2D, width: number, height: number): View {
  const toWorld = gridToWorld(layer.info, placement);
  const cells = layer.info.known ?? { x: 0, y: 0, width: layer.info.width, height: layer.info.height };
  const corners = [
    [cells.x, cells.y],
    [cells.x + cells.width, cells.y],
    [cells.x, cells.y + cells.height],
    [cells.x + cells.width, cells.y + cells.height],
  ].map(([x, y]) => toWorld.transformPoint({ x, y }));
  const xs = corners.map((c) => c.x);
  const ys = corners.map((c) => c.y);
  const [minX, maxX, minY, maxY] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const scale = 0.94 * Math.min(width / (maxX - minX || 1), height / (maxY - minY || 1));
  return {
    x: (minX + maxX) / 2,
    y: (minY + maxY) / 2,
    scale: Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale)),
  };
}

type Gesture =
  | { kind: 'pan' }
  | { kind: 'pinch'; distance: number; center: { x: number; y: number } }
  | { kind: 'place'; tool: Tool; pointerId: number; anchor: { x: number; y: number }; start: { x: number; y: number } };

function NavigationWidget({ config, editing }: WidgetProps<NavigationConfig>) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const view = useRef<View | null>(null);
  // What the view was last fitted to. The map, whenever it comes, replaces a
  // view fitted to something else, but not one the user moved.
  const fittedTo = useRef<'map' | 'costmap' | 'robot' | 'user' | null>(null);
  const layers = useRef<Partial<Record<LayerName, Layer>>>({});
  // The frame of each layer, to place it in the map frame
  const [layerFrames, setLayerFrames] = useState<Record<LayerName, string>>({ map: '', global: '', local: '' });
  const [mapStatus, setMapStatus] = useState({ state: 'waiting', message: 'Connecting…' });
  const [tool, setTool] = useState<Tool | null>(null);
  const [follow, setFollow] = useState(false);
  const goal = useRef<Transform2D | null>(null);
  const plan = useRef<PathUpdate | null>(null);
  const [planFrame, setPlanFrame] = useState('');
  const preview = useRef<Scene['preview']>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<Gesture | null>(null);

  const mapFrame = config.mapFrame.trim();
  const robot = useTf(mapFrame, config.robotFrame);
  // Layers in another frame (Nav2's local costmap: odom) are placed by TF
  const frameOf = (name: LayerName) => (layerFrames[name] && layerFrames[name] !== mapFrame ? layerFrames[name] : '');
  const tfs = {
    map: useTf(mapFrame, frameOf('map')),
    global: useTf(mapFrame, frameOf('global')),
    local: useTf(mapFrame, frameOf('local')),
  };
  const placements: Scene['placements'] = {};
  for (const name of LAYERS) {
    placements[name] = frameOf(name) ? (tfs[name]?.transform ?? null) : { x: 0, y: 0, yaw: 0 };
  }
  const planTf = useTf(mapFrame, planFrame && planFrame !== mapFrame ? planFrame : '');
  const planPlacement = planFrame && planFrame !== mapFrame ? (planTf?.transform ?? null) : { x: 0, y: 0, yaw: 0 };

  // What render() draws: what the last render computed, and the latest of
  // what arrives between renders (plan, goal, preview), read when the frame comes
  const scene = useRef({ layers: layers.current, placements, planPlacement, robot });
  scene.current = { layers: layers.current, placements, planPlacement, robot };
  const frame = useRef(0);
  const redraw = useCallback(() => {
    frame.current ||= requestAnimationFrame(() => {
      frame.current = 0;
      const canvas = canvasRef.current;
      const { planPlacement: placement, ...rest } = scene.current;
      if (canvas) {
        render(canvas, view.current, {
          ...rest,
          plan: plan.current && placement ? { points: plan.current.points, placement } : null,
          goal: goal.current,
          preview: preview.current,
        });
      }
    });
  }, []);
  useEffect(redraw);
  useEffect(() => () => cancelAnimationFrame(frame.current), []);

  const size = () => ({ width: canvasRef.current?.clientWidth ?? 1, height: canvasRef.current?.clientHeight ?? 1 });

  const fit = useCallback(() => {
    const { width, height } = size();
    for (const name of LAYERS) {
      const layer = layers.current[name];
      const placement = scene.current.placements[name];
      if (layer && placement) {
        view.current = fitLayer(layer, placement, width, height);
        fittedTo.current = name === 'map' ? 'map' : 'costmap';
        redraw();
        return true;
      }
    }
    const pose = scene.current.robot?.transform;
    if (pose) {
      view.current = { x: pose.x, y: pose.y, scale: 50 };
      fittedTo.current = 'robot';
      redraw();
      return true;
    }
    return false;
  }, [redraw]);

  // ── Layers ──
  const subscribeLayer = useCallback(
    (name: LayerName, topic: string, style: GridStyle, maxFps: number) => {
      let current = true;
      const unsubscribe = connection.subscribeGrid(
        { topic, style, maxFps },
        {
          status: (state, message) => name === 'map' && setMapStatus({ state, message }),
          frame: async (file, { meta }) => {
            const image = await createImageBitmap(file);
            if (!current) {
              image.close();
              return;
            }
            const info = meta as GridInfo;
            layers.current[name]?.image.close();
            layers.current[name] = { image, info };
            setLayerFrames((frames) => (frames[name] === info.frameId ? frames : { ...frames, [name]: info.frameId }));
            const fitted = fittedTo.current;
            if (name === 'map' ? fitted !== 'map' && fitted !== 'user' : fitted === null || fitted === 'robot') {
              fit();
            }
            redraw();
          },
        },
      );
      return () => {
        current = false;
        unsubscribe();
        layers.current[name]?.image.close();
        delete layers.current[name];
        redraw();
      };
    },
    [fit, redraw],
  );

  const mapTopic = config.mapTopic.trim();
  useEffect(() => {
    if (!mapTopic) {
      setMapStatus({ state: 'error', message: 'No map topic: set one in edit mode' });
      return;
    }
    setMapStatus({ state: 'waiting', message: 'Connecting…' });
    return subscribeLayer('map', mapTopic, 'map', 1);
  }, [mapTopic, subscribeLayer]);

  const globalTopic = config.showGlobalCostmap ? config.globalCostmapTopic.trim() : '';
  useEffect(() => (globalTopic ? subscribeLayer('global', globalTopic, 'costmap', 1) : undefined), [globalTopic, subscribeLayer]);

  const localTopic = config.showLocalCostmap ? config.localCostmapTopic.trim() : '';
  useEffect(() => (localTopic ? subscribeLayer('local', localTopic, 'costmap', 4) : undefined), [localTopic, subscribeLayer]);

  // ── Plan ──
  const planTopic = config.showPlan ? config.planTopic.trim() : '';
  useEffect(() => {
    if (!planTopic) {
      return;
    }
    const unsubscribe = connection.subscribePath({ topic: planTopic }, (update) => {
      plan.current = update;
      // Its placement comes with the next render, which redraws
      setPlanFrame(update.frameId);
      redraw();
    });
    return () => {
      unsubscribe();
      plan.current = null;
      setPlanFrame('');
      redraw();
    };
  }, [planTopic, redraw]);

  // ── Robot ──
  useEffect(() => {
    const pose = robot?.transform;
    if (pose && goal.current && Math.hypot(pose.x - goal.current.x, pose.y - goal.current.y) < GOAL_REACHED_M) {
      goal.current = null;
    }
    if (follow && pose && view.current) {
      view.current = { ...view.current, x: pose.x, y: pose.y };
    } else if (!view.current && pose) {
      fit();
    }
  }, [robot, follow, fit]);

  // Redraws on resize, keeping the view's centre and zoom
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }
    const observer = new ResizeObserver(redraw);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [redraw]);

  // ── Gestures ──
  const zoomAt = useCallback(
    (point: { x: number; y: number }, factor: number) => {
      const current = view.current;
      if (!current) {
        return;
      }
      const { width, height } = size();
      const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, current.scale * factor));
      fittedTo.current = 'user';
      // The map point under the pointer stays under it
      const world = worldToCanvas(current, width, height).inverse().transformPoint(point);
      view.current = {
        scale,
        x: world.x - (point.x - width / 2) / scale,
        y: world.y + (point.y - height / 2) / scale,
      };
      redraw();
    },
    [redraw],
  );

  // Not React's onWheel, which is passive: the page would scroll
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = canvas.getBoundingClientRect();
      zoomAt({ x: event.clientX - rect.left, y: event.clientY - rect.top }, Math.exp(-event.deltaY * 0.0015));
    };
    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', onWheel);
  }, [zoomAt]);

  useEffect(() => {
    if (!tool) {
      return;
    }
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && setTool(null);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [tool]);

  const local = (event: PointerEvent) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };
  // A plain object: a DOMPoint's x and y do not spread
  const toWorld = (point: { x: number; y: number }) => {
    const { width, height } = size();
    const { x, y } = worldToCanvas(view.current!, width, height).inverse().transformPoint(point);
    return { x, y };
  };

  const pinch = () => {
    const [a, b] = [...pointers.current.values()];
    return { distance: Math.hypot(a.x - b.x, a.y - b.y), center: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
  };

  const publish = (kind: Tool, pose: Transform2D) => {
    const sent = connection.send({
      type: 'pose',
      topic: kind === 'goal' ? config.goalTopic.trim() : config.poseTopic.trim(),
      covariance: kind === 'pose',
      frameId: mapFrame,
      ...pose,
    });
    if (!sent) {
      notify('Not connected to the robot', 'error');
      return;
    }
    if (kind === 'goal') {
      goal.current = pose;
    }
    notify(`${kind === 'goal' ? 'Goal' : 'Pose estimate'} sent: ${describePose(pose)}`);
  };

  const onPointerDown = (event: PointerEvent<HTMLCanvasElement>) => {
    if (!view.current || (event.pointerType === 'mouse' && event.button !== 0)) {
      return;
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    const point = local(event);
    pointers.current.set(event.pointerId, point);
    if (pointers.current.size === 2) {
      // A second finger: zoom, whatever the first one was doing
      preview.current = null;
      gesture.current = { kind: 'pinch', ...pinch() };
    } else if (pointers.current.size === 1 && tool) {
      const anchor = toWorld(point);
      gesture.current = { kind: 'place', tool, pointerId: event.pointerId, anchor, start: point };
      preview.current = { tool, pose: { x: anchor.x, y: anchor.y, yaw: 0 } };
    } else if (pointers.current.size === 1) {
      gesture.current = { kind: 'pan' };
    }
    redraw();
  };

  const onPointerMove = (event: PointerEvent<HTMLCanvasElement>) => {
    const previous = pointers.current.get(event.pointerId);
    const current = view.current;
    if (!previous || !current) {
      return;
    }
    const point = local(event);
    pointers.current.set(event.pointerId, point);
    const g = gesture.current;
    if (g?.kind === 'place') {
      const target = toWorld(point);
      const dragged = Math.hypot(point.x - g.start.x, point.y - g.start.y) > DRAG_PX;
      preview.current = {
        tool: g.tool,
        pose: { ...g.anchor, yaw: dragged ? Math.atan2(target.y - g.anchor.y, target.x - g.anchor.x) : 0 },
      };
    } else if (g?.kind === 'pan') {
      fittedTo.current = 'user';
      view.current = {
        ...current,
        x: current.x - (point.x - previous.x) / current.scale,
        y: current.y + (point.y - previous.y) / current.scale,
      };
      setFollow(false);
    } else if (g?.kind === 'pinch' && pointers.current.size === 2) {
      const next = pinch();
      view.current = {
        ...current,
        x: current.x - (next.center.x - g.center.x) / current.scale,
        y: current.y + (next.center.y - g.center.y) / current.scale,
      };
      zoomAt(next.center, next.distance / (g.distance || 1));
      gesture.current = { kind: 'pinch', ...next };
    }
    redraw();
  };

  const onPointerEnd = (event: PointerEvent<HTMLCanvasElement>) => {
    if (!pointers.current.delete(event.pointerId)) {
      return;
    }
    const g = gesture.current;
    if (g?.kind === 'place' && g.pointerId === event.pointerId) {
      const placed = preview.current;
      preview.current = null;
      gesture.current = null;
      if (event.type === 'pointerup' && placed) {
        publish(g.tool, placed.pose);
        setTool(null);
      }
    } else if (pointers.current.size === 1) {
      // From a pinch back to a pan with the finger left
      gesture.current = { kind: 'pan' };
    } else if (pointers.current.size === 0) {
      gesture.current = null;
    }
    redraw();
  };

  const robotPose = robot?.transform;
  let readout: { text: string; className: string };
  if (!mapFrame || !config.robotFrame.trim()) {
    readout = { text: 'Set the TF frames in edit mode', className: 'error' };
  } else if (robotPose) {
    const stale = robot.ageMs > STALE_MS;
    readout = { text: `${describePose(robotPose)}${stale ? '  (stale)' : ''}`, className: stale ? 'stale' : '' };
  } else {
    readout = { text: robot?.error ?? 'Locating the robot…', className: 'error' };
  }

  const toolButton = (kind: Tool, label: string, Icon: typeof FlagIcon) => (
    <button
      type="button"
      className="overlay-button"
      aria-pressed={tool === kind}
      title={label}
      aria-label={label}
      onClick={() => setTool((current) => (current === kind ? null : kind))}
    >
      <Icon width={17} height={17} />
    </button>
  );

  return (
    <div className="navigation">
      <canvas
        ref={canvasRef}
        className={tool ? 'placing' : undefined}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onPointerCancel={onPointerEnd}
      />
      {mapStatus.state !== 'streaming' && (
        <div className={`nav-overlay ${mapStatus.state}`}>
          <MapIcon width={28} height={28} />
          <span>{mapStatus.message}</span>
        </div>
      )}
      <div className="overlay-toolbar">
        {toolButton('pose', 'Set the pose estimate', LocateIcon)}
        {toolButton('goal', 'Send a navigation goal', FlagIcon)}
        <span className="overlay-separator" />
        <button
          type="button"
          className="overlay-button"
          title="Fit the map"
          aria-label="Fit the map"
          onClick={() => {
            setFollow(false);
            fit();
          }}
        >
          <FitIcon width={17} height={17} />
        </button>
        <button
          type="button"
          className="overlay-button"
          aria-pressed={follow}
          title="Follow the robot"
          aria-label="Follow the robot"
          disabled={!robotPose}
          onClick={() => setFollow((on) => !on)}
        >
          <NavigationIcon width={17} height={17} />
        </button>
      </div>
      {tool && !editing && (
        <div className="nav-hint">
          {tool === 'goal'
            ? 'Press where the robot should go, drag towards where it should face'
            : 'Press where the robot is, drag towards where it faces'}
        </div>
      )}
      <div className={`nav-readout ${readout.className}`}>{readout.text}</div>
    </div>
  );
}

export const navigationWidget = defineWidget<NavigationConfig>({
  type: 'navigation',
  name: 'Navigation',
  description: 'The map, the costmaps and the robot on them; set its pose and send it goals.',
  icon: MapIcon,
  defaultSize: { w: 8, h: 6 },
  minSize: { w: 3, h: 3 },
  component: NavigationWidget,
  properties: [
    {
      key: 'mapTopic',
      label: 'Map topic',
      kind: 'topic',
      default: '/map',
      topicTypes: ['nav_msgs/msg/OccupancyGrid'],
    },
    { key: 'showGlobalCostmap', label: 'Show the global costmap', kind: 'boolean', default: false },
    {
      key: 'globalCostmapTopic',
      label: 'Global costmap topic',
      kind: 'topic',
      default: '/global_costmap/costmap',
      topicTypes: ['nav_msgs/msg/OccupancyGrid'],
      visible: (config) => config.showGlobalCostmap,
    },
    { key: 'showLocalCostmap', label: 'Show the local costmap', kind: 'boolean', default: true },
    {
      key: 'localCostmapTopic',
      label: 'Local costmap topic',
      kind: 'topic',
      default: '/local_costmap/costmap',
      topicTypes: ['nav_msgs/msg/OccupancyGrid'],
      visible: (config) => config.showLocalCostmap,
    },
    { key: 'showPlan', label: 'Show the planned path', kind: 'boolean', default: true },
    {
      key: 'planTopic',
      label: 'Plan topic',
      kind: 'topic',
      default: '/plan',
      topicTypes: ['nav_msgs/msg/Path'],
      help: 'nav_msgs/Path: Nav2’s planner publishes its plan on /plan',
      visible: (config) => config.showPlan,
    },
    {
      key: 'goalTopic',
      label: 'Goal topic',
      kind: 'topic',
      default: '/goal_pose',
      topicTypes: ['geometry_msgs/msg/PoseStamped'],
      help: 'geometry_msgs/PoseStamped, which Nav2’s bt_navigator follows',
    },
    {
      key: 'poseTopic',
      label: 'Pose estimate topic',
      kind: 'topic',
      default: '/initialpose',
      topicTypes: ['geometry_msgs/msg/PoseWithCovarianceStamped'],
      help: 'geometry_msgs/PoseWithCovarianceStamped, which AMCL starts from',
    },
    {
      key: 'mapFrame',
      label: 'Map frame',
      kind: 'string',
      default: 'map',
      help: 'The frame the map is drawn in, and the goals and poses are set in',
    },
    {
      key: 'robotFrame',
      label: 'Robot frame',
      kind: 'string',
      default: 'base_footprint',
      help: 'Where the robot is, from TF',
    },
  ],
});
