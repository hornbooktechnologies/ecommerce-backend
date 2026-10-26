import Joi from "joi";
import { env } from "../../config/env.js";
import { logger } from "../../config/logger.js";
import { closePrimaryPool } from "../pool-factory.js";
import { withTransaction } from "../transaction.js";
import { bufferToUuid, createId, uuidToBuffer } from "../../core/identifiers/uuid.js";
import { hashPassword } from "../../core/security/password.js";

const inputSchema = Joi.object({
  PLATFORM_ADMIN_EMAIL: Joi.string().email().max(254).required(),
  PLATFORM_ADMIN_PASSWORD: Joi.string().min(12).max(200).required(),
  PLATFORM_ADMIN_FIRST_NAME: Joi.string().trim().max(100).required(),
  PLATFORM_ADMIN_LAST_NAME: Joi.string().trim().max(100).allow("").default("")
}).unknown(true);

async function seed() {
  const { value, error } = inputSchema.validate(process.env, { abortEarly: false });
  if (error) {
    throw new Error(`Invalid platform administrator seed input: ${error.message}`);
  }

  const email = value.PLATFORM_ADMIN_EMAIL.trim().toLowerCase();
  const result = await withTransaction(null, async (connection) => {
    const [roleRows] = await connection.execute(
      `SELECT id
         FROM roles
        WHERE tenant_id IS NULL
          AND role_key = 'platform_super_admin'
          AND deleted_at IS NULL
        LIMIT 1`
    );

    let roleId = roleRows[0]?.id;
    if (!roleId) {
      const roleUuid = createId();
      roleId = uuidToBuffer(roleUuid);
      await connection.execute(
        `INSERT INTO roles (id, tenant_id, role_key, name, role_level, is_system)
         VALUES (?, NULL, 'platform_super_admin', 'Platform super administrator', 'PLATFORM', 1)`,
        [roleId]
      );
    }

    const [userRows] = await connection.execute(
      `SELECT id FROM users WHERE email = ? AND deleted_at IS NULL LIMIT 1`,
      [email]
    );

    let userId = userRows[0]?.id;
    let created = false;
    if (!userId) {
      userId = uuidToBuffer(createId());
      const passwordHash = await hashPassword(value.PLATFORM_ADMIN_PASSWORD);
      await connection.execute(
        `INSERT INTO users (
           id, email, password_hash, first_name, last_name, status,
           email_verified_at, password_changed_at
         ) VALUES (?, ?, ?, ?, ?, 'ACTIVE', UTC_TIMESTAMP(6), UTC_TIMESTAMP(6))`,
        [
          userId,
          email,
          passwordHash,
          value.PLATFORM_ADMIN_FIRST_NAME,
          value.PLATFORM_ADMIN_LAST_NAME || null
        ]
      );
      created = true;
    }

    const [assignmentRows] = await connection.execute(
      `SELECT id
         FROM user_role_assignments
        WHERE user_id = ?
          AND role_id = ?
          AND scope_type = 'PLATFORM'
          AND scope_id IS NULL
          AND revoked_at IS NULL
        LIMIT 1`,
      [userId, roleId]
    );

    if (!assignmentRows[0]) {
      await connection.execute(
        `INSERT INTO user_role_assignments (
           id, user_id, tenant_id, role_id, scope_type, scope_id, assigned_by
         ) VALUES (?, ?, NULL, ?, 'PLATFORM', NULL, ?)`,
        [uuidToBuffer(createId()), userId, roleId, userId]
      );
    }

    await connection.execute(
      `INSERT INTO platform_memberships (user_id, status, invited_by, invited_at, joined_at)
       VALUES (?, 'ACTIVE', ?, UTC_TIMESTAMP(6), UTC_TIMESTAMP(6))
       ON DUPLICATE KEY UPDATE status = 'ACTIVE', joined_at = COALESCE(joined_at, UTC_TIMESTAMP(6))`,
      [userId, userId]
    );

    return { created, userId: bufferToUuid(userId) };
  });

  logger.info(
    { created: result.created, userId: result.userId, environment: env.nodeEnv },
    result.created ? "Platform administrator created" : "Platform administrator already exists"
  );
}

seed()
  .catch((error) => {
    logger.fatal({ error }, "Platform administrator seed failed");
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePrimaryPool();
  });
