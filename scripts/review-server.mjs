export function assertReviewServer(status, repository, app) {
  if (!status.reviewProviders?.includes('codex') || !status.github || status.repository !== repository || status.githubAppId !== app.appId || (app.installationId && status.githubInstallationId !== app.installationId)) throw new Error('Live server does not manage this repository/App installation with Codex review support');
}
