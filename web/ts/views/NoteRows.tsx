import { type NoteSummary } from '../api/client.js';
import { base } from '../basepath.js';
import { NoteActions } from '../components/NoteActions.js';

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Safety: escapeHtml runs first, so every character from the server-supplied
// excerpt is neutralized before any HTML is introduced. The only < > that
// survive are the two hardcoded literal strings below — never user content.
export function renderExcerpt(excerpt: string): string {
  return escapeHtml(excerpt)
    .replace(/\x02/g, '<mark>')
    .replace(/\x03/g, '</mark>');
}

export function formatDate(iso: string): string {
  const d = new Date(iso);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd} ${hh}:${min}`;
}

interface Props {
  rows: NoteSummary[];
  activeSlug?: string;
  // When true, render the per-note action toolbar (download, print, split,
  // edit, delete) on each row — used by the main-panel overview, not the
  // sidebar list. onMutate is invoked after an action changes the note set so
  // the lists can refresh.
  showActions?: boolean;
  onMutate?: () => void;
}

// Presentational list of note rows shared by the sidebar list and the
// main-panel overview. Must be rendered inside an `.item-list` container so the
// per-row border styling applies.
export function NoteRows({ rows, activeSlug, showActions, onMutate }: Props) {
  return (
    <ul>
      {rows.map(n => (
        <li key={n.slug}>
          <div class={`note-row${n.slug === activeSlug ? ' note-row--active' : ''}${showActions ? ' note-row--actions' : ''}`}>
            <a class="link" href={`${base}/notes/${n.slug}`}>{n.title}</a>
            <span class="muted note-date" title={`Version ${n.version}`}>
              <time dateTime={n.created_at}>created {formatDate(n.created_at)}</time>
              {' · '}
              <time dateTime={n.updated_at}>updated {formatDate(n.updated_at)}</time>
            </span>
            {n.excerpt && (
              <p class="note-excerpt muted"
                dangerouslySetInnerHTML={{ __html: renderExcerpt(n.excerpt) }}
              />
            )}
            {n.tags.length > 0 && (
              <div class="tag-chips">
                {n.tags.map(t => (
                  <a key={t.slug} class="tag-chip" href={`${base}/tags/${t.slug}`}
                    onClick={(e) => e.stopPropagation()}>{t.slug}</a>
                ))}
              </div>
            )}
            {showActions && (
              <NoteActions
                slug={n.slug}
                title={n.title}
                toolbarClass="note-row-actions"
                showView
                onDeleted={onMutate}
                onSplit={onMutate}
              />
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}
