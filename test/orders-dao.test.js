import assert from "node:assert/strict";
import test from "node:test";
import { nextDocumentNumber } from "../src/modules/orders/orders.dao.js";

test("document numbering does not duplicate a configured trailing separator", async () => {
  const calls = [];
  const connection = {
    async execute(sql, parameters) {
      calls.push({ sql, parameters });
      if (sql.startsWith("SELECT")) return [[{
        id: Buffer.alloc(16), prefix: "STORE-ORD-", next_number: 12, number_padding: 6
      }]];
      return [{ affectedRows: 1 }];
    }
  };
  const value = await nextDocumentNumber({
    tenantId: "018f47f2-6b6d-7c34-ae31-8f4f17b79b88",
    storeId: "018f47f2-6b6d-7c34-ae31-8f4f17b79b89",
    type: "ORDER", connection
  });
  assert.equal(value, "STORE-ORD-000012");
  assert.equal(calls.length, 2);
});

test("document numbering adds a separator when the prefix has none", async () => {
  const connection = {
    async execute(sql) {
      if (sql.startsWith("SELECT")) return [[{
        id: Buffer.alloc(16), prefix: "ORDER", next_number: 7, number_padding: 4
      }]];
      return [{ affectedRows: 1 }];
    }
  };
  const value = await nextDocumentNumber({
    tenantId: "018f47f2-6b6d-7c34-ae31-8f4f17b79b88",
    storeId: "018f47f2-6b6d-7c34-ae31-8f4f17b79b89",
    type: "ORDER", connection
  });
  assert.equal(value, "ORDER-0007");
});
