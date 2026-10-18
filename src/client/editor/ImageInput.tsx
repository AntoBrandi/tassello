// The image properties: a path on the robot, typed or picked by browsing its
// directories, or an image uploaded from this device (kept by the server).

import { useEffect, useRef, useState, type ReactNode } from 'react';

import { api, imageUrl, type DirectoryListing } from '../api.ts';
import { Modal } from '../dialogs.tsx';
import { notify } from '../notifications.tsx';

interface InputProps {
  id: string;
  value: string;
  placeholder?: string;
  onCommit: (value: string) => void;
}

export function ImageInput({
  children,
  ...input
}: InputProps & { children: (props: InputProps) => ReactNode }) {
  const [browsing, setBrowsing] = useState(false);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const url = imageUrl(input.value);

  const upload = async (file: File | undefined) => {
    if (!file) {
      return;
    }
    setUploading(true);
    try {
      input.onCommit(await api.uploadImage(file));
    } catch (e) {
      notify(`Could not upload ${file.name}: ${e instanceof Error ? e.message : e}`, 'error');
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="image-input">
      {children({ ...input, placeholder: input.placeholder ?? '~/pictures/map.png' })}
      <div className="image-input-actions">
        <button type="button" className="button" onClick={() => setBrowsing(true)}>
          Browse the robot…
        </button>
        <button type="button" className="button" disabled={uploading} onClick={() => fileRef.current?.click()}>
          {uploading ? 'Uploading…' : 'Upload…'}
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
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
          className="image-input-preview"
          src={url}
          alt=""
          // A path still being typed, or a file that is gone
          onError={(e) => (e.currentTarget.hidden = true)}
        />
      )}
      {browsing && (
        <FileBrowser
          start={input.value.startsWith('/') || input.value.startsWith('~/') ? input.value : '~'}
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

// The robot's directories and images, from start (a directory, or a file in it)
function FileBrowser({
  start,
  onChoose,
  onClose,
}: {
  start: string;
  onChoose: (file: string) => void;
  onClose: () => void;
}) {
  const [dir, setDir] = useState(/\.[A-Za-z]+$/.test(start) ? start.replace(/\/[^/]*$/, '') || '/' : start);
  const [listing, setListing] = useState<DirectoryListing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  // A directory was listed: a failure after it is no reason to go home
  const listed = useRef(false);

  useEffect(() => {
    let current = true;
    setError(null);
    setSelected(null);
    api.listFiles(dir).then(
      (result) => {
        if (current) {
          listed.current = true;
          setListing(result);
        }
      },
      (e: unknown) => {
        if (current) {
          setError(e instanceof Error ? e.message : String(e));
          // A start that is gone: home instead
          if (!listed.current && dir !== '~') {
            setDir('~');
          }
        }
      },
    );
    return () => {
      current = false;
    };
  }, [dir]);

  const join = (name: string) => `${listing!.dir.replace(/\/$/, '')}/${name}`;

  return (
    <Modal title="Choose an image of the robot" onClose={onClose} wide>
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
          <code title={listing?.dir}>{listing?.dir ?? dir}</code>
        </div>
        {error && <p className="field-help error">{error}</p>}
        <div className="file-browser-body">
          <ul className="file-browser-list">
            {listing?.entries.length === 0 && <li className="file-browser-empty">No folder nor image here</li>}
            {listing?.entries.map((entry) => (
              <li key={entry.name}>
                <button
                  type="button"
                  className={`file-browser-entry${selected === join(entry.name) ? ' selected' : ''}`}
                  onClick={() => (entry.kind === 'dir' ? setDir(join(entry.name)) : setSelected(join(entry.name)))}
                  onDoubleClick={() => entry.kind === 'image' && onChoose(join(entry.name))}
                >
                  <span aria-hidden="true">{entry.kind === 'dir' ? '📁' : '🖼'}</span>
                  {entry.name}
                </button>
              </li>
            ))}
          </ul>
          <div className="file-browser-preview">
            {selected ? <img src={imageUrl(selected) ?? ''} alt={selected} /> : <span>Select an image to preview it</span>}
          </div>
        </div>
        <div className="modal-actions">
          <button type="button" className="button" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="button primary" disabled={!selected} onClick={() => selected && onChoose(selected)}>
            Choose
          </button>
        </div>
      </div>
    </Modal>
  );
}
