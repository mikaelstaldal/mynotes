import { getThemePreference, setTheme, type ThemePreference } from '../util/theme.js';
import type { ComponentChildren } from 'preact';
import { useState, useEffect, useRef } from 'preact/hooks';
import {
  mymailOverride,
  serverMymailUrl,
  setMymailUrl,
  validateMymailUrl,
} from '../util/mymail.js';
import { ApiTokens } from './ApiTokens.js';
import { isDemo } from '../util/serverconfig.js';

interface Props {
  // Dismiss the dialog. Also called after a successful save.
  onClose: () => void;
}

// Theme preferences are available in both server and demo builds.
export function SettingsDialog({ onClose }: Props) {
  return isDemo() ? <DemoSettings onClose={onClose} /> : <MymailSettings onClose={onClose} />;
}

function ThemeSetting() {
  const [preference, setPreference] = useState(getThemePreference);
  return <label class="settings-field">
    <span>Theme</span>
    <select aria-label="Theme" value={preference} onChange={e => {
      const value = (e.target as HTMLSelectElement).value as ThemePreference;
      setTheme(value);
      setPreference(value);
    }}>
      <option value="auto">Auto</option>
      <option value="light">Light</option>
      <option value="dark">Dark</option>
    </select>
  </label>;
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
        <ThemeSetting />
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
        Theme changes are saved in this browser. API tokens and device login need a server. The MyMail URL and “Send as email” needs a server to relay the message — this
        demo has none. Choose Auto to follow your browser’s color scheme.
      </p>
      <div class="settings-actions">
        <button ref={closeRef} type="button" class="primary" onClick={onClose}>Close</button>
      </div>
    </SettingsShell>
  );
}

// Both panels remain mounted to retain in-progress device approval across tabs.
function MymailSettings({ onClose }: Props) {
  const [tab, setTab] = useState<'integration' | 'tokens'>('integration');
  const integrationRef = useRef<HTMLButtonElement>(null);
  const tokensRef = useRef<HTMLButtonElement>(null);
  function tabKey(e: KeyboardEvent) {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
    e.preventDefault();
    const next = e.key === 'Home' ? 'integration' : e.key === 'End' ? 'tokens' : tab === 'integration' ? 'tokens' : 'integration';
    setTab(next);
    (next === 'integration' ? integrationRef : tokensRef).current?.focus();
  }
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
      <div class="settings-tabs" role="tablist" aria-label="Settings tabs">
        <button type="button" role="tab" ref={integrationRef} tabIndex={tab === 'integration' ? 0 : -1} onKeyDown={tabKey} aria-selected={tab === 'integration'} aria-controls="settings-integration" id="tab-integration" onClick={() => setTab('integration')}>Integration</button>
        <button type="button" role="tab" ref={tokensRef} tabIndex={tab === 'tokens' ? 0 : -1} onKeyDown={tabKey} aria-selected={tab === 'tokens'} aria-controls="settings-tokens" id="tab-tokens" onClick={() => setTab('tokens')}>API Tokens</button>
      </div>
      <div id="settings-integration" role="tabpanel" aria-labelledby="tab-integration" hidden={tab !== 'integration'}>
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
      <div id="settings-tokens" role="tabpanel" aria-labelledby="tab-tokens" hidden={tab !== 'tokens'}>
        <ApiTokens />
        <div class="settings-actions"><button type="button" onClick={onClose}>Close</button></div>
      </div>
    </SettingsShell>
  );
}
