// The plot's series, chosen: a topic of the graph, then fields among those
// of its latest message that are numbers (a joint's named), or typed; each
// series' label. Those plotted are listed under the fields, which do not
// move as they are added.

import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from 'react';

import type { GraphSnapshot } from '../../../shared/monitor.ts';
import type { StreamStatus } from '../../../shared/protocol.ts';
import { connection } from '../../connection.ts';
import { Modal } from '../../dialogs.tsx';
import { CheckIcon, CloseIcon, PlusIcon, SearchIcon } from '../../icons.tsx';
import { isHiddenName } from '../monitor/model.ts';
import { fieldLabel, MAX_SERIES, numericFields, seriesName, seriesPath, valueText, type Series } from './model.ts';

// Lists of the messages echoed are cut to this many items
const LIST_ITEMS = 64;
// Fields listed at once: more are filtered
const SHOWN_FIELDS = 300;
const REFRESH_MS = 500;

// A topic's latest message, as echoed, every REFRESH_MS
function useLatest(topic: string | null): { status: { state: StreamStatus['state']; message: string } | null; message: unknown } {
  const [status, setStatus] = useState<{ state: StreamStatus['state']; message: string } | null>(null);
  const [message, setMessage] = useState<unknown>(undefined);
  const latest = useRef<unknown>(undefined);
  useEffect(() => {
    setStatus(null);
    setMessage(undefined);
    if (!topic) {
      return;
    }
    // The first at once
    let shown = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = connection.subscribeTopicMonitor(
      { topic, window: 2, echo: { field: '', truncate: LIST_ITEMS } },
      {
        status: (state, text) => setStatus({ state, message: text }),
        echo: (echo) => {
          latest.current = echo.message;
          if (!shown) {
            shown = true;
            setMessage(echo.message);
          }
          timer ??= setTimeout(() => {
            timer = null;
            setMessage(latest.current);
          }, REFRESH_MS);
        },
      },
    );
    return () => {
      unsubscribe();
      if (timer) {
        clearTimeout(timer);
      }
    };
  }, [topic]);
  return { status, message };
}

