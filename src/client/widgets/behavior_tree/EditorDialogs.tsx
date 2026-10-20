// The behavior tree editor's file dialog (Save as, New file) and its XML
// view, where the file is edited as text.

import { useEffect, useId, useRef, useState } from 'react';

import { connection } from '../../connection.ts';
import { Modal } from '../../dialogs.tsx';
import { FileBrowser } from '../../editor/FileInput.tsx';
import { baseName } from './RecordPlayback.tsx';
import { parseDocument, type XmlDocument } from './xml_document.ts';

// A new file's, of BT.CPP's format
export function newTreeText(format: 3 | 4): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<root ${format === 4 ? 'BTCPP_format="4" ' : ''}main_tree_to_execute="MainTree">
  <BehaviorTree ID="MainTree">
    <Sequence/>
  </BehaviorTree>
</root>
`;
}

// The folder of a path: /a/b/c.xml -> /a/b
function folderOf(path: string): string {
  return path.replace(/\/[^/]*$/, '') || '~';
}

// Where to save a file, new (its text then given by its format) or a copy:
// resolves with the path and the text saved, once saved
export function FileDialog({
  mode,
  initial,
  text,
  onSaved,
  onClose,
}: {
  mode: 'save-as' | 'new';
  // A path to start from
  initial: string;
  // Of a copy
  text: string;
  onSaved: (path: string, text: string, version: string) => void;
  onClose: () => void;
}) {
  const id = useId();
  const [path, setPath] = useState(initial);
  const [format, setFormat] = useState<3 | 4>(4);
  const [browsing, setBrowsing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<{ message: string; exists: boolean } | null>(null);
  const valid = /^(\/|~\/).+\.xml$/i.test(path.trim());

  const save = async (replace: boolean) => {
    const target = path.trim();
    const content = mode === 'new' ? newTreeText(format) : text;
    setSaving(true);
    setError(null);
    try {
      const result = await connection.saveBehaviorTreeFile(target, content, null, !replace);
      onSaved(target, content, result.version);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setError({ message, exists: /exists already/.test(message) });
      setSaving(false);
    }
  };

  return (
    <>
      <Modal title={mode === 'new' ? 'New behavior tree' : 'Save the tree as'} onClose={onClose} wide>
        <form
          className="modal-body"
          onSubmit={(e) => {
            e.preventDefault();
            void save(false);
          }}
        >
          <div className="field">
            <label className="field-label" htmlFor={id}>
              File on the robot
            </label>
            <div className="bt-record-path">
              <input
                id={id}
                value={path}
                spellCheck={false}
                autoFocus
                onChange={(e) => {
                  setPath(e.target.value);
                  setError(null);
                }}
              />
              <button type="button" className="button" onClick={() => setBrowsing(true)}>
                Browse…
              </button>
            </div>
            <p className="field-help">An XML file: /…, ~/…</p>
            {error && <p className="field-help error">{error.message}</p>}
          </div>
          {mode === 'new' && (
            <div className="field">
              <label className="field-label" htmlFor={`${id}-format`}>
                Format
              </label>
              <select id={`${id}-format`} value={format} onChange={(e) => setFormat(Number(e.target.value) as 3 | 4)}>
                <option value={4}>BT.CPP 4: ROS 2 Jazzy and later</option>
                <option value={3}>BT.CPP 3: ROS 2 Humble</option>
              </select>
            </div>
          )}
          <div className="modal-actions">
            <button type="button" className="button" onClick={onClose}>
              Cancel
            </button>
            {error?.exists && (
              <button type="button" className="button danger" disabled={saving} onClick={() => void save(true)}>
                Replace it
              </button>
            )}
            <button type="submit" className="button primary" disabled={saving || !valid}>
              {saving ? 'Saving…' : mode === 'new' ? 'Create' : 'Save'}
            </button>
          </div>
        </form>
      </Modal>
      {browsing && (
        <FileBrowser
          kind="folder"
          start={folderOf(path.trim())}
          onChoose={(folder) => {
            setBrowsing(false);
            setPath(`${folder.replace(/\/+$/, '')}/${baseName(path.trim()) || 'tree.xml'}`);
          }}
          onClose={() => setBrowsing(false)}
        />
      )}
    </>
  );
}

// The file as text: what is typed becomes the document once it is XML again
export function XmlView({
  text,
  readOnly,
  onDocument,
  onDone,
}: {
  text: string;
  readOnly: boolean;
  onDocument: (document: XmlDocument) => void;
  // Done typing: the next change is another undo step
  onDone: () => void;
}) {
  const [draft, setDraft] = useState(text);
  const [error, setError] = useState<string | null>(null);
  // Typed, not yet the document's: kept over the document's text
  const typing = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!typing.current) {
      setDraft(text);
      setError(null);
    }
  }, [text]);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);

  const apply = (value: string) => {
    timer.current = null;
    try {
      onDocument(parseDocument(value));
      setError(null);
      typing.current = false;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="bte-xml">
      <textarea
        value={draft}
        spellCheck={false}
        readOnly={readOnly}
        aria-label="The file’s XML"
        onChange={(e) => {
          const value = e.target.value;
          typing.current = true;
          setDraft(value);
          if (timer.current) {
            clearTimeout(timer.current);
          }
          timer.current = setTimeout(() => apply(value), 400);
        }}
        onBlur={() => {
          if (timer.current) {
            clearTimeout(timer.current);
            apply(draft);
          }
          onDone();
        }}
      />
      {error && <p className="bte-xml-error">{error}</p>}
    </div>
  );
}
