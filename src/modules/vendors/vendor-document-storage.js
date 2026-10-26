import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { env } from "../../config/env.js";
import { AppError } from "../../core/errors/app-error.js";
import { createId } from "../../core/identifiers/uuid.js";

export const MAX_VENDOR_DOCUMENT_BYTES = 10 * 1024 * 1024;

const formats = new Map([
  ["application/pdf", { extension: ".pdf", signature: (buffer) => buffer.subarray(0, 5).toString("ascii") === "%PDF-" }],
  ["image/jpeg", { extension: ".jpg", signature: (buffer) => buffer.length >= 3
    && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff }],
  ["image/png", { extension: ".png", signature: (buffer) => buffer.length >= 8
    && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) }]
]);

const mimeByExtension = new Map([...formats].map(([mimeType, value]) => [value.extension, mimeType]));

function fail(code, message, status = 422) {
  throw new AppError({ code, message, status });
}

function cleanOriginalName(value = "vendor-document") {
  const name = path.basename(value).replace(/[^a-zA-Z0-9._ -]+/g, "-").trim();
  return (name || "vendor-document").slice(0, 255);
}

export function createVendorDocumentStorage({ directory = env.vendorDocumentDirectory } = {}) {
  const absoluteDirectory = path.resolve(directory);

  return Object.freeze({
    directory: absoluteDirectory,

    async store({ buffer, mimeType, originalName }) {
      if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
        fail("VENDOR_DOCUMENT_REQUIRED", "Choose a KYC document to upload.");
      }
      const normalizedMimeType = String(mimeType || "").split(";")[0].trim().toLowerCase();
      const format = formats.get(normalizedMimeType);
      if (!format) fail("VENDOR_DOCUMENT_TYPE_INVALID", "Upload a PDF, PNG or JPEG document.");
      if (buffer.length > MAX_VENDOR_DOCUMENT_BYTES) {
        fail("VENDOR_DOCUMENT_TOO_LARGE", "Vendor documents must be 10 MB or smaller.", 413);
      }
      if (!format.signature(buffer)) {
        fail("VENDOR_DOCUMENT_CONTENT_INVALID", "The selected file does not contain a valid document.");
      }
      await mkdir(absoluteDirectory, { recursive: true });
      const fileKey = `${createId().replaceAll("-", "")}${format.extension}`;
      await writeFile(path.join(absoluteDirectory, fileKey), buffer, { flag: "wx" });
      return { fileKey, originalName: cleanOriginalName(originalName), mimeType: normalizedMimeType,
        byteSize: buffer.length };
    },

    async read(fileKey) {
      if (!fileKey || fileKey !== path.basename(fileKey)) {
        fail("VENDOR_DOCUMENT_FILE_INVALID", "The document file reference is invalid.", 404);
      }
      try {
        return { buffer: await readFile(path.join(absoluteDirectory, fileKey)),
          mimeType: mimeByExtension.get(path.extname(fileKey).toLowerCase()) || "application/octet-stream" };
      } catch (error) {
        if (error?.code === "ENOENT") fail("VENDOR_DOCUMENT_FILE_NOT_FOUND", "The document file is unavailable.", 404);
        throw error;
      }
    },

    async remove(fileKey) {
      if (!fileKey || fileKey !== path.basename(fileKey)) return false;
      try {
        await unlink(path.join(absoluteDirectory, fileKey));
        return true;
      } catch (error) {
        if (error?.code === "ENOENT") return false;
        throw error;
      }
    }
  });
}

export const vendorDocumentStorage = createVendorDocumentStorage();
