import { mkdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { env } from "../../config/env.js";
import { AppError } from "../../core/errors/app-error.js";
import { createId } from "../../core/identifiers/uuid.js";

export const MAX_VENDOR_LOGO_BYTES = 2 * 1024 * 1024;

const extensions = new Map([
  ["image/jpeg", ".jpg"],
  ["image/png", ".png"]
]);

function hasValidSignature(buffer, mimeType) {
  if (mimeType === "image/jpeg") return buffer.length >= 3
    && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  if (mimeType === "image/png") return buffer.length >= 8
    && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  return false;
}

function uploadError(code, message, status = 422) {
  return new AppError({ code, message, status });
}

export function createVendorLogoStorage({
  directory = env.vendorLogoDirectory,
  publicBaseUrl = env.apiPublicUrl
} = {}) {
  const absoluteDirectory = path.resolve(directory);
  const publicPrefix = `${publicBaseUrl.replace(/\/$/, "")}/media/vendor-logos/`;

  return Object.freeze({
    directory: absoluteDirectory,

    async store({ buffer, mimeType }) {
      if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
        throw uploadError("VENDOR_LOGO_REQUIRED", "Choose a vendor logo to upload.");
      }
      const normalizedMimeType = String(mimeType || "").split(";")[0].trim().toLowerCase();
      const extension = extensions.get(normalizedMimeType);
      if (!extension) {
        throw uploadError("VENDOR_LOGO_TYPE_INVALID", "Upload a PNG or JPEG vendor logo.");
      }
      if (buffer.length > MAX_VENDOR_LOGO_BYTES) {
        throw uploadError("VENDOR_LOGO_TOO_LARGE", "Vendor logos must be 2 MB or smaller.", 413);
      }
      if (!hasValidSignature(buffer, normalizedMimeType)) {
        throw uploadError("VENDOR_LOGO_CONTENT_INVALID", "The selected file does not contain a valid image.");
      }

      await mkdir(absoluteDirectory, { recursive: true });
      const fileName = `${createId().replaceAll("-", "")}${extension}`;
      await writeFile(path.join(absoluteDirectory, fileName), buffer, { flag: "wx" });
      return { url: `${publicPrefix}${fileName}`, fileName, mimeType: normalizedMimeType,
        byteSize: buffer.length };
    },

    async remove(url) {
      if (typeof url !== "string" || !url.startsWith(publicPrefix)) return false;
      const fileName = url.slice(publicPrefix.length);
      if (!fileName || fileName !== path.basename(fileName)) return false;
      try {
        await unlink(path.join(absoluteDirectory, fileName));
        return true;
      } catch (error) {
        if (error?.code === "ENOENT") return false;
        throw error;
      }
    }
  });
}

export const vendorLogoStorage = createVendorLogoStorage();
