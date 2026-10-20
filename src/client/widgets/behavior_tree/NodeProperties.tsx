// The behavior tree editor's side panel: the selected node's name and ports
// (those of its model, with their types, defaults and descriptions, and any
// other attribute), what to do with it (move, duplicate, wrap, delete); or,
// the tree itself selected, its ID and whether it is the main one.

import { useEffect, useId, useMemo, useState, type ReactNode } from 'react';

import type { BtNodeModel, BtPortModel } from '../../../shared/bt_nodes.ts';
import type { BtNodeKind } from '../../../shared/protocol.ts';
import { Modal } from '../../dialogs.tsx';
import { ArrowRightIcon, CloseIcon, CopyIcon, PlusIcon, TrashIcon, TreeIcon } from '../../icons.tsx';
import type { Catalog, GraphNode } from './editor_model.ts';
import { KindIcon, kindLabel } from './parts.tsx';
import type { XmlNode } from './xml_document.ts';

// BT.CPP 4's scripts run before and after any node
const SCRIPT_ATTRIBUTES = ['_skipIf', '_successIf', '_failureIf', '_while', '_onSuccess', '_onFailure', '_onHalted', '_post'];
const DIRECTIONS: Record<BtPortModel['direction'], string> = { input: 'in', output: 'out', inout: 'in/out' };

// A value typed in: the document follows each key, an undo step for all of them
function ValueInput({
  id,
  value,
  placeholder,
  onChange,
  onDone,
  label,
}: {
  id?: string;
  value: string;
  placeholder?: string;
  onChange: (value: string) => void;
  onDone: () => void;
  label?: string;
}) {
  const props = {
    id,
    value,
    placeholder,
    spellCheck: false,
    'aria-label': label,
    onBlur: onDone,
  };
  // Scripts on several lines
  return value.includes('\n') ? (
    <textarea {...props} rows={Math.min(8, value.split('\n').length + 1)} onChange={(e) => onChange(e.target.value)} />
  ) : (
    <input {...props} onChange={(e) => onChange(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()} />
  );
}

// Applied when done (Enter, or leaving it), if valid: an ID, an attribute's name
function CommitInput({
  value,
  label,
  validate,
  onCommit,
}: {
  value: string;
  label: string;
  // Why it cannot be, null if it can
  validate: (value: string) => string | null;
  onCommit: (value: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const error = draft.trim() === value ? null : validate(draft.trim());
  const commit = () => {
    if (!error && draft.trim() !== value) {
      onCommit(draft.trim());
    } else {
      setDraft(value);
    }
  };
  return (
    <>
      <input
        value={draft}
        aria-label={label}
        aria-invalid={error !== null}
        spellCheck={false}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.currentTarget.blur();
          } else if (e.key === 'Escape') {
            setDraft(value);
          }
        }}
      />
      {error && <p className="field-help error">{error}</p>}
    </>
  );
}

const ATTRIBUTE_NAME = /^[A-Za-z_:][-\w:.]*$/;

export interface NodeActions {
  // null: not possible
  moveEarlier: (() => void) | null;
  moveLater: (() => void) | null;
  duplicate: (() => void) | null;
  wrap: (() => void) | null;
  unwrap: (() => void) | null;
  replace: (() => void) | null;
  remove: () => void;
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h3>{title}</h3>
      {children}
    </section>
  );
}

