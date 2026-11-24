function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} fehlt in der .env (siehe .env.example)`);
  return value;
}

import { parseKey } from '@echte-balance/core/crypto';

export const config = {
  botToken: required('CUSTOMER_BOT_TOKEN'),
  adminId: Number(required('ADMIN_TELEGRAM_ID')),
  /** Spendenlink für /unterstuetzen und die Willkommensnachricht; per .env überschreibbar */
  donationUrl: process.env.DONATION_URL || 'https://paypal.me/counting',
  /** Öffentlicher Link zur Anleitung (/anleitung). Ohne Link schickt der Bot docs/anleitung.html als Datei. */
  guideUrl: process.env.GUIDE_URL || '',
  /** Verschlüsselt die Meta-Tokens der Nutzer */
  tokenKey: parseKey(process.env.TOKEN_ENCRYPTION_KEY),
};

if (!Number.isSafeInteger(config.adminId)) throw new Error('ADMIN_TELEGRAM_ID muss eine Zahl sein');
