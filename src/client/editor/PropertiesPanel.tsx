// Edits the selected widget, of the board or of the status bar: its title
// (the board's only) and the properties its definition declares. Text and
// numbers are applied when the field is left (or on Enter), not on every
// keystroke: a camera would resubscribe for every letter typed.

import { useEffect, useId, useState, type ComponentType, type ReactNode, type SVGProps } from 'react';

import type { DisplayInstance, TopicInfo } from '../../shared/panel.ts';
import { api } from '../api.ts';
import { CloseIcon, CopyIcon, QuestionIcon, TrashIcon } from '../icons.tsx';
import { DisplaysEditor } from './DisplaysEditor.tsx';
import { FileInput } from './FileInput.tsx';
import { resolveConfig } from '../widgets/registry.ts';
import type { Property } from '../widgets/types.ts';

interface SelectOption {
  value: string;
  label: string;
}

export interface PropertiesPanelProps {
  type: string;
  // Its widget's or status widget's, if the type is known
  definition:
    | {
        name: string;
        icon: ComponentType<SVGProps<SVGSVGElement>>;
        properties: Property[];
        migrate?: (stored: Record<string, unknown>) => Record<string, unknown>;
      }
    | undefined;
  // As stored
  config: Record<string, unknown>;
  // A widget of the board's; status widgets have none
  title?: string;
  // Where it is
  meta: string;
  label: string;
  onConfig: (config: Record<string, unknown>) => void;
  onTitle?: (title: string) => void;
  onDuplicate: () => void;
  onRemove: () => void;
  onClose: () => void;
}

export function PropertiesPanel({
  type,
  definition,
  config: stored,
  title,
  meta,
  label,
  onConfig,
  onTitle,
  onDuplicate,
  onRemove,
  onClose,
}: PropertiesPanelProps) {
  const config = definition ? resolveConfig(definition, stored) : stored;
  const Icon = definition?.icon ?? QuestionIcon;
  // Onto the config as upgraded, if saved by an earlier version
  const setProperty = (key: string, value: unknown) =>
    onConfig({ ...(definition?.migrate ? definition.migrate(stored) : stored), [key]: value });

  return (
    <aside className="properties" aria-label={label}>
      <header className="properties-header">
        <Icon />
        <h2>{definition?.name ?? type}</h2>
        <button type="button" className="icon-button" aria-label="Close" onClick={onClose}>
          <CloseIcon />
        </button>
      </header>
      <div className="properties-body">
        {title !== undefined && onTitle && (
          <Field label="Title" help="Shown above the widget, if set">
            {(id) => <CommittedInput id={id} value={title} onCommit={onTitle} />}
          </Field>
        )}
        {definition?.properties
          .filter((property) => !property.visible || property.visible(config))
          .map((property) => (
            <PropertyField
              key={property.key}
              property={property}
              value={config[property.key]}
              onChange={(value) => setProperty(property.key, value)}
            />
          ))}
        <p className="properties-meta">{meta}</p>
      </div>
      <footer className="properties-footer">
        <button type="button" className="button" onClick={onDuplicate}>
          <CopyIcon /> Duplicate
        </button>
        <button type="button" className="button danger" onClick={onRemove}>
          <TrashIcon /> Remove
        </button>
      </footer>
    </aside>
  );
}

function Field({ label, help, children }: { label: string; help?: string; children: (id: string) => ReactNode }) {
  const id = useId();
  return (
    <div className="field">
      <label className="field-label" htmlFor={id}>
        {label}
      </label>
      {children(id)}
      {help && <p className="field-help">{help}</p>}
    </div>
  );
}

