// Shows an image topic: raw (sensor_msgs/Image, compressed to JPEG by the
// server) or compressed (sensor_msgs/CompressedImage, passed through).

import { useEffect, useRef, useState } from 'react';

import type { ImageTransport } from '../../shared/protocol.ts';
import { connection } from '../connection.ts';
import { CameraIcon } from '../icons.tsx';
import { defineWidget, type WidgetProps } from './types.ts';

type Fit = 'contain' | 'cover' | 'fill';

interface CameraConfig {
  topic: string;
  transport: ImageTransport;
  maxFps: number;
  quality: number;
  maxWidth: number;
  fit: Fit;
  showInfo: boolean;
}

// Without a frame for this long, a streaming image is shown as stalled
const STALE_MS = 3000;
// Window over which the frame rate is measured
const FPS_WINDOW_MS = 2000;

function draw(canvas: HTMLCanvasElement, image: ImageBitmap, fit: Fit): void {
  const ratio = window.devicePixelRatio || 1;
  const width = Math.round(canvas.clientWidth * ratio);
  const height = Math.round(canvas.clientHeight * ratio);
  if (width === 0 || height === 0) {
    return;
  }
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  const context = canvas.getContext('2d');
  if (!context) {
    return;
  }
  let w = width;
  let h = height;
  if (fit !== 'fill') {
    const scale = (fit === 'contain' ? Math.min : Math.max)(width / image.width, height / image.height);
    w = image.width * scale;
    h = image.height * scale;
  }
  context.clearRect(0, 0, width, height);
  context.drawImage(image, (width - w) / 2, (height - h) / 2, w, h);
}

interface Info {
  width: number;
  height: number;
  fps: number;
}

function CameraWidget({ config }: WidgetProps<CameraConfig>) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const latest = useRef<ImageBitmap | null>(null);
  const fitRef = useRef(config.fit);
  fitRef.current = config.fit;
  const [status, setStatus] = useState({ state: 'waiting', message: 'Connecting…' });
  const [info, setInfo] = useState<Info | null>(null);
  const [stale, setStale] = useState(false);
  const lastFrameAt = useRef(0);

  const topic = config.topic.trim();
  const { transport, maxFps, quality, maxWidth } = config;
  useEffect(() => {
    setInfo(null);
    if (!topic) {
      setStatus({ state: 'error', message: 'No image topic: set one in edit mode' });
      return;
    }
    setStatus({ state: 'waiting', message: 'Connecting…' });
    const times: number[] = [];
    // A frame being decoded when the subscription changes is not to be drawn
    let current = true;
    const unsubscribe = connection.subscribeImage(
      { topic, transport, maxFps, quality, maxWidth },
      {
        status: (state, message) => setStatus({ state, message }),
        frame: async (file, { width: sourceWidth, height: sourceHeight }) => {
          const image = await createImageBitmap(file);
          if (!current) {
            image.close();
            return;
          }
          const canvas = canvasRef.current;
          if (canvas) {
            draw(canvas, image, fitRef.current);
          }
          latest.current?.close();
          latest.current = image;
          const now = performance.now();
          lastFrameAt.current = now;
          times.push(now);
          while (times.length > 2 && now - times[0] > FPS_WINDOW_MS) {
            times.shift();
          }
          setStale(false);
          setInfo({
            width: sourceWidth || image.width,
            height: sourceHeight || image.height,
            fps: times.length > 1 ? ((times.length - 1) * 1000) / (now - times[0]) : 0,
          });
        },
      },
    );
    return () => {
      current = false;
      unsubscribe();
      latest.current?.close();
      latest.current = null;
      const canvas = canvasRef.current;
      canvas?.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height);
    };
  }, [topic, transport, maxFps, quality, maxWidth]);

  // Redraws the last image when the widget is resized or its fit changes
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }
    const redraw = () => latest.current && draw(canvas, latest.current, fitRef.current);
    redraw();
    const observer = new ResizeObserver(redraw);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [config.fit]);

  useEffect(() => {
    const timer = setInterval(() => {
      setStale(lastFrameAt.current > 0 && performance.now() - lastFrameAt.current > STALE_MS);
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  let overlay: string | null = null;
  if (status.state !== 'streaming') {
    overlay = status.message;
  } else if (stale) {
    overlay = `No image for ${Math.round((performance.now() - lastFrameAt.current) / 1000)} s`;
  }
  return (
    <div className="camera">
      <canvas ref={canvasRef} className={overlay && info ? 'dimmed' : undefined} />
      {overlay && (
        <div className={`camera-overlay ${status.state}`}>
          <CameraIcon width={28} height={28} />
          <span>{overlay}</span>
        </div>
      )}
      {config.showInfo && info && !overlay && (
        <div className="camera-info">
          {info.width}×{info.height} · {info.fps.toFixed(1)} fps
        </div>
      )}
    </div>
  );
}

export const cameraWidget = defineWidget<CameraConfig>({
  type: 'camera',
  name: 'Camera',
  description: 'Show an image topic, raw or compressed.',
  icon: CameraIcon,
  defaultSize: { w: 6, h: 4 },
  minSize: { w: 2, h: 2 },
  component: CameraWidget,
  properties: [
    {
      key: 'topic',
      label: 'Topic',
      kind: 'topic',
      default: '',
      topicTypes: ['sensor_msgs/msg/Image', 'sensor_msgs/msg/CompressedImage'],
      placeholder: '/arm_camera/image_raw',
    },
    {
      key: 'transport',
      label: 'Transport',
      kind: 'select',
      default: 'auto',
      options: [
        { value: 'auto', label: 'Auto: the type the topic is published with' },
        { value: 'raw', label: 'Raw: sensor_msgs/Image' },
        { value: 'compressed', label: 'Compressed: <topic>/compressed' },
      ],
      help: 'Compressed images take far less bandwidth from the camera driver to the server',
    },
    { key: 'maxFps', label: 'Max frame rate', kind: 'number', default: 10, min: 0.1, max: 60, step: 1 },
    {
      key: 'maxWidth',
      label: 'Max width (raw images, px)',
      kind: 'number',
      default: 640,
      min: 0,
      max: 8192,
      step: 1,
      help: 'Wider raw images are scaled down before being sent. 0: full size',
    },
    {
      key: 'quality',
      label: 'JPEG quality (raw images)',
      kind: 'number',
      default: 75,
      min: 1,
      max: 100,
      step: 1,
    },
    {
      key: 'fit',
      label: 'Fit',
      kind: 'select',
      default: 'contain',
      options: [
        { value: 'contain', label: 'Whole image' },
        { value: 'cover', label: 'Fill the widget, cropped' },
        { value: 'fill', label: 'Stretch' },
      ],
    },
    { key: 'showInfo', label: 'Show size and frame rate', kind: 'boolean', default: true },
  ],
});
