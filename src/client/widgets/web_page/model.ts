// The address a Web Page widget shows, resolved against the dashboard's own
// page:
//   http://host:port/path, https://…   as it is
//   host:port/path                     over HTTP
//   :port/path                         on the host the dashboard was opened by
//                                      (its name or address on this network),
//                                      so a panel works from any network
//   /path                              on the dashboard's server, e.g. another
//                                      app behind the same proxy

export type PageAddress =
  | { kind: 'page'; url: string }
  // Not shown in the widget, only opened in a tab
  | { kind: 'blocked'; url: string; reason: string }
  | { kind: 'invalid'; reason: string };

// What of the dashboard's location the addresses depend on
export type PageLocation = Pick<Location, 'href' | 'origin' | 'protocol' | 'hostname'>;

// A scheme, not a host:port
const SCHEME = /^([a-z][a-z0-9+.-]*):(?!\d)/i;
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

export function resolveAddress(address: string, page: PageLocation): PageAddress {
  const text = address.trim();
  let candidate: string;
  if (text.startsWith(':')) {
    candidate = `${page.protocol}//${page.hostname}${text}`;
  } else if (text.startsWith('/')) {
    candidate = new URL(text, page.href).href;
  } else if (SCHEME.test(text)) {
    candidate = text;
  } else {
    candidate = `http://${text}`;
  }
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return { kind: 'invalid', reason: `“${text}” is not a web address` };
  }
  // javascript: would run in the dashboard's origin
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { kind: 'invalid', reason: `Only http:// and https:// pages can be shown, not ${url.protocol}` };
  }
  if (url.origin === page.origin && (url.pathname === '/' || url.pathname === '/index.html')) {
    return { kind: 'blocked', url: url.href, reason: 'This is the dashboard itself' };
  }
  if (page.protocol === 'https:' && url.protocol === 'http:' && !LOOPBACK.has(url.hostname)) {
    return {
      kind: 'blocked',
      url: url.href,
      reason: 'The dashboard is served over HTTPS: browsers do not show http:// pages inside it',
    };
  }
  return { kind: 'page', url: url.href };
}

// robot.local:8081/grafana: the address bar's
export function shortAddress(url: string): string {
  return url.replace(/^https?:\/\//, '').replace(/\/$/, '');
}