function PropertyField({
  property,
  value,
  onChange,
}: {
  property: Property;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  if (property.kind === 'displays') {
    return (
      <div className="field">
        <span className="field-label">{property.label}</span>
        {property.help && <p className="field-help">{property.help}</p>}
        <DisplaysEditor
          value={value as DisplayInstance[]}
          onChange={onChange}
          renderProperty={(p, v, change) => <PropertyField property={p} value={v} onChange={change} />}
        />
      </div>
    );
  }
  if (property.kind === 'boolean') {
    return (
      <div className="field">
        <label className="toggle">
          <input type="checkbox" checked={value === true} onChange={(e) => onChange(e.target.checked)} />
          <span className="toggle-switch" aria-hidden="true" />
          <span className="field-label">{property.label}</span>
        </label>
        {property.help && <p className="field-help">{property.help}</p>}
      </div>
    );
  }
  return (
    <Field label={property.label} help={property.help}>
      {(id) => {
        switch (property.kind) {
          case 'number':
            return (
              <CommittedInput
                id={id}
                type="number"
                min={property.min}
                max={property.max}
                step={property.step ?? 'any'}
                value={String(value)}
                onCommit={(text) => {
                  const number = Number(text);
                  if (text.trim() && Number.isFinite(number)) {
                    onChange(Math.min(property.max ?? Infinity, Math.max(property.min ?? -Infinity, number)));
                  }
                }}
              />
            );
          case 'select':
            return property.useOptions ? (
              <RunTimeSelect
                id={id}
                value={String(value)}
                options={property.options}
                useOptions={property.useOptions}
                onChange={onChange}
              />
            ) : (
              <select id={id} value={String(value)} onChange={(e) => onChange(e.target.value)}>
                {property.options.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            );
          case 'color':
            return (
              <div className="color-field">
                <input id={id} type="color" value={String(value)} onChange={(e) => onChange(e.target.value)} />
                <code>{String(value)}</code>
              </div>
            );
          case 'text':
            return (
              <CommittedInput
                id={id}
                multiline
                value={String(value)}
                placeholder={property.placeholder}
                onCommit={onChange}
              />
            );
          case 'image':
          case 'behavior-tree':
            return (
              <FileInput
                id={id}
                kind={property.kind}
                value={String(value)}
                placeholder={property.placeholder}
                onCommit={onChange}
              >
                {(props) => <CommittedInput {...props} />}
              </FileInput>
            );
          case 'topic':
            return (
              <TopicInput
                id={id}
                value={String(value)}
                types={property.topicTypes}
                placeholder={property.placeholder}
                onCommit={onChange}
              />
            );
          default:
            return (
              <CommittedInput
                id={id}
                value={String(value)}
                placeholder={property.placeholder}
                onCommit={onChange}
              />
            );
        }
      }}
    </Field>
  );
}

// An input whose value is applied when left or on Enter (Ctrl+Enter when
// multi-line), and reverted with Escape
function CommittedInput({
  value,
  onCommit,
  multiline = false,
  ...props
}: {
  id: string;
  value: string;
  onCommit: (value: string) => void;
  multiline?: boolean;
  type?: string;
  min?: number;
  max?: number;
  step?: number | 'any';
  placeholder?: string;
  list?: string;
  onFocus?: () => void;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => draft !== value && onCommit(draft);
  const common = {
    ...props,
    value: draft,
    spellCheck: false,
    onBlur: commit,
    onChange: (e: { target: { value: string } }) => setDraft(e.target.value),
  };
  if (multiline) {
    return (
      <textarea
        {...common}
        rows={4}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            commit();
          } else if (e.key === 'Escape') {
            setDraft(value);
          }
        }}
      />
    );
  }
  return (
    <input
      {...common}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          commit();
        } else if (e.key === 'Escape') {
          setDraft(value);
        }
      }}
    />
  );
}

// A select whose options are also known at run time (useOptions, a hook: the
// same one for as long as the panel shows the widget). The value is kept when
// among neither, e.g. while they are fetched, and shown as it is.
function RunTimeSelect({
  id,
  value,
  options,
  useOptions,
  onChange,
}: {
  id: string;
  value: string;
  options: SelectOption[];
  useOptions: () => SelectOption[];
  onChange: (value: string) => void;
}) {
  const found = useOptions();
  const all = [...options, ...found.filter((option) => !options.some((o) => o.value === option.value))];
  return (
    <select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
      {!all.some((option) => option.value === value) && <option value={value}>{value}</option>}
      {all.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

// Suggests the topics of the given types, as the ROS graph has them now
function TopicInput({
  id,
  value,
  types,
  placeholder,
  onCommit,
}: {
  id: string;
  value: string;
  types: string[];
  placeholder?: string;
  onCommit: (value: string) => void;
}) {
  const [topics, setTopics] = useState<TopicInfo[]>([]);
  const listId = `${id}-topics`;
  const refresh = () =>
    api
      .listTopics()
      .then(setTopics)
      .catch(() => setTopics([]));
  const matching = topics.filter((topic) => topic.types.some((type) => types.includes(type)));
  return (
    <>
      <CommittedInput
        id={id}
        value={value}
        placeholder={placeholder}
        list={listId}
        onFocus={refresh}
        onCommit={onCommit}
      />
      <datalist id={listId}>
        {matching.map((topic) => (
          <option key={topic.name} value={topic.name}>
            {topic.types.join(', ')}
          </option>
        ))}
      </datalist>
    </>
  );
}
