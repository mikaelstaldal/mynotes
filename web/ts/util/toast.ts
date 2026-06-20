// A tiny observable toast store. UI code calls showToast / showNetworkErrorToast;
// the <Toast> component subscribes and renders the current list. Keeping the
// store separate from the component lets non-component code (e.g. the API
// client) raise toasts without prop drilling.

export interface ToastItem {
  id: number;
  message: string;
  persistent: boolean;
  onRetry?: () => void;
}

type Listener = (items: ToastItem[]) => void;

let items: ToastItem[] = [];
let nextId = 0;
const listeners = new Set<Listener>();

function notify(): void {
  const snapshot = [...items];
  for (const l of listeners) l(snapshot);
}

export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  listener([...items]);
  return () => { listeners.delete(listener); };
}

export function showToast(message: string, duration = 5000): void {
  const id = nextId++;
  items = [...items, { id, message, persistent: false }];
  notify();
  setTimeout(() => dismissToast(id), duration);
}

// A persistent toast with a Retry button, used for recoverable network errors.
export function showNetworkErrorToast(message: string, onRetry: () => void): void {
  const id = nextId++;
  items = [...items, { id, message, persistent: true, onRetry }];
  notify();
}

export function dismissToast(id: number): void {
  items = items.filter(t => t.id !== id);
  notify();
}
