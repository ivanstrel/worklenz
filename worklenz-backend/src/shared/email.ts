import nodemailer from "nodemailer";
import { SendEmailCommand, SESClient } from "@aws-sdk/client-ses";
import { Validator } from "jsonschema";
import { QueryResult } from "pg";
import lodash from "lodash";
import sanitizeHtmlLib from "sanitize-html";
import { log_error, isValidateEmail } from "./utils";
import emailRequestSchema from "../json_schemas/email-request-schema";
import db from "../config/db";

/**
 * ---------------------------------------------------------------------------
 * Email transport discovery
 * ---------------------------------------------------------------------------
 * The transport is chosen per-send based on what is configured in the
 * environment.  This makes the module safe to import on a clean CE database
 * that has:
 *   - SMTP configured  (SMTP_HOST / SMTP_PORT, optionally SMTP_USER/SMTP_PASS)
 *     -> uses Nodemailer SMTP transport.
 *   - AWS SES configured (AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY + AWS_REGION)
 *     -> uses the AWS SES API.
 *   - NEITHER configured
 *     -> logs a warning and reports a non-fatal failure.  Crucially this never
 *        throws and never instantiates an SES client with a missing region
 *        (the previous `new SESClient({ region: undefined })` at module load
 *        was the source of the "Region is missing" crash on CE).
 *
 * The SES client is created lazily and ONLY when AWS credentials are present,
 * so importing this module can no longer fail at startup.
 */

const SMTP_HOST = process.env.SMTP_HOST || process.env.EMAIL_HOST;
const SMTP_PORT = process.env.SMTP_PORT || process.env.EMAIL_PORT;
const SMTP_USER = process.env.SMTP_USER || process.env.EMAIL_USER;
const SMTP_PASS = process.env.SMTP_PASS || process.env.EMAIL_PASS;
const SMTP_SECURE = /^(1|true)$/i.test(process.env.SMTP_SECURE || "");
const EMAIL_FROM = process.env.EMAIL_FROM || process.env.SMTP_FROM;

export function isSmtpConfigured(): boolean {
  return Boolean(SMTP_HOST && SMTP_PORT);
}

export function isAwsSesConfigured(): boolean {
  return Boolean(
    process.env.AWS_ACCESS_KEY_ID &&
      process.env.AWS_SECRET_ACCESS_KEY &&
      process.env.AWS_REGION,
  );
}

let _sesClient: SESClient | null = null;

function getSesClient(): SESClient {
  if (!_sesClient) {
    if (!isAwsSesConfigured()) {
      throw new Error(
        "AWS SES is not configured (set AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY and AWS_REGION).",
      );
    }
    _sesClient = new SESClient({
      region: process.env.AWS_REGION as string,
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID as string,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY as string,
      },
    });
  }
  return _sesClient;
}

export interface IEmail {
  to?: string[];
  subject: string;
  html: string;
}

export interface IEmailResult {
  success: boolean;
  messageId?: string;
  error?: {
    code: string;
    message: string;
    details?: any;
  };
}

export class EmailRequest implements IEmail {
  public readonly html: string;
  public readonly subject: string;
  public readonly to: string[];

  constructor(toEmails: string[], subject: string, content: string) {
    this.to = toEmails;
    this.subject = subject;
    this.html = content;
  }
}

function isValidMailBody(body: IEmail) {
  const validator = new Validator();
  return validator.validate(body, emailRequestSchema).valid;
}

async function removeMails(query: string, emails: string[]) {
  let result: QueryResult<{ email: string }>;
  try {
    result = await db.query(query, []);
  } catch (error) {
    // The bounce/spam/deleted tables may not exist in a fresh CE deployment,
    // or the DB may be unavailable. Filtering is best-effort and must never
    // prevent a message from being sent (or crash the request).
    log_error(error);
    return;
  }
  const bouncedEmails = result.rows.map((e) => e.email);
  for (let i = emails.length - 1; i >= 0; i--) {
    const email = emails[i];
    if (bouncedEmails.includes(email)) {
      emails.splice(i, 1);
    }
  }
}

