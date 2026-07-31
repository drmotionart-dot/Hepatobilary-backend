// pdf-parse (1.1.x) is a CommonJS function (not a class). It is imported via
// dynamic `import()` in route handlers, so the interop shape exposes it as
// the `default` export: `(await import("pdf-parse")).default(buffer)`.
declare module "pdf-parse" {
  export interface PDFParseOptions {
    pagerender?: (...args: unknown[]) => unknown;
    max?: number;
    version?: string;
  }
  export interface PDFParseResult {
    text: string;
    numpages: number;
    numrender: number;
    info: Record<string, unknown>;
    metadata: Record<string, unknown>;
    version: string;
  }
  const PDFParse: (dataBuffer: Buffer | { data: Buffer }, options?: PDFParseOptions) => Promise<PDFParseResult>;
  export default PDFParse;
}
