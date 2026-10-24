'use strict';
/*
 * Regression tests for lib/import-safety.js (Phase 2 import safety remediation)
 * and for the Phase 2.1 write-containment in admin.html.
 * UNEXECUTED — NOT APPROVED FOR LIVE IMPORT. These tests have never been run.
 * Run (Node >= 18):  npm run check && npm test
 *
 * The fake Firestore verifies how OUR code uses transactions; it does not prove real Firestore behavior.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const IS = require('../lib/import-safety.js');
const { FakeFirestore } = require('./helpers/fake-firestore.js');

// ---------- fixtures ----------
const SUPPLIER_NAME = 'Jinzhou Wangdihao Towel Factory';
const SUPPLIER_DEF = Object.freeze({ key: 'jinzhou', name: SUPPLIER_NAME, platform: '1688 / Alibaba', phone: '', categorySupplied: 'Home Textiles', notes: '' });
const ITEM = Object.freeze(Object.assign({}, IS.CONFIRMED_SINGLE_SKU_VALUES['ML-TWL-003']));
const CTX = Object.freeze({ batchId: 'workbook-batch1-44skus', suppliers: [SUPPLIER_DEF], now: () => 1760000000000 });
const SUP_ID = 'sup-1';

function newDb(opts){
  const db = new FakeFirestore();
  if(!opts || opts.supplier !== false){
    db.seed('suppliers', SUP_ID, { name: SUPPLIER_NAME, platform: '1688 / Alibaba', phone: '', categorySupplied: 'Home Textiles', notes: '', createdAt: 1 });
  }
  return db;
}
function productDoc(over){
  return Object.assign({
    category: 'home', n: ITEM.n, note: ITEM.note, price: 74, old: 74, costPrice: 37.17, isFreeGift: false,
    wholesalePrice: 56, landedCost: null, poUnitCost: null, images: [], variants: [], optionGroups: [], comboStock: {},
    status: 'in_stock', quantity: 1, sku: 'ML-TWL-003', reorderLevel: 5, incomingStock: 0, stockVerified: true,
    auditNote: null, supplierRef: SUP_ID, priceStatus: 'priced', importedFromWorkbook: true,
    importBatchId: CTX.batchId, archived: false, sortOrder: 1
  }, over || {});
}
function poDoc(over){
  return Object.assign({
    poNumber: 'ML-PO-007', date: 1, supplierRef: SUP_ID, supplierName: SUPPLIER_NAME, sku: 'ML-TWL-003',
    productName: ITEM.n, productRef: 'ML-TWL-003', qty: 1, unitCost: 37.17, totalCost: 37.17,
    paymentStatus: 'paid', orderStatus: 'unknown', warehouseArrivalDate: null, notes: 'seed',
    excludeFromInventory: false, dateValidationStatus: 'unknown', dateValidationNote: '',
    importBatchId: CTX.batchId, createdAt: 1
  }, over || {});
}
function flagCodes(result){ return (result.flags || []).map(f => f.code); }
function assertNoNullSupplierRefs(db){
  ['products', 'purchaseOrders'].forEach(col => {
    Object.entries(db.dump(col)).forEach(([id, d]) => {
      assert.ok(typeof d.supplierRef === 'string' && d.supplierRef.length > 0, col + '/' + id + ' has a null or empty supplierRef');
    });
  });
}
const ADMIN_PATH = path.join(__dirname, '..', 'admin.html');
function readAdmin(){ return fs.readFileSync(ADMIN_PATH, 'utf8'); }

// ---------- Scenario 1 ----------
test('Scenario 1: product and PO both missing -> both created in one transaction', async () => {
  const db = newDb();
  const pre = await IS.preflightSingleSku(db, [ITEM], CTX);
  assert.equal(pre.safeToWrite, true);
  assert.equal(pre.plan, 'create_both');
  assert.equal(db.writeOps().length, 0, 'preflight must not write');

  const out = await IS.runSingleSkuImport(db, [ITEM], CTX);
  assert.equal(out.ok, true);
  assert.equal(out.result.action, 'created');

  const p = db.dump('products')['ML-TWL-003'];
  const po = db.dump('purchaseOrders')['ML-PO-007'];
  assert.ok(p, 'product document ML-TWL-003 exists');
  assert.ok(po, 'PO document ML-PO-007 exists');
  assert.equal(p.sku, 'ML-TWL-003');
  assert.equal(p.n, ITEM.n);
  assert.equal(p.supplierRef, SUP_ID);
  assert.equal(po.sku, 'ML-TWL-003');
  assert.equal(po.productRef, 'ML-TWL-003');
  assert.equal(po.supplierRef, SUP_ID);

  const directWrites = db.ops.filter(o => ['set', 'add', 'update', 'delete'].includes(o.op) && o.collection !== 'suppliers');
  assert.equal(directWrites.length, 0, 'product/PO writes must go through the transaction only');
  assert.equal(db.ops.filter(o => o.op === 'commit').length, 1);
  assert.equal(db.ops.filter(o => o.op === 'tx-set').length, 2);
  assertNoNullSupplierRefs(db);
});

test('Scenario 1b: supplier missing -> preflight does not create it; write run creates it exactly once', async () => {
  const db = newDb({ supplier: false });
  const pre = await IS.preflightSingleSku(db, [ITEM], CTX);
  assert.equal(pre.safeToWrite, true);
  assert.equal(pre.supplier.state, 'missing');
  assert.equal(db.count('suppliers'), 0, 'preflight must not create suppliers');
  assert.equal(db.writeOps().length, 0);

  const out = await IS.runSingleSkuImport(db, [ITEM], CTX);
  assert.equal(out.ok, true);
  assert.equal(db.count('suppliers'), 1);
  const supplierId = Object.keys(db.dump('suppliers'))[0];
  assert.equal(db.dump('products')['ML-TWL-003'].supplierRef, supplierId);
  assert.equal(db.dump('purchaseOrders')['ML-PO-007'].supplierRef, supplierId);
});

// ---------- Scenario 2 ----------
test('Scenario 2: product exists and PO missing -> only the PO is created; product untouched', async () => {
  const db = newDb();
  db.seed('products', 'ML-TWL-003', productDoc());
  const before = db.dump('products')['ML-TWL-003'];

  const pre = await IS.preflightSingleSku(db, [ITEM], CTX);
  assert.equal(pre.plan, 'create_po');
  assert.equal(pre.safeToWrite, true);

  const out = await IS.runSingleSkuImport(db, [ITEM], CTX);
  assert.equal(out.ok, true);
  assert.equal(out.result.action, 'po_recovered');
  assert.deepEqual(db.dump('products')['ML-TWL-003'], before, 'existing product must be unchanged');
  const po = db.dump('purchaseOrders')['ML-PO-007'];
  assert.ok(po);
  assert.equal(po.productRef, 'ML-TWL-003');
  assert.equal(po.supplierRef, SUP_ID);
  assert.equal(db.ops.filter(o => o.op === 'tx-set').length, 1, 'only the PO is written');
});

// ---------- Scenario 3 ----------
test('Scenario 3: product and PO both exist and match -> skipped with zero writes', async () => {
  const db = newDb();
  db.seed('products', 'ML-TWL-003', productDoc());
  db.seed('purchaseOrders', 'ML-PO-007', poDoc());
  const snapshotP = db.dump('products');
  const snapshotPo = db.dump('purchaseOrders');

  const out = await IS.runSingleSkuImport(db, [ITEM], CTX);
  assert.equal(out.ok, true);
  assert.equal(out.result.action, 'skipped');
  assert.equal(db.writeOps().length, 0);
  assert.deepEqual(db.dump('products'), snapshotP);
  assert.deepEqual(db.dump('purchaseOrders'), snapshotPo);
});

// ---------- Scenario 4 ----------
test('Scenario 4: existing product name conflict -> flagged, nothing written, PO not created', async () => {
  const db = newDb();
  db.seed('products', 'ML-TWL-003', productDoc({ n: 'Factory Direct Coral Velvet Set \u2014 Normal Pink' }));
  const before = db.dump('products')['ML-TWL-003'];

  const pre = await IS.preflightSingleSku(db, [ITEM], CTX);
  assert.equal(pre.safeToWrite, false);
  assert.ok(pre.flags.some(f => f.code === 'PRODUCT_NAME_CONFLICT'));

  const out = await IS.runSingleSkuImport(db, [ITEM], CTX);
  assert.equal(out.ok, false);
  assert.equal(out.stage, 'preflight');
  assert.equal(db.writeOps().length, 0);
  assert.equal(db.count('purchaseOrders'), 0, 'PO must not be created next to a conflicting product');
  assert.deepEqual(db.dump('products')['ML-TWL-003'], before);

  // The shared resolver (used by the full batch path) reports the same conflict.
  const viaResolver = await IS.resolveItem(db, ITEM, Object.assign({}, CTX, { supplierIdByKey: { jinzhou: SUP_ID } }));
  assert.equal(viaResolver.action, 'conflict');
  assert.ok(flagCodes(viaResolver).includes('PRODUCT_NAME_CONFLICT'));
  assert.equal(db.writeOps().length, 0);
});

test('Scenario 4b: name conflict with a missing supplier -> supplier is NOT created', async () => {
  const db = newDb({ supplier: false });
  db.seed('products', 'ML-TWL-003', productDoc({ n: 'Different name', supplierRef: 'whatever' }));
  const out = await IS.runSingleSkuImport(db, [ITEM], CTX);
  assert.equal(out.ok, false);
  assert.equal(out.stage, 'preflight');
  assert.equal(db.count('suppliers'), 0);
  assert.equal(db.writeOps().length, 0);
});

// ---------- Scenario 5 ----------
test('Scenario 5: existing PO linked to a different SKU or product document -> blocked BEFORE any product write', async (t) => {
  await t.test('5a: PO ML-PO-007 linked to a different SKU', async () => {
    const db = newDb();
    db.seed('purchaseOrders', 'ML-PO-007', poDoc({ sku: 'ML-TWL-002', productRef: 'ML-TWL-002' }));
    const out = await IS.runSingleSkuImport(db, [ITEM], CTX);
    assert.equal(out.ok, false);
    assert.equal(out.stage, 'preflight');
    const codes = out.preflight.flags.map(f => f.code);
    assert.ok(codes.includes('PO_SKU_MISMATCH'));
    assert.ok(codes.includes('PO_PRODUCTREF_MISMATCH'));
    assert.equal(db.count('products'), 0, 'product must NOT be created when the PO conflicts');
    assert.equal(db.writeOps().length, 0);
  });
  await t.test('5b: PO has the right SKU but points at a different product document', async () => {
    const db = newDb();
    db.seed('purchaseOrders', 'ML-PO-007', poDoc({ productRef: 'auto-some-other-doc' }));
    const out = await IS.runSingleSkuImport(db, [ITEM], CTX);
    assert.equal(out.ok, false);
    assert.ok(out.preflight.flags.some(f => f.code === 'PO_PRODUCTREF_MISMATCH'));
    assert.equal(db.count('products'), 0);
    assert.equal(db.writeOps().length, 0);
  });
  await t.test('5c: the same SKU already has a PO under a different PO number', async () => {
    const db = newDb();
    db.seed('purchaseOrders', 'ML-PO-099', poDoc({ poNumber: 'ML-PO-099' }));
    const out = await IS.runSingleSkuImport(db, [ITEM], CTX);
    assert.equal(out.ok, false);
    assert.ok(out.preflight.flags.some(f => f.code === 'PO_SKU_ON_DIFFERENT_PO'));
    assert.equal(db.count('products'), 0);
    assert.equal(db.writeOps().length, 0);
  });
  await t.test('5d: batch-path resolver also blocks and writes nothing', async () => {
    const db = newDb();
    db.seed('purchaseOrders', 'ML-PO-007', poDoc({ sku: 'ML-TWL-002', productRef: 'ML-TWL-002' }));
    const r = await IS.resolveItem(db, ITEM, Object.assign({}, CTX, { supplierIdByKey: { jinzhou: SUP_ID } }));
    assert.equal(r.action, 'conflict');
    assert.equal(db.count('products'), 0);
    assert.equal(db.writeOps().length, 0);
  });
});

// ---------- Scenario 6 ----------
test('Scenario 6: supplier lookup or creation failure -> no product or PO written, no null supplierRef', async (t) => {
  await t.test('6a: supplier lookup throws', async () => {
    const db = newDb();
    db.injectFailure({ op: 'query', collection: 'suppliers', times: 99, error: new Error('simulated supplier lookup failure') });
    const out = await IS.runSingleSkuImport(db, [ITEM], CTX);
    assert.equal(out.ok, false);
    assert.equal(out.stage, 'preflight');
    assert.ok(out.preflight.blockers.some(b => b.indexOf('SUPPLIER_LOOKUP_FAILED') === 0));
    assert.equal(db.count('products'), 0);
    assert.equal(db.count('purchaseOrders'), 0);
    assert.equal(db.writeOps().length, 0);
  });
  await t.test('6b: supplier creation throws', async () => {
    const db = newDb({ supplier: false });
    db.injectFailure({ op: 'add', collection: 'suppliers', times: 99, error: new Error('simulated supplier create failure') });
    const out = await IS.runSingleSkuImport(db, [ITEM], CTX);
    assert.equal(out.ok, false);
    assert.equal(out.stage, 'supplier');
    assert.equal(out.result.action, 'supplier_unresolved');
    assert.equal(db.count('products'), 0);
    assert.equal(db.count('purchaseOrders'), 0);
    assert.equal(db.ops.some(o => o.op === 'commit' || o.op === 'tx-set'), false);
  });
  await t.test('6c: duplicate supplier names are ambiguous and block', async () => {
    const db = newDb();
    db.seed('suppliers', 'sup-dup', { name: SUPPLIER_NAME, createdAt: 2 });
    const out = await IS.runSingleSkuImport(db, [ITEM], CTX);
    assert.equal(out.ok, false);
    assert.equal(out.stage, 'preflight');
    assert.ok(out.preflight.blockers.some(b => b.indexOf('SUPPLIER_AMBIGUOUS') === 0));
    assert.equal(db.writeOps().length, 0);
  });
  await t.test('6d: batch resolver with no resolved supplier writes nothing (product missing)', async () => {
    const db = newDb();
    const ctx = Object.assign({}, CTX, { supplierIdByKey: {}, supplierFailures: { jinzhou: 'lookup_failed: x' } });
    const r = await IS.resolveItem(db, ITEM, ctx);
    assert.equal(r.action, 'supplier_unresolved');
    assert.equal(db.count('products'), 0);
    assert.equal(db.count('purchaseOrders'), 0);
    assert.equal(db.writeOps().length, 0);
  });
  await t.test('6e: batch resolver with no resolved supplier does not recover a missing PO', async () => {
    const db = newDb();
    db.seed('products', 'ML-TWL-003', productDoc());
    const r = await IS.resolveItem(db, ITEM, Object.assign({}, CTX, { supplierIdByKey: {} }));
    assert.equal(r.action, 'supplier_unresolved');
    assert.equal(db.count('purchaseOrders'), 0);
    assert.equal(db.writeOps().length, 0);
  });
  await t.test('6f: empty-string or null supplier IDs are treated as unresolved', async () => {
    for(const bad of ['', null, undefined, '   ']){
      const db = newDb();
      const r = await IS.resolveItem(db, ITEM, Object.assign({}, CTX, { supplierIdByKey: { jinzhou: bad } }));
      assert.equal(r.action, 'supplier_unresolved');
      assert.equal(db.writeOps().length, 0);
    }
  });
  await t.test('6g: legacy product with a null supplierRef is flagged for manual review, PO not created', async () => {
    const db = newDb();
    db.seed('products', 'ML-TWL-003', productDoc({ supplierRef: null }));
    const r = await IS.resolveItem(db, ITEM, Object.assign({}, CTX, { supplierIdByKey: { jinzhou: SUP_ID } }));
    assert.equal(r.action, 'conflict');
    assert.ok(flagCodes(r).includes('PRODUCT_SUPPLIER_MISMATCH'));
    assert.equal(db.count('purchaseOrders'), 0);
    assert.equal(db.writeOps().length, 0);
  });
});

// ---------- Scenario 7 ----------
test('Scenario 7: partial failure followed by a successful retry', async (t) => {
  await t.test('7a: supplier created, transaction commit fails, retry succeeds without a duplicate supplier', async () => {
    const db = newDb({ supplier: false });
    db.injectFailure({ op: 'commit', error: new Error('simulated commit failure'), times: 1 });

    const first = await IS.runSingleSkuImport(db, [ITEM], CTX);
    assert.equal(first.ok, false);
    assert.equal(first.result.action, 'failed');
    assert.equal(first.result.stage, 'transaction');
    assert.equal(db.count('products'), 0, 'failed commit must leave no product');
    assert.equal(db.count('purchaseOrders'), 0, 'failed commit must leave no PO');
    assert.equal(db.count('suppliers'), 1, 'supplier from the first attempt remains');

    const second = await IS.runSingleSkuImport(db, [ITEM], CTX);
    assert.equal(second.ok, true);
    assert.equal(second.result.action, 'created');
    assert.equal(db.count('suppliers'), 1, 'retry must reuse the supplier, not create another');
    assert.ok(db.dump('products')['ML-TWL-003']);
    assert.ok(db.dump('purchaseOrders')['ML-PO-007']);
    assertNoNullSupplierRefs(db);
  });
  await t.test('7b: legacy product-only state, PO commit fails, retry recovers the PO', async () => {
    const db = newDb();
    db.seed('products', 'ML-TWL-003', productDoc());
    const before = db.dump('products')['ML-TWL-003'];
    db.injectFailure({ op: 'commit', error: new Error('simulated commit failure'), times: 1 });

    const first = await IS.runSingleSkuImport(db, [ITEM], CTX);
    assert.equal(first.ok, false);
    assert.equal(first.result.action, 'failed');
    assert.equal(db.count('purchaseOrders'), 0);
    assert.deepEqual(db.dump('products')['ML-TWL-003'], before);

    const second = await IS.runSingleSkuImport(db, [ITEM], CTX);
    assert.equal(second.ok, true);
    assert.equal(second.result.action, 'po_recovered');
    assert.ok(db.dump('purchaseOrders')['ML-PO-007']);
  });
  await t.test('7c: a further run after success is a no-op', async () => {
    const db = newDb();
    await IS.runSingleSkuImport(db, [ITEM], CTX);
    const opsBefore = db.writeOps().length;
    const again = await IS.runSingleSkuImport(db, [ITEM], CTX);
    assert.equal(again.ok, true);
    assert.equal(again.result.action, 'skipped');
    assert.equal(db.writeOps().length, opsBefore, 'no further writes');
  });
  await t.test('7d: a conflicting PO appearing between the read and the transaction is caught inside the transaction', async () => {
    const db = newDb();
    db.beforeTransaction = d => d._put('purchaseOrders', 'ML-PO-007', poDoc({ sku: 'ML-TWL-002', productRef: 'ML-TWL-002' }));
    const out = await IS.runSingleSkuImport(db, [ITEM], CTX);
    assert.equal(out.ok, false);
    assert.equal(out.result.action, 'conflict');
    assert.equal(out.result.detectedIn, 'transaction');
    assert.equal(db.count('products'), 0, 'product must not be written when the in-transaction re-check fails');
    assert.equal(db.ops.filter(o => o.op === 'tx-set').length, 0);
  });
});

// ---------- Scenario 8 ----------
test('Scenario 8: any attempt to include a SKU other than ML-TWL-003 is rejected before any Firestore access', async () => {
  const other = Object.assign({}, ITEM, { sku: 'ML-TWL-002', poNumber: 'ML-PO-006', n: 'Factory Direct Coral Velvet Set \u2014 Ordinary Rice White' });
  const cases = {
    'extra SKU alongside ML-TWL-003': [ITEM, other],
    'only a different SKU': [other],
    'empty list': [],
    'lowercase SKU': [Object.assign({}, ITEM, { sku: 'ml-twl-003' })],
    'SKU with trailing whitespace': [Object.assign({}, ITEM, { sku: 'ML-TWL-003 ' })],
    'duplicate ML-TWL-003': [ITEM, ITEM],
    'allowlisted SKU with an altered confirmed value (price)': [Object.assign({}, ITEM, { price: 75 })],
    'allowlisted SKU with an altered PO number': [Object.assign({}, ITEM, { poNumber: 'ML-PO-008' })],
    'not an array': ITEM
  };
  for(const label of Object.keys(cases)){
    const items = cases[label];
    const db = newDb();
    await assert.rejects(
      () => IS.runSingleSkuImport(db, items, CTX),
      err => { assert.equal(err.code, 'ALLOWLIST_VIOLATION', label); return true; },
      label
    );
    assert.equal(db.ops.length, 0, label + ': no Firestore operation of any kind');
    const pre = await IS.preflightSingleSku(db, items, CTX);
    assert.equal(pre.safeToWrite, false, label + ': preflight must not approve it');
    assert.equal(db.ops.length, 0, label + ': preflight made no Firestore operation');
  }
  assert.deepEqual(Array.from(IS.SINGLE_SKU_TEST_ALLOWLIST), ['ML-TWL-003']);
  assert.throws(() => { IS.SINGLE_SKU_TEST_ALLOWLIST.push('ML-TWL-002'); }, TypeError, 'allowlist is frozen');
});

// ---------- Additional: ID / SKU / productRef consistency ----------
test('Consistency: product ID, sku field and PO productRef mismatches are flagged for manual review', async (t) => {
  await t.test('same SKU on an auto-ID product document', async () => {
    const db = newDb();
    db.seed('products', 'auto-xyz', productDoc());
    const out = await IS.runSingleSkuImport(db, [ITEM], CTX);
    assert.equal(out.ok, false);
    assert.ok(out.preflight.flags.some(f => f.code === 'PRODUCT_SKU_ON_DIFFERENT_DOC'));
    assert.equal(db.writeOps().length, 0);
  });
  await t.test('document ID is the SKU but the sku field disagrees', async () => {
    const db = newDb();
    db.seed('products', 'ML-TWL-003', productDoc({ sku: 'ML-TWL-002' }));
    const out = await IS.runSingleSkuImport(db, [ITEM], CTX);
    assert.equal(out.ok, false);
    assert.ok(out.preflight.flags.some(f => f.code === 'PRODUCT_SKU_FIELD_MISMATCH'));
    assert.equal(db.writeOps().length, 0);
  });
  await t.test('PO supplierRef differs from the resolved supplier', async () => {
    const db = newDb();
    db.seed('products', 'ML-TWL-003', productDoc());
    db.seed('purchaseOrders', 'ML-PO-007', poDoc({ supplierRef: 'sup-other' }));
    const out = await IS.runSingleSkuImport(db, [ITEM], CTX);
    assert.equal(out.ok, false);
    assert.ok(out.preflight.flags.some(f => f.code === 'PO_SUPPLIER_MISMATCH'));
    assert.equal(db.writeOps().length, 0);
  });
  await t.test('supplier missing but product/PO already exist -> blocked, supplier not created', async () => {
    const db = newDb({ supplier: false });
    db.seed('products', 'ML-TWL-003', productDoc({ supplierRef: 'dangling' }));
    const pre = await IS.preflightSingleSku(db, [ITEM], CTX);
    assert.equal(pre.safeToWrite, false);
    assert.ok(pre.blockers.some(b => b.indexOf('SUPPLIER_MISSING_BUT_RECORDS_EXIST') === 0));
    assert.equal(db.count('suppliers'), 0);
  });
});

test('Preflight is read-only: it succeeds with writes blocked and issues only reads', async () => {
  const states = [
    () => newDb(),
    () => newDb({ supplier: false }),
    () => newDb().seed('products', 'ML-TWL-003', productDoc()),
    () => newDb().seed('products', 'ML-TWL-003', productDoc()).seed('purchaseOrders', 'ML-PO-007', poDoc()),
    () => newDb().seed('purchaseOrders', 'ML-PO-007', poDoc({ sku: 'ML-TWL-002' }))
  ];
  for(const make of states){
    const db = make().blockWrites();
    const report = await IS.preflightSingleSku(db, [ITEM], CTX);
    assert.equal(report.readOnly, true);
    assert.ok(db.ops.length > 0);
    assert.ok(db.ops.every(o => o.op === 'get' || o.op === 'query'), 'only reads: ' + JSON.stringify(db.ops.map(o => o.op)));
  }
});

// ---------- Static guards on admin.html (read the file; do not execute it) ----------
test('static: admin.html inline <script> blocks compile without a SyntaxError', () => {
  const src = readAdmin();
  const re = /<script>([\s\S]*?)<\/script>/g;
  let m;
  let count = 0;
  while((m = re.exec(src)) !== null){
    count += 1;
    assert.doesNotThrow(() => new vm.Script(m[1], { filename: 'admin.html#inline-' + count }), 'inline script ' + count + ' has a syntax error');
  }
  assert.ok(count >= 2, 'expected at least two inline scripts, found ' + count);
});

test('static: admin.html loads lib/import-safety.js and no longer writes null supplier references', () => {
  const src = readAdmin();
  assert.ok(src.includes('<script src="lib/import-safety.js"></script>'));
  assert.equal(/supplierRef:\s*supplierId\s*\|\|\s*null/.test(src), false, 'null-supplier fallback must be gone');
  assert.equal(src.includes('async function resolveBatch1Item'), false, 'old unsafe resolver must be gone');
});

test('static: ML-TWL-003 entry in admin.html BATCH1_SKUS matches the Commander-confirmed values and appears once', () => {
  const src = readAdmin();
  assert.equal(src.split('sku:"ML-TWL-003"').length - 1, 1, 'exactly one ML-TWL-003 entry');
  const m = /\{ sku:"ML-TWL-003"[^\n]*\}/.exec(src);
  assert.ok(m, 'ML-TWL-003 entry found');
  const entry = new Function('return (' + m[0] + ');')();
  const confirmed = IS.CONFIRMED_SINGLE_SKU_VALUES['ML-TWL-003'];
  Object.keys(confirmed).forEach(k => assert.equal(entry[k], confirmed[k], 'field ' + k));
});

// ======================================================================
// Phase 2.1 — import write containment
// ======================================================================
const BLOCKED_HANDLERS = [
  { name: 'importSingleSkuTest', boxId: 'preflightResultBox', buttonText: 'Run Single-SKU Test \u2014 ML-TWL-003 Only' },
  { name: 'importApprovedTestBatch', boxId: 'importResultBox', buttonText: 'Import Approved Test Batch (5 Neutriherbs SKUs)' },
  { name: 'importBatch1', boxId: 'importBatch1ResultBox', buttonText: 'Import Batch 1 \u2014 40 New SKUs' }
];

function mainInlineScript(){
  const src = readAdmin();
  const re = /<script>([\s\S]*?)<\/script>/g;
  let m;
  while((m = re.exec(src)) !== null){
    if(m[1].indexOf('function importBatch1') !== -1) return m[1];
  }
  throw new Error('main inline script not found in admin.html');
}

// Runs admin.html's main inline script in a vm sandbox with a stubbed DOM.
// By default every Firebase / database / ImportSafety access THROWS, so a handler that reaches them fails the test.
function loadAdminSandbox(overrides){
  const o = overrides || {};
  const boxes = {};
  const sandbox = {
    window: {},
    RenderSafety: require('../lib/render-safety.js'),
    document: {
      addEventListener(){},
      getElementById(id){ return boxes[id] || (boxes[id] = { id: id, style: { display: '' }, innerHTML: '' }); },
      querySelectorAll(){ return []; }
    },
    alert(msg){ sandbox.__alerts.push(String(msg)); },
    console: console,
    __alerts: []
  };
  if(o.importSafety){
    sandbox.ImportSafety = o.importSafety;
  } else {
    Object.defineProperty(sandbox, 'ImportSafety', { get(){ throw new Error('ImportSafety was accessed'); }, configurable: true });
  }
  Object.defineProperty(sandbox, 'firebase', { get(){ throw new Error('firebase was accessed'); }, configurable: true });
  if(o.fakeDb) sandbox.__fakeDb = o.fakeDb;
  const ctx = vm.createContext(sandbox);
  vm.runInContext(mainInlineScript(), ctx, { filename: 'admin.html#main' });
  if(o.fakeDb){
    vm.runInContext('db = __fakeDb;', ctx);
  } else {
    vm.runInContext('db = new Proxy({}, { get(){ throw new Error("DB_ACCESSED"); }, has(){ throw new Error("DB_ACCESSED"); } });', ctx);
  }
  return { ctx: ctx, boxes: boxes, sandbox: sandbox };
}

function handlerSource(src, name){
  const start = src.indexOf('async function ' + name + '(){');
  assert.ok(start !== -1, name + ' not found');
  const rest = src.slice(start + 1);
  const m = /\n  (?:\/\/ =====|async function |function )/.exec(rest);
  return src.slice(start, m ? start + 1 + m.index : src.length);
}

function buttonTag(html, handlerName){
  const m = new RegExp('<button[^>]*onclick="' + handlerName + '\\(\\)"[^>]*>').exec(html);
  assert.ok(m, 'button for ' + handlerName + ' not found');
  return m[0];
}

test('containment: IMPORT_WRITES_CONTAINED is literally declared once and set to true', () => {
  const src = mainInlineScript();
  assert.ok(/^\s*const IMPORT_WRITES_CONTAINED = true;\s*$/m.test(src), 'flag must be declared as: const IMPORT_WRITES_CONTAINED = true;');
  assert.equal(src.match(/IMPORT_WRITES_CONTAINED\s*=(?!=)/g).length, 1, 'flag must be assigned exactly once');
  const { ctx } = loadAdminSandbox();
  assert.equal(vm.runInContext('IMPORT_WRITES_CONTAINED', ctx), true);
});

test('containment: each import handler starts with the guard, before any Firebase/database access', () => {
  const src = readAdmin();
  for(const h of BLOCKED_HANDLERS){
    const body = handlerSource(src, h.name).replace(/^async function \w+\(\)\{/, '');
    assert.ok(/^\s*if\(IMPORT_WRITES_CONTAINED\)\{[^}]*\breturn;\s*\}/.test(body), h.name + ': guard must be the first statement');
    assert.ok(body.indexOf('IMPORT_WRITES_CONTAINED') < 40, h.name + ': guard must open the function body');
    const guardIdx = body.indexOf('IMPORT_WRITES_CONTAINED');
    [/\bdb\b/, /\bfirebase\b/, /\bImportSafety\b/, /\balert\(/].forEach(token => {
      const m = token.exec(body);
      if(m) assert.ok(guardIdx < m.index, h.name + ': ' + token + ' appears before the guard');
    });
    assert.ok(/\bdb\b/.test(body), h.name + ': sanity check — handler is expected to use db after the guard');
  }
});

test('containment: executing each handler returns blocked without touching db, firebase, ImportSafety or alert', async () => {
  for(const h of BLOCKED_HANDLERS){
    const { ctx, boxes, sandbox } = loadAdminSandbox();
    await assert.doesNotReject(async () => { await vm.runInContext(h.name + '()', ctx); }, h.name + ' must not throw (no db/firebase/ImportSafety access)');
    assert.deepEqual(Object.keys(boxes), [h.boxId], h.name + ': must touch only its own result box');
    assert.equal(boxes[h.boxId].style.display, 'block');
    assert.ok(boxes[h.boxId].innerHTML.indexOf('Import blocked') !== -1, h.name + ': must show a blocked message');
    assert.ok(boxes[h.boxId].innerHTML.indexOf('No Firestore calls were made') !== -1);
    assert.equal(sandbox.__alerts.length, 0, h.name + ': must not call alert');
  }
});

test('containment: handlers stay blocked even when a working fake database is present', async () => {
  for(const h of BLOCKED_HANDLERS){
    const fake = newDb().blockWrites();
    const { ctx } = loadAdminSandbox({ fakeDb: fake, importSafety: IS });
    await vm.runInContext(h.name + '()', ctx);
    assert.equal(fake.ops.length, 0, h.name + ': no Firestore operation of any kind');
  }
});

test('containment: all three import buttons are disabled in the HTML', () => {
  const src = readAdmin();
  for(const h of BLOCKED_HANDLERS){
    const tag = buttonTag(src, h.name);
    assert.ok(/\sdisabled(\s|=|>)/.test(tag), h.name + ': button must carry the disabled attribute: ' + tag);
    assert.ok(src.includes(h.buttonText), 'button label present: ' + h.buttonText);
    assert.equal(src.split('onclick="' + h.name + '()"').length - 1, 1, h.name + ': exactly one button');
  }
});

test('containment: offline checks and the read-only preflight remain available (buttons enabled, handlers defined)', async () => {
  const src = readAdmin();
  ['runBatch1OfflineChecks', 'runSingleSkuPreflight'].forEach(name => {
    const tag = buttonTag(src, name);
    assert.equal(/\sdisabled(\s|=|>)/.test(tag), false, name + ': button must NOT be disabled');
  });
  const { ctx, boxes } = loadAdminSandbox();
  assert.equal(vm.runInContext('typeof runBatch1OfflineChecks', ctx), 'function');
  assert.equal(vm.runInContext('typeof runSingleSkuPreflight', ctx), 'function');
  assert.ok(!/IMPORT_WRITES_CONTAINED/.test(handlerSourceAny(src, 'runSingleSkuPreflight')), 'preflight is not blocked by the containment flag');

  vm.runInContext('runBatch1OfflineChecks()', ctx);
  assert.ok(/offline checks/i.test(boxes.preflightResultBox.innerHTML), 'offline checks produced a result');
  assert.ok(boxes.preflightResultBox.innerHTML.indexOf('All offline checks passed.') !== -1, 'offline checks pass: ' + boxes.preflightResultBox.innerHTML);
});

function handlerSourceAny(src, name){
  const start = src.indexOf('function ' + name + '(){');
  assert.ok(start !== -1, name + ' not found');
  const rest = src.slice(start + 1);
  const m = /\n  (?:\/\/ =====|async function |function )/.exec(rest);
  return src.slice(start, m ? start + 1 + m.index : src.length);
}

test('containment: the read-only preflight runs reads only and a clean result is not presented as permission to write', async () => {
  const fake = newDb().blockWrites();
  const { ctx, boxes } = loadAdminSandbox({ fakeDb: fake, importSafety: IS });
  await vm.runInContext('runSingleSkuPreflight()', ctx);
  assert.ok(fake.ops.length > 0, 'preflight read something');
  assert.ok(fake.ops.every(o => o.op === 'get' || o.op === 'query'), 'only reads: ' + JSON.stringify(fake.ops.map(o => o.op)));
  const html = boxes.preflightResultBox.innerHTML;
  assert.ok(html.indexOf('NOT permission to write') !== -1, 'clean preflight must say it is not permission to write: ' + html);
  assert.equal(html.indexOf('would be permitted'), -1);
});

test('containment: page copy states that import write paths are disabled and a clean preflight is not permission', () => {
  const src = readAdmin();
  assert.ok(src.includes('Every import write path is disabled'));
  assert.ok(src.includes('A clean preflight is not permission to write.'));
  assert.ok(src.includes('Offline static checks and the read-only preflight are available'));
  assert.equal(src.includes('a write run would be permitted'), false, 'old permission-implying copy must be gone');
});
