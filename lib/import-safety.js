/*
 * lib/import-safety.js — Phase 2 import-safety layer for admin.html
 *
 * STATUS: UNEXECUTED — NOT APPROVED FOR LIVE IMPORT.
 * Written without a terminal. Never run, linted, or tested at the time of writing.
 *
 * Works both in the browser (exposes window.ImportSafety) and in Node (module.exports),
 * so the exact code admin.html runs is the code the regression tests import.
 *
 * Design notes
 *  - Every record decision is made by the pure function classifyItemState().
 *  - Conflicts are detected BEFORE any write (product, PO, supplier-reference checks).
 *  - A product/PO write requires a resolved, non-empty supplier document ID. A null
 *    supplier reference is never written.
 *  - Product + PO creation for one SKU happens inside ONE Firestore transaction that
 *    re-reads both documents by ID and re-validates before writing.
 *  - Firestore client transactions cannot run queries, so the SKU-field and PO-by-SKU
 *    queries run before the transaction (read-only). A concurrent writer that creates a
 *    differently-ID'd document with the same SKU between those queries and the commit is
 *    NOT detectable here. This is a documented residual risk.
 *  - Supplier lookup/creation cannot be transactional (suppliers have auto-generated IDs
 *    and are found by name). Two simultaneous importers could create duplicate suppliers;
 *    a later run then reports the supplier as ambiguous and blocks.
 */
