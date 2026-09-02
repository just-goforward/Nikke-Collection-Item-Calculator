export type WorkerEnv = GeneratedWorkerEnv & {
  ADMIN_TOKEN?: string;
  DEPLOYMENT_SHA?: string;
};
