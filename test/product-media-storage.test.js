import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createProductMediaStorage } from "../src/modules/catalog/product-media-storage.js";

const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);

test("product media storage writes and removes a managed image", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "commerce-media-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const storage = createProductMediaStorage({ directory, publicBaseUrl: "http://localhost:4000" });

  const stored = await storage.store({ buffer: png, mimeType: "image/png", originalName: "Front view.png" });
  assert.match(stored.url, /^http:\/\/localhost:4000\/media\/product-media\/[a-f0-9]+\.png$/);
  assert.equal(stored.originalName, "Front view.png");
  assert.deepEqual(await readFile(path.join(directory, stored.fileName)), png);
  assert.equal(await storage.remove(stored.url), true);
  assert.equal(await storage.remove(stored.url), false);
});

test("product media storage rejects disguised and unsupported files", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "commerce-media-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const storage = createProductMediaStorage({ directory, publicBaseUrl: "http://localhost:4000" });

  await assert.rejects(() => storage.store({ buffer: Buffer.from("not-an-image"),
    mimeType: "image/png", originalName: "fake.png" }), { code: "PRODUCT_IMAGE_CONTENT_INVALID" });
  await assert.rejects(() => storage.store({ buffer: png,
    mimeType: "image/svg+xml", originalName: "unsafe.svg" }), { code: "PRODUCT_IMAGE_TYPE_INVALID" });
});
