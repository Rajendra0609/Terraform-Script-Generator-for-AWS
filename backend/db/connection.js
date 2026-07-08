const { Pool } = require('pg');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});
pool.on('error', (err) => console.error('PG pool error:', err));

/**
 * Run `fn` inside a BEGIN/COMMIT transaction on a single checked-out client,
 * rolling back on any thrown error. Needed anywhere a read-then-write
 * sequence must be atomic across statements — pool.query() alone gives no
 * such guarantee, since each call may run on a different pooled connection.
 *
 * Added for the C-11 fix (backend/routes/auth.js): the first-user/admin
 * check-then-insert was previously two separate pool.query() calls with no
 * transaction or locking, making it a straightforward TOCTOU race.
 *
 * @param {(client: import('pg').PoolClient) => Promise<T>} fn
 * @returns {Promise<T>}
 */
async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = pool;
module.exports.withTransaction = withTransaction;
