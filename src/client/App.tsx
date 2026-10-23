// The dashboard: a top bar (panel, mode, edit tools) over the current panel's
// board. The panel shown is the one in the URL (#/<panel id>), so that a panel
// can be bookmarked. In edit mode every change is saved on the fly, and can be
// undone.
//
// The board shows the layout of the window's kind of device (desktop, tablet,
// phone: see board/layouts.ts). Edit mode can show and arrange those of the
// others, at their width.
//
// A panel is exported as its file, the layouts of every device included, and
// files are imported as new panels (see panel_files.ts).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { Device, Panel, PanelSummary, Rect, WidgetInstance } from '../shared/panel.ts';
import { api } from './api.ts';
import { Board } from './board/Board.tsx';
import { freeSpot } from './board/geometry.ts';
import { DEVICES, deviceFor, fits, layoutFor, withHidden, withoutLayout, withRect } from './board/layouts.ts';
import { connection, useConnectionStatus } from './connection.ts';
import { useDialogs } from './dialogs.tsx';
import { PropertiesPanel } from './editor/PropertiesPanel.tsx';
import { WidgetPalette } from './editor/WidgetPalette.tsx';
import {
  DesktopIcon,
  EyeIcon,
  MoreIcon,
  PencilIcon,
  PhoneIcon,
  PlusIcon,
  TasselloIcon,
  TabletIcon,
  UndoIcon,
} from './icons.tsx';
import { notify, Notifications } from './notifications.tsx';
import { freeName, panelFile, panelFileName, panelFileText, readPanelFile } from './panel_files.ts';
import { widgetDefinition } from './widgets/registry.ts';
import type { RegisteredWidget } from './widgets/types.ts';

type Mode = 'view' | 'edit';
type SaveState = 'saved' | 'saving' | 'failed';

const SAVE_DELAY_MS = 500;
const UNDO_LIMIT = 50;
// Desktop columns for the widgets added while another device's layout is shown
const DESKTOP_COLUMNS = 18;
const DEVICE_ICONS = { desktop: DesktopIcon, tablet: TabletIcon, phone: PhoneIcon };

const minSize = (type: string) => widgetDefinition(type)?.minSize ?? { w: 1, h: 1 };

