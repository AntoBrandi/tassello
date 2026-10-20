// The file manager's status line, as the behavior tree editor's: of the
// folder shown, its entries, those selected and the space left on its disk;
// of a text file, whether it is saved, the caret's line and column, and its
// highlighting, indentation and line ends, switched there; of an image, its
// size; or how far an upload is, to cancel it.

import { useMemo } from 'react';

import type { FsEntry, FsListing } from '../../../shared/file_manager.ts';
import { LANGUAGES, type Language } from './highlight.ts';
import { baseName, formatSize, isHidden, items, usageTone } from './model.ts';
import { isDirty, type TextTab } from './session.ts';
import { lineAt, lineStarts, type Eol, type Indent } from './text_edit.ts';

export interface UploadProgress {
  // The file being sent, the how many-th of how many
  name: string;
  index: number;
  count: number;
  // Bytes, of them all
  sent: number;
  total: number;
  abort: () => void;
}

const INDENTS: { value: Indent; label: string }[] = [
  { value: 2, label: 'Spaces: 2' },
  { value: 3, label: 'Spaces: 3' },
  { value: 4, label: 'Spaces: 4' },
  { value: 8, label: 'Spaces: 8' },
  { value: 'tab', label: 'Tabs' },
];

function TextTools({
  tab,
  readOnly,
  onSettings,
}: {
  tab: TextTab & { text: string };
  readOnly: boolean;
  onSettings: (settings: { language?: Language; indent?: Indent; eol?: Eol }) => void;
}) {
  const starts = useMemo(() => lineStarts(tab.text), [tab.text]);
  const line = lineAt(starts, tab.selection.end);
  const selected = Math.abs(tab.selection.end - tab.selection.start);
  return (
    <span className="fm-status-tools">
      <span className="fm-status-caret">
        Ln {(line + 1).toLocaleString()}, Col {tab.selection.end - starts[line] + 1}
        {selected > 0 ? ` (${selected.toLocaleString()} selected)` : ''}
      </span>
      <select
        className="fm-status-select"
        aria-label="Highlighting"
        value={tab.language}
        onChange={(e) => onSettings({ language: e.target.value as Language })}
      >
        {LANGUAGES.map(({ id, label }) => (
          <option key={id} value={id}>
            {label}
          </option>
        ))}
      </select>
      <select
        className="fm-status-select"
        aria-label="Indentation"
        value={String(tab.indent)}
        onChange={(e) => onSettings({ indent: (e.target.value === 'tab' ? 'tab' : Number(e.target.value)) as Indent })}
      >
        {INDENTS.map(({ value, label }) => (
          <option key={value} value={String(value)}>
            {label}
          </option>
        ))}
      </select>
      <select
        className="fm-status-select"
        aria-label="Line ends"
        value={tab.eol}
        disabled={readOnly}
        onChange={(e) => onSettings({ eol: e.target.value === '\r\n' ? '\r\n' : '\n' })}
      >
        <option value={'\n'}>LF</option>
        <option value={'\r\n'}>CRLF</option>
      </select>
    </span>
  );
}

export function StatusLine({
  uploads,
  textTab,
  saving,
  image,
  folder,
  readOnly,
  onSettings,
}: {
  uploads: UploadProgress | null;
  // The tab shown, a text file's or an image's (with its size, once known)
  textTab: TextTab | null;
  saving: boolean;
  image: { path: string; size: string } | null;
  // Else the files
  folder: {
    path: string;
    listing: FsListing | null;
    error: string | null;
    offline: boolean;
    // The entries shown, those hidden not
    shown: number;
    showHidden: boolean;
    selected: number;
    // Those selected known
    entries: FsEntry[];
  };
  readOnly: boolean;
  onSettings: (settings: { language?: Language; indent?: Indent; eol?: Eol }) => void;
}) {
  let status: { text: string; tone: string; title?: string };
  let extra = null;
  if (uploads) {
    const share = uploads.total > 0 ? Math.round((uploads.sent / uploads.total) * 100) : 100;
    status = {
      text: `Uploading ${uploads.name}${uploads.count > 1 ? ` (${uploads.index + 1} of ${uploads.count})` : ''} · ${share}%`,
      tone: 'running',
    };
    extra = (
      <button type="button" className="link-button fm-status-action" onClick={uploads.abort}>
        Cancel
      </button>
    );
  } else if (textTab) {
    const name = baseName(textTab.path);
    status = saving
      ? { text: `Saving ${name}…`, tone: 'running' }
      : textTab.text === null
        ? { text: name, tone: textTab.error ? 'error' : 'idle' }
        : isDirty(textTab)
          ? { text: `${name} · changed`, tone: 'changed' }
          : textTab.readOnly
            ? { text: `${name} · read-only: ${textTab.readOnly}`, tone: 'idle' }
            : { text: `${name} · saved`, tone: 'success' };
    status.title = textTab.path;
    if (textTab.text !== null) {
      extra = <TextTools tab={textTab as TextTab & { text: string }} readOnly={readOnly} onSettings={onSettings} />;
    }
  } else if (image) {
    status = { text: `${baseName(image.path)}${image.size ? ` · ${image.size}` : ''}`, tone: 'idle', title: image.path };
  } else if (folder.error) {
    status = { text: folder.error, tone: 'error' };
  } else if (!folder.listing) {
    status = { text: folder.offline ? 'Cannot reach the robot' : 'Reading…', tone: 'idle' };
  } else {
    const { listing } = folder;
    const hidden = listing.entries.filter((entry) => isHidden(entry.name)).length;
    const parts = [`${items(folder.shown)}${!folder.showHidden && hidden > 0 ? `, ${hidden} hidden` : ''}`];
    if (folder.selected > 0) {
      const files = folder.entries.filter((entry) => entry.kind === 'file');
      const size = files.reduce((sum, entry) => sum + entry.size, 0);
      parts.push(`${folder.selected.toLocaleString()} selected${files.length > 0 ? `, ${formatSize(size)}` : ''}`);
    }
    if (!listing.writable) {
      parts.push('read-only');
    }
    status = { text: parts.join(' · '), tone: 'idle', title: folder.path };
    const { space } = listing;
    if (space) {
      extra = (
        <span
          className={`fm-status-space ${usageTone(space.total - space.free, space.total)}`}
          title={`${formatSize(space.free)} free of ${formatSize(space.total)} on ${space.mount}`}
        >
          {formatSize(space.free)} free
        </span>
      );
    }
  }

  return (
    <div className={`bt-status ${status.tone}`} title={status.title ?? status.text}>
      <span className="bt-dot" aria-hidden="true" />
      <span className="bt-status-text">{status.text}</span>
      {extra}
    </div>
  );
}
