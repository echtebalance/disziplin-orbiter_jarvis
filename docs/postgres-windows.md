# PostgreSQL unter Windows einrichten

Einmalig, ca. 15 Minuten. Danach läuft PostgreSQL als Windows-Dienst automatisch im Hintergrund.

## 1. Installieren

1. Installer von **postgresql.org/download/windows** laden (Anbieter EDB), **Version 17**.
   Auf dem Raspberry Pi installieren wir später dieselbe Hauptversion.
2. Im Installer:
   - Komponenten: **PostgreSQL Server** und **Command Line Tools**. pgAdmin ist optional (grafische Oberfläche), Stack Builder nicht nötig.
   - Passwort für den Benutzer `postgres` vergeben und **im Passwortmanager speichern**.
   - Port `5432` lassen, Locale: Standard.
3. Prüfen in einer neuen PowerShell:

   ```powershell
   & "C:\Program Files\PostgreSQL\17\bin\psql.exe" --version
   ```

   Optional `C:\Program Files\PostgreSQL\17\bin` zur PATH-Variable hinzufügen, dann reicht `psql`.

## 2. Datenbank und eigenen Benutzer anlegen

Die App arbeitet nicht mit dem Admin-Benutzer `postgres`, sondern mit einem eigenen Benutzer, der nur diese Datenbank besitzt.

```powershell
& "C:\Program Files\PostgreSQL\17\bin\psql.exe" -U postgres
```

Dann im `psql`-Prompt (eigenes Passwort statt `PASSWORT` wählen):

```sql
CREATE ROLE echte_balance LOGIN PASSWORD 'PASSWORT';
CREATE DATABASE echte_balance OWNER echte_balance;
\q
```

## 3. Projekt verbinden

Im Projektordner `.env.example` nach `.env` kopieren und eintragen:

```
DATABASE_URL=postgres://echte_balance:PASSWORT@localhost:5432/echte_balance
TOKEN_ENCRYPTION_KEY=<Ausgabe des Befehls unten>
```

Schlüssel erzeugen:

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

**Den Schlüssel zusätzlich im Passwortmanager sichern.** Ohne ihn sind gespeicherte Kunden-Tokens nicht mehr lesbar.

## 4. Tabellen anlegen

```powershell
npm run db:migrate
```

Erwartete Ausgabe: `✔ 001_core.sql`, `✔ 002_instagram.sql`. Ein zweiter Aufruf meldet „Datenbank ist aktuell".

## Hinweise

- Die PostgreSQL-Instanz von XAMPP gibt es nicht; XAMPP nutzt MariaDB für WordPress. Beide laufen unabhängig nebeneinander.
- Backups lokal: `pg_dump -U echte_balance -Fc echte_balance > backup.dump`
