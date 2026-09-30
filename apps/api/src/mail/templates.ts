// Auth emails. Plain text first (it's what many clients show in previews);
// the HTML version is the same content with a button.
import type { Mail } from "./mail.service";

const escape = (value: string) => value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function layout(heading: string, body: string, action: { label: string; url: string }) {
  return `<!doctype html>
<html><body style="font-family:system-ui,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#111">
<h1 style="font-size:20px">${escape(heading)}</h1>
<p>${escape(body)}</p>
<p><a href="${escape(action.url)}" style="display:inline-block;background:#111;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none">${escape(action.label)}</a></p>
<p style="font-size:12px;color:#555">Or paste this link into your browser:<br>${escape(action.url)}</p>
<p style="font-size:12px;color:#555">If you didn't request this, you can ignore this email.</p>
</body></html>`;
}

export function verifyEmailMail(to: string, url: string): Mail {
  const body = "Confirm your email address for Spatial Capture. The link is valid for 24 hours.";
  return {
    to,
    subject: "Confirm your email for Spatial Capture",
    text: `${body}\n\n${url}\n\nIf you didn't create an account, you can ignore this email.`,
    html: layout("Confirm your email", body, { label: "Confirm email", url }),
  };
}

export function resetPasswordMail(to: string, url: string): Mail {
  const body =
    "Someone asked to reset the password for your Spatial Capture account. The link is valid for 1 hour and works once.";
  return {
    to,
    subject: "Reset your Spatial Capture password",
    text: `${body}\n\n${url}\n\nIf you didn't ask for this, your password is unchanged.`,
    html: layout("Reset your password", body, { label: "Choose a new password", url }),
  };
}
