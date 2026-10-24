'use strict';
/*
 * Phase 1B regression tests: XSS, attribute/handler injection, malformed values, legitimate content.
 * UNEXECUTED — NOT APPROVED FOR RELEASE. These tests have never been run.
 * Run (Node >= 18):  npm run check && npm test
 * No DOM dependency: output of our own templates is checked with tests/helpers/html-tokens.js,
 * which is a strict purpose-built tokenizer, not a full HTML5 parser.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const RS = require('../lib/render-safety.js');
const { tokenize } = require('./helpers/html-tokens.js');

const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
function mainScript(file, marker){
  const re = /<script>([\s\S]*?)<\/script>/g;
  let m;
  while((m = re.exec(read(file))) !== null){ if(m[1].indexOf(marker) !== -1) return m[1]; }
  throw new Error('script not found in ' + file);
}

const PAYLOADS = [
  '<img src=x onerror=alert(1)>',
  '"><svg onload=alert(1)>',
  "');alert(1);//",
  "\\');alert(1);//",
  '" onmouseover="alert(1)',
  'x" style="background:url(javascript:alert(1))',
  '</script><script>alert(1)</script>',
  '&lt;b&gt;',
  'a&b "c" \'d\' <e>',
  '<!-- x -->',
  'javascript:alert(1)',
  '\u202eRTL',
  'A'.repeat(5000),
  '__proto__',
  'constructor'
];

const ALLOWED = new Set(['div', 'span', 'strong', 'br', 'img', 'h3', 'select', 'option', 'button', 'p', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'h2']);
const GOOD_URL = /^(https:\/\/|assets\/)/;

function assertSafe(html, label){
  const t = tokenize(html);
  assert.deepEqual(t.errors, [], label + ': ' + t.errors.join('; '));
  t.tags.forEach(tag => {
    assert.notEqual(tag.name, '#comment', label + ': unexpected comment');
    assert.ok(ALLOWED.has(tag.name), label + ': unexpected <' + tag.name + '>');
    Object.keys(tag.attrs).forEach(a => {
      const v = tag.attrs[a];
      assert.ok(!/^on/.test(a), label + ': inline handler attribute ' + a);
      if(a === 'src') assert.match(v, GOOD_URL, label + ': unsafe src');
      if(a === 'class') assert.match(v, /^[A-Za-z0-9_\- ]*$/, label + ': unsafe class');
      if(a === 'style'){
        assert.ok(!/javascript:/i.test(v), label + ': unsafe style');
        const m = /url\('([^']*)'\)/.exec(v);
        if(m) assert.match(m[1], GOOD_URL, label + ': unsafe style url');
      }
    });
  });
  return t;
}

function fakeEl(){
  return {
    style: {}, dataset: {}, classList: { add(){}, remove(){}, toggle(){}, contains(){ return false; } },
    innerHTML: '', textContent: '', value: '', options: [], src: '', className: '', disabled: false, tagName: 'DIV',
    focus(){}, appendChild(){}, remove(){}, addEventListener(){}, querySelectorAll(){ return []; },
    querySelector(){ return fakeEl(); }, scrollIntoView(){}, setAttribute(){}
  };
}
function loadPage(file, marker){
  const els = {}, listeners = {};
  const sb = {
    window: { addEventListener(){}, scrollTo(){}, scrollY: 0 },
    document: {
      getElementById(id){ return els[id] || (els[id] = fakeEl()); },
      querySelector(){ return fakeEl(); }, querySelectorAll(){ return []; }, createElement(){ return fakeEl(); },
      body: { appendChild(){} }, hidden: false,
      addEventListener(type, fn){ (listeners[type] = listeners[type] || []).push(fn); }
    },
    location: { hash: '', pathname: '/', search: '' }, history: { pushState(){} },
    sessionStorage: { getItem(){ return null; }, setItem(){} },
    fbq(){}, gtag(){}, PaystackPop: { setup(){ return { openIframe(){} }; } },
    alert(m){ sb.__alerts.push(String(m)); }, prompt(){ return null; }, confirm(){ return false; }, console,
    setTimeout(){ return 0; }, clearTimeout(){}, fetch(){ return Promise.reject(new Error('network disabled in tests')); }, URL,
    RenderSafety: RS, __alerts: [], __calls: []
  };
  vm.createContext(sb);
  vm.runInContext(mainScript(file, marker), sb, { filename: file + '#main' });
  return { ctx: sb, els: els, listeners: listeners, run: code => vm.runInContext(code, sb) };
}
const click = (pg, dataset, tag) => pg.listeners.click[0]({
  target: { tagName: tag || 'BUTTON', dataset: dataset, closest(){ return this; } },
  stopPropagation(){}
});

test('render-safety helpers', () => {
  assert.equal(RS.esc('<a href="x">&\'</a>'), '&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;');
  assert.equal(RS.esc(null), '');
  assert.equal(RS.esc(undefined), '');
  assert.equal(RS.esc(5), '5');
  ['javascript:alert(1)', 'data:text/html,x', '//evil.com/a.png', 'http://x.com/a.png', 'https://', 'assets/../x.png', 'assets/a b.png',
   'https://x.com/a"b', 'https://x.com/a(b)', 'https://x.com/a\\b', ' ', 5, null, {}].forEach(u => assert.equal(RS.safeUrl(u), '', String(u)));
  assert.equal(RS.safeUrl('https://res.cloudinary.com/demo/image/upload/v1/a.jpg'), 'https://res.cloudinary.com/demo/image/upload/v1/a.jpg');
  assert.equal(RS.safeUrl('assets/hero-skin.jpg'), 'assets/hero-skin.jpg');
  [NaN, Infinity, -Infinity, '5', null, undefined, {}, [], true].forEach(v => assert.equal(RS.num(v), null));
  assert.equal(RS.num(0), 0);
  assert.equal(RS.num(-1), -1);
  ['5', -1, NaN, 1e21, null].forEach(v => assert.equal(RS.money(v), 'Invalid amount'));
  assert.equal(RS.money(81), 'GHC 81.00');
  assert.equal(RS.money(0), 'GHC 0.00');
  [0, 6, -1, 1e9, NaN, 5.5, '5', null].forEach(v => assert.equal(RS.rating(v), null));
  [1, 5].forEach(v => assert.equal(RS.rating(v), v));
});

function hostileProduct(p){
  return {
    n: p, note: p, price: 10, old: 12, images: [p],
    variants: [{ color: p, image: p }, { color: 'Blue', image: 'https://res.cloudinary.com/demo/a.jpg' }],
    optionGroups: [{ name: p, choices: [p, 'ok'] }, { name: 'Many', choices: Array.from({ length: 10 }, (_, k) => k === 0 ? p : 'c' + k) }],
    status: 'in_stock', quantity: null, comboStock: {}, archived: false, starterKey: null, docId: 'x', isStarter: false
  };
}
const store = (pg, products) => { pg.ctx.__data = products; pg.run('PRODUCTS = __data; selectedVariantIndex = {}; selectedOptionChoice = {};'); };

test('storefront: all 29 legitimate starter cards render intact', () => {
  const pg = loadPage('index.html', 'function productCardHtml');
  const defs = pg.run('DEFAULT_PRODUCTS');
  let n = 0;
  Object.keys(defs).forEach(cat => defs[cat].forEach((p, i) => {
    n++;
    const t = assertSafe(pg.run('productCardHtml(' + JSON.stringify(cat) + ', ' + i + ')'), cat + '-' + i);
    assert.ok(t.text.includes(p.n), 'name ' + p.n);
    assert.ok(t.text.includes(p.note), 'note ' + p.note);
    assert.ok(t.text.includes('GHC ' + p.price.toFixed(2)), 'price');
    assert.ok(t.text.includes('GHC ' + p.old.toFixed(2)), 'old price');
    assert.ok(t.text.includes('Secure Your Piece'), 'button label');
  }));
  assert.equal(n, 29);
});

test('storefront: hostile product fields stay inert and exact', () => {
  const pg = loadPage('index.html', 'function productCardHtml');
  PAYLOADS.forEach(pl => {
    store(pg, { skin: [hostileProduct(pl)] });
    const t = assertSafe(pg.run("productCardHtml('skin', 0)"), pl.slice(0, 30));
    assert.ok(t.text.some(x => x.includes(pl)), 'text fidelity');
    assert.ok(t.tags.some(g => g.attrs['data-choice'] === pl), 'pill data-choice exact');
    assert.ok(t.tags.some(g => g.name === 'option' && g.attrs.value === pl), 'option value exact');
  });
});

test('storefront: invalid prices are never shown as zero and cannot be added', () => {
  const pg = loadPage('index.html', 'function productCardHtml');
  [NaN, Infinity, -1, '5abc', null, undefined, {}].forEach(price => {
    store(pg, { skin: [Object.assign(hostileProduct('Ok'), { price: price, old: price })] });
    const html = pg.run("productCardHtml('skin', 0)");
    const t = assertSafe(html, 'price');
    assert.ok(t.text.includes('Price unavailable'));
    assert.ok(t.text.includes('Unavailable'));
    assert.ok(!html.includes('GHC 0.00'));
    assert.ok(t.tags.some(g => g.name === 'button' && 'disabled' in g.attrs));
  });
});

test('storefront: delegated handlers pass exact data and ignore forged categories', () => {
  const pg = loadPage('index.html', 'function productCardHtml');
  store(pg, { skin: [hostileProduct(PAYLOADS[3])] });
  pg.run('selectOptionChoice = function(){ __calls.push(Array.from(arguments).slice(0, 4)); };');
  click(pg, { act: 'option-pill', cat: 'skin', i: '0', gi: '0', choice: PAYLOADS[3] }, 'SPAN');
  assert.deepEqual(pg.ctx.__calls, [['skin', 0, 0, PAYLOADS[3]]]);
  click(pg, { act: 'option-pill', cat: 'constructor', i: '0', gi: '0', choice: 'x' }, 'SPAN');
  click(pg, { act: 'option-pill', cat: 'skin', i: '9', gi: '0', choice: 'x' }, 'SPAN');
  assert.equal(pg.ctx.__calls.length, 1);
});

test('storefront: cart and search render hostile data inertly', () => {
  const pg = loadPage('index.html', 'function productCardHtml');
  PAYLOADS.forEach(pl => {
    pg.ctx.__n = pl;
    pg.run("for(const k of Object.keys(cart)) delete cart[k]; cart['skin|0|c:' + __n] = {n: __n, price: 10, image: __n, qty: 1, color: __n, options: {Size: __n}}; renderCart();");
    const t = assertSafe(pg.els.drawerItems.innerHTML, 'cart');
    assert.ok(t.tags.some(g => g.attrs['data-key'] === 'skin|0|c:' + pl), 'cart key exact');
    pg.run('renderSearchResults(__n)');
    assertSafe(pg.els.searchResults.innerHTML, 'search');
  });
});

test('storefront: malformed reviews and prototype routes do not break rendering', () => {
  const pg = loadPage('index.html', 'function productCardHtml');
  pg.ctx.__r = [
    { rating: 5, comment: '<b>hi</b>', name: 'A', createdAt: 1 }, { rating: -1, comment: 'x', name: 'B' },
    { rating: 1e9, comment: 'x', name: 'C' }, { rating: NaN, comment: 'x', name: 'D' },
    { rating: 4, comment: null, name: 'E' }, { rating: '5', comment: 'x', name: 'F' }
  ];
  pg.run('REVIEWS = __r;');
  assert.doesNotThrow(() => pg.run('renderReviewsSection()'));
  const t = assertSafe(pg.els.reviewsList.innerHTML, 'reviews');
  assert.equal(t.tags.filter(g => g.name === 'div' && /review-card/.test(g.attrs.class || '')).length, 1);
  assert.ok(t.text.some(x => x.includes('<b>hi</b>')));
  ['#constructor', '#__proto__', '#toString'].forEach(h => {
    pg.ctx.location.hash = h;
    assert.doesNotThrow(() => pg.run('handleRoute()'));
  });
});

const order = (pl, over) => Object.assign({
  docId: 'o1', customerName: pl, phone: pl, address: pl,
  items: [{ name: pl, qty: 2, price: 23, image: pl, color: pl, options: { Size: pl } }],
  subtotal: 46, delivery: 35, total: 81, createdAt: Date.now(), status: pl, paymentStatus: pl, paymentMethod: pl, channel: 'whatsapp'
}, over || {});
const adminPage = () => loadPage('admin.html', 'function importBatch1');

test('admin: hostile public order, lead, review and invoice data is inert and exact', () => {
  const pg = adminPage();
  PAYLOADS.forEach(pl => {
    pg.ctx.__d = [order(pl, { docId: pl })];
    pg.ctx.__l = [{ name: pl, email: pl, phone: pl, source: 'newsletter' }];
    pg.ctx.__v = [{ docId: pl, rating: 3, comment: pl, name: pl, product: pl, status: pl }];
    pg.run('ORDERS = __d; LEADS = __l; REVIEWS_ADMIN = __v; renderOrdersList(); renderOrdersPageList(); renderLeadsList(); renderReviewsAdminList(); renderInvoiceContent(ORDERS[0]);');
    ['ordersList', 'ordersPageList', 'colourOrdersList', 'leadsList', 'reviewsAdminList', 'invoiceArea', 'analyticsBestSellers', 'profitTableBody']
      .forEach(id => assertSafe(pg.els[id].innerHTML, id));
    assert.ok(tokenize(pg.els.ordersPageList.innerHTML).tags.some(g => g.attrs['data-id'] === pl), 'docId exact');
    assert.ok(tokenize(pg.els.leadsList.innerHTML).text.some(x => x.includes(pl)), 'lead text exact');
  });
});

test('admin: invalid financial values are flagged, excluded and never shown as zero', () => {
  const pg = adminPage();
  const bad = [NaN, Infinity, -1, '81', null, undefined, {}, [], 1e21];
  pg.ctx.__d = bad.map((t, k) => order('Ama', { docId: 'bad' + k, total: t, status: 'pending', paymentStatus: 'unpaid', items: [{ name: 'X', qty: '2', price: null }] }))
    .concat([order('Kofi', { docId: 'good', status: 'pending', paymentStatus: 'unpaid', items: [{ name: 'Y', qty: 2, price: 23 }] })]);
  pg.run('ORDERS = __d;');
  assert.doesNotThrow(() => pg.run('renderOrdersList(); renderOrdersPageList(); renderInvoiceContent(ORDERS[0]);'));
  assert.equal(pg.els.ordersList.innerHTML.split('Invalid total').length - 1, bad.length);
  assert.equal(pg.els.ordersList.innerHTML.split('GHC 81.00').length - 1, 1);
  assert.equal(pg.els.statTotalRevenue.textContent, 'GHC 81.00');
  assert.equal(String(pg.els.statTotalOrders.textContent), '1');
  assert.equal(pg.els.analyticsInvalidNote.style.display, 'block');
  pg.run("notifyCustomer('bad0'); convertOrderToDebtor('bad0');");
  assert.equal(pg.ctx.__alerts.length, 2);
});

test('admin: __proto__ item names cannot pollute Object.prototype', () => {
  const pg = adminPage();
  pg.ctx.__d = [order('A', { status: 'pending', paymentStatus: 'unpaid', items: [{ name: '__proto__', qty: 1, price: 5 }] })];
  pg.run('ORDERS = __d; renderAnalytics(); renderProfitability();');
  assert.equal(({}).sales, undefined);
  assert.equal(({}).units, undefined);
  assert.equal(Object.prototype.hasOwnProperty.call(Object.prototype, 'sales'), false);
});

test('admin: malformed review ratings do not break the list', () => {
  const pg = adminPage();
  pg.ctx.__v = [-1, 1e9, NaN, '5', 5.5, null, 3].map((r, k) => ({ docId: 'r' + k, rating: r, comment: 'c', name: 'n', status: 'pending' }));
  pg.run('REVIEWS_ADMIN = __v;');
  assert.doesNotThrow(() => pg.run('renderReviewsAdminList()'));
  assert.equal(pg.els.reviewsAdminList.innerHTML.split('Invalid rating').length - 1, 6);
});

test('admin: delegated actions pass exact ids and reject forged input', () => {
  const pg = adminPage();
  pg.ctx.__calls = [];
  pg.run("deleteOrder = function(id){ __calls.push(['del', id]); }; setReviewStatus = function(id, s){ __calls.push(['rs', id, s]); }; adjustComboQty = function(){ __calls.push(['combo']); };");
  click(pg, { act: 'order-delete', id: PAYLOADS[0] });
  assert.deepEqual(pg.ctx.__calls[0], ['del', PAYLOADS[0]]);
  click(pg, { act: 'review-status', id: 'r1', status: 'javascript' });
  assert.equal(pg.ctx.__calls.length, 1);
  click(pg, { act: 'review-status', id: 'r1', status: 'approved' });
  assert.deepEqual(pg.ctx.__calls[1], ['rs', 'r1', 'approved']);
  click(pg, { act: 'combo-adjust', cat: 'constructor', i: '0', key: 'k', delta: '1' });
  assert.equal(pg.ctx.__calls.length, 2);
});

test('admin: hostile product data renders inertly; legitimate order renders intact', () => {
  const pg = adminPage();
  PAYLOADS.forEach(pl => {
    pg.ctx.__d = { skin: [Object.assign(hostileProduct(pl), { sku: pl, priceStatus: pl, auditNote: pl, comboStock: { ['Size:' + pl]: 3 } })] };
    pg.run('PRODUCTS = __d; renderAdminList();');
    assertSafe(pg.els.adminProductList.innerHTML, 'adminList');
  });
  pg.ctx.__d = [order('Ama Mensah', { docId: 'o9', status: 'pending', paymentStatus: 'unpaid', address: 'Makavo Junction, Accra-Lome Rd', items: [{ name: 'Sadoer Combo Lip & Eye Mask', qty: 2, price: 23 }] })];
  pg.run('ORDERS = __d; renderOrdersList(); renderInvoiceContent(ORDERS[0]);');
  const t = assertSafe(pg.els.ordersList.innerHTML, 'legit');
  assert.ok(t.text.includes('Ama Mensah'));
  assert.ok(t.text.some(x => x.includes('Sadoer Combo Lip & Eye Mask x2')));
  assert.ok(t.text.includes('GHC 81.00'));
});

test('static: no data-derived inline handlers remain in either page', () => {
  [['index.html', 'function productCardHtml'], ['admin.html', 'function importBatch1']].forEach(([f, m]) => {
    (mainScript(f, m).match(/\bon[a-z]+="[^"]*"/g) || []).filter(a => a.includes('${')).forEach(a =>
      (a.match(/\$\{[^}]*\}/g) || []).forEach(x => assert.match(x, /^\$\{(idx|i)\}$/, f + ': ' + a)));
  });
  ['index.html', 'admin.html'].forEach(f => assert.ok(read(f).includes('<script src="lib/render-safety.js"></script>'), f));
});
