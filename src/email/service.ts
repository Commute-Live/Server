import { Resend } from "resend";

import { emailConfig } from "./config.ts";
import { buildPasswordResetEmail } from "./templates/passwordReset.ts";

let resendClient: Resend | null = null;

const getResendClient = (): Resend => {
    if (!emailConfig.resendApiKey) {
        throw new Error("RESEND_API_KEY is not configured");
    }

    resendClient ??= new Resend(emailConfig.resendApiKey);
    return resendClient;
};

export const buildPasswordResetUrl = (rawToken: string) =>
    `${emailConfig.appBaseUrl}/reset-password?token=${encodeURIComponent(rawToken)}`;

export async function sendPasswordResetEmail(input: {
    to: string;
    rawToken: string;
}): Promise<void> {
    const resetUrl = buildPasswordResetUrl(input.rawToken);
    const message = buildPasswordResetEmail({ resetUrl });

    const resend = getResendClient();
    await resend.emails.send({
        from: emailConfig.authFrom,
        to: input.to,
        replyTo: emailConfig.authReplyTo,
        subject: message.subject,
        html: message.html,
        text: message.text,
    });
}
