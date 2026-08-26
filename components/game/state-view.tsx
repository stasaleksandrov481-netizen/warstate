"use client";

import { memo, useEffect, useMemo, useState } from "react";
import type { GameSnapshot, StateView } from "@/lib/types";
import { GAME_GUIDE_SECTIONS } from "@/lib/game-guide";

type Props = {
  snapshot: GameSnapshot;
  onClaim: (missionId: string) => void;
  onPolitics: (action: string, payload?: Record<string, string>) => void;
  onGovernment: (action: string, payload?: Record<string, string>) => void;
  onCustomize: (patch: Partial<Pick<StateView, "motto" | "emblem" | "theme" | "color">>) => void;
};

const EMBLEMS = ["◆","◈","⬡","⚑","✦","★","♜","☄"];
const THEMES = [
  ["violet","VIOLET"], ["cyan","CYAN"], ["ember","EMBER"], ["emerald","EMERALD"], ["steel","STEEL"],
] as const;

function roleLabel(role: string) {
  return ({ founder: "Основатель", president: "Президент", minister: "Заместитель", deputy: "Заместитель", curator: "Куратор", general: "Генерал", citizen: "Гражданин", member: "Участник" } as Record<string, string>)[role] || role;
}
function Stat({ label, value }: { label: string; value: string }) {
  return <div className="stat"><small>{label}</small><strong>{value}</strong></div>;
}
function remaining(iso: string, now: number) {
  const ms = Math.max(0, new Date(iso).getTime() - now);
  const days = Math.floor(ms / 86400000);
  const hours = Math.floor(ms % 86400000 / 3600000);
  const minutes = Math.floor(ms % 3600000 / 60000);
  return days > 0 ? `${days}д ${hours}ч` : `${hours}ч ${minutes}м`;
}

function GameGuidePanel() {
  return <div className="panel game-guide-panel">
    <details>
      <summary>
        <span><small>СПРАВОЧНИК</small><strong>Как играть в WARSTATE</strong></span>
        <em>открыть</em>
      </summary>
      <div className="game-guide-intro">От первого входа до войн, союзов и шпионских операций. В чате этот же гайд доступен по команде <b>!играть</b>.</div>
      <div className="game-guide-sections">
        {GAME_GUIDE_SECTIONS.map((section) => <details key={section.title} className="game-guide-step">
          <summary><i>{section.icon}</i><b>{section.title}</b><span>+</span></summary>
          <ul>{section.lines.map((line) => <li key={line}>{line}</li>)}</ul>
        </details>)}
      </div>
      <div className="game-guide-commands"><b>Быстрый старт</b><span>!помощь · !карта · !статус · !миссия · !ресурсы</span></div>
    </details>
  </div>;
}

function PlayerProgress({ snapshot }: { snapshot: GameSnapshot }) {
  const currentFloor = 180 * Math.pow(Math.max(0, snapshot.player.level - 1), 2);
  const nextFloor = 180 * Math.pow(snapshot.player.level, 2);
  const progress = Math.max(0, Math.min(100, ((snapshot.player.xp - currentFloor) / Math.max(1, nextFloor - currentFloor)) * 100));
  return <div className="panel player-progress">
    <div className="player-progress-head"><div><small>ТВОЙ ПРОФИЛЬ</small><h3>{snapshot.player.displayName}</h3><p>{snapshot.state.isFreeport ? "Свободный игрок Freeport" : snapshot.government.founder?.playerId === snapshot.player.id && snapshot.government.president?.playerId === snapshot.player.id ? "Основатель · Президент" : snapshot.government.founder?.playerId === snapshot.player.id ? "Основатель" : roleLabel(snapshot.player.role)} · вклад {snapshot.player.contribution.toLocaleString("ru-RU")}</p></div><b>LVL {snapshot.player.level}</b></div>
    <div className="xp-track"><i style={{ width: `${progress}%` }} /></div>
    <span>{snapshot.player.xp.toLocaleString("ru-RU")} XP · до следующего уровня {Math.max(0, nextFloor - snapshot.player.xp).toLocaleString("ru-RU")} XP</span>
    {snapshot.state.shieldUntil && new Date(snapshot.state.shieldUntil).getTime() > Date.now() && <div className="rookie-shield">◆ Защита новичка активна до {new Date(snapshot.state.shieldUntil).toLocaleTimeString("ru-RU", {hour:"2-digit",minute:"2-digit"})}</div>}
  </div>;
}

