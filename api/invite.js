// STWRD Partner Invite Email — sends a transactional invite via Resend.
// Mirrors api/digest.js pattern: no SDK, env-only RESEND_API_KEY, direct
// fetch to api.resend.com. The invite token already lives in the
// partnerships table (created client-side); this endpoint just delivers it.

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STWRD_DOMAIN = 'https://getstwrd.com';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { partnerEmail, inviteToken, inviterName, inviterEmail } = req.body || {};

  // ── Validation ──────────────────────────────────────────────
  if (!partnerEmail || typeof partnerEmail !== 'string' || !EMAIL_REGEX.test(partnerEmail.trim())) {
    return res.status(400).json({ error: 'Invalid partnerEmail' });
  }
  if (!inviteToken || typeof inviteToken !== 'string' || !UUID_REGEX.test(inviteToken)) {
    return res.status(400).json({ error: 'Invalid inviteToken' });
  }
  if (!inviterName || typeof inviterName !== 'string' || inviterName.trim().length === 0 || inviterName.length > 60) {
    return res.status(400).json({ error: 'Invalid inviterName' });
  }
  if (!inviterEmail || typeof inviterEmail !== 'string' || !EMAIL_REGEX.test(inviterEmail.trim())) {
    return res.status(400).json({ error: 'Invalid inviterEmail' });
  }

  // Self-invite reject. Defensive check — client passes its own email so this
  // is UX protection, not security. Worst case if a user lies: they create an
  // orphan pending partnership row, recovered by acceptInvite's not-self check.
  if (partnerEmail.trim().toLowerCase() === inviterEmail.trim().toLowerCase()) {
    return res.status(400).json({ error: 'You cannot invite yourself' });
  }

  // ── Resend key ───────────────────────────────────────────────
  const resendKey = process.env.RESEND_API_KEY;
  if (!resendKey) {
    return res.status(500).json({ error: 'RESEND_API_KEY not configured in environment' });
  }

  const cleanName = inviterName.trim();
  const cleanPartnerEmail = partnerEmail.trim();
  const link = `${STWRD_DOMAIN}/?invite=${inviteToken}`;
  const subject = `${cleanName} invited you to STWRD`;

  // ── Plain-text fallback (some clients render this by default) ──
  const text = `${cleanName} invited you to STWRD.

STWRD is a household OS for couples — shared task visibility, a daily AI briefing, and a partner digest.

Accept your invite: ${link}

If you didn't expect this invite, you can ignore this email.`;

  // ── HTML email ───────────────────────────────────────────────
  const html = `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#0a0a0f;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <div style="max-width:560px;margin:0 auto;padding:32px 20px;">

    <!-- HEADER -->
    <div style="margin-bottom:28px;">
      <div style="font-size:24px;font-weight:800;color:#7c6fef;letter-spacing:-0.5px;">STWRD</div>
      <div style="font-size:13px;color:#8888aa;margin-top:4px;">Your household OS</div>
    </div>

    <!-- INVITE CARD -->
    <div style="background:#12121a;border:1px solid #7c6fef40;border-radius:14px;padding:24px;margin-bottom:20px;">
      <div style="font-size:18px;font-weight:700;color:#f0f0ff;margin-bottom:12px;">${escapeHtml(cleanName)} invited you to STWRD</div>
      <div style="font-size:14px;color:#c0c0d8;line-height:1.6;margin-bottom:24px;">${escapeHtml(cleanName)} wants to manage your household together on STWRD. Tap below to accept the invite — it'll auto-link your accounts when you sign in.</div>

      <!-- CTA BUTTON -->
      <div style="text-align:center;margin-bottom:18px;">
        <a href="${link}" style="display:inline-block;background:#7c6fef;color:white;text-decoration:none;padding:14px 36px;border-radius:12px;font-size:15px;font-weight:700;letter-spacing:0.3px;">Accept invite</a>
      </div>

      <!-- Helper line -->
      <div style="font-size:11px;color:#8888aa;text-align:center;line-height:1.5;">Or paste this link in your browser:<br><span style="color:#a0a0c0;word-break:break-all;">${link}</span></div>
    </div>

    <!-- FOOTER -->
    <div style="text-align:center;font-size:11px;color:#8888aa;line-height:1.5;">
      If you didn't expect this invite, you can ignore this email.
    </div>

  </div>
</body>
</html>`;

  // ── Send via Resend ──────────────────────────────────────────
  try {
    const emailRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${resendKey}`,
      },
      body: JSON.stringify({
        from: 'STWRD <onboarding@resend.dev>',
        to: [cleanPartnerEmail],
        subject,
        html,
        text,
      }),
    });

    const emailData = await emailRes.json();

    if (!emailRes.ok) {
      console.error('[/api/invite] Resend error:', emailData);
      return res.status(500).json({ error: 'Email send failed', details: emailData });
    }

    return res.status(200).json({ success: true });
  } catch (e) {
    console.error('[/api/invite] error:', e);
    return res.status(500).json({ error: e.message || 'Internal error' });
  }
}

// Minimal HTML escape for user-controlled values that get interpolated
// into the email body (inviterName). Subject line uses the raw value
// since email clients don't render HTML in subjects.
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
