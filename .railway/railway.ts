import { defineRailway, github, postgres, preserve, project, service, volume } from "railway/iac";

export default defineRailway(() => {
  const Postgres = postgres("Postgres", { region: "us-west2" });
  Postgres.networking = { privateNetworkEndpoint: "postgres" };
  const postgresVolume = volume("postgres-volume", { alerts: { usage: { "100": {}, "80": {}, "95": {} } }, allowOnlineResize: true, region: "us-west2", sizeMB: 5000 });
  const graphyard = service("graphyard", {
    source: github("cryptob1/graphyard", { branch: "main" }),
    build: { builder: "DOCKERFILE", dockerfilePath: "Dockerfile" },
    healthcheck: "/healthz",
    healthcheckTimeout: 120,
    deploy: { restartPolicyType: "ON_FAILURE", restartPolicyMaxRetries: 10 },
    replicas: { "us-west2": 1 },
    // Every variable an adapter or the operator sets by hand is declared so applying this
    // configuration keeps it. The capacity variables are written by scripts/provision-railway.mjs
    // and scripts/configure-integrations.mjs from the deployed principal set (docs/deployment.md,
    // Delegation capacity variables); RAILWAY_API_TOKEN lets the control plane observe deployments.
    env: { DATABASE_URL: preserve(), GITHUB_REPOSITORY: preserve(), GRAPHYARD_PRINCIPALS: preserve(), HOST: preserve(), PORT: preserve(),
      GITHUB_APP_ID: preserve(), GITHUB_INSTALLATION_ID: preserve(), GITHUB_PRIVATE_KEY: preserve(), GITHUB_WEBHOOK_SECRET: preserve(),
      GRAPHYARD_MAX_SLICE_LEADS: preserve(), GRAPHYARD_MAX_ENGINEERS_PER_LEAD: preserve(), GRAPHYARD_MIN_REVIEWERS: preserve(), GRAPHYARD_MAX_REVIEWERS: preserve(),
      RAILWAY_API_TOKEN: preserve() },
  });

  return project("graphyard", {
    resources: [Postgres, graphyard, postgresVolume],
  });
});
