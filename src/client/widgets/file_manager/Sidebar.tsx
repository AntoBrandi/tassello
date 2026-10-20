// The file manager's places, as the behavior tree editor's palette lists its
// nodes: home, the root, the ROS installations and workspaces sourced, the
// bookmarks (the widget's, and those of this page), and the disks with their
// space. Entries are dropped onto them.

import { useState, type DragEvent } from 'react';

import type { FsDisk } from '../../../shared/file_manager.ts';
import { BookmarkIcon, CloseIcon, FolderIcon, HardDriveIcon, HomeIcon, PlusIcon, RobotIcon } from '../../icons.tsx';
import { formatSize, isWithin } from './model.ts';
import { UsageBar } from './parts.tsx';

export interface Place {
  name: string;
  path: string;
  kind: 'home' | 'root' | 'folder' | 'ros' | 'bookmark';
  // The page's bookmarks: removed here
  removable: boolean;
}

const ICONS = { home: HomeIcon, root: HardDriveIcon, folder: FolderIcon, ros: RobotIcon, bookmark: BookmarkIcon };

export function Sidebar({
  places,
  disks,
  folder,
  dropTarget,
  canBookmark,
  onGo,
  onBookmark,
  onRemoveBookmark,
  onDragOver,
  onDrop,
  onClose,
}: {
  places: Place[];
  // null: not shown (the widget confined to a folder)
  disks: FsDisk[] | null;
  folder: string;
  dropTarget: string | null;
  // The folder shown is not one of the places already
  canBookmark: boolean;
  onGo: (path: string) => void;
  onBookmark: () => void;
  onRemoveBookmark: (path: string) => void;
  onDragOver: (folder: string, event: DragEvent) => void;
  onDrop: (folder: string, event: DragEvent) => void;
  onClose: () => void;
}) {
  const [closed, setClosed] = useState<ReadonlySet<string>>(new Set());
  // The deepest place holding the folder shown is where it is
  const here = places.reduce<Place | null>(
    (best, place) => (isWithin(folder, place.path) && (!best || place.path.length > best.path.length) ? place : best),
    null,
  );

  const group = (key: string, title: string, count: number) => (
    <button
      type="button"
      className="bte-palette-group"
      aria-expanded={!closed.has(key)}
      onClick={() =>
        setClosed((current) => {
          const next = new Set(current);
          if (!next.delete(key)) {
            next.add(key);
          }
          return next;
        })
      }
    >
      {title}
      <span className="bt-muted">{count}</span>
    </button>
  );

  const target = (path: string) => ({
    onDragOver: (event: DragEvent) => onDragOver(path, event),
    onDrop: (event: DragEvent) => onDrop(path, event),
  });

  const sections: { key: string; title: string; list: Place[] }[] = [
    { key: 'places', title: 'Places', list: places.filter((place) => place.kind !== 'ros' && place.kind !== 'bookmark') },
    { key: 'ros', title: 'ROS', list: places.filter((place) => place.kind === 'ros') },
    { key: 'bookmarks', title: 'Bookmarks', list: places.filter((place) => place.kind === 'bookmark') },
  ];

  return (
    <aside className="bte-palette fm-sidebar" aria-label="Places">
      <header className="bte-palette-header fm-sidebar-header">
        <span className="fm-sidebar-title">Places</span>
        <button type="button" className="icon-button" aria-label="Close the places" title="Close" onClick={onClose}>
          <CloseIcon width={16} height={16} />
        </button>
      </header>
      <div className="bte-palette-body">
        {sections.map(
          ({ key, title, list }) =>
            list.length > 0 && (
              <section key={key}>
                {key !== 'places' && group(key, title, list.length)}
                {!closed.has(key) && (
                  <ul>
                    {list.map((place) => {
                      const Icon = ICONS[place.kind];
                      return (
                        <li key={`${place.kind}:${place.path}`} className="fm-place-item">
                          <button
                            type="button"
                            className={`bte-palette-item fm-place${here === place ? ' active' : ''}${dropTarget === place.path ? ' drop-into' : ''}`}
                            title={place.path}
                            onClick={() => onGo(place.path)}
                            {...target(place.path)}
                          >
                            <Icon className="fm-icon folder" width={15} height={15} />
                            <span className="bte-palette-name">{place.name}</span>
                          </button>
                          {place.removable && (
                            <button
                              type="button"
                              className="icon-button fm-place-remove"
                              aria-label={`Remove the bookmark ${place.name}`}
                              title="Remove the bookmark"
                              onClick={() => onRemoveBookmark(place.path)}
                            >
                              <CloseIcon width={13} height={13} />
                            </button>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </section>
            ),
        )}
        {disks && disks.length > 0 && (
          <section>
            {group('disks', 'Disks', disks.length)}
            {!closed.has('disks') && (
              <ul>
                {disks.map((disk) => (
                  <li key={disk.mount}>
                    <button
                      type="button"
                      className={`bte-palette-item fm-disk${dropTarget === disk.mount ? ' drop-into' : ''}`}
                      title={`${disk.mount}: ${disk.device} (${disk.type}${disk.readOnly ? ', read-only' : ''})`}
                      onClick={() => onGo(disk.mount)}
                      {...target(disk.mount)}
                    >
                      <span className="fm-disk-name">
                        <HardDriveIcon className="fm-icon folder" width={15} height={15} />
                        <span className="bte-palette-name">{disk.mount}</span>
                        <span className="bte-palette-library">{formatSize(disk.free)} free</span>
                      </span>
                      <UsageBar used={disk.used} total={disk.used + disk.free} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}
      </div>
      <footer className="bte-palette-footer">
        <button type="button" className="button" disabled={!canBookmark} onClick={onBookmark}>
          <PlusIcon width={16} height={16} /> Bookmark this folder
        </button>
      </footer>
    </aside>
  );
}
