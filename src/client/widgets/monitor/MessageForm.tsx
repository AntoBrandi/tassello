// A message to publish, to call a service with, or to send as an action's
// goal: a form made from its definition, or its JSON. Numbers are kept as
// typed while they are not numbers yet; times may be "now", which the server
// makes the time of each message, as ros2 topic pub does.

import { useEffect, useId, useState } from 'react';

import type { InterfaceInfo, MessageField, MessageSchema } from '../../../shared/monitor.ts';
import { CodeIcon, ListIcon, MinusIcon, PlusIcon, UndoIcon } from '../../icons.tsx';
import { defaultValue, fieldConstants, listText, numberValue, parseList, setAt, shortType } from './model.ts';

const TIME_TYPE = 'builtin_interfaces/msg/Time';
const INTEGER = /^(u?int(8|16|32|64)|byte|char)$/;

type Path = (string | number)[];
type Set = (path: Path, value: unknown) => void;

interface FieldProps {
  info: InterfaceInfo;
  schema: MessageSchema;
  field: MessageField;
  value: unknown;
  path: Path;
  onSet: Set;
  disabled: boolean;
}

function numberText(value: unknown): string {
  return typeof value === 'number' ? String(value) : typeof value === 'string' ? value : '';
}

// Its text kept while it is not a number yet (-, 1.), its value given up
function NumberInput({
  value,
  integer,
  list,
  disabled,
  label,
  onValue,
}: {
  value: unknown;
  integer: boolean;
  list?: string;
  disabled: boolean;
  label: string;
  onValue: (value: unknown) => void;
}) {
  const [text, setText] = useState(() => numberText(value));
  useEffect(() => {
    if (numberValue(text) !== value) {
      setText(numberText(value));
    }
    // Only when the value changes from elsewhere
  }, [value]);
  const invalid = typeof numberValue(text) === 'string' && !/^\s*-?(inf|nan)\s*$/i.test(text);
  return (
    <input
      type="text"
      inputMode={integer ? 'numeric' : 'decimal'}
      className={`mon-input${invalid ? ' invalid' : ''}`}
      value={text}
      list={list}
      disabled={disabled}
      aria-label={label}
      title={label}
      spellCheck={false}
      onChange={(event) => {
        setText(event.target.value);
        onValue(numberValue(event.target.value));
      }}
    />
  );
}

// A list of numbers, booleans or strings, as text: 1, 2, 3
function ListInput({ field, value, disabled, onValue }: { field: MessageField; value: unknown; disabled: boolean; onValue: (value: unknown) => void }) {
  const [text, setText] = useState(() => listText(value));
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const parsed = parseList(text, field.type);
    if (!('value' in parsed) || JSON.stringify(parsed.value) !== JSON.stringify(value)) {
      setText(listText(value));
      setError(null);
    }
  }, [value]);
  const what = field.type === 'bool' ? 'booleans' : field.type.includes('string') ? 'strings' : 'numbers';
  const count = field.array === 'fixed' ? `${field.size} ${what}` : field.array === 'bounded' ? `${field.size} ${what} at most` : what;
  return (
    <input
      type="text"
      className={`mon-input${error ? ' invalid' : ''}`}
      value={text}
      placeholder={`${count}, separated by commas`}
      title={error ?? `${count}, separated by commas`}
      disabled={disabled}
      aria-label={field.name}
      spellCheck={false}
      onChange={(event) => {
        setText(event.target.value);
        const parsed = parseList(event.target.value, field.type);
        if ('value' in parsed) {
          setError(null);
          onValue(parsed.value);
        } else {
          setError(parsed.error);
        }
      }}
    />
  );
}

function FieldLabel({ field, htmlFor }: { field: MessageField; htmlFor?: string }) {
  const array = field.array === 'none' ? '' : field.array === 'fixed' ? `[${field.size}]` : field.array === 'bounded' ? `[<=${field.size}]` : '[]';
  return (
    <label className="mon-field-label" htmlFor={htmlFor}>
      <span className="mon-field-name">{field.name}</span>
      <span className="mon-field-type">
        {shortType(field.type)}
        {field.stringBound !== null && `<=${field.stringBound}`}
        {array}
      </span>
    </label>
  );
}

