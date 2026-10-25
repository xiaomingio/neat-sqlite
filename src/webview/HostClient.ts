/*
Purpose: Correlate webview requests with host responses and persist editor preferences.
*/
import type { Action, Response, Result, Status } from '../protocol';
type Api = { postMessage(message: unknown): void; getState(): unknown; setState(state: unknown): void };
declare const acquireVsCodeApi: () => Api;
export class HostClient {
  private readonly api = acquireVsCodeApi();
  private sequence = 0;
  private readonly pending = new Map<number, { resolve: (result: Result) => void; reject: (error: Error) => void }>();
  onStatus?: (status: Status, external?: boolean) => void;
  onFlush?: () => Promise<void>;
  constructor() {
    window.addEventListener('message', event => {
      if (event.data?.event === 'flush') {
        const id = event.data.id as number;
        Promise.resolve().then(() => this.onFlush?.()).then(() => this.api.postMessage({ type: 'flushed', id }), error => this.api.postMessage({ type: 'flushed', id, error: error instanceof Error ? error.message : String(error) }));
        return;
      }
      const message = event.data as Response;
      if ('event' in message) { this.onStatus?.(message.status, true); return; }
      const request = this.pending.get(message.id);
      if (!request) return;
      this.pending.delete(message.id);
      if (message.error) request.reject(new Error(message.error));
      else if (message.result) { this.onStatus?.(message.result.status); request.resolve(message.result); }
      else request.reject(new Error('The editor received an empty response.'));
    });
  }
  request(action: Action): Promise<Result> {
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      this.pending.set(id, { resolve, reject });
      this.api.postMessage({ id, action });
    });
  }
  getState<T>(): T | undefined { return this.api.getState() as T | undefined; }
  setState(state: unknown): void { this.api.setState(state); }
}
