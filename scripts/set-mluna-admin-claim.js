'use strict';

/*
 * One-time MLuna administrator custom-claim provisioning.
 *
 * Run only from a trusted machine with GOOGLE_APPLICATION_CREDENTIALS
 * pointing to a service-account key for project maluna-fab51.
 * Never expose the service-account key or this script through a public API.
 */

const { initializeApp, applicationDefault } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');

const PROJECT_ID = 'maluna-fab51';
const ADMIN_UID = 'ox0mUbjbv9QFIKQO8JdqAqJ68uN2';
const ADMIN_EMAIL = 'mawuenaagbogah0@gmail.com';

async function main() {
  initializeApp({
    credential: applicationDefault(),
    projectId: PROJECT_ID
  });

  const auth = getAuth();
  const user = await auth.getUser(ADMIN_UID);

  if (!user.email || user.email.toLowerCase() !== ADMIN_EMAIL) {
    throw new Error(
      'Refusing to grant admin claim: UID does not resolve to the expected email.'
    );
  }

  await auth.setCustomUserClaims(ADMIN_UID, {
    ...(user.customClaims || {}),
    admin: true
  });

  await auth.revokeRefreshTokens(ADMIN_UID);

  console.log('Admin claim assigned to the verified MLuna administrator.');
  console.log('The administrator must sign in again to receive the refreshed claim.');
}

main().catch(error => {
  console.error('Admin claim provisioning failed:', error.message);
  process.exitCode = 1;
});
