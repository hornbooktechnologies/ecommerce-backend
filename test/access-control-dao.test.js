import assert from "node:assert/strict";
import test from "node:test";
import { listPermissions } from "../src/modules/access-control/access-control.dao.js";

test("permission catalogue maps deterministic binary IDs as opaque identifiers", async () => {
  const id = Buffer.from("ebc3e1519806f2318fa81ccd97c916a6", "hex");
  const connection = {
    async execute() {
      return [[{
        id,
        permission_key: "settings.role.assign",
        module_name: "Access control",
        description: "Assign roles and scopes"
      }]];
    }
  };

  const permissions = await listPermissions({ connection });

  assert.deepEqual(permissions, [{
    id: "ebc3e1519806f2318fa81ccd97c916a6",
    key: "settings.role.assign",
    module: "Access control",
    description: "Assign roles and scopes"
  }]);
});