(function(root, factory){
  if(typeof module === 'object' && module.exports){ module.exports = factory(); }
  else { root.ImportSafety = factory(); }
})(typeof self !== 'undefined' ? self : this, function(){
  'use strict';

  // ===== Allowlist (strict, single SKU) =====
  const SINGLE_SKU_TEST_ALLOWLIST = Object.freeze(['ML-TWL-003']);

  // Commander-confirmed values for the single-SKU test, copied from BATCH1_SKUS at
  // commit c5ca4809fedca50b98a8cc464e3d41ade85262c3. A test compares this against admin.html.
  const CONFIRMED_SINGLE_SKU_VALUES = Object.freeze({
    'ML-TWL-003': Object.freeze({
      sku: 'ML-TWL-003',
      n: 'Factory Direct Coral Velvet Set \u2014 Normal Purple',
      category: 'home',
      note: 'Coral velvet home textile set',
      price: 74,
      old: 74,
      wholesalePrice: 56,
      costPrice: 37.17,
      quantity: 1,
      stockVerified: true,
      reorderLevel: 5,
      poNumber: 'ML-PO-007',
      poDate: '2026-08-01',
      supplierKey: 'jinzhou'
    })
  });

  // ===== Small helpers =====
  function isNonEmptyString(v){ return typeof v === 'string' && v.trim().length > 0; }
  function errMsg(err){ return (err && err.message) ? err.message : String(err); }
  function makeError(code, message, details){
    const e = new Error(message);
    e.code = code;
    if(details !== undefined) e.details = details;
    return e;
  }
  function nowFn(ctx){ return (ctx && typeof ctx.now === 'function') ? ctx.now : Date.now; }

  // ===== Allowlist validation =====
  function validateSingleSkuAllowlist(items){
    const errors = [];
    if(!Array.isArray(items)){
      return {ok: false, errors: ['items must be an array containing exactly one item.']};
    }
    if(items.length !== 1){
      errors.push('Exactly one item is permitted; received ' + items.length + '.');
    }
    items.forEach(function(it, idx){
      const sku = it && it.sku;
      if(typeof sku !== 'string' || SINGLE_SKU_TEST_ALLOWLIST.indexOf(sku) === -1){
        errors.push('SKU not on the single-SKU allowlist: ' + JSON.stringify(sku === undefined ? null : sku) + ' (index ' + idx + ').');
      }
    });
    if(errors.length === 0){
      const confirmed = CONFIRMED_SINGLE_SKU_VALUES[items[0].sku];
      Object.keys(confirmed).forEach(function(k){
        if(items[0][k] !== confirmed[k]){
          errors.push('Field "' + k + '" does not match the Commander-confirmed value.');
        }
      });
    }
    return {ok: errors.length === 0, errors: errors};
  }
  function assertSingleSkuAllowlist(items){
    const v = validateSingleSkuAllowlist(items);
    if(!v.ok){
      throw makeError('ALLOWLIST_VIOLATION', 'Single-SKU allowlist violation: ' + v.errors.join(' '), v.errors);
    }
    return items[0];
  }

  // ===== Item shape validation (pure) =====
  const SKU_PATTERN = /^ML-[A-Z]{2,4}-\d{3}$/;
  const PO_PATTERN = /^ML-PO-\d{3}$/;
  function validateItemShape(item, ctx){
    const errs = [];
    if(!item || typeof item !== 'object') return ['item is not an object'];
    if(typeof item.sku !== 'string' || !SKU_PATTERN.test(item.sku)) errs.push('sku "' + item.sku + '" is not a valid ML-XXX-000 SKU');
    if(typeof item.poNumber !== 'string' || !PO_PATTERN.test(item.poNumber)) errs.push('poNumber "' + item.poNumber + '" is not a valid ML-PO-000 number');
    if(!isNonEmptyString(item.n)) errs.push('product name is missing');
    if(!isNonEmptyString(item.supplierKey)){
      errs.push('supplierKey is missing');
    } else if(ctx && Array.isArray(ctx.suppliers) && !ctx.suppliers.some(function(s){ return s.key === item.supplierKey; })){
      errs.push('supplierKey "' + item.supplierKey + '" has no supplier definition');
    }
    ['price', 'costPrice', 'wholesalePrice', 'quantity', 'reorderLevel'].forEach(function(k){
      if(typeof item[k] !== 'number' || !isFinite(item[k])) errs.push(k + ' must be a finite number');
    });
    if(typeof item.poDate !== 'string' || isNaN(new Date(item.poDate).getTime())) errs.push('poDate is missing or not a valid date');
    return errs;
  }

  // ===== Read-only state collection =====
  function toEntry(snap, id){
    const exists = !!(snap && snap.exists);
    return {exists: exists, id: (snap && snap.id) || id, data: exists ? (snap.data() || {}) : null};
  }

  // Reads only. Never writes.
  async function readItemState(db, item){
    const productSnap = await db.collection('products').doc(item.sku).get();
    const poSnap = await db.collection('purchaseOrders').doc(item.poNumber).get();
    const prodBySku = await db.collection('products').where('sku', '==', item.sku).limit(5).get();
    const poBySku = await db.collection('purchaseOrders').where('sku', '==', item.sku).limit(5).get();
    return {
      productById: toEntry(productSnap, item.sku),
      poById: toEntry(poSnap, item.poNumber),
      productsBySku: prodBySku.docs.map(function(d){ return {id: d.id, data: d.data() || {}}; }),
      posBySku: poBySku.docs.map(function(d){ return {id: d.id, data: d.data() || {}}; })
    };
  }

  // ===== Pure classifier =====
  // supplierId: resolved supplier doc ID, or null when unresolved / not yet known.
  // Supplier-reference comparisons only run when a resolved ID is available.
  function classifyItemState(item, state, supplierId){
    const flags = [];
    function add(code, message, extra){ flags.push(Object.assign({code: code, message: message}, extra || {})); }
    const expectedProductId = item.sku;
    const expectedPoId = item.poNumber;
    const haveSupplier = isNonEmptyString(supplierId);
    const prod = (state.productById && state.productById.exists) ? state.productById : null;
    const po = (state.poById && state.poById.exists) ? state.poById : null;

    const strayProducts = (state.productsBySku || []).filter(function(p){ return p.id !== expectedProductId; });
    if(strayProducts.length){
      const ids = strayProducts.map(function(p){ return p.id; });
      add('PRODUCT_SKU_ON_DIFFERENT_DOC', 'SKU ' + item.sku + ' already exists on product document(s) with a different ID: ' + ids.join(', ') + ' (expected document ID "' + expectedProductId + '").', {ids: ids});
    }
    if(prod){
      if(prod.data.sku !== item.sku){
        add('PRODUCT_SKU_FIELD_MISMATCH', 'Product document "' + prod.id + '" has sku field "' + prod.data.sku + '" but the document ID implies "' + item.sku + '".', {found: prod.data.sku === undefined ? null : prod.data.sku});
      }
      if(prod.data.n !== item.n){
        add('PRODUCT_NAME_CONFLICT', 'Product "' + prod.id + '" exists as "' + prod.data.n + '" but the import expects "' + item.n + '".', {existingName: prod.data.n === undefined ? null : prod.data.n, existingDocId: prod.id});
      }
      if(haveSupplier && prod.data.supplierRef !== supplierId){
        add('PRODUCT_SUPPLIER_MISMATCH', 'Product "' + prod.id + '" has supplierRef "' + prod.data.supplierRef + '" but the resolved supplier is "' + supplierId + '".', {found: prod.data.supplierRef === undefined ? null : prod.data.supplierRef});
      }
    }
    if(po){
      if(po.data.sku !== item.sku){
        add('PO_SKU_MISMATCH', 'PO "' + po.id + '" is linked to SKU "' + po.data.sku + '", expected "' + item.sku + '".', {existingPoSku: po.data.sku === undefined ? null : po.data.sku, poNumber: po.id});
      }
      if(po.data.productRef !== expectedProductId){
        add('PO_PRODUCTREF_MISMATCH', 'PO "' + po.id + '" productRef is "' + po.data.productRef + '", expected product document "' + expectedProductId + '".', {found: po.data.productRef === undefined ? null : po.data.productRef, poNumber: po.id});
      }
      if(po.data.poNumber !== item.poNumber){
        add('PO_NUMBER_FIELD_MISMATCH', 'PO document "' + po.id + '" has poNumber field "' + po.data.poNumber + '".', {found: po.data.poNumber === undefined ? null : po.data.poNumber});
      }
      if(haveSupplier && po.data.supplierRef !== supplierId){
        add('PO_SUPPLIER_MISMATCH', 'PO "' + po.id + '" has supplierRef "' + po.data.supplierRef + '" but the resolved supplier is "' + supplierId + '".', {found: po.data.supplierRef === undefined ? null : po.data.supplierRef, poNumber: po.id});
      }
    }
    const strayPos = (state.posBySku || []).filter(function(p){ return p.id !== expectedPoId; });
    if(strayPos.length){
      const ids = strayPos.map(function(p){ return p.id; });
      add('PO_SKU_ON_DIFFERENT_PO', 'SKU ' + item.sku + ' already has purchase order(s) under a different PO ID: ' + ids.join(', ') + ' (expected "' + expectedPoId + '").', {ids: ids});
    }

    if(flags.length){
      return {status: 'conflict', flags: flags, needsProduct: false, needsPO: false};
    }
    const needsProduct = !prod;
    const needsPO = !po;
    let status;
    if(needsProduct && needsPO) status = 'create_both';
    else if(needsPO) status = 'create_po';
    else if(needsProduct) status = 'create_product';
    else status = 'complete';
    return {status: status, flags: [], needsProduct: needsProduct, needsPO: needsPO};
  }

  // ===== Supplier resolution =====
  // ok === true ONLY when a non-empty supplier document ID is in hand.
  async function resolveSupplier(db, def, opts){
    const o = opts || {};
    const now = o.now || Date.now;
    if(!def || !isNonEmptyString(def.name)){
      return {ok: false, state: 'invalid_definition', supplierId: null, error: 'Supplier definition is missing a name.'};
    }
    let snap;
    try{
      snap = await db.collection('suppliers').where('name', '==', def.name).limit(2).get();
    }catch(err){
      return {ok: false, state: 'lookup_failed', supplierId: null, error: errMsg(err)};
    }
    if(snap.docs.length > 1){
      return {ok: false, state: 'ambiguous', supplierId: null, ids: snap.docs.map(function(d){ return d.id; }), error: 'More than one supplier document is named "' + def.name + '".'};
    }
    if(snap.docs.length === 1){
      const id = snap.docs[0].id;
      if(!isNonEmptyString(id)) return {ok: false, state: 'invalid_id', supplierId: null, error: 'Supplier document has an empty ID.'};
      return {ok: true, state: 'found', supplierId: id};
    }
    if(o.readOnly){
      return {ok: false, state: 'missing', supplierId: null};
    }
    try{
      const ref = await db.collection('suppliers').add({
        name: def.name,
        platform: def.platform || '',
        phone: def.phone || '',
        categorySupplied: def.categorySupplied || '',
        notes: def.notes || '',
        createdAt: now()
      });
      if(!ref || !isNonEmptyString(ref.id)){
        return {ok: false, state: 'create_failed', supplierId: null, error: 'Supplier creation returned no document ID.'};
      }
      return {ok: true, state: 'created', supplierId: ref.id};
    }catch(err){
      return {ok: false, state: 'create_failed', supplierId: null, error: errMsg(err)};
    }
  }

  async function setUpSuppliers(db, defs, opts){
    const supplierIdByKey = {};
    const supplierFailures = {};
    const supplierStates = {};
    const supplierReport = [];
    for(let i = 0; i < defs.length; i++){
      const def = defs[i];
      const r = await resolveSupplier(db, def, opts);
      supplierStates[def.key] = r;
      if(r.ok){
        supplierIdByKey[def.key] = r.supplierId;
        supplierReport.push(def.name + ' \u2014 ' + (r.state === 'created' ? 'created' : 'reused existing'));
      } else {
        supplierFailures[def.key] = r.state + (r.error ? ': ' + r.error : '');
        supplierReport.push(def.name + ' \u2014 UNRESOLVED (' + supplierFailures[def.key] + ')');
      }
    }
    return {supplierIdByKey: supplierIdByKey, supplierFailures: supplierFailures, supplierStates: supplierStates, supplierReport: supplierReport};
  }

  // ===== Record builders (supplierId is guaranteed non-empty by callers) =====
  function buildProductData(item, supplierId, ctx){
    return {
      category: item.category, n: item.n, note: item.note,
      price: item.price, old: item.old, costPrice: item.costPrice, isFreeGift: false,
      wholesalePrice: item.wholesalePrice,
      landedCost: (item.landedCost !== undefined && item.landedCost !== null) ? item.landedCost : null,
      poUnitCost: (item.poUnitCost !== undefined && item.poUnitCost !== null) ? item.poUnitCost : null,
      images: [], variants: [], optionGroups: [], comboStock: {},
      status: item.stockVerified ? 'in_stock' : 'coming_soon',
      quantity: item.quantity,
      sku: item.sku, reorderLevel: item.reorderLevel, incomingStock: item.incomingStock || 0,
      stockVerified: !!item.stockVerified,
      auditNote: item.auditNote || null,
      supplierRef: supplierId, priceStatus: 'priced',
      importedFromWorkbook: true, importBatchId: ctx.batchId,
      archived: false, sortOrder: nowFn(ctx)()
    };
  }
  function buildPoData(item, supplierId, ctx){
    const def = ctx.suppliers.find(function(s){ return s.key === item.supplierKey; });
    const unitCost = (item.poUnitCost !== undefined && item.poUnitCost !== null) ? item.poUnitCost : item.costPrice;
    const qty = (item.quantity || 0) + (item.incomingStock || 0);
    return {
      poNumber: item.poNumber,
      date: new Date(item.poDate).getTime(),
      supplierRef: supplierId,
      supplierName: def.name,
      sku: item.sku, productName: item.n, productRef: item.sku,
      qty: qty,
      unitCost: unitCost,
      totalCost: unitCost * qty,
      paymentStatus: 'paid',
      orderStatus: item.incomingStock ? 'processing' : 'unknown',
      warehouseArrivalDate: null,
      notes: 'Imported from workbook audit \u2014 Batch 1 (' + ctx.batchId + ')' + (item.auditNote ? ' \u2014 ' + item.auditNote : ''),
      excludeFromInventory: false,
      dateValidationStatus: 'unknown', dateValidationNote: '',
      importBatchId: ctx.batchId, createdAt: nowFn(ctx)()
    };
  }

  // ===== Atomic write =====
  // Re-reads product + PO by ID inside the transaction, re-classifies, and only then writes.
  // The callback has no side effects other than tx.set, so Firestore may safely retry it.
  async function commitItem(db, item, supplierId, ctx, outerState){
    const productRef = db.collection('products').doc(item.sku);
    const poRef = db.collection('purchaseOrders').doc(item.poNumber);
    return db.runTransaction(async function(tx){
      const pSnap = await tx.get(productRef);
      const poSnap = await tx.get(poRef);
      const txState = {
        productById: toEntry(pSnap, item.sku),
        poById: toEntry(poSnap, item.poNumber),
        productsBySku: outerState.productsBySku,
        posBySku: outerState.posBySku
      };
      const plan = classifyItemState(item, txState, supplierId);
      if(plan.status === 'conflict') return {outcome: 'conflict', plan: plan};
      if(plan.status === 'complete') return {outcome: 'noop', plan: plan};
      if(plan.needsProduct) tx.set(productRef, buildProductData(item, supplierId, ctx));
      if(plan.needsPO) tx.set(poRef, buildPoData(item, supplierId, ctx));
      return {outcome: 'written', plan: plan};
    });
  }

  // ===== Per-item resolver shared by the single-SKU test and the full Batch 1 path =====
  // ctx: {batchId, suppliers, supplierIdByKey, supplierFailures, now}
  async function resolveItem(db, item, ctx){
    if(!ctx || !isNonEmptyString(ctx.batchId)) throw makeError('INVALID_CONTEXT', 'ctx.batchId is required.');
    const base = {sku: item && item.sku, n: item && item.n};
    const shapeErrors = validateItemShape(item, ctx);
    if(shapeErrors.length){
      return Object.assign(base, {action: 'invalid_item', flags: shapeErrors.map(function(m){ return {code: 'INVALID_ITEM', message: m}; })});
    }
    const resolved = ctx.supplierIdByKey ? ctx.supplierIdByKey[item.supplierKey] : null;
    const supplierId = isNonEmptyString(resolved) ? resolved : null;

    let state;
    try{
      state = await readItemState(db, item);
    }catch(err){
      return Object.assign(base, {action: 'failed', stage: 'read', error: errMsg(err)});
    }

    const plan = classifyItemState(item, state, supplierId);
    if(plan.status === 'conflict') return Object.assign(base, {action: 'conflict', flags: plan.flags});
    if(plan.status === 'complete') return Object.assign(base, {action: 'skipped'});

    if(!supplierId){
      const why = (ctx.supplierFailures && ctx.supplierFailures[item.supplierKey]) || 'no resolved supplier document ID';
      return Object.assign(base, {action: 'supplier_unresolved', needs: plan.status, reason: why});
    }

    let committed;
    try{
      committed = await commitItem(db, item, supplierId, ctx, state);
    }catch(err){
      return Object.assign(base, {action: 'failed', stage: 'transaction', error: errMsg(err)});
    }
    if(committed.outcome === 'conflict') return Object.assign(base, {action: 'conflict', flags: committed.plan.flags, detectedIn: 'transaction'});
    if(committed.outcome === 'noop') return Object.assign(base, {action: 'skipped', detectedIn: 'transaction'});
    const actionByPlan = {create_both: 'created', create_po: 'po_recovered', create_product: 'product_recovered'};
    return Object.assign(base, {action: actionByPlan[committed.plan.status]});
  }

  // ===== Read-only preflight for the single-SKU test =====
  function summarizeProduct(entry){
    if(!entry || !entry.exists) return {exists: false, id: entry ? entry.id : null};
    return {exists: true, id: entry.id, n: entry.data.n === undefined ? null : entry.data.n, sku: entry.data.sku === undefined ? null : entry.data.sku, supplierRef: entry.data.supplierRef === undefined ? null : entry.data.supplierRef};
  }
  function summarizePo(entry){
    if(!entry || !entry.exists) return {exists: false, id: entry ? entry.id : null};
    return {exists: true, id: entry.id, sku: entry.data.sku === undefined ? null : entry.data.sku, productRef: entry.data.productRef === undefined ? null : entry.data.productRef, supplierRef: entry.data.supplierRef === undefined ? null : entry.data.supplierRef};
  }

  // Performs reads only (document gets and where().limit().get()). Never creates a supplier.
  async function preflightSingleSku(db, items, ctx){
    const report = {
      readOnly: true, sku: null, safeToWrite: false, ok: false, plan: null,
      supplier: null, product: null, purchaseOrder: null,
      otherProductsWithSku: [], otherPosWithSku: [],
      flags: [], blockers: [], notes: []
    };
    const allow = validateSingleSkuAllowlist(items);
    if(!allow.ok){
      report.blockers = allow.errors.map(function(m){ return 'ALLOWLIST: ' + m; });
      return report;
    }
    const item = items[0];
    report.sku = item.sku;
    const def = ((ctx && ctx.suppliers) || []).find(function(s){ return s.key === item.supplierKey; });
    if(!def){
      report.blockers.push('SUPPLIER_DEFINITION_MISSING: no supplier definition for key "' + item.supplierKey + '".');
      return report;
    }

    const sup = await resolveSupplier(db, def, {readOnly: true});
    report.supplier = {name: def.name, state: sup.state, id: sup.supplierId || null};
    if(sup.state === 'missing'){
      report.notes.push('Supplier "' + def.name + '" does not exist yet; it would be created at write time. The preflight did not create it.');
    } else if(!sup.ok){
      report.blockers.push('SUPPLIER_' + sup.state.toUpperCase() + ': ' + (sup.error || 'supplier could not be resolved'));
    }

    let state;
    try{
      state = await readItemState(db, item);
    }catch(err){
      report.blockers.push('READ_FAILED: ' + errMsg(err));
      return report;
    }
    report.product = summarizeProduct(state.productById);
    report.purchaseOrder = summarizePo(state.poById);
    report.otherProductsWithSku = state.productsBySku.filter(function(p){ return p.id !== item.sku; }).map(function(p){ return p.id; });
    report.otherPosWithSku = state.posBySku.filter(function(p){ return p.id !== item.poNumber; }).map(function(p){ return p.id; });

    const plan = classifyItemState(item, state, sup.ok ? sup.supplierId : null);
    report.plan = plan.status;
    report.flags = plan.flags;
    plan.flags.forEach(function(f){ report.blockers.push(f.code + ': ' + f.message); });

    if(sup.state === 'missing' && (state.productById.exists || state.poById.exists)){
      report.blockers.push('SUPPLIER_MISSING_BUT_RECORDS_EXIST: the supplier does not exist, but a product or PO for this SKU already does. Manual review required before anything is written.');
    }
    if(plan.status === 'complete') report.notes.push('Product and PO already exist and match; a write run would make no changes.');

    report.safeToWrite = report.blockers.length === 0;
    report.ok = report.safeToWrite;
    return report;
  }

  // ===== Single-SKU write path =====
  // Throws ALLOWLIST_VIOLATION BEFORE any Firestore access when the item list is not
  // exactly [ML-TWL-003] with the Commander-confirmed values.
  async function runSingleSkuImport(db, items, ctx){
    assertSingleSkuAllowlist(items);
    const item = items[0];
    const preflight = await preflightSingleSku(db, items, ctx);
    if(!preflight.safeToWrite){
      return {ok: false, stage: 'preflight', preflight: preflight, result: null, supplier: null};
    }
    const def = ctx.suppliers.find(function(s){ return s.key === item.supplierKey; });
    const supplierSetup = await setUpSuppliers(db, [def], {now: nowFn(ctx)});
    if(!supplierSetup.supplierIdByKey[def.key]){
      return {
        ok: false, stage: 'supplier', preflight: preflight, supplier: supplierSetup,
        result: {sku: item.sku, n: item.n, action: 'supplier_unresolved', reason: supplierSetup.supplierFailures[def.key]}
      };
    }
    const result = await resolveItem(db, item, Object.assign({}, ctx, {
      supplierIdByKey: supplierSetup.supplierIdByKey,
      supplierFailures: supplierSetup.supplierFailures
    }));
    const okActions = ['created', 'po_recovered', 'product_recovered', 'skipped'];
    return {ok: okActions.indexOf(result.action) !== -1, stage: 'write', preflight: preflight, result: result, supplier: supplierSetup};
  }

  return {
    SINGLE_SKU_TEST_ALLOWLIST: SINGLE_SKU_TEST_ALLOWLIST,
    CONFIRMED_SINGLE_SKU_VALUES: CONFIRMED_SINGLE_SKU_VALUES,
    validateSingleSkuAllowlist: validateSingleSkuAllowlist,
    assertSingleSkuAllowlist: assertSingleSkuAllowlist,
    validateItemShape: validateItemShape,
    readItemState: readItemState,
    classifyItemState: classifyItemState,
    resolveSupplier: resolveSupplier,
    setUpSuppliers: setUpSuppliers,
    buildProductData: buildProductData,
    buildPoData: buildPoData,
    resolveItem: resolveItem,
    preflightSingleSku: preflightSingleSku,
    runSingleSkuImport: runSingleSkuImport
  };
});
