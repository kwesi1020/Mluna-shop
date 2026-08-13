const admin = require('firebase-admin');

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT))
  });
}
const db = admin.firestore();

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const { reference, orderId } = req.body || {};
  if (!reference || !orderId) {
    return res.status(400).json({ error: 'Missing reference or orderId' });
  }

  try {
    const orderRef = db.collection('orders').doc(orderId);
    const orderSnap = await orderRef.get();
    if (!orderSnap.exists) {
      return res.status(404).json({ verified: false, error: 'Order not found' });
    }
    const order = orderSnap.data();

    if (order.paymentStatus === 'paid') {
      return res.status(200).json({ verified: true, alreadyProcessed: true });
    }

    const verifyRes = await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`, {
      headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` }
    });
    const verifyData = await verifyRes.json();

    if (!verifyData.status || !verifyData.data || verifyData.data.status !== 'success') {
      return res.status(200).json({ verified: false, status: verifyData.data ? verifyData.data.status : 'unknown' });
    }

    const expectedAmount = Math.round((order.total || 0) * 100);
    if (verifyData.data.amount !== expectedAmount) {
      return res.status(200).json({ verified: false, error: 'Amount mismatch' });
    }

    await orderRef.update({
      paymentStatus: 'paid',
      paymentMethod: 'Paystack',
      paystackRef: verifyData.data.reference,
      paidAt: Date.now(),
      status: order.status === 'pending' ? 'confirmed' : order.status
    });

    return res.status(200).json({ verified: true, reference: verifyData.data.reference });
  } catch (err) {
    return res.status(500).json({ error: 'Verification failed', details: err.message });
  }
};
