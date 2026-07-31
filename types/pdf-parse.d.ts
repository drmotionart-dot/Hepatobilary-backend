declare module "pdf-parse" {
  export class PDFParse {
    constructor(options: { data: Buffer });
    getText(): Promise<{ text: string }>;
  }
  export default PDFParse;
}
