"""
NEXT-JENN -- ALL EMAIL TEMPLATES + GMAIL SMTP SERVICE
Five emails:
  1. Confirmation  -- sent when candidate schedules
  2. Reminder 24hr -- sent 24 hours before
  3. Reminder 1hr  -- sent 1 hour before
  4. Thank You     -- sent to candidate after interview
  5. Transcript    -- sent to client with Q&A + video links

Uses Gmail SMTP via Google Workspace. No SendGrid needed.
Install: pip install python-dotenv flask
"""

import os
import smtplib
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from flask import Flask, request, jsonify
from dotenv import load_dotenv

load_dotenv()
app = Flask(__name__)

EMAIL_USER      = os.getenv("EMAIL_USER")
EMAIL_PASSWORD  = os.getenv("EMAIL_PASSWORD")
EMAIL_FROM      = os.getenv("EMAIL_FROM", "interview@next-jennconsulting.com")
EMAIL_FROM_NAME = "Next-Jenn AI Recruiter"
APP_URL         = os.getenv("APP_URL", "https://nextjenn.onrender.com")

QUESTION_LABELS = {
    "q1":    "Question 1 - What is your interest in this position?",
    "q2":    "Question 2 - Summary of experience relative to this role",
    "q3":    "Question 3 - Three words that best describe you",
    "q4":    "Question 4 - Project you are most proud of",
    "final": "Final Question - Are you interested in moving forward?",
}


def email_shell(body_html, preview=""):
    return (
        "<!DOCTYPE html><html><head><meta charset='UTF-8'>"
        + ("<span style='display:none'>" + preview + "</span>" if preview else "")
        + "</head><body style='margin:0;padding:0;background:#F0F2F5;font-family:Arial,sans-serif;'>"
        + "<table width='100%' cellpadding='0' cellspacing='0' style='background:#F0F2F5;padding:32px 16px;'>"
        + "<tr><td align='center'>"
        + "<table width='600' cellpadding='0' cellspacing='0' style='background:#FFFFFF;border-radius:16px;overflow:hidden;max-width:600px;width:100%;'>"
        + "<tr><td style='background:#1B2A4A;padding:20px 32px;'>"
        + "<span style='font-size:20px;font-weight:700;color:#FFFFFF;letter-spacing:0.08em;'>NEXT-JENN</span>"
        + "<span style='float:right;font-size:11px;color:#8892A4;letter-spacing:0.1em;text-transform:uppercase;'>AI Recruiter Interview</span>"
        + "</td></tr>"
        + body_html
        + "<tr><td style='background:#F8F9FC;padding:16px 32px;border-top:1px solid #D8DCE6;'>"
        + "<p style='margin:0;font-size:11px;color:#8892A4;text-align:center;'>"
        + "Next-Jenn AI Recruiter Platform | next-jennconsulting.com"
        + "</p></td></tr>"
        + "</table></td></tr></table></body></html>"
    )


def send_email(to_email, subject, html_body, plain_body=""):
    try:
        msg = MIMEMultipart("alternative")
        msg["Subject"] = subject
        msg["From"]    = EMAIL_FROM_NAME + " <" + EMAIL_FROM + ">"
        msg["To"]      = to_email
        msg.attach(MIMEText(plain_body or "Please view in an HTML email client.", "plain"))
        msg.attach(MIMEText(html_body, "html"))
        with smtplib.SMTP_SSL("smtp.gmail.com", 465) as server:
            server.login(EMAIL_USER, EMAIL_PASSWORD)
            server.sendmail(EMAIL_FROM, to_email, msg.as_string())
        print("Email sent to " + to_email)
        return True
    except Exception as e:
        print("Gmail error: " + str(e))
        return False


# ---------------------------------------------------------------
# EMAIL BUILDERS
# ---------------------------------------------------------------

