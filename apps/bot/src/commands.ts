// Befehlsmenü in Telegram ("/"-Vorschau). Jeder sieht die Gratis-Befehle; wer Module
// freigeschaltet hat, bekommt ein eigenes Menü mit den zusätzlichen Befehlen (Scope pro Chat).
import type { Api } from 'grammy';
import type { BotCommand } from 'grammy/types';
import { getPool } from '@echte-balance/db';
import { activeModules, type Module } from '@echte-balance/core/customers';
import { config } from './config.ts';
import { texts } from './texts.ts';

const FREE: BotCommand[] = [
  { command: 'hilfe', description: 'Alle Befehle und Erklärungen' },
  { command: 'hustle', description: 'Heutige Aufgaben abhaken' },
  { command: 'log', description: 'Zeit eintragen: /log name 45' },
  { command: 'stats', description: 'Statistik: woche, vorwoche, monat …' },
  { command: 'stunden', description: 'Zeit pro Aufgabe' },
  { command: 'termin', description: 'Termin eintragen: Was Datum Uhrzeit' },
  { command: 'termine', description: 'Anstehende Termine' },
  { command: 'training', description: 'Training starten oder fortsetzen' },
  { command: 'plan', description: 'Trainingsplan ansehen und bearbeiten' },
  { command: 'modus', description: 'Trainingsplan aktivieren' },
  { command: 'verlauf', description: 'Verlauf einer Übung' },
  { command: 'gewicht', description: 'Körpergewicht' },
  { command: 'add', description: 'Ausdauer eintragen: /add Laufen 45' },
  { command: 'habit', description: 'Aufgaben verwalten' },
  { command: 'time', description: 'Uhrzeit und Erinnerung, /time alle aus|an' },
  { command: 'reset', description: 'Heutigen Eintrag zurücksetzen' },
  { command: 'erinnerung', description: 'Termin-Erinnerungen und Berichte' },
  { command: 'urlaub', description: 'Urlaubsmodus' },
  { command: 'frei', description: 'Freie Tage' },
  { command: 'insta', description: 'Instagram-Export: Übersicht und Anleitung' },
  { command: 'nichtfolger', description: 'Wer dir nicht zurückfolgt' },
  { command: 'entfolgen', description: 'Entfolgen-Liste abarbeiten' },
  { command: 'unfollower', description: 'Wer dir entfolgt ist' },
  { command: 'neuefollower', description: 'Wer dir neu folgt' },
  { command: 'igexport', description: 'Listen als CSV' },
  { command: 'igundo', description: 'Abhaken rückgängig machen' },
  { command: 'import', description: 'Hochgeladene Export-Dateien einlesen' },
  { command: 'anleitung', description: 'Anleitung mit Beispielen' },
  { command: 'freischaltung', description: 'Extras anfragen: Instagram-Tracker, KI' },
  { command: 'anfrage', description: 'Nachricht an echte BΛLΛNCΣ, z. B. Plan anfragen' },
  { command: 'unterstuetzen', description: 'Den Bot unterstützen' },
  { command: 'datenschutz', description: 'Was gespeichert wird' },
  { command: 'loeschen', description: 'Konto und Daten löschen' },
];

const INSTA: BotCommand[] = [
  { command: 'status', description: 'Wer bei dir kommentiert' },
  { command: 'unbeantwortet', description: 'Offene Kommentare und Antworten' },
  { command: 'vergessen', description: 'Aktive, bei denen du dich nicht gemeldet hast' },
  { command: 'benachrichtigung', description: 'Tägliche Instagram-Nachricht einstellen' },
  { command: 'neu', description: 'Neue Kommentierer' },
  { command: 'kommentierer', description: 'Nicht-Follower, die kommentiert haben' },
  { command: 'snoozed', description: 'Ausgeblendete Kommentierer' },
  { command: 'unsnooze', description: 'Kommentierer wieder einblenden: /unsnooze name' },
  { command: 'apicalls', description: 'Anfragen an die Meta-API' },
  { command: 'verbinden', description: 'Instagram per Meta-API verbinden' },
  { command: 'meta', description: 'Anleitung Meta-App' },
  { command: 'trennen', description: 'Instagram-Verbindung trennen' },
];

const AI: BotCommand[] = [
  { command: 'antworten', description: 'KI-Vorschläge für offene Kommentare' },
  { command: 'ki', description: 'KI verbinden und Stil einstellen' },
];

const ADMIN: BotCommand[] = [
  { command: 'einladung', description: 'Einladungscode erzeugen' },
  { command: 'einladungen', description: 'Offene Einladungen' },
  { command: 'anfragen', description: 'Alle offenen Anfragen mit Buttons' },
  { command: 'nutzer', description: 'Alle Nutzer und Freischaltungen' },
  { command: 'freischalten', description: 'Modul freischalten: @name insta|plaene|ki' },
  { command: 'sperren', description: 'Modul sperren' },
];

export function commandsFor(modules: Module[], isAdmin: boolean): BotCommand[] {
  const insta = isAdmin || modules.includes('instagram_api');
  const ai = isAdmin || (insta && modules.includes('ai_replies'));
  // Instagram-/KI-Befehle direkt nach /hilfe, damit sie oben in der Vorschau stehen
  return [FREE[0]!, ...(ai ? AI : []), ...(insta ? INSTA : []), ...FREE.slice(1), ...(isAdmin ? ADMIN : [])];
}

/** Menü für alle (ohne Freischaltungen) */
export async function setDefaultCommands(api: Api) {
  await api.setMyCommands(commandsFor([], false));
}

/** Eigenes Menü für einen Nutzer passend zu seinen Freischaltungen (oder zurück zum Standard). */
export async function setUserCommands(api: Api, customerId: number, telegramUserId: number) {
  const isAdmin = telegramUserId === config.adminId;
  const modules = await activeModules(getPool(), customerId);
  const scope = { type: 'chat' as const, chat_id: telegramUserId };
  if (!isAdmin && !modules.length) await api.deleteMyCommands({ scope }).catch(() => {});
  else await api.setMyCommands(commandsFor(modules, isAdmin), { scope });
}

/** Beschreibung im leeren Chat vor dem Start und Kurzbeschreibung im Profil */
export async function setBotProfile(api: Api) {
  await api.setMyDescription(texts.botDescription);
  await api.setMyShortDescription(texts.botShortDescription);
}

/** Beim Start: Profiltexte, Standardmenü und eigene Menüs für alle mit Freischaltung sowie den Admin. */
export async function syncAllCommands(api: Api) {
  await setBotProfile(api).catch((err) => console.warn('Bot-Beschreibung konnte nicht gesetzt werden:', err.message));
  await setDefaultCommands(api);
  const { rows } = await getPool().query(
    `SELECT DISTINCT c.id, c.telegram_user_id FROM core.customers c
     LEFT JOIN core.entitlements e ON e.customer_id = c.id
     WHERE c.deleted_at IS NULL AND (c.telegram_user_id = $1 OR e.id IS NOT NULL)`,
    [config.adminId],
  );
  for (const r of rows) await setUserCommands(api, Number(r.id), Number(r.telegram_user_id)).catch(() => {});
}