function PrimitiveField({ schema, field, value, path, onSet, disabled }: FieldProps) {
  const id = useId();
  const constants = fieldConstants(schema, field.type);
  let input;
  if (field.type === 'bool') {
    input = (
      <input
        id={id}
        type="checkbox"
        className="mon-check"
        checked={value === true}
        disabled={disabled}
        onChange={(event) => onSet(path, event.target.checked)}
      />
    );
  } else if (field.type === 'string' || field.type === 'wstring') {
    input = (
      <input
        id={id}
        type="text"
        className="mon-input"
        value={typeof value === 'string' ? value : ''}
        maxLength={field.stringBound ?? undefined}
        disabled={disabled}
        spellCheck={false}
        onChange={(event) => onSet(path, event.target.value)}
      />
    );
  } else {
    input = (
      <>
        <NumberInput
          value={value}
          integer={INTEGER.test(field.type)}
          list={constants.length ? `${id}-constants` : undefined}
          disabled={disabled}
          label={field.name}
          onValue={(v) => onSet(path, v)}
        />
        {constants.length > 0 && (
          <datalist id={`${id}-constants`}>
            {constants.map((c) => (
              <option key={c.name} value={String(c.value)} label={c.name} />
            ))}
          </datalist>
        )}
      </>
    );
  }
  const constant = constants.find((c) => c.value === value);
  return (
    <div className="mon-field">
      <FieldLabel field={field} htmlFor={id} />
      <div className="mon-field-input">
        {input}
        {constant && <span className="mon-field-constant">{constant.name}</span>}
      </div>
    </div>
  );
}

// A builtin_interfaces/msg/Time: its seconds and nanoseconds, or now
function TimeField({ field, value, path, onSet, disabled, label }: Omit<FieldProps, 'info' | 'schema'> & { label?: string }) {
  const now = value === 'now';
  const time = (value !== null && typeof value === 'object' ? value : {}) as { sec?: unknown; nanosec?: unknown };
  return (
    <div className="mon-field">
      {label ? <span className="mon-field-label"><span className="mon-field-name">{label}</span></span> : <FieldLabel field={field} />}
      <div className="mon-field-input mon-time">
        {now ? (
          <span className="mon-time-now">Now, at each message</span>
        ) : (
          <>
            <NumberInput
              value={time.sec ?? 0}
              integer
              disabled={disabled}
              label={`${field.name} seconds`}
              onValue={(v) => onSet([...path, 'sec'], v)}
            />
            <NumberInput
              value={time.nanosec ?? 0}
              integer
              disabled={disabled}
              label={`${field.name} nanoseconds`}
              onValue={(v) => onSet([...path, 'nanosec'], v)}
            />
          </>
        )}
        <button
          type="button"
          className="mon-chip"
          aria-pressed={now}
          title={now ? 'A time of its own' : 'The time each message is sent at'}
          disabled={disabled}
          onClick={() => onSet(path, now ? { sec: 0, nanosec: 0 } : 'now')}
        >
          now
        </button>
      </div>
    </div>
  );
}

function Fields({ info, type, value, path, onSet, disabled }: { info: InterfaceInfo; type: string; value: unknown; path: Path; onSet: Set; disabled: boolean }) {
  const schema = info.schemas[type];
  if (!schema) {
    return <p className="mon-muted">No definition of {type}</p>;
  }
  if (schema.fields.length === 0) {
    return <p className="mon-muted">No fields</p>;
  }
  const object = (value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {}) as Record<string, unknown>;
  return (
    <>
      {schema.fields.map((field) => (
        <Field
          key={field.name}
          info={info}
          schema={schema}
          field={field}
          value={object[field.name]}
          path={[...path, field.name]}
          onSet={onSet}
          disabled={disabled}
        />
      ))}
    </>
  );
}

