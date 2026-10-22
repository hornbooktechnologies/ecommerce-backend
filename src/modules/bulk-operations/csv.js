const BOM = /^\uFEFF/;

export function parseCsv(text) {
  const input = String(text || "").replace(BOM, "");
  const records = [];
  let record = [];
  let field = "";
  let quoted = false;

  for (let index = 0; index < input.length; index += 1) {
    const character = input[index];
    if (quoted) {
      if (character === '"' && input[index + 1] === '"') {
        field += '"'; index += 1;
      } else if (character === '"') quoted = false;
      else field += character;
    } else if (character === '"') quoted = true;
    else if (character === ",") { record.push(field); field = ""; }
    else if (character === "\n") {
      record.push(field.replace(/\r$/, ""));
      if (record.some((value) => value.trim() !== "")) records.push(record);
      record = []; field = "";
    } else field += character;
  }
  if (quoted) throw new Error("CSV_QUOTE_UNCLOSED");
  record.push(field.replace(/\r$/, ""));
  if (record.some((value) => value.trim() !== "")) records.push(record);
  if (!records.length) return { headers: [], rows: [] };

  const headers = records[0].map((value) => value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_"));
  if (headers.some((header) => !header) || new Set(headers).size !== headers.length) {
    throw new Error("CSV_HEADERS_INVALID");
  }
  const rows = records.slice(1).map((values, index) => ({
    rowNumber: index + 2,
    data: Object.fromEntries(headers.map((header, column) => [header, (values[column] || "").trim()]))
  }));
  return { headers, rows };
}

function cell(value) {
  const normalized = value === null || value === undefined ? "" : String(value);
  return /[",\r\n]/.test(normalized) ? `"${normalized.replaceAll('"', '""')}"` : normalized;
}

export function stringifyCsv(headers, rows) {
  return [headers, ...rows.map((row) => headers.map((header) => row[header] ?? ""))]
    .map((row) => row.map(cell).join(",")).join("\r\n");
}
