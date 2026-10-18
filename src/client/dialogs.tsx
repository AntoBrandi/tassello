// Modal dialogs: <Modal> for custom content, and useDialogs().confirm/prompt,
// which return a promise of the answer.

import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { CloseIcon } from './icons.tsx';

export function Modal({
  title,
  onClose,
  children,
  wide = false,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal${wide ? ' wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <header className="modal-header">
          <h2>{title}</h2>
          <button type="button" className="icon-button" aria-label="Close" onClick={onClose}>
            <CloseIcon />
          </button>
        </header>
        {children}
      </div>
    </div>
  );
}

export interface ConfirmOptions {
  title: string;
  message?: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
}

export interface PromptOptions {
  title: string;
  label: string;
  initial?: string;
  confirmLabel?: string;
}

export interface Dialogs {
  confirm: (options: ConfirmOptions) => Promise<boolean>;
  // null if cancelled
  prompt: (options: PromptOptions) => Promise<string | null>;
}

type Request = { id: number } & (
  | ({ kind: 'confirm'; resolve: (answer: boolean) => void } & ConfirmOptions)
  | ({ kind: 'prompt'; resolve: (answer: string | null) => void } & PromptOptions)
);

let nextRequestId = 1;

const DialogContext = createContext<Dialogs | null>(null);

export function useDialogs(): Dialogs {
  const dialogs = useContext(DialogContext);
  if (!dialogs) {
    throw new Error('useDialogs() outside of <DialogProvider>');
  }
  return dialogs;
}

export function DialogProvider({ children }: { children: ReactNode }) {
  const [request, setRequest] = useState<Request | null>(null);
  const dialogs = useMemo<Dialogs>(
    () => ({
      confirm: (options) =>
        new Promise((resolve) => setRequest({ id: nextRequestId++, kind: 'confirm', resolve, ...options })),
      prompt: (options) =>
        new Promise((resolve) => setRequest({ id: nextRequestId++, kind: 'prompt', resolve, ...options })),
    }),
    [],
  );
  return (
    <DialogContext.Provider value={dialogs}>
      {children}
      {request && <DialogView key={request.id} request={request} onDone={() => setRequest(null)} />}
    </DialogContext.Provider>
  );
}

function DialogView({ request, onDone }: { request: Request; onDone: () => void }) {
  const [value, setValue] = useState(request.kind === 'prompt' ? (request.initial ?? '') : '');
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => inputRef.current?.select(), []);

  const answer = (confirmed: boolean) => {
    if (request.kind === 'confirm') {
      request.resolve(confirmed);
    } else {
      request.resolve(confirmed && value.trim() ? value.trim() : null);
    }
    onDone();
  };

  return (
    <Modal title={request.title} onClose={() => answer(false)}>
      <form
        className="modal-body"
        onSubmit={(e) => {
          e.preventDefault();
          answer(true);
        }}
      >
        {request.kind === 'confirm' ? (
          request.message && <div className="dialog-message">{request.message}</div>
        ) : (
          <label className="field">
            <span className="field-label">{request.label}</span>
            <input ref={inputRef} value={value} onChange={(e) => setValue(e.target.value)} autoFocus />
          </label>
        )}
        <div className="modal-actions">
          <button type="button" className="button" onClick={() => answer(false)}>
            Cancel
          </button>
          <button
            type="submit"
            className={`button ${request.kind === 'confirm' && request.danger ? 'danger' : 'primary'}`}
            disabled={request.kind === 'prompt' && !value.trim()}
            autoFocus={request.kind === 'confirm'}
          >
            {request.confirmLabel ?? 'OK'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
