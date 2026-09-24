import { supabaseAdmin } from '../../lib/supabaseAdmin.js';

const ordersTable = () => supabaseAdmin.schema('public').from('orders');
const mediaTable = () => supabaseAdmin.schema('public').from('order_media');

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

    // Read the objects that were actually uploaded to this order's private folder.
    const { data: objects, error: listError } = await supabaseAdmin.storage
      .from('order-media')
      .list(`orders/${orderId}`, { limit: 100, sortBy: { column: 'name', order: 'asc' } });
    if (listError) throw listError;

    const uploaded = (objects || []).filter(item => item?.name);
    if (!uploaded.length) {
      return res.status(400).json({ error: 'No uploaded files were found for this order.' });
    }

    const { data: existingRows, error: existingError } = await mediaTable()
      .select('storage_path')
      .eq('order_id', orderId);
    if (existingError) throw existingError;

    const existingPaths = new Set((existingRows || []).map(row => row.storage_path));
    const rows = uploaded
      .map(item => {
        const storagePath = `orders/${orderId}/${item.name}`;
        const metadata = item.metadata || {};
        return {
          order_id: orderId,
          storage_path: storagePath,
          original_name: item.name.length > 37 ? item.name.slice(37) : item.name,
          media_type: metadata.mimetype || metadata.contentType || null
        };
      })
      .filter(row => !existingPaths.has(row.storage_path));

    if (rows.length) {
      const { error: mediaError } = await mediaTable().insert(rows);
      if (mediaError) throw mediaError;
    }

    const { error: orderError } = await ordersTable().update({
      status: 'content_submitted',
      content_status: 'uploaded'
    }).eq('id', orderId);
    if (orderError) throw orderError;

    return res.status(200).json({ ok: true, mediaCount: uploaded.length });
  } catch (error) {
    console.error('Upload completion failed:', error);
    return res.status(500).json({ error: error?.message || 'Could not complete upload' });
  }
}
