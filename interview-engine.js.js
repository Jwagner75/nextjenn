/**
 * AI RECRUITER — VIDEO INTERVIEW ENGINE
 * Node.js + Python
 *
 * Handles: ElevenLabs video segment sequencing,
 *          response triggers, Whisper transcription,
 *          and transcript delivery to client email.
 *
 * NO recording, NO storage, NO scoring — just video + transcription.
 */

const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const axios = require('axios');

const PYTHON_SERVICE_URL = process.env.PYTHON_SERVICE_URL || 'http://localhost:5001';

// ─────────────────────────────────────────────────────────────
// INTERVIEW SEGMENTS
// Each maps to one ElevenLabs-generated video file
// Response time in seconds — frontend enforces max recording window
// ─────────────────────────────────────────────────────────────
const INTERVIEW_SEGMENTS = [
  {
    id: 'intro',
    label: 'Introduction',
    video_file: 'intro.mp4',
    response_seconds: 5,
    question_text: 'Hi, my name is Jenn, an AI Recruiter who will be conducting your interview today. Are you ready?',
  },
  {
    id: 'q1',
    label: 'Question 1',
    video_file: 'q1.mp4',
    response_seconds: 60,
    question_text: 'Can you tell me why you would be interested in this role?',
  },
  {
    id: 'q2',
    label: 'Question 2',
    video_file: 'q2.mp4',
    response_seconds: 180,
    question_text: 'What are 3 qualifications that make you the best fit for this role?',
  },
  {
    id: 'q3',
    label: 'Question 3',
    video_file: 'q3.mp4',
    response_seconds: 30,
    question_text: 'Are you actively interviewing?',
  },
  {
    id: 'q4',
    label: 'Question 4',
    video_file: 'q4.mp4',
    response_seconds: 120,
    question_text: 'What are 3 words that best describe you?',
  },
  {
    id: 'q5',
    label: 'Question 5',
    video_file: 'q5.mp4',
    response_seconds: 10,
    question_text: 'Are you interested in us moving you to the next stage in the process?',
  },
  {
    id: 'outro',
    label: 'Closing',
    video_file: 'outro.mp4',
    response_seconds: 0, // No response — closing statement
    question_text: 'You will receive an email from us if the hiring manager wants to move forward. Thank you so much for your time today.',
  },
];

// ─────────────────────────────────────────────────────────────
// IN-MEMORY SESSION STORE
// Replace with your DB calls when ready to integrate
// ─────────────────────────────────────────────────────────────
const sessions = new Map();

// ─────────────────────────────────────────────────────────────
// ROUTE: Initialize interview session
// POST /api/interview/init
//
// Body: {
//   candidate_name: string,
//   candidate_email: string,
//   client_email: string,    ← transcript sent here when complete
//   job_title: string,
//   job_id: string
// }
// ─────────────────────────────────────────────────────────────
router.post('/init', (req, res) => {
  const { candidate_name, candidate_email, client_email, job_title, job_id } = req.body;

  if (!candidate_email || !client_email) {
    return res.status(400).json({ error: 'candidate_email and client_email are required' });
  }

  const session_id = uuidv4();

  const session = {
    id: session_id,
    candidate_name,
    candidate_email,
    client_email,
    job_title,
    job_id,
    current_segment_index: 0,
    segments: INTERVIEW_SEGMENTS.map(seg => ({
      ...seg,
      status: 'pending',        // pending | playing | awaiting_response | response_received | complete
      response_audio_url: null, // set when candidate response audio is submitted
      transcript: null,         // set after Python transcribes
      started_at: null,
      response_submitted_at: null,
    })),
    transcripts: [],            // accumulates as responses come in
    status: 'initialized',      // initialized | active | complete
    created_at: new Date().toISOString(),
  };

  sessions.set(session_id, session);

  // Return session + first segment to frontend
  const firstSegment = INTERVIEW_SEGMENTS[0];

  res.json({
    session_id,
    candidate_name,
    job_title,
    total_segments: INTERVIEW_SEGMENTS.length,
    first_segment: buildSegmentPayload(session, 0),
  });
});

// ─────────────────────────────────────────────────────────────
// ROUTE: Segment video finished playing — trigger response window
// POST /api/interview/:session_id/segment-ended
//
// Body: { segment_index: number }
// Frontend calls this when the avatar video ends.
// Returns: whether to open response window or auto-advance.
// ─────────────────────────────────────────────────────────────
router.post('/:session_id/segment-ended', (req, res) => {
  const session = sessions.get(req.params.session_id);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  const { segment_index } = req.body;
  const segment = session.segments[segment_index];
  if (!segment) return res.status(400).json({ error: 'Invalid segment index' });

  segment.status = 'awaiting_response';
  segment.started_at = new Date().toISOString();

  const isOutro = segment.id === 'outro';

  if (isOutro) {
    // No response needed — session is complete
    session.status = 'complete';
    triggerTranscriptProcessing(session.id);
    return res.json({ action: 'session_complete' });
  }

  if (segment.response_seconds === 0) {
    // No response needed for this segment — auto-advance
    return res.json({
      action: 'advance',
      next_segment: buildSegmentPayload(session, segment_index + 1),
    });
  }

  // Open response recording window
  res.json({
    action: 'record_response',
    segment_id: segment.id,
    segment_index,
    question_text: segment.question_text,
    max_response_seconds: segment.response_seconds,
    // Frontend shows a countdown timer using this value
  });
});

