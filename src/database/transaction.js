import { getPoolForTenant } from "./shard-router.js";

export async function withTransaction(tenantId, operation) {
  const pool = getPoolForTenant(tenantId);
  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();
    const result = await operation(connection);
    await connection.commit();
    return result;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}
