import { defineRailway, postgres, preserve, project, service, volume } from "railway/iac";

export default defineRailway(() => {
  const Postgres = postgres("Postgres", { region: "us-west2" });
  Postgres.networking = { privateNetworkEndpoint: "postgres" };
  const postgresVolume = volume("postgres-volume", { alerts: { usage: { "100": {}, "80": {}, "95": {} } }, allowOnlineResize: true, region: "us-west2", sizeMB: 5000 });
  const graphyard = service("graphyard", {
    build: { builder: "DOCKERFILE", dockerfilePath: "Dockerfile" },
    healthcheck: "/healthz",
    healthcheckTimeout: 120,
    deploy: { restartPolicyType: "ON_FAILURE", restartPolicyMaxRetries: 10 },
    replicas: { "us-west2": 1 },
    env: { DATABASE_URL: preserve(), GITHUB_REPOSITORY: preserve(), GRAPHYARD_PRINCIPALS: preserve(), HOST: preserve(), PORT: preserve() },
  });

  return project("graphyard", {
    resources: [Postgres, graphyard, postgresVolume],
  });
});
