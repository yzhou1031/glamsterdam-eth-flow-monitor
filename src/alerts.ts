import { EventEmitter } from 'node:events';
import { getAlertView, insertAlert, type AlertView, type Db, type TransferRow } from './db.js';
import type { Match } from './screen.js';

/** Events: 'transfer' (TransferRow), 'alert' (AlertView), 'alert-updated' (AlertView). */
export const bus = new EventEmitter();
bus.setMaxListeners(100);

export interface AlertOptions {
  webhookUrl?: string;
  fetchFn?: typeof fetch;
  log?: (message: string) => void;
}

/** Inserts one alert per match. Call inside the block's DB transaction. */
export function recordAlerts(db: Db, transfer: TransferRow, matches: Match[]): AlertView[] {
  return matches.map((m) => {
    const row = insertAlert(db, {
      transferId: transfer.id,
      reason: m.reason,
      matchedAddress: m.matchedAddress,
      matchedEntry: m.matchedEntry,
      listVersion: m.listVersion,
    });
    return getAlertView(db, row.id)!;
  });
}

/** Sends committed alerts to the dashboard (SSE bus), the webhook and the email stub. */
export function notifyAlerts(alerts: AlertView[], opts: AlertOptions = {}): void {
  const log = opts.log ?? console.log;
  for (const a of alerts) {
    bus.emit('alert', a);
    log(`[email stub] Alert #${a.id} (${a.reason}): ${a.matched_entry}; ${a.value_eth} ETH ${a.from_addr} -> ${a.to_addr}; tx ${a.tx_hash}`);
    if (opts.webhookUrl) void postWebhook(opts.webhookUrl, a, opts.fetchFn ?? fetch, log);
  }
}

async function postWebhook(url: string, alert: AlertView, fetchFn: typeof fetch, log: (m: string) => void): Promise<void> {
  try {
    const res = await fetchFn(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(alert),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) log(`[webhook] HTTP ${res.status} for alert #${alert.id}`);
  } catch (e) {
    log(`[webhook] failed for alert #${alert.id}: ${(e as Error).message}`);
  }
}
