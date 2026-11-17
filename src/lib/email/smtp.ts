import "server-only";
import nodemailer, { type SendMailOptions } from "nodemailer";

export interface SmtpCredentials {
  host: string;
  port: 465 | 587;
  username: string;
  password: string;
}

export async function sendSmtpMail(credentials: SmtpCredentials, message: SendMailOptions) {
  const transporter = nodemailer.createTransport({
    host: credentials.host,
    port: credentials.port,
    secure: credentials.port === 465,
    requireTLS: credentials.port === 587,
    auth: { user: credentials.username, pass: credentials.password },
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 30_000,
    tls: { minVersion: "TLSv1.2" },
  });

  try {
    return await transporter.sendMail(message);
  } finally {
    transporter.close();
  }
}
