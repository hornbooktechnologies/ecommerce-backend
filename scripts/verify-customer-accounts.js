import assert from "node:assert/strict";
import { getPrimaryPool, closePrimaryPool } from "../src/database/pool-factory.js";
import { createId } from "../src/core/identifiers/uuid.js";
import * as dao from "../src/modules/customer-accounts/customer-accounts.dao.js";
import { createCustomerAccountsService, digest } from "../src/modules/customer-accounts/customer-accounts.service.js";
import { getCustomerDetails } from "../src/modules/customers/customers.dao.js";

const connection = await getPrimaryPool().getConnection();
try {
  const scopedDao = Object.fromEntries(Object.entries(dao).map(([name, fn]) => [name, (input) => fn({ ...input, connection })]));
  const messages = [];
  const service = createCustomerAccountsService({ dao: scopedDao,
    transaction: async (_tenantId, operation) => operation(connection),
    mailer: { ready: () => {}, send: async (mail) => messages.push(mail) } });
  const scope = await service.scope({ tenantCode: "HORNBOOK_RETAIL", storeCode: "MAIN" });
  const email = `account-verification-${createId()}@example.invalid`;
  await connection.beginTransaction();
  await service.register(scope, { email, firstName: "Rollback", lastName: "Verification" });
  assert.equal(await dao.findAccount({ ...scope, email, connection }), null);
  await service.verify(scope, { token: messages[0].token, newPassword: "VerifyAccount-123!" });
  await assert.rejects(service.verify(scope, { token: messages[0].token, newPassword: "VerifyAccount-123!" }), { status: 400 });
  const first = await service.login(scope, { email, password: "VerifyAccount-123!" });
  const second = await service.login(scope, { email, password: "VerifyAccount-123!" });
  await assert.rejects(service.me({ ...scope, tenantId: createId() }, first.sessionToken), { status: 401 });
  const input = { label: "Home", contactName: "Test Customer", line1: "123 Test Street", line2: "", landmark: "", city: "Bengaluru", stateCode: "KA", postalCode: "560001", phone: "+919876543210", isDefault: true };
  const saved = await service.address(scope, first.sessionToken, null, input);
  assert.equal(saved.addresses[0].stateName, "Karnataka");
  await service.address(scope, first.sessionToken, saved.addresses[0].id, { ...input, city: "Mysuru" });
  const admin = await getCustomerDetails({ tenantId: scope.tenantId, customerId: first.customer.id, connection });
  assert.equal(admin.customer.email, email); assert.equal(admin.addresses[0].city, "Mysuru");
  await service.updateProfile(scope, first.sessionToken, { firstName: "Updated", lastName: "Customer", phone: "+919876543210" });
  assert.equal((await service.me(scope, first.sessionToken)).customer.firstName, "Updated");
  await service.changePassword(scope, first.sessionToken, { currentPassword: "VerifyAccount-123!", newPassword: "VerifyAccount-456!" });
  await assert.rejects(service.me(scope, second.sessionToken), { status: 401 });
  await service.forgot(scope, { email });
  await service.reset(scope, { token: messages[1].token, newPassword: "VerifyAccount-789!" });
  await assert.rejects(service.reset(scope, { token: messages[1].token, newPassword: "VerifyAccount-789!" }), { status: 400 });
  const final = await service.login(scope, { email, password: "VerifyAccount-789!" });
  const expired = await service.login(scope, { email, password: "VerifyAccount-789!" });
  await connection.execute("UPDATE customer_sessions SET expires_at = DATE_SUB(UTC_TIMESTAMP(6), INTERVAL 1 SECOND) WHERE token_hash = ?", [digest(expired.sessionToken)]);
  await assert.rejects(service.me(scope, expired.sessionToken), { status: 401 });
  await service.address(scope, final.sessionToken, saved.addresses[0].id, null, true);
  assert.equal((await service.me(scope, final.sessionToken)).addresses.length, 0);
  await service.logout(scope, final.sessionToken);
  await assert.rejects(service.me(scope, final.sessionToken), { status: 401 });
  await connection.rollback();
  assert.equal(await dao.findAccount({ ...scope, email, connection }), null);
  process.stdout.write("PASS: real MariaDB registration, single-use verification/reset, profile, address CRUD, admin visibility, tenant isolation, session revocation and rollback. No emails sent or customer data retained.\n");
} finally { await connection.rollback(); connection.release(); await closePrimaryPool(); }