async function logEmailAttempt(
  email: string,
  subject: string,
  html: string,
): Promise<string | null> {
  try {
    const q = `
      INSERT INTO email_logs (email, subject, html, status)
      VALUES ($1, $2, $3, 'pending')
      RETURNING id;
    `;
    const result = await db.query(q, [email, subject, html]);
    return result.rows[0]?.id || null;
  } catch (error) {
    log_error(error);
    return null;
  }
}

async function updateEmailLogStatus(
  logId: string,
  status: "sent" | "failed",
  messageId?: string,
  errorDetails?: string,
): Promise<void> {
  try {
    const q = `
      UPDATE email_logs
      SET status = $2, message_id = $3, error_details = $4, updated_at = CURRENT_TIMESTAMP
      WHERE id = $1;
    `;
    await db.query(q, [logId, status, messageId, errorDetails]);
  } catch (error) {
    log_error(error);
  }
}

function categorizeError(error: any): {
  code: string;
  message: string;
  details?: any;
} {
  if (error.name === "MessageRejected") {
    return {
      code: "MESSAGE_REJECTED",
      message: "Email rejected by Amazon SES",
      details: error.message,
    };
  }

  if (error.name === "SendingQuotaExceeded") {
    return {
      code: "QUOTA_EXCEEDED",
      message: "Daily sending quota exceeded",
      details: error.message,
    };
  }

  if (error.name === "Throttling") {
    return {
      code: "RATE_LIMITED",
      message: "Sending rate exceeded",
      details: error.message,
    };
  }

  if (error.code === "InvalidParameterValue") {
    return {
      code: "INVALID_EMAIL",
      message: "Invalid email address or parameters",
      details: error.message,
    };
  }

  if (error.code === "NetworkingError") {
    return {
      code: "NETWORK_ERROR",
      message: "Network connection failed",
      details: error.message,
    };
  }

  return {
    code: "UNKNOWN_ERROR",
    message: error.message || "Unknown error occurred",
    details: error,
  };
}

async function filterSpamEmails(emails: string[]): Promise<void> {
  await removeMails("SELECT email FROM spam_emails ORDER BY email;", emails);
}

async function filterBouncedEmails(emails: string[]): Promise<void> {
  await removeMails("SELECT email FROM bounced_emails ORDER BY email;", emails);
}

async function filterDeletedAccountEmails(emails: string[]): Promise<void> {
  await removeMails(
    "SELECT email FROM users WHERE is_deleted IS TRUE ORDER BY email;",
    emails,
  );
}

/** Send through the AWS SES API. Only called when AWS creds are configured. */
async function sendViaSes(email: IEmail): Promise<string> {
  const client = getSesClient();

  const charset = "UTF-8";

  const plainText = lodash.unescape(
    sanitizeHtmlLib(email.html, { allowedTags: [], allowedAttributes: {} })
  )
    .replace(/\s+/g, " ")
    .trim();

  const command = new SendEmailCommand({
    Destination: {
      ToAddresses: email.to,
    },
    Message: {
      Subject: {
        Charset: charset,
        Data: email.subject,
      },
      Body: {
        Html: {
          Charset: charset,
          Data: email.html,
        },
        Text: {
          Charset: charset,
          Data: plainText,
        },
      },
    },
    Source: "Worklenz <noreply@worklenz.com>",
  });

  const res = await client.send(command);
  return res.MessageId || String(Date.now());
}

/** Send through a Nodemailer SMTP transport. Used when SMTP_* is configured. */
async function sendViaSmtp(email: IEmail): Promise<string> {
  const transporter = nodemailer.createTransport({
    host: SMTP_HOST as string,
    port: Number(SMTP_PORT),
    secure: SMTP_SECURE,
    auth: {
      user: SMTP_USER as string,
      pass: SMTP_PASS as string,
    },
    pool: true,
    maxConnections: 5,
    rateLimit: 10,
  });

  const from = EMAIL_FROM || SMTP_USER || "Worklenz <noreply@worklenz.com>";
  const info = await transporter.sendMail({
    from,
    to: (email.to || []).join(", "),
    subject: email.subject,
    html: email.html,
  });

  return (typeof info.messageId === "string" && info.messageId) || String(Date.now());
}

