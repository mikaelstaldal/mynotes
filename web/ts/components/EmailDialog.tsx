import { useState, useEffect } from 'preact/hooks';
import { NotFoundError } from '../api/client.js';
import { buildNoteEmail, sendNoteEmail } from '../util/email.js';
import { showToast } from '../util/toast.js';

interface Props {
  slug: string;
  // The note's title, used as the initial subject.
  title: string;
  // Base URL of the sibling MyMail instance (never empty — the caller only
  // renders this dialog when MyMail is configured).
  mymailUrl: string;
  // Dismiss the dialog. Also called after a successful send.
  onClose: () => void;
}

// Modal shown by the note toolbar's "Send as email" action. Composes the note
// into an HTML email and hands it to MyMail; the note is rendered only on
// submit, since rendering it (Mermaid diagrams, image inlining) is the
// expensive part and the dialog may well be dismissed.
export function EmailDialog({ slug, title, mymailUrl, onClose }: Props) {
  const [recipient, setRecipient] = useState('');
  const [subject, setSubject] = useState(title);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape' && !sending) onClose();
    }
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [onClose, sending]);

  async function handleSubmit(e: Event) {
    e.preventDefault();
    if (sending) return;
    setSending(true);
    setError('');
    try {
      const email = await buildNoteEmail(slug);
      await sendNoteEmail(mymailUrl, email, recipient.trim(), subject.trim() || email.subject);
      // Name what the body could not carry, so it is clear why the message did
      // (or did not) come with the standalone export attached.
      showToast(
        email.degraded.length > 0
          ? `Email sent, with the note attached (${email.degraded.join(', ')} cannot be shown in an email)`
          : 'Email sent',
      );
      onClose();
    } catch (err) {
      setError(err instanceof NotFoundError ? 'Note not found' : (err as Error).message);
      setSending(false);
    }
  }

  return (
    <div class="email-overlay" onClick={sending ? undefined : onClose}>
      <div class="email-dialog" role="dialog" aria-modal="true" aria-labelledby="email-title"
        onClick={(e) => e.stopPropagation()}>
        <h2 id="email-title" class="email-title">Send as email</h2>
        <p class="email-body">
          Sends the note as an HTML formatted email. If anything in it cannot be
          shown in an email — a diagram, a formula, an image — the standalone
          HTML file is attached as well.
        </p>
        <form onSubmit={handleSubmit}>
          <label class="email-field">
            <span>To</span>
            <input type="email" required autofocus value={recipient} disabled={sending}
              placeholder="recipient@example.com"
              onInput={(e) => { setRecipient((e.target as HTMLInputElement).value); setError(''); }} />
          </label>
          <label class="email-field">
            <span>Subject</span>
            <input type="text" required value={subject} disabled={sending}
              onInput={(e) => setSubject((e.target as HTMLInputElement).value)} />
          </label>
          {error && <p class="email-error" role="alert">{error}</p>}
          <div class="email-actions">
            <button type="button" class="link" disabled={sending} onClick={onClose}>Cancel</button>
            <button type="submit" disabled={sending || !recipient.trim()}>
              {sending ? 'Sending…' : 'Send'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