def build_confirmation_email(candidate_name, job_title, scheduled_time_str, timezone_str, join_url):
    body = (
        "<tr><td style='background:#1B2A4A;padding:36px 32px;text-align:center;'>"
        + "<h1 style='margin:0 0 10px;font-size:26px;color:#FFFFFF;'>Interview Scheduled!</h1>"
        + "<p style='margin:0;font-size:14px;color:rgba(255,255,255,0.75);'>Your interview with Jenn is confirmed.</p>"
        + "</td></tr>"
        + "<tr><td style='padding:32px;'>"
        + "<p style='margin:0 0 20px;font-size:15px;color:#555B6E;line-height:1.7;'>Hi <strong style='color:#1B2A4A;'>" + candidate_name + "</strong>, your AI interview for <strong style='color:#1B2A4A;'>" + job_title + "</strong> is confirmed.</p>"
        + "<table width='100%' cellpadding='0' cellspacing='0' style='background:#F0F2F5;border-radius:12px;margin-bottom:20px;border:1px solid #D8DCE6;'>"
        + "<tr><td style='padding:20px 24px;'>"
        + "<p style='margin:0;font-size:11px;color:#8892A4;text-transform:uppercase;letter-spacing:0.12em;font-weight:600;'>Scheduled Time</p>"
        + "<p style='margin:6px 0 2px;font-size:22px;font-weight:700;color:#1B2A4A;'>" + scheduled_time_str + "</p>"
        + "<p style='margin:0;font-size:12px;color:#8892A4;'>" + timezone_str + "</p>"
        + "</td></tr></table>"
        + "<p style='margin:0 0 20px;padding:14px 18px;background:#EAF0EE;border-left:4px solid #2E7D5E;border-radius:8px;font-size:13px;color:#2E7D5E;'>"
        + "Reminders will be sent <strong>24 hours</strong> and <strong>1 hour</strong> before your interview.</p>"
        + "<p style='text-align:center;margin:0 0 8px;'>"
        + "<a href='" + join_url + "' style='display:inline-block;padding:16px 40px;background:#1B2A4A;color:#FFFFFF;text-decoration:none;border-radius:10px;font-size:15px;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;'>Join Interview at Scheduled Time</a>"
        + "</p>"
        + "<p style='margin:0 0 24px;font-size:12px;color:#8892A4;text-align:center;'>This link activates at your scheduled time.</p>"
        + "<p style='margin:0;font-size:13px;color:#555B6E;line-height:1.7;'><strong style='color:#1B2A4A;'>Tips:</strong> Camera and mic working, quiet space, good lighting. Jenn will ask 5 questions. Interview takes 8-10 minutes.</p>"
        + "</td></tr>"
    )
    return email_shell(body, "Your Next-Jenn interview is confirmed for " + scheduled_time_str)


def build_reminder_email(candidate_name, job_title, scheduled_time_str, timezone_str, join_url, hours_until):
    urgency = "Tomorrow" if hours_until == 24 else "In 1 Hour"
    color   = "#4A6FA5" if hours_until == 24 else "#C96A3A"
    message = ("Your interview is <strong>tomorrow at " + scheduled_time_str + "</strong>. Make sure you are prepared."
               if hours_until == 24
               else "Your interview starts <strong>in 1 hour</strong>. Get to a quiet space now.")
    body = (
        "<tr><td style='background:" + color + ";padding:12px 32px;text-align:center;'>"
        + "<p style='margin:0;font-size:13px;font-weight:700;color:#FFFFFF;text-transform:uppercase;letter-spacing:0.1em;'>Interview Reminder - " + urgency + "</p>"
        + "</td></tr>"
        + "<tr><td style='background:#1B2A4A;padding:32px;text-align:center;'>"
        + "<h1 style='margin:0 0 8px;font-size:24px;color:#FFFFFF;'>Your Interview is " + urgency + "</h1>"
        + "<p style='margin:0;font-size:14px;color:rgba(255,255,255,0.7);'>" + job_title + "</p>"
        + "</td></tr>"
        + "<tr><td style='padding:32px;'>"
        + "<p style='margin:0 0 20px;font-size:15px;color:#555B6E;line-height:1.7;'>Hi <strong style='color:#1B2A4A;'>" + candidate_name + "</strong>, " + message + "</p>"
        + "<table width='100%' cellpadding='0' cellspacing='0' style='background:#F0F2F5;border-radius:12px;margin-bottom:24px;border:2px solid " + color + ";'>"
        + "<tr><td style='padding:20px;text-align:center;'>"
        + "<p style='margin:0 0 4px;font-size:24px;font-weight:700;color:#1B2A4A;'>" + scheduled_time_str + "</p>"
        + "<p style='margin:0;font-size:12px;color:#8892A4;'>" + timezone_str + "</p>"
        + "</td></tr></table>"
        + "<p style='text-align:center;margin:0;'>"
        + "<a href='" + join_url + "' style='display:inline-block;padding:16px 40px;background:" + color + ";color:#FFFFFF;text-decoration:none;border-radius:10px;font-size:15px;font-weight:700;text-transform:uppercase;'>Join My Interview</a>"
        + "</p></td></tr>"
    )
    return email_shell(body, "Reminder: Your Next-Jenn interview is " + urgency.lower())


