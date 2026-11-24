// Alle längeren Texte an einer Stelle, damit du sie ohne Programmierkenntnisse anpassen kannst.
// HTML erlaubt: <b>fett</b>, <i>kursiv</i>, <a href="...">Link</a>.

export const texts = {
  welcome: (name: string) =>
    `Willkommen bei <b>echte BΛLΛNCΣ</b>, ${name}! 💜\n\n` +
    `Ich bin <b>Jarvis</b>, dein Disziplin-Bot. Disziplin baust du dir jeden Tag selbst, Schritt für Schritt. ` +
    `Genau dafür bin ich da: Ich erinnere dich, halte dich auf Kurs und zeige dir schwarz auf weiß, ob du durchziehst. ` +
    `<b>Body · Game · Hustle · Mind</b> - alles in einem Chat, ohne App, ohne Abo, ohne Werbung.\n\n` +
    `🏋️ <b>BODY - Training mit Plan</b>\n` +
    `Dein Trainingsplan mit Vorgaben für jeden Satz, Satz für Satz eintragen, „🔁 Wie letztes Mal“ mit einem Tipp, ` +
    `Bestwerte, Körpergewicht und Ausdauer. Zur Trainingszeit klopfe ich an. Ausreden zählen nicht.\n` +
    `💪 <i>Fertige Trainings- und Recovery-Pläne, raffiniert durchdacht mit der Hilfe von Olympia-Sportlern, gibt es auf Anfrage zum Reinladen. ` +
    `Schreib mir einfach: /anfrage</i>\n\n` +
    `🚀 <b>HUSTLE - Jeden Tag abhaken</b>\n` +
    `Habits und Side-Hustle mit einem Tipp erledigen, Arbeitszeit mit Wochensoll, Termine mit Erinnerung. ` +
    `Du legst fest, wann ich dich an deine Ziele erinnere. Fertige Habits wie Stretching, gesunde Ernährung ` +
    `oder Morgenlektüre übernimmst du mit einem Tipp: /habit vorlagen\n\n` +
    `📸 <b>GAME - Instagram im Griff</b>\n` +
    `Wer folgt dir nicht zurück, wer hat dir entfolgt? Export hochladen und in sicheren 5er-Schritten aufräumen, ` +
    `alles auch als Excel-Datei.\n\n` +
    `🧠 <b>MIND - Disziplin sichtbar machen</b>\n` +
    `/stats zeigt deine Quote pro Woche, den Vergleich zur Vorwoche, Arbeit gegen Side-Hustle und deine stärkste ` +
    `und schwächste Gewohnheit. Jeden Samstag kommt dein Wochenbericht: ehrlich und ohne Schönreden.\n\n` +
    `🔓 <b>EXTRA - Instagram-Tracker</b> <i>(auf Anfrage: /freischaltung)</i>\n` +
    `Über die offizielle Schnittstelle von Meta - kein Scraping, ganz nach den Regeln von Meta - siehst du jeden Tag, ` +
    `<b>wer bei dir aktiv ist</b> und auf deinen Gegenbesuch wartet, und <b>wen du schon zu lange vergessen hast</b>.\n\n` +
    `<i>Kleine Schritte, jeden Tag. Das ist echte Balance.</i>\n\n` +
    `👇 Wähle einen Bereich und fang heute an:`,

  // Schnellstart je Bereich (Buttons unter der Willkommensnachricht)
  quickstart: {
    training:
      `🏋️ <b>Schnellstart Training</b>\n\n` +
      `1. Übungen anlegen: <code>/plan add 1 Bankdrücken</code> (1 = Trainingstag 1)\n` +
      `2. Plan aktivieren: <code>/modus split</code> (3 Tage Training, 1 Tag Pause)\n` +
      `3. Loslegen: /training und dann einfach <code>80x8</code> schicken\n` +
      `4. Automatisch starten: <code>/time training 17:30</code>\n\n` +
      `Eigener Zyklus: <code>/plan neu Oberkörper Unterkörper 2 1</code> · Fortschritt: <code>/verlauf Bankdrücken</code>\n\n` +
      `📄 <b>Schneller:</b> Plan als Textdatei schicken - mit allen Übungen, Sätzen, Wiederholungen und Gewichten. ` +
      `Vorlage: /plan vorlage\n\n` +
      `💪 <b>Fertige Pläne:</b> Trainings- und Recovery-Pläne bekommst du auf Anfrage ` +
      `direkt in dein Training geladen. Schreib einfach: <code>/anfrage Ich hätte gern einen Plan für …</code>`,
    planner:
      `🚀 <b>Schnellstart Planer</b>\n\n` +
      `1. Heute abhaken: /hustle → Aufgabe antippen → Zeit wählen\n` +
      `2. Zeit eintragen: <code>/log side 1:30</code>\n` +
      `3. Eigene Aufgabe: <code>/habit neu lesen 15 60 Lesen</code>\n` +
      `4. Erinnerung: <code>/time lesen 21:00</code>\n` +
      `5. Termin: <code>/termin Zahnarzt morgen 9:00</code>\n\n` +
      `✨ Fertige Habits mit einem Tipp: /habit vorlagen\n` +
      `Arbeitszeit mit Wochensoll: <code>/habit woche arbeit 38,5</code> · Erinnerungen einstellen: /erinnerung`,
    instagram:
      `📸 <b>Schnellstart Instagram</b>\n\n` +
      `1. In Instagram deinen Export anfordern (Anleitung: /insta)\n` +
      `2. Die ZIP-Datei hier in den Chat schicken. Oder nur die zwei Dateien <code>following.json</code> und ` +
      `<code>followers_1.json</code> (aus dem Ordner connections/followers_and_following) und danach /import\n` +
      `3. /nichtfolger - wer dir nicht zurückfolgt\n` +
      `4. /entfolgen - in sicheren 5er-Schritten abarbeiten\n\n` +
      `Ab dem zweiten Export siehst du mit /unfollower, wer dir entfolgt ist. Tipp: alle 1-2 Wochen exportieren.\n\n` +
      `🔓 Extra auf Anfrage: der <b>Instagram-Tracker</b> zeigt dir jeden Tag, wer bei dir aktiv ist und wem du antworten solltest. ` +
      `Anfragen mit /freischaltung`,
    stats:
      `🧠 <b>Schnellstart Statistik</b>\n\n` +
      `<code>/stats</code> - heute · <code>/stats woche</code> · <code>/stats vorwoche</code> · <code>/stats monat</code>\n` +
      `<code>/stunden woche</code> - Zeit pro Aufgabe\n\n` +
      `100 % = die Mindestzeit jeder Aufgabe (Training: alle Übungen erledigt). Einzelne Aufgaben dürfen über 100 % gehen, ` +
      `in der Gesamtquote zählt jede höchstens 100 %. Samstags um 20:00 kommt dein Wochenbericht automatisch.`,
  },

  requestHelp:
    `📩 <b>Anfrage an echte BΛLΛNCΣ</b>\n\n` +
    `Schreib deine Nachricht direkt hinter den Befehl, zum Beispiel:\n` +
    `<code>/anfrage Ich hätte gern einen Recovery-Plan, 3x pro Woche, Ziel Muskelaufbau</code>\n\n` +
    `Fertige Trainings- und Recovery-Pläne werden dir bei Zusage direkt ` +
    `in dein Training geladen. Für Fragen, Feedback und Ideen ist /anfrage auch da.`,

  planImportHelp:
    `📄 <b>Trainingsplan einspielen</b>\n\n` +
    `Schick mir den Plan jetzt als Text (oder jederzeit als <b>.txt-Datei</b>), zum Beispiel:\n\n` +
    `<code>Plan: Push Pull Beine\nZyklus: 3 1\n\nTag 1: Push\nBankdrücken: 60kg x 10, 70kg x 8, 80kg x 6\nSchrägbank: 3x10 @ 24kg\nDips (KG): 3x12</code>\n\n` +
    `• <code>60kg x 10, 70kg x 8</code> = Gewicht x Wiederholungen je Satz\n` +
    `• <code>3x10 @ 24kg</code> = 3 Sätze à 10 mit 24 kg · <code>3x12-15</code> = Bereich\n` +
    `• <code>(KG)</code> = Körpergewichtsübung · <code>3x60s</code> = Sekunden\n\n` +
    `Du bekommst zuerst eine Vorschau. Vorlage als Datei: /plan vorlage`,

  noInvite:
    `<b>Jarvis</b> - der Disziplin-Bot von <b>echte BΛLΛNCΣ</b> 💜\n\n` +
    `Training mit Plan, Habits und Side-Hustle mit Erinnerungen, Instagram im Griff und ein Wochenbericht, ` +
    `der dir ehrlich zeigt, ob du durchziehst.\n\n` +
    `🔒 Der Zugang ist nur mit Einladung möglich.\n\n` +
    `<b>Noch keine Einladung?</b> Tippe auf „🙋 Zugang anfragen“. Wenn du magst, erzähl kurz, wer du bist: ` +
    `<code>/anfrage Hi, ich bin …</code>\n\n` +
    `Du hast einen Code? Dann so: <code>/start DEINCODE</code>

` +
    `📘 Was Jarvis alles kann, zeigt dir die Anleitung: /anleitung`,

  // Telegram-Profil: Beschreibung im leeren Chat vor dem Start (max. 512 Zeichen) und Kurzbeschreibung (max. 120)
  botDescription:
    'Jarvis - der Disziplin-Bot von echte BΛLΛNCΣ 💜\n\n' +
    'Ich erinnere dich, halte dich auf Kurs und zeige dir, ob du durchziehst:\n\n' +
    '🏋️ Training mit Plan, Vorgaben und Bestwerten\n' +
    '🚀 Habits, Side-Hustle und Termine mit Erinnerungen\n' +
    '📸 Instagram-Tracker: sagt dir, wer aktiv ist und wem du antworten solltest (offizielle Meta-API)\n' +
    '🧠 Wochenbericht und Statistik zu deiner Disziplin\n\n' +
    'Zugang mit Einladung oder auf Anfrage: einfach Start tippen. Extras wie den Instagram-Tracker ' +
    'fragst du im Bot mit /freischaltung an.',
  botShortDescription: 'Jarvis, dein Disziplin-Bot: Training, Habits, Side-Hustle & Instagram-Tracker. 💜',

  inviteErrors: {
    invalid: 'Diesen Einladungscode kenne ich nicht. Bitte prüf ihn noch einmal.',
    used: 'Dieser Einladungscode wurde schon verwendet.',
    expired: 'Dieser Einladungscode ist abgelaufen. Frag nach einem neuen.',
    already_registered: 'Du bist schon registriert. 🙂',
  },

  help: (isAdmin: boolean) =>
    [
      '<b>Allgemein</b>',
      '/hilfe - diese Übersicht',
      '/anleitung - Anleitung mit Beispielen zu den wichtigsten Funktionen',
      '/unterstuetzen - den Bot unterstützen',
      '/freischaltung - Extras wie den Instagram-Tracker anfragen',
      '/anfrage Text - Nachricht an echte BΛLΛNCΣ (z. B. Trainingsplan anfragen)',
      '/datenschutz - was gespeichert wird',
      '/loeschen - dein Konto und alle Daten löschen',
      '',
      '<b>Instagram</b>',
      '/insta - Übersicht und Anleitung zum Export',
      '/import - hochgeladene Einzeldateien einlesen',
      '/nichtfolger - wer dir nicht zurückfolgt',
      '/entfolgen - 5er-Blöcke zum Abhaken, max. 20 pro Tag',
      '/igundo [name] - Abhaken rückgängig machen',
      '/unfollower - wer dir seit dem letzten Export entfolgt ist',
      '/neuefollower - wer dir neu folgt',
      '/igexport - Listen als CSV für Excel',
      '',
      '<b>Instagram mit Meta-API</b> 🔓 (Freischaltung)',
      '/meta - Anleitung Meta-App · /verbinden · /trennen',
      '/status [Beiträge] - wer bei dir kommentiert (zum Zurückkommentieren)',
      '/snoozed · /unsnooze name - ausgeblendete Kommentierer',
      '/vergessen - aktive Kommentierer, bei denen du dich lange nicht gemeldet hast',
      '/unbeantwortet - Kommentare mit Text ohne deine Antwort',
      '/benachrichtigung 19:00|aus - tägliche Erinnerung an offene Kommentare',
      '/neu [Tage] - neue Kommentierer · /kommentierer - Nicht-Follower mit Kommentar',
      '/apicalls - wie viele Anfragen an Meta gehen',
      '',
      '<b>KI-Antworten</b> 🔓 (eigene Freischaltung)',
      '/ki - KI verbinden (kostenlos) · /antworten - 5 Vorschläge je Kommentar',
      '',
      '<b>Planer</b>',
      '/hustle - heutige Aufgaben abhaken',
      '/log name Zeit - Zeit eintragen (45, 1:30, 1,5h, nein)',
      '/reset [name] - heutigen Eintrag zurücksetzen',
      '/habit - Aufgaben verwalten (Dauer, Wochensoll, eigene Zeit-Buttons)',
      '/habit vorlagen - fertige Habits mit einem Tipp übernehmen',
      '/time name 19:00 [mo-sa] - Uhrzeit und Erinnerung',
      '/time alle aus | an - alle Erinnerungen auf einmal aus- oder einschalten',
      '/stats [woche|monat|jahr|vorwoche|vormonat] - wie gut du dabei bist',
      '/stunden [woche|monat|jahr|gesamt] - Zeit pro Aufgabe',
      '/termin Was Datum Uhrzeit · /termine',
      '/erinnerung - Termin-Erinnerungen und Berichte einstellen',
      '/urlaub [Tage] · /frei - Urlaub und freie Tage',
      '',
      '<b>Training</b>',
      '/modus [plan] [Position] - Plan aktivieren (Zyklus aus Trainings- und Pausentagen)',
      '/modus ausdauer - Training zählt nach Zeit statt nach Übungen',
      '/plan - Plan ansehen · /plan add 1 Bankdrücken · /plan tag 1 Push',
      '/plan neu Name 3 1 - eigener Plan (3 Trainingstage, 1 Pause)',
      '📄 Plan als .txt-Datei schicken = einspielen · /plan vorlage · /plan export',
      '/training [Tag] - Einheit starten, Satz für Satz eintragen (75x8)',
      '/verlauf Übung - letzte Sätze und bestes Gewicht',
      '/gewicht [kg|an|aus|zeit 07:30] - Körpergewicht',
      '/add Laufen 45 - Ausdauer eintragen',
      ...(isAdmin
        ? [
            '',
            '<b>Admin</b>',
            '/einladung [Notiz] - neuen Einladungscode erzeugen',
            '/einladungen - offene Einladungen',
            '/anfragen - alle offenen Anfragen (Zugang, Freischaltung, Nachrichten) mit Buttons',
            '/nutzer - alle Nutzer mit Freischaltungen',
            '/freischalten &lt;@name|Nr&gt; &lt;insta|plaene|ki&gt; [Tage]',
            '/sperren &lt;@name|Nr&gt; &lt;insta|plaene|ki&gt;',
            '/plan geben &lt;@name|Nr&gt; Planname - eigenen Plan als Kopie geben',
          ]
        : []),
    ].join('\n'),

  // Die Menübezeichnungen in Instagram ändern sich gelegentlich; bei Bedarf anpassen.
  instaGuide:
    `📸 <b>Instagram: Follower-Export</b>\n\n` +
    `So bekommst du deine Daten (dauert bei Instagram meist Minuten bis einige Stunden):\n\n` +
    `1. Instagram → Profil → ☰ → <b>Kontenübersicht</b>\n` +
    `2. <b>Deine Informationen und Berechtigungen</b> → <b>Deine Informationen herunterladen</b>\n` +
    `3. <b>Informationen herunterladen</b> → dein Konto wählen → <b>Einige deiner Informationen</b>\n` +
    `4. Nur <b>Follower und gefolgte Personen</b> anhaken\n` +
    `5. <b>Auf Gerät herunterladen</b>, Zeitraum <b>Gesamter Zeitraum</b>, Format <b>JSON</b> (wichtig!)\n` +
    `6. Wenn die Benachrichtigung kommt: ZIP herunterladen und <b>als Datei</b> hier in den Chat schicken\n\n` +
    `<b>Alternative:</b> ZIP entpacken und nur <code>following.json</code> und <code>followers_1.json</code> schicken ` +
    `(Ordner connections/followers_and_following; bei vielen Followern auch followers_2.json usw.). ` +
    `Wenn alle Dateien da sind: /import\n\n` +
    `Danach siehst du, wer dir nicht zurückfolgt. Ab dem zweiten Export auch, wer dir entfolgt ist. ` +
    `Tipp: alle 1-2 Wochen einen neuen Export schicken.`,

  instaApiLocked:
    `🔒 Das ist der <b>Instagram-Tracker</b> (offizielle Meta-API): wer bei dir aktiv ist und wem du antworten solltest. ` +
    `Er wird einzeln freigeschaltet - tippe unten auf den Button, um ihn anzufragen.\n\n` +
    `Kostenlos für alle: /insta (Export, Nicht-Follower, Entfolgen, Unfollower). Alle Extras: /freischaltung`,

  instaTokenInvalid:
    `⚠️ Dein Instagram-Token ist abgelaufen oder wurde widerrufen.\n` +
    `Erzeuge einen neuen (Anleitung: /meta, Schritt 3-5) und schick ihn mir nach /verbinden 1784… (deine Konto-ID). Deine Daten bleiben erhalten.`,

  instaConnectPrompt:
    `🔐 <b>Instagram verbinden</b>\n\n` +
    `Schick mir jetzt deinen Token (beginnt mit „EAA…“ oder „IG…“) als normale Nachricht.\n\n` +
    `• Ich lösche die Nachricht sofort wieder aus dem Chat.\n` +
    `• Der Token wird verschlüsselt gespeichert und nur zum Lesen deiner Beiträge und Kommentare verwendet.\n` +
    `• Bevor er abläuft, erinnere ich dich (Instagram-Tokens verlängere ich automatisch).\n` +
    `• Trennen jederzeit mit /trennen.\n\n` +
    `💡 Am sichersten klappt es mit deiner Konto-ID: zuerst <code>/verbinden 1784…</code> schreiben ` +
    `(die Zahl unter deinem Kontonamen bei „Zugriffstokens generieren“), danach den Token schicken.\n\n` +
    `Noch keinen Token? Anleitung: /meta`,

  // Hauptweg: Instagram-Zugriffstoken aus dem App-Dashboard („Token generieren“). Der Token beginnt trotzdem
  // mit "EAA…"; das Konto findet Jarvis zuverlässig über die Konto-ID (/verbinden 1784…).
  // Graph API Explorer bleibt als Alternative. Menüpunkte im Meta-Dashboard ändern sich gelegentlich.
  metaGuide:
    `📘 <b>Token für die Meta-API erzeugen</b> (einmalig, ca. 10 Minuten)\n\n` +
    `<b>Voraussetzungen</b>\n` +
    `• Dein Instagram-Konto ist ein <b>Business- oder Creator-Konto</b>.\n` +
    `• Es ist mit einer <b>Facebook-Seite</b> verknüpft (Facebook-Seite → Einstellungen → Verknüpfte Konten → Instagram).\n\n` +
    `<b>1. Entwicklerkonto</b>\ndevelopers.facebook.com öffnen, mit Facebook anmelden, als Entwickler registrieren.\n\n` +
    `<b>2. App erstellen</b>\n„Meine Apps“ → „App erstellen“ → Anwendungsfall <b>„Nachrichten und Inhalte auf Instagram verwalten“</b>. ` +
    `Name z. B. „Mein Insta Helper“.\n\n` +
    `<b>3. Instagram-Zugriffstoken generieren</b>\nIm Dashboard deiner App beim Anwendungsfall Instagram zu <b>„Zugriffstokens generieren“</b>. ` +
    `Dein Instagram-Konto hinzufügen bzw. anmelden und bei deinem Konto auf <b>„Token generieren“</b> tippen. ` +
    `Den Token kopieren (beginnt meist mit „EAA…“, das ist richtig so).\n\n` +
    `<b>4. Konto-ID notieren</b>\nUnter deinem Kontonamen steht eine lange Zahl, die mit <b>1784…</b> beginnt. Das ist deine Konto-ID.\n\n` +
    `<b>5. Verbinden</b>\nHier <code>/verbinden 1784…</code> mit deiner Konto-ID schreiben, danach den Token als eigene Nachricht schicken.\n\n` +
    `<i>Kein App Review nötig: Die App greift nur auf dein eigenes Konto zu. Bevor der Token abläuft, erinnere ich dich, ` +
    `Schritt 3-5 zu wiederholen. Den Token gibst du nur diesem Bot - nie in Gruppen oder an andere Personen.</i>\n\n` +
    `<b>Alternative: Graph API Explorer</b>\nFalls „Token generieren“ bei dir fehlt: <b>Tools → Graph API Explorer</b> → deine App wählen → ` +
    `„Nutzer-Zugriffstoken anfordern“ → Berechtigungen <code>instagram_basic</code>, <code>instagram_manage_comments</code>, ` +
    `<code>pages_show_list</code>, <code>pages_read_engagement</code> → „Generate Access Token“. ` +
    `Danach unter <b>Tools → Zugriffsschlüssel-Debugger</b> auf 60 Tage verlängern und mit /verbinden schicken.`,

  aiLocked:
    `🔒 KI-Antwortvorschläge sind eine eigene Freischaltung und brauchen den Instagram-Tracker. ` +
    `Tippe unten auf den Button, um sie anzufragen. Alle Extras: /freischaltung`,

  // Stand Nov. 2026: GroqCloud und Google Gemini, beide mit dauerhaftem Gratis-Kontingent. Menüs können sich ändern.
  aiGuide:
    `🤖 <b>KI-Antwortvorschläge einrichten</b> (kostenlos, ca. 3 Minuten)\n\n` +
    `Du brauchst einen eigenen, kostenlosen KI-Schlüssel:\n\n` +
    `<b>GroqCloud</b> (empfohlen)\n1. console.groq.com öffnen, anmelden\n2. <b>API Keys</b> → <b>„Create API Key“</b>\n` +
    `3. Schlüssel kopieren (beginnt mit „gsk_…“)\n` +
    `<i>Groq mit q, nicht „Grok“ von X.</i>\n\n` +
    `<b>oder Google Gemini</b>\n1. aistudio.google.com öffnen, mit Google-Konto anmelden\n` +
    `2. <b>„Get API key“</b> → <b>„API-Schlüssel erstellen“</b>\n3. Schlüssel kopieren (beginnt mit „AQ.“ oder „AIza…“)\n\n` +
    `Dann den Schlüssel einfach <b>hier als Nachricht</b> schicken. Ich lösche die Nachricht sofort, ` +
    `speichere den Schlüssel verschlüsselt und suche das passende Modell aus.\n\n` +
    `💡 Du kannst <b>beide</b> speichern: Ist einer überlastet, springt der andere automatisch ein. Umschalten mit /ki.\n\n` +
    `<i>Kostenlos im Rahmen der Tageslimits des Anbieters; ist das Limit erreicht, kommt eine Meldung, keine Rechnung. ` +
    `Hinweis: Bei Gratis-Angeboten können die Anbieter die gesendeten Texte (Kommentar und Bildunterschrift) ` +
    `zur Verbesserung ihrer Dienste nutzen. Schick also keine Kommentare mit sensiblen Inhalten.</i>`,

  // Vorschlag - frei anpassen.
  donation:
    `💜 Dieser Bot ist kostenlos und bleibt es. Ich entwickle ihn in meiner Freizeit, ` +
    `neben Training und Job.\n\n` +
    `Wenn er dir hilft und du mich unterstützen willst, freue ich mich über eine Spende. ` +
    `Jeder Betrag hilft, keiner ist Pflicht.`,

  // Bitte vor dem Start mit Freunden prüfen und bei Bedarf ergänzen (z. B. Kontaktadresse).
  privacy:
    `<b>Datenschutz</b>\n\n` +
    `<b>Was gespeichert wird:</b>\n` +
    `• deine Telegram-ID, dein Telegram-Name und Benutzername\n` +
    `• was du selbst einträgst (Planer, Training)\n` +
    `• Instagram-Daten, die du hochlädst oder über deine eigene Meta-App freigibst ` +
    `(z. B. Follower-Listen, Kommentare unter deinen Beiträgen)\n\n` +
    `<b>Wofür:</b> nur, damit die Funktionen dieses Bots für dich laufen. ` +
    `Keine Weitergabe, keine Werbung, kein Verkauf.\n\n` +
    `<b>KI-Antworten (nur wenn du sie nutzt):</b> Für Vorschläge werden der jeweilige Kommentar, der Benutzername ` +
    `und die Bildunterschrift an den KI-Anbieter gesendet, dessen Schlüssel du hinterlegt hast (z. B. GroqCloud oder Google). ` +
    `Dort gelten deren Datenschutzbedingungen.\n\n` +
    `<b>Wo:</b> auf einem privaten Server in Österreich.\n\n` +
    `<b>Löschen:</b> /loeschen entfernt dein Konto und alle zugehörigen Daten sofort und endgültig.`,

  deleteConfirm:
    `⚠️ <b>Konto wirklich löschen?</b>\n\n` +
    `Alle deine Daten werden sofort und endgültig gelöscht. Das lässt sich nicht rückgängig machen. ` +
    `Um den Bot wieder zu nutzen, brauchst du danach eine neue Einladung.`,
  deleted: 'Dein Konto und alle Daten wurden gelöscht. Mach’s gut! 👋',
  deleteCancelled: 'Abgebrochen, nichts wurde gelöscht.',
};
