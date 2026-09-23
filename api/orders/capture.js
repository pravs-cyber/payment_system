import { supabaseAdmin } from '../../lib/supabaseAdmin.js';
import { paypalRequest } from '../../lib/paypal.js';

const ordersTable = () => supabaseAdmin.schema('public').from('orders');

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { paypalOrderId, localOrderId } = req.body || {};
    if (!paypalOrderId || !localOrderId) {
      return res.status(400).json({ error: 'PayPal order ID and local order ID are required' });
    }

    const { data: order, error: lookupError } = await ordersTable()
      .select('id,total_usd,payment_status,payment_provider,payment_provider_order_id')
      .eq('id', localOrderId)
      .maybeSingle();

    if (lookupError) throw lookupError;
    if (!order) return res.status(404).json({ error: 'Local order was not found' });
    if (order.payment_provider !== 'paypal') return res.status(400).json({ error: 'Order is not a PayPal order' });
    if (order.payment_provider_order_id !== paypalOrderId) {
      return res.status(409).json({ error: 'PayPal order does not match the local order' });
    }

    if (order.payment_status === 'paid') {
      return res.status(200).json({ ok: true, status: 'COMPLETED', alreadyCaptured: true });
    }

    const result = await paypalRequest(`/v2/checkout/orders/${encodeURIComponent(paypalOrderId)}/capture`, {
      method: 'POST',
      headers: { 'PayPal-Request-Id': `capture-${localOrderId}` },
      body: JSON.stringify({})
    });

    const purchaseUnit = result.purchase_units?.[0];
    const capture = purchaseUnit?.payments?.captures?.[0];
    const capturedValue = Number(capture?.amount?.value);
    const expectedValue = Number(order.total_usd);

    if (result.status !== 'COMPLETED' || capture?.status !== 'COMPLETED') {
      await ordersTable().update({ status: 'payment_error' }).eq('id', localOrderId);
      return res.status(402).json({ error: 'PayPal did not complete the payment', status: result.status });
    }

    if (!Number.isFinite(capturedValue) || Math.abs(capturedValue - expectedValue) > 0.001) {
      await ordersTable().update({ status: 'payment_error' }).eq('id', localOrderId);
      return res.status(409).json({ error: 'Captured amount does not match the order total' });
    }

    const { error: updateError } = await ordersTable().update({
      payment_status: 'paid',
      status: 'paid',
      paid_at: new Date().toISOString()
    }).eq('id', localOrderId);

    if (updateError) throw updateError;

    return res.status(200).json({ ok: true, status: 'COMPLETED', captureId: capture.id });
  } catch (error) {
    console.error('Order capture failed:', error);
    return res.status(500).json({ error: error?.message || 'Could not capture payment' });
  }
}
