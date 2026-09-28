/** A profile field a spreadsheet column can feed. */
export type Field = 'name' | 'proxy' | 'cookies' | 'tags' | 'status' | 'folder' | 'notes' | 'startUrl';
export type Column = Field | 'ignore';

/** One row of POST /api/import/profiles; every value goes up raw, the server parses. */
export type ImportRow = { name: string } & Partial<Record<Exclude<Field, 'name'>, string>>;

export interface Skipped {
  name: string;
  error: string;
}
export interface ImportResult {
  created: number;
  skipped: Skipped[];
}

export interface ExportFile {
  id: string;
  url: string;
  bytes: number;
}
export interface ExportResult {
  files: ExportFile[];
  skipped: Array<{ id: string; error: string }>;
}
export interface SmpResult {
  created: string[];
  skipped: Array<{ id: string; error: string }>;
}

/** A text file the user picked or dropped. */
export interface PickedFile {
  name: string;
  text: string;
  bytes: number;
}
