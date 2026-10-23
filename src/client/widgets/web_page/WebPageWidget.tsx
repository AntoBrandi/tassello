// Another web page in the panel: a server's own interface, e.g. the robot's
// router, a camera's, Grafana, Foxglove, a robot's web UI. Its address may be
// a port alone, on the host the dashboard was opened by (see model.ts). The
// page is in a frame: sites that refuse to be framed show an error there, and
// the address bar opens them in a tab of their own.

import { useEffect, useMemo, useState } from 'react';

import { ExternalLinkIcon, GlobeIcon, RefreshIcon } from '../../icons.tsx';
import { defineWidget, type WidgetProps } from '../types.ts';
import { resolveAddress, shortAddress } from './model.ts';

interface WebPageConfig {
  address: string;
  zoom: number;
  addressBar: boolean;
}

function WebPageWidget({ config, instance }: WidgetProps<WebPageConfig>) {
  const address = useMemo(() => resolveAddress(config.address, window.location), [config.address]);
  // Reloaded: the frame made again, at the address (another site's frame
  // cannot be told to reload)
  const [reloads, setReloads] = useState(0);
  // Until the page and all it shows have loaded, which one streaming an MJPEG
  // image never does: the address bar's button spins meanwhile, nothing
  // covers the page
  const [loading, setLoading] = useState(true);
  const url = address.kind === 'invalid' ? null : address.url;
  useEffect(() => setLoading(true), [url, reloads]);

  if (!config.address.trim()) {
    return <div className="widget-message">No address: set one in edit mode</div>;
  }
  if (address.kind === 'invalid') {
    return <div className="widget-message error">{address.reason}</div>;
  }
  // A panel's file may have any number
  const scale = Math.min(200, Math.max(25, config.zoom)) / 100;
  return (
    <div className="web-page">
      {config.addressBar && (
        <div className="web-page-bar">
          <GlobeIcon width={14} height={14} />
          <span className="web-page-address" title={address.url}>
            {shortAddress(address.url)}
          </span>
          <button
            type="button"
            className={`overlay-button${address.kind === 'page' && loading ? ' loading' : ''}`}
            title="Reload"
            aria-label="Reload"
            disabled={address.kind !== 'page'}
            onClick={() => setReloads((n) => n + 1)}
          >
            <RefreshIcon width={15} height={15} />
          </button>
          <a
            className="overlay-button"
            href={address.url}
            target="_blank"
            rel="noopener noreferrer"
            title="Open in a new tab"
            aria-label="Open in a new tab"
          >
            <ExternalLinkIcon width={15} height={15} />
          </a>
        </div>
      )}
      <div className="web-page-view">
        {address.kind === 'blocked' ? (
          <div className="widget-message">
            {address.reason}:{' '}
            <a className="link-button" href={address.url} target="_blank" rel="noopener noreferrer">
              open it in a new tab
            </a>
          </div>
        ) : (
          <iframe
            key={`${address.url} ${reloads}`}
            src={address.url}
            title={instance.title || shortAddress(address.url)}
            allow="fullscreen; autoplay; clipboard-write"
            style={
              scale === 1
                ? undefined
                : { width: `${100 / scale}%`, height: `${100 / scale}%`, transform: `scale(${scale})` }
            }
            onLoad={() => setLoading(false)}
          />
        )}
      </div>
    </div>
  );
}

export const webPageWidget = defineWidget<WebPageConfig>({
  type: 'web-page',
  name: 'Web Page',
  description: 'Another web page in the panel: a server’s interface, e.g. the router’s, a camera’s, Grafana or Foxglove.',
  icon: GlobeIcon,
  defaultSize: { w: 8, h: 6 },
  minSize: { w: 2, h: 2 },
  component: WebPageWidget,
  properties: [
    {
      key: 'address',
      label: 'Address',
      kind: 'string',
      default: '',
      placeholder: 'http://192.168.1.20/  or  :8081/',
      help:
        'http(s)://…, or :<port>/… for a server of the robot: on the host this dashboard was opened by, so that ' +
        'it works from any network. Sites that refuse to be shown inside other pages open in a new tab',
    },
    {
      key: 'zoom',
      label: 'Zoom (%)',
      kind: 'number',
      default: 100,
      min: 25,
      max: 200,
      step: 5,
      help: 'Under 100 fits more of a page made for a large screen',
    },
    {
      key: 'addressBar',
      label: 'Address bar',
      kind: 'boolean',
      default: true,
      help: 'The address, with buttons to reload the page and to open it in a new tab',
    },
  ],
});
