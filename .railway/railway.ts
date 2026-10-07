import { defineRailway, github, postgres, preserve, project, service, volume } from "railway/iac";

// Neither environment deploys main's tip. Each service tracks a release branch that only
// `graphyard release` moves, to the exact SHA of a release candidate (docs/delivery.md#release-candidates):
// `release/uat` for any candidate under test, `release/production` only for one whose UAT validation passed.
export const releaseBranches = { uat: "release/uat", production: "release/production" } as const;

export default defineRailway(ctx => {
  // UAT runs the candidate against its own Postgres (each Railway environment has its own instance)
  // and without the GitHub App: with no GITHUB_* variable it holds no credential that can write to
  // the production repository, so it never merges, dispatches or spends the App's request budget.
  const uat = ctx.isEnvironment("uat");
  // Each environment keeps the database and volume it was created with; UAT's carry Railway's generated suffixes.
  const Postgres = postgres(uat ? "Postgres-B0rl" : "Postgres", { region: uat ? "sfo" : "us-west2" });
  if (!uat) Postgres.networking = { privateNetworkEndpoint: "postgres" };
  const postgresVolume = volume(uat ? "postgres-volume-MrSK" : "postgres-volume", { alerts: { usage: { "100": {}, "80": {}, "95": {} } }, allowOnlineResize: true, region: uat ? "sfo" : "us-west2", sizeMB: uat ? 50000 : 20000 });
  const graphyard = service("graphyard", {
    source: github("cryptob1/graphyard", { branch: uat ? releaseBranches.uat : releaseBranches.production }),
    build: { builder: "DOCKERFILE", dockerfilePath: "Dockerfile" },
    healthcheck: "/healthz",
    healthcheckTimeout: 120,
    deploy: { restartPolicyType: "ON_FAILURE", restartPolicyMaxRetries: 10 },
    replicas: { "us-west2": 1 },
    // Every variable an adapter or the operator sets by hand is declared so applying this
    // configuration keeps it. The capacity variables are written by scripts/provision-railway.mjs
    // and scripts/configure-integrations.mjs from the deployed principal set (docs/deployment.md,
    // Delegation capacity variables); the same adapters write GRAPHYARD_GENERATED_FILES from the
    // repository's generated-file manifest, and dropping it would make the regression guard treat
    // every generated page as owned work; RAILWAY_API_TOKEN lets the control plane observe deployments, and
    // GRAPHYARD_PRODUCTION_ENVIRONMENT names the environment it reads them under (`graphyard / production` here,
    // the install's run field productionEnvironment; docs/deployment.md#production-environment-name).
    env: uat
      ? { DATABASE_URL: preserve(), GRAPHYARD_PRINCIPALS: preserve(), HOST: preserve(), PORT: preserve(), GRAPHYARD_GENERATED_FILES: preserve() }
      : { DATABASE_URL: preserve(), GITHUB_REPOSITORY: preserve(), GRAPHYARD_PRINCIPALS: preserve(), HOST: preserve(), PORT: preserve(),
        GITHUB_APP_ID: preserve(), GITHUB_INSTALLATION_ID: preserve(), GITHUB_PRIVATE_KEY: preserve(), GITHUB_WEBHOOK_SECRET: preserve(),
        GRAPHYARD_MAX_SLICE_LEADS: preserve(), GRAPHYARD_MAX_ENGINEERS_PER_LEAD: preserve(), GRAPHYARD_MIN_REVIEWERS: preserve(), GRAPHYARD_MAX_REVIEWERS: preserve(), GRAPHYARD_GENERATED_FILES: preserve(),
        RAILWAY_API_TOKEN: preserve(), GRAPHYARD_PRODUCTION_ENVIRONMENT: preserve(), GRAPHYARD_DIRECT_MERGE_SINCE: preserve(),
        GRAPHYARD_REVERT_APPROVER_APP_ID: preserve(), GRAPHYARD_REVERT_APPROVER_INSTALLATION_ID: preserve(), GRAPHYARD_REVERT_APPROVER_PRIVATE_KEY: preserve(),
        GRAPHYARD_DATABASE_MAX_BYTES: preserve(), GRAPHYARD_DATABASE_POOL_SIZE: preserve(), GRAPHYARD_ESCALATION_CONTEXT_BUDGET: preserve(),
        GRAPHYARD_OBSERVATION_CONCURRENCY: preserve(), GRAPHYARD_RECONCILE_BATCH_MS: preserve(), RAILWAY_HEALTHCHECK_TIMEOUT_SEC: preserve() },
  });

  return project("graphyard", {
    resources: [Postgres, graphyard, postgresVolume],
  });
});
