// A Robot Viewer's displays, in the side panel: as RViz's Displays panel, a
// list in the order they are drawn, each shown or hidden, renamed, moved and
// removed, opened to edit its own properties; others added from those
// registered, Tassello's and the plugins'. A display of a plugin not
// installed is kept as it is.

import { Fragment, useState, type ReactNode } from 'react';

import type { DisplayInstance } from '../../shared/panel.ts';
import { ArrowDownIcon, ArrowUpIcon, ChevronRightIcon, QuestionIcon, TrashIcon } from '../icons.tsx';
import { displayDefinition, displayEntries, resolveConfig } from '../widgets/registry.ts';
import { moveItem, newDisplayId } from '../widgets/robot_viewer/model.ts';
import type { Property } from '../widgets/types.ts';

export interface DisplaysEditorProps {
  value: DisplayInstance[];
  onChange: (displays: DisplayInstance[]) => void;
  // A property's field, as the side panel's
  renderProperty: (property: Property, value: unknown, onChange: (value: unknown) => void) => ReactNode;
}

export function DisplaysEditor({ value, onChange, renderProperty }: DisplaysEditorProps) {
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const toggle = (id: string) =>
    setOpen((previous) => {
      const next = new Set(previous);
      if (!next.delete(id)) {
        next.add(id);
      }
      return next;
    });
  const change = (index: number, changes: Partial<DisplayInstance>) =>
    onChange(value.map((display, i) => (i === index ? { ...display, ...changes } : display)));
  const add = (type: string) => {
    const id = newDisplayId(value.map((display) => display.id));
    onChange([...value, { id, type, name: '', enabled: true, config: {} }]);
    setOpen((previous) => new Set(previous).add(id));
  };

  return (
    <div className="displays">
      {value.length > 0 && (
        <ul className="displays-list">
          {value.map((display, index) => {
            const definition = displayDefinition(display.type);
            const Icon = definition?.icon ?? QuestionIcon;
            const name = display.name.trim() || definition?.name || display.type;
            const isOpen = open.has(display.id);
            const config = definition ? resolveConfig(definition, display.config) : display.config;
            const nameProperty: Property = {
              key: 'name',
              label: 'Name',
              kind: 'string',
              default: '',
              placeholder: definition?.name ?? display.type,
            };
            return (
              <li key={display.id} className={`display-item${display.enabled ? '' : ' hidden'}${isOpen ? ' open' : ''}`}>
                <div className="display-row">
                  <input
                    type="checkbox"
                    className="display-enabled"
                    checked={display.enabled}
                    aria-label={`Show ${name}`}
                    title={display.enabled ? 'Shown' : 'Hidden'}
                    onChange={(e) => change(index, { enabled: e.target.checked })}
                  />
                  <button
                    type="button"
                    className="display-title"
                    aria-expanded={isOpen}
                    title={definition?.description ?? `No display "${display.type}"`}
                    onClick={() => toggle(display.id)}
                  >
                    <ChevronRightIcon className="display-chevron" width={14} height={14} />
                    <Icon width={16} height={16} />
                    <span className="display-name">{name}</span>
                  </button>
                  <button
                    type="button"
                    className="icon-button small"
                    aria-label={`Move ${name} up`}
                    title="Move up"
                    disabled={index === 0}
                    onClick={() => onChange(moveItem(value, index, -1))}
                  >
                    <ArrowUpIcon width={14} height={14} />
                  </button>
                  <button
                    type="button"
                    className="icon-button small"
                    aria-label={`Move ${name} down`}
                    title="Move down"
                    disabled={index === value.length - 1}
                    onClick={() => onChange(moveItem(value, index, 1))}
                  >
                    <ArrowDownIcon width={14} height={14} />
                  </button>
                  <button
                    type="button"
                    className="icon-button small"
                    aria-label={`Remove ${name}`}
                    title="Remove"
                    onClick={() => onChange(value.filter((_, i) => i !== index))}
                  >
                    <TrashIcon width={14} height={14} />
                  </button>
                </div>
                {isOpen && (
                  <div className="display-body">
                    {definition ? (
                      <>
                        {renderProperty(nameProperty, display.name, (name) => change(index, { name: String(name) }))}
                        {definition.properties
                          .filter((property) => !property.visible || property.visible(config))
                          .map((property) => (
                            <Fragment key={property.key}>
                              {renderProperty(property, config[property.key], (v) =>
                                change(index, { config: { ...display.config, [property.key]: v } }),
                              )}
                            </Fragment>
                          ))}
                      </>
                    ) : (
                      <p className="field-help">
                        No display “{display.type}”: is its plugin installed? It is kept as it is.
                      </p>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <select className="displays-add" value="" aria-label="Add a display" onChange={(e) => e.target.value && add(e.target.value)}>
        <option value="">＋ Add a display…</option>
        {displayEntries().map(({ definition, plugin }) => (
          <option key={definition.type} value={definition.type} title={definition.description}>
            {definition.name}
            {plugin ? ` (${plugin})` : ''}
          </option>
        ))}
      </select>
    </div>
  );
}
