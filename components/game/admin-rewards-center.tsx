"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type RewardType = "resource" | "military_boost" | "protection" | "prestige" | "title" | "medal" | "treasury" | "xp_boost" | "starter_pack" | "reputation" | "influence";
type AdminState = { id: string; name: string; stateUsername: string | null; telegramChatId: number; telegramChatUsername: string | null; botPresent: boolean; memberCount: number; rating: number };
type AdminMember = { id: string; displayName: string; username: string | null; role: string };
type HistoryRow = { id: string; adminUsername: string | null; adminTelegramId: number; stateId: string; stateName: string; playerName: string | null; actionType: "reward" | "message"; rewardType: string | null; amount: number; parameters: Record<string, unknown>; reason: string | null; messageText: string | null; createdAt: string };

type PendingConfirm =
  | { kind: "reward"; title: string; detail: string }
  | { kind: "message"; title: string; detail: string }
  | { kind: "access"; title: string; detail: string };

const REWARDS: Array<{ key: RewardType; icon: string; label: string; hint: string }> = [
  { key: "resource", icon: "💰", label: "Ресурсы", hint: "Кредиты, сталь, топливо, еда или технологии" },
  { key: "military_boost", icon: "⚔️", label: "Военный буст", hint: "Временное усиление реальной силы армии" },
  { key: "protection", icon: "🛡", label: "Защита", hint: "Временный щит от ЧП" },
  { key: "prestige", icon: "🏆", label: "Престиж", hint: "Очки достижений государства" },
  { key: "title", icon: "🎖", label: "Титул", hint: "Именной титул конкретному игроку" },
  { key: "medal", icon: "🏅", label: "Медаль", hint: "Игроку или государству" },
  { key: "treasury", icon: "🎁", label: "Казна", hint: "Фиксированное пополнение кредитов" },
  { key: "xp_boost", icon: "⭐", label: "Буст опыта", hint: "Ускорение XP всем гражданам государства" },
  { key: "starter_pack", icon: "🚀", label: "Стартовый набор", hint: "Ресурсы + 12 часов защиты от ЧП" },
  { key: "reputation", icon: "◆", label: "Репутация", hint: "Повышение репутации государства" },
  { key: "influence", icon: "◈", label: "Влияние", hint: "Дополнительное влияние" },
];

async function adminCall<T>(initData: string, path: string, payload: Record<string, unknown>): Promise<T> {
  const response = await fetch(path, { method: "POST", headers: { "content-type": "application/json", "x-telegram-init-data": initData }, body: JSON.stringify(payload), cache: "no-store" });
  const json = await response.json().catch(() => null);
  if (!response.ok) throw new Error(json?.error || `Ошибка сервера (${response.status})`);
  return json as T;
}

