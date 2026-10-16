/**
 * Session token helpers.
 */
// TODO: support refresh tokens
export function authToken(user) {
  return `token:${user}`;
}
