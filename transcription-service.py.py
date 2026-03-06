"""
AI RECRUITER — TRANSCRIPTION + EMAIL SERVICE
Python | Flask microservice

Handles:
  1. Whisper transcription of candidate response audio
  2. Transcript compilation and formatting
  3. Email delivery to client with formatted transcript

Dependencies:
  pip install faster-whisper flask httpx python-dotenv
  pip install resend   ← OR swap for SendGrid, Mailgun, SES (see EMAIL section)
"""

import os
import json
import httpx
import asyncio
from datetime import datetime
from flask import Flask, request, jsonify
from faster_whisper import WhisperModel
from dotenv import load_dotenv

load_dotenv()

app = Flask(__name__)

# ─────────────────────────────────────────────────────────────
# WHISPER — LOCAL TRANSCRIPTION
# Runs fully on your server — no API cost per transcription
# Model options: tiny | base | small | medium | large-v3
# medium = best balance of speed and accuracy for interviews
# ─────────────────────────────────────────────────────────────
whisper = WhisperModel(
    os.getenv("WHISPER_MODEL", "medium"),
    device="cpu",        # change to "cuda" if you have a GPU server
    compute_type="int8"  # fastest CPU option
)

NODE_CALLBACK_URL = os.getenv("NODE_CALLBACK_URL", "http://localhost:3000")

# ─────────────────────────────────────────────────────────────
# ROUTE: Transcribe a single response segment
# POST /transcribe
#
# Called by Node.js immediately after each response is submitted.
# Runs async — does not block the interview session.
# Calls back to Node when complete with the transcript text.
# ─────────────────────────────────────────────────────────────
@app.route('/transcribe', methods=['POST'])
def transcribe():
    data = request.json
    session_id   = data['session_id']
    segment_index = data['segment_index']
    audio_url    = data['audio_url']
    question_text = data.get('question_text', '')

    # Run transcription in background thread so Flask responds immediately
    import threading
    thread = threading.Thread(
        target=run_transcription,
        args=(session_id, segment_index, audio_url, question_text)
    )
    thread.daemon = True
    thread.start()

    return jsonify({"status": "transcription_started"})


def run_transcription(session_id, segment_index, audio_url, question_text):
    """
    Downloads audio, transcribes with Whisper,
    sends transcript back to Node.js.
    """
    try:
        print(f"Transcribing: session={session_id} segment={segment_index}")

        # Download audio from your storage URL
        audio_path = download_audio(audio_url, session_id, segment_index)

        # Transcribe with Whisper
        segments, info = whisper.transcribe(
            audio_path,
            beam_size=5,
            language="en",
            word_timestamps=False,
        )

        # Join all segments into clean transcript text
        transcript_text = " ".join(seg.text.strip() for seg in segments).strip()

        # Clean up temp file
        if os.path.exists(audio_path):
            os.remove(audio_path)

        print(f"Transcript ready: session={session_id} segment={segment_index}")
        print(f"  Q: {question_text}")
        print(f"  A: {transcript_text[:100]}...")

        # Send transcript back to Node.js
        import requests
        requests.post(
            f"{NODE_CALLBACK_URL}/api/interview/transcript-ready",
            json={
                "session_id": session_id,
                "segment_index": segment_index,
                "question_text": question_text,
                "transcript": transcript_text,
            },
            timeout=10
        )

    except Exception as e:
        print(f"Transcription error: session={session_id} segment={segment_index} error={e}")


def download_audio(audio_url: str, session_id: str, segment_index: int) -> str:
    """Downloads audio to a temp file for Whisper processing."""
    import requests
    suffix = ".webm" if "webm" in audio_url else ".mp3" if "mp3" in audio_url else ".mp4"
    path = f"/tmp/{session_id}_seg{segment_index}{suffix}"

    response = requests.get(audio_url, timeout=60)
    response.raise_for_status()

    with open(path, "wb") as f:
        f.write(response.content)

    return path


# ─────────────────────────────────────────────────────────────
# ROUTE: Send transcript email to client
# POST /send-transcript
#
# Called by Node.js when session is complete and
# all transcripts are ready.
# ─────────────────────────────────────────────────────────────
@app.route('/send-transcript', methods=['POST'])
def send_transcript():
    data = request.json
    session_id      = data['session_id']
    candidate_name  = data.get('candidate_name', 'Candidate')
    candidate_email = data.get('candidate_email', '')
    client_email    = data['client_email']
    job_title       = data.get('job_title', 'Open Role')

    import threading
    thread = threading.Thread(
        target=compile_and_send,
        args=(session_id, candidate_name, candidate_email, client_email, job_title)
    )
    thread.daemon = True
    thread.start()

    return jsonify({"status": "email_sending"})


