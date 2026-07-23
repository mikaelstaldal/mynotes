import { useState } from 'preact/hooks';
import { api, NotFoundError } from '../api/client.js';
import { navigate, currentPath } from '../router.js';
import { base } from '../basepath.js';
import { showToast } from '../util/toast.js';
import { downloadNoteHtml, noteHtmlDocument } from '../util/export.js';
import { SplitDialog } from './SplitDialog.js';
import { Icon } from './Icon.js';

interface Props {
  slug: string;
  // Used in the delete confirmation prompt.
  title: string;
  // Extra class applied to the toolbar container (e.g. for list-row layout).
  toolbarClass?: string;
  // Show a "View" button that opens the note's read view. Omitted in the read
  // view itself, where it would be a no-op.
  showView?: boolean;
  // Invoked after a successful delete; the caller decides whether to refresh a
  // list or navigate away.
  onDeleted?: () => void;
  // Invoked after a successful split creates new notes, before navigation; the
  // caller uses it to refresh any affected lists.
  onSplit?: () => void;
}

// The per-note action toolbar (view, download, print, split, edit, delete)
// shared by the single-note read view and each row of the main-panel overview.
// The delete and split handlers defer navigation/refresh to the caller via
// onDeleted / onSplit so the same buttons behave correctly in both contexts.
export function NoteActions({ slug, title, toolbarClass, showView, onDeleted, onSplit }: Props) {
  const [deleting, setDeleting] = useState(false);
  const [splitting, setSplitting] = useState(false);
  const [showSplit, setShowSplit] = useState(false);

  // Print reuses the same standalone HTML document as Download HTML (built in
  // the browser, with Mermaid diagrams rendered and internal images inlined): it
  // is loaded into an off-screen iframe whose print dialog is then invoked, so
  // the printout matches the exported file rather than the surrounding app chrome.
  async function handlePrint() {
    try {
      const html = await noteHtmlDocument(slug);
      const iframe = document.createElement('iframe');
      iframe.setAttribute('aria-hidden', 'true');
      iframe.style.position = 'fixed';
      iframe.style.right = '0';
      iframe.style.bottom = '0';
      iframe.style.width = '0';
      iframe.style.height = '0';
      iframe.style.border = '0';
      iframe.onload = () => {
        const win = iframe.contentWindow;
        if (!win) { iframe.remove(); return; }
        const cleanup = () => iframe.remove();
        win.addEventListener('afterprint', cleanup);
        win.focus();
        win.print();
        // Fallback removal for browsers that never fire afterprint.
        setTimeout(cleanup, 60000);
      };
      iframe.srcdoc = html;
      document.body.appendChild(iframe);
    } catch (e) {
      if (e instanceof NotFoundError) {
        showToast('Note not found');
      } else {
        showToast(`Failed to print: ${(e as Error).message}`);
      }
    }
  }

  // Build the standalone HTML document in the browser and download it as a file.
  async function handleDownloadHtml() {
    try {
      await downloadNoteHtml(slug);
    } catch (e) {
      if (e instanceof NotFoundError) {
        showToast('Note not found');
      } else {
        showToast(`Failed to download HTML: ${(e as Error).message}`);
      }
    }
  }

  // Split the note into several notes at its top-level Markdown headings. The
  // optional tag (chosen in the SplitDialog, undefined = none) is attached to
  // every new note. On success we navigate to the tag page when a tag was given
  // (it lists all the new notes), otherwise to the first created note. The
  // source note is left unchanged.
  async function doSplit(tag: string | undefined) {
    setSplitting(true);
    try {
      const result = await api.notes.split(slug, tag);
      const count = result.notes.length;
      showToast(`Split into ${count} note${count === 1 ? '' : 's'}`);
      // Close the dialog explicitly: when no tag is chosen we navigate to
      // another /notes/{slug} route, which may reuse the same view instance
      // (only the slug prop changes), so the dialog would otherwise stay open.
      setShowSplit(false);
      onSplit?.();
      if (tag) {
        navigate(`/tags/${tag}`);
      } else if (result.notes[0]) {
        navigate(`/notes/${result.notes[0].slug}`);
      } else {
        navigate('/');
      }
    } catch (e) {
      if (e instanceof NotFoundError) {
        showToast('Note not found');
      } else {
        showToast(`Failed to split: ${(e as Error).message}`);
      }
      setShowSplit(false);
    } finally {
      setSplitting(false);
    }
  }

  async function handleDelete() {
    if (!confirm(`Delete “${title}”? This cannot be undone.`)) return;
    setDeleting(true);
    try {
      await api.notes.delete(slug);
      onDeleted?.();
    } catch (e) {
      if (e instanceof NotFoundError) {
        showToast('Note was already deleted');
        onDeleted?.();
      } else {
        showToast(`Failed to delete: ${(e as Error).message}`);
        setDeleting(false);
      }
    }
  }

  return (
    <>
      <div class={`toolbar${toolbarClass ? ` ${toolbarClass}` : ''}`}>
        {showView && (
          <a class="btn-icon" href={`${base}/notes/${slug}`} title="View" aria-label="View"><Icon name="eye" size={16} /></a>
        )}
        <a class="btn-icon" href={`${base}/api/v1/notes/${slug}/download-markdown`} title="Download Markdown" aria-label="Download Markdown"><Icon name="file-down" size={16} /></a>
        <button class="btn-icon" title="Download HTML" aria-label="Download HTML" onClick={handleDownloadHtml}>HTML</button>
        <button class="btn-icon" title="Print" aria-label="Print" onClick={handlePrint}><Icon name="printer" size={16} /></button>
        <button class="btn-icon" title="Split by headings" aria-label="Split by headings" onClick={() => setShowSplit(true)} disabled={splitting}><Icon name="scissors" size={16} /></button>
        <button class="btn-icon" title="Edit" aria-label="Edit" onClick={() => navigate(`/notes/${slug}/edit`, { returnTo: currentPath() })}><Icon name="pencil" size={16} /></button>
        <button class="danger btn-icon" onClick={handleDelete} disabled={deleting}
          title={deleting ? 'Deleting…' : 'Delete'} aria-label={deleting ? 'Deleting…' : 'Delete'}><Icon name="recycle" size={16} /></button>
      </div>
      {showSplit && (
        <SplitDialog busy={splitting} onClose={() => setShowSplit(false)} onSplit={doSplit} />
      )}
    </>
  );
}
