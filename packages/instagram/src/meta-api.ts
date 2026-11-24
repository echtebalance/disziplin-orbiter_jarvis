// Offizielle Instagram API. Jeder Kunde nutzt seine eigene Meta-App und seinen eigenen Token
// (Standard Access, kein App Review). Zwei Token-Arten werden unterstützt:
//
//   instagram  "IG…"  Instagram-Login, graph.instagram.com
//              Berechtigungen: instagram_business_basic, instagram_business_manage_comments
//   facebook   "EAA…" Facebook-Login (Graph API Explorer, Unified Login), graph.facebook.com
//              Berechtigungen: instagram_basic, instagram_manage_comments, pages_show_list,
//              pages_read_engagement; das Instagram-Konto muss mit einer Facebook-Seite verknüpft sein.
//
// Seit Ende 2026 bietet Meta neuen Apps die Instagram-Login-Einrichtung nicht mehr an
// ("Unified Login"), daher ist der Facebook-Weg für neue Nutzer der Normalfall.
// Die Pfade für Beiträge und Kommentare sind bei beiden gleich.
//
// Der Token steht als Query-Parameter in der URL (so verlangt es die API). URLs deshalb nie loggen.

export const GRAPH = 'https://graph.instagram.com/v27.0';
export const GRAPH_FB = 'https://graph.facebook.com/v26.0';
export type TokenKind = 'instagram' | 'facebook';
const TIMEOUT_MS = 20_000;
const MAX_COMMENT_PAGES = 10; // höchstens 500 Kommentare pro Beitrag

export type FetchFn = typeof fetch;

export class MetaApiError extends Error {
  readonly code?: number;
  readonly subcode?: number;
  constructor(message: string, code?: number, subcode?: number) {
    super(message);
    this.code = code;
    this.subcode = subcode;
  }
  /** Token abgelaufen, widerrufen oder ungültig (OAuthException 190) */
  get tokenInvalid() {
    return this.code === 190;
  }
}

export interface IgMe {
  userId: string;
  username: string;
  accountType: string | null;
  /** Falls der Token an einem anderen Server funktioniert als sein Präfix vermuten lässt */
  kind?: TokenKind;
}
export interface IgMedia {
  id: string;
  caption: string | null;
  timestamp: string | null;
  permalink: string | null;
  commentsCount: number;
}
export interface IgComment {
  id: string;
  text: string | null;
  timestamp: string | null;
  username: string | null;
  fromId: string | null;
  /** Antworten unter dem Kommentar (Diskussion) */
  replies: IgReply[];
}
export interface IgReply {
  id: string | null;
  text: string | null;
  timestamp: string | null;
  username: string | null;
  fromId: string | null;
}

/** Grobe Formprüfung, bevor der Token an Meta geht. */
export const looksLikeIgToken = (s: string) => /^IG[A-Za-z0-9_-]{40,}$/.test(s.trim());
export const looksLikeFbToken = (s: string) => /^EAA[A-Za-z0-9_-]{40,}$/.test(s.trim());
export const tokenKind = (s: string): TokenKind | null =>
  looksLikeIgToken(s) ? 'instagram' : looksLikeFbToken(s) ? 'facebook' : null;

/** Beschreibung einer Anfrage fürs Protokoll - ohne Token, ohne IDs, ohne Inhalte */
export interface CallInfo {
  endpoint: string;
  ok: boolean;
  error: string | null;
  /** Auslastung laut Meta in Prozent (höchster Wert aus den Usage-Headern), falls mitgeschickt */
  usagePct: number | null;
}

/** "/v26.0/17841400/media" → "media", "/v26.0/me/accounts" → "me/accounts" */
export function endpointLabel(url: URL): string {
  const parts = url.pathname.split('/').filter((p) => p && !/^v\d+\.\d+$/.test(p));
  const named = parts.filter((p) => !/^\d+(_\d+)?$/.test(p));
  return named.join('/') || (parts.length ? 'objekt' : '/');
}

