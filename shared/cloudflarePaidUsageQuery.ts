export const CLOUDFLARE_PAID_USAGE_QUERY = `query PaidQuota(
  $accountTag: string!,
  $startDate: Date,
  $endDate: Date,
  $startTimestamp: Time,
  $endTimestamp: Time,
  $runtimeStartTimestamp: Time
) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      d1AnalyticsAdaptiveGroups(
        limit: 10000,
        filter: { date_geq: $startDate, date_leq: $endDate },
        orderBy: [date_DESC]
      ) {
        sum { rowsRead rowsWritten }
        dimensions { date databaseId }
      }
      d1StorageAdaptiveGroups(
        limit: 10000,
        filter: { datetime_geq: $startTimestamp, datetime_leq: $endTimestamp }
      ) {
        max { databaseSizeBytes }
        dimensions { databaseId }
      }
      workersInvocationsAdaptive(
        limit: 10000,
        filter: { datetime_geq: $startTimestamp, datetime_leq: $endTimestamp }
      ) {
        sum { requests errors cpuTimeUs }
        quantiles { cpuTimeP95 cpuTimeP99 }
        dimensions { date scriptName status }
      }
      workerRuntime: workersInvocationsAdaptive(
        limit: 10000,
        filter: { datetime_geq: $runtimeStartTimestamp, datetime_leq: $endTimestamp }
      ) {
        sum { requests errors cpuTimeUs }
        quantiles { cpuTimeP95 cpuTimeP99 }
        dimensions { date scriptName status }
      }
    }
  }
}`;
