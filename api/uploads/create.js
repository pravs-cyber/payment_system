import { randomUUID } from 'node:crypto';
import { supabaseAdmin } from '../../lib/supabaseAdmin.js';

const ordersTable = () => supabaseAdmin.schema('public').from('orders');
const MAX_FILE_SIZE = 50 * 1024 * 1024;
const MAX_FILES = 30;
const ALLOWED_TYPES = /^(image\/|audio\/|video\/)/i;

function safeName(name) {
  return String(name || 'file').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { orderId, files = [] } = req.body || {};
    if (!orderId) return res.status(400).json({ error: 'Order ID is required' });
    if (!Array.isArray(files) || files.length < 1 || files.length > MAX_FILES) {
      return res.status(400).json({ error: `Choose between 1 and ${MAX_FILES} files` });
    }

    const { data: order, error: orderError } = await ordersTable()
      .select('id,payment_status')
      .eq('id', orderId)
      .maybeSingle();
    if (orderError) throw orderError;
    if (!order) return res.status(404).json({ error: 'Order was not found' });
    if (order.payment_status !== 'paid') return res.status(402).json({ error: 'Payment must be completed before uploading media' });

    for (const file of files) {
      if (!file?.name || !file?.type || !ALLOWED_TYPES.test(file.type)) {
        return res.status(400).json({ error: 'Only image, audio and video files are allowed' });
      }
      if (!Number.isFinite(Number(file.size)) || Number(file.size) <= 0 || Number(file.size) > MAX_FILE_SIZE) {
        return res.status(400).json({ error: 'Each file must be 50 MB or smaller' });
      }
    }

    const bucket = supabaseAdmin.storage.from('order-media');
    const uploads = [];
    for (const file of files) {
      const path = `orders/${orderId}/${randomUUID()}-${safeName(file.name)}`;
      const { data, error } = await bucket.createSignedUploadUrl(path);
      if (error) throw error;
      uploads.push({ path, token: data.token });
    }

    return res.status(200).json({ uploads });
  } catch (error) {
    console.error('Upload preparation failed:', error);
    return res.status(500).json({ error: error?.message || 'Could not prepare uploads' });
  }
}
