// Benachrichtigungs-Einstellungen pro Nutzer und Schutz vor doppeltem Versand.
import type { Queryable } from '@echte-balance/db';

export interface NotificationSetting {
  enabled: boolean;
  localTime: string | null; // HH:MM in der Zeitzone des Nutzers
  options: Record<string, unknown>;
}

/** Liest eine Einstellung; ohne Eintrag gelten die übergebenen Standardwerte. */
export async function getNotification(
  db: Queryable,
  customerId: number,
  kind: string,
  defaults: NotificationSetting,
): Promise<NotificationSetting> {
  const { rows } = await db.query(
    `SELECT enabled, to_char(local_time, 'HH24:MI') AS local_time, options
     FROM core.notification_settings WHERE customer_id = $1 AND kind = $2`,
    [customerId, kind],
  );
  if (!rows[0]) return defaults;
  return {
    enabled: rows[0].enabled,
    localTime: rows[0].local_time,
    options: { ...defaults.options, ...rows[0].options },
  };
}

export async function setNotification(db: Queryable, customerId: number, kind: string, value: NotificationSetting) {
  await db.query(
    `INSERT INTO core.notification_settings (customer_id, kind, enabled, local_time, options) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (customer_id, kind) DO UPDATE
       SET enabled = EXCLUDED.enabled, local_time = EXCLUDED.local_time, options = EXCLUDED.options`,
    [customerId, kind, value.enabled, value.localTime, JSON.stringify(value.options)],
  );
}

/** true, wenn diese Benachrichtigung noch nicht verschickt wurde (und merkt sie sich). */
export async function claimNotification(db: Queryable, customerId: number, kind: string, ref: string): Promise<boolean> {
  const r = await db.query(
    'INSERT INTO core.notification_log (customer_id, kind, ref) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
    [customerId, kind, ref],
  );
  return (r.rowCount ?? 0) > 0;
}