function GovernmentPanel({ snapshot, onGovernment }: Pick<Props, "snapshot" | "onGovernment">) {
  const gov = snapshot.government;
  const [target, setTarget] = useState("");
  const [voteTarget, setVoteTarget] = useState("");
  const [handle, setHandle] = useState(snapshot.state.stateUsername || "");
  const [stateName, setStateName] = useState(snapshot.state.name);
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const founderName = gov.founder ? `${gov.founder.displayName}${gov.founder.username ? ` (@${gov.founder.username})` : ""}` : "не подтверждён";
  const presidentName = gov.president ? `${gov.president.displayName}${gov.president.username ? ` (@${gov.president.username})` : ""}` : "не назначен";
  const founderIsPresident = Boolean(gov.founder && gov.president && gov.founder.playerId === gov.president.playerId);
  const iAmPresident = gov.president?.playerId === snapshot.player.id;
  return <div className="panel government-panel">
    <div className="panel-head"><div><small>ПРАВИТЕЛЬСТВО</small><h3>Управление государством</h3></div><span>{snapshot.state.stateUsername ? `@${snapshot.state.stateUsername}` : "без юза"}</span></div>
    <div className="government-roster">
      <article><small>ОСНОВАТЕЛЬ</small><b>{founderName}</b></article>
      <article><small>ПРЕЗИДЕНТ</small><b>{presidentName}</b></article>
      <article><small>ЗАМЕСТИТЕЛИ · {gov.deputies.length}/3</small><b>{gov.deputies.length ? gov.deputies.map((d) => d.username ? `@${d.username}` : d.displayName).join(", ") : "нет"}</b></article>
    </div>
    {snapshot.election?.status === "open" && new Date(snapshot.election.endsAt).getTime() > Date.now() && <div className="government-vote">
      <label>Голосование по @username</label>
      <div><input placeholder="@username" value={voteTarget} onChange={(e) => setVoteTarget(e.target.value)} /><button type="button" className="primary" onClick={() => onGovernment("vote_username", { username: voteTarget })}>Голосовать</button></div>
      <small>Один голос на гражданина. Голос можно изменить до закрытия выборов.</small>
    </div>}
    {gov.canProjectAdmin && gov.canFounderManage && <div className="project-admin-console">
      <div className="project-admin-copy"><small>РЕЖИМ СОЗДАТЕЛЯ ПРОЕКТА</small><b>Тестовое управление без голосования</b><span>Работает только для Telegram ID из WARSTATE_PROJECT_ADMIN_TELEGRAM_IDS и только в вашем государстве.</span></div>
      <button type="button" disabled={iAmPresident} onClick={() => onGovernment("request_self_presidency")}>{iAmPresident ? "Вы уже президент" : "Назначить себя президентом"}</button>
    </div>}
    {gov.canFounderManage && <div className="government-console">
      <div className="founder-self-rule">
        <div><small>СОВМЕЩЕНИЕ РОЛЕЙ</small><b>{founderIsPresident ? "Основатель + Президент" : "Основатель может стать Президентом"}</b><span>{gov.canProjectAdmin ? "Админ бота управляет командами без изменения роли." : "Для обычного Основателя самоназначение проходит через 2-минутное голосование и требует хотя бы одного голоса другого гражданина и большинства среди поданных голосов."}</span></div>
        {!gov.canProjectAdmin && <button type="button" disabled={iAmPresident} onClick={() => onGovernment("request_self_presidency")}>{iAmPresident ? "Вы уже президент" : "Выдвинуть себя"}</button>}
      </div>
      <div className="government-field"><label>Название государства</label><div><input maxLength={64} value={stateName} onChange={(e) => setStateName(e.target.value)} /><button type="button" onClick={() => onGovernment("rename_state", { name: stateName })}>Сохранить</button></div></div>
      <div className="government-field"><label>Уникальный юз</label><div><input maxLength={32} placeholder="north_empire" value={handle} onChange={(e) => setHandle(e.target.value.replace(/^@/, ""))} /><button type="button" onClick={() => onGovernment("set_username", { username: handle })}>@ Юз</button></div></div>
      <div className="government-field"><label>Гражданин по @username</label><input placeholder="@username" value={target} onChange={(e) => setTarget(e.target.value)} /></div>
      <div className="government-actions">
        <button type="button" className="primary" onClick={() => onGovernment("open_election")}>Выборы · 30 мин</button>
        <button type="button" onClick={() => onGovernment("appoint_president", { username: target })}>Назначить президента</button>
        <button type="button" onClick={() => onGovernment("remove_president")}>Снять президента</button>
        <button type="button" onClick={() => onGovernment("appoint_deputy", { username: target })}>Назначить зама</button>
        <button type="button" onClick={() => onGovernment("remove_deputy", { username: target })}>Снять зама</button>
      </div>
      <div className="government-danger-zone">
        <small>ОПАСНАЯ ЗОНА · ТОЛЬКО ВЛАДЕЛЕЦ ЧАТА</small>
        {!deleteConfirm ? <>
          <p>Удаление необратимо. Граждане будут переведены во Freeport, а остров исчезнет с карты.</p>
          <button type="button" onClick={() => setDeleteConfirm(true)}>Удалить государство</button>
        </> : <div className="government-delete-confirm">
          <b>Точно удалить «{snapshot.state.name}»?</b>
          <div className="government-delete-actions">
            <button type="button" onClick={() => setDeleteConfirm(false)}>Отмена</button>
            <button type="button" className="confirm-delete" onClick={() => onGovernment("delete_state")}>Да, удалить</button>
          </div>
        </div>}
      </div>
    </div>}
    {iAmPresident && !gov.canFounderManage && <div className="government-console president-deputy-console">
      <div className="founder-self-rule"><div><small>ПРЕЗИДЕНТ</small><b>Управление заместителями</b><span>Президент может назначать и снимать до трёх заместителей. Укажите @username гражданина государства.</span></div></div>
      <div className="government-field"><label>Гражданин по @username</label><input placeholder="@username" value={target} onChange={(e) => setTarget(e.target.value)} /></div>
      <div className="government-actions">
        <button type="button" className="primary" onClick={() => onGovernment("appoint_deputy", { username: target })}>Назначить зама</button>
        <button type="button" onClick={() => onGovernment("remove_deputy", { username: target })}>Снять зама</button>
      </div>
    </div>}
    {!gov.canFounderManage && gov.president?.playerId && snapshot.player.role !== "curator" && (
      <div className="government-console impeachment-section">
        <div className="founder-self-rule"><div><small>ИМПИЧМЕНТ</small><b>Голосование об отстранении президента</b><span>Любой гражданин может инициировать импичмент. Голосование длится 5 минут, необходимо большинство «За».</span></div></div>
        <button type="button" className="impeachment-btn" onClick={() => onGovernment("start_impeachment")}>⚖ Инициировать импичмент</button>
      </div>
    )}
  </div>;
}

