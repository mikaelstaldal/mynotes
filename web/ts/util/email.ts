// "Send as email" — hands a rendered note to the sibling MyMail instance.
//
// The note goes out as body_html — the read-view render, rewritten by
// util/emailhtml.ts so it survives an email round-trip.
//
// When that rewriting had to give something up — a Mermaid diagram, MathML, an
// image or embedded SVG the body cannot carry — the standalone "Download HTML"
// document is attached alongside, so nothing is actually lost. When the body is
// a faithful rendering of the note, which is the common case, no attachment is
// sent: a duplicate copy of a note the recipient can already read in full is
// noise, and it roughly doubles the size of the message.

import { api, type Note } from '../api/client.js';
import { buildNoteFragment, wrapNoteDocument } from './export.js';
import { toEmailBody } from './emailhtml.js';

// Everything needed to hand one note to MyMail. `subject` is a starting point
// the user may edit before sending.
export interface NoteEmail {
  subject: string;
  bodyText: string;
  bodyHtml: string;
  // The standalone export, present only when the body lost content (see
  // `degraded`). Absent means the body stands on its own.
  attachment?: { blob: Blob; filename: string };
  // What the body could not carry, for the caller to report to the user.
  degraded: string[];
}

// Fetch a note and build the message. The fragment is rendered once and cloned,
// so any attachment is exactly what "Download HTML" would have produced and the
// inline body is derived from the same render.
export async function buildNoteEmail(slug: string): Promise<NoteEmail> {
  const note: Note = await api.notes.get(slug);
  const fragment = await buildNoteFragment(note, false);

  // Rewriting mutates the fragment, so the body works off a clone and the
  // standalone document keeps the unmodified render.
  const body = toEmailBody(fragment.cloneNode(true) as HTMLElement, document.baseURI);

  return {
    subject: note.title,
    // Plain-text alternative for clients that refuse HTML: the note's Markdown
    // source, which is the most faithful text rendering available.
    bodyText: note.content,
    bodyHtml: body.html,
    degraded: body.degraded,
    ...(body.degraded.length > 0 && {
      attachment: {
        blob: new Blob([wrapNoteDocument(note, fragment, false)], { type: 'text/html' }),
        filename: `${note.slug}.html`,
      },
    }),
  };
}

// Send a built note through MyMail. Messages carrying the standalone export go
// to the multipart endpoint; the rest use the plain JSON one, so an unattached
// note is an ordinary send rather than a multipart request with no files in it.
//
// This is the one place the frontend talks to something other than the MyNotes
// API, so it deliberately does not go through api/client.ts — that client owns
// the MyNotes base path, retry policy and 401/404 handling, none of which apply
// to a different application. MyMail is same-origin (its URL is derived from
// this instance's -public-url), so `credentials: 'include'` carries the shared
// Basic-Auth session and the Origin header satisfies MyMail's CSRF check.
export async function sendNoteEmail(
  mymailUrl: string,
  email: NoteEmail,
  recipient: string,
  subject: string,
): Promise<void> {
  const message = {
    to_addr: recipient,
    subject,
    body_text: email.bodyText,
    body_html: email.bodyHtml,
  };

  let path: string;
  let init: RequestInit;
  if (email.attachment) {
    const form = new FormData();
    form.append('message', JSON.stringify(message));
    form.append('attachments', email.attachment.blob, email.attachment.filename);
    path = '/api/v1/messages/send-with-attachments';
    init = { method: 'POST', body: form };
  } else {
    path = '/api/v1/messages/send';
    init = {
      method: 'POST',
      body: JSON.stringify(message),
      headers: { 'Content-Type': 'application/json' },
    };
  }

  const response = await fetch(`${mymailUrl}${path}`, { ...init, credentials: 'include' });
  if (!response.ok) {
    let message = `MyMail returned ${response.status}`;
    try {
      const body = await response.json();
      if (body?.error) message = body.error;
    } catch {
      // Non-JSON error body — keep the status-based message.
    }
    throw new Error(message);
  }
}