def compile_and_send(session_id, candidate_name, candidate_email, client_email, job_title):
    """
    Fetches all transcripts from Node, formats them,
    and sends the email to the client.
    """
    try:
        # Fetch session with transcripts from Node
        import requests
        response = requests.get(
            f"{NODE_CALLBACK_URL}/api/interview/{session_id}/status",
            timeout=10
        )
        session_data = response.json()

        # Fetch full transcript data
        transcript_response = requests.get(
            f"{NODE_CALLBACK_URL}/api/interview/{session_id}/transcripts",
            timeout=10
        )
        transcripts = transcript_response.json().get("transcripts", [])

        # Build and send the email
        send_transcript_email(
            client_email=client_email,
            candidate_name=candidate_name,
            candidate_email=candidate_email,
            job_title=job_title,
            transcripts=transcripts,
            session_id=session_id,
        )

        print(f"Transcript email sent: session={session_id} to={client_email}")

    except Exception as e:
        print(f"Email send error: session={session_id} error={e}")


# ─────────────────────────────────────────────────────────────
# EMAIL DELIVERY
# Using Resend (recommended — simple API, great deliverability)
# Swap the send function for SendGrid, Mailgun, or AWS SES
# by replacing the resend.Emails.send() call below.
# ─────────────────────────────────────────────────────────────

def send_transcript_email(
    client_email: str,
    candidate_name: str,
    candidate_email: str,
    job_title: str,
    transcripts: list,
    session_id: str,
):
    """
    Sends formatted transcript email to client.
    Uses Resend by default — swap for your preferred email provider.
    """
    html_body  = build_email_html(candidate_name, candidate_email, job_title, transcripts)
    plain_body = build_email_plain(candidate_name, candidate_email, job_title, transcripts)

    send_with_resend(
        to=client_email,
        subject=f"Interview Transcript — {candidate_name} for {job_title}",
        html=html_body,
        plain=plain_body,
    )


def send_with_resend(to: str, subject: str, html: str, plain: str):
    """
    Sends email via Resend.
    Install: pip install resend
    Get API key at: resend.com
    """
    import resend
    resend.api_key = os.getenv("RESEND_API_KEY")

    resend.Emails.send({
        "from": os.getenv("EMAIL_FROM", "interviews@yourplatform.com"),
        "to": to,
        "subject": subject,
        "html": html,
        "text": plain,
    })


# ── SWAP FOR SENDGRID ─────────────────────────────────────────
# def send_with_sendgrid(to, subject, html, plain):
#     import sendgrid
#     from sendgrid.helpers.mail import Mail
#     sg = sendgrid.SendGridAPIClient(api_key=os.getenv("SENDGRID_API_KEY"))
#     message = Mail(
#         from_email=os.getenv("EMAIL_FROM"),
#         to_emails=to,
#         subject=subject,
#         html_content=html,
#         plain_text_content=plain,
#     )
#     sg.send(message)

# ── SWAP FOR AWS SES ──────────────────────────────────────────
# def send_with_ses(to, subject, html, plain):
#     import boto3
#     ses = boto3.client("ses", region_name=os.getenv("AWS_REGION", "us-east-1"))
#     ses.send_email(
#         Source=os.getenv("EMAIL_FROM"),
#         Destination={"ToAddresses": [to]},
#         Message={
#             "Subject": {"Data": subject},
#             "Body": {
#                 "Html": {"Data": html},
#                 "Text": {"Data": plain},
#             },
#         },
#     )


# ─────────────────────────────────────────────────────────────
# EMAIL TEMPLATES
# ─────────────────────────────────────────────────────────────