function IdentityEditor({ snapshot, onCustomize }: Pick<Props, "snapshot" | "onCustomize">) {
  const [motto, setMotto] = useState(snapshot.state.motto);
  const canEdit = ["president","minister","deputy","curator"].includes(snapshot.player.role) || snapshot.government.president?.playerId === snapshot.player.id;
  if (!canEdit) return null;
  return <div className="panel identity-editor">
    <div className="panel-head"><div><small>АЙДЕНТИКА</small><h3>Лицо государства</h3></div><span>видно всему миру</span></div>
    <label className="motto-input"><span>Девиз</span><input maxLength={80} value={motto} onChange={(e) => setMotto(e.target.value)} onBlur={() => motto !== snapshot.state.motto && onCustomize({ motto })} /></label>
    <div className="identity-row"><div><small>ЭМБЛЕМА</small><div className="emblem-picker">{EMBLEMS.map((emblem) => <button type="button" key={emblem} className={snapshot.state.emblem === emblem ? "active" : ""} onClick={() => onCustomize({ emblem })}>{emblem}</button>)}</div></div>
    <label className="color-picker"><small>ЦВЕТ</small><input aria-label="Цвет государства" type="color" value={snapshot.state.color} onChange={(e) => onCustomize({ color: e.target.value })} /></label></div>
    <div className="theme-picker">{THEMES.map(([key,label]) => <button type="button" key={key} className={snapshot.state.theme === key ? `active theme-${key}` : `theme-${key}`} onClick={() => onCustomize({ theme: key })}><i />{label}</button>)}</div>
  </div>;
}

