// The file manager's tabs: the files, then the files open, their changes
// not saved marked; and the view of the images open.

import { useEffect, useState } from 'react';

import { fsApi } from '../../api.ts';
import { CloseIcon, FolderIcon } from '../../icons.tsx';
import { EntryIcon } from './FileList.tsx';
import { baseName, displayPath } from './model.ts';
import { isDirty, type Tab } from './session.ts';

export function TabStrip({
  tabs,
  active,
  folder,
  home,
  onActivate,
  onClose,
}: {
  tabs: Tab[];
  // The tab shown, null: the files
  active: number | null;
  // The folder shown
  folder: string;
  home: string;
  onActivate: (id: number | null) => void;
  onClose: (tab: Tab) => void;
}) {
  return (
    <div className="fm-tabs" role="tablist" aria-label="Open files">
      <button
        type="button"
        role="tab"
        aria-selected={active === null}
        className={`fm-tab${active === null ? ' active' : ''}`}
        title={folder ? displayPath(folder, home) : undefined}
        onClick={() => onActivate(null)}
      >
        <FolderIcon className="fm-icon folder" width={14} height={14} />
        <span className="fm-tab-name">{folder ? baseName(displayPath(folder, home)) || '/' : 'Files'}</span>
      </button>
      {tabs.map((tab) => (
        <div
          key={tab.id}
          role="tab"
          aria-selected={tab.id === active}
          tabIndex={0}
          className={`fm-tab${tab.id === active ? ' active' : ''}`}
          title={displayPath(tab.path, home)}
          onClick={() => onActivate(tab.id)}
          onKeyDown={(e) => e.key === 'Enter' && onActivate(tab.id)}
          onAuxClick={(e) => e.button === 1 && onClose(tab)}
        >
          <EntryIcon entry={{ name: baseName(tab.path), kind: 'file', bag: false, mode: 0o644, link: null }} size={14} />
          <span className="fm-tab-name">{baseName(tab.path)}</span>
          {isDirty(tab) && <span className="fm-dirty" aria-label="Changed" title="Changed" />}
          <button
            type="button"
            className="fm-tab-close"
            aria-label={`Close ${baseName(tab.path)}`}
            title="Close"
            onClick={(e) => {
              e.stopPropagation();
              onClose(tab);
            }}
          >
            <CloseIcon width={12} height={12} />
          </button>
        </div>
      ))}
    </div>
  );
}

// Fitted, or at its size; maps (PGM) with their cells square
export function ImageView({ path, reads, onSize }: { path: string; reads: number; onSize: (size: string) => void }) {
  const [fit, setFit] = useState(true);
  const [error, setError] = useState(false);
  useEffect(() => setError(false), [path, reads]);
  if (error) {
    return <div className="widget-message error">This image cannot be shown: download it</div>;
  }
  const map = /\.(pgm|ppm|pnm)$/i.test(path);
  return (
    <div className={`fm-image${fit ? ' fit' : ''}${map ? ' map' : ''}`} title={fit ? 'Click: at its size' : 'Click: to fit'} onClick={() => setFit((on) => !on)}>
      <img
        src={fsApi.viewUrl(path, String(reads))}
        alt={baseName(path)}
        onLoad={(e) => onSize(`${e.currentTarget.naturalWidth} × ${e.currentTarget.naturalHeight}`)}
        onError={() => setError(true)}
      />
    </div>
  );
}