def build_email_html(candidate_name, candidate_email, job_title, transcripts):
    """Builds the HTML version of the transcript email."""

    interview_date = datetime.utcnow().strftime("%B %d, %Y")

    # Build Q&A rows
    qa_rows = ""
    for item in transcripts:
        question = item.get("question", "")
        response = item.get("response", "[No response recorded]")
        qa_rows += f"""
        <tr>
          <td style="padding:20px 24px 8px 24px;">
            <p style="margin:0;font-size:13px;font-weight:700;color:#0D7377;
                      text-transform:uppercase;letter-spacing:0.05em;">
              {question}
            </p>
          </td>
        </tr>
        <tr>
          <td style="padding:0 24px 20px 24px;border-bottom:1px solid #E5E7EB;">
            <p style="margin:0;font-size:15px;color:#1F2937;line-height:1.7;">
              {response}
            </p>
          </td>
        </tr>
        """

    return f"""
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
</head>
<body style="margin:0;padding:0;background:#F3F4F6;font-family:Arial,sans-serif;">

  <table width="100%" cellpadding="0" cellspacing="0" style="background:#F3F4F6;padding:40px 20px;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0"
             style="background:#ffffff;border-radius:12px;overflow:hidden;
                    box-shadow:0 2px 8px rgba(0,0,0,0.08);">

        <!-- HEADER -->
        <tr>
          <td style="background:#1B2A4A;padding:32px 24px;">
            <p style="margin:0;font-size:11px;color:#7B9FC9;
                      text-transform:uppercase;letter-spacing:0.2em;">
              AI Recruiting Platform
            </p>
            <h1 style="margin:8px 0 0 0;font-size:22px;color:#ffffff;font-weight:700;">
              Interview Transcript
            </h1>
          </td>
        </tr>

        <!-- CANDIDATE INFO -->
        <tr>
          <td style="background:#E8F6F7;padding:20px 24px;
                     border-bottom:2px solid #0D7377;">
            <table width="100%" cellpadding="0" cellspacing="0">
              <tr>
                <td>
                  <p style="margin:0;font-size:13px;color:#6B7280;">Candidate</p>
                  <p style="margin:4px 0 0 0;font-size:17px;font-weight:700;
                             color:#1B2A4A;">{candidate_name}</p>
                  <p style="margin:2px 0 0 0;font-size:13px;color:#6B7280;">
                    {candidate_email}
                  </p>
                </td>
                <td align="right">
                  <p style="margin:0;font-size:13px;color:#6B7280;">Role</p>
                  <p style="margin:4px 0 0 0;font-size:17px;font-weight:700;
                             color:#1B2A4A;">{job_title}</p>
                  <p style="margin:2px 0 0 0;font-size:13px;color:#6B7280;">
                    {interview_date}
                  </p>
                </td>
              </tr>
            </table>
          </td>
        </tr>

        <!-- TRANSCRIPT -->
        <tr>
          <td>
            <table width="100%" cellpadding="0" cellspacing="0">
              <tr>
                <td style="padding:24px 24px 8px 24px;">
                  <p style="margin:0;font-size:13px;font-weight:700;color:#6B7280;
                             text-transform:uppercase;letter-spacing:0.1em;">
                    Interview Responses
                  </p>
                </td>
              </tr>
              {qa_rows}
            </table>
          </td>
        </tr>

        <!-- FOOTER -->
        <tr>
          <td style="background:#F9FAFB;padding:24px;border-top:1px solid #E5E7EB;">
            <p style="margin:0;font-size:12px;color:#9CA3AF;text-align:center;
                      line-height:1.6;">
              This transcript was automatically generated by AI Recruiter Jenn.<br>
              Transcription powered by Whisper AI — accuracy may vary.<br>
              Please review responses directly for final hiring decisions.
            </p>
          </td>
        </tr>

      </table>
    </td></tr>
  </table>

</body>
</html>
"""


def build_email_plain(candidate_name, candidate_email, job_title, transcripts):
    """Builds the plain text fallback version of the transcript email."""

    interview_date = datetime.utcnow().strftime("%B %d, %Y")
    lines = [
        "AI RECRUITING PLATFORM — INTERVIEW TRANSCRIPT",
        "=" * 50,
        f"Candidate:  {candidate_name}",
        f"Email:      {candidate_email}",
        f"Role:       {job_title}",
        f"Date:       {interview_date}",
        "=" * 50,
        "",
        "INTERVIEW RESPONSES",
        "-" * 50,
    ]

    for item in transcripts:
        question = item.get("question", "")
        response = item.get("response", "[No response recorded]")
        lines.append(f"\nQ: {question}")
        lines.append(f"A: {response}")
        lines.append("-" * 50)

    lines += [
        "",
        "This transcript was automatically generated by AI Recruiter Jenn.",
        "Transcription powered by Whisper AI — accuracy may vary.",
        "Please review responses directly for final hiring decisions.",
    ]

    return "\n".join(lines)


# ─────────────────────────────────────────────────────────────
# HEALTH CHECK
# ─────────────────────────────────────────────────────────────
@app.route('/health', methods=['GET'])
def health():
    return jsonify({
        "status": "ok",
        "service": "interview-transcription-service",
        "whisper_model": os.getenv("WHISPER_MODEL", "medium"),
    })


if __name__ == '__main__':
    port = int(os.getenv('PYTHON_PORT', 5001))
    print(f"Interview transcription service running on port {port}")
    app.run(host='0.0.0.0', port=port, debug=False)
