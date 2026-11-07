// Who sees a panel: its minRole, for administrators to choose. The server
// lists, sends and runs the panel's commands for those roles only.

import { useState, type FormEvent } from 'react';

import type { Role } from '../shared/auth.ts';
import { Modal } from './dialogs.tsx';

export const VISIBILITY_LABELS: Record<Role, string> = {
  viewer: 'Viewers and up',
  operator: 'Operators and up',
  admin: 'Administrators only',
};

const VISIBILITY_HELP: Record<Role, string> = {
  viewer: 'Everyone who signs in',
  operator: 'Operators and administrators: e.g. a panel that drives the robot',
  admin: 'A panel being made, or of the robot’s system',
};

export function PanelVisibilityDialog({
  name,
  minRole,
  onChange,
  onClose,
}: {
  name: string;
  minRole: Role;
  onChange: (minRole: Role) => void;
  onClose: () => void;
}) {
  const [choice, setChoice] = useState<Role>(minRole);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (choice !== minRole) {
      onChange(choice);
    }
    onClose();
  };

  return (
    <Modal title={`Who sees “${name}”`} onClose={onClose}>
      <form className="modal-body" onSubmit={submit}>
        <fieldset className="visibility-choices">
          <legend className="field-label">Visible to</legend>
          {(['viewer', 'operator', 'admin'] as const).map((role) => (
            <label key={role} className="visibility-choice">
              <input
                type="radio"
                name="minRole"
                value={role}
                checked={choice === role}
                onChange={() => setChoice(role)}
              />
              <span>
                <strong>{VISIBILITY_LABELS[role]}</strong>
                <span className="field-help">{VISIBILITY_HELP[role]}</span>
              </span>
            </label>
          ))}
        </fieldset>
        <div className="modal-actions">
          <button type="button" className="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="button primary">
            Save
          </button>
        </div>
      </form>
    </Modal>
  );
}