// ─────────────────────────────────────────────────────────────
// ROUTE: Submit candidate response audio
// POST /api/interview/:session_id/submit-response
//
// Body: {
//   segment_index: number,
//   audio_url: string    ← URL of uploaded response audio file
// }
// ─────────────────────────────────────────────────────────────
router.post('/:session_id/submit-response', async (req, res) => {
  const session = sessions.get(req.params.session_id);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  const { segment_index, audio_url } = req.body;
  const segment = session.segments[segment_index];
  if (!segment) return res.status(400).json({ error: 'Invalid segment index' });

  // Save response reference
  segment.status = 'response_received';
  segment.response_audio_url = audio_url;
  segment.response_submitted_at = new Date().toISOString();

  // Trigger async transcription — non-blocking
  transcribeSegmentAsync(session.id, segment_index, audio_url, segment.question_text);

  // Determine next action
  const nextIndex = segment_index + 1;
  const hasNext = nextIndex < session.segments.length;

  if (!hasNext) {
    session.status = 'complete';
    triggerTranscriptProcessing(session.id);
    return res.json({ action: 'session_complete' });
  }

  // Return next segment
  res.json({
    action: 'play_next',
    next_segment: buildSegmentPayload(session, nextIndex),
  });
});

// ─────────────────────────────────────────────────────────────
// ROUTE: Receive transcript from Python processor
// POST /api/interview/transcript-ready  (internal — Python calls this)
//
// Body: {
//   session_id: string,
//   segment_index: number,
//   question_text: string,
//   transcript: string
// }
// ─────────────────────────────────────────────────────────────
router.post('/transcript-ready', (req, res) => {
  const { session_id, segment_index, question_text, transcript } = req.body;
  const session = sessions.get(session_id);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  const segment = session.segments[segment_index];
  if (segment) {
    segment.transcript = transcript;
    segment.status = 'complete';
  }

  // Add to transcript log
  session.transcripts.push({
    segment_index,
    segment_id: segment?.id,
    question: question_text,
    response: transcript,
    transcribed_at: new Date().toISOString(),
  });

  // Check if all transcripts are ready — send email
  checkAndSendTranscript(session_id);

  res.json({ success: true });
});

// ─────────────────────────────────────────────────────────────
// ROUTE: Get session status (frontend polling)
// GET /api/interview/:session_id/status
// ─────────────────────────────────────────────────────────────
router.get('/:session_id/status', (req, res) => {
  const session = sessions.get(req.params.session_id);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  res.json({
    session_id: session.id,
    status: session.status,
    current_segment: session.current_segment_index,
    total_segments: session.segments.length,
    transcripts_received: session.transcripts.length,
  });
});

// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────

function buildSegmentPayload(session, index) {
  const seg = session.segments[index];
  if (!seg) return null;
  return {
    index,
    segment_id: seg.id,
    label: seg.label,
    // Video URL served from your CDN / static file server
    video_url: `${process.env.VIDEO_CDN_BASE_URL}/${seg.video_file}`,
    response_seconds: seg.response_seconds,
    question_text: seg.question_text,
    is_last: index === session.segments.length - 1,
  };
}

// Trigger Python to transcribe a response audio file async
async function transcribeSegmentAsync(session_id, segment_index, audio_url, question_text) {
  try {
    await axios.post(`${PYTHON_SERVICE_URL}/transcribe`, {
      session_id,
      segment_index,
      audio_url,
      question_text,
    });
  } catch (err) {
    console.error(`Transcription trigger failed: session ${session_id} segment ${segment_index}`, err.message);
  }
}

// Trigger Python to compile and send full transcript email
async function triggerTranscriptProcessing(session_id) {
  const session = sessions.get(session_id);
  if (!session) return;

  try {
    await axios.post(`${PYTHON_SERVICE_URL}/send-transcript`, {
      session_id,
      candidate_name: session.candidate_name,
      candidate_email: session.candidate_email,
      client_email: session.client_email,
      job_title: session.job_title,
    });
  } catch (err) {
    console.error(`Transcript send trigger failed: session ${session_id}`, err.message);
  }
}

// Check if all segment transcripts are ready, then send email
function checkAndSendTranscript(session_id) {
  const session = sessions.get(session_id);
  if (!session) return;

  // Count segments that need a response
  const respondableSegments = session.segments.filter(s => s.response_seconds > 0);
  const completedTranscripts = session.transcripts.length;

  if (completedTranscripts >= respondableSegments.length) {
    triggerTranscriptProcessing(session_id);
  }
}

module.exports = router;