export async function sendEmail(email: IEmail): Promise<string | null> {
  const result = await sendEmailEnhanced(email);
  return result.success ? result.messageId || null : null;
}

export async function sendEmailEnhanced(email: IEmail): Promise<IEmailResult> {
  const logIds: string[] = [];

  try {
    const options = { ...email } as IEmail;
    options.to = Array.isArray(options.to)
      ? Array.from(new Set(options.to))
      : [];

    // Filter out empty, null, undefined, and invalid emails
    options.to = options.to
      .filter(
        (email) =>
          email && typeof email === "string" && email.trim().length > 0,
      )
      .map((email) => email.trim())
      .filter((email) => isValidateEmail(email));

    if (options.to.length) {
      await filterBouncedEmails(options.to);
      await filterSpamEmails(options.to);
      await filterDeletedAccountEmails(options.to);
    }

    // Double-check that we still have valid emails after filtering
    if (!options.to.length) {
      return {
        success: false,
        error: {
          code: "NO_VALID_RECIPIENTS",
          message: "No valid email addresses after filtering",
        },
      };
    }

    if (!isValidMailBody(options)) {
      return {
        success: false,
        error: {
          code: "INVALID_EMAIL_BODY",
          message: "Email body validation failed",
        },
      };
    }

    // Log email attempt for each recipient
    for (const recipient of options.to) {
      const logId = await logEmailAttempt(
        recipient,
        options.subject,
        options.html,
      );
      if (logId) {
        logIds.push(logId);
      }
    }

    let messageId: string | undefined;

    // Choose a transport. SMTP is preferred (CE production runs a standard
    // SMTP server); SES is only used when explicit AWS credentials + region
    // are present. When neither is configured we fail gracefully.
    if (isSmtpConfigured()) {
      console.log("\n📧 Sending email via SMTP (nodemailer)...");
      console.log("To:", options.to.join(", "));
      console.log("Subject:", options.subject);
      messageId = await sendViaSmtp(options);
    } else if (isAwsSesConfigured()) {
      console.log("\n📧 Sending email via AWS SES...");
      console.log("To:", options.to.join(", "));
      console.log("Subject:", options.subject);
      messageId = await sendViaSes(options);
    } else {
      console.warn(
        "⚠️  No email transport configured. Set SMTP_HOST/SMTP_PORT " +
          "(optionally SMTP_USER/SMTP_PASS) or AWS SES credentials to send email. " +
          "Skipping delivery.",
      );
      return {
        success: false,
        error: {
          code: "NO_EMAIL_TRANSPORT",
          message:
            "No email transport configured (set SMTP_* or AWS SES credentials).",
        },
      };
    }

    console.log("✅ Email sent successfully!");
    console.log("Message ID:", messageId);

    // Update log status to sent
    // Append index to messageId to make it unique per recipient when sending to multiple
    for (let i = 0; i < logIds.length; i++) {
      const uniqueMessageId =
        logIds.length > 1 ? `${messageId}-${i}` : messageId;
      await updateEmailLogStatus(logIds[i], "sent", uniqueMessageId);
    }

    return {
      success: true,
      messageId,
    };
  } catch (e: any) {
    // Any sending error (SMTP disconnect, SES API failure, etc.) is non-fatal.
    // Log it (console.warn + log_error) and return a structured failure so the
    // caller — and ultimately the HTTP request / OAuth callback — never crashes.
    console.warn("⚠️  Email send failed:", e?.message || e);
    log_error(e);
    const categorizedError = categorizeError(e);

    // Update log status to failed
    for (const logId of logIds) {
      await updateEmailLogStatus(
        logId,
        "failed",
        undefined,
        JSON.stringify(categorizedError),
      );
    }

    return {
      success: false,
      error: categorizedError,
    };
  }
}
