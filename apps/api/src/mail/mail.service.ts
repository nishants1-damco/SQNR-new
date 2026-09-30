// Transactional email over SMTP: Mailpit locally, Azure Communication
// Services in production (plan §10.2, §14.2). Sending happens after the
// database commit; a failure is logged, never shown to the user, because the
// account change it describes has already happened.
import { Inject, Injectable, Logger, type OnApplicationShutdown } from "@nestjs/common";
import type { ApiConfig } from "@spatial/config";
import nodemailer, { type Transporter } from "nodemailer";
import { API_CONFIG } from "../config/config.module";

export interface Mail {
  to: string;
  subject: string;
  text: string;
  html: string;
}

@Injectable()
export class MailService implements OnApplicationShutdown {
  private readonly logger = new Logger("MailService");
  private readonly transport: Transporter;

  constructor(@Inject(API_CONFIG) private readonly config: ApiConfig) {
    this.transport = nodemailer.createTransport(config.mail.smtpUrl);
  }

  /** Returns false (and logs) instead of throwing, so callers never leak delivery errors. */
  async send(mail: Mail): Promise<boolean> {
    try {
      await this.transport.sendMail({ from: this.config.mail.from, ...mail });
      return true;
    } catch (err) {
      this.logger.error({ err, subject: mail.subject }, "email delivery failed");
      return false;
    }
  }

  onApplicationShutdown() {
    this.transport.close();
  }
}
