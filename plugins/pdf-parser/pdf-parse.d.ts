declare module 'pdf-parse' {
  interface PdfParseResult {
    text: string;
    numpages: number;
  }

  export default function pdfParse(buffer: Buffer): Promise<PdfParseResult>;
}
