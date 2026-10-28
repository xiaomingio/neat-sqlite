/*
Purpose: Register the SQLite custom editor and connect document lifecycle, native clipboard, and the webview.
*/
import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { DatabaseDestination } from './DatabaseDestination';
import { CsvImport } from './CsvImport';
import { SqliteDocument } from './SqliteDocument';
import type { Action, Request, Response, Result } from './protocol';

type Flush = { id: number; resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };
class SqliteEditorProvider implements vscode.CustomEditorProvider<SqliteDocument> {
  private readonly changed = new vscode.EventEmitter<vscode.CustomDocumentEditEvent<SqliteDocument>>();
  readonly onDidChangeCustomDocument = this.changed.event;
  constructor(private readonly context: vscode.ExtensionContext) {}
  openCustomDocument(uri: vscode.Uri, openContext: vscode.CustomDocumentOpenContext): Promise<SqliteDocument> {
    return SqliteDocument.open(uri, openContext.backupId);
  }
  saveCustomDocument(document: SqliteDocument): Promise<void> { return document.save(); }
  saveCustomDocumentAs(document: SqliteDocument, destination: vscode.Uri): Promise<void> { return document.saveAs(destination); }
  revertCustomDocument(document: SqliteDocument): Promise<void> {
    return document.run(async () => { await document.database.discard(); await document.database.refresh(); document.epoch++; document.notify?.(); });
  }
  backupCustomDocument(document: SqliteDocument, context: vscode.CustomDocumentBackupContext): Promise<vscode.CustomDocumentBackup> { return document.backup(context.destination); }

