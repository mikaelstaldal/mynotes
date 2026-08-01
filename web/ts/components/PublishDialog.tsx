import { useState, useEffect } from 'preact/hooks';
import { NotFoundError, api } from '../api/client.js';
import { publishNote, publicNoteUrl } from '../util/publish.js';
import { showToast } from '../util/toast.js';

interface Props {
  slug: string;
  // ISO timestamp of the note's current publication, or undefined when it is
  // not published. Decides which actions the dialog offers.
  publishedAt?: string;
  // Reports the new publication state to the caller, which holds the note.
  onChange: (publishedAt: string | undefined) => void;
  // Dismiss the dialog.
  onClose: () => void;
}

// Modal shown by the note toolbar's "Publish" action: renders the note and
// hands the HTML to the server, which serves it at a public URL without
// authentication.
//
// Like the email dialog, the note is rendered only on submit — rendering it
// (Mermaid diagrams especially) is the expensive part and the dialog may well
// be dismissed. Unlike it, the dialog stays open after publishing, so the link
// it just created can be copied.
export function PublishDialog({ slug, publishedAt, onChange, onClose }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [published, setPublished] = useState(publishedAt);

  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape' && !busy) onClose();
    }
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [onClose, busy]);

  const url = published === undefined ? '' : publicNoteUrl(`/public/notes/${slug}`);

  async function handlePublish() {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await publishNote(slug);
      // The response carries the server's own timestamp, but the note is not
      // re-fetched here; the caller refreshes it. Any non-empty value is enough
      // to switch this dialog into its published state.
      const now = new Date().toISOString();
      setPublished(now);
      onChange(now);
      showToast('Note published');
    } catch (err) {
      setError(err instanceof NotFoundError ? 'Note not found' : (err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function handleUnpublish() {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await api.notes.unpublish(slug);
    } catch (err) {
      // Already gone is the outcome the user asked for, not a failure.
      if (!(err instanceof NotFoundError)) {
        setError((err as Error).message);
        setBusy(false);
        return;
      }
    }
    setPublished(undefined);
    onChange(undefined);
    setBusy(false);
    showToast('Note unpublished');
    onClose();
  }

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(url);
      showToast('Link copied');
    } catch {
      // Clipboard access can be denied or unavailable outside a secure context;
      // selecting the field lets the user copy it by hand instead.
      document.querySelector<HTMLInputElement>('.publish-link input')?.select();
      showToast('Could not copy — the link is selected, copy it manually');
    }
  }

  return (
    <div class="publish-overlay" onClick={busy ? undefined : onClose}>
      <div class="publish-dialog" role="dialog" aria-modal="true" aria-labelledby="publish-title"
        onClick={(e) => e.stopPropagation()}>
        <h2 id="publish-title" class="publish-title">
          {published === undefined ? 'Publish note' : 'Published note'}
        </h2>
        {published === undefined ? (
          <p class="publish-body">
            Publishes this note as a web page anyone with the link can read, with
            no password. The page is a snapshot: later edits do not change it
            until you publish again. Images used by the note become readable at
            their own public links too.
          </p>
        ) : (
          <>
            <p class="publish-body">
              This note is published. The page is a snapshot taken when you last
              published — publish again to update it, or unpublish to take it
              down.
            </p>
            <label class="publish-link">
              <span>Public link</span>
              <input type="text" readonly value={url} onClick={(e) => (e.target as HTMLInputElement).select()} />
            </label>
          </>
        )}
        {error && <p class="publish-error" role="alert">{error}</p>}
        <div class="publish-actions">
          <button type="button" class="link" disabled={busy} onClick={onClose}>Close</button>
          {published !== undefined && (
            <>
              <button type="button" disabled={busy} onClick={handleCopy}>Copy link</button>
              <button type="button" class="danger" disabled={busy} onClick={handleUnpublish}>
                Unpublish
              </button>
            </>
          )}
          <button type="button" disabled={busy} onClick={handlePublish}>
            {busy ? 'Working…' : published === undefined ? 'Publish' : 'Publish again'}
          </button>
        </div>
      </div>
    </div>
  );
}
