import { PASSWORD_RESET_TTL_MINUTES } from "../../auth/passwordReset.ts";

const escapeHtml = (value: string) =>
    value
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");

export function buildPasswordResetEmail(input: { resetUrl: string }) {
    const safeUrl = escapeHtml(input.resetUrl);
    const text = [
        "CommuteLive",
        "",
        "We received a request to reset your CommuteLive password.",
        `This link expires in ${PASSWORD_RESET_TTL_MINUTES} minutes.`,
        "",
        `Reset your password: ${input.resetUrl}`,
        "",
        "If you did not request this, you can ignore this email.",
    ].join("\n");

    const html = `
<!DOCTYPE html>
<html lang="en">
  <body style="margin:0;padding:0;background:#f4f7fb;font-family:Arial,Helvetica,sans-serif;color:#102033;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="padding:24px 12px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:560px;background:#ffffff;border-radius:18px;overflow:hidden;border:1px solid #d7e0ea;">
            <tr>
              <td style="padding:24px 28px;background:#102033;color:#ffffff;font-size:22px;font-weight:700;">
                CommuteLive
              </td>
            </tr>
            <tr>
              <td style="padding:28px;">
                <p style="margin:0 0 16px;font-size:16px;line-height:1.6;">
                  We received a request to reset your CommuteLive password.
                </p>
                <p style="margin:0 0 24px;font-size:14px;line-height:1.6;color:#4c6177;">
                  Use the button below to choose a new password. This link expires in ${PASSWORD_RESET_TTL_MINUTES} minutes.
                </p>
                <p style="margin:0 0 24px;">
                  <a href="${safeUrl}" style="display:inline-block;background:#0f6cbd;color:#ffffff;text-decoration:none;font-weight:700;padding:14px 22px;border-radius:10px;">
                    Reset Password
                  </a>
                </p>
                <p style="margin:0 0 12px;font-size:13px;line-height:1.6;color:#4c6177;">
                  If the button does not work, copy and paste this URL into your browser:
                </p>
                <p style="margin:0 0 24px;font-size:13px;line-height:1.6;word-break:break-all;">
                  <a href="${safeUrl}" style="color:#0f6cbd;">${safeUrl}</a>
                </p>
                <p style="margin:0;font-size:13px;line-height:1.6;color:#4c6177;">
                  If you did not request this, you can ignore this email.
                </p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`.trim();

    return {
        subject: "Reset your CommuteLive password",
        html,
        text,
    };
}
