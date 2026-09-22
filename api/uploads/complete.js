import { supabaseAdmin } from '../../lib/supabaseAdmin.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const { orderId } = req.body || {};
    if (!orderId) return res.status(400).json({ error: 'orderId is required' });

    const { error } = await supabaseAdmin.from('orders').update({
      status: 'ready_for_build',
      content_status: 'submitted'
    }).eq('id', orderId).eq('payment_status', 'paid');
    if (error) throw error;

    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Could not complete upload step' });
  }
}
