import { probeGithubAppWorkflow } from "../forecast-dispatcher/src/github-app";

const result = await probeGithubAppWorkflow({
  appId: requiredEnvironment("FORECAST_GITHUB_APP_ID"),
  installationId: requiredEnvironment("FORECAST_GITHUB_APP_INSTALLATION_ID"),
  privateKey: requiredEnvironment("FORECAST_GITHUB_APP_PRIVATE_KEY"),
});
console.log(JSON.stringify(result));

function requiredEnvironment(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}.`);
  return value;
}
