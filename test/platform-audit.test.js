import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import request from "supertest";
import { createAccessToken } from "../src/core/security/tokens.js";
import { createPlatformAuditRouter } from "../src/modules/platform-audit/platform-audit.routes.js";
import { projectEvent, listAuditEvents } from "../src/modules/platform-audit/platform-audit.dao.js";
import { buildUiConfiguration } from "../src/modules/auth/ui-configuration.js";

const ids = { userId:"018f47f2-6b6d-7c34-ae31-8f4f17b79b77", sessionId:"018f47f2-6b6d-7c34-ae31-8f4f17b79b99" };
const auth = "Bearer " + createAccessToken(ids);
function fixture({ permitted = true, active = true } = {}) {
  const app = express();
  app.use(createPlatformAuditRouter({
    authorize: permission => { assert.equal(permission,"platform.audit.read");
      return (_req,res,next) => permitted ? next() : res.sendStatus(403); },
    session: async actor => active && actor.sessionId === ids.sessionId,
    list: async filters => ({ ...filters, items:[], total:0 })
  }));
  app.use((err,_req,res,_next) => res.status(err.status || err.statusCode || 500).json({code:err.code}));
  return app;
}
test("audit GET requires authentication, explicit platform permission, and an active session", async () => {
  await request(fixture()).get("/").expect(401);
  await request(fixture({permitted:false})).get("/").set("Authorization",auth).expect(403);
  await request(fixture({active:false})).get("/").set("Authorization",auth).expect(401);
  const r = await request(fixture()).get("/").set("Authorization",auth).expect(200);
  assert.equal(r.body.data.pageSize,10); assert.match(r.headers["cache-control"],/no-store/);
  await request(fixture()).get("/?pageSize=1000").set("Authorization",auth).expect(422);
});
test("tenant-level audit permission never unlocks platform navigation", () => {
  const links = (roleLevel,permissions) => buildUiConfiguration([{roleLevel,roleKey:"custom",tenantId:"t",permissions}]).navigation.platform.map(i=>i.href);
  assert.ok(!links("TENANT",["audit.read","platform.audit.read"]).includes("/platform/audit-log"));
  assert.ok(!links("PLATFORM",["platform.tenant.read"]).includes("/platform/audit-log"));
  assert.ok(links("PLATFORM",["platform.audit.read"]).includes("/platform/audit-log"));
});
test("projection exposes only approved changed fields, not email, metadata or raw snapshots", () => {
  const row = {id:Buffer.from(ids.sessionId.replaceAll("-",""),"hex"),entity_id:Buffer.from(ids.userId.replaceAll("-",""),"hex"),entity_type:"PLATFORM_USER",
    before_data:'{"status":"INVITED"}',after_data:{status:"ACTIVE",email:"private",password:"private"},
    actor_name:"Operator",target_name:"Member",metadata:{reason:"private"},ip_address:"private"};
  const event = projectEvent(row);
  assert.deepEqual(event.changes,[{field:"status",from:"INVITED",to:"ACTIVE"}]);
  assert.ok(!JSON.stringify(event).includes("private"));
});
test("both queries restrict event scope and bind filters; pagination resolves out-of-range pages", async () => {
  const calls=[];
  const db={execute:async (sql,args)=>{calls.push({sql,args});return calls.length===1?[[{total:11}]]:[[]];}};
  const result=await listAuditEvents({page:10,pageSize:10,area:"TENANT",search:"x%_"},db);
  assert.equal(result.page,2);
  for (const {sql,args} of calls) {
    assert.match(sql,/a.tenant_id=a.entity_id/); assert.match(sql,/a.tenant_id IS NULL/);
    assert.ok(args.includes("x%_")); assert.ok(!sql.includes("x%_"));
  }
  assert.match(calls[1].sql,/occurred_at DESC,a.id DESC/);
  assert.deepEqual(calls[1].args.slice(-2),[10,10]);
});
