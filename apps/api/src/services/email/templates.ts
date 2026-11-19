/** Pure email templates. Every interpolated value is HTML-escaped. No images, no tracking. */
export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Strip control characters and limit length (the name goes into a header-like subject). */
export function cleanInstitutionName(name: string): string {
  // eslint-disable-next-line no-control-regex
  return name.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
}

/** Origin of FRONTEND_URL only, or null when unset/invalid. */
export function frontendOrigin(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env.FRONTEND_URL;
  if (!raw) return null;
  try {
    return new URL(raw).origin;
  } catch {
    return null;
  }
}

export function buildAccountLink(path: "/reset-password" | "/activate", token: string): string | null {
  const origin = frontendOrigin();
  if (!origin) return null;
  return `${origin}${path}#token=${encodeURIComponent(token)}`;
}

function layout(heading: string, intro: string, buttonLabel: string, link: string, expiry: string): { html: string; text: string } {
  const h = escapeHtml(heading);
  const html =
    `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;color:#1f2937;max-width:520px">` +
    `<h2 style="font-size:18px;margin:0 0 12px">${h}</h2>` +
    `<p style="margin:0 0 12px">Hello,</p>` +
    `<p style="margin:0 0 16px">${escapeHtml(intro)}</p>` +
    `<p style="margin:0 0 16px"><a href="${escapeHtml(link)}" style="background:#1d4ed8;color:#ffffff;padding:10px 18px;border-radius:6px;text-decoration:none;display:inline-block">${escapeHtml(buttonLabel)}</a></p>` +
    `<p style="margin:0 0 8px;font-size:13px">If the button does not work, copy this link into your browser:<br>${escapeHtml(link)}</p>` +
    `<p style="margin:0 0 8px;font-size:13px">${escapeHtml(expiry)}</p>` +
    `<p style="margin:0;font-size:13px;color:#6b7280">If you did not request this, you can ignore this email. Your password will not change.</p>` +
    `</div>`;
  const text = [
    "Hello,",
    "",
    intro,
    "",
    `${buttonLabel}: ${link}`,
    "",
    expiry,
    "If you did not request this, you can ignore this email. Your password will not change.",
  ].join("\n");
  return { html, text };
}

export function renderPasswordReset(input: {
  institutionName: string;
  link: string;
  expiresInMinutes: number;
}): RenderedEmail {
  const inst = cleanInstitutionName(input.institutionName);
  const body = layout(
    "Reset your password",
    `We received a request to reset the password for your CampusGate account at ${inst}.`,
    "Reset password",
    input.link,
    `This link works once and expires in ${input.expiresInMinutes} minutes.`,
  );
  return { subject: `Reset your CampusGate password - ${inst}`, ...body };
}

export function renderActivation(input: {
  institutionName: string;
  link: string;
  expiresInHours: number;
}): RenderedEmail {
  const inst = cleanInstitutionName(input.institutionName);
  const days = input.expiresInHours % 24 === 0 ? input.expiresInHours / 24 : null;
  const window = days !== null ? `${days} day${days === 1 ? "" : "s"}` : `${input.expiresInHours} hours`;
  const body = layout(
    "Activate your account",
    `An account has been created for you on CampusGate at ${inst}. Set a password to start using it.`,
    "Activate account",
    input.link,
    `This link works once and expires in ${window}.`,
  );
  return { subject: `Activate your CampusGate account - ${inst}`, ...body };
}
