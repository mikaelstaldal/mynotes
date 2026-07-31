import { useState, useEffect } from 'preact/hooks';
import {
  mymailOverride,
  serverMymailUrl,
  setMymailUrl,
  validateMymailUrl,
} from '../util/mymail.js';

interface Props {
  // Dismiss the dialog. Also called after a successful save.
  onClose: () => void;
}

// Modal for the browser-local settings, opened from the sidebar footer. Only
// the MyMail integration is configured here; the theme and the browse order
// have their own controls where they apply. Never rendered in demo mode, which
// has no server to relay a message and so nothing to configure.
export function SettingsDialog({ onClose }: Props) {
  // The override alone, not the effective URL: an empty field means "follow the
  // server", which the placeholder and the hint below spell out.
  const [url, setUrl] = useState(() => mymailOverride());
  const [error, setError] = useState('');
  const derived = serverMymailUrl();

  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [onClose]);

  function handleSubmit(e: Event) {
    e.preventDefault();
    const trimmed = url.trim().replace(/\/+$/, '');
    const message = validateMymailUrl(trimmed);
    if (message) {
      setError(message);
      return;
    }
    setMymailUrl(trimmed);
    onClose();
  }

  return (
    <div class="settings-overlay" onClick={onClose}>
      <div class="settings-dialog" role="dialog" aria-modal="true" aria-labelledby="settings-title"
        onClick={(e) => e.stopPropagation()}>
        <h2 id="settings-title" class="settings-title">Settings</h2>
        <form onSubmit={handleSubmit}>
          <label class="settings-field">
            <span>MyMail URL</span>
            <input type="url" autofocus value={url}
              placeholder={derived || `${window.location.origin}/mymail`}
              onInput={(e) => { setUrl((e.target as HTMLInputElement).value); setError(''); }} />
          </label>
          <p class="settings-hint">
            {derived
              ? `Leave empty to use the URL this server derived: ${derived}`
              : 'This server derived no MyMail URL; set one here to enable “Send as email”.'}
            {' '}MyMail must be on the same origin as MyNotes.
          </p>
          {error && <p class="settings-error" role="alert">{error}</p>}
          <div class="settings-actions">
            <button type="button" class="link" onClick={onClose}>Cancel</button>
            <button type="submit" class="primary">Save</button>
          </div>
        </form>
      </div>
    </div>
  );
}
