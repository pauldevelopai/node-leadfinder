// document-processor.js — extract plain text from an uploaded file by mime type.
// Trimmed from the tracker's document-processor.js (just extractText — the Node has
// no uploaded_documents table / knowledge base to feed). pdf-parse / mammoth / xlsx
// are lazy-imported so a text-only upload never loads them.
import fs from 'node:fs';

export async function extractText(filePath, mimeType) {
  if (mimeType === 'application/pdf') {
    // pdf-parse v2 exports a PDFParse class (no default pdfParse(buffer) function).
    const { PDFParse } = await import('pdf-parse');
    const buffer = fs.readFileSync(filePath);
    const parser = new PDFParse({ data: new Uint8Array(buffer) });
    try {
      const data = await parser.getText();
      return data.text || '';
    } finally {
      try { await parser.destroy(); } catch { /* ignore */ }
    }
  }

  if (mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
    const mammoth = await import('mammoth');
    const result = await mammoth.extractRawText({ path: filePath });
    return result.value;
  }

  if (mimeType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' || mimeType === 'text/csv') {
    const xlsx = (await import('xlsx')).default;
    const wb = xlsx.readFile(filePath);
    let text = '';
    for (const name of wb.SheetNames) {
      const ws = wb.Sheets[name];
      text += `=== ${name} ===\n`;
      text += xlsx.utils.sheet_to_csv(ws) + '\n\n';
    }
    return text;
  }

  if (mimeType === 'text/plain') {
    return fs.readFileSync(filePath, 'utf-8');
  }

  throw new Error(`Unsupported file type: ${mimeType}`);
}
