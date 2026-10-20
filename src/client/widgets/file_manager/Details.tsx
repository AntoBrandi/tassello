// The details of what is selected in the file manager, as the behavior tree
// inspector details a node: an entry's kind, size, times, owner, permissions
// (changed there), link and disk, an image's preview, a folder's size
// computed on demand; of several, their count and size. Or, nothing
// selected, of the folder shown. With what can be done with them.

import { useEffect, useState, type ReactNode } from 'react';

import type { FsAnalysis, FsDetails, FsEntry } from '../../../shared/file_manager.ts';
import { fsApi } from '../../api.ts';
import { CloseIcon } from '../../icons.tsx';
import { EntryIcon } from './FileList.tsx';
import {
  ago,
  baseName,
  counted,
  displayPath,
  fileType,
  formatFullDate,
  formatMode,
  formatSize,
  isViewable,
  items,
  octalMode,
  parentOf,
  typeLabel,
} from './model.ts';

export interface DetailsActions {
  onOpen: (path: string) => void;
  onGo: (folder: string) => void;
  onDownload: (paths: string[]) => void;
  onRename: (path: string) => void;
  onMove: (paths: string[], copy: boolean) => void;
  onDelete: (paths: string[]) => void;
  onChmod: (path: string, mode: number) => Promise<void>;
}

const PERMISSIONS: { who: string; shift: number }[] = [
  { who: 'Owner', shift: 6 },
  { who: 'Group', shift: 3 },
  { who: 'Others', shift: 0 },
];

