// Read .xlsx / .csv / .tsv files into plain rows so a local model can map
// them to users. Read-only; nothing is sent anywhere.

import fs from "node:fs/promises";
import path from "node:path";
import ExcelJS from "exceljs";

const MAX_BYTES = 20 * 1024 * 1024;
const MAX_ROWS = 2000;

export function parseDelimited(text, delimiter = ",") {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  const s = String(text || "").replace(/^﻿/, "");
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === delimiter) {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && s[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += c;
    }
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((v) => String(v).trim() !== ""));
}

function cellText(v) {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === "object") {
    if (v.text !== undefined) return String(v.text);
    if (v.result !== undefined) return cellText(v.result);
    if (Array.isArray(v.richText)) return v.richText.map((p) => p.text).join("");
    if (v.hyperlink) return String(v.text || v.hyperlink).replace(/^mailto:/i, "");
    return "";
  }
  return String(v);
}

function toObjects(matrix) {
  const [header = [], ...body] = matrix;
  const headers = header.map((h, i) => String(h || "").trim() || `column${i + 1}`);
  return {
    headers,
    rows: body.slice(0, MAX_ROWS).map((r) => {
      const o = {};
      headers.forEach((h, i) => {
        o[h] = String(r[i] ?? "").trim();
      });
      return o;
    }),
    truncated: body.length > MAX_ROWS,
  };
}

export async function readSpreadsheet(filePath, { sheet } = {}) {
  const abs = path.resolve(String(filePath || ""));
  const stat = await fs.stat(abs);
  if (!stat.isFile()) throw new Error(`${abs} is not a file.`);
  if (stat.size > MAX_BYTES) throw new Error("File is larger than 20 MB.");
  const ext = path.extname(abs).toLowerCase();

  if (ext === ".csv" || ext === ".tsv" || ext === ".txt") {
    const text = await fs.readFile(abs, "utf8");
    const delimiter = ext === ".tsv" || (ext === ".txt" && text.includes("\t")) ? "\t" : ",";
    return { file: abs, sheet: null, sheets: [], ...toObjects(parseDelimited(text, delimiter)) };
  }
  if (ext === ".xls") {
    throw new Error("Old .xls files are not supported. Open it and save as .xlsx or .csv first.");
  }
  if (ext !== ".xlsx" && ext !== ".xlsm") {
    throw new Error(`Unsupported file type ${ext || "(none)"}. Use .xlsx, .csv or .tsv.`);
  }

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(abs);
  const names = wb.worksheets.map((w) => w.name);
  const ws = sheet ? wb.getWorksheet(sheet) : wb.worksheets.find((w) => w.actualRowCount > 0) || wb.worksheets[0];
  if (!ws) throw new Error(sheet ? `Sheet "${sheet}" not found. Sheets: ${names.join(", ")}` : "Workbook has no sheets.");
  const matrix = [];
  ws.eachRow({ includeEmpty: false }, (r) => {
    const vals = Array.isArray(r.values) ? r.values.slice(1) : [];
    matrix.push(vals.map(cellText));
  });
  return { file: abs, sheet: ws.name, sheets: names, ...toObjects(matrix.filter((r) => r.some((v) => v.trim() !== ""))) };
}
