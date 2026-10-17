'use strict';
/*
 * In-memory fake of the small Firestore compat surface that lib/import-safety.js uses.
 * UNEXECUTED — NOT APPROVED FOR LIVE IMPORT.
 *
 * IMPORTANT LIMIT: this fake models transactions as "buffer tx.set() calls, apply them all at
 * commit, discard them on error". It verifies that OUR CODE routes the product + PO writes through
 * a single transaction and re-validates inside it. It does NOT prove anything about real
 * Firestore transaction semantics, contention retries, security rules, or latency.
 */

function clone(v){ return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); }
const WRITE_OPS = ['add', 'set', 'update', 'delete', 'tx-set', 'commit'];

class FakeFirestore {
  constructor(){
    this.store = new Map();
    this.autoIdCounter = 0;
    this.ops = [];                 // every attempted operation, in order
    this.failures = [];            // injected failures
    this.writesBlocked = false;    // when true, any write attempt throws
    this.beforeTransaction = null; // hook(db): simulate a concurrent writer racing the transaction
  }

  // ----- test helpers -----
  _col(name){ if(!this.store.has(name)) this.store.set(name, new Map()); return this.store.get(name); }
  _put(col, id, data){ this._col(col).set(id, clone(data)); }
  seed(col, id, data){ this._put(col, id, data); return this; }
  dump(col){ const out = {}; this._col(col).forEach((v, k) => { out[k] = clone(v); }); return out; }
  count(col){ return this._col(col).size; }
  writeOps(){ return this.ops.filter(o => WRITE_OPS.includes(o.op)); }
  blockWrites(){ this.writesBlocked = true; return this; }
  injectFailure(spec){
    this.failures.push({
      op: spec.op,
      collection: spec.collection || null,
      error: spec.error || new Error('injected failure'),
      times: spec.times === undefined ? 1 : spec.times
    });
    return this;
  }
  _maybeFail(op, col){
    for(const f of this.failures){
      if(f.times > 0 && f.op === op && (!f.collection || f.collection === col)){
        f.times -= 1;
        throw f.error;
      }
    }
  }
  _assertWritable(){
    if(this.writesBlocked) throw new Error('WRITE_BLOCKED: a write was attempted while writes were blocked');
  }
  _snap(col, id){
    const m = this._col(col);
    const exists = m.has(id);
    return {id: id, exists: exists, data: () => (exists ? clone(m.get(id)) : undefined)};
  }

  // ----- Firestore-like API -----
  collection(name){
    const db = this;
    return {
      doc(id){ return db._docRef(name, id); },
      where(field, opStr, value){ return db._query(name, [{field: field, opStr: opStr, value: value}], null); },
      async add(data){
        db.ops.push({op: 'add', collection: name, inTx: false});
        db._assertWritable();
        db._maybeFail('add', name);
        db.autoIdCounter += 1;
        const id = 'auto' + db.autoIdCounter;
        db._put(name, id, data);
        return {id: id};
      }
    };
  }

  _docRef(col, id){
    const db = this;
    return {
      id: id, path: col + '/' + id, _col: col,
      async get(){
        db.ops.push({op: 'get', collection: col, id: id, inTx: false});
        db._maybeFail('get', col);
        return db._snap(col, id);
      },
      async set(data){
        db.ops.push({op: 'set', collection: col, id: id, inTx: false});
        db._assertWritable();
        db._maybeFail('set', col);
        db._put(col, id, data);
      },
      async update(){
        db.ops.push({op: 'update', collection: col, id: id, inTx: false});
        db._assertWritable();
        throw new Error('update() is not implemented in the fake');
      },
      async delete(){
        db.ops.push({op: 'delete', collection: col, id: id, inTx: false});
        db._assertWritable();
        throw new Error('delete() is not implemented in the fake');
      }
    };
  }

  _query(col, filters, lim){
    const db = this;
    return {
      where(field, opStr, value){ return db._query(col, filters.concat([{field: field, opStr: opStr, value: value}]), lim); },
      limit(n){ return db._query(col, filters, n); },
      async get(){
        db.ops.push({op: 'query', collection: col, inTx: false});
        db._maybeFail('query', col);
        let docs = [];
        db._col(col).forEach((data, id) => {
          const match = filters.every(f => {
            if(f.opStr !== '==') throw new Error('Only == is supported by the fake');
            return data[f.field] === f.value;
          });
          if(match) docs.push({id: id, exists: true, data: () => clone(data)});
        });
        if(lim !== null && lim !== undefined) docs = docs.slice(0, lim);
        return {docs: docs, size: docs.length, empty: docs.length === 0, forEach: fn => docs.forEach(fn)};
      }
    };
  }

  async runTransaction(fn){
    const db = this;
    db.ops.push({op: 'tx-begin', inTx: true});
    if(typeof db.beforeTransaction === 'function'){
      const hook = db.beforeTransaction;
      db.beforeTransaction = null;
      hook(db);
    }
    const buffered = [];
    const tx = {
      async get(ref){
        db.ops.push({op: 'get', collection: ref._col, id: ref.id, inTx: true});
        db._maybeFail('get', ref._col);
        return db._snap(ref._col, ref.id);
      },
      set(ref, data){
        db.ops.push({op: 'tx-set', collection: ref._col, id: ref.id, inTx: true});
        db._assertWritable();
        buffered.push({col: ref._col, id: ref.id, data: clone(data)});
        return tx;
      }
    };
    let result;
    try{
      result = await fn(tx);
    }catch(err){
      db.ops.push({op: 'tx-rollback', inTx: true});
      throw err;
    }
    db.ops.push({op: 'commit', inTx: true});
    try{
      db._maybeFail('commit', null);
    }catch(err){
      db.ops.push({op: 'tx-rollback', inTx: true});
      throw err;
    }
    buffered.forEach(w => db._put(w.col, w.id, w.data));
    return result;
  }
}

module.exports = { FakeFirestore };
