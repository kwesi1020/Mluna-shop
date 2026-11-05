'use strict';

const fs = require('node:fs');
const { test, before, after, beforeEach } = require('node:test');
const path = require('node:path');
const {
  initializeTestEnvironment,
  assertSucceeds,
  assertFails
} = require('@firebase/rules-unit-testing');
const {
  collection,
  deleteDoc,
  doc,
  getDoc,
  setDoc,
  updateDoc
} = require('firebase/firestore');

const PROJECT_ID = 'mluna-fab51-rules-test';
let testEnv;

before(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: {
      rules: fs.readFileSync(path.join(__dirname, '..', 'firestore.rules'), 'utf8')
    }
  });

  await testEnv.withSecurityRulesDisabled(async context => {
    const db = context.firestore();
    await setDoc(doc(db, 'reviews', 'approved-seed'), {
      status: 'approved',
      rating: 5,
      comment: 'Approved seed'
    });
    await setDoc(doc(db, 'reviews', 'pending-seed'), {
      status: 'pending',
      rating: 5,
      comment: 'Pending seed'
    });
    await setDoc(doc(db, 'orders', 'private-seed'), { status: 'pending' });
    await setDoc(doc(db, 'leads', 'private-seed'), { source: 'test' });
    await setDoc(doc(db, 'debtors', 'private-seed'), { name: 'Test debtor' });
    await setDoc(doc(db, 'suppliers', 'private-seed'), { name: 'Test supplier' });
    await setDoc(doc(db, 'purchaseOrders', 'private-seed'), { status: 'draft' });
    await setDoc(doc(db, 'products', 'public-seed'), { name: 'Public product' });
  });
});

after(async () => {
  if (testEnv) await testEnv.cleanup();
});

beforeEach(async () => {
  await testEnv.clearFirestore();
  await testEnv.withSecurityRulesDisabled(async context => {
    const db = context.firestore();
    await setDoc(doc(db, 'reviews', 'approved-seed'), { status: 'approved' });
    await setDoc(doc(db, 'reviews', 'pending-seed'), { status: 'pending' });
    for (const collectionName of [
      'orders', 'leads', 'debtors', 'suppliers', 'purchaseOrders'
    ]) {
      await setDoc(doc(db, collectionName, 'private-seed'), { status: 'pending' });
    }
    await setDoc(doc(db, 'products', 'public-seed'), { name: 'Public product' });
  });
});

test('public visitors can read products, but cannot create or modify catalog products', async () => {
  const db = testEnv.unauthenticatedContext().firestore();
  await assertSucceeds(getDoc(doc(db, 'products', 'public-seed')));
  await assertFails(setDoc(doc(db, 'products', 'visitor-write'), { name: 'Forged' }));
  await assertFails(updateDoc(doc(db, 'products', 'public-seed'), { name: 'Changed' }));
  await assertFails(deleteDoc(doc(db, 'products', 'public-seed')));
});

test('ordinary authenticated users can read products but cannot write them', async () => {
  const db = testEnv.authenticatedContext('ordinary-user').firestore();
  await assertSucceeds(getDoc(doc(db, 'products', 'public-seed')));
  await assertFails(setDoc(doc(db, 'products', 'ordinary-write'), { name: 'Forbidden' }));
});

test('administrator can create, read, update and delete every protected collection', async () => {
  const db = testEnv.authenticatedContext('admin-user', { admin: true }).firestore();
  const protectedCollections = [
    'products', 'orders', 'leads', 'reviews',
    'debtors', 'suppliers', 'purchaseOrders'
  ];

  for (const collectionName of protectedCollections) {
    const reference = doc(db, collectionName, 'admin-write');
    await assertSucceeds(setDoc(reference, { status: 'created' }));
    await assertSucceeds(getDoc(reference));
    await assertSucceeds(updateDoc(reference, { status: 'updated' }));
    await assertSucceeds(deleteDoc(reference));
  }

  for (const collectionName of [
    'orders', 'leads', 'debtors', 'suppliers', 'purchaseOrders'
  ]) {
    await assertSucceeds(getDoc(doc(db, collectionName, 'private-seed')));
  }
  await assertSucceeds(getDoc(doc(db, 'reviews', 'pending-seed')));
});

test('ordinary authenticated users cannot read or manage protected business data', async () => {
  const db = testEnv.authenticatedContext('ordinary-user').firestore();

  for (const collectionName of [
    'orders', 'leads', 'debtors', 'suppliers', 'purchaseOrders'
  ]) {
    await assertFails(getDoc(doc(db, collectionName, 'private-seed')));
    await assertFails(setDoc(doc(db, collectionName, 'forbidden-write'), { status: 'x' }));
  }

  await assertFails(getDoc(doc(db, 'reviews', 'pending-seed')));
  await assertFails(updateDoc(doc(db, 'reviews', 'approved-seed'), { status: 'pending' }));
  await assertFails(deleteDoc(doc(db, 'reviews', 'approved-seed')));
});

test('signed-out visitors cannot read or manage protected business data', async () => {
  const db = testEnv.unauthenticatedContext().firestore();

  for (const collectionName of [
    'orders', 'leads', 'debtors', 'suppliers', 'purchaseOrders'
  ]) {
    await assertFails(getDoc(doc(db, collectionName, 'private-seed')));
    await assertFails(setDoc(doc(db, collectionName, 'forbidden-write'), { status: 'x' }));
  }

  await assertFails(getDoc(doc(db, 'reviews', 'pending-seed')));
  await assertFails(updateDoc(doc(db, 'reviews', 'approved-seed'), { status: 'pending' }));
});

test('public checkout, lead and review submissions remain available', async () => {
  const db = testEnv.unauthenticatedContext().firestore();

  await assertSucceeds(setDoc(doc(db, 'orders', 'public-order'), {
    status: 'pending',
    total: 100
  }));
  await assertSucceeds(setDoc(doc(db, 'leads', 'public-lead'), {
    source: 'newsletter'
  }));
  await assertSucceeds(setDoc(doc(db, 'reviews', 'public-review'), {
    status: 'pending',
    rating: 5,
    comment: 'New review'
  }));

  await assertFails(getDoc(doc(db, 'orders', 'public-order')));
  await assertFails(getDoc(doc(db, 'leads', 'public-lead')));
  await assertFails(getDoc(doc(db, 'reviews', 'public-review')));
});

test('only approved reviews are publicly readable', async () => {
  const db = testEnv.unauthenticatedContext().firestore();
  await assertSucceeds(getDoc(doc(db, 'reviews', 'approved-seed')));
  await assertFails(getDoc(doc(db, 'reviews', 'pending-seed')));
});
