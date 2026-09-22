import { randomUUID } from 'node:crypto';
import { supabaseAdmin } from '../../lib/supabaseAdmin.js';

const MAX_FILE_SIZE = 50 * 1024 * 1024;
const ALLOWED = new Set([
  'image/jpeg', 'image/png', 'image/webp', 'image/gif',
  'audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/ogg', 'audio/mp4',
  'video/mp4', 'video/webm', 'video/quicktime'
]);

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { orderId, files = [] } = req.body || {};
    if (!orderId || !Array.isArray(files) || files.length > 25) {
      return res.status(400).json({ error: 'Invalid upload request' });
    }

    const { data: order, error: orderError } = await supabaseAdmin
      .from('orders').select('id,payment_status').eq('id', orderId).single();
    if (orderError || !order || order.payment_status !== 'paid') {
      return res.status(403).json({ error: 'Payment must be completed before uploads' });
    }

    const uploads = [];
    for (const file of files) {
      const safeName = String(file.name || 'file').replace(/[^a-zA-Z0-9._-]/g, '_').slice(-120);
      const contentType = String(file.type || 'application/octet-stream');
      const size = Number(file.size || 0);
      if (!safeName || !ALLOWED.has(contentType) || size <= 0 || size > MAX_FILE_SIZE) {
        return res.status(400).json({ error: `Unsupported or oversized file: ${safeName}` });
      }

      const path = `${orderId}/${randomUUID()}-${safeName}`;
      const { data, error } = await supabaseAdmin.storage
        .from('order-media')
        .createSignedUploadUrl(path, { upsert: false });
      if (error) throw error;

      const { error: rowError } = await supabaseAdmin.from('order_media').insert({
        order_id: orderId,
        storage_path: path,
        original_name: safeName,
        media_type: contentType,
        file_size: size
      });
      if (rowError) throw rowError;

      uploads.push({ path, token: data.token, name: safeName, type: contentType });
    }

    return res.status(200).json({ uploads });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Could not prepare uploads' });
  }
}