function fmtTime(iso: string) {
  return new Date(iso).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function rewardName(key: string | null) {
  return REWARDS.find((item) => item.key === key)?.label || key || "Награда";
}

function historyValue(row: HistoryRow) {
  if (row.actionType === "message") return row.messageText || "Сообщение";
  const p = row.parameters || {};
  if (row.rewardType === "resource") return `${String(p.resource || "resource")} +${row.amount.toLocaleString("ru-RU")}`;
  if (row.rewardType === "treasury") return `+${row.amount.toLocaleString("ru-RU")} кредитов`;
  if (["prestige","reputation","influence"].includes(String(row.rewardType))) return `+${row.amount.toLocaleString("ru-RU")}`;
  if (["military_boost","xp_boost"].includes(String(row.rewardType))) return `+${Number(p.boostPct || 0)}% · ${Number(p.durationHours || 0)} ч`;
  if (row.rewardType === "protection") return `${Number(p.durationHours || 0)} ч`;
  if (row.rewardType === "title") return String(p.title || "Титул");
  if (row.rewardType === "medal") return `${String(p.icon || "🏅")} ${String(p.title || "Медаль")}`;
  if (row.rewardType === "starter_pack") return "Стартовый набор";
  return rewardName(row.rewardType);
}

type ResolvedGroupLink = { url: string | null; isPublic: boolean; pendingRequest: { id: string; requestedAt: string } | null };

function launchTelegramLink(url: string) {
  const app = (window as any).Telegram?.WebApp;
  // Must be invoked synchronously from a user interaction (Telegram requirement) — never after an await,
  // or the redirect silently fails on some platforms/clients (especially when not yet a member of the chat).
  if (app?.openTelegramLink) app.openTelegramLink(url);
  else window.location.assign(url);
}

export function AdminRewardsCenter({ initData }: { initData: string }) {
  const [states, setStates] = useState<AdminState[]>([]);
  const [stateQuery, setStateQuery] = useState("");
  const [selected, setSelected] = useState<AdminState | null>(null);
  const [members, setMembers] = useState<AdminMember[]>([]);
  const [playerId, setPlayerId] = useState("");
  const [rewardType, setRewardType] = useState<RewardType>("resource");
  const [resource, setResource] = useState("credits");
  const [amount, setAmount] = useState("1000");
  const [boostPct, setBoostPct] = useState("25");
  const [durationHours, setDurationHours] = useState("24");
  const [title, setTitle] = useState("");
  const [medalScope, setMedalScope] = useState<"state" | "player">("state");
  const [medalIcon, setMedalIcon] = useState("🏅");
  const [medalDescription, setMedalDescription] = useState("");
  const [reason, setReason] = useState("");
  const [freeText, setFreeText] = useState("");
  const [history, setHistory] = useState<HistoryRow[]>([]);
  const [tab, setTab] = useState<"reward" | "message" | "history">("reward");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<PendingConfirm | null>(null);
  const stateListRef = useRef<HTMLDivElement | null>(null);
  const historyRef = useRef<HTMLDivElement | null>(null);
  // Cache of resolved group links, keyed by stateId. Filled in the background (not on click) so that
  // "Открыть" can call openTelegramLink synchronously and reliably instead of after an async round-trip.
  const groupLinkCache = useRef<Map<string, ResolvedGroupLink>>(new Map());

  const loadStates = useCallback(async (query = "") => {
    const result = await adminCall<{ states: AdminState[] }>(initData, "/api/admin/rewards", { action: "states", query });
    setStates(result.states || []);
  }, [initData]);

  const loadHistory = useCallback(async (stateId?: string | null) => {
    const result = await adminCall<{ history: HistoryRow[] }>(initData, "/api/admin/rewards", { action: "history", stateId: stateId || undefined });
    setHistory(result.history || []);
  }, [initData]);

  useEffect(() => { void loadStates().catch((e) => setError(e instanceof Error ? e.message : "Не удалось загрузить государства")); void loadHistory().catch(() => undefined); }, [loadHistory, loadStates]);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadStates(stateQuery).catch(() => undefined), 250);
    return () => window.clearTimeout(timer);
  }, [stateQuery, loadStates]);

  useEffect(() => {
    setMembers([]); setPlayerId("");
    if (!selected) return;
    void adminCall<{ members: AdminMember[] }>(initData, "/api/admin/rewards", { action: "members", stateId: selected.id }).then((r) => setMembers(r.members || [])).catch(() => undefined);
    void loadHistory(selected.id).catch(() => undefined);
  }, [selected?.id, initData, loadHistory]);

  const selectedPlayer = useMemo(() => members.find((item) => item.id === playerId) || null, [members, playerId]);
  const needsPlayer = rewardType === "title" || (rewardType === "medal" && medalScope === "player");
  const currentReward = REWARDS.find((item) => item.key === rewardType)!;

  const chooseState = (state: AdminState) => {
    setSelected(state); setStatus(null); setError(null);
    window.setTimeout(() => stateListRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 20);
  };

  const resolveAndCache = useCallback(async (state: AdminState) => {
    const result = await adminCall<{ isPublic: boolean; url: string | null; pendingRequest?: { id: string; requestedAt: string } | null }>(initData, "/api/admin/groups", { action: "resolve", stateId: state.id });
    const cached: ResolvedGroupLink = { url: result.url, isPublic: result.isPublic, pendingRequest: result.pendingRequest || null };
    groupLinkCache.current.set(state.id, cached);
    return cached;
  }, [initData]);

  // Prefetch links in the background for groups we don't already know a public username for (private
  // groups need a server round-trip to check for a fulfilled invite link). Public groups don't need this —
  // their username already arrives with the state list, so opening them never has to wait on the network.
  useEffect(() => {
    let cancelled = false;
    const targets = states.filter((s) => !s.telegramChatUsername && s.botPresent && !groupLinkCache.current.has(s.id));
    (async () => {
      for (const state of targets) {
        if (cancelled) return;
        try { await resolveAndCache(state); } catch { /* best-effort prefetch, ignore failures here */ }
      }
    })();
    return () => { cancelled = true; };
  }, [states, resolveAndCache]);

  const openGroup = useCallback((state: AdminState) => {
    setError(null); setStatus(null); setSelected(state);
    const cached = groupLinkCache.current.get(state.id);
    const knownUrl = state.telegramChatUsername ? `https://t.me/${state.telegramChatUsername}` : cached?.url ?? null;

    if (knownUrl) {
      // Fire the redirect immediately, synchronously, inside the click handler — this is what actually
      // fixes the flaky/first-click-doesn't-work behaviour.
      launchTelegramLink(knownUrl);
      setStatus(`Вы сейчас смотрите группу: ${state.name}`);
      void resolveAndCache(state).catch(() => undefined); // refresh cache/username quietly for next time
      return;
    }
    if (cached?.pendingRequest) {
      setStatus(`Для «${state.name}» уже запрошено приглашение.`);
      void resolveAndCache(state).catch(() => undefined); // in case the invite was just fulfilled
      return;
    }

    // Nothing cached yet (rare — background prefetch hasn't finished). We can't guarantee the redirect
    // fires after this async call due to Telegram's user-interaction requirement, so just resolve and
    // cache it; the group will open reliably on the next click.
    setBusy(true);
    resolveAndCache(state)
      .then((result) => {
        if (result.url) { launchTelegramLink(result.url); setStatus(`Вы сейчас смотрите группу: ${state.name}`); }
        else setStatus(result.pendingRequest ? `Для «${state.name}» уже запрошено приглашение.` : `«${state.name}» — приватная группа. Запросите доступ у владельца.`);
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Не удалось открыть группу"))
      .finally(() => setBusy(false));
  }, [resolveAndCache]);

  const askAccess = (state: AdminState) => {
    setSelected(state);
    setConfirm({ kind: "access", title: "Запросить доступ к приватной группе?", detail: `Бот отправит в «${state.name}» официальный запрос. Владелец или администратор должен ответить на него пригласительной ссылкой.` });
  };

  const prepareReward = () => {
    if (!selected) { setError("Сначала выберите государство."); return; }
    if (needsPlayer && !playerId) { setError("Выберите игрока для этой награды."); return; }
    if ((rewardType === "title" || rewardType === "medal") && !title.trim()) { setError(rewardType === "title" ? "Введите название титула." : "Введите название медали."); return; }
    const target = selectedPlayer ? ` · ${selectedPlayer.displayName}` : "";
    setConfirm({ kind: "reward", title: `Выдать «${currentReward.label}»?`, detail: `${selected.name}${target}. После подтверждения эффект применится сразу и системное сообщение уйдёт в чат государства.` });
  };

  const prepareMessage = () => {
    if (!selected) { setError("Сначала выберите государство."); return; }
    if (!freeText.trim()) { setError("Введите текст сообщения."); return; }
    setConfirm({ kind: "message", title: "Отправить сообщение от Администрации?", detail: `Получатель: ${selected.name}. Текст будет сохранён в истории админ-панели.` });
  };

  const executeConfirmed = useCallback(async () => {
    if (!confirm || !selected) return;
    setBusy(true); setError(null); setStatus(null);
    try {
      if (confirm.kind === "access") {
        const result = await adminCall<{ ok: true; request: { id: string; requestedAt: string } }>(initData, "/api/admin/groups", { action: "request_access", stateId: selected.id });
        groupLinkCache.current.set(selected.id, { url: null, isPublic: false, pendingRequest: result.request });
        setStatus(`Запрос отправлен в «${selected.name}». Приглашение придёт админу в ЛС после reply владельца.`);
      } else if (confirm.kind === "message") {
        await adminCall(initData, "/api/admin/rewards", { action: "message", stateId: selected.id, text: freeText });
        setFreeText(""); setStatus("Сообщение отправлено и записано в историю.");
        await loadHistory(selected.id);
      } else {
        const parameters: Record<string, unknown> = {};
        if (rewardType === "resource") parameters.resource = resource;
        if (["military_boost", "xp_boost"].includes(rewardType)) { parameters.boostPct = Number(boostPct); parameters.durationHours = Number(durationHours); }
        if (rewardType === "protection") parameters.durationHours = Number(durationHours);
        if (rewardType === "title") parameters.title = title.trim();
        if (rewardType === "medal") { parameters.targetScope = medalScope; parameters.icon = medalIcon.trim() || "🏅"; parameters.title = title.trim(); parameters.description = medalDescription.trim(); }
        const result = await adminCall<{ label: string; notificationSent: boolean }>(initData, "/api/admin/rewards", {
          action: "grant", stateId: selected.id, playerId: needsPlayer ? playerId : undefined, rewardType,
          amount: Number(amount || 0), parameters, reason: reason.trim() || undefined,
        });
        setStatus(`Награда выдана: ${result.label}${result.notificationSent ? "" : ". Эффект применён, но Telegram-сообщение не доставлено."}`);
        if (rewardType === "title" || rewardType === "medal") { setTitle(""); setMedalDescription(""); }
        await loadHistory(selected.id);
      }
    } catch (e) { setError(e instanceof Error ? e.message : "Не удалось выполнить действие"); }
    finally { setBusy(false); setConfirm(null); }
  }, [confirm, selected, initData, freeText, rewardType, resource, boostPct, durationHours, title, medalScope, medalIcon, medalDescription, needsPlayer, playerId, amount, reason, loadHistory]);

  return <section className="admin-reward-center" ref={stateListRef}>
    <div className="admin-reward-heading"><div><small>УПРАВЛЕНИЕ ПРОЕКТОМ</small><h2>🎁 Награды и доступ к группам</h2><p>Выберите государство. Все выдачи, сообщения и запросы доступа фиксируются.</p></div><b>{states.length}</b></div>

    <div className="admin-state-picker">
      <label><span>🔍</span><input value={stateQuery} onChange={(e) => setStateQuery(e.target.value)} placeholder="Государство или @юз" /></label>
      <div className="admin-state-list">
        {states.map((state) => <article key={state.id} className={selected?.id === state.id ? "selected" : ""}>
          <button className="admin-state-main" type="button" onClick={() => chooseState(state)}><b>{state.name}</b><small>{state.stateUsername ? `@${state.stateUsername} · ` : ""}{state.memberCount} участников · {state.rating} ELO</small></button>
          <button type="button" className="admin-open-group" disabled={busy || !state.botPresent} onClick={() => openGroup(state)}>Открыть</button>
        </article>)}
        {!states.length && <p>Группы не найдены.</p>}
      </div>
    </div>

    {selected && <div className="admin-current-state">
      <small>ВЫ СЕЙЧАС СМОТРИТЕ ГРУППУ</small><h3>{selected.name}</h3><p>{selected.stateUsername ? `@${selected.stateUsername} · ` : ""}{selected.telegramChatId}</p>
      <div><button type="button" onClick={() => setTab("history")}>История</button><button type="button" onClick={() => setStatus("Наказания выполняются штатными правами Telegram. Откройте группу и примените модерацию от имени администратора чата.")}>Наказания</button><button type="button" onClick={() => setTab("reward")}>Награды</button><button type="button" onClick={() => setTab("message")}>Сообщение</button><button type="button" className="soft" onClick={() => askAccess(selected)}>🔒 Запросить доступ</button></div>
      <span>Быстрые действия работают в контексте выбранного государства. Награды не меняют Telegram-права участников.</span>
    </div>}

    <div className="admin-reward-tabs"><button className={tab === "reward" ? "active" : ""} onClick={() => setTab("reward")}>Выдать награду</button><button className={tab === "message" ? "active" : ""} onClick={() => setTab("message")}>Свободное сообщение</button><button className={tab === "history" ? "active" : ""} onClick={() => setTab("history")}>История</button></div>

    {tab === "reward" && <div className="admin-reward-form">
      <div className="admin-reward-types">{REWARDS.map((reward) => <button type="button" key={reward.key} className={rewardType === reward.key ? "active" : ""} onClick={() => setRewardType(reward.key)}><i>{reward.icon}</i><span><b>{reward.label}</b><small>{reward.hint}</small></span></button>)}</div>
      <div className="admin-reward-fields">
        {rewardType === "resource" && <label><span>Ресурс</span><select value={resource} onChange={(e) => setResource(e.target.value)}><option value="credits">Кредиты</option><option value="steel">Сталь</option><option value="fuel">Топливо</option><option value="food">Еда</option><option value="tech">Технологии</option></select></label>}
        {["resource","prestige","treasury","reputation","influence"].includes(rewardType) && <label><span>Сумма</span><input type="number" min="1" value={amount} onChange={(e) => setAmount(e.target.value)} /></label>}
        {["military_boost","xp_boost"].includes(rewardType) && <><label><span>Усиление, %</span><input type="number" min="1" max="300" value={boostPct} onChange={(e) => setBoostPct(e.target.value)} /></label><label><span>Срок, часов</span><input type="number" min="1" max="720" value={durationHours} onChange={(e) => setDurationHours(e.target.value)} /></label></>}
        {rewardType === "protection" && <label><span>Срок защиты от ЧП, часов</span><input type="number" min="1" max="720" value={durationHours} onChange={(e) => setDurationHours(e.target.value)} /></label>}
        {needsPlayer && <label><span>Игрок</span><select value={playerId} onChange={(e) => setPlayerId(e.target.value)}><option value="">Выберите игрока</option>{members.map((member) => <option key={member.id} value={member.id}>{member.displayName}{member.username ? ` (@${member.username})` : ""}</option>)}</select></label>}
        {rewardType === "medal" && <label><span>Кому медаль</span><select value={medalScope} onChange={(e) => setMedalScope(e.target.value as "state" | "player")}><option value="state">Государству</option><option value="player">Игроку</option></select></label>}
        {(rewardType === "title" || rewardType === "medal") && <label className="wide"><span>{rewardType === "title" ? "Название титула" : "Название медали"}</span><input maxLength={100} value={title} onChange={(e) => setTitle(e.target.value)} placeholder={rewardType === "title" ? "Защитник границ" : "Лучший шахтёр месяца"} /></label>}
        {rewardType === "medal" && <><label><span>Иконка / URL картинки</span><input maxLength={300} value={medalIcon} onChange={(e) => setMedalIcon(e.target.value)} /></label><label className="wide"><span>Описание</span><textarea value={medalDescription} onChange={(e) => setMedalDescription(e.target.value)} maxLength={500} rows={3} /></label></>}
        <label className="wide"><span>Причина</span><textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} rows={3} placeholder="Необязательно" /></label>
      </div>
      <button type="button" className="admin-confirm-start" disabled={busy || !selected} onClick={prepareReward}>Выдать</button>
    </div>}

    {tab === "message" && <div className="admin-message-form"><textarea value={freeText} onChange={(e) => setFreeText(e.target.value)} maxLength={3500} rows={7} placeholder="Свободный текст от Администрации WARSTATE"/><div><span>{freeText.length}/3500</span><button type="button" disabled={busy || !selected || !freeText.trim()} onClick={prepareMessage}>Отправить</button></div></div>}

    {tab === "history" && <div className="admin-reward-history" ref={historyRef}>{history.length ? history.map((row) => <article key={row.id}><div><small>{fmtTime(row.createdAt)} · {row.adminUsername ? `@${row.adminUsername}` : `ID ${row.adminTelegramId}`}</small><b>{row.stateName}{row.playerName ? ` · ${row.playerName}` : ""}</b></div><strong>{row.actionType === "message" ? "Сообщение" : rewardName(row.rewardType)}</strong><p>{historyValue(row)}</p>{row.reason && <em>Причина: {row.reason}</em>}</article>) : <p>История пока пустая.</p>}</div>}

    {status && <div className="admin-action-status success">{status}</div>}
    {error && <div className="admin-action-status error">{error}</div>}

    {confirm && <div className="admin-confirm-backdrop"><section className="admin-confirm-card"><small>ПОДТВЕРЖДЕНИЕ</small><h3>{confirm.title}</h3><p>{confirm.detail}</p><div><button type="button" onClick={() => setConfirm(null)} disabled={busy}>Отмена</button><button type="button" className="confirm" onClick={() => void executeConfirmed()} disabled={busy}>{busy ? "Выполняю…" : "Подтвердить"}</button></div></section></div>}
  </section>;
}
