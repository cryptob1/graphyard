export function assertReviewServer(status, repository, app) {
  if (status.githubPermissions?.pull_requests !== 'write' || !['read', 'write'].includes(status.githubPermissions?.issues) || status.githubPermissions?.checks !== 'write') throw new Error('Live installation has not verified Codex dispatch and evidence permissions');
  if (!status.reviewProviders?.includes('codex') || !status.github || typeof status.repository !== 'string' || status.repository.toLowerCase() !== repository.toLowerCase() || status.githubAppId !== app.appId || (app.installationId && status.githubInstallationId !== app.installationId)) throw new Error('Live server does not manage this repository/App installation with Codex review support');
}
