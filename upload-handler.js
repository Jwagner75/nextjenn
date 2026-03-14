/**
 * NEXT-JENN — VIDEO UPLOAD HANDLER (original working version)
 */
const express = require('express');
const multer  = require('multer');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const router  = express.Router();

const r2 = new S3Client({
  region:   'auto',
  endpoint: 'https://' + process.env.R2_ACCOUNT_ID + '.r2.cloudflarestorage.com',
  credentials: {
    accessKeyId:     process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

const BUCKET        = process.env.R2_BUCKET_NAME;
const R2_PUBLIC_URL = process.env.R2_PUBLIC_URL;

const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 150 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('video/') || file.mimetype === 'audio/webm') cb(null, true);
    else cb(new Error('Video files only'), false);
  },
});

router.post('/response-video', upload.single('video'), async (req, res) => {
  try {
    const { session_id, segment_index } = req.body;
    const file = req.file;

    if (!file) return res.status(400).json({ error: 'No video file received' });

    const timestamp = Date.now();
    const ext       = file.originalname.split('.').pop() || 'webm';
    const r2Key     = 'responses/' + session_id + '/seg' + segment_index + '_' + timestamp + '.' + ext;

    await r2.send(new PutObjectCommand({
      Bucket:      BUCKET,
      Key:         r2Key,
      Body:        file.buffer,
      ContentType: file.mimetype,
    }));

    const videoUrl = R2_PUBLIC_URL + '/' + r2Key;
    console.log('Video uploaded: ' + r2Key + ' (' + (file.size/1024/1024).toFixed(1) + 'MB)');

    res.json({ success: true, video_url: videoUrl, r2_key: r2Key });

  } catch (err) {
    console.error('R2 upload error:', err.message);
    res.status(500).json({ error: 'Upload failed', details: err.message });
  }
});

module.exports = router;
