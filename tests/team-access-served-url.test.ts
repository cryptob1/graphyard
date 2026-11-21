import assert from 'node:assert/strict';
import { test } from 'node:test';
import { servedInstall, servedUrl } from './helpers/served-install.js';

test('e2e:team-access-served-url — the loop reads the node and the https serve mapping from tailscale, so Setup and invites carry the served address', async () => {
  const install = await servedInstall('team_access_served');
  try {
    await install.sync();
    const access = (await install.call('/api/team-access')).body;
    assert.equal(access.installUrl, servedUrl);
    assert.doesNotMatch(String(access.guidance), /Tailscale is not serving/, 'Tailscale serves this install');
    const invite = await install.call('/api/invites', { name: 'sam', role: 'viewer' });
    assert.equal(invite.status, 200);
    assert.ok(invite.body.link.startsWith(`${servedUrl}/#sign-in=`), invite.body.link);
    assert.ok(!invite.body.link.includes(`:${install.port}`), 'no unreachable server-port address');

    // Tailscale serves another port only: the warning names this install's own port.
    await install.serve({ 8448: 'http://127.0.0.1:1' });
    await install.sync();
    const unserved = (await install.call('/api/team-access')).body;
    assert.equal(unserved.installUrl, null);
    assert.match(unserved.guidance, new RegExp(`Tailscale is not serving this machine's port ${install.port}\\b`));
  } finally { await install.close(); }
});