// The window's kind of device, as it is resized or turned
function useWindowDevice(): Device {
  const [device, setDevice] = useState(() => deviceFor(window.innerWidth));
  useEffect(() => {
    const onResize = () => setDevice(deviceFor(window.innerWidth));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return device;
}

function hashPanelId(): string {
  return decodeURIComponent(location.hash.replace(/^#\/?/, ''));
}

function showPanel(id: string, replace = false): void {
  const url = `#/${encodeURIComponent(id)}`;
  if (replace) {
    history.replaceState(null, '', url);
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  } else {
    location.hash = url;
  }
}

// Within WIDGET_ID_PATTERN: plugins' types may have dots, slashes, @
function newWidgetId(type: string): string {
  const base = type.replace(/[^A-Za-z0-9_-]+/g, '-').slice(-48);
  return `${base}-${Math.random().toString(36).slice(2, 8)}`;
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function download(name: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Saves the panel shortly after the last change, one save at a time, in order
function usePanelSaver() {
  const [state, setState] = useState<SaveState>('saved');
  const pending = useRef<Panel | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const chain = useRef<Promise<void>>(Promise.resolve());

  const flush = useCallback((): Promise<void> => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    const panel = pending.current;
    pending.current = null;
    if (panel) {
      chain.current = chain.current.then(() =>
        api.savePanel(panel).then(
          () => {
            if (!pending.current) {
              setState('saved');
            }
          },
          (e: unknown) => {
            setState('failed');
            notify(`Could not save “${panel.name}”: ${errorText(e)}`, 'error');
          },
        ),
      );
    }
    return chain.current;
  }, []);

  const schedule = useCallback(
    (panel: Panel) => {
      pending.current = panel;
      setState('saving');
      if (timer.current) {
        clearTimeout(timer.current);
      }
      timer.current = setTimeout(flush, SAVE_DELAY_MS);
    },
    [flush],
  );

  // Leaving the page: the last changes go out anyway
  useEffect(() => {
    const onHide = () => {
      const panel = pending.current;
      if (panel) {
        pending.current = null;
        fetch(`/api/panels/${encodeURIComponent(panel.id)}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(panel),
          keepalive: true,
        });
      }
    };
    window.addEventListener('pagehide', onHide);
    return () => window.removeEventListener('pagehide', onHide);
  }, []);

  const actions = useMemo(
    () => ({ schedule, flush, isPending: () => pending.current !== null }),
    [schedule, flush],
  );
  return [state, actions] as const;
}

export function App() {
  const status = useConnectionStatus();
  const dialogs = useDialogs();
  const [saveState, saver] = usePanelSaver();

  const [panels, setPanels] = useState<PanelSummary[] | null>(null);
  const [panelId, setPanelId] = useState(hashPanelId);
  const panelIdRef = useRef(panelId);
  panelIdRef.current = panelId;
  const [panel, setPanelState] = useState<Panel | null>(null);
  const panelRef = useRef<Panel | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>('view');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const importRef = useRef<HTMLInputElement>(null);
  const undoStack = useRef<Panel[]>([]);
  const [canUndo, setCanUndo] = useState(false);
  const visibleCols = useRef(12);
  const onVisibleColumns = useCallback((cols: number) => {
    visibleCols.current = cols;
  }, []);
  const editing = mode === 'edit';
  const windowDevice = useWindowDevice();
  // The device whose layout edit mode shows, null: the window's
  const [editDevice, setEditDevice] = useState<Device | null>(null);
  const device = editing ? (editDevice ?? windowDevice) : windowDevice;
  const deviceRef = useRef(device);
  deviceRef.current = device;
  const layout = useMemo(() => (panel ? layoutFor(panel, device, minSize) : null), [panel, device]);

  const setPanel = useCallback((next: Panel | null) => {
    panelRef.current = next;
    setPanelState(next);
  }, []);

  const refreshPanels = useCallback(async () => {
    try {
      setPanels(await api.listPanels());
    } catch (e) {
      notify(`Could not list the panels: ${errorText(e)}`, 'error');
    }
  }, []);

  // Every change of the panel goes through here: shown, saved, undoable
  const updatePanel = useCallback(
    (change: (panel: Panel) => Panel) => {
      const current = panelRef.current;
      if (!current) {
        return;
      }
      const next = change(current);
      undoStack.current = [...undoStack.current.slice(-(UNDO_LIMIT - 1)), current];
      setCanUndo(true);
      setPanel(next);
      saver.schedule(next);
    },
    [saver, setPanel],
  );

  const undo = useCallback(() => {
    const previous = undoStack.current.pop();
    setCanUndo(undoStack.current.length > 0);
    if (previous) {
      setPanel(previous);
      saver.schedule(previous);
      setSelectedId((id) => (id && previous.widgets.some((w) => w.id === id) ? id : null));
    }
  }, [saver, setPanel]);

  useEffect(() => {
    const onHashChange = () => setPanelId(hashPanelId());
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  // Also after reconnecting: panels may have changed while disconnected
  useEffect(() => {
    if (status !== 'closed') {
      void refreshPanels();
    }
  }, [refreshPanels, status]);

  // Without a panel in the URL, or one that is gone: the first one
  useEffect(() => {
    if (panels && panels.length > 0 && !panels.some((p) => p.id === panelId)) {
      showPanel(panels[0].id, true);
    }
  }, [panels, panelId]);

  const loadPanel = useCallback(
    async (id: string) => {
      try {
        const loaded = await api.getPanel(id);
        // Not if another panel was chosen meanwhile
        if (id === panelIdRef.current) {
          setPanel(loaded);
          setLoadError(null);
        }
      } catch (e) {
        if (id === panelIdRef.current) {
          setLoadError(errorText(e));
        }
      }
    },
    [setPanel],
  );

  // Loaded when chosen, not whenever the list changes
  const panelListed = panels?.some((p) => p.id === panelId) ?? false;
  useEffect(() => {
    if (!panelListed) {
      return;
    }
    let current = true;
    void saver.flush().then(() => {
      if (current) {
        undoStack.current = [];
        setCanUndo(false);
        setSelectedId(null);
        void loadPanel(panelId);
      }
    });
    return () => {
      current = false;
    };
  }, [panelId, panelListed, loadPanel, saver]);

  // Changes made on other pages
  useEffect(
    () =>
      connection.onServerMessage((message) => {
        if (message.type === 'error') {
          notify(message.message, 'error');
        }
        if (message.type !== 'panels.changed' || message.origin === connection.clientId) {
          return;
        }
        void refreshPanels();
        if (message.id === panelRef.current?.id && !message.deleted && !saver.isPending()) {
          void loadPanel(message.id);
        }
      }),
    [refreshPanels, loadPanel, saver],
  );

  const switchMode = async (next: Mode) => {
    if (next === 'view') {
      // Buttons run the saved command: save before they can be pressed
      setSelectedId(null);
      setEditDevice(null);
      await saver.flush();
    }
    setMode(next);
    setMenuOpen(false);
  };

  // ── Widgets ──
  const addWidget = (definition: RegisteredWidget) => {
    setPaletteOpen(false);
    const current = panelRef.current;
    if (!current) {
      return;
    }
    const columns = deviceRef.current === 'desktop' ? visibleCols.current : DESKTOP_COLUMNS;
    const rect = freeSpot(current.widgets, definition.defaultSize, columns);
    const widget: WidgetInstance = { id: newWidgetId(definition.type), type: definition.type, title: '', ...rect, config: {} };
    updatePanel((p) => ({ ...p, widgets: [...p.widgets, widget] }));
    setSelectedId(widget.id);
  };

  // In the layout of the device shown
  const placeWidget = useCallback(
    (id: string, rect: Rect) =>
      updatePanel((p) => withRect(p, deviceRef.current, layoutFor(p, deviceRef.current, minSize), id, rect)),
    [updatePanel],
  );

  // What a widget changes of its own config (WidgetProps.updateConfig)
  const configureWidget = useCallback(
    (id: string, changes: Record<string, unknown>) =>
      updatePanel((p) => ({
        ...p,
        widgets: p.widgets.map((w) => (w.id === id ? { ...w, config: { ...w.config, ...changes } } : w)),
      })),
    [updatePanel],
  );

  // On the device shown (a tablet or a phone), or shown again
  const hideWidget = useCallback(
    (id: string, hide = true) => {
      const shown = deviceRef.current;
      if (shown === 'desktop') {
        return;
      }
      updatePanel((p) => withHidden(p, shown, layoutFor(p, shown, minSize), id, hide));
      setSelectedId((selected) => (selected === id ? null : selected));
    },
    [updatePanel],
  );

  const removeWidget = useCallback(
    (id: string) => {
      const widget = panelRef.current?.widgets.find((w) => w.id === id);
      updatePanel((p) => ({ ...p, widgets: p.widgets.filter((w) => w.id !== id) }));
      setSelectedId((selected) => (selected === id ? null : selected));
      if (widget) {
        const name = widget.title || widgetDefinition(widget.type)?.name || widget.type;
        notify(`Removed “${name}”`, 'info', { label: 'Undo', run: undo });
      }
    },
    [updatePanel, undo],
  );

  const duplicateWidget = (id: string) => {
    const current = panelRef.current;
    const widget = current?.widgets.find((w) => w.id === id);
    if (!current || !widget) {
      return;
    }
    const columns = deviceRef.current === 'desktop' ? visibleCols.current : DESKTOP_COLUMNS;
    const rect = freeSpot(current.widgets, { w: widget.w, h: widget.h }, columns);
    const copy = { ...widget, ...rect, id: newWidgetId(widget.type), config: structuredClone(widget.config) };
    updatePanel((p) => ({ ...p, widgets: [...p.widgets, copy] }));
    setSelectedId(copy.id);
  };

  // ── Panels ──
  const createPanel = async () => {
    setMenuOpen(false);
    const name = await dialogs.prompt({ title: 'New panel', label: 'Name', confirmLabel: 'Create' });
    if (!name) {
      return;
    }
    try {
      const created = await api.createPanel({ name, widgets: [] });
      await refreshPanels();
      showPanel(created.id);
      setMode('edit');
    } catch (e) {
      notify(`Could not create the panel: ${errorText(e)}`, 'error');
    }
  };

  const renamePanel = async () => {
    setMenuOpen(false);
    const current = panelRef.current;
    if (!current) {
      return;
    }
    const name = await dialogs.prompt({ title: 'Rename panel', label: 'Name', initial: current.name, confirmLabel: 'Rename' });
    if (name && name !== current.name) {
      updatePanel((p) => ({ ...p, name }));
      await saver.flush();
      await refreshPanels();
    }
  };

  const duplicatePanel = async () => {
    setMenuOpen(false);
    const current = panelRef.current;
    if (!current) {
      return;
    }
    try {
      await saver.flush();
      const copy = await api.createPanel({ ...panelFile(current), name: `${current.name} (copy)` });
      await refreshPanels();
      showPanel(copy.id);
    } catch (e) {
      notify(`Could not duplicate the panel: ${errorText(e)}`, 'error');
    }
  };

  const exportPanel = () => {
    setMenuOpen(false);
    const current = panelRef.current;
    if (current) {
      download(panelFileName(current), panelFileText(current));
    }
  };

  // Each file a new panel, never over another: named as in the file, unless
  // a panel has that name already. Shows the last one.
  const importPanels = async (files: File[]) => {
    const taken = (panels ?? []).map((p) => p.name);
    let last: Panel | null = null;
    for (const file of files) {
      try {
        const content = readPanelFile(await file.text());
        const created = await api.createPanel({ ...content, name: freeName(content.name, taken) });
        taken.push(created.name);
        last = created;
        notify(`Imported “${created.name}”`);
      } catch (e) {
        notify(`Could not import ${file.name}: ${errorText(e)}`, 'error');
      }
    }
    if (last) {
      await refreshPanels();
      showPanel(last.id);
    }
  };

  const chooseImport = () => {
    setMenuOpen(false);
    importRef.current?.click();
  };

  const deletePanel = async () => {
    setMenuOpen(false);
    const current = panelRef.current;
    if (
      !current ||
      !(await dialogs.confirm({
        title: `Delete “${current.name}”?`,
        message: 'The panel and its widgets are deleted for good.',
        confirmLabel: 'Delete',
        danger: true,
      }))
    ) {
      return;
    }
    try {
      await saver.flush();
      await api.deletePanel(current.id);
      setPanel(null);
      await refreshPanels();
    } catch (e) {
      notify(`Could not delete the panel: ${errorText(e)}`, 'error');
    }
  };

  // ── Keyboard: undo, remove and move the selected widget ──
  useEffect(() => {
    if (!editing) {
      return;
    }
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (target.closest('input, textarea, select, [role="dialog"]')) {
        return;
      }
      if (event.key === 'z' && (event.ctrlKey || event.metaKey) && !event.shiftKey) {
        event.preventDefault();
        undo();
        return;
      }
      const widget = panelRef.current?.widgets.find((w) => w.id === selectedId);
      if (!widget) {
        return;
      }
      if (event.key === 'Delete' || event.key === 'Backspace') {
        event.preventDefault();
        removeWidget(widget.id);
        return;
      }
      const step = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
      const shown = layoutFor(panelRef.current!, deviceRef.current, minSize);
      const current = shown.rects.get(widget.id);
      if (step && current) {
        event.preventDefault();
        const rect = { ...current, x: current.x + step[0], y: current.y + step[1] };
        if (fits(rect, shown, DEVICES[deviceRef.current].columns, widget.id)) {
          placeWidget(widget.id, rect);
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [editing, selectedId, undo, removeWidget, placeWidget]);

  const selected = editing ? panel?.widgets.find((w) => w.id === selectedId) : undefined;
  const statusText = { connecting: 'Connecting…', open: `Connected to ${connection.hostname}`, closed: 'Disconnected, reconnecting…' }[status];

  return (
    <div className={`app${editing ? ' editing' : ''}`}>
      <header className="topbar">
        <div className="brand" title={statusText}>
          <TasselloIcon width={22} height={22} />
          <span className="brand-name">{connection.hostname || 'Tassello'}</span>
          <span className={`connection-dot ${status}`} aria-label={statusText} />
        </div>

        {panels && panels.length > 0 && (
          <select
            className="panel-select"
            aria-label="Panel"
            value={panelId}
            onChange={(e) => showPanel(e.target.value)}
          >
            {panels.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        )}

        <div className="topbar-spacer" />

        {editing && panel && (
          <>
            <span className={`save-state ${saveState}`}>
              {{ saved: 'Saved', saving: 'Saving…', failed: 'Not saved' }[saveState]}
            </span>
            <button type="button" className="icon-button" title="Undo (Ctrl+Z)" aria-label="Undo" disabled={!canUndo} onClick={undo}>
              <UndoIcon />
            </button>
            <button type="button" className="button primary" aria-label="Add widget" onClick={() => setPaletteOpen(true)}>
              <PlusIcon /> <span className="hide-narrow">Add widget</span>
            </button>
          </>
        )}
        {editing && (
          <div className="mode-switch device-switch" role="group" aria-label="Layout of">
            {(Object.keys(DEVICES) as Device[]).map((option) => {
              const Icon = DEVICE_ICONS[option];
              return (
                <button
                  key={option}
                  type="button"
                  aria-pressed={device === option}
                  title={`The ${DEVICES[option].label.toLowerCase()} layout`}
                  aria-label={`${DEVICES[option].label} layout`}
                  onClick={() => {
                    setEditDevice(option);
                    setSelectedId(null);
                  }}
                >
                  <Icon />
                </button>
              );
            })}
          </div>
        )}
        {editing && (
          <div className="menu">
            <button
              type="button"
              className="icon-button"
              aria-label="Panel actions"
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen((open) => !open)}
            >
              <MoreIcon />
            </button>
            {menuOpen && (
              <>
                <div className="menu-backdrop" onPointerDown={() => setMenuOpen(false)} />
                <div className="menu-list" role="menu">
                  <button type="button" role="menuitem" onClick={createPanel}>
                    New panel…
                  </button>
                  <button type="button" role="menuitem" onClick={chooseImport}>
                    Import panel…
                  </button>
                  {panel && (
                    <>
                      <button type="button" role="menuitem" onClick={renamePanel}>
                        Rename panel…
                      </button>
                      <button type="button" role="menuitem" onClick={duplicatePanel}>
                        Duplicate panel
                      </button>
                      <button type="button" role="menuitem" onClick={exportPanel}>
                        Export panel
                      </button>
                      <button type="button" role="menuitem" className="danger" onClick={deletePanel}>
                        Delete panel…
                      </button>
                    </>
                  )}
                </div>
              </>
            )}
          </div>
        )}
        <div className="mode-switch" role="group" aria-label="Mode">
          <button type="button" aria-label="View" title="View" aria-pressed={!editing} onClick={() => switchMode('view')}>
            <EyeIcon /> <span className="hide-narrow">View</span>
          </button>
          <button type="button" aria-label="Edit" title="Edit" aria-pressed={editing} onClick={() => switchMode('edit')}>
            <PencilIcon /> <span className="hide-narrow">Edit</span>
          </button>
        </div>
      </header>

      <main className="workspace">
        {panels === null ? (
          <div className="empty-state">Loading…</div>
        ) : panels.length === 0 ? (
          <div className="empty-state">
            <h1>No panels yet</h1>
            <p>A panel is a board of widgets: create one for each task, e.g. teleoperation or navigation.</p>
            <div className="empty-state-actions">
              <button type="button" className="button primary" onClick={createPanel}>
                <PlusIcon /> Create a panel
              </button>
              <button type="button" className="button" onClick={chooseImport}>
                Import a panel…
              </button>
            </div>
          </div>
        ) : loadError ? (
          <div className="empty-state">
            <h1>Cannot open this panel</h1>
            <p>{loadError}</p>
          </div>
        ) : panel ? (
          <>
            <div className="board-column">
              {editing && device !== 'desktop' && layout && (
                <div className="layout-bar">
                  <span>
                    <strong>{DEVICES[device].label} layout</strong>
                    {layout.custom
                      ? ' · arranged for this device'
                      : ' · automatic, from the desktop’s: moving a widget arranges it for this device'}
                  </span>
                  {layout.hidden.length > 0 && (
                    <span className="layout-hidden">
                      Hidden:
                      {layout.hidden.map((id) => {
                        const widget = panel.widgets.find((w) => w.id === id);
                        return (
                          <button
                            key={id}
                            type="button"
                            className="layout-chip"
                            title="Show it again"
                            onClick={() => hideWidget(id, false)}
                          >
                            {widget?.title || widgetDefinition(widget?.type ?? '')?.name || id} ＋
                          </button>
                        );
                      })}
                    </span>
                  )}
                  {(layout.custom || layout.hidden.length > 0) && (
                    <button
                      type="button"
                      className="link-button"
                      onClick={() => updatePanel((p) => withoutLayout(p, device as 'tablet' | 'phone'))}
                    >
                      Back to automatic
                    </button>
                  )}
                </div>
              )}
              {layout && (
                <Board
                  key={device}
                  panel={panel}
                  device={device}
                  layout={layout}
                  previewWidth={device !== windowDevice ? DEVICES[device].previewWidth : null}
                  editing={editing}
                  selectedId={selectedId}
                  onSelect={setSelectedId}
                  onPlace={placeWidget}
                  onRemove={removeWidget}
                  onConfigure={configureWidget}
                  onHide={device === 'desktop' ? undefined : hideWidget}
                  onVisibleColumns={onVisibleColumns}
                />
              )}
            </div>
            {panel.widgets.length === 0 && (
              <div className="board-hint">
                {editing ? (
                  <>This panel is empty: add widgets with <strong>Add widget</strong>.</>
                ) : (
                  <>This panel is empty: switch to <strong>Edit</strong> to add widgets.</>
                )}
              </div>
            )}
            {selected && (
              <PropertiesPanel
                key={selected.id}
                widget={selected}
                onChange={(widget) =>
                  updatePanel((p) => ({ ...p, widgets: p.widgets.map((w) => (w.id === widget.id ? widget : w)) }))
                }
                onDuplicate={() => duplicateWidget(selected.id)}
                onRemove={() => removeWidget(selected.id)}
                onClose={() => setSelectedId(null)}
              />
            )}
          </>
        ) : null}
      </main>

      {paletteOpen && <WidgetPalette onAdd={addWidget} onClose={() => setPaletteOpen(false)} />}
      <input
        ref={importRef}
        type="file"
        accept=".json,application/json"
        multiple
        hidden
        onChange={(event) => {
          const files = [...(event.target.files ?? [])];
          event.target.value = '';
          void importPanels(files);
        }}
      />
      <Notifications />
    </div>
  );
}
