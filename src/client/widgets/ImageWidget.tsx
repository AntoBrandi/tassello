// A static image: a file of the robot (a path, or picked by browsing it), a
// package's (package://), or one uploaded from a page. Reloaded every few
// seconds if asked, for images the robot rewrites.

import { useEffect, useState } from 'react';

import { imageUrl } from '../api.ts';
import { ImageIcon } from '../icons.tsx';
import { defineWidget, type WidgetProps } from './types.ts';

interface ImageConfig {
  image: string;
  fit: 'contain' | 'cover' | 'fill';
  refreshSeconds: number;
}

function ImageWidget({ config }: WidgetProps<ImageConfig>) {
  const url = imageUrl(config.image);
  const [version, setVersion] = useState(0);
  const [failed, setFailed] = useState(false);

  useEffect(() => setFailed(false), [url]);
  useEffect(() => {
    if (!url || config.refreshSeconds <= 0) {
      return;
    }
    const timer = setInterval(() => setVersion((v) => v + 1), config.refreshSeconds * 1000);
    return () => clearInterval(timer);
  }, [url, config.refreshSeconds]);

  if (!config.image.trim()) {
    return <div className="widget-message">No image: choose one in edit mode</div>;
  }
  if (!url) {
    return <div className="widget-message error">“{config.image}” is not a path (/…, ~/…, package://…)</div>;
  }
  // The server revalidates: an unchanged image is not downloaded again
  const src = version ? `${url}${url.includes('?') ? '&' : '?'}v=${version}` : url;
  return (
    <div className="image-viewer">
      <img
        src={src}
        alt={config.image}
        style={{ objectFit: config.fit }}
        className={failed ? 'failed' : undefined}
        onLoad={() => setFailed(false)}
        onError={() => setFailed(true)}
      />
      {failed && <div className="widget-message error image-viewer-error">Cannot load {config.image}</div>}
    </div>
  );
}

export const imageWidget = defineWidget<ImageConfig>({
  type: 'image',
  name: 'Image Viewer',
  description: 'A static image: a file of the robot, or one uploaded from here.',
  icon: ImageIcon,
  defaultSize: { w: 5, h: 4 },
  minSize: { w: 1, h: 1 },
  component: ImageWidget,
  properties: [
    {
      key: 'image',
      label: 'Image',
      kind: 'image',
      default: '',
      help: 'A file of the robot (/…, ~/…, package://…), or upload one from this device',
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
    {
      key: 'refreshSeconds',
      label: 'Reload every (s)',
      kind: 'number',
      default: 0,
      min: 0,
      step: 1,
      help: 'For an image the robot updates. 0: never',
    },
  ],
});