def build_thank_you_email(candidate_name, job_title):
    body = (
        "<tr><td style='background:#1B2A4A;padding:48px 32px;text-align:center;'>"
        + "<h1 style='margin:0 0 12px;font-size:28px;color:#FFFFFF;'>Interview Complete</h1>"
        + "<p style='margin:0;font-size:15px;color:rgba(255,255,255,0.75);'>Thank you for your time today, " + candidate_name + ".</p>"
        + "</td></tr>"
        + "<tr><td style='padding:36px 32px;'>"
        + "<p style='margin:0 0 20px;font-size:15px;color:#555B6E;line-height:1.8;'>We appreciate you completing your interview for <strong style='color:#1B2A4A;'>" + job_title + "</strong>. Your responses have been recorded and will be reviewed by the hiring team.</p>"
        + "<div style='background:#F0F2F5;border-radius:12px;padding:24px;text-align:center;margin-bottom:20px;'>"
        + "<p style='margin:0 0 8px;font-size:13px;font-weight:700;color:#1B2A4A;text-transform:uppercase;letter-spacing:0.1em;'>What Happens Next</p>"
        + "<p style='margin:0;font-size:14px;color:#555B6E;line-height:1.8;'>Our team will review your responses. <strong style='color:#1B2A4A;'>If the hiring manager would like to move forward, you will receive an email with next steps.</strong></p>"
        + "</div>"
        + "<p style='margin:0;font-size:14px;color:#8892A4;line-height:1.7;font-style:italic;text-align:center;'>Thank you again for your interest.<br>- Jenn and the Next-Jenn Team</p>"
        + "</td></tr>"
    )
    return email_shell(body, "Your interview for " + job_title + " is complete - thank you!")


