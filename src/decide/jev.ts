/**
 * @deprecated — the backend is now provider-neutral (`./systemone`). These aliases exist so the
 * frozen §1 contract names (`createJevJudge`, `DEFAULT_JEV_*`) and the vendored call sites keep
 * working; new code should import from `./systemone`.
 */

export {
  createSystemOneJudge as createJevJudge,
  DEFAULT_SYSTEMONE_BASE_URL as DEFAULT_JEV_BASE_URL,
  DEFAULT_SYSTEMONE_MODEL as DEFAULT_JEV_MODEL,
  DEFAULT_SYSTEMONE_TIMEOUT_MS as DEFAULT_JEV_TIMEOUT_MS,
  SYSTEMONE_USER_AGENT as JEV_USER_AGENT,
} from "./systemone"
export type { CreateSystemOneJudgeOptions as CreateJevJudgeOptions } from "./systemone"
