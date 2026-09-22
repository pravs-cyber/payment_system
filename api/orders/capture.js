import { paypalRequest } from '../../lib/paypal.js';
import { supabaseAdmin } from '../../lib/supabaseAdmin.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { paypalOrderId, localOrderId } = req.body || {};
    if (!paypalOrderId || !localOrderId) return res.status(400).json({ error: 'Order IDs are required' });

    const { data: order, error: lookupError } = await supabaseAdmin
      .from('orders')
      .select('id,payment_provider_order_id,total_usd,payment_status')
      .eq('id', localOrderId)
      .single();

    if (lookupError || !order || order.payment_provider_order_id !== paypalOrderId) {
      return res.status(404).json({ error: 'Order not found' });
    }

    if (order.payment_status === 'paid') {
      return res.status(200).json({ ok: true, status: 'COMPLETED', localOrderId });
    }

    const capture = await paypalRequest(`/v2/checkout/orders/${paypalOrderId}/capture`, {
      method: 'POST',
      headers: { 'PayPal-Request-Id': `capture-${localOrderId}-${paypalOrderId}` }
    });

    const completed = capture.status === 'COMPLETED';
    if (completed) {
      const capturedValue = Number(
        capture.purchase_units?.[0]?.payments?.captures?.[0]?.amount?.value || 0
      );
      if (capturedValue !== Number(order.total_usd)) {
        throw new Error('Captured amount does not match the order total');
      }

      await supabaseAdmin.from('orders').update({
        payment_status: 'paid',
        status: 'paid_content_pending',
        paid_at: new Date().toISOString()
      }).eq('id', localOrderId);
    }

    return res.status(200).json({ ok: completed, status: capture.status, localOrderId });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Could not capture payment' });
  }
}
