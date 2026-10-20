// The file properties, images and behavior trees: a path on the robot, typed
// or picked by browsing its directories, or a file uploaded from this device
// (kept by the server). The browser also picks rosbags and folders.

import { useEffect, useRef, useState, type ReactNode } from 'react';

import { api, imageUrl, type DirectoryListing, type FileKind } from '../api.ts';
import { Modal } from '../dialogs.tsx';
import { notify } from '../notifications.tsx';

interface InputProps {
  id: string;
  value: string;
  placeholder?: string;
  onCommit: (value: string) => void;
}

// What differs between the kinds of file
const KINDS: Record<FileKind, { title: string; none: string; icon: string }> = {
  image: { title: 'Choose an image of the robot', none: 'No folder nor image here', icon: '🖼' },
  'behavior-tree': { title: 'Choose a behavior tree of the robot', none: 'No folder nor XML file here', icon: '🌳' },
  bag: { title: 'Choose a rosbag of the robot', none: 'No folder nor rosbag here', icon: '🎞' },
  folder: { title: 'Choose a folder of the robot', none: 'No folder here', icon: '📁' },
};

// Of the properties' kinds
const INPUTS = {
  image: { placeholder: '~/pictures/map.png', accept: 'image/*' },
  'behavior-tree': { placeholder: 'package://my_robot/behavior_trees/main.xml', accept: '.xml,text/xml,application/xml' },
};

export function FileInput({
  kind,
  children,
  ...input
}: InputProps & { kind: keyof typeof INPUTS; children: (props: InputProps) => ReactNode }) {
  const [browsing, setBrowsing] = useState(false);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const url = kind === 'image' ? imageUrl(input.value) : null;

  const upload = async (file: File | undefined) => {
    if (!file) {
      return;
    }
    setUploading(true);
    try {
      input.onCommit(await api.uploadFile(file));
    } catch (e) {
      notify(`Could not upload ${file.name}: ${e instanceof Error ? e.message : e}`, 'error');
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="file-input">
      {children({ ...input, placeholder: input.placeholder ?? INPUTS[kind].placeholder })}
      <div className="file-input-actions">
        <button type="button" className="button" onClick={() => setBrowsing(true)}>
          Browse the robot…
        </button>
        <button type="button" className="button" disabled={uploading} onClick={() => fileRef.current?.click()}>
          {uploading ? 'Uploading…' : 'Upload…'}
        </button>
        <input
          ref={fileRef}
          type="file"
          accept={INPUTS[kind].accept}
          hidden
          onChange={(e) => {
            void upload(e.target.files?.[0]);
            e.target.value = '';
          }}
        />
      </div>
      {url && (
        <img
          key={url}
          className="file-input-preview"
          src={url}
          alt=""
          // A path still being typed, or a file that is gone
          onError={(e) => (e.currentTarget.hidden = true)}
        />
      )}
      {browsing && (
        <FileBrowser
          kind={kind}
          start={input.value}
          onChoose={(file) => {
            setBrowsing(false);
            input.onCommit(file);
          }}
          onClose={() => setBrowsing(false)}
        />
      )}
    </div>
  );
}

// The robot's directories and files of the kind, from start (a directory, or
// a file in it; home if not a path). Folders are chosen by going into them.
// Resizable, for long names; which scroll sideways anyway.
export function FileBrowser({
  kind,
  start,
  onChoose,
  onClose,
}: {
  kind: FileKind;
  start: string;
  onChoose: (path: string) => void;
  onClose: () => void;
}) {
  const [dir, setDir] = useState(() => {
    if (!start.startsWith('/') && !start.startsWith('~/')) {
      return '~';
    }
    return kind !== 'folder' && /\.[A-Za-z0-9]+$/.test(start) ? start.replace(/\/[^/]*$/, '') || '/' : start;
  });
  const [listing, setListing] = useState<DirectoryListing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  // A directory was listed: a failure after it is no reason to go home
  const listed = useRef(false);
  const { title, none, icon } = KINDS[kind];
  const preview = kind === 'image';
  const folders = kind === 'folder';

  useEffect(() => {
    let current = true;
    setError(null);
    setSelected(null);
    api.listFiles(dir, kind).then(
      (result) => {
        if (current) {
          listed.current = true;
          setListing(result);
        }
      },
      (e: unknown) => {
        if (current) {
          setError(e instanceof Error ? e.message : String(e));
          // A start that is gone: its parent, or home
          if (!listed.current && dir !== '~') {
            setDir(folders && dir.lastIndexOf('/') > 0 ? dir.replace(/\/[^/]*$/, '') : '~');
          }
        }
      },
    );
    return () => {
      current = false;
    };
  }, [dir, kind, folders]);

  const join = (name: string) => `${listing!.dir.replace(/\/$/, '')}/${name}`;
  const chosen = folders ? (listing?.dir ?? null) : selected;

  return (
    <Modal title={title} onClose={onClose} wide resizable>
      <div className="modal-body file-browser">
        <div className="file-browser-path">
          <button
            type="button"
            className="button"
            disabled={!listing?.parent}
            onClick={() => listing?.parent && setDir(listing.parent)}
          >
            Up
          </button>
          <code>{listing?.dir ?? dir}</code>
        </div>
        {error && <p className="field-help error">{error}</p>}
        <div className={`file-browser-body${preview ? '' : ' single'}`}>
          <ul className="file-browser-list">
            {listing?.entries.length === 0 && <li className="file-browser-empty">{none}</li>}
            {listing?.entries.map((entry) => (
              <li key={entry.name}>
                <button
                  type="button"
                  title={entry.name}
                  className={`file-browser-entry${selected === join(entry.name) ? ' selected' : ''}`}
                  onClick={() => (entry.kind === 'dir' ? setDir(join(entry.name)) : setSelected(join(entry.name)))}
                  onDoubleClick={() => entry.kind !== 'dir' && onChoose(join(entry.name))}
                >
                  <span aria-hidden="true">{entry.kind === 'dir' ? '📁' : icon}</span>
                  {entry.name}
                </button>
              </li>
            ))}
          </ul>
          {preview && (
            <div className="file-browser-preview">
              {selected ? <img src={imageUrl(selected) ?? ''} alt={selected} /> : <span>Select an image to preview it</span>}
            </div>
          )}
        </div>
        <p className="file-browser-chosen">{chosen ?? 'Nothing selected'}</p>
        <div className="modal-actions">
          <button type="button" className="button" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="button primary" disabled={!chosen} onClick={() => chosen && onChoose(chosen)}>
            {folders ? 'Choose this folder' : 'Choose'}
          </button>
        </div>
      </div>
    </Modal>
  );
}
