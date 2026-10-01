import pg from "pg";

export type Client = pg.Client;

/**
 * A connection with the same output settings on both sides, so a row's text
 * form, and therefore its checksum, is the same in Supabase and in the new
 * database.
 */
export async function connect(url: string, name: string): Promise<Client> {
  const client = new pg.Client({ connectionString: url, application_name: name });
  await client.connect();
  await client.query(
    "SET TimeZone = 'UTC'; SET DateStyle = 'ISO, MDY'; SET IntervalStyle = 'postgres';" +
      " SET extra_float_digits = 1; SET statement_timeout = 0",
  );
  return client;
}

export const ident = (name: string) => `"${name.replace(/"/g, '""')}"`;
