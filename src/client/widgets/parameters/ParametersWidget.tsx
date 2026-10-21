// Nodes' parameters, as rqt_reconfigure and ros2 param show them: the nodes
// of the graph, and the parameters of the one chosen, grouped by their
// prefixes, each edited in place with an editor of its type and range; their
// descriptions, constraints and ranges (ros2 param describe); new ones added
// and undeclared ones deleted (ros2 param set, delete); all of them dumped as
// YAML, downloaded or saved on the robot (dump), and loaded from a YAML file
// of the robot or of this device (load). Changes made elsewhere show as they
// come: the server follows /parameter_events (see src/server/parameters.ts).

import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';

import type { GraphSnapshot } from '../../../shared/monitor.ts';
import { PARAM_TYPES, type ParamInfo, type ParamResult, type ParamType, type ParamValue } from '../../../shared/parameters.ts';
import { ApiError, fsApi } from '../../api.ts';
import { connection } from '../../connection.ts';
import { useDialogs } from '../../dialogs.tsx';
import { FileBrowser } from '../../editor/FileInput.tsx';
import {
  ArrowRightIcon,
  CloseIcon,
  CopyIcon,
  DownloadIcon,
  InfoIcon,
  LockIcon,
  PlusIcon,
  RefreshIcon,
  SearchIcon,
  SlidersIcon,
  TrashIcon,
  UploadIcon,
} from '../../icons.tsx';
import { notify } from '../../notifications.tsx';
import { ContextMenu, type MenuItem } from '../file_manager/parts.tsx';
import { copyText } from '../file_manager/folders.ts';
import { textMatch } from '../logs/model.ts';
import { defineWidget, type WidgetProps } from '../types.ts';
import {
  inferValue,
  isHiddenNode,
  paramRows,
  parseValueText,
  rangeText,
  setCommand,
  typeName,
  valueText,
  type ParamRow,
} from './model.ts';

interface ParametersConfig {
  node: string;
  filter: string;
  readOnly: boolean;
}

// Narrower than this, the nodes are a list to pick from in the toolbar
const NODES_BESIDE_PX = 560;
const INDENT_PX = 16;