function Field(props: FieldProps) {
  const { info, field, value, path, onSet, disabled } = props;
  if (field.array === 'none') {
    if (field.primitive) {
      return <PrimitiveField {...props} />;
    }
    if (field.type === TIME_TYPE) {
      return <TimeField field={field} value={value} path={path} onSet={onSet} disabled={disabled} />;
    }
    return (
      <details className="mon-group" open>
        <summary>
          <FieldLabel field={field} />
        </summary>
        <div className="mon-group-body">
          <Fields info={info} type={field.type} value={value} path={path} onSet={onSet} disabled={disabled} />
        </div>
      </details>
    );
  }
  if (field.primitive) {
    return (
      <div className="mon-field">
        <FieldLabel field={field} />
        <div className="mon-field-input">
          <ListInput field={field} value={value} disabled={disabled} onValue={(v) => onSet(path, v)} />
        </div>
      </div>
    );
  }
  // A list of messages
  const items = Array.isArray(value) ? value : [];
  const resizable = field.array !== 'fixed';
  const full = field.array === 'bounded' && field.size !== null && items.length >= field.size;
  return (
    <details className="mon-group" open>
      <summary>
        <FieldLabel field={field} />
        <span className="mon-field-count">
          {items.length} item{items.length === 1 ? '' : 's'}
        </span>
      </summary>
      <div className="mon-group-body">
        {items.map((item, index) => (
          <div key={index} className="mon-item">
            <div className="mon-item-header">
              <span className="mon-item-index">[{index}]</span>
              {resizable && (
                <button
                  type="button"
                  className="overlay-button"
                  title="Remove this item"
                  aria-label={`Remove item ${index}`}
                  disabled={disabled}
                  onClick={() => onSet(path, items.filter((_, i) => i !== index))}
                >
                  <MinusIcon width={14} height={14} />
                </button>
              )}
            </div>
            {field.type === TIME_TYPE ? (
              <TimeField field={field} label="time" value={item} path={[...path, index]} onSet={onSet} disabled={disabled} />
            ) : (
              <Fields info={info} type={field.type} value={item} path={[...path, index]} onSet={onSet} disabled={disabled} />
            )}
          </div>
        ))}
        {resizable && (
          <button
            type="button"
            className="mon-add"
            disabled={disabled || full}
            onClick={() => onSet(path, [...items, defaultValue(info.schemas, field.type)])}
          >
            <PlusIcon width={14} height={14} /> Add {field.name.replace(/s$/, '')}
          </button>
        )}
      </div>
    </details>
  );
}

function JsonEditor({ value, onChange, disabled }: { value: unknown; onChange: (value: unknown) => void; disabled: boolean }) {
  const [text, setText] = useState(() => JSON.stringify(value, null, 2));
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let same = false;
    try {
      same = JSON.stringify(JSON.parse(text)) === JSON.stringify(value);
    } catch {
      // Being typed: kept
      same = true;
    }
    if (!same) {
      setText(JSON.stringify(value, null, 2));
      setError(null);
    }
  }, [value]);
  return (
    <div className="mon-json">
      <textarea
        className={`mon-json-text${error ? ' invalid' : ''}`}
        value={text}
        spellCheck={false}
        disabled={disabled}
        aria-label="The message, as JSON"
        onChange={(event) => {
          setText(event.target.value);
          try {
            onChange(JSON.parse(event.target.value));
            setError(null);
          } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
          }
        }}
      />
      <p className={`mon-json-hint${error ? ' error' : ''}`}>
        {error ??
          'Fields left out take their default. Times may be "now", a header "auto"; numbers "nan", "inf", 64 bit integers text.'}
      </p>
    </div>
  );
}

export function MessageForm({
  info,
  type,
  value,
  initial,
  onChange,
  disabled = false,
}: {
  info: InterfaceInfo;
  // The part's type: a message's, a service's request, an action's goal
  type: string;
  value: unknown;
  // What Reset brings back
  initial: unknown;
  onChange: (value: unknown) => void;
  disabled?: boolean;
}) {
  const [json, setJson] = useState(false);
  return (
    <div className="mon-form">
      <div className="mon-form-bar">
        <div className="mon-segmented" role="group" aria-label="Edit as">
          <button type="button" aria-pressed={!json} title="Field by field" onClick={() => setJson(false)}>
            <ListIcon width={13} height={13} /> Fields
          </button>
          <button type="button" aria-pressed={json} title="As JSON" onClick={() => setJson(true)}>
            <CodeIcon width={13} height={13} /> JSON
          </button>
        </div>
        <span className="mon-spacer" />
        <button
          type="button"
          className="overlay-button"
          title="Back to the default values"
          aria-label="Back to the default values"
          disabled={disabled}
          onClick={() => onChange(initial)}
        >
          <UndoIcon width={15} height={15} />
        </button>
      </div>
      {json ? (
        <JsonEditor value={value} onChange={onChange} disabled={disabled} />
      ) : (
        <div className="mon-fields">
          <Fields info={info} type={type} value={value} path={[]} onSet={(path, v) => onChange(setAt(value, path, v))} disabled={disabled} />
        </div>
      )}
    </div>
  );
}