  async resolveCustomEditor(document: SqliteDocument, panel: vscode.WebviewPanel): Promise<void> {
    const webview = panel.webview;
    const dist = vscode.Uri.joinPath(this.context.extensionUri, 'dist');
    webview.options = { enableScripts: true, localResourceRoots: [dist] };
    const nonce = randomBytes(24).toString('hex');
    const script = webview.asWebviewUri(vscode.Uri.joinPath(dist, 'grid.js'));
    const css = webview.asWebviewUri(vscode.Uri.joinPath(dist, 'style.css'));
    webview.html = `<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} data:;"><meta name="csp-nonce" content="${nonce}"><link rel="stylesheet" href="${css}"><title>Neat SQLite</title></head><body><div id="app"></div><script nonce="${nonce}" src="${script}"></script></body></html>`;
    const post = (message: Response) => { void webview.postMessage(message); };
    document.notify = () => post({ event: 'status', status: document.database.status() });
    let flush: Flush | undefined;
    let flushSequence = 0;
    document.flushInput = () => {
      if (flush) return Promise.reject(new Error('Another save is already in progress.'));
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { flush = undefined; reject(new Error('The editor did not finish its active input. Try saving again.')); }, 15000);
        flush = { id: ++flushSequence, resolve, reject, timer };
        void webview.postMessage({ event: 'flush', id: flush.id }).then(delivered => {
          if (!delivered && flush) { clearTimeout(flush.timer); flush.reject(new Error('The editor is unavailable.')); flush = undefined; }
        });
      });
    };
    const subscription = webview.onDidReceiveMessage(async (message: unknown) => {
      if (message && typeof message === 'object' && 'type' in message && message.type === 'flushed') {
        if (flush && 'id' in message && message.id === flush.id) {
          clearTimeout(flush.timer);
          if ('error' in message && typeof message.error === 'string') flush.reject(new Error(message.error));
          else flush.resolve();
          flush = undefined;
        }
        return;
      }
      if (!message || typeof message !== 'object' || !('id' in message) || !Number.isSafeInteger(message.id) || !('action' in message)) return;
      const request = message as Request;
      if (!request.action || typeof request.action !== 'object' || typeof request.action.type !== 'string') return;
      try {
        if (JSON.stringify(request).length > 16 * 1024 * 1024) throw new Error('This operation exceeds the 16 MiB message limit.');
        if (request.action.type === 'sqlCancel') {
          document.database.sqlCancel(); post({ id: request.id, result: { status: document.database.status() } }); return;
        }
        if (request.action.type === 'save') {
          // VS Code owns dirty-state transitions and invokes saveCustomDocument.
          await vscode.commands.executeCommand('workbench.action.files.save');
          post({ id: request.id, result: { status: document.database.status() } }); return;
        }
        if (request.action.type === 'discard') {
          await vscode.commands.executeCommand('workbench.action.files.revert');
          post({ id: request.id, result: { status: document.database.status() } }); return;
        }
        if (request.action.type === 'undo' || request.action.type === 'redo') {
          await vscode.commands.executeCommand(request.action.type);
          post({ id: request.id, result: { status: document.database.status() } }); return;
        }
        const result = await document.run(() => this.handle(document, request.action));
        post({ id: request.id, result });
      } catch (error) { post({ id: request.id, error: error instanceof Error ? error.message : String(error) }); }
    });
    panel.onDidDispose(() => {
      subscription.dispose(); document.notify = undefined; document.flushInput = undefined;
      if (flush) { clearTimeout(flush.timer); flush.reject(new Error('The database editor closed.')); flush = undefined; }
    });
  }

  private recordEdit(document: SqliteDocument, label: string): void {
    const epoch = document.epoch;
    const checkEpoch = () => { if (epoch !== document.epoch) throw new Error('Undo is available for changes made since the last save or revert.'); };
    this.changed.fire({ document, label, undo: () => document.run(async () => { checkEpoch(); await document.database.undo(); document.notify?.(); }), redo: () => document.run(async () => { checkEpoch(); await document.database.redo(); document.notify?.(); }) });
  }

  private async handle(document: SqliteDocument, action: Action): Promise<Result> {
    const database = document.database;
    let result: Omit<Result, 'status'> = {};
    switch (action.type) {
      case 'foreignRecord': result.related = await database.foreignRecord(action.table, action.key, action.foreignKey); break;
      case 'sqlCancel': database.sqlCancel(); break;
      case 'sqlQuery': result.sql = await database.sqlQuery(action.sql, action.limit); break;
      case 'sqlExport': {
        const text = database.sqlExport(action.sql, action.limit);
        const target = await vscode.window.showSaveDialog({ saveLabel: 'Export Query CSV', filters: { CSV: ['csv'] } });
        if (target) { if (target.scheme !== 'file') throw new Error('Choose a local destination.'); await DatabaseDestination.validate(document.uri.fsPath, target.fsPath); await writeFile(target.fsPath, text, 'utf8'); }
        break;
      }
      case 'sqlWrite': result.changes = await database.sqlWrite(action.sql); document.epoch++; result.tables = await database.metadata(); document.notify?.(); break;
      case 'csvRead': {
        const files = await vscode.window.showOpenDialog({ canSelectMany: false, filters: { CSV: ['csv'] } });
        if (files?.[0]) { if (files[0].scheme !== 'file') throw new Error('Choose a local CSV file.'); if ((await stat(files[0].fsPath)).size > 8 * 1024 * 1024) throw new Error('Import CSV files of at most 8 MiB.'); result.text = await readFile(files[0].fsPath, 'utf8'); }
        break;
      }
      case 'csvPreview': result.csv = new CsvImport(action.text).preview(); break;
      case 'csvImport': result.changes = await database.csvImport(action.table, action.text, action.mapping, action.nullToken); if (result.changes) this.recordEdit(document, 'Import CSV records'); break;
      case 'find': case 'replacePreview': case 'replaceApply': result.search = await database.search(action, action.type); if (result.search.changes) this.recordEdit(document, 'Replace SQLite values'); break;
      case 'replaceOne': ({ changes: result.changes, snapshot: result.snapshot } = await database.replaceOne(action)); if (result.changes) this.recordEdit(document, 'Replace SQLite value'); break;
      case 'searchLocate': result.located = await database.searchLocate(action.token, action.key, action.column, action.limit); break;
      case 'maintenance': result.report = await database.maintenance(action.operation); if (action.operation === 'vacuum') { document.epoch++; document.notify?.(); } break;
      case 'count': result.count = await database.count(action.query); break;
      case 'metadata': result.tables = await database.metadata(); break;
      case 'page': result.page = await database.page(action.query); break;
      case 'distinct': result.distinct = await database.distinct(action.table, action.column); break;
      case 'edit': {
        await database.edit(action.edits);
        this.recordEdit(document, 'Edit SQLite records');
        break;
      }
      case 'discard':
        // Revert through VS Code to reset native dirty state together with pending edits.
        throw new Error('Use File → Revert File in VS Code to discard all pending changes.');
      case 'refresh': await database.refresh(); result.tables = await database.metadata(); break;
      case 'export': {
        const text = await database.exportCsv(action.query);
        const target = await vscode.window.showSaveDialog({ saveLabel: 'Export CSV', filters: { CSV: ['csv'] } });
        if (target) { if (target.scheme !== 'file') throw new Error('Choose a local destination.'); await DatabaseDestination.validate(document.uri.fsPath, target.fsPath); await writeFile(target.fsPath, text, 'utf8'); }
        break;
      }
      case 'backup': {
        const target = await vscode.window.showSaveDialog({ saveLabel: 'Save Database Snapshot', filters: { SQLite: ['sqlite', 'db'] } });
        if (target) { if (target.scheme !== 'file') throw new Error('Choose a local destination.'); await database.backup(target.fsPath); }
        break;
      }
      case 'clipboardRead': result.text = await vscode.env.clipboard.readText(); break;
      case 'clipboardWrite': if (typeof action.text !== 'string' || Buffer.byteLength(action.text) > 8 * 1024 * 1024) throw new Error('Clipboard data exceeds 8 MiB.'); await vscode.env.clipboard.writeText(action.text); break;
      default: throw new Error('Unsupported editor operation.');
    }
    return { ...result, status: database.status() };
  }
}
export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(vscode.window.registerCustomEditorProvider('neat-sqlite.editor', new SqliteEditorProvider(context), { webviewOptions: { retainContextWhenHidden: true }, supportsMultipleEditorsPerDocument: false }));
  context.subscriptions.push(vscode.commands.registerCommand('neat-sqlite.open', async () => {
    const files = await vscode.window.showOpenDialog({ canSelectMany: false, filters: { SQLite: ['sqlite', 'sqlite3', 'db', 'db3'] } });
    if (files?.[0]) await vscode.commands.executeCommand('vscode.openWith', files[0], 'neat-sqlite.editor');
  }));
}
