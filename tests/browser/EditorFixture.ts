/*
Purpose: Connect the real browser UI to temporary SQLite files using the production engine contract.
*/
import type { Page } from '@playwright/test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sqlite3 from 'sqlite3';
import { SqliteDatabase } from '../../src/SqliteDatabase';
import type { Action, Request, Result } from '../../src/protocol';
export class EditorFixture {
  private engine!: SqliteDatabase;
  private directory = '';
  private clipboard = '';
  private operations: Promise<unknown> = Promise.resolve();
  private heldPage?: { table: string; wait: Promise<void> };
  holdNextPage(table: string): () => void { let release!: () => void; const wait = new Promise<void>(resolve => { release = resolve; }); this.heldPage = { table, wait }; return release; }
  async open(page: Page): Promise<void> {
    this.directory = await mkdtemp(join(tmpdir(), 'neat-sqlite-ui-'));
    const path = join(this.directory, 'sample.sqlite');
    const db = await new Promise<sqlite3.Database>((resolve, reject) => { const instance = new sqlite3.Database(path, error => error ? reject(error) : resolve(instance)); });
    await new Promise<void>((resolve, reject) => db.exec(`CREATE TABLE users(id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT, score REAL DEFAULT 1.5, label TEXT GENERATED ALWAYS AS (name || '!') VIRTUAL); INSERT INTO users(name,email) VALUES ('Alice','alice@example.com'),('Bob',NULL); CREATE TABLE orders(id INTEGER PRIMARY KEY, note TEXT); INSERT INTO orders(note) VALUES ('First order'); CREATE VIEW user_names AS SELECT name FROM users; CREATE TABLE filter_values(value); INSERT INTO filter_values VALUES (NULL),(''),(0),('0'),(1.5),('A'),('A'); CREATE TABLE "__proto__"("constructor" TEXT); INSERT INTO "__proto__" VALUES ('safe');`, error => error ? reject(error) : resolve()));
    await new Promise<void>((resolve, reject) => db.close(error => error ? reject(error) : resolve()));
    this.engine = await SqliteDatabase.open(path);
    await page.exposeFunction('editorHost', async (request: Request) => {
      const held = request.action.type === 'page' && this.heldPage?.table === request.action.query.table ? this.heldPage : undefined; if (held) this.heldPage = undefined;
      const operation = this.operations.then(() => this.dispatch(request.action)); this.operations = operation.then(() => undefined, () => undefined);
      const response = await operation.then(result => ({ id: request.id, result }), error => ({ id: request.id, error: error instanceof Error ? error.message : String(error) }));
      if (held) await held.wait; return response;
    });
    await page.addInitScript(() => {
      let state: unknown;
      (window as unknown as { acquireVsCodeApi: () => unknown }).acquireVsCodeApi = () => ({ getState: () => state, setState: (next: unknown) => { state = next; }, postMessage: (message: unknown) => {
        if ((message as { type?: string }).type === 'flushed') { (window as unknown as { flushResult: unknown }).flushResult = message; return; }
        void (window as unknown as { editorHost: (message: unknown) => Promise<unknown> }).editorHost(message).then(result => window.dispatchEvent(new MessageEvent('message', { data: result })));
      } });
    });
    await page.route('http://editor.test/**', async route => {
      const url = new URL(route.request().url());
      if (url.pathname === '/grid.js' || url.pathname === '/style.css') await route.fulfill({ contentType: url.pathname.endsWith('.js') ? 'text/javascript' : 'text/css', body: await readFile(join(process.cwd(), 'dist', url.pathname.slice(1))) });
      else await route.fulfill({ contentType: 'text/html', body: `<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self' 'nonce-test'; style-src 'self';"><link rel="stylesheet" href="/style.css"></head><body><div id="app"></div><script nonce="test" src="/grid.js"></script></body></html>` });
    });
    await page.goto('http://editor.test/');
  }
  private async dispatch(action: Action): Promise<Result> {
    switch (action.type) {
      case 'distinct': return { distinct: await this.engine.distinct(action.table, action.column), status: this.engine.status() };
      case 'metadata': return { tables: await this.engine.metadata(), status: this.engine.status() };
      case 'page': return { page: await this.engine.page(action.query), status: this.engine.status() };
      case 'edit': await this.engine.edit(action.edits); break;
      case 'save': await this.engine.save(); break;
      case 'undo': await this.engine.undo(); break;
      case 'redo': await this.engine.redo(); break;
      case 'discard': await this.engine.discard(); break;
      case 'refresh': await this.engine.refresh(); break;
      case 'export': return { text: await this.engine.exportCsv(action.query), status: this.engine.status() };
      case 'backup': await this.engine.backup(join(this.directory, 'backup.sqlite')); break;
      case 'clipboardRead': return { text: this.clipboard, status: this.engine.status() };
      case 'clipboardWrite': this.clipboard = action.text; break;
    }
    return { status: this.engine.status() };
  }
  async close(): Promise<void> { await this.engine?.close(); if (this.directory) await rm(this.directory, { recursive: true, force: true }); }
}
