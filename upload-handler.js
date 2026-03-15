/**
 * NEXT-JENN — VIDEO UPLOAD HANDLER
 */

'use strict';

const express  = require('express');
const multer   = require('multer');
const tracker  = require('./server-tracker');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const router   = express.Router();

const r2 = new S3Client({
  region:   'auto',
  endpoint: 'https://' + process.env.R2_ACCOUNT_ID + '.r2.cloudflarestorage.com',
  credentials: {
    accessKeyId:     process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 150 * 1024 * 1024 },
  fileFilter: function(req, file, cb) {
    if (file.mimetype.startsWith('video/') || file.mimetype === 'audio/webm') cb(null, true);
    else cb(new Error('Video files only'), false);
  },
});

router.post('/response-video', upload.single('video'), async function(req, res) {
  try {
    console.log('Upload received: session=' + req.body.session_id + ' seg=' + req.body.segment_id);

    var session_id   = req.body.session_id   || 'unknown';
    var segment_id   = req.body.segment_id   || '';
    var segment_index = req.body.segment_index || '0';
    var file         = req.file;

    if (!file) {
      console.error('Upload: no file received');
      return res.status(400).json({ error: 'No video file received' });
    }

    var ext    = (file.originalname.split('.').pop()) || 'webm';
    var r2Key  = 'responses/' + session_id + '/seg' + segment_index + '_' + Date.now() + '.' + ext;

    await r2.send(new PutObjectCommand({
      Bucket:      process.env.R2_BUCKET_NAME,
      Key:         r2Key,
      Body:        file.buffer,
      ContentType: file.mimetype,
    }));

    var videoUrl = process.env.R2_PUBLIC_URL + '/' + r2Key;
    console.log('Upload OK: ' + r2Key + ' (' + (file.size/1024/1024).toFixed(1) + 'MB)');

    // Track for transcript email
    tracker.track(session_id, segment_id, videoUrl, {
      cand_name:           req.body.cand_name           || '',
      job_title:           req.body.job_title           || '',
      company_name:        req.body.company_name        || '',
      client_email:        req.body.client_email        || '',
      hiring_manager_name: req.body.hiring_manager_name || '',
    });

    res.json({ success: true, video_url: videoUrl });

  } catch (err) {
    console.error('Upload error: ' + err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
