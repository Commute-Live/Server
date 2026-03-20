const requireEnv = (name: string): string => {
    const value = process.env[name]?.trim();
    if (value) return value;

    if (process.env.NODE_ENV === "production") {
        throw new Error(`${name} is required in production`);
    }

    return "";
};

export const emailConfig = {
    resendApiKey: requireEnv("RESEND_API_KEY"),
    appBaseUrl: (
        process.env.APP_BASE_URL?.trim() || "https://commutelive.com"
    ).replace(/\/+$/, ""),
    authFrom: process.env.EMAIL_FROM_AUTH?.trim() || "Commutelive <auth@commutelive.com>",
    authReplyTo: process.env.EMAIL_REPLY_TO?.trim() || "team@commutelive.com",
} as const;
