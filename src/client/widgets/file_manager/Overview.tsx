// The file manager's overview: the robot's disks, their size, use and free
// space (and of their inodes, when they run short), and what takes the space
// of the folder shown, analyzed on demand: its largest entries, its files by
// type, the largest and the latest files anywhere under it.

import { useState } from 'react';

import type { FsAnalysis, FsDisk } from '../../../shared/file_manager.ts';
import { fsApi } from '../../api.ts';
import { HardDriveIcon, PieChartIcon, RefreshIcon } from '../../icons.tsx';
import { ago, baseName, counted, displayPath, formatSize, joinPath, parentOf, usageTone } from './model.ts';
import { UsageBar } from './parts.tsx';

// Of the page: analyses are long, kept by folder
const analyses = new Map<string, { result: FsAnalysis; at: number }>();

function share(part: number, whole: number): string {
  return whole > 0 ? `${Math.round((part / whole) * 100)}%` : '';
}

function Bars({
  rows,
  onPick,
}: {
  rows: { key: string; label: string; size: number; note: string }[];
  onPick?: (key: string) => void;
}) {
  const largest = Math.max(1, ...rows.map((row) => row.size));
  return (
    <ul className="fm-bars">
      {rows.map((row) => (
        <li key={row.key}>
          <button type="button" className="fm-bar-row" disabled={!onPick} onClick={() => onPick?.(row.key)} title={row.label}>
            <span className="fm-bar-label">{row.label}</span>
            <span className="fm-bar-size">{formatSize(row.size)}</span>
            <span className="fm-bar-note">{row.note}</span>
            <span className="fm-bar">
              <span style={{ width: `${(row.size / largest) * 100}%` }} />
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

export function Overview({
  folder,
  home,
  disks,
  now,
  onGo,
  onReveal,
  onRefreshDisks,
}: {
  folder: string;
  home: string;
  // null: not shown (the widget confined to a folder)
  disks: FsDisk[] | null;
  now: number;
  onGo: (folder: string) => void;
  // A file: its folder shown, it selected
  onReveal: (path: string) => void;
  onRefreshDisks: () => void;
}) {
  const [analysis, setAnalysis] = useState(() => analyses.get(folder) ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [shownFor, setShownFor] = useState(folder);
  if (shownFor !== folder) {
    setShownFor(folder);
    setAnalysis(analyses.get(folder) ?? null);
    setError(null);
  }

  const analyze = () => {
    setBusy(true);
    setError(null);
    fsApi.analyze(folder).then(
      (result) => {
        const kept = { result, at: Date.now() };
        analyses.set(result.path, kept);
        if (result.path === folder) {
          setAnalysis(kept);
        }
        setBusy(false);
      },
      (e: unknown) => {
        setError(e instanceof Error ? e.message : String(e));
        setBusy(false);
      },
    );
  };

  const result = analysis?.result;
  return (
    <div className="fm-overview">
      {disks && (
        <section>
          <h3>
            Disks
            <button type="button" className="icon-button fm-heading-button" aria-label="Read the disks again" title="Read again" onClick={onRefreshDisks}>
              <RefreshIcon width={14} height={14} />
            </button>
          </h3>
          <ul className="fm-disks">
            {disks.map((disk) => {
              const size = disk.used + disk.free;
              const inodes = disk.inodes && disk.inodes.total > 0 ? disk.inodes : null;
              const inodesUsed = inodes ? inodes.total - inodes.free : 0;
              return (
                <li key={disk.mount}>
                  <button type="button" className={`fm-disk-card ${usageTone(disk.used, size)}`} onClick={() => onGo(disk.mount)} title={`Go to ${disk.mount}`}>
                    <span className="fm-disk-head">
                      <HardDriveIcon width={16} height={16} />
                      <strong>{disk.mount}</strong>
                      <span className="bt-muted">
                        {disk.device} · {disk.type}
                        {disk.readOnly ? ' · read-only' : ''}
                      </span>
                    </span>
                    <UsageBar used={disk.used} total={size} />
                    <span className="fm-disk-numbers">
                      <span>
                        <strong>{formatSize(disk.free)}</strong> free of {formatSize(disk.total)}
                      </span>
                      <span>
                        {formatSize(disk.used)} used, {share(disk.used, size)}
                      </span>
                    </span>
                    {inodes && usageTone(inodesUsed, inodes.total) !== 'ok' && (
                      <span className="fm-error">
                        {share(inodesUsed, inodes.total)} of its inodes used: {counted(inodes.free, 'file')} more at most
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      )}
      <section>
        <h3>This folder</h3>
        <p className="fm-overview-path">{displayPath(folder, home)}</p>
        {!result && (
          <p className="bt-muted fm-overview-hint">What takes its space: its largest entries, its files by type, the largest and the latest files under it.</p>
        )}
        <div className="fm-analyze">
          <button type="button" className={`button${result ? '' : ' primary'}`} disabled={busy} onClick={analyze}>
            <PieChartIcon width={16} height={16} />
            {busy ? 'Analyzing…' : result ? 'Analyze again' : 'Analyze this folder'}
          </button>
          {analysis && !busy && <span className="bt-muted">Analyzed {ago(analysis.at, now)}</span>}
        </div>
        {error && <p className="fm-error">{error}</p>}
        {result && (
          <>
            <p className="fm-summary">
              <strong>{formatSize(result.size)}</strong> in {counted(result.files, 'file')} and {counted(result.folders, 'folder')}
              <span className="bt-muted">
                {' '}
                ({formatSize(result.disk)} on the disk
                {result.links > 0 ? `, ${counted(result.links, 'link')} not followed` : ''})
              </span>
            </p>
            {(result.partial || result.unreadable > 0 || result.mounts > 0) && (
              <p className="fm-error">
                {[
                  result.partial && `${result.partial}: at least as much`,
                  result.unreadable > 0 && `${counted(result.unreadable, 'folder')} not readable`,
                  result.mounts > 0 && `${counted(result.mounts, 'other disk')} left out`,
                ]
                  .filter(Boolean)
                  .join('; ')}
              </p>
            )}
            {result.children.length > 0 && (
              <>
                <h4>Largest inside</h4>
                <Bars
                  rows={result.children
                    .filter((child) => child.size > 0)
                    .slice(0, 12)
                    .map((child) => ({
                      key: child.name,
                      label: `${child.name}${child.kind === 'dir' ? '/' : ''}`,
                      size: child.size,
                      note: `${share(child.size, result.size)}${child.kind === 'dir' ? ` · ${counted(child.files, 'file')}` : ''}`,
                    }))}
                  onPick={(name) => {
                    const child = result.children.find((entry) => entry.name === name);
                    const path = joinPath(result.path, name);
                    if (child?.kind === 'dir') {
                      onGo(path);
                    } else {
                      onReveal(path);
                    }
                  }}
                />
              </>
            )}
            {result.types.length > 0 && (
              <>
                <h4>By type</h4>
                <Bars
                  rows={result.types.map((type) => ({
                    key: type.type,
                    label: type.type ? type.type.slice(1) : 'No extension',
                    size: type.size,
                    note: `${share(type.size, result.size)} · ${counted(type.files, 'file')}`,
                  }))}
                />
              </>
            )}
            {result.largest.length > 0 && (
              <>
                <h4>Largest files</h4>
                <ul className="fm-file-list">
                  {result.largest.map((file) => (
                    <li key={file.path}>
                      <button type="button" className="fm-file-row" title={file.path} onClick={() => onReveal(joinPath(result.path, file.path))}>
                        <span className="fm-bar-label">{baseName(file.path)}</span>
                        <span className="bt-muted fm-file-where">{file.path.includes('/') ? parentOf(file.path) : ''}</span>
                        <span className="fm-bar-size">{formatSize(file.size)}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            )}
            {result.recent.length > 0 && (
              <>
                <h4>Latest changes</h4>
                <ul className="fm-file-list">
                  {result.recent.map((file) => (
                    <li key={file.path}>
                      <button type="button" className="fm-file-row" title={file.path} onClick={() => onReveal(joinPath(result.path, file.path))}>
                        <span className="fm-bar-label">{baseName(file.path)}</span>
                        <span className="bt-muted fm-file-where">{file.path.includes('/') ? parentOf(file.path) : ''}</span>
                        <span className="fm-bar-size">{ago(file.modified, now)}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </>
        )}
      </section>
    </div>
  );
}
