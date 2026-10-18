import { Modal } from '../dialogs.tsx';
import { widgetEntries, type WidgetEntry } from '../widgets/registry.ts';
import type { RegisteredWidget } from '../widgets/types.ts';

// Tassello's widgets, then each plugin's
function groups(): { plugin: string | null; entries: WidgetEntry[] }[] {
  const byPlugin = new Map<string | null, WidgetEntry[]>();
  for (const entry of widgetEntries()) {
    byPlugin.set(entry.plugin, [...(byPlugin.get(entry.plugin) ?? []), entry]);
  }
  return [...byPlugin].map(([plugin, entries]) => ({ plugin, entries }));
}

export function WidgetPalette({
  onAdd,
  onClose,
}: {
  onAdd: (definition: RegisteredWidget) => void;
  onClose: () => void;
}) {
  const sections = groups();
  return (
    <Modal title="Add a widget" onClose={onClose} wide>
      <div className="palette-scroll">
        {sections.map(({ plugin, entries }) => (
          <section key={plugin ?? ''}>
            {sections.length > 1 && <h3 className="palette-heading">{plugin ?? 'Tassello'}</h3>}
            <div className="palette">
              {entries.map(({ definition }) => (
                <button
                  key={definition.type}
                  type="button"
                  className="palette-item"
                  onClick={() => onAdd(definition)}
                >
                  <span className="palette-icon">
                    <definition.icon width={24} height={24} />
                  </span>
                  <span className="palette-text">
                    <strong>{definition.name}</strong>
                    <span>{definition.description}</span>
                  </span>
                </button>
              ))}
            </div>
          </section>
        ))}
      </div>
    </Modal>
  );
}
