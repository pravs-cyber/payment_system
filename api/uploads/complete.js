import { supabaseAdmin } from '../../lib/supabaseAdmin.js';

const ordersTable = () => supabaseAdmin.schema('public').from('orders');

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { orderId } = req.body || {};
    if (!orderId) return res.status(400).json({ error: 'Order ID is required' });

    const { data: order, error: lookupError } = await ordersTable()
      .select('id,payment_status')
      .eq('id', orderId)
      .maybeSingle();
    if (lookupError) throw lookupError;
    if (!order) return res.status(404).json({ error: 'Order was not found' });
    if (order.payment_status !== 'paid') return res.status(402).json({ error: 'Payment must be completed first' });

    const { error } = await ordersTable().update({
      status: 'content_submitted',
      content_status: 'uploaded'
    }).eq('id', orderId);
    if (error) throw error;

    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error('Upload completion failed:', error);
    return res.status(500).json({ error: error?.message || 'Could not complete upload' });
  }
}