function ElectionPanel({ snapshot, onPolitics, now }: Pick<Props, "snapshot" | "onPolitics"> & { now: number }) {
  const [statement, setStatement] = useState("Развивать остров, укреплять флот и поднимать рейтинг.");
  const election = snapshot.election;
  const canOpen = snapshot.government.canFounderManage;
  const myCandidate = election?.candidates.find((candidate) => candidate.isMe);
  const totalVotes = election?.candidates.reduce((sum, candidate) => sum + candidate.votes, 0) || 0;
  const ended = election ? new Date(election.endsAt).getTime() <= now : false;

  if (!election) return <div className="panel election-panel empty-election"><div><small>ПОЛИТИКА</small><h3>Президентские выборы</h3><p>Запускайте голосование кнопкой ниже. После старта сообщение автоматически появится в Telegram-группе государства.</p></div>{canOpen && <button className="primary" onClick={() => onPolitics("open")}>Открыть выборы</button>}</div>;

  return <div className="panel election-panel">
    <div className="election-head"><div><small>ВЫБОРЫ ПРЕЗИДЕНТА</small><h3>{election.status === "open" ? ended ? "Голосование завершено" : `До закрытия ${remaining(election.endsAt, now)}` : election.status === "resolved" ? "Результаты утверждены" : "Выборы отменены"}</h3></div><b>{totalVotes}<span>голосов</span></b></div>
    <div className="candidate-list">{election.candidates.map((candidate, index) => {
      const share = totalVotes ? Math.round(candidate.votes / totalVotes * 100) : 0;
      return <div className={`candidate-card ${election.myVoteCandidateId === candidate.id ? "voted" : ""}`} key={candidate.id}>
        <div className="candidate-rank">{index + 1}</div><div className="candidate-main"><strong>{candidate.displayName}{candidate.isMe ? " · вы" : ""}</strong><span>{candidate.statement || "Без предвыборной программы"}</span><i><em style={{ width: `${share}%` }} /></i></div><div className="candidate-votes"><b>{candidate.votes}</b><small>{share}%</small>{election.status === "open" && !ended && <button type="button" disabled={snapshot.government.canFounderManage && candidate.isMe} onClick={() => onPolitics("vote", { electionId: election.id, candidateId: candidate.id })}>{snapshot.government.canFounderManage && candidate.isMe ? "Нужен другой" : election.myVoteCandidateId === candidate.id ? "✓" : "Голос"}</button>}</div>
      </div>;
    })}</div>
    {election.status === "open" && !ended && !myCandidate && <div className="nominate"><input maxLength={120} value={statement} onChange={(e) => setStatement(e.target.value)} /><button type="button" onClick={() => onPolitics("nominate", { electionId: election.id, statement })}>Выдвинуться</button></div>}
    {election.status === "open" && ended && <button className="primary finalize-election" onClick={() => onPolitics("finalize", { electionId: election.id })}>Подвести итоги</button>}
  </div>;
}

function DailyOpsPanel({ snapshot, onClaim }: Pick<Props, "snapshot" | "onClaim">) {
  const claimed = snapshot.dailyMissions.filter((mission) => mission.claimed).length;
  const ready = snapshot.dailyMissions.filter((mission) => !mission.claimed && mission.progress >= mission.target).length;
  return <div className="panel daily-ops" id="daily-ops">
    <div className="daily-head"><div><small>ЕЖЕДНЕВНЫЕ ОПЕРАЦИИ</small><h3>{claimed}/{snapshot.dailyMissions.length} наград получено</h3></div><b>{ready > 0 ? `${ready} готово` : "до 00:00 UTC"}</b></div>
    <div className="mission-list">
      {snapshot.dailyMissions.map((mission) => {
        const done = mission.progress >= mission.target;
        const pct = mission.target > 0 ? Math.min(100, mission.progress / mission.target * 100) : 100;
        return <div className={`mission-row ${mission.claimed ? "claimed" : done ? "done" : ""}`} key={mission.id}>
          <div className="mission-copy"><strong>{mission.title}</strong><span>{mission.description}</span><i><em style={{ width: `${pct}%` }} /></i></div>
          <div className="mission-reward"><small>{mission.progress}/{mission.target}</small><span>+{mission.rewardXp} XP<br/>+{mission.rewardCredits} ₡</span><button type="button" disabled={!done || mission.claimed} onClick={() => onClaim(mission.id)}>{mission.claimed ? "✓" : done ? "Забрать" : "…"}</button></div>
        </div>;
      })}
    </div>
  </div>;
}

