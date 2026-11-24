-- Ohne diese Änderung blockiert eine eingelöste Einladung das Löschen des Kunden (/loeschen).
-- Die Einladung bleibt als "verbraucht" erhalten, nur der Verweis auf den Kunden fällt weg.
ALTER TABLE core.invites DROP CONSTRAINT invites_redeemed_by_fkey;
ALTER TABLE core.invites
  ADD CONSTRAINT invites_redeemed_by_fkey
  FOREIGN KEY (redeemed_by) REFERENCES core.customers(id) ON DELETE SET NULL;
