# Jarvis

**Telegram-Bot für Disziplin: Habits, Training und Instagram.**
Von [echte BΛLΛNCΣ](https://instagram.com/echte_balance) · *Body · Game · Hustle · Mind*

[Deutsch](#deutsch) · [English](#english) · [💜 Unterstützen / Support](https://paypal.me/counting)

---

## Deutsch

Jarvis ist ein Telegram-Bot, der dir hilft, jeden Tag dranzubleiben. Er läuft bei uns auf einem Raspberry Pi und ist hier offen einsehbar, damit jeder nachprüfen kann, was er tut und was er speichert.

### Funktionen

| Bereich | Was Jarvis macht | Befehle |
|---|---|---|
| **Habits** | Tägliche Aufgaben abhaken, Zeiten eintragen, Erinnerungen zur Uhrzeit | `/hustle` `/log` `/habit` `/time` `/time alle aus` |
| **Training** | Geführte Einheit Übung für Übung, letzte Werte und Bestwerte, Supersätze | `/training` `/verlauf` `/add` |
| **Trainingsplan** | Pläne im Zyklus (z. B. 3 Tage Training, 1 Pause), Vorgaben je Übung, Import als `.txt` | `/plan` `/modus` |
| **Gewicht & Statistik** | Körpergewicht, Wochen- und Monatsquote, Wochenbericht | `/gewicht` `/stats` `/stunden` |
| **Instagram-Export** | Instagram-Datenexport hochladen: wer dir nicht zurückfolgt, Entfolgen-Liste, Unfollower | `/insta` `/entfolgen` `/unfollower` |
| **Instagram-Tracker** *(Extra)* | Über die offizielle Meta-API: aktive Kommentierer, neue Leute, offene Kommentare | `/status` `/neu` `/unbeantwortet` |
| **KI-Antwortvorschläge** *(Extra)* | Fünf Antworten auf offene Kommentare, mit eigenem Gratis-Schlüssel (GroqCloud oder Google Gemini) | `/ki` `/antworten` |

Zugang gibt es per Einladung oder auf Anfrage. Extras werden einzeln vom Admin freigeschaltet (`/freischaltung`, Admin: `/anfragen`).

### Datenschutz und Meta

- **Nur offizielle Meta-API**, nur das eigene Konto wird gelesen. Kein Scraping, kein automatisches Liken, Folgen oder Kommentieren.
- **Sparsam:** wenige Anfragen pro Tag, die Auslastung laut Meta zeigt `/apicalls`.
- **Verschlüsselt:** Meta-Tokens und KI-Schlüssel werden mit AES-256-GCM gespeichert (`packages/core/src/crypto.ts`). Nachrichten mit Tokens löscht der Bot sofort aus dem Chat.
- **Löschen:** `/loeschen` entfernt das Konto mit allen Daten. Was gespeichert wird, zeigt `/datenschutz`.

### Technik

- Node.js ≥ 22.18 mit TypeScript ohne Build-Schritt (Type Stripping), [grammY](https://grammy.dev), PostgreSQL
- npm-Workspaces: `apps/bot` (Bot) und `packages/*` (core, db, instagram, planner, training)
- Tests mit `node --test` gegen eine lokale Datenbank, jeder Test in einer Transaktion, die zurückgerollt wird

### Selbst betreiben

1. PostgreSQL einrichten (Windows: [docs/postgres-windows.md](docs/postgres-windows.md)).
2. Bot bei [@BotFather](https://t.me/BotFather) anlegen.
3. `.env.example` nach `.env` kopieren und ausfüllen (Datenbank, Bot-Token, deine Telegram-ID, Schlüssel für die Verschlüsselung).
4. Installieren, Datenbank anlegen, starten:
   ```bash
   npm install
   npm run db:migrate
   npm run bot:dev
   ```
5. Prüfen: `npm run typecheck` und `npm test`.

Für einen Raspberry Pi gibt es `scripts/deploy-pi.sh` und systemd-Dateien in `scripts/pi/` (Platzhalter `PI_USER` ersetzen).

Die Texte im Bot (`apps/bot/src/texts.ts`) sind auf echte BΛLΛNCΣ zugeschnitten. Für einen eigenen Bot dort Namen und Texte anpassen.

### Unterstützen

Jarvis ist kostenlos und ohne Werbung. Wenn er dir hilft, freuen wir uns über eine Spende, damit Server und Weiterentwicklung laufen können:

**[💜 Jetzt unterstützen (PayPal)](https://paypal.me/counting)**

Im Bot geht das auch mit `/unterstuetzen`.

### Lizenz

Der Code steht unter der **GNU AGPL-3.0** (siehe `LICENSE`). Wer den Bot verändert und als Dienst für andere betreibt, muss den geänderten Quellcode ebenfalls offenlegen.

Name, Logo und Bilder von **echte BΛLΛNCΣ** und **Jarvis** sind nicht Teil der Lizenz und dürfen ohne Erlaubnis nicht verwendet werden.

---

## English

Jarvis is a Telegram bot that helps you stay disciplined every day. We run it on a Raspberry Pi and publish the code so anyone can check what it does and what it stores. The bot itself speaks German.

### Features

| Area | What Jarvis does | Commands |
|---|---|---|
| **Habits** | Check off daily tasks, log time, reminders at a set time | `/hustle` `/log` `/habit` `/time` |
| **Training** | Guided session exercise by exercise, last and best values, supersets | `/training` `/verlauf` `/add` |
| **Training plan** | Cycle-based plans (e.g. 3 days on, 1 off), targets per exercise, `.txt` import | `/plan` `/modus` |
| **Weight & stats** | Body weight, weekly and monthly score, weekly report | `/gewicht` `/stats` |
| **Instagram export** | Upload your Instagram data export: who doesn't follow back, unfollow list, unfollowers | `/insta` `/entfolgen` |
| **Instagram tracker** *(extra)* | Via the official Meta API: active commenters, new people, open comments | `/status` `/neu` `/unbeantwortet` |
| **AI reply suggestions** *(extra)* | Five replies to open comments, using your own free key (GroqCloud or Google Gemini) | `/ki` `/antworten` |

### Privacy and Meta

- **Official Meta API only**, reading only your own account. No scraping, no automated liking, following or commenting.
- **Encrypted:** Meta tokens and AI keys are stored with AES-256-GCM. Messages containing tokens are deleted from the chat right away.
- `/loeschen` deletes the account and all data.

### Running it yourself

Requires Node.js ≥ 22.18 and PostgreSQL. Copy `.env.example` to `.env`, fill it in, then run `npm install`, `npm run db:migrate` and `npm run bot:dev`. Check with `npm run typecheck` and `npm test`.

### Support

Jarvis is free and has no ads. If it helps you, a donation keeps the server and development going:

**[💜 Support Jarvis (PayPal)](https://paypal.me/counting)**

### License

Code: **GNU AGPL-3.0** (see `LICENSE`). If you modify the bot and run it as a service for others, you must publish your modified source code too.

The names, logo and images of **echte BΛLΛNCΣ** and **Jarvis** are not covered by the license and may not be used without permission.
