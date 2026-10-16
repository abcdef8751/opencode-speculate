/**
 * Database pool.
 * @deprecated use dbPool from ./db2.mjs
 */
// TODO: delete after the migration
export function dbQuery(sql) {
  return { sql };
}
