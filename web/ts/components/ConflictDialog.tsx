import { useEffect } from 'preact/hooks';

interface Props {
  // Discard the local edits and reload the note from the backend.
  onReload: () => void;
  // Overwrite the backend with the local edits regardless of the conflict.
  onForceSave: () => void;
  // Dismiss the dialog without resolving the conflict (keeps editing).
  onClose: () => void;
  // Disables the action buttons while a reload or force-save is in flight.
  busy: boolean;
}

// Shown when a save fails with 412 Precondition Failed because the note was
// modified elsewhere since it was loaded. Offers an explicit choice instead of
// a dead-end "please reload" toast.
export function ConflictDialog({ onReload, onForceSave, onClose, busy }: Props) {
  // Close on Escape from anywhere in the document.
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [onClose]);

  return (
    <div class="conflict-overlay" onClick={busy ? undefined : onClose}>
      <div class="conflict-dialog" role="alertdialog" aria-modal="true" aria-labelledby="conflict-title" onClick={(e) => e.stopPropagation()}>
        <h2 id="conflict-title" class="conflict-title">Note modified elsewhere</h2>
        <p class="conflict-body">
          This note has changed on the server since you started editing.
          Choose how to resolve the conflict.
        </p>
        <div class="conflict-actions">
          <button type="button" class="danger" disabled={busy} onClick={onForceSave}>
            Save my changes anyway
          </button>
          <button type="button" disabled={busy} onClick={onReload}>
            Discard my edits &amp; reload
          </button>
          <button type="button" class="link" disabled={busy} onClick={onClose}>
            Keep editing
          </button>
        </div>
      </div>
    </div>
  );
}
