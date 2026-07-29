// A tiny observable modal-dialog store — the blocking counterpart of
// util/toast.ts. UI code calls confirmDialog / promptDialog and awaits the
// answer; the <Dialogs> component subscribes and renders the pending request.
//
// These replace window.confirm / window.prompt, which are styled by the browser,
// blocked outright in some contexts, and impossible to theme. The one behavioural
// difference callers must account for is that these are asynchronous: they
// return a promise instead of an answer, so a caller that used to decide inline
// has to await (see router.ts's navigation guard, which now accepts a promise).
//
// Requests queue: only the first is rendered, and the next appears once it is
// answered, so two overlapping asks can never race for the same overlay.

interface BaseOptions {
  // Short heading naming the action being asked about.
  title: string;
  // Optional paragraph spelling out the consequences.
  body?: string;
  // Label of the accepting button (default 'OK').
  confirmLabel?: string;
  // Label of the dismissing button (default 'Cancel').
  cancelLabel?: string;
  // Withholds the casual ways out — Escape and a click outside the box — so the
  // only answers are the two buttons. For a question whose dismissing answer is
  // itself destructive (discarding a draft), where a stray click must not be
  // able to trigger it.
  requireAnswer?: boolean;
}

export interface ConfirmOptions extends BaseOptions {
  // Style the accepting button as destructive rather than primary.
  danger?: boolean;
}

export interface PromptOptions extends BaseOptions {
  // Label of the text field.
  label: string;
  initialValue?: string;
  placeholder?: string;
  maxLength?: number;
}

export type DialogRequest =
  | { id: number; kind: 'confirm'; options: ConfirmOptions; resolve: (value: boolean) => void }
  | { id: number; kind: 'prompt'; options: PromptOptions; resolve: (value: string | null) => void };

type Listener = (requests: DialogRequest[]) => void;

let requests: DialogRequest[] = [];
let nextId = 0;
const listeners = new Set<Listener>();

function notify(): void {
  const snapshot = [...requests];
  for (const l of listeners) l(snapshot);
}

export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  listener([...requests]);
  return () => { listeners.delete(listener); };
}

// Asks the user to confirm an action. Resolves true when accepted, false when
// dismissed (button, Escape, or a click outside) — the same answers window.confirm
// gave, so call sites read the same way apart from the await.
export function confirmDialog(options: ConfirmOptions): Promise<boolean> {
  return new Promise<boolean>(resolve => {
    requests = [...requests, { id: nextId++, kind: 'confirm', options, resolve }];
    notify();
  });
}

// Asks the user for a line of text. Resolves the entered string (possibly empty)
// when accepted and null when dismissed, mirroring window.prompt.
export function promptDialog(options: PromptOptions): Promise<string | null> {
  return new Promise<string | null>(resolve => {
    requests = [...requests, { id: nextId++, kind: 'prompt', options, resolve }];
    notify();
  });
}

// Answers a pending request and drops it from the queue. Called by the <Dialogs>
// component; the value must match the request's kind.
export function resolveDialog(id: number, value: boolean | string | null): void {
  const request = requests.find(r => r.id === id);
  if (!request) return;
  requests = requests.filter(r => r.id !== id);
  notify();
  (request.resolve as (v: boolean | string | null) => void)(value);
}
