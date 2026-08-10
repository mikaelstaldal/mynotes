import type { ComponentChildren } from 'preact';
import { useState, useEffect, useRef } from 'preact/hooks';
import {
  mymailOverride,
  serverMymailUrl,
  setMymailUrl,
  validateMymailUrl,
} from '../util/mymail.js';
import { isDemo } from '../util/serverconfig.js';

interface Props {
  // Dismiss the dialog. Also called after a successful save.
  onClose: () => void;
}

// Modal for the browser-local settings, opened from the sidebar footer. Only
// the MyMail integration is configured here; the theme and the browse order
// have their own controls where they apply. A demo build opens the same dialog
// — the footer offers the same pair of controls everywhere — but has no server
// to relay a message, so it explains that instead of showing the field.
//
// Two components rather than a branch inside one, so neither variant carries
// the other's hooks: the demo body would otherwise read localStorage for a
// field it never renders. This dispatcher deliberately holds no state of its
// own.
export function SettingsDialog({ onClose }: Props) {
  return isDemo() ? <DemoSettings onClose={onClose} /> : <MymailSettings onClose={onClose} />;
}

interface ShellProps extends Props {
  // Id of the element describing the dialog, for variants whose body is prose
  // rather than a form. Omitted leaves the attribute off entirely.
  describedBy?: string;
  children: ComponentChildren;
}

// The chrome both variants share: the overlay that dismisses on an outside
// click, the dialog box, the title, and Escape.
function SettingsShell({ onClose, describedBy, children }: ShellProps) {
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [onClose]);

  return (
    <div class="settings-overlay" onClick={onClose}>
      <div class="settings-dialog" role="dialog" aria-modal="true" aria-labelledby="settings-title"
        aria-describedby={describedBy}
        onClick={(e) => e.stopPropagation()}>
        <h2 id="settings-title" class="settings-title">Settings</h2>
        {children}
      </div>
    </div>
  );
}

// The demo variant: nothing to configure, and why. Described by its body the
// way DemoDialog is, since a screen reader reaching only the title and a Close
// button would be told nothing at all.
function DemoSettings({ onClose }: Props) {
  const closeRef = useRef<HTMLButtonElement>(null);

  // Mount only. The other variant's `autofocus` puts the caret in the field;
  // with no form to take it, focus goes to the one button, so Escape and Enter
  // both land here rather than on whatever was focused behind the overlay.
  // Depending on `onClose` would re-run this — the caller passes a fresh
  // closure on every render — and yank focus back while the dialog is open.
  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  return (
    <SettingsShell onClose={onClose} describedBy="settings-demo-body">
      <p id="settings-demo-body" class="settings-body">
        There is nothing to configure in the demo. The MyMail URL is the only setting
        MyNotes holds, and “Send as email” needs a server to relay the message — this
        demo has none. The theme is on the button beside Settings in the sidebar footer.
      </p>
      <div class="settings-actions">
        <button ref={closeRef} type="button" class="primary" onClick={onClose}>Close</button>
      </div>
    </SettingsShell>
  );
}

// The real variant: the MyMail override, and nothing else.
function MymailSettings({ onClose }: Props) {
  // The override alone, not the effective URL: an empty field means "follow the
  // server", which the placeholder and the hint below spell out.
  const [url, setUrl] = useState(() => mymailOverride());
  const [error, setError] = useState('');
  const derived = serverMymailUrl();

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
    <SettingsShell onClose={onClose}>
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
    </SettingsShell>
  );
}