export function NodeProperties({
  node,
  element,
  catalog,
  format,
  actions,
  onAttribute,
  onRenameAttribute,
  onSeal,
  onOpenTree,
  onClose,
}: {
  node: GraphNode;
  element: XmlNode;
  catalog: Catalog;
  format: 3 | 4;
  actions: NodeActions;
  // Its attribute's value (null: removed), typed (tag: one undo step) or not
  onAttribute: (name: string, value: string | null, typed?: boolean) => void;
  onRenameAttribute: (from: string, to: string) => void;
  // Done typing
  onSeal: () => void;
  onOpenTree: (id: string) => void;
  onClose: () => void;
}) {
  const id = useId();
  const [adding, setAdding] = useState({ name: '', value: '' });
  const model = node.model?.model ?? null;
  const subtree = node.kind === 'subtree';
  const remap = format === 4 ? '_autoremap' : '__shared_blackboard';
  // Shown apart from the other attributes
  const special = new Set(['name', ...(subtree ? ['ID', remap] : [])]);
  const modelPorts = model?.ports ?? [];
  const others = Object.keys(node.ports).filter((name) => !special.has(name) && !modelPorts.some((port) => port.name === name));
  const suggestions = [
    ...modelPorts.map((port) => port.name).filter((name) => !(name in node.ports)),
    ...(format === 4 ? SCRIPT_ATTRIBUTES.filter((name) => !(name in node.ports)) : []),
  ];
  const addError =
    adding.name && !ATTRIBUTE_NAME.test(adding.name)
      ? 'Not an attribute name'
      : adding.name in element.attributes || special.has(adding.name)
        ? 'It has it already'
        : null;
  const add = () => {
    if (adding.name && !addError) {
      onAttribute(adding.name, adding.value);
      setAdding({ name: '', value: '' });
    }
  };

  return (
    <aside className="bt-details bte-properties" aria-label={`${node.type}: properties`}>
      <header className="bt-details-header">
        <KindIcon node={node} size={18} />
        <div className="bt-details-title">
          <strong>{node.type}</strong>
          <span>
            {kindLabel(node)} · {node.model?.library ?? 'not in the libraries'}
          </span>
        </div>
        <button type="button" className="icon-button" aria-label="Close" onClick={onClose}>
          <CloseIcon width={16} height={16} />
        </button>
      </header>
      <div className="bte-actions" role="toolbar" aria-label="What to do with it">
        <button type="button" className="icon-button" title="Move earlier (Alt+←)" aria-label="Move earlier" disabled={!actions.moveEarlier} onClick={() => actions.moveEarlier?.()}>
          <ArrowRightIcon width={16} height={16} style={{ transform: 'scaleX(-1)' }} />
        </button>
        <button type="button" className="icon-button" title="Move later (Alt+→)" aria-label="Move later" disabled={!actions.moveLater} onClick={() => actions.moveLater?.()}>
          <ArrowRightIcon width={16} height={16} />
        </button>
        <button type="button" className="icon-button" title="Duplicate (Ctrl+D)" aria-label="Duplicate" disabled={!actions.duplicate} onClick={() => actions.duplicate?.()}>
          <CopyIcon width={16} height={16} />
        </button>
        <span className="bte-actions-text">
          <button type="button" className="link-button" disabled={!actions.replace} onClick={() => actions.replace?.()} title="Another node of its kind in its place: its name, ports and children kept">
            Change
          </button>
          <button type="button" className="link-button" disabled={!actions.wrap} onClick={() => actions.wrap?.()} title="Put it under a new control node or decorator">
            Wrap
          </button>
          <button type="button" className="link-button" disabled={!actions.unwrap} onClick={() => actions.unwrap?.()} title="Delete it, its children in its place">
            Unwrap
          </button>
        </span>
        <button type="button" className="icon-button danger" title="Delete, with its children (Delete)" aria-label="Delete" onClick={actions.remove}>
          <TrashIcon width={16} height={16} />
        </button>
      </div>
      <div className="bt-details-body">
        {node.problems.length > 0 && (
          <ul className="bte-problems">
            {node.problems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        )}
        {model?.description && <p className="bt-muted bte-description">{model.description}</p>}
        <div className="field">
          <label className="field-label" htmlFor={`${id}-name`}>
            Name
          </label>
          <ValueInput
            id={`${id}-name`}
            value={element.attributes.name ?? ''}
            placeholder={subtree ? (element.attributes.ID ?? '') : node.type}
            onChange={(value) => onAttribute('name', value || null, true)}
            onDone={onSeal}
          />
        </div>
        {subtree && (
          <div className="field">
            <label className="field-label" htmlFor={`${id}-tree`}>
              Tree
            </label>
            <div className="bte-row">
              <select id={`${id}-tree`} value={element.attributes.ID ?? ''} onChange={(e) => onAttribute('ID', e.target.value)}>
                {!catalog.trees.includes(element.attributes.ID ?? '') && <option value={element.attributes.ID ?? ''}>{element.attributes.ID || '—'}</option>}
                {catalog.trees.map((tree) => (
                  <option key={tree} value={tree}>
                    {tree}
                  </option>
                ))}
              </select>
              <button type="button" className="button" disabled={!element.attributes.ID} onClick={() => onOpenTree(element.attributes.ID ?? '')}>
                Open
              </button>
            </div>
            <label className="bte-check">
              <input
                type="checkbox"
                checked={element.attributes[remap] === 'true'}
                onChange={(e) => onAttribute(remap, e.target.checked ? 'true' : null)}
              />
              {format === 4 ? 'Its ports those of this tree’s blackboard of the same names (_autoremap)' : 'Shares this tree’s blackboard (__shared_blackboard)'}
            </label>
          </div>
        )}
        {modelPorts.length > 0 && (
          <Section title="Ports">
            {modelPorts.map((port) => (
              <div key={port.name} className="field bte-port">
                <label className="field-label" htmlFor={`${id}-port-${port.name}`}>
                  <span className="bte-port-name">{port.name}</span>
                  <span className={`bte-direction ${port.direction}`}>{DIRECTIONS[port.direction]}</span>
                  {port.type && <span className="bt-muted bte-port-type">{port.type}</span>}
                </label>
                <ValueInput
                  id={`${id}-port-${port.name}`}
                  value={element.attributes[port.name] ?? ''}
                  placeholder={port.default !== null ? `${port.default} (default)` : port.direction === 'input' ? '' : `{${port.name}}`}
                  onChange={(value) => onAttribute(port.name, value === '' ? null : value, true)}
                  onDone={onSeal}
                />
                {port.description && <p className="field-help">{port.description}</p>}
              </div>
            ))}
          </Section>
        )}
        {others.length > 0 && (
          <Section title={model ? 'Other attributes' : 'Attributes'}>
            {others.map((name) => (
              <div key={name} className="bte-attribute">
                <CommitInput
                  value={name}
                  label="Its name"
                  validate={(value) =>
                    !ATTRIBUTE_NAME.test(value) ? 'Not an attribute name' : value in element.attributes ? 'It has it already' : null
                  }
                  onCommit={(value) => onRenameAttribute(name, value)}
                />
                <ValueInput
                  value={element.attributes[name]}
                  label={`${name}: its value`}
                  onChange={(value) => onAttribute(name, value, true)}
                  onDone={onSeal}
                />
                <button type="button" className="icon-button" aria-label={`Remove ${name}`} title="Remove" onClick={() => onAttribute(name, null)}>
                  <CloseIcon width={14} height={14} />
                </button>
              </div>
            ))}
          </Section>
        )}
        <Section title="Add an attribute">
          <form
            className="bte-attribute"
            onSubmit={(e) => {
              e.preventDefault();
              add();
            }}
          >
            <input
              list={`${id}-suggestions`}
              placeholder="name"
              aria-label="The new attribute’s name"
              spellCheck={false}
              value={adding.name}
              onChange={(e) => setAdding((current) => ({ ...current, name: e.target.value.trim() }))}
            />
            <datalist id={`${id}-suggestions`}>
              {suggestions.map((name) => (
                <option key={name} value={name} />
              ))}
            </datalist>
            <input
              placeholder="value"
              aria-label="The new attribute’s value"
              spellCheck={false}
              value={adding.value}
              onChange={(e) => setAdding((current) => ({ ...current, value: e.target.value }))}
            />
            <button type="submit" className="icon-button" aria-label="Add" title="Add" disabled={!adding.name || addError !== null}>
              <PlusIcon width={16} height={16} />
            </button>
          </form>
          {addError && <p className="field-help error">{addError}</p>}
        </Section>
      </div>
    </aside>
  );
}

export function TreeProperties({
  id,
  isMain,
  trees,
  problems,
  onRename,
  onMain,
  onRemove,
  onClose,
}: {
  id: string;
  isMain: boolean;
  // The file's tree IDs
  trees: string[];
  problems: string[];
  onRename: (id: string) => void;
  onMain: () => void;
  // null: its only tree
  onRemove: (() => void) | null;
  onClose: () => void;
}) {
  return (
    <aside className="bt-details bte-properties" aria-label={`The tree ${id}: properties`}>
      <header className="bt-details-header">
        <TreeIcon className="bt-kind" width={18} height={18} />
        <div className="bt-details-title">
          <strong>{id || 'Unnamed tree'}</strong>
          <span>BehaviorTree{isMain ? ' · the main one' : ''}</span>
        </div>
        <button type="button" className="icon-button" aria-label="Close" onClick={onClose}>
          <CloseIcon width={16} height={16} />
        </button>
      </header>
      <div className="bt-details-body">
        {problems.length > 0 && (
          <ul className="bte-problems">
            {problems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        )}
        <div className="field">
          <span className="field-label">ID</span>
          <CommitInput
            value={id}
            label="The tree’s ID"
            validate={(value) => (!value ? 'A tree needs an ID' : trees.includes(value) ? 'Another tree has it' : null)}
            onCommit={onRename}
          />
          <p className="field-help">Its subtrees and main_tree_to_execute follow</p>
        </div>
        <label className="bte-check">
          <input type="checkbox" checked={isMain} disabled={isMain || !id} onChange={onMain} />
          The main tree: the one BT.CPP runs (main_tree_to_execute)
        </label>
        {onRemove && (
          <button type="button" className="button danger" onClick={onRemove}>
            <TrashIcon width={16} height={16} /> Delete the tree
          </button>
        )}
      </div>
    </aside>
  );
}

// A node model to pick: to wrap a node in, to replace it with
export function NodePicker({
  title,
  models,
  kinds,
  onPick,
  onClose,
}: {
  title: string;
  models: { model: BtNodeModel; library: string }[];
  kinds: BtNodeKind[];
  onPick: (model: BtNodeModel) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const shown = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    return models
      .filter(({ model, library }) => kinds.includes(model.kind) && words.every((word) => `${model.id} ${library}`.toLowerCase().includes(word)))
      .sort((a, b) => kinds.indexOf(a.model.kind) - kinds.indexOf(b.model.kind) || a.model.id.localeCompare(b.model.id));
  }, [models, kinds, query]);
  return (
    <Modal title={title} onClose={onClose}>
      <form
        className="modal-body bte-picker"
        onSubmit={(e) => {
          e.preventDefault();
          if (shown[0]) {
            onPick(shown[0].model);
          }
        }}
      >
        <input type="search" placeholder="Search" aria-label="Search" value={query} autoFocus onChange={(e) => setQuery(e.target.value)} />
        <ul>
          {shown.map(({ model, library }) => (
            <li key={`${library}/${model.id}`}>
              <button type="button" className="bte-palette-item" title={model.description} onClick={() => onPick(model)}>
                <KindIcon node={{ kind: model.kind, type: model.id }} />
                <span className="bte-palette-name">{model.id}</span>
                <span className="bte-palette-library">{library}</span>
              </button>
            </li>
          ))}
          {shown.length === 0 && <li className="bt-muted">None</li>}
        </ul>
      </form>
    </Modal>
  );
}
