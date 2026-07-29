import { useState, useEffect, useRef } from 'preact/hooks';
import { subscribe, resolveDialog, type DialogRequest } from '../util/dialog.js';

// Renders the dialog store. Mount once near the app root, like <Toast>. Only the
// head of the queue is rendered; answering it reveals the next one.
export function Dialogs() {
  const [requests, setRequests] = useState<DialogRequest[]>([]);

  useEffect(() => subscribe(setRequests), []);

  const current = requests[0];
  if (!current) return null;

  // Keyed by id so the prompt's field state belongs to one request only and is
  // never carried over to the next one.
  return <Dialog key={current.id} request={current} />;
}

function Dialog({ request }: { request: DialogRequest }) {
  const { id, options } = request;
  const prompt = request.kind === 'prompt' ? request.options : null;
  const [value, setValue] = useState(prompt?.initialValue ?? '');
  const inputRef = useRef<HTMLInputElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);

  // Cancelling answers false / null — what window.confirm / window.prompt
  // returned when cancelled, so existing call-site logic still holds.
  function cancel() {
    resolveDialog(id, prompt ? null : false);
  }

  function accept() {
    resolveDialog(id, prompt ? value : true);
  }

  // Escape and a click outside the box are shorthand for cancelling — unless the
  // request asked for a deliberate answer, in which case they do nothing and the
  // dialog stays put.
  function dismiss() {
    if (!options.requireAnswer) cancel();
  }

  // Focus the field (a prompt) or the accepting button (a confirmation) so the
  // dialog is operable from the keyboard alone, and close it on Escape from
  // anywhere in the document. dismiss() only closes over the id, so registering
  // once per request is enough.
  useEffect(() => {
    if (inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    } else {
      confirmRef.current?.focus();
    }
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') dismiss();
    }
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [id]);

  return (
    <div class="dialog-overlay" onClick={dismiss}>
      {/* A form so Enter in the prompt's field accepts. <Dialogs> is mounted at
          the app root, never inside another form, so this cannot nest. */}
      <form
        class="dialog-box"
        role={prompt ? 'dialog' : 'alertdialog'}
        aria-modal="true"
        aria-labelledby={`dialog-title-${id}`}
        aria-describedby={options.body ? `dialog-body-${id}` : undefined}
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => { e.preventDefault(); accept(); }}
      >
        <h2 id={`dialog-title-${id}`} class="dialog-title">{options.title}</h2>
        {options.body && (
          <p id={`dialog-body-${id}`} class="dialog-body">{options.body}</p>
        )}
        {prompt && (
          <label class="dialog-field">
            <span>{prompt.label}</span>
            <input
              ref={inputRef}
              type="text"
              value={value}
              maxLength={prompt.maxLength}
              placeholder={prompt.placeholder}
              onInput={(e) => setValue((e.target as HTMLInputElement).value)}
            />
          </label>
        )}
        <div class="dialog-actions">
          <button type="button" class="link" onClick={cancel}>
            {options.cancelLabel ?? 'Cancel'}
          </button>
          <button
            ref={confirmRef}
            type="submit"
            class={request.kind === 'confirm' && request.options.danger ? 'danger' : 'primary'}
          >
            {options.confirmLabel ?? 'OK'}
          </button>
        </div>
      </form>
    </div>
  );
}
