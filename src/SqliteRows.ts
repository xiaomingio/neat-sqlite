/*
Purpose: Stream SQLite rows and finalize statements before reporting success or native errors.
*/
import type sqlite3 from 'sqlite3';

export class SqliteRows {
  constructor(private readonly db: sqlite3.Database) {}

  each<T>(sql: string, params: unknown[], visit: (row: T) => void): Promise<void> {
    return new Promise((resolve, reject) => {
      const statement = this.db.prepare(sql, error => {
        if (error) { reject(error); return; }
        let failure: Error | undefined;
        statement.each(params, (rowError: Error | null, row: T) => {
          if (failure) return;
          try { if (rowError) throw rowError; visit(row); }
          catch (cause) { failure = cause instanceof Error ? cause : new Error(String(cause)); this.db.interrupt(); }
        }, (completionError: Error | null) => {
          failure ??= completionError ?? undefined;
          // sqlite3's completion notification can precede its worker's error callback.
          // Finalization waits for the worker and preserves errors on every platform.
          statement.finalize(finalizeError => {
            failure ??= finalizeError ?? undefined;
            if (failure) reject(failure); else resolve();
          });
        });
      });
    });
  }
}