function nodeName(node: string): string {
  const trimmed = node.trim().replace(/\/+$/, '');
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

function copy(text: string, what: string): void {
  copyText(text).then(
    () => notify(`Copied ${what}`),
    (e: unknown) => notify(`Could not copy ${what}: ${e instanceof Error ? e.message : e}`, 'error'),
  );
}

function download(name: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/yaml' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// /robot1/amcl: robot1__amcl.yaml
function fileName(node: string): string {
  return `${node.replace(/^\//, '').replace(/\//g, '__') || 'node'}.yaml`;
}

// A parameter's value, edited in place: committed on Enter or when left
// (sliders and switches at once); its text kept while being edited, else
// following the value as it changes elsewhere, and back to it when the node
// refuses the new one
function ValueEditor({
  param,
  disabled,
  onCommit,
}: {
  param: ParamInfo;
  disabled: boolean;
  // Resolves with whether the node took it
  onCommit: (value: ParamValue) => Promise<boolean>;
}) {
  const { value, descriptor } = param;
  const text = valueText(value);
  const [draft, setDraft] = useState(text);
  const [invalid, setInvalid] = useState<string | null>(null);
  const editing = useRef(false);
  useEffect(() => {
    if (!editing.current) {
      setDraft(text);
      setInvalid(null);
    }
  }, [text]);

  const commit = (next = draft) => {
    editing.current = false;
    if (next === text) {
      setInvalid(null);
      return;
    }
    const parsed = parseValueText(next, value.type);
    if ('error' in parsed) {
      setInvalid(parsed.error);
      return;
    }
    setInvalid(null);
    void onCommit(parsed.value).then((taken) => {
      if (!taken && !editing.current) {
        setDraft(text);
      }
    });
  };

  if (value.type === 'not_set') {
    return <span className="prm-unset">not set</span>;
  }
  if (value.type === 'bool') {
    return (
      <label className="prm-switch" title={disabled ? undefined : 'Click to switch'}>
        <input
          type="checkbox"
          checked={value.value === true}
          disabled={disabled}
          aria-label={param.name}
          onChange={(event) => void onCommit({ type: 'bool', value: event.target.checked })}
        />
        <span className="prm-switch-track" aria-hidden="true" />
        <span className="prm-switch-text">{value.value ? 'true' : 'false'}</span>
      </label>
    );
  }
  const range = descriptor?.range;
  const slider =
    range && (value.type === 'integer' || value.type === 'double') && Number.isFinite(range.from) && Number.isFinite(range.to) && range.to > range.from;
  const numeric = value.type === 'integer' || value.type === 'double';
  return (
    <div className="prm-editor">
      {slider && (
        <input
          type="range"
          className="prm-slider"
          min={range.from}
          max={range.to}
          step={range.step || (value.type === 'integer' ? 1 : (range.to - range.from) / 1000)}
          value={Number(draft) || 0}
          disabled={disabled}
          aria-label={`${param.name}: slide`}
          onChange={(event) => {
            editing.current = true;
            setDraft(event.target.value);
          }}
          onPointerUp={(event) => commit(event.currentTarget.value)}
          onKeyUp={(event) => commit(event.currentTarget.value)}
        />
      )}
      <input
        type="text"
        inputMode={value.type === 'integer' ? 'numeric' : value.type === 'double' ? 'decimal' : undefined}
        className={`prm-input${numeric ? ' numeric' : ''}${invalid ? ' invalid' : ''}`}
        value={draft}
        disabled={disabled}
        title={invalid ?? undefined}
        aria-label={param.name}
        aria-invalid={invalid !== null}
        spellCheck={false}
        onFocus={() => {
          editing.current = true;
        }}
        onChange={(event) => {
          editing.current = true;
          setDraft(event.target.value);
          setInvalid(null);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            commit();
          } else if (event.key === 'Escape') {
            editing.current = false;
            setDraft(text);
            setInvalid(null);
          }
        }}
        onBlur={() => commit()}
      />
    </div>
  );
}

function ParamDetails({
  node,
  param,
  canDelete,
  onDelete,
}: {
  node: string;
  param: ParamInfo;
  canDelete: boolean;
  onDelete: () => void;
}) {
  const d = param.descriptor;
  const range = rangeText(d);
  return (
    <div className="prm-details">
      <dl className="prm-facts">
        <div>
          <dt>Name</dt>
          <dd>{param.name}</dd>
        </div>
        <div>
          <dt>Type</dt>
          <dd>
            {typeName(param.value.type)}
            {d?.dynamicTyping && ' (dynamic: may change type)'}
          </dd>
        </div>
        {d?.description && (
          <div>
            <dt>Description</dt>
            <dd className="prose">{d.description}</dd>
          </div>
        )}
        {range && (
          <div>
            <dt>Range</dt>
            <dd>{range}</dd>
          </div>
        )}
        {d?.additionalConstraints && (
          <div>
            <dt>Constraints</dt>
            <dd className="prose">{d.additionalConstraints}</dd>
          </div>
        )}
        {d?.readOnly && (
          <div>
            <dt>Read only</dt>
            <dd className="prose">Set when the node starts, not after</dd>
          </div>
        )}
        {!d && (
          <div>
            <dt>Descriptor</dt>
            <dd className="prose">The node did not describe it</dd>
          </div>
        )}
      </dl>
      <div className="prm-details-actions">
        <button type="button" className="prm-small" onClick={() => copy(valueText(param.value), 'the value')}>
          <CopyIcon width={13} height={13} /> Value
        </button>
        <button type="button" className="prm-small" onClick={() => copy(setCommand(node, param.name, param.value), 'the command')}>
          <CopyIcon width={13} height={13} /> ros2 param set
        </button>
        {canDelete && (
          <button
            type="button"
            className="prm-small danger"
            title="ros2 param delete: only undeclared parameters can be"
            onClick={onDelete}
          >
            <TrashIcon width={13} height={13} /> Delete
          </button>
        )}
      </div>
    </div>
  );
}

function AddForm({ onAdd, onClose }: { onAdd: (name: string, value: ParamValue) => Promise<boolean>; onClose: () => void }) {
  const [name, setName] = useState('');
  const [type, setType] = useState<ParamType | 'auto'>('auto');
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!name.trim()) {
      setError('A name');
      return;
    }
    let value: ParamValue;
    if (type === 'auto') {
      value = inferValue(text);
    } else {
      const parsed = parseValueText(text, type);
      if ('error' in parsed) {
        setError(parsed.error);
        return;
      }
      value = parsed.value;
    }
    setBusy(true);
    setError(null);
    if (await onAdd(name.trim(), value)) {
      onClose();
    }
    setBusy(false);
  };
  return (
    <form
      className="prm-add"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <input className="prm-input" placeholder="name.of.parameter" value={name} aria-label="Name" spellCheck={false} onChange={(e) => setName(e.target.value)} autoFocus />
      <select className="prm-select" value={type} aria-label="Type" onChange={(e) => setType(e.target.value as ParamType | 'auto')}>
        <option value="auto">As ros2 param set reads it</option>
        {PARAM_TYPES.filter((t) => t !== 'not_set').map((t) => (
          <option key={t} value={t}>
            {typeName(t)}
          </option>
        ))}
      </select>
      <input
        className="prm-input"
        placeholder={type === 'auto' ? '0.5, true, map, [1, 2]' : 'Value'}
        value={text}
        aria-label="Value"
        spellCheck={false}
        onChange={(e) => setText(e.target.value)}
      />
      <button type="submit" className="button primary prm-add-button" disabled={busy}>
        Add
      </button>
      <button type="button" className="overlay-button" aria-label="Cancel" title="Cancel" onClick={onClose}>
        <CloseIcon width={15} height={15} />
      </button>
      {error && <p className="prm-add-error">{error}</p>}
      <p className="prm-add-hint">Nodes take parameters they did not declare only if they allow it.</p>
    </form>
  );
}

