import "server-only";

export interface DarajaEnvironmentConfig {
  enabled: true;
  environment: "sandbox" | "production";
  short_code: string;
  consumer_key: string;
  consumer_secret: string;
  passkey: string;
  callback_secret: string;
  callback_url: string;
}

export function getDarajaEnvironmentConfig(propertyId: string, outletId: string) {
  const configuredPropertyId = process.env.DARAJA_PROPERTY_ID?.trim();
  const configuredOutletId = process.env.DARAJA_OUTLET_ID?.trim();
  if (!configuredPropertyId && !configuredOutletId) return null;
  if (!configuredPropertyId || !configuredOutletId) {
    throw new Error("DARAJA_PROPERTY_ID and DARAJA_OUTLET_ID must both be configured.");
  }
  if (configuredPropertyId !== propertyId || configuredOutletId !== outletId) return null;
  if (process.env.DARAJA_ENABLED?.trim().toLowerCase() !== "true") return null;

  const environment = process.env.DARAJA_ENVIRONMENT?.trim();
  if (environment !== "sandbox" && environment !== "production") {
    throw new Error("DARAJA_ENVIRONMENT must be sandbox or production.");
  }

  const shortCode = process.env.DARAJA_SHORT_CODE?.trim();
  const consumerKey = process.env.DARAJA_CONSUMER_KEY?.trim();
  const consumerSecret = process.env.DARAJA_CONSUMER_SECRET?.trim();
  const passkey = process.env.DARAJA_PASSKEY?.trim();
  const callbackSecret = process.env.DARAJA_CALLBACK_SECRET?.trim();
  const callbackUrl = process.env.DARAJA_CALLBACK_URL?.trim();
  if (!shortCode || !/^[0-9]{5,10}$/.test(shortCode) || !consumerKey || !consumerSecret || !passkey ||
      !callbackSecret || callbackSecret.length < 32 || !callbackUrl) {
    throw new Error("Daraja environment configuration is incomplete or invalid.");
  }

  let parsedCallbackUrl: URL;
  try {
    parsedCallbackUrl = new URL(callbackUrl);
  } catch {
    throw new Error("DARAJA_CALLBACK_URL must be a public HTTPS callback URL.");
  }
  if (parsedCallbackUrl.protocol !== "https:" || parsedCallbackUrl.username || parsedCallbackUrl.password ||
      parsedCallbackUrl.hash || !parsedCallbackUrl.pathname.replace(/\/+$/, "").endsWith("/api/integrations/daraja/callback")) {
    throw new Error("DARAJA_CALLBACK_URL must be a public HTTPS callback URL ending in /api/integrations/daraja/callback.");
  }

  return {
    enabled: true,
    environment,
    short_code: shortCode,
    consumer_key: consumerKey,
    consumer_secret: consumerSecret,
    passkey,
    callback_secret: callbackSecret,
    callback_url: callbackUrl,
  } satisfies DarajaEnvironmentConfig;
}
