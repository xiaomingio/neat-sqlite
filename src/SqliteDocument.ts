/*
Purpose: Own a database editor lifecycle and serialize reads, staged edits, saves, and recovery.
*/
import type * as vscode from 'vscode';
import { readFile, writeFile, mkdir, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { SqliteDatabase } from './SqliteDatabase';

export class SqliteDocument implements vscode.CustomDocument {
  private queue: Promise<unknown> = Promise.resolve();
  private closed = false;
  epoch = 0;
  flushInput?: () => Promise<void>;
  notify?: () => void;
  private constructor(readonly uri: vscode.Uri, readonly database: SqliteDatabase) {}

  static async open(uri: vscode.Uri, backupId?: string): Promise<SqliteDocument> {
    if (uri.scheme !== 'file') throw new Error('Open a local SQLite database file.');
    const database = await SqliteDatabase.open(uri.fsPath);
    try {
      if (backupId) await database.restore(await readFile(backupId, 'utf8'));
      return new SqliteDocument(uri, database);
    } catch (error) { await database.close(); throw error; }
  }

  run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(() => {
      if (this.closed) throw new Error('The database editor has closed.');
      return operation();
    });
    this.queue = result.catch(() => undefined);
    return result;
  }

  async save(): Promise<void> {
    await this.flushInput?.();
    await this.run(async () => { await this.database.save(); this.epoch++; this.notify?.(); });
  }

  async saveAs(destination: vscode.Uri): Promise<void> {
    if (destination.scheme !== 'file') throw new Error('Choose a local destination.');
    await this.flushInput?.();
    await this.run(async () => {
      await this.database.backup(destination.fsPath);
      try {
        const copy = await SqliteDatabase.open(destination.fsPath);
        try { await copy.restore(this.database.recovery()); await copy.save(); }
        finally { await copy.close(); }
      } catch (error) {
        await unlink(destination.fsPath).catch(() => undefined);
        throw error;
      }
    });
  }

  async backup(destination: vscode.Uri): Promise<vscode.CustomDocumentBackup> {
    await this.flushInput?.();
    return this.run(async () => {
      await mkdir(dirname(destination.fsPath), { recursive: true });
      await writeFile(destination.fsPath, this.database.recovery(), 'utf8');
      return { id: destination.fsPath, delete: async () => { await unlink(destination.fsPath).catch(() => undefined); } };
    });
  }

  dispose(): void {
    this.closed = true;
    void this.queue.then(() => this.database.close()).catch(error => console.error('Neat SQLite close failed:', error));
  }
}
