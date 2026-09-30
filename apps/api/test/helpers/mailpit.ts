// Reads the emails the API sent, from Mailpit's HTTP API (plan §14.2).
import { localStack } from "@spatial/config";

const api = localStack().mailpitApiUrl;

interface Summary {
  ID: string;
  Subject: string;
}

/** The newest email to `address` whose subject matches, waiting briefly for delivery. */
export async function latestEmail(
  address: string,
  subject: RegExp,
): Promise<{ subject: string; text: string }> {
  for (let attempt = 0; attempt < 25; attempt++) {
    const res = await fetch(`${api}/search?query=${encodeURIComponent(`to:"${address}"`)}`);
    const { messages } = (await res.json()) as { messages: Summary[] };
    const match = messages.find((m) => subject.test(m.Subject));
    if (match) {
      const message = (await (await fetch(`${api}/message/${match.ID}`)).json()) as {
        Subject: string;
        Text: string;
      };
      return { subject: message.Subject, text: message.Text };
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`No email to ${address} matching ${subject}`);
}

/** Number of emails Mailpit holds for `address`. */
export async function countEmails(address: string): Promise<number> {
  const res = await fetch(`${api}/search?query=${encodeURIComponent(`to:"${address}"`)}`);
  const { messages } = (await res.json()) as { messages: Summary[] };
  return messages.length;
}

/** The `token` query parameter of the first link in an email. */
export function tokenFrom(text: string): string {
  const match = text.match(/[?&]token=([A-Za-z0-9_-]+)/);
  if (!match?.[1]) throw new Error("No token link in email");
  return match[1];
}
