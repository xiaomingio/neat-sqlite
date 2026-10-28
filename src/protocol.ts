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
/** One ORDER BY key. A query applies keys in array order, then the natural row identity. */
export type SortKey = { column: string; direction: 'ASC' | 'DESC' };
export type Query = { table: string; offset: number; limit: number; sort?: SortKey[]; filters?: ColumnFilter[] };
export type DistinctValue = { value: Value; count: number };

export type Page = { rows: Row[]; hasMore: boolean; offset: number; snapshot?: string };
export type Status = { pending: number; tables: string[]; canUndo: boolean; canRedo: boolean; readOnly: boolean };
export type Edit = { kind: 'update'; table: string; key: string; column: string; value: Value } | { kind: 'insert'; table: string; values: Record<string, Value> } | { kind: 'delete'; table: string; key: string };
export type SqlResult = { columns: string[]; rows: Value[][]; elapsedMs: number; truncated: boolean };
export type CsvMapping = { source: number; column: string; type: 'text' | 'integer' | 'real' | 'auto'; empty: 'text' | 'null' | 'default' };
export type CsvPreview = { headers: string[]; rows: string[][]; total: number };
export type SearchScope = { type: 'table' } | { type: 'selection'; snapshot: string; cells: { key: string; column: string }[] };
export type SearchRequest = { table: string; scope: SearchScope; column?: string; search: string; replacement?: string; matchCase: boolean; preview?: string; regex?: boolean };
export type SearchHit = { key: string; column: string; before: string; after: string; type: Value['type']; offset: number; match?: [number, number] };
export type SearchResult = { count: number; changes: number; samples: SearchHit[]; token: string; truncated: boolean };
export type SearchLocation = { query: Query; page: Page; row: number; column: string };
export type DatabaseReport = { integrity: string[]; foreignKeys: Record<string, unknown>[]; pageCount: number; pageSize: number; freePages: number; bytes: number };
export type RelatedRecord = { table: string; filters: ColumnFilter[] };
export type Action = { type: 'foreignRecord'; table: string; key: string; foreignKey: number } | { type: 'sqlQuery' | 'sqlExport'; sql: string; limit?: number } | { type: 'sqlCancel' } | { type: 'sqlWrite'; sql: string }
  | { type: 'csvRead' } | { type: 'csvPreview'; text: string } | { type: 'csvImport'; table: string; text: string; mapping: CsvMapping[]; nullToken?: string }
  | ({ type: 'find' | 'replacePreview' | 'replaceApply' } & SearchRequest)
  | ({ type: 'replaceOne'; target: { key: string; column: string } } & SearchRequest)
  | { type: 'searchLocate'; token: string; key: string; column: string; limit: number }
  | { type: 'maintenance'; operation: 'check' | 'vacuum' } | { type: 'count'; query: Query } | { type: 'distinct'; table: string; column: string } | { type: 'metadata' } | { type: 'page'; query: Query } | { type: 'edit'; edits: Edit[] } | { type: 'undo' | 'redo' | 'discard' | 'save' | 'refresh' } | { type: 'export'; query: Query } | { type: 'backup' } | { type: 'clipboardRead' } | { type: 'clipboardWrite'; text: string };
export type Result = { tables?: Table[]; page?: Page; distinct?: DistinctValue[]; status: Status; text?: string; sql?: SqlResult; csv?: CsvPreview; search?: SearchResult; located?: SearchLocation; snapshot?: string; report?: DatabaseReport; changes?: number; count?: number; related?: RelatedRecord };
export type Request = { id: number; action: Action };
export type Response = { id: number; result?: Result; error?: string } | { event: 'status'; status: Status };
