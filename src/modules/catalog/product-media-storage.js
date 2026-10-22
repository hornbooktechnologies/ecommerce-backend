import { mkdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { AppError } from "../../core/errors/app-error.js";
import { createId } from "../../core/identifiers/uuid.js";
import { env } from "../../config/env.js";

export const MAX_PRODUCT_IMAGE_BYTES = 8 * 1024 * 1024;

const extensions = new Map([
  ["image/jpeg", ".jpg"],
  ["image/png", ".png"],
  ["image/webp", ".webp"],
  ["image/avif", ".avif"]
]);

function hasValidSignature(buffer, mimeType) {
  if (mimeType === "image/jpeg") return buffer.length >= 3
    && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  if (mimeType === "image/png") return buffer.length >= 8
    && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (mimeType === "image/webp") return buffer.length >= 12
    && buffer.subarray(0, 4).toString("ascii") === "RIFF"
    && buffer.subarray(8, 12).toString("ascii") === "WEBP";
  if (mimeType === "image/avif") return buffer.length >= 12
    && buffer.subarray(4, 8).toString("ascii") === "ftyp"
    && ["avif", "avis"].includes(buffer.subarray(8, 12).toString("ascii"));
  return false;
}

function uploadError(code, message, status = 422) {
  return new AppError({ code, message, status });
}

function cleanOriginalName(value = "product-image") {
  const name = path.basename(value).replace(/[^a-zA-Z0-9._ -]+/g, "-").trim();
  return (name || "product-image").slice(0, 255);
}

export function createProductMediaStorage({
  directory = env.productMediaDirectory,
  publicBaseUrl = env.apiPublicUrl
} = {}) {
  const absoluteDirectory = path.resolve(directory);
  const publicPrefix = `${publicBaseUrl.replace(/\/$/, "")}/media/product-media/`;

  return Object.freeze({
    directory: absoluteDirectory,

    async store({ buffer, mimeType, originalName }) {
      if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
        throw uploadError("PRODUCT_IMAGE_REQUIRED", "Choose an image file to upload.");
      }
      const normalizedMimeType = String(mimeType || "").split(";")[0].trim().toLowerCase();
      const extension = extensions.get(normalizedMimeType);
      if (!extension) {
        throw uploadError("PRODUCT_IMAGE_TYPE_INVALID", "Upload a JPEG, PNG, WebP or AVIF image.");
      }
      if (buffer.length > MAX_PRODUCT_IMAGE_BYTES) {
        throw uploadError("PRODUCT_IMAGE_TOO_LARGE", "Product images must be 8 MB or smaller.", 413);
      }
      if (!hasValidSignature(buffer, normalizedMimeType)) {
        throw uploadError("PRODUCT_IMAGE_CONTENT_INVALID", "The selected file does not contain a valid image.");
      }

      await mkdir(absoluteDirectory, { recursive: true });
      const fileName = `${createId().replaceAll("-", "")}${extension}`;
      await writeFile(path.join(absoluteDirectory, fileName), buffer, { flag: "wx" });
      return {
        url: `${publicPrefix}${fileName}`,
        fileName,
        originalName: cleanOriginalName(originalName),
        mimeType: normalizedMimeType,
        byteSize: buffer.length
      };
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

export const productMediaStorage = createProductMediaStorage();
