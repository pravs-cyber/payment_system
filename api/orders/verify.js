import crypto from 'node:crypto';
import { supabaseAdmin } from '../../lib/supabaseAdmin.js';
import { razorpayRequest } from '../../lib/razorpay.js';

const ordersTable = () => supabaseAdmin.schema('public').from('orders');

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const {
      razorpay_order_id: razorpayOrderId,
      razorpay_payment_id: razorpayPaymentId,
      razorpay_signature: razorpaySignature,
      localOrderId
    } = req.body || {};

    if (!razorpayOrderId || !razorpayPaymentId || !razorpaySignature || !localOrderId) {
      return res.status(400).json({ error: 'Missing Razorpay payment verification fields' });
    }

    const { data: localOrder, error: orderError } = await ordersTable()
      .select('id,payment_provider,payment_provider_order_id,payment_status')
      .eq('id', localOrderId)
      .maybeSingle();

    if (orderError) throw orderError;
    if (!localOrder) return res.status(404).json({ error: 'Local order not found' });
    if (localOrder.payment_provider !== 'razorpay') {
      return res.status(400).json({ error: 'Order is not a Razorpay order' });
    }
    if (localOrder.payment_provider_order_id !== razorpayOrderId) {
      return res.status(400).json({ error: 'Razorpay order does not match this order' });
    }

    const secret = process.env.RAZORPAY_KEY_SECRET?.trim();
    if (!secret) throw new Error('RAZORPAY_KEY_SECRET is missing from Vercel Environment Variables');

    const expected = crypto
      .createHmac('sha256', secret)
      .update(`${razorpayOrderId}|${razorpayPaymentId}`)
      .digest('hex');

    const expectedBuffer = Buffer.from(expected, 'utf8');
    const receivedBuffer = Buffer.from(String(razorpaySignature), 'utf8');
    if (expectedBuffer.length !== receivedBuffer.length || !crypto.timingSafeEqual(expectedBuffer, receivedBuffer)) {
      return res.status(400).json({ error: 'Invalid Razorpay payment signature' });
    }

    const payment = await razorpayRequest(`/payments/${encodeURIComponent(razorpayPaymentId)}`);
    if (payment.order_id !== razorpayOrderId) {
      return res.status(400).json({ error: 'Payment does not belong to the expected Razorpay order' });
    }

    let finalStatus = payment.status;
    if (payment.status === 'authorized') {
      await razorpayRequest(`/payments/${encodeURIComponent(razorpayPaymentId)}/capture`, {
        method: 'POST',
        body: JSON.stringify({ amount: payment.amount, currency: payment.currency })
      });
      finalStatus = 'captured';
    }

    if (finalStatus !== 'captured') {
      return res.status(400).json({ error: `Payment is not captured (status: ${finalStatus})` });
    }

    const { error: updateError } = await ordersTable()
      .update({
        payment_status: 'paid',
        status: 'paid'
      })
      .eq('id', localOrderId);

    if (updateError) throw updateError;

    return res.status(200).json({ ok: true, localOrderId, paymentId: razorpayPaymentId });
  } catch (error) {
    console.error('Razorpay verification failed:', error);
    return res.status(500).json({ error: error?.message || 'Could not verify Razorpay payment' });
  }
}
