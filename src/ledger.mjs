// 办公室台账：采集来源记录（离线咨询单 / 站点门户转介 / 接收点回执），
// 维护授权、领取、拒收与停止使用的认定状态。
//
// 归集原则：
// - 一切归集只按咨询编号（consult）与翻译记录里明确的原件归属（original），
//   不按姓名或别名相似并案；别名仅用于展示。
// - 站点签过的预约（appointment）只证明接手窗口，不具有材料授权效力；
//   材料领取只依据授权（grant：接收点 + 用途 + 材料条目 + 起止时段）。
// - 收窄（restrict）不溯及既往：收窄前已合规领取的条目转为“停止使用事项”并跟踪确认；
//   尚未领取的越权条目立即不可领。

const TIME_PATTERN = /^([01]?\d|2[0-3]):([0-5]\d)$/;

export function toMinutes(time) {
  if (typeof time !== 'string') return null;
  const match = TIME_PATTERN.exec(time.trim());
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

export function createLedger() {
  return {
    records: new Set(), // 已处理的来源记录键 `${source}/${record}`，用于重传去重
    consults: new Map(), // consult -> { consult, alias, items: Map, translations: Map }
    appointments: new Map(), // appointment -> { id, consult, point, purpose, window, history: [] }
    grants: new Map(), // grant -> { id, consult, point, purpose, items, valid, validMin, restrictions: [] }
    receipts: new Map(), // sourceReceipt -> { kind, grant, item, point, time, timeMin, valid, reason, records: [] }
    notices: new Map(), // `${grant}|${item}|${point}` -> 停止使用事项
    unmatchedTranslations: [], // 咨询编号未匹配的翻译记录（绝不按别名猜测归并）
    invalidRecords: [], // 无法落账的非回执类记录
    conflicts: [], // 同一 sourceReceipt 携带不同内容的冲突
  };
}

const noticeKey = (grant, item, point) => `${grant}|${item}|${point}`;

function failRecord(ledger, recordKey, kind, reason, payload) {
  ledger.invalidRecords.push({ record: recordKey, kind, reason });
  return { applied: false, invalid: true, reason };
}

// ---------- 各类来源记录落账 ----------

export function applyRecord(ledger, kind, payload, recordKey = null) {
  switch (kind) {
    case 'case': return applyCase(ledger, payload, recordKey);
    case 'translation': return applyTranslation(ledger, payload, recordKey);
    case 'appointment': return applyAppointment(ledger, payload, recordKey);
    case 'grant': return applyGrant(ledger, payload, recordKey);
    case 'restrict': return applyRestrict(ledger, payload, recordKey);
    case 'received': return applyReceipt(ledger, 'received', payload, recordKey);
    case 'denied': return applyReceipt(ledger, 'denied', payload, recordKey);
    case 'stopped': return applyReceipt(ledger, 'stopped', payload, recordKey);
    default: return failRecord(ledger, recordKey, kind, '未知记录类型', payload);
  }
}

function applyCase(ledger, p, recordKey) {
  if (!p || typeof p.consult !== 'string' || !Array.isArray(p.items)) {
    return failRecord(ledger, recordKey, 'case', '咨询单格式无效', p);
  }
  let consult = ledger.consults.get(p.consult);
  if (!consult) {
    consult = { consult: p.consult, alias: p.alias ?? null, items: new Map(), translations: new Map() };
    ledger.consults.set(p.consult, consult);
  }
  // 咨询单分为可通知事项与材料条目；同一编号重复到达时按条目合并，不覆盖
  for (const item of p.items) {
    if (!item || typeof item.id !== 'string') continue;
    if (!consult.items.has(item.id)) {
      consult.items.set(item.id, { id: item.id, scope: item.scope === '通知' ? '通知' : '材料' });
    }
  }
  return { applied: true };
}

function applyTranslation(ledger, p, recordKey) {
  // 只按咨询编号归集；编号不存在时进入待匹配队列，绝不做姓名相似并案
  const consult = typeof p?.consult === 'string' ? ledger.consults.get(p.consult) : null;
  if (!consult) {
    const pending = { record: recordKey, consult: p?.consult ?? null, id: p?.id ?? null, payload: p };
    if (!ledger.unmatchedTranslations.some((t) => t.consult === pending.consult && t.id === pending.id)) {
      ledger.unmatchedTranslations.push(pending);
    }
    return { applied: false, retry: true, reason: '未知咨询编号' };
  }
  const timeMin = toMinutes(p.time);
  if (typeof p.id !== 'string' || timeMin === null) {
    return failRecord(ledger, recordKey, 'translation', '翻译记录格式无效', p);
  }
  if (!consult.translations.has(p.id)) {
    consult.translations.set(p.id, {
      id: p.id,
      original: typeof p.original === 'string' ? p.original : null, // 明确的翻译归属：译件 -> 原件
      language: p.language ?? null,
      time: p.time,
      timeMin,
    });
  }
  ledger.unmatchedTranslations = ledger.unmatchedTranslations.filter(
    (t) => !(t.consult === p.consult && t.id === p.id),
  );
  return { applied: true };
}

function applyAppointment(ledger, p, recordKey) {
  if (!p || typeof p.appointment !== 'string' || typeof p.consult !== 'string' || typeof p.point !== 'string') {
    return failRecord(ledger, recordKey, 'appointment', '预约记录格式无效', p);
  }
  const existing = ledger.appointments.get(p.appointment);
  if (existing) {
    // 改派：只更新预约的接手点与窗口；授权（grant）不随预约迁移
    existing.history.push({ point: existing.point, purpose: existing.purpose, window: existing.window });
    existing.point = p.point;
    existing.purpose = p.purpose ?? existing.purpose;
    existing.window = p.window ?? existing.window;
    return { applied: true, reassigned: true };
  }
  ledger.appointments.set(p.appointment, {
    id: p.appointment,
    consult: p.consult,
    point: p.point,
    purpose: p.purpose ?? null,
    window: p.window ?? null,
    history: [],
  });
  return { applied: true };
}

function applyGrant(ledger, p, recordKey) {
  if (
    !p || typeof p.grant !== 'string' || typeof p.consult !== 'string' ||
    typeof p.point !== 'string' || typeof p.purpose !== 'string' ||
    !Array.isArray(p.items) || !p.items.every((i) => typeof i === 'string')
  ) {
    return failRecord(ledger, recordKey, 'grant', '授权记录格式无效', p);
  }
  const from = toMinutes(p.valid?.[0]);
  const to = toMinutes(p.valid?.[1]);
  if (from === null || to === null || from > to) {
    return failRecord(ledger, recordKey, 'grant', '授权时段无效', p);
  }
  if (ledger.grants.has(p.grant)) {
    return { applied: false, duplicate: true, reason: '授权已存在' };
  }
  ledger.grants.set(p.grant, {
    id: p.grant,
    consult: p.consult,
    point: p.point,
    purpose: p.purpose,
    items: [...p.items],
    valid: [p.valid[0], p.valid[1]],
    validMin: [from, to],
    restrictions: [],
  });
  return { applied: true };
}

function applyRestrict(ledger, p, recordKey) {
  const grant = typeof p?.grant === 'string' ? ledger.grants.get(p.grant) : null;
  if (!grant) return failRecord(ledger, recordKey, 'restrict', '未知授权', p);
  const atMin = toMinutes(p.time);
  if (atMin === null || !Array.isArray(p.items) || !p.items.every((i) => typeof i === 'string')) {
    return failRecord(ledger, recordKey, 'restrict', '收窄记录格式无效', p);
  }
  // items 为收窄后保留的条目清单；被移出的条目自 time 起退出授权范围
  grant.restrictions.push({ retained: [...p.items], at: p.time, atMin });
  reconcile(ledger);
  return { applied: true };
}

function applyReceipt(ledger, kind, p, recordKey) {
  const id = p?.sourceReceipt;
  if (typeof id !== 'string' || id.length === 0) {
    return failRecord(ledger, recordKey, kind, '回执缺少来源键', p);
  }
  const existing = ledger.receipts.get(id);
  if (existing) {
    // 离线包重传：同一回执键只认第一次落账的内容
    if (
      existing.kind !== kind || existing.grant !== p.grant || existing.item !== p.item ||
      existing.point !== p.point || existing.time !== p.time
    ) {
      ledger.conflicts.push({ receipt: id, record: recordKey, reason: '回执冲突', kept: existing.kind, dropped: kind });
    }
    if (recordKey) existing.records.push(recordKey);
    return { applied: false, duplicate: true, reason: '重复回执' };
  }
  const receipt = {
    kind,
    grant: typeof p.grant === 'string' ? p.grant : null,
    item: typeof p.item === 'string' ? p.item : null,
    point: typeof p.point === 'string' ? p.point : null,
    time: typeof p.time === 'string' ? p.time : null,
    timeMin: toMinutes(p.time),
    valid: false,
    reason: null,
    records: recordKey ? [recordKey] : [],
  };
  const invalid = (reason) => {
    receipt.reason = reason;
    ledger.receipts.set(id, receipt);
    return { applied: false, invalid: true, reason };
  };
  if (receipt.timeMin === null) return invalid('时间无效');
  const grant = receipt.grant ? ledger.grants.get(receipt.grant) : null;
  if (!grant) return invalid('未知授权');
  if (receipt.point !== grant.point) return invalid('接收点与授权不符');
  if (kind === 'received') {
    const consult = ledger.consults.get(grant.consult);
    const resolved = consult ? resolveItem(consult, receipt.item) : null;
    if (!resolved) return invalid('条目不存在');
    if (!allowedItems(grant, receipt.timeMin).includes(receipt.item)) return invalid('条目不在授权范围');
    if (resolved.scope !== '材料') return invalid('通知事项不可领取');
    if (resolved.translation && resolved.translation.timeMin > receipt.timeMin) return invalid('翻译未到');
    if (receipt.timeMin < grant.validMin[0] || receipt.timeMin > grant.validMin[1]) return invalid('超出授权时段');
  } else if (kind === 'denied') {
    if (!grant.items.includes(receipt.item)) return invalid('条目不在授权范围');
  }
  // stopped 回执先落账，是否与待确认的停用事项匹配由 reconcile 统一判定
  receipt.valid = kind !== 'stopped';
  if (kind === 'stopped') receipt.reason = '无待确认的停用事项';
  ledger.receipts.set(id, receipt);
  reconcile(ledger);
  return receipt.valid ? { applied: true } : { applied: true, reason: receipt.reason };
}

// ---------- 派生规则 ----------

// 授权在某时刻的保留条目：取不晚于该时刻的最近一次收窄清单
export function allowedItems(grant, atMin) {
  let best = null;
  for (const r of grant.restrictions) {
    if (r.atMin <= atMin && (best === null || r.atMin >= best.atMin)) best = r;
  }
  return best ? best.retained : grant.items;
}

// 条目解析：原件来自咨询单；译件来自翻译记录，scope 继承其归属原件
export function resolveItem(consult, itemId) {
  if (!consult || typeof itemId !== 'string') return null;
  const own = consult.items.get(itemId);
  if (own) return { id: itemId, scope: own.scope, translation: null };
  const translation = consult.translations.get(itemId);
  if (translation) {
    const original = translation.original ? consult.items.get(translation.original) : null;
    return { id: itemId, scope: original?.scope ?? '材料', translation };
  }
  return null;
}

function forEachReceipt(ledger, grantId, item, point, fn) {
  for (const r of ledger.receipts.values()) {
    if (r.valid && r.grant === grantId && r.item === item && r.point === point) fn(r);
  }
}

// 已交认定：存在有效的领取确认且同一条目未被拒收。
// 离线包重传、回执晚到或条目被拒收，都不会把尚未转交的材料标为已交。
export function transferred(ledger, grantId, item, point) {
  let received = false;
  let refused = false;
  forEachReceipt(ledger, grantId, item, point, (r) => {
    if (r.kind === 'received') received = true;
    if (r.kind === 'denied') refused = true;
  });
  return received && !refused;
}

export function denied(ledger, grantId, item, point) {
  let refused = false;
  forEachReceipt(ledger, grantId, item, point, (r) => {
    if (r.kind === 'denied') refused = true;
  });
  return refused;
}

//  reconciliation：每次落账后重算，保证与记录到达顺序无关。
//  1) 已领取但被收窄出授权范围的条目 -> 补发停止使用事项并跟踪确认；
//  2) 停止使用回执与待确认事项互相匹配（回执先到或晚到都能闭环）。
export function reconcile(ledger) {
  for (const grant of ledger.grants.values()) {
    const removed = grant.items.filter((item) => !allowedItems(grant, Number.POSITIVE_INFINITY).includes(item));
    for (const item of removed) {
      if (!transferred(ledger, grant.id, item, grant.point)) continue;
      const key = noticeKey(grant.id, item, grant.point);
      if (ledger.notices.has(key)) continue;
      let since = null;
      for (const r of grant.restrictions) {
        if (!r.retained.includes(item) && (since === null || r.atMin < since.atMin)) since = r;
      }
      ledger.notices.set(key, {
        grant: grant.id,
        consult: grant.consult,
        item,
        point: grant.point,
        since: since?.at ?? null,
        sinceMin: since?.atMin ?? null,
        status: 'pending',
        stoppedAt: null,
        receipt: null,
      });
    }
  }
  for (const [id, receipt] of ledger.receipts) {
    if (receipt.kind !== 'stopped') continue;
    const notice = ledger.notices.get(noticeKey(receipt.grant, receipt.item, receipt.point));
    if (notice && notice.status === 'pending') {
      notice.status = 'stopped';
      notice.stoppedAt = receipt.time;
      notice.receipt = id;
      receipt.valid = true;
      receipt.reason = null;
    } else if (!notice) {
      receipt.valid = false;
      receipt.reason = '无待确认的停用事项';
    }
  }
}

// ---------- 查询 ----------

// 接收点当前可领取的材料条目。只依据授权，不依据预约。
export function collectibleItems(ledger, point, consultNo, atMin) {
  const visible = visibleItems(ledger, point, consultNo, atMin);
  if (visible === null) return null;
  return visible
    .filter((entry) => entry.collectible)
    .map((entry) => ({ consult: consultNo, item: entry.item, grants: entry.grants, purposes: entry.purposes }));
}

// 接收点可见的条目：仅覆盖其有效授权范围内的条目，范围外的条目内容不可得知。
export function visibleItems(ledger, point, consultNo, atMin) {
  const consult = ledger.consults.get(consultNo);
  if (!consult) return null;
  const byItem = new Map();
  for (const grant of ledger.grants.values()) {
    if (grant.point !== point || grant.consult !== consultNo) continue;
    if (atMin < grant.validMin[0] || atMin > grant.validMin[1]) continue;
    for (const itemId of allowedItems(grant, atMin)) {
      let entry = byItem.get(itemId);
      if (!entry) {
        entry = {
          item: itemId,
          consult: consultNo,
          scope: null,
          available: false,
          reason: null,
          purposes: [],
          grants: [],
          translation: null,
          transferred: false,
          denied: false,
          collectible: false,
          stopUse: null,
        };
        byItem.set(itemId, entry);
      }
      entry.purposes.push(grant.purpose);
      entry.grants.push(grant.id);
      const resolved = resolveItem(consult, itemId);
      if (resolved) {
        entry.scope = resolved.scope;
        if (resolved.translation) {
          entry.translation = {
            original: resolved.translation.original,
            language: resolved.translation.language,
            time: resolved.translation.time,
          };
          entry.available = resolved.translation.timeMin <= atMin;
        } else {
          entry.available = true;
        }
        if (!entry.available) entry.reason = '翻译未到';
      } else {
        entry.reason = '翻译未到'; // 授权已覆盖但翻译记录尚未补到
      }
    }
  }
  for (const entry of byItem.values()) {
    entry.transferred = entry.grants.some((g) => transferred(ledger, g, entry.item, point));
    entry.denied = entry.grants.some((g) => denied(ledger, g, entry.item, point));
    entry.collectible = entry.scope === '材料' && entry.available && !entry.transferred && !entry.denied;
    const states = entry.grants
      .map((g) => ledger.notices.get(noticeKey(g, entry.item, point))?.status)
      .filter(Boolean);
    entry.stopUse = states.includes('pending') ? 'pending' : states.includes('stopped') ? 'stopped' : null;
  }
  return [...byItem.values()];
}

// 办公室视角：停用回执迟迟不到的事项（哪一次授予、哪条资料、哪个接收点）
export function pendingStopUse(ledger) {
  return [...ledger.notices.values()]
    .filter((n) => n.status === 'pending')
    .map((n) => ({ grant: n.grant, consult: n.consult, item: n.item, point: n.point, since: n.since }));
}

export function invalidReceipts(ledger) {
  const invalid = [];
  for (const [id, r] of ledger.receipts) {
    if (!r.valid) invalid.push({ receipt: id, kind: r.kind, grant: r.grant, item: r.item, point: r.point, time: r.time, reason: r.reason });
  }
  return invalid;
}

export function consultView(ledger, consultNo) {
  const consult = ledger.consults.get(consultNo);
  if (!consult) return null;
  const grants = [...ledger.grants.values()].filter((g) => g.consult === consultNo);
  const grantIds = new Set(grants.map((g) => g.id));
  const items = [
    ...[...consult.items.values()].map((i) => ({ id: i.id, scope: i.scope, origin: '咨询单' })),
    ...[...consult.translations.values()].map((t) => ({
      id: t.id,
      scope: resolveItem(consult, t.id)?.scope ?? '材料',
      origin: '翻译',
      original: t.original,
      language: t.language,
      time: t.time,
    })),
  ];
  const receipts = [];
  for (const [id, r] of ledger.receipts) {
    if (r.grant && grantIds.has(r.grant)) {
      receipts.push({ receipt: id, kind: r.kind, grant: r.grant, item: r.item, point: r.point, time: r.time, valid: r.valid, reason: r.reason });
    }
  }
  const transfers = [];
  for (const g of grants) {
    for (const itemId of g.items) {
      if (transferred(ledger, g.id, itemId, g.point)) transfers.push({ grant: g.id, item: itemId, point: g.point });
    }
  }
  return {
    consult: consult.consult,
    alias: consult.alias,
    items,
    grants: grants.map((g) => ({
      id: g.id,
      point: g.point,
      purpose: g.purpose,
      items: g.items,
      valid: g.valid,
      retained: allowedItems(g, Number.POSITIVE_INFINITY),
      restrictions: g.restrictions.map((r) => ({ retained: r.retained, at: r.at })),
    })),
    appointments: [...ledger.appointments.values()]
      .filter((a) => a.consult === consultNo)
      .map((a) => ({ id: a.id, point: a.point, purpose: a.purpose, window: a.window, history: a.history })),
    receipts,
    transfers,
    notices: [...ledger.notices.values()].filter((n) => n.consult === consultNo),
  };
}

export function summary(ledger) {
  const receipts = [...ledger.receipts.values()];
  const notices = [...ledger.notices.values()];
  return {
    consults: ledger.consults.size,
    appointments: ledger.appointments.size,
    grants: ledger.grants.size,
    receipts: {
      total: receipts.length,
      valid: receipts.filter((r) => r.valid).length,
      invalid: receipts.filter((r) => !r.valid).length,
    },
    notices: {
      pending: notices.filter((n) => n.status === 'pending').length,
      stopped: notices.filter((n) => n.status === 'stopped').length,
    },
    unmatchedTranslations: ledger.unmatchedTranslations.length,
    invalidRecords: ledger.invalidRecords.length,
    conflicts: ledger.conflicts.length,
  };
}
