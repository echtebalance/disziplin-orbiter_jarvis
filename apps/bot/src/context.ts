import type { Context } from 'grammy';
import type { Customer } from '@echte-balance/core/customers';

/** Kontext jeder Nachricht: customer ist gesetzt, sobald jemand registriert ist. */
export type BotContext = Context & { customer?: Customer };

/** Telegram-Identität aus dem Kontext, im Format für die core-Funktionen. */
export function identity(ctx: Context) {
  const from = ctx.from!;
  return {
    id: from.id,
    username: from.username,
    name: [from.first_name, from.last_name].filter(Boolean).join(' ') || undefined,
  };
}

export const esc = (s: unknown) =>
  String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
