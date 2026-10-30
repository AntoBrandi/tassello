import type { ComponentType, SVGProps } from 'react';

import { Modal } from '../dialogs.tsx';

interface Definition {
  type: string;
  name: string;
  description: string;
  icon: ComponentType<SVGProps<SVGSVGElement>>;
}

interface Entry<D> {
  definition: D;
  plugin: string | null;
}

// Tassello's widgets, then each plugin's
function groups<D>(all: Entry<D>[]): { plugin: string | null; entries: Entry<D>[] }[] {
  const byPlugin = new Map<string | null, Entry<D>[]>();
  for (const entry of all) {
    byPlugin.set(entry.plugin, [...(byPlugin.get(entry.plugin) ?? []), entry]);
  }
  return [...byPlugin].map(([plugin, entries]) => ({ plugin, entries }));
}

// The widgets of the board, or the status bar's
export function WidgetPalette<D extends Definition>({
  title,
  entries: all,
  onAdd,
  onClose,
}: {
  title: string;
  entries: Entry<D>[];
  onAdd: (definition: D) => void;
  onClose: () => void;
}) {
  const sections = groups(all);
  return (
    <Modal title={title} onClose={onClose} wide>
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
