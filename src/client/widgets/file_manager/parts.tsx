// What the file manager's views share: the menus of the entries, the dialog
// asking what to do with the names taken, the "Save as" dialog, and the bars
// of the disks' use.

import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';

import type { FsConflict } from '../../../shared/file_manager.ts';
import { ApiError, fsApi } from '../../api.ts';
import { Modal } from '../../dialogs.tsx';
import { FileBrowser } from '../../editor/FileInput.tsx';
import { baseName, formatSize, listNames, parentOf, usageTone } from './model.ts';

export interface MenuItem {
  label: string;
  run: () => void;
  disabled?: boolean;
  danger?: boolean;
  // A line above it
  separated?: boolean;
  keys?: string;
  // Only when the toolbar has no room for it
  narrow?: boolean;
}

// A menu where the pointer is, kept in the window
export function ContextMenu({ x, y, items, onClose }: { x: number; y: number; items: MenuItem[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState({ left: x, top: y });
  useLayoutEffect(() => {
    const menu = ref.current;
    if (!menu) {
      return;
    }
    const { width, height } = menu.getBoundingClientRect();
    setPlace({
      left: Math.max(4, Math.min(x, window.innerWidth - width - 4)),
      top: Math.max(4, y + height > window.innerHeight - 4 ? y - height : y),
    });
    menu.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({ preventScroll: true });
  }, [x, y]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);
  return (
    <>
      <div
        className="menu-backdrop"
        onPointerDown={onClose}
        onContextMenu={(e) => {
          e.preventDefault();
          onClose();
        }}
      />
      <div
        ref={ref}
        className="menu-list fm-menu"
        role="menu"
        style={place}
        onKeyDown={(event) => {
          // Up and down the items
          if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') {
            return;
          }
          event.preventDefault();
          const buttons = [...(ref.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])];
          const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
          buttons[(index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus();
        }}
      >
        {items.map((item) => (
          <button
            key={item.label}
            type="button"
            role="menuitem"
            className={`${item.danger ? 'danger' : ''}${item.separated ? ' separated' : ''}${item.narrow ? ' bte-narrow' : ''}`}
            disabled={item.disabled}
            onClick={() => {
              onClose();
              item.run();
            }}
          >
            <span>{item.label}</span>
            {item.keys && <kbd>{item.keys}</kbd>}
          </button>
        ))}
      </div>
    </>
  );
}

export interface ConflictQuestion {
  names: string[];
  folder: string;
  // What is done: moved, copied, uploaded
  verb: string;
  resolve: (choice: Exclude<FsConflict, 'ask'> | null) => void;
}

export function ConflictDialog({ question, onDone }: { question: ConflictQuestion; onDone: () => void }) {
  const { names, folder, verb, resolve } = question;
  const answer = (choice: Exclude<FsConflict, 'ask'> | null) => {
    resolve(choice);
    onDone();
  };
  const one = names.length === 1;
  return (
    <Modal title={one ? `${names[0]} exists already` : `${names.length} names are taken`} onClose={() => answer(null)}>
      <div className="modal-body">
        <div className="dialog-message">
          {one ? 'There is' : 'There are'} <strong>{listNames(names)}</strong> in <code>{baseName(folder)}</code> already, where{' '}
          {one ? 'it is' : 'they are'} {verb}.
          <ul className="fm-choices">
            <li>
              <strong>Replace</strong>: what is there is deleted{one ? '' : ', folders with all they hold'}
            </li>
            <li>
              <strong>Keep both</strong>: the new {one ? 'one gets' : 'ones get'} a number after the name, “name (2).ext”
            </li>
            <li>
              <strong>Skip</strong>: {one ? 'it is' : 'they are'} not {verb}
            </li>
          </ul>
        </div>
        <div className="modal-actions">
          <button type="button" className="button" onClick={() => answer(null)}>
            Cancel
          </button>
          <button type="button" className="button" onClick={() => answer('skip')}>
            Skip
          </button>
          <button type="button" className="button" onClick={() => answer('keep-both')} autoFocus>
            Keep both
          </button>
          <button type="button" className="button danger" onClick={() => answer('replace')}>
            Replace
          </button>
        </div>
      </div>
    </Modal>
  );
}

// Where to save a text: resolves with the path and its version, once saved
export function SaveAsDialog({
  initial,
  text,
  onSaved,
  onClose,
}: {
  initial: string;
  text: string;
  onSaved: (path: string, version: string, stamp: string) => void;
  onClose: () => void;
}) {
  const id = useId();
  const [path, setPath] = useState(initial);
  const [browsing, setBrowsing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<{ message: string; exists: boolean } | null>(null);
  const valid = /^(\/|~\/).*[^/]$/.test(path.trim());

  const save = async (replace: boolean) => {
    const target = path.trim();
    setSaving(true);
    setError(null);
    try {
      const result = await fsApi.saveText(target, text, null, !replace);
      onSaved(target, result.version, result.stamp);
    } catch (e) {
      setError({ message: e instanceof Error ? e.message : String(e), exists: e instanceof ApiError && e.status === 409 });
      setSaving(false);
    }
  };

  return (
    <>
      <Modal title="Save as" onClose={onClose} wide>
        <form
          className="modal-body"
          onSubmit={(e) => {
            e.preventDefault();
            void save(false);
          }}
        >
          <div className="field">
            <label className="field-label" htmlFor={id}>
              File on the robot
            </label>
            <div className="bt-record-path">
              <input
                id={id}
                value={path}
                spellCheck={false}
                autoFocus
                onChange={(e) => {
                  setPath(e.target.value);
                  setError(null);
                }}
              />
              <button type="button" className="button" onClick={() => setBrowsing(true)}>
                Browse…
              </button>
            </div>
            <p className="field-help">/…, ~/…: its folder must exist</p>
            {error && <p className="field-help error">{error.message}</p>}
          </div>
          <div className="modal-actions">
            <button type="button" className="button" onClick={onClose}>
              Cancel
            </button>
            {error?.exists && (
              <button type="button" className="button danger" disabled={saving} onClick={() => void save(true)}>
                Replace it
              </button>
            )}
            <button type="submit" className="button primary" disabled={saving || !valid}>
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </form>
      </Modal>
      {browsing && (
        <FileBrowser
          kind="folder"
          start={parentOf(path.trim()) ?? '~'}
          onChoose={(folder) => {
            setBrowsing(false);
            setPath(`${folder.replace(/\/+$/, '')}/${baseName(path.trim()) || 'untitled.txt'}`);
          }}
          onClose={() => setBrowsing(false)}
        />
      )}
    </>
  );
}

// A disk's use, coloured as it fills
export function UsageBar({ used, total }: { used: number; total: number }) {
  const share = total > 0 ? Math.min(1, used / total) : 0;
  return (
    <span
      className={`fm-usage ${usageTone(used, total)}`}
      role="meter"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(share * 100)}
      title={`${formatSize(used)} used of ${formatSize(total)}`}
    >
      <span style={{ width: `${share * 100}%` }} />
    </span>
  );
}
