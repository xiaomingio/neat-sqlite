/*
Purpose: Define lossless SQLite values and the editor request/response contract.
*/
export type Value = { type: 'null' | 'integer' | 'real' | 'text' | 'blob'; value: string };
export type Column = { name: string; type: string; notNull: boolean; defaultValue: string | null; pk: number; generated: boolean };
export type Table = { name: string; kind: 'table' | 'view'; sql: string; editable: boolean; reason?: string; columns: Column[]; indexes: unknown[]; foreignKeys: unknown[] };
export type Row = { key: string; values: Value[]; modified: boolean; inserted: boolean; deleted: boolean };
export type ColumnFilter = { column: string; mode: 'text'; text: string }
  | { column: string; mode: 'regex'; text: string }
  | { column: string; mode: 'values'; values: Value[] }
  | { column: string; mode: 'number'; operator: 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'between'; value: string; max?: string }
  | { column: string; mode: 'empty' | 'notEmpty' }
  | { column: string; mode: 'custom'; sql: string };
export type Query = { table: string; offset: number; limit: number; sort?: { column: string; direction: 'ASC' | 'DESC' }; filters?: ColumnFilter[] };
export type DistinctValue = { value: Value; count: number };

export type Page = { rows: Row[]; hasMore: boolean; offset: number };
export type Status = { pending: number; tables: string[]; canUndo: boolean; canRedo: boolean; readOnly: boolean };
export type Edit = { kind: 'update'; table: string; key: string; column: string; value: Value } | { kind: 'insert'; table: string; values: Record<string, Value> } | { kind: 'delete'; table: string; key: string };
export type Action = { type: 'distinct'; table: string; column: string } | { type: 'metadata' } | { type: 'page'; query: Query } | { type: 'edit'; edits: Edit[] } | { type: 'undo' | 'redo' | 'discard' | 'save' | 'refresh' } | { type: 'export'; query: Query } | { type: 'backup' } | { type: 'clipboardRead' } | { type: 'clipboardWrite'; text: string };
export type Result = { tables?: Table[]; page?: Page; distinct?: DistinctValue[]; status: Status; text?: string };
export type Request = { id: number; action: Action };
export type Response = { id: number; result?: Result; error?: string } | { event: 'status'; status: Status };