export function SeriesDialog({
  series,
  onChange,
  onClose,
}: {
  series: Series[];
  onChange: (series: Series[]) => void;
  onClose: () => void;
}) {
  const id = useId();
  const [graph, setGraph] = useState<GraphSnapshot | null>(null);
  useEffect(() => connection.subscribeGraph(setGraph), []);
  const [topicText, setTopicText] = useState(() => series[series.length - 1]?.topic ?? '');
  const [filter, setFilter] = useState('');
  const [typed, setTyped] = useState('');

  const topics = useMemo(
    () => (graph?.topics ?? []).filter((t) => !isHiddenName(t.name)).sort((a, b) => a.name.localeCompare(b.name)),
    [graph],
  );
  const topic = topicText.trim() ? topicText.trim().replace(/^\/?/, '/') : '';
  const known = topics.find((t) => t.name === topic) ?? null;
  const { status, message } = useLatest(known?.name ?? null);
  const { fields, cut } = useMemo(
    () => (message === undefined ? { fields: [], cut: false } : numericFields(message)),
    [message],
  );
  const words = filter.trim().toLowerCase();
  const matching = words
    ? fields.filter((f) => f.field.toLowerCase().includes(words) || f.name?.toLowerCase().includes(words))
    : fields;
  const plotted = new Set(series.map((s) => s.path));
  const full = series.length >= MAX_SERIES;

  const toggle = (field: string, label: string) => {
    const path = seriesPath(topic, field);
    if (plotted.has(path)) {
      onChange(series.filter((s) => s.path !== path));
    } else if (!full) {
      onChange([...series, { path, topic, field, label }]);
    }
  };

  const addTyped = (event: FormEvent) => {
    event.preventDefault();
    const field = typed.trim().replace(/^\./, '');
    if (topic && field && !/\s/.test(field) && !plotted.has(seriesPath(topic, field)) && !full) {
      onChange([...series, { path: seriesPath(topic, field), topic, field, label: '' }]);
      setTyped('');
    }
  };

  const relabel = (path: string, label: string) => {
    const words = label.trim().replace(/\s+/g, ' ');
    if (series.some((s) => s.path === path && s.label !== words)) {
      onChange(series.map((s) => (s.path === path ? { ...s, label: words } : s)));
    }
  };

  let waiting: string | null = null;
  if (!topic) {
    waiting = 'Choose a topic: the fields of its messages that are numbers are listed.';
  } else if (!known) {
    waiting = graph ? `${topic} is not in the ROS graph now: type its field below.` : 'Reading the ROS graph…';
  } else if (status?.state === 'error') {
    waiting = status.message;
  } else if (message === undefined) {
    waiting = `Waiting for a message on ${topic}…`;
  } else if (fields.length === 0) {
    waiting = `The messages of ${topic} have no numbers.`;
  }

  return (
    <Modal title="Plot series" onClose={onClose} resizable>
      <div className="modal-body plot-dialog">
        <section className="field plot-adding">
          <label className="field-label" htmlFor={`${id}-topic`}>
            Add from the topic
          </label>
          <input
            id={`${id}-topic`}
            className="plot-mono"
            list={`${id}-topics`}
            value={topicText}
            placeholder="/odom"
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => setTopicText(e.target.value)}
          />
          <datalist id={`${id}-topics`}>
            {topics.map((t) => (
              <option key={t.name} value={t.name} label={t.types.join(', ')} />
            ))}
          </datalist>
          {known && <span className="field-help plot-mono">{known.types.join(', ')}</span>}
          {waiting ? (
            <p className="field-help">{waiting}</p>
          ) : (
            <>
              <label className="bag-search">
                <SearchIcon width={13} height={13} />
                <input
                  type="search"
                  value={filter}
                  placeholder="Filter…"
                  aria-label="Only the fields containing"
                  spellCheck={false}
                  onChange={(e) => setFilter(e.target.value)}
                />
              </label>
              <ul className="plot-fields" aria-label={`Fields of ${topic}`}>
                {matching.slice(0, SHOWN_FIELDS).map((f) => {
                  const on = plotted.has(seriesPath(topic, f.field));
                  return (
                    <li key={f.field}>
                      <button
                        type="button"
                        className="plot-field"
                        aria-pressed={on}
                        disabled={!on && full}
                        title={on ? 'Remove from the plot' : full ? `${MAX_SERIES} series at most` : 'Plot it'}
                        onClick={() => toggle(f.field, fieldLabel(f))}
                      >
                        <span className="plot-field-mark" aria-hidden="true">
                          {on ? <CheckIcon width={13} height={13} /> : <PlusIcon width={13} height={13} />}
                        </span>
                        <code>{f.field}</code>
                        {f.name && <span className="plot-field-name">{f.name}</span>}
                        <span className="plot-field-value">{valueText(f.value)}</span>
                      </button>
                    </li>
                  );
                })}
                {matching.length === 0 && <li className="bag-muted">No field contains “{filter.trim()}”.</li>}
                {matching.length > SHOWN_FIELDS && (
                  <li className="bag-muted">
                    And {matching.length - SHOWN_FIELDS} more: filter them.
                  </li>
                )}
              </ul>
              {cut && <p className="field-help">Lists are cut to their first {LIST_ITEMS} items: type further ones below.</p>}
            </>
          )}
          {topic && (
            <form className="bag-topic-tools" onSubmit={addTyped}>
              <input
                className="bag-typed"
                value={typed}
                placeholder="Or a field: twist.twist.linear.x"
                aria-label={`A field of ${topic}`}
                spellCheck={false}
                autoComplete="off"
                onChange={(e) => setTyped(e.target.value)}
              />
              <button type="submit" className="button" disabled={!typed.trim() || full}>
                Add
              </button>
            </form>
          )}
          {full && <p className="field-help">{MAX_SERIES} series at most: remove one to add another.</p>}
        </section>

        <section className="field">
          <span className="field-label">
            Plotted <span className="plot-count">{series.length} of {MAX_SERIES}</span>
          </span>
          {series.length === 0 ? (
            <p className="field-help">None yet: choose fields above.</p>
          ) : (
            <ul className="plot-series-list">
              {series.map((s, index) => (
                <li key={s.path}>
                  <span className="plot-key" style={{ background: `var(--plot-${index + 1})` }} aria-hidden="true" />
                  <input
                    key={s.label}
                    defaultValue={s.label}
                    placeholder={s.path}
                    aria-label={`Label of ${s.path}`}
                    title={`Its label, else ${s.path}`}
                    onBlur={(e) => relabel(s.path, e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
                  />
                  {s.label && <code title={s.path}>{s.path}</code>}
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={`Remove ${seriesName(s)}`}
                    title="Remove"
                    onClick={() => onChange(series.filter((other) => other.path !== s.path))}
                  >
                    <CloseIcon width={15} height={15} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <div className="modal-actions">
          <button type="button" className="button primary" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </Modal>
  );
}
