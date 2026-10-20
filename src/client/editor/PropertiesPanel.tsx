// Edits the selected widget: its title and the properties its definition
// declares. Text and numbers are applied when the field is left (or on Enter),
// not on every keystroke: a camera would resubscribe for every letter typed.

import { useEffect, useId, useState, type ReactNode } from 'react';

import type { TopicInfo, WidgetInstance } from '../../shared/panel.ts';
import { api } from '../api.ts';
import { CloseIcon, CopyIcon, QuestionIcon, TrashIcon } from '../icons.tsx';
import { FileInput } from './FileInput.tsx';
import { resolveConfig, widgetDefinition } from '../widgets/registry.ts';
import type { Property } from '../widgets/types.ts';

export interface PropertiesPanelProps {
  widget: WidgetInstance;
  onChange: (widget: WidgetInstance) => void;
  onDuplicate: () => void;
  onRemove: () => void;
  onClose: () => void;
}

export function PropertiesPanel({ widget, onChange, onDuplicate, onRemove, onClose }: PropertiesPanelProps) {
  const definition = widgetDefinition(widget.type);
  const config = definition ? resolveConfig(definition, widget.config) : widget.config;
  const Icon = definition?.icon ?? QuestionIcon;
  const setProperty = (key: string, value: unknown) =>
    onChange({ ...widget, config: { ...widget.config, [key]: value } });

  return (
    <aside className="properties" aria-label="Widget properties">
      <header className="properties-header">
        <Icon />
        <h2>{definition?.name ?? widget.type}</h2>
        <button type="button" className="icon-button" aria-label="Close" onClick={onClose}>
          <CloseIcon />
        </button>
      </header>
      <div className="properties-body">
        <Field label="Title" help="Shown above the widget, if set">
          {(id) => (
            <CommittedInput id={id} value={widget.title} onCommit={(title) => onChange({ ...widget, title })} />
          )}
        </Field>
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
        <p className="properties-meta">
          {widget.w}×{widget.h} cells at column {widget.x + 1}, row {widget.y + 1}
        </p>
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
            return (
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