function Permissions({ details, disabled, onChange }: { details: FsDetails; disabled: boolean; onChange: (mode: number) => void }) {
  const folder = details.kind === 'dir';
  const bits = [
    { label: 'Read', bit: 4 },
    { label: 'Write', bit: 2 },
    { label: folder ? 'Enter' : 'Run', bit: 1 },
  ];
  return (
    <table className="fm-perms">
      <thead>
        <tr>
          <th />
          {bits.map(({ label }) => (
            <th key={label} scope="col">
              {label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {PERMISSIONS.map(({ who, shift }) => (
          <tr key={who}>
            <th scope="row">{who}</th>
            {bits.map(({ label, bit }) => {
              const mask = bit << shift;
              return (
                <td key={label}>
                  <input
                    type="checkbox"
                    aria-label={`${who}: ${label}`}
                    checked={(details.mode & mask) !== 0}
                    disabled={disabled}
                    onChange={() => onChange(details.mode ^ mask)}
                  />
                </td>
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Fact({ term, children }: { term: string; children: ReactNode }) {
  return (
    <>
      <dt>{term}</dt>
      <dd>{children}</dd>
    </>
  );
}

function FolderSize({ path }: { path: string }) {
  const [state, setState] = useState<{ busy: boolean; result: FsAnalysis | null; error: string | null }>({
    busy: false,
    result: null,
    error: null,
  });
  useEffect(() => setState({ busy: false, result: null, error: null }), [path]);
  const compute = () => {
    setState({ busy: true, result: null, error: null });
    fsApi.analyze(path).then(
      (result) => setState({ busy: false, result, error: null }),
      (e: unknown) => setState({ busy: false, result: null, error: e instanceof Error ? e.message : String(e) }),
    );
  };
  const { busy, result, error } = state;
  if (result) {
    return (
      <span title={result.partial ?? undefined}>
        {result.partial ? 'At least ' : ''}
        {formatSize(result.size)} in {counted(result.files, 'file')}, {counted(result.folders, 'folder')}
      </span>
    );
  }
  return (
    <span>
      <button type="button" className="link-button fm-inline-button" disabled={busy} onClick={compute}>
        {busy ? 'Computing…' : 'Compute its size'}
      </button>
      {error && <span className="fm-error"> {error}</span>}
    </span>
  );
}

export function Details({
  paths,
  folder,
  entries,
  version,
  home,
  readOnly,
  now,
  actions,
  onClose,
}: {
  // Selected; none: the folder shown
  paths: string[];
  folder: string;
  // The selected entries known, by path
  entries: ReadonlyMap<string, FsEntry>;
  // Of the listing: read again when it changes
  version: string;
  home: string;
  readOnly: boolean;
  now: number;
  actions: DetailsActions;
  onClose: () => void;
}) {
  const single = paths.length <= 1 ? (paths[0] ?? folder) : null;
  const [details, setDetails] = useState<FsDetails | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [changing, setChanging] = useState(false);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!single) {
      return;
    }
    let current = true;
    fsApi.details(single).then(
      (result) => {
        if (current) {
          setDetails(result);
          setError(null);
        }
      },
      (e: unknown) => {
        if (current) {
          setDetails(null);
          setError(e instanceof Error ? e.message : String(e));
        }
      },
    );
    return () => {
      current = false;
    };
  }, [single, version, tick]);

  // Another entry: what was shown goes
  useEffect(() => {
    setDetails(null);
    setError(null);
  }, [single]);

  let header: ReactNode;
  let body: ReactNode;
  if (!single) {
    const known = paths.map((path) => entries.get(path)).filter((entry) => entry !== undefined);
    const files = known.filter((entry) => entry.kind === 'file');
    const folders = known.filter((entry) => entry.kind === 'dir').length;
    const together = paths.every((path) => parentOf(path) === parentOf(paths[0]));
    header = (
      <div className="bt-details-title">
        <strong>{items(paths.length)} selected</strong>
        <span>{together ? `In ${displayPath(parentOf(paths[0]) ?? '/', home)}` : 'In several folders'}</span>
      </div>
    );
    body = (
      <>
        <dl className="bt-facts">
          <Fact term="Files">{files.length.toLocaleString()}</Fact>
          <Fact term="Folders">{folders.toLocaleString()}</Fact>
          <Fact term="Size">
            {formatSize(files.reduce((sum, entry) => sum + entry.size, 0))}
            {folders > 0 && <span className="bt-muted"> of the files</span>}
          </Fact>
        </dl>
        <div className="fm-details-actions">
          <button type="button" className="button" disabled={!together} onClick={() => actions.onDownload(paths)} title={together ? 'As a .tar.gz' : 'Entries of one folder at a time'}>
            Download
          </button>
          {!readOnly && (
            <>
              <button type="button" className="button" onClick={() => actions.onMove(paths, false)}>
                Move to…
              </button>
              <button type="button" className="button" onClick={() => actions.onMove(paths, true)}>
                Copy to…
              </button>
              <button type="button" className="button danger" onClick={() => actions.onDelete(paths)}>
                Delete
              </button>
            </>
          )}
        </div>
      </>
    );
  } else {
    const shown = details && details.path === single ? details : null;
    const entry = shown ?? entries.get(single) ?? null;
    const isFolder = single === folder;
    const name = baseName(single);
    header = (
      <>
        {entry && <EntryIcon entry={entry} size={18} />}
        <div className="bt-details-title">
          <strong title={single}>{name}</strong>
          <span>{entry ? typeLabel(entry) : 'Reading…'}{isFolder ? ', shown' : ''}</span>
        </div>
      </>
    );
    const modeChange = async (mode: number) => {
      setChanging(true);
      await actions.onChmod(single, mode);
      setChanging(false);
      setTick((n) => n + 1);
    };
    const type = entry ? fileType(entry) : 'other';
    body = (
      <>
        {error && <p className="fm-error">{error}</p>}
        {entry && isViewable(name) && entry.kind === 'file' && (
          <button type="button" className="fm-preview" title="Open it" onClick={() => actions.onOpen(single)}>
            <img src={fsApi.viewUrl(single, `${entry.size}-${entry.modified}`)} alt="" onError={(e) => (e.currentTarget.hidden = true)} />
          </button>
        )}
        {shown && (
          <dl className="bt-facts">
            <Fact term="Where">
              {parentOf(single) ? (
                <button type="button" className="link-button fm-inline-button" onClick={() => actions.onGo(parentOf(single)!)}>
                  {displayPath(parentOf(single)!, home)}
                </button>
              ) : (
                'The root'
              )}
            </Fact>
            {shown.kind === 'dir' ? (
              <>
                <Fact term="Holds">
                  {shown.items === null ? 'Cannot be read' : items(shown.items)}
                  {shown.hidden ? <span className="bt-muted"> ({shown.hidden} hidden)</span> : null}
                </Fact>
                <Fact term="Size">
                  <FolderSize path={single} />
                </Fact>
              </>
            ) : (
              <Fact term="Size">
                {formatSize(shown.size)}
                {shown.size >= 1000 && <span className="bt-muted"> ({shown.size.toLocaleString()} bytes)</span>}
              </Fact>
            )}
            <Fact term="Modified">
              <span title={formatFullDate(shown.modified)}>{ago(shown.modified, now)}</span>
            </Fact>
            {shown.created !== null && (
              <Fact term="Created">
                <span title={formatFullDate(shown.created)}>{ago(shown.created, now)}</span>
              </Fact>
            )}
            <Fact term="Owner">
              {shown.owner}
              <span className="bt-muted">, group {shown.group}</span>
            </Fact>
            <Fact term="Mode">
              <code>{formatMode(shown.mode, shown.kind, shown.link !== null)}</code> <span className="bt-muted">{octalMode(shown.mode)}</span>
            </Fact>
            {shown.link !== null && <Fact term="Links to">{shown.link || '?'}</Fact>}
            {shown.realPath && <Fact term="Is at">{displayPath(shown.realPath, home)}</Fact>}
            {shown.space && (
              <Fact term="Disk">
                {formatSize(shown.space.free)} free of {formatSize(shown.space.total)}
                <span className="bt-muted"> on {shown.space.mount}</span>
              </Fact>
            )}
            {!shown.writable && <Fact term="Access">{shown.readable ? 'Read only, for the server’s user' : 'Not readable by the server’s user'}</Fact>}
          </dl>
        )}
        {shown && shown.kind !== 'other' && (
          <section>
            <h3>Permissions</h3>
            <Permissions details={shown} disabled={readOnly || changing} onChange={(mode) => void modeChange(mode)} />
          </section>
        )}
        {entry && (
          <div className="fm-details-actions">
            {!isFolder && (
              <button type="button" className="button primary" onClick={() => actions.onOpen(single)}>
                {entry.kind === 'dir' ? 'Open' : type === 'text' ? 'Edit' : type === 'image' ? 'View' : 'Open as text'}
              </button>
            )}
            {entry.kind !== 'other' && (
              <button type="button" className="button" onClick={() => actions.onDownload([single])} title={entry.kind === 'dir' ? 'As a .tar.gz' : undefined}>
                Download
              </button>
            )}
            {!readOnly && !isFolder && (
              <>
                <button type="button" className="button" onClick={() => actions.onRename(single)}>
                  Rename
                </button>
                <button type="button" className="button danger" onClick={() => actions.onDelete([single])}>
                  Delete
                </button>
              </>
            )}
          </div>
        )}
      </>
    );
  }

  return (
    <section className="bt-details fm-details" aria-label="Details">
      <header className="bt-details-header">
        {header}
        <button type="button" className="icon-button" aria-label="Close the details" title="Close (Esc)" onClick={onClose}>
          <CloseIcon width={16} height={16} />
        </button>
      </header>
      <div className="bt-details-body">{body}</div>
    </section>
  );
}