/** Liest Metas Auslastungs-Header; liefert den höchsten Prozentwert (call_count, total_time, total_cputime). */
export function usageFromHeaders(h: Headers): number | null {
  const values: number[] = [];
  const collect = (o: any) => {
    for (const k of ['call_count', 'total_time', 'total_cputime', 'acc_id_util_pct']) if (typeof o?.[k] === 'number') values.push(o[k]);
  };
  for (const name of ['x-business-use-case-usage', 'x-app-usage', 'x-ad-account-usage']) {
    const raw = h.get(name);
    if (!raw) continue;
    try {
      const j = JSON.parse(raw);
      if (Array.isArray(j)) j.forEach(collect);
      else if (j && typeof j === 'object' && ('call_count' in j || 'total_time' in j)) collect(j);
      else for (const v of Object.values(j ?? {})) (Array.isArray(v) ? v : [v]).forEach(collect);
    } catch {
      /* unlesbar → ignorieren */
    }
  }
  return values.length ? Math.max(...values) : null;
}

export function createMetaClient(
  token: string,
  fetchFn: FetchFn = fetch,
  kind: TokenKind = tokenKind(token) ?? 'instagram',
  onCall?: (info: CallInfo) => void,
) {
  const base = kind === 'facebook' ? GRAPH_FB : GRAPH;
  async function call(path: string, params: Record<string, string> = {}): Promise<any> {
    const url = path.startsWith('https://') ? new URL(path) : new URL(`${base}/${path}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    if (!url.searchParams.has('access_token')) url.searchParams.set('access_token', token);
    const log = (ok: boolean, error: string | null, usagePct: number | null = null) => {
      try {
        onCall?.({ endpoint: endpointLabel(url), ok, error, usagePct });
      } catch {
        /* Protokoll darf nie die Anfrage stören */
      }
    };
    let res: Response;
    try {
      res = await fetchFn(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (err) {
      log(false, `nicht erreichbar (${(err as Error).name})`);
      throw new MetaApiError(`Instagram nicht erreichbar (${(err as Error).name})`);
    }
    const usage = usageFromHeaders(res.headers);
    const data: any = await res.json().catch(() => ({}));
    if (data?.error || !res.ok) {
      const e = data?.error ?? {};
      log(false, String(e.message ?? `HTTP ${res.status}`).slice(0, 200), usage);
      throw new MetaApiError(String(e.message ?? `HTTP ${res.status}`), e.code, e.error_subcode);
    }
    log(true, null, usage);
    return data;
  }

  return {
    kind,

    /**
     * Das Instagram-Konto zum Token. Bei Facebook-Tokens: das erste Instagram-Business-/Creator-Konto,
     * das mit einer der Facebook-Seiten des Nutzers verknüpft ist.
     */
    async me(): Promise<IgMe> {
      if (kind === 'instagram') {
        const d = await call('me', { fields: 'user_id,username,account_type' });
        return { userId: String(d.user_id ?? d.id), username: String(d.username ?? '').toLowerCase(), accountType: d.account_type ?? null };
      }
      // Mehrere Wege, je nachdem wie der Token erzeugt wurde. Jeder Schritt wird für die Diagnose
      // protokolliert (nur Meta-Fehlertexte und Berechtigungsnamen, nie der Token).
      const diag: string[] = [];
      const tryCall = async (label: string, path: string, params: Record<string, string> = {}) => {
        try {
          return await call(path, params);
        } catch (err) {
          if (err instanceof MetaApiError && err.tokenInvalid) throw err; // abgelaufen/ungültig: sofort melden
          diag.push(`${label}: ${(err as Error).message.slice(0, 120)}`);
          return null;
        }
      };
      const found = (ig: any): IgMe => ({ userId: String(ig.id), username: String(ig.username ?? '').toLowerCase(), accountType: 'BUSINESS' });
      const igOfPages = (pages: any) => (pages?.data ?? []).find((p: any) => p.instagram_business_account?.id)?.instagram_business_account;

      // 1. Nutzer-Token mit Facebook-Seite, an der das Instagram-Konto hängt (klassischer Weg, Jarvis)
      const pages = await tryCall('Seiten', 'me/accounts', { fields: 'name,instagram_business_account{id,username}', limit: '100' });
      if (igOfPages(pages)) return found(igOfPages(pages));
      if (pages) diag.push(`Seiten: ${pages.data?.length ?? 0} gefunden, keine mit Instagram-Konto`);

      // 2. Freigaben im Token (Unified Login): granular_scopes → target_ids
      const info = await tryCall('Token-Prüfung', 'debug_token', { input_token: token });
      const scopes: { scope: string; target_ids?: string[] }[] = info?.data?.granular_scopes ?? [];
      if (info?.data?.type) diag.push(`Token-Typ: ${info.data.type}`);
      for (const id of new Set(scopes.filter((s) => s.scope.startsWith('instagram')).flatMap((s) => s.target_ids ?? []))) {
        const ig = await tryCall('Konto aus Freigabe', id, { fields: 'id,username' });
        if (ig?.username) return found(ig);
      }

      // 3. Business-Portfolio: Instagram-Konten und Seiten des Portfolios (Systemnutzer, business_management)
      const biz = await tryCall('Portfolios', 'me/businesses', { fields: 'id,name', limit: '25' });
      for (const b of biz?.data ?? []) {
        const igs = await tryCall('Portfolio-Instagram', `${b.id}/instagram_accounts`, { fields: 'id,username', limit: '25' });
        if (igs?.data?.[0]?.id) return found(igs.data[0]);
        const owned = await tryCall('Portfolio-Seiten', `${b.id}/owned_pages`, { fields: 'name,instagram_business_account{id,username}', limit: '100' });
        if (igOfPages(owned)) return found(igOfPages(owned));
      }

      // 4. Login über Instagram (Unified Login): EAA-Token, der direkt am Instagram-Server gilt
      // Der Instagram-Server meldet "Cannot parse access token" (Code 190), wenn er den Token nicht kennt.
      // Das heißt hier nur "falscher Server", nicht "Token ungültig" → nicht abbrechen.
      const igMe = await call(`${GRAPH}/me`, { fields: 'user_id,username,account_type' }).catch((err: Error) => {
        diag.push(`Instagram-Server: ${err.message.slice(0, 80)}`);
        return null;
      });
      if (igMe?.username) {
        return { userId: String(igMe.user_id ?? igMe.id), username: String(igMe.username).toLowerCase(), accountType: igMe.account_type ?? null, kind: 'instagram' };
      }
      // … oder am Facebook-Server als Instagram-Nutzer selbst
      // Nur id abfragen: "username" auf /me lehnt der Facebook-Server bei Facebook-Nutzern ab (#12),
      // bei Tokens aus „Token generieren“ ist /me aber das Instagram-Konto selbst → per ID nachladen.
      const fbMe = await tryCall('Profil', 'me', { fields: 'id' });
      if (fbMe?.id) {
        const ig = await tryCall('Profil-Konto', String(fbMe.id), { fields: 'id,username' });
        if (ig?.username) return found(ig);
      }

      // 5. Welche Berechtigungen hat der Token überhaupt?
      const perms = await tryCall('Berechtigungen', 'me/permissions');
      const granted = (perms?.data ?? []).filter((p: any) => p.status === 'granted').map((p: any) => p.permission);
      const scopeNames = scopes.map((s) => s.scope);
      const list = [...new Set([...granted, ...scopeNames])];
      throw new MetaApiError(
        'Kein Instagram-Konto in diesem Token gefunden.\n' +
          'Tipp: Gib die ID deines Instagram-Kontos mit an: /verbinden 1784… - sie steht im Meta-Dashboard bei ' +
          '„Zugriffstokens generieren“ unter deinem Kontonamen.\n' +
          `Berechtigungen im Token: ${list.length ? list.join(', ') : 'keine erkennbar'}\n` +
          `Diagnose: ${diag.join(' | ') || '-'}`,
      );
    },

    /**
     * Instagram-Konto direkt per ID (steht im Meta-Dashboard unter "Zugriffstokens generieren").
     * Für Tokens, bei denen sich das Konto nicht automatisch finden lässt.
     */
    async account(igUserId: string): Promise<IgMe> {
      const fields = { fields: 'id,username' };
      try {
        const d = await call(igUserId, fields);
        return { userId: String(d.id ?? igUserId), username: String(d.username ?? '').toLowerCase(), accountType: 'BUSINESS' };
      } catch (err) {
        if (kind !== 'facebook') throw err;
        // Gegenprobe am Instagram-Server
        const d = await call(`${GRAPH}/${igUserId}`, fields).catch(() => {
          throw err;
        });
        return { userId: String(d.id ?? igUserId), username: String(d.username ?? '').toLowerCase(), accountType: 'BUSINESS', kind: 'instagram' };
      }
    },

    /**
     * Wann läuft der Token ab? null = läuft nicht ab (z. B. Systemnutzer-Token) oder unbekannt.
     * Facebook: debug_token akzeptiert den Token des App-Entwicklers selbst. Instagram: 60 Tage.
     */
    async expiresAt(): Promise<Date | null> {
      if (kind === 'instagram') return new Date(Date.now() + 60 * 86_400_000);
      try {
        const d = await call('debug_token', { input_token: token });
        const exp = Number(d.data?.expires_at ?? 0);
        return exp > 0 ? new Date(exp * 1000) : null;
      } catch {
        return new Date(Date.now() + 60 * 86_400_000); // vorsichtshalber wie ein langlebiger Nutzer-Token
      }
    },

    /** Neueste Beiträge. "caption" ist laut Doku evtl. nur mit Facebook-Login verfügbar → Rückfall ohne. */
    async media(userId: string, limit = 25): Promise<IgMedia[]> {
      const base = 'id,timestamp,permalink,comments_count';
      let d: any;
      try {
        d = await call(`${userId}/media`, { fields: `${base},caption`, limit: String(limit) });
      } catch (err) {
        if (err instanceof MetaApiError && !err.tokenInvalid && /caption/i.test(err.message)) {
          d = await call(`${userId}/media`, { fields: base, limit: String(limit) });
        } else throw err;
      }
      return (d.data ?? []).map((m: any) => ({
        id: String(m.id),
        caption: m.caption ?? null,
        timestamp: m.timestamp ?? null,
        permalink: m.permalink ?? null,
        commentsCount: Number(m.comments_count ?? 0),
      }));
    },

    /** Alle Kommentare eines Beitrags (oberste Ebene) mit den Antworten darauf. */
    async comments(mediaId: string): Promise<IgComment[]> {
      const out: IgComment[] = [];
      let next: string | null = null;
      for (let page = 0; page < MAX_COMMENT_PAGES; page++) {
        const d: any = next
          ? await call(next)
          : await call(`${mediaId}/comments`, {
              fields: 'id,text,timestamp,username,from{id,username},replies{id,text,timestamp,username,from{id,username}}',
              limit: '50',
            });
        for (const c of d.data ?? []) {
          out.push({
            id: String(c.id),
            text: c.text ?? null,
            timestamp: c.timestamp ?? null,
            username: (c.username ?? c.from?.username ?? null)?.toLowerCase() ?? null,
            fromId: c.from?.id ? String(c.from.id) : null,
            replies: (c.replies?.data ?? []).map((r: any) => ({
              id: r.id ? String(r.id) : null,
              text: r.text ?? null,
              timestamp: r.timestamp ?? null,
              username: (r.username ?? r.from?.username ?? null)?.toLowerCase() ?? null,
              fromId: r.from?.id ? String(r.from.id) : null,
            })),
          });
        }
        next = d.paging?.next ?? null;
        if (!next) break;
      }
      return out;
    },

    /**
     * Verlängert einen Instagram-Token um 60 Tage (frühestens 24 h nach Ausstellung).
     * Facebook-Tokens lassen sich ohne App-Geheimnis nicht verlängern → Nutzer erzeugt neu.
     */
    async refresh(): Promise<{ token: string; expiresIn: number }> {
      if (kind === 'facebook') throw new MetaApiError('Facebook-Tokens müssen neu erzeugt werden.');
      const d = await call('https://graph.instagram.com/refresh_access_token', { grant_type: 'ig_refresh_token' });
      return { token: String(d.access_token), expiresIn: Number(d.expires_in ?? 60 * 86400) };
    },
  };
}

export type MetaClient = ReturnType<typeof createMetaClient>;

/** true, wenn der Kommentar leer ist oder nur aus Emojis, Leerzeichen und Satzzeichen besteht */
export const isEmojiOnly = (s: unknown) =>
  /^[\p{Extended_Pictographic}\p{Emoji_Modifier}\u{1F1E6}-\u{1F1FF}‍️⃣\s\p{P}\p{S}]*$/u.test(String(s ?? ''));
