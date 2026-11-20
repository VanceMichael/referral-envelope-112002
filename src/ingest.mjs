// 来源采集：按分页把演练来源的记录拉入台账。
// 同一来源可反复采集（离线包重传、按阶段回放），落账幂等：
// - 记录级按 `${source}/${record}` 去重；
// - 回执级按 sourceReceipt 去重（同一回执可能随不同记录重传）；
// - 咨询编号未匹配的翻译记录暂不落账，下一轮采集自动重试。

import { applyRecord, summary } from './ledger.mjs';

export function applySourceRecord(ledger, source, entry) {
  if (!entry || typeof entry.record !== 'string') return { status: 'invalid', reason: '来源记录缺少键' };
  const key = `${source}/${entry.record}`;
  if (ledger.records.has(key)) return { status: 'duplicate' };
  const result = applyRecord(ledger, entry.kind, entry.payload ?? {}, key);
  if (result.retry) return { status: 'pending', reason: result.reason };
  ledger.records.add(key);
  if (result.duplicate) return { status: 'duplicate', reason: result.reason };
  if (result.invalid) return { status: 'invalid', reason: result.reason };
  return { status: 'applied' };
}

export async function collectFromSource(ledger, baseUrl, { sources = ['train', 'referrals', 'receiver'], limit = 100, fetchImpl = fetch } = {}) {
  const tally = {};
  for (const source of sources) {
    const count = { applied: 0, duplicate: 0, invalid: 0, pending: 0 };
    let offset = 0;
    do {
      const response = await fetchImpl(`${baseUrl}/source/${source}?offset=${offset}&limit=${limit}`);
      if (!response.ok) throw new Error(`来源 ${source} 采集失败：HTTP ${response.status}`);
      const page = await response.json();
      for (const entry of page.records) {
        count[applySourceRecord(ledger, source, entry).status] += 1;
      }
      offset = page.next;
    } while (offset !== null);
    tally[source] = count;
  }
  return { sources: tally, ledger: summary(ledger) };
}
