/**
 * NEXT-JENN — VIDEO UPLOAD HANDLER
 * Receives candidate response videos and stores in Cloudflare R2
 *
 * Install: npm install multer @aws-sdk/client-s3 @aws-sdk/s3-request-presigner
 */

const express = require('express');
const multer  = require('multer');
const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const router  = express.Router();

// ── CLOUDFLARE R2 CLIENT ──────────────────────────────────────
const r2 = new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId:     process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

const BUCKET        = process.env.R2_BUCKET_NAME;
const R2_PUBLIC_URL = process.env.R2_PUBLIC_URL;

// ── MULTER — MEMORY STORAGE ───────────────────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 150 * 1024 * 1024 }, // 150MB max
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('video/') || file.mimetype === 'audio/webm') {
      cb(null, true);
    } else {
      cb(new Error('Video files only'), false);
    }
  },
});

// ── ROUTE: Upload candidate response video ────────────────────
// POST /api/upload/response-video
//
// Body (multipart):
//   video:         video blob
//   session_id:    string
//   segment_index: number
// ─────────────────────────────────────────────────────────────
router.post('/response-video', upload.single('video'), async (req, res) => {
  try {
    const { session_id, segment_index } = req.body;
    const file = req.file;

    if (!file) {
      return res.status(400).json({ error: 'No video file received' });
    }

    // Build R2 key — organized by session
    const timestamp = Date.now();
    const ext       = file.originalname.split('.').pop() || 'webm';
    const r2Key     = `responses/${session_id}/seg${segment_index}_${timestamp}.${ext}`;

    // Upload to R2
    await r2.send(new PutObjectCommand({
      Bucket:      BUCKET,
      Key:         r2Key,
      Body:        file.buffer,
      ContentType: file.mimetype,
      Metadata: {
        session_id:    session_id,
        segment_index: String(segment_index),
      },
    }));

    // Build public URL
    const videoUrl = `${R2_PUBLIC_URL}/${r2Key}`;

    console.log(`Video uploaded: ${r2Key} (${(file.size / 1024 / 1024).toFixed(1)}MB)`);

    res.json({
      success:   true,
      video_url: videoUrl,
      r2_key:    r2Key,
      size_bytes: file.size,
    });

  } catch (err) {
    console.error('R2 upload error:', err);
    res.status(500).json({ error: 'Upload failed', details: err.message });
  }
});

// ── Generate signed URL for private bucket access ─────────────
async function generateSignedUrl(r2Key, expiresInSeconds = 604800) {
  const command = new GetObjectCommand({ Bucket: BUCKET, Key: r2Key });
  return getSignedUrl(r2, command, { expiresIn: expiresInSeconds });
}

module.exports = router;
module.exports.generateSignedUrl = generateSignedUrl;