function StateViewInner({ snapshot, onClaim, onPolitics, onGovernment, onCustomize }: Props) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 60_000); return () => window.clearInterval(timer); }, []);
  const seasonProgress = useMemo(() => {
    if (!snapshot.season) return 0;
    const start = new Date(snapshot.season.startsAt).getTime();
    const end = new Date(snapshot.season.endsAt).getTime();
    return Math.max(0, Math.min(100, (now - start) / Math.max(1, end - start) * 100));
  }, [snapshot.season, now]);
  return <div className={`state-screen game-scene state-theme-${snapshot.state.theme} ${snapshot.state.isFreeport ? "freeport-profile" : ""}`} style={{ ["--state-color" as any]: snapshot.state.color }}>
    <div className="hero-state identity-hero"><div className="state-emblem">{snapshot.state.emblem}</div><div className="flag"><span /></div><small>{snapshot.state.isFreeport ? "НЕЙТРАЛЬНАЯ ГАВАНЬ" : "ГОСУДАРСТВО"}</small><h2>{snapshot.state.name}</h2>{snapshot.state.stateUsername && <div className="state-handle">@{snapshot.state.stateUsername}</div>}<p className="state-motto">«{snapshot.state.motto}»</p></div>
    {!snapshot.state.isFreeport && snapshot.season && <div className="season-strip"><div><small>СЕЗОН {snapshot.season.number}</small><strong>{snapshot.season.name}</strong></div><div className="season-progress"><i><em style={{ width: `${seasonProgress}%` }} /></i><span>осталось {remaining(snapshot.season.endsAt, now)}</span></div><b>#{snapshot.state.seasonRank}</b></div>}
    <div className="stats-grid"><Stat label={snapshot.state.isFreeport ? "Уровень" : "Рейтинг"} value={snapshot.state.isFreeport ? String(snapshot.player.level) : snapshot.state.rating.toLocaleString("ru-RU")} /><Stat label={snapshot.state.isFreeport ? "Опыт" : "Место"} value={snapshot.state.isFreeport ? `${snapshot.player.xp} XP` : `#${snapshot.state.seasonRank}`} /><Stat label={snapshot.state.isFreeport ? "Свободные игроки" : "Граждане"} value={String(snapshot.state.memberCount)} /><Stat label={snapshot.state.isFreeport ? "Статус" : "Победы"} value={snapshot.state.isFreeport ? "FREE" : String(snapshot.state.islandWins)} /></div>
    {!snapshot.state.isFreeport && snapshot.election?.status === "open" && <ElectionPanel snapshot={snapshot} onPolitics={onPolitics} now={now} />}
    <DailyOpsPanel snapshot={snapshot} onClaim={onClaim} />
    <PlayerProgress snapshot={snapshot} />
    <GameGuidePanel />
    {!snapshot.state.isFreeport && <GovernmentPanel snapshot={snapshot} onGovernment={onGovernment} />}
    {!snapshot.state.isFreeport && snapshot.election?.status !== "open" && <ElectionPanel snapshot={snapshot} onPolitics={onPolitics} now={now} />}
    {!snapshot.state.isFreeport && <IdentityEditor snapshot={snapshot} onCustomize={onCustomize} />}
    {!snapshot.state.isFreeport && <div className="panel badge-panel"><div className="panel-head"><div><small>ЛЕТОПИСЬ</small><h3>Награды государства</h3></div><span>{snapshot.badges.length} получено</span></div>{snapshot.badges.length ? <div className="badge-grid">{snapshot.badges.map((badge) => <div className="state-badge" key={badge.id}><b>{badge.icon}</b><strong>{badge.title}</strong><span>{badge.description}</span></div>)}</div> : <p>Первая награда появится за рейтинг, серию или победы.</p>}</div>}
    <div className="panel wars-panel"><small>ПОСЛЕДНИЕ БОИ</small>{snapshot.wars.length ? snapshot.wars.map((war) => <div className="war-row" key={war.id}><b>{war.attackerName}</b><span>{war.attackerPower} : {war.defenderPower}</span><b>{war.defenderName || "Нейтралы"}</b></div>) : <p>История пока пустая. Время испортить отношения с соседями.</p>}</div>
  </div>;
}
export const StateViewPanel = memo(StateViewInner);