function ParametersWidget({ config }: WidgetProps<ParametersConfig>) {
  const dialogs = useDialogs();
  const pinned = config.node.trim() ? nodeName(config.node) : '';
  const [graph, setGraph] = useState<GraphSnapshot | null>(null);
  const [chosenNode, setChosenNode] = useState('');
  const node = pinned || chosenNode;
  const [nodeFilter, setNodeFilter] = useState('');
  const [filterText, setFilterText] = useState(config.filter);
  const [params, setParams] = useState<Map<string, ParamInfo> | null>(null);
  const [status, setStatus] = useState<{ state: string; message: string }>({ state: 'waiting', message: '' });
  const [reload, setReload] = useState(0);
  const [folding, setFolding] = useState<ReadonlyMap<string, boolean>>(new Map());
  const [expanded, setExpanded] = useState<string | null>(null);
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const [errors, setErrors] = useState<ReadonlyMap<string, string>>(new Map());
  const [results, setResults] = useState<{ title: string; failed: ParamResult[] } | null>(null);
  const [adding, setAdding] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const [browsing, setBrowsing] = useState(false);
  const [width, setWidth] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => setFilterText(config.filter), [config.filter]);
  useEffect(() => (pinned ? undefined : connection.subscribeGraph(setGraph)), [pinned]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) {
      return;
    }
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    observer.observe(root);
    return () => observer.disconnect();
  }, []);

  // Another node: what was shown of the last one goes
  useEffect(() => {
    setParams(null);
    setExpanded(null);
    setErrors(new Map());
    setResults(null);
    setAdding(false);
    setFolding(new Map());
  }, [node]);

  useEffect(() => {
    if (!node) {
      return;
    }
    setStatus({ state: 'waiting', message: '' });
    return connection.subscribeParameters(node, {
      status: (state, message) => setStatus({ state, message }),
      update: (update) =>
        setParams((current) => {
          const next = new Map(update.reset ? [] : (current ?? []));
          for (const param of update.parameters) {
            next.set(param.name, param);
          }
          for (const name of update.deleted) {
            next.delete(name);
          }
          return next;
        }),
    });
  }, [node, reload]);

  const nodes = useMemo(
    () =>
      (graph?.nodes ?? [])
        .filter((n) => !isHiddenNode(n))
        .filter((n) => !nodeFilter.trim() || n.toLowerCase().includes(nodeFilter.trim().toLowerCase())),
    [graph, nodeFilter],
  );

  const text = useDeferredValue(filterText);
  const match = useMemo(() => textMatch(text, false), [text]);
  const list = useMemo(() => [...(params?.values() ?? [])], [params]);
  const rows = useMemo(() => paramRows(list, match.test, folding), [list, match, folding]);

  const editable = !config.readOnly;

  const setValues = useCallback(
    async (changes: { name: string; value: ParamValue }[]): Promise<ParamResult[] | null> => {
      const names = changes.map((c) => c.name);
      setPending((current) => new Set([...current, ...names]));
      try {
        const answers = await connection.setParameters(node, changes);
        setErrors((current) => {
          const next = new Map(current);
          for (const answer of answers) {
            if (answer.successful) {
              next.delete(answer.name);
            } else {
              next.set(answer.name, answer.reason || 'The node refused it');
            }
          }
          return next;
        });
        return answers;
      } catch (e) {
        notify(`Could not set ${names.join(', ')}: ${e instanceof Error ? e.message : e}`, 'error');
        return null;
      } finally {
        setPending((current) => new Set([...current].filter((n) => !names.includes(n))));
      }
    },
    [node],
  );

  const remove = async (param: ParamInfo) => {
    if (
      !(await dialogs.confirm({
        title: `Delete ${param.name}?`,
        message: `ros2 param delete ${node} ${param.name}: only parameters the node did not declare can be.`,
        confirmLabel: 'Delete',
        danger: true,
      }))
    ) {
      return;
    }
    const answers = await setValues([{ name: param.name, value: { type: 'not_set', value: null } }]);
    if (answers?.[0] && !answers[0].successful) {
      notify(`${param.name} not deleted: ${answers[0].reason}`, 'error');
    }
  };

  const add = async (name: string, value: ParamValue): Promise<boolean> => {
    const answers = await setValues([{ name, value }]);
    if (answers?.[0]?.successful) {
      notify(`${name} set`);
      setExpanded(name);
      return true;
    }
    if (answers?.[0]) {
      notify(`${name} not set: ${answers[0].reason}`, 'error');
    }
    return false;
  };

  const load = async (yaml: string, source: string) => {
    try {
      const answers = await connection.loadParameters(node, yaml);
      const failed = answers.filter((a) => !a.successful);
      const done = answers.length - failed.length;
      if (failed.length === 0) {
        notify(`Loaded ${done} parameter${done === 1 ? '' : 's'} from ${source}`);
        setResults(null);
      } else {
        setResults({ title: `Loaded ${done} of ${answers.length} parameters from ${source}`, failed });
      }
    } catch (e) {
      notify(`Could not load ${source}: ${e instanceof Error ? e.message : e}`, 'error');
    }
  };

  const dump = async (): Promise<string | null> => {
    try {
      return await connection.dumpParameters(node);
    } catch (e) {
      notify(`Could not dump the parameters: ${e instanceof Error ? e.message : e}`, 'error');
      return null;
    }
  };

  const saveOnRobot = async () => {
    const path = await dialogs.prompt({
      title: `Save the parameters of ${node}`,
      label: 'File on the robot',
      initial: `~/${fileName(node)}`,
      confirmLabel: 'Save',
    });
    if (!path?.trim()) {
      return;
    }
    const yaml = await dump();
    if (yaml === null) {
      return;
    }
    try {
      await fsApi.saveText(path.trim(), yaml, null, true);
      notify(`Saved ${path.trim()}`);
    } catch (e) {
      if (
        e instanceof ApiError &&
        e.status === 409 &&
        (await dialogs.confirm({ title: `Replace ${path.trim()}?`, message: 'The file exists.', confirmLabel: 'Replace', danger: true }))
      ) {
        await fsApi.saveText(path.trim(), yaml, null, false).then(
          () => notify(`Saved ${path.trim()}`),
          (err: unknown) => notify(`Could not save: ${err instanceof Error ? err.message : err}`, 'error'),
        );
      } else if (!(e instanceof ApiError && e.status === 409)) {
        notify(`Could not save: ${e instanceof Error ? e.message : e}`, 'error');
      }
    }
  };

  const openMenu = (event: MouseEvent<HTMLButtonElement>, items: MenuItem[]) => {
    const box = event.currentTarget.getBoundingClientRect();
    setMenu({ x: box.right - 210, y: box.bottom + 4, items });
  };

  const dumpMenu = (event: MouseEvent<HTMLButtonElement>) =>
    openMenu(event, [
      {
        label: 'Download as YAML',
        run: () => void dump().then((yaml) => yaml !== null && download(fileName(node), yaml)),
      },
      { label: 'Save on the robot…', run: () => void saveOnRobot() },
      { label: 'Copy the YAML', run: () => void dump().then((yaml) => yaml !== null && copy(yaml, 'the parameters')) },
    ]);

  const loadMenu = (event: MouseEvent<HTMLButtonElement>) =>
    openMenu(event, [
      { label: 'From a file of the robot…', run: () => setBrowsing(true) },
      { label: 'From a file of this device…', run: () => fileRef.current?.click() },
    ]);

  const narrow = width > 0 && width < NODES_BESIDE_PX;
  const count = params?.size ?? 0;
  const readOnlyCount = list.filter((p) => p.descriptor?.readOnly).length;

  let content;
  if (!node) {
    content = <p className="prm-empty">{graph ? 'Choose a node to see its parameters' : 'Reading the ROS graph…'}</p>;
  } else if (status.state === 'error' && !params) {
    content = <p className="prm-empty error">{status.message}</p>;
  } else if (!params) {
    content = <p className="prm-empty">Reading the parameters of {node}…</p>;
  } else if (rows.length === 0) {
    content = <p className="prm-empty">{count === 0 ? `${node} has no parameters` : 'No parameter matches the filter'}</p>;
  } else {
    content = (
      <ul className="prm-list" aria-label={`Parameters of ${node}`}>
        {rows.map((row: ParamRow) =>
          row.kind === 'group' ? (
            <li key={`group ${row.key}`}>
              <button
                type="button"
                className="prm-group"
                style={{ paddingLeft: 6 + row.depth * INDENT_PX }}
                aria-expanded={row.open}
                onClick={() => setFolding((current) => new Map(current).set(row.key, !row.open))}
              >
                <ArrowRightIcon width={11} height={11} className="prm-fold" />
                <span className="prm-group-name">{row.label}</span>
                <span className="prm-group-count">{row.count}</span>
              </button>
            </li>
          ) : (
            <li key={row.key} className={`prm-item${expanded === row.key ? ' open' : ''}`}>
              <div className={`prm-row${pending.has(row.key) ? ' pending' : ''}`}>
                <button
                  type="button"
                  className="prm-name"
                  style={{ paddingLeft: 23 + row.depth * INDENT_PX }}
                  title={`${row.param.name}${row.param.descriptor?.description ? `: ${row.param.descriptor.description}` : ''}`}
                  aria-expanded={expanded === row.key}
                  onClick={() => setExpanded((current) => (current === row.key ? null : row.key))}
                >
                  <span className="prm-name-text">{row.label}</span>
                  {row.param.descriptor?.description && <span className="prm-description">{row.param.descriptor.description}</span>}
                </button>
                <div className="prm-value">
                  <ValueEditor
                    param={row.param}
                    disabled={!editable || row.param.descriptor?.readOnly === true || pending.has(row.key)}
                    onCommit={(value) =>
                      setValues([{ name: row.param.name, value }]).then((answers) => answers?.[0]?.successful === true)
                    }
                  />
                </div>
                <span className="prm-type" title={typeName(row.param.value.type)}>
                  {row.param.descriptor?.readOnly && <LockIcon width={11} height={11} aria-label="Read only" />}
                  {typeName(row.param.value.type)}
                </span>
                <button
                  type="button"
                  className="overlay-button prm-info"
                  aria-label={`Details of ${row.param.name}`}
                  aria-pressed={expanded === row.key}
                  title="Details"
                  onClick={() => setExpanded((current) => (current === row.key ? null : row.key))}
                >
                  <InfoIcon width={14} height={14} />
                </button>
              </div>
              {errors.get(row.key) && (
                <p className="prm-error" style={{ marginLeft: 6 + row.depth * INDENT_PX }}>
                  {errors.get(row.key)}
                </p>
              )}
              {expanded === row.key && (
                <div style={{ marginLeft: 6 + row.depth * INDENT_PX }}>
                  <ParamDetails
                    node={node}
                    param={row.param}
                    canDelete={editable && !row.param.descriptor?.readOnly}
                    onDelete={() => void remove(row.param)}
                  />
                </div>
              )}
            </li>
          ),
        )}
      </ul>
    );
  }

  let line: { text: string; tone: string };
  if (!node) {
    line = { text: graph ? `${nodes.length} nodes` : 'Reading the ROS graph…', tone: 'idle' };
  } else if (status.state === 'error') {
    line = { text: status.message, tone: 'failed' };
  } else if (!params) {
    line = { text: `Reading the parameters of ${node}…`, tone: 'idle' };
  } else {
    const parts = [node, `${count} parameter${count === 1 ? '' : 's'}`];
    if (readOnlyCount > 0) {
      parts.push(`${readOnlyCount} read-only`);
    }
    if (config.readOnly) {
      parts.push('view only');
    }
    line = { text: parts.join(' · '), tone: 'idle' };
  }

  const nodeList = !pinned && !narrow && (
    <nav className="prm-nodes" aria-label="Nodes">
      <label className="prm-search">
        <SearchIcon width={13} height={13} />
        <input type="search" value={nodeFilter} placeholder="Nodes…" aria-label="Only the nodes containing" spellCheck={false} onChange={(e) => setNodeFilter(e.target.value)} />
      </label>
      <ul className="prm-node-list">
        {nodes.map((n) => (
          <li key={n}>
            <button type="button" className="prm-node" aria-current={n === node || undefined} title={n} onClick={() => setChosenNode(n)}>
              <span className="prm-node-name">{n}</span>
              {n === graph?.self && <span className="prm-self">this dashboard</span>}
            </button>
          </li>
        ))}
        {graph && nodes.length === 0 && <li className="prm-muted">No node</li>}
      </ul>
    </nav>
  );

  return (
    <div ref={rootRef} className={`prm${narrow ? ' narrow' : ''}`}>
      <div className="prm-toolbar" role="toolbar" aria-label="Parameters">
        {!pinned && narrow && (
          <select className="prm-select prm-node-select" value={node} aria-label="Node" onChange={(e) => setChosenNode(e.target.value)}>
            <option value="">Choose a node…</option>
            {nodes.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        )}
        {(pinned || !narrow) && node && <strong className="prm-title" title={node}>{node}</strong>}
        <label className="prm-search prm-filter">
          <SearchIcon width={13} height={13} />
          <input
            type="search"
            value={filterText}
            placeholder="Filter…"
            aria-label="Only the parameters whose name or description contain"
            title="Only the parameters whose name or description contain any of these, separated by ;"
            spellCheck={false}
            disabled={!node}
            onChange={(e) => setFilterText(e.target.value)}
          />
        </label>
        <div className="prm-tools">
          <button type="button" className="overlay-button" title="Read them again" aria-label="Read them again" disabled={!node} onClick={() => setReload((r) => r + 1)}>
            <RefreshIcon width={16} height={16} />
          </button>
          {editable && (
            <button
              type="button"
              className="overlay-button"
              aria-pressed={adding}
              title="Set a parameter the node did not declare"
              aria-label="Add a parameter"
              disabled={!node || !params}
              onClick={() => setAdding((on) => !on)}
            >
              <PlusIcon width={16} height={16} />
            </button>
          )}
          <button type="button" className="overlay-button" title="Dump them as YAML (ros2 param dump)" aria-label="Dump" aria-haspopup="menu" disabled={!node || !params} onClick={dumpMenu}>
            <DownloadIcon width={16} height={16} />
          </button>
          {editable && (
            <button type="button" className="overlay-button" title="Load a YAML file (ros2 param load)" aria-label="Load" aria-haspopup="menu" disabled={!node || !params} onClick={loadMenu}>
              <UploadIcon width={16} height={16} />
            </button>
          )}
        </div>
      </div>
      <div className="prm-body">
        {nodeList}
        <div className="prm-main">
          {adding && node && <AddForm onAdd={add} onClose={() => setAdding(false)} />}
          {results && (
            <div className="prm-results" role="status">
              <div className="prm-results-head">
                <strong>{results.title}</strong>
                <button type="button" className="overlay-button" aria-label="Close" title="Close" onClick={() => setResults(null)}>
                  <CloseIcon width={14} height={14} />
                </button>
              </div>
              <ul>
                {results.failed.map((r) => (
                  <li key={r.name}>
                    <code>{r.name}</code> {r.reason}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {content}
        </div>
      </div>
      <div className={`prm-status ${line.tone}`} title={line.text}>
        <span className="prm-status-text">{line.text}</span>
      </div>
      <input
        ref={fileRef}
        type="file"
        accept=".yaml,.yml,application/yaml,text/yaml"
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = '';
          if (file) {
            void file.text().then((yaml) => load(yaml, file.name));
          }
        }}
      />
      {browsing && (
        <FileBrowser
          kind="yaml"
          start="~"
          onClose={() => setBrowsing(false)}
          onChoose={(path) => {
            setBrowsing(false);
            fsApi.readText(path).then(
              (file) => file && void load(file.text, path),
              (e: unknown) => notify(`Could not read ${path}: ${e instanceof Error ? e.message : e}`, 'error'),
            );
          }}
        />
      )}
      {menu && <ContextMenu x={Math.max(4, menu.x)} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
    </div>
  );
}

export const parametersWidget = defineWidget<ParametersConfig>({
  type: 'parameters',
  name: 'Parameters',
  description: 'Nodes’ parameters, read and set live as rqt_reconfigure does; described, added, deleted, dumped and loaded as ros2 param does.',
  icon: SlidersIcon,
  defaultSize: { w: 9, h: 8 },
  minSize: { w: 3, h: 4 },
  component: ParametersWidget,
  properties: [
    {
      key: 'node',
      label: 'Node',
      kind: 'string',
      default: '',
      placeholder: '/controller_server',
      help: 'Only this node’s parameters, e.g. a panel to tune one node. Any node of the graph if empty',
    },
    {
      key: 'filter',
      label: 'Filter',
      kind: 'string',
      default: '',
      placeholder: 'inflation; max_vel',
      help: 'Only the parameters whose name or description contain any of these, separated by ;. The toolbar changes it',
    },
    {
      key: 'readOnly',
      label: 'View only',
      kind: 'boolean',
      default: false,
      help: 'Shows the parameters without editing them: the page’s choice, not a protection',
    },
  ],
});
