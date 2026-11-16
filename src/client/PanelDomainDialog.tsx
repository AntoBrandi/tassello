// The ROS domain (ROS_DOMAIN_ID) of a panel's widgets, for administrators to
// choose: the server's own, or another, on which the server then keeps a node
// of its own for the panel's pages (src/server/domains.ts).

import { useState, type FormEvent } from 'react';

import { isDomainId, MAX_DOMAIN_ID } from '../shared/panel.ts';
import { Modal } from './dialogs.tsx';

// Its domain in words, for the panel's menu
export function domainLabel(domainId: number | undefined, serverDomainId: number | null): string {
  if (domainId === undefined) {
    return serverDomainId === null ? 'the server’s' : `the server’s (${serverDomainId})`;
  }
  return String(domainId);
}

export function PanelDomainDialog({
  name,
  domainId,
  serverDomainId,
  onChange,
  onClose,
}: {
  name: string;
  // undefined: the server's own
  domainId: number | undefined;
  serverDomainId: number | null;
  onChange: (domainId: number | undefined) => void;
  onClose: () => void;
}) {
  const [own, setOwn] = useState(domainId !== undefined);
  const [text, setText] = useState(String(domainId ?? serverDomainId ?? 0));
  const value = Number(text);
  const valid = !own || (text.trim() !== '' && isDomainId(value));

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!valid) {
      return;
    }
    const chosen = own ? value : undefined;
    if (chosen !== domainId) {
      onChange(chosen);
    }
    onClose();
  };

  return (
    <Modal title={`ROS domain of “${name}”`} onClose={onClose}>
      <form className="modal-body" onSubmit={submit}>
        <fieldset className="visibility-choices">
          <legend className="field-label">Its widgets reach the ROS nodes of</legend>
          <label className="visibility-choice">
            <input type="radio" name="domain" checked={!own} onChange={() => setOwn(false)} />
            <span>
              <strong>The server’s domain{serverDomainId === null ? '' : `: ${serverDomainId}`}</strong>
              <span className="field-help">The ROS_DOMAIN_ID Tassello was started with</span>
            </span>
          </label>
          <label className="visibility-choice">
            <input type="radio" name="domain" checked={own} onChange={() => setOwn(true)} />
            <span>
              <strong>Another domain</strong>
              <span className="field-help">
                The server joins it with a node of its own. The panel’s terminals, button commands and
                bags run on it too.
              </span>
            </span>
          </label>
        </fieldset>
        {own && (
          <label className="field">
            <span className="field-label">ROS_DOMAIN_ID</span>
            <input
              type="number"
              min={0}
              max={MAX_DOMAIN_ID}
              step={1}
              value={text}
              autoFocus
              aria-invalid={!valid}
              onChange={(e) => setText(e.target.value)}
            />
            <span className="field-help">
              {valid ? `0 to ${MAX_DOMAIN_ID}; on Linux, 0 to 101 or 215 to ${MAX_DOMAIN_ID} are safest` : `An integer from 0 to ${MAX_DOMAIN_ID}`}
            </span>
          </label>
        )}
        <div className="modal-actions">
          <button type="button" className="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="button primary" disabled={!valid}>
            Save
          </button>
        </div>
      </form>
    </Modal>
  );
}