def build_transcript_email(candidate_name, candidate_email, job_title, interview_date_str, transcripts):
    qa_html = ""
    for item in transcripts:
        seg_id     = item.get("segment_id", "")
        transcript = item.get("transcript", "[No response recorded]")
        video_url  = item.get("video_url", "")
        label      = QUESTION_LABELS.get(seg_id, item.get("question", ""))
        if seg_id in ("intro", "outro"):
            continue
        watch = ("<a href='" + video_url + "' style='display:inline-block;margin-top:12px;padding:9px 18px;background:#1B2A4A;color:#FFFFFF;text-decoration:none;border-radius:8px;font-size:12px;font-weight:700;'>Watch Response</a>"
                 if video_url else "")
        qa_html += (
            "<tr><td style='padding:0 0 16px;'>"
            + "<table width='100%' cellpadding='0' cellspacing='0' style='border-radius:10px;overflow:hidden;border:1px solid #D8DCE6;'>"
            + "<tr><td style='background:#F0F2F5;padding:12px 20px;border-bottom:2px solid #1B2A4A;'>"
            + "<p style='margin:0;font-size:11px;font-weight:700;color:#1B2A4A;text-transform:uppercase;letter-spacing:0.1em;'>" + label + "</p>"
            + "</td></tr>"
            + "<tr><td style='padding:16px 20px 20px;'>"
            + "<p style='margin:0;font-size:14px;color:#1A1D2E;line-height:1.8;font-style:italic;'>&ldquo;" + transcript + "&rdquo;</p>"
            + watch
            + "</td></tr></table></td></tr>"
        )

    body = (
        "<tr><td style='background:#1B2A4A;padding:32px;'>"
        + "<h1 style='margin:0 0 6px;font-size:22px;color:#FFFFFF;'>Interview Transcript Ready</h1>"
        + "<p style='margin:0;font-size:14px;color:rgba(255,255,255,0.7);'>Review the candidate responses below</p>"
        + "</td></tr>"
        + "<tr><td style='background:#EEF1F7;padding:20px 32px;border-bottom:2px solid #1B2A4A;'>"
        + "<table width='100%' cellpadding='0' cellspacing='0'><tr>"
        + "<td><p style='margin:0;font-size:20px;font-weight:700;color:#1B2A4A;'>" + candidate_name + "</p><p style='margin:2px 0 0;font-size:13px;color:#555B6E;'>" + candidate_email + "</p></td>"
        + "<td align='right'><p style='margin:0;font-size:18px;font-weight:700;color:#1B2A4A;'>" + job_title + "</p><p style='margin:2px 0 0;font-size:13px;color:#555B6E;'>" + interview_date_str + "</p></td>"
        + "</tr></table></td></tr>"
        + "<tr><td style='padding:24px 32px;'>"
        + "<p style='margin:0 0 16px;font-size:11px;font-weight:700;color:#8892A4;text-transform:uppercase;letter-spacing:0.15em;'>Interview Responses</p>"
        + "<table width='100%' cellpadding='0' cellspacing='0'>" + qa_html + "</table>"
        + "<p style='margin:16px 0 0;font-size:12px;color:#8892A4;line-height:1.7;padding:14px;background:#F8F9FC;border-radius:8px;border:1px solid #D8DCE6;'>"
        + "Transcript generated by Whisper AI. Click Watch Response to view each video clip. Interview conducted by Jenn, AI Recruiter - Next-Jenn Platform."
        + "</p></td></tr>"
    )
    return email_shell(body, "Interview transcript ready - " + candidate_name + " for " + job_title)


# ---------------------------------------------------------------
# FLASK ROUTES
# ---------------------------------------------------------------

@app.route("/email/confirmation", methods=["POST"])
def send_confirmation():
    d = request.json
    html = build_confirmation_email(d["candidate_name"], d["job_title"], d["scheduled_time_str"], d["timezone_str"], d["join_url"])
    ok = send_email(d["candidate_email"], "Interview Confirmed - " + d["job_title"] + " | Next-Jenn", html)
    return jsonify({"sent": ok})


@app.route("/email/reminder", methods=["POST"])
def send_reminder():
    d = request.json
    hours = int(d.get("hours_until", 24))
    html = build_reminder_email(d["candidate_name"], d["job_title"], d["scheduled_time_str"], d["timezone_str"], d["join_url"], hours)
    label = "Tomorrow" if hours == 24 else "In 1 Hour"
    ok = send_email(d["candidate_email"], "Interview Reminder (" + label + ") - " + d["job_title"] + " | Next-Jenn", html)
    return jsonify({"sent": ok})


@app.route("/email/thank-you", methods=["POST"])
def send_thank_you():
    d = request.json
    html = build_thank_you_email(d["candidate_name"], d["job_title"])
    ok = send_email(d["candidate_email"], "Thank You for Your Interview - " + d["job_title"] + " | Next-Jenn", html)
    return jsonify({"sent": ok})


@app.route("/email/transcript", methods=["POST"])
def send_transcript():
    d = request.json
    html = build_transcript_email(d["candidate_name"], d["candidate_email"], d["job_title"], d["interview_date_str"], d["transcripts"])
    ok = send_email(d["client_email"], "Interview Transcript - " + d["candidate_name"] + " for " + d["job_title"] + " | Next-Jenn", html)
    return jsonify({"sent": ok})


@app.route("/health", methods=["GET"])
def health():
    return jsonify({"status": "ok", "service": "nextjenn-email"})


if __name__ == "__main__":
    port = int(os.getenv("EMAIL_SERVICE_PORT", 5002))
    print("Next-Jenn email service running on port " + str(port))
    app.run(host="0.0.0.0", port=port, debug=False)
