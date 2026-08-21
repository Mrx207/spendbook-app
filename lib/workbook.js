import * as XLSX from "xlsx";
import { parseCSV } from "./statement.js";

// Banks label almost anything ".xls". Plenty of Indian exports are actually an
// HTML table or tab separated text with a spreadsheet extension, and some are
// genuine last-century BIFF files. Sniffing the first bytes is the only
// reliable way to tell, so the extension is treated as a hint at most.
export function sniff(buffer) {
  const head = buffer.subarray(0, 8);
  // ZIP magic - every .xlsx is a zip archive.
  if (head[0] === 0x50 && head[1] === 0x4b) return "xlsx";
  // OLE2 compound document - the real legacy .xls container.
  if (head[0] === 0xd0 && head[1] === 0xcf && head[2] === 0x11 && head[3] === 0xe0) return "xls";

  const text = buffer.subarray(0, 4096).toString("utf8").trim().toLowerCase();
  if (/^(<!doctype|<html|<table|<meta|<\?xml)/.test(text)) return "html";
  if (/^<\?xml|<workbook/.test(text)) return "xml";
  return "text";
}

// Picks the separator by counting candidates on the busiest line, so tab and
// semicolon exports read as well as commas.
function delimited(text) {
  const lines = text.split(/\r?\n/).filter(l => l.trim()).slice(0, 40);
  if (!lines.length) return [];
  const score = (ch) => lines.reduce((n, l) => n + (l.split(ch).length - 1), 0);
  const tabs = score("\t"), semis = score(";"), commas = score(",");

  if (tabs > commas && tabs > semis) {
    return text.split(/\r?\n/).map(l => l.split("\t"));
  }
  if (semis > commas) {
    return text.split(/\r?\n/).map(l => l.split(";"));
  }
  return parseCSV(text);
}

/**
 * Reads any supported statement file into an array of rows.
 * Returns { rows, format } so the caller can explain what it saw.
 */
export function readWorkbook(buffer) {
  const format = sniff(buffer);

  if (format === "text") {
    return { rows: delimited(buffer.toString("utf8")), format: "text" };
  }

  // Formatted values rather than raw ones: a date should arrive as the string
  // the bank displayed, which the date parser already understands, and numbers
  // keep their grouping for the amount parser to strip.
  const wb = XLSX.read(buffer, { type: "buffer", cellDates: true, raw: false, WTF: false });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  if (!sheet) return { rows: [], format };

  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: "", blankrows: true });
  return { rows: rows.map(r => r.map(c => (c === null || c === undefined ? "" : c))), format };
}
