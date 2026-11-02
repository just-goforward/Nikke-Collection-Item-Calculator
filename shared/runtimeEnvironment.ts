export const STAGING_RUNTIME_QUERY_KEY = "statsEnv" as const;
export const STAGING_RUNTIME_QUERY_VALUE = "staging" as const;
export const STAGING_RUNTIME_SEARCH =
  `?${STAGING_RUNTIME_QUERY_KEY}=${STAGING_RUNTIME_QUERY_VALUE}` as const;
