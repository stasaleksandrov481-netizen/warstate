"use client";

import { memo, useEffect, useMemo, useState } from "react";
import type { GameSnapshot, StateView } from "@/lib/types";

type Props = {
  snapshot: GameSnapshot;
  onClaim: (missionId: string) => void;
  onPolitics: (action: string, payload?: Record<string, string>) => void;
  onCustomize: (patch: Partial<Pick<StateView, "motto" | "emblem" | "theme" | "color">>) => void;
};

const EMBLEMS = ["◆","◈","⬡","⚑","✦","★","♜","☄"];
const THEMES = [
  ["violet","VIOLET"], ["cyan","CYAN"], ["ember","EMBER"], ["emerald","EMERALD"], ["steel","STEEL"],
] as const;

function roleLabel(role: string) {
  return ({ president: "Президент", minister: "Министр", general: "Генерал", citizen: "Гражданин" } as Record<string, string>)[role] || role;
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

function PlayerProgress({ snapshot }: { snapshot: GameSnapshot }) {
  const currentFloor = 180 * Math.pow(Math.max(0, snapshot.player.level - 1), 2);
  const nextFloor = 180 * Math.pow(snapshot.player.level, 2);
  const progress = Math.max(0, Math.min(100, ((snapshot.player.xp - currentFloor) / Math.max(1, nextFloor - currentFloor)) * 100));
  return <div className="panel player-progress">
    <div className="player-progress-head"><div><small>ТВОЙ ПРОФИЛЬ</small><h3>{snapshot.player.displayName}</h3><p>{roleLabel(snapshot.player.role)} · вклад {snapshot.player.contribution.toLocaleString("ru-RU")}</p></div><b>LVL {snapshot.player.level}</b></div>
    <div className="xp-track"><i style={{ width: `${progress}%` }} /></div>
    <span>{snapshot.player.xp.toLocaleString("ru-RU")} XP · до следующего уровня {Math.max(0, nextFloor - snapshot.player.xp).toLocaleString("ru-RU")} XP</span>
    {snapshot.state.shieldUntil && new Date(snapshot.state.shieldUntil).getTime() > Date.now() && <div className="rookie-shield">◆ Защита новичка активна до {new Date(snapshot.state.shieldUntil).toLocaleTimeString("ru-RU", {hour:"2-digit",minute:"2-digit"})}</div>}
  </div>;
}

function IdentityEditor({ snapshot, onCustomize }: Pick<Props, "snapshot" | "onCustomize">) {
  const [motto, setMotto] = useState(snapshot.state.motto);
  const canEdit = ["president","minister"].includes(snapshot.player.role);
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
  const [statement, setStatement] = useState("Развивать город, укреплять армию и расширять границы.");
  const election = snapshot.election;
  const canOpen = snapshot.player.role === "president";
  const myCandidate = election?.candidates.find((candidate) => candidate.isMe);
  const totalVotes = election?.candidates.reduce((sum, candidate) => sum + candidate.votes, 0) || 0;
  const ended = election ? new Date(election.endsAt).getTime() <= now : false;

  if (!election) return <div className="panel election-panel empty-election"><div><small>ПОЛИТИКА</small><h3>Президентские выборы</h3><p>Откройте 24-часовое голосование. Каждый гражданин получает один голос и может поменять его до закрытия урн.</p></div>{canOpen && <button className="primary" onClick={() => onPolitics("open")}>Открыть выборы</button>}</div>;

  return <div className="panel election-panel">
    <div className="election-head"><div><small>ВЫБОРЫ ПРЕЗИДЕНТА</small><h3>{election.status === "open" ? ended ? "Голосование завершено" : `До закрытия ${remaining(election.endsAt, now)}` : election.status === "resolved" ? "Результаты утверждены" : "Выборы отменены"}</h3></div><b>{totalVotes}<span>голосов</span></b></div>
    <div className="candidate-list">{election.candidates.map((candidate, index) => {
      const share = totalVotes ? Math.round(candidate.votes / totalVotes * 100) : 0;
      return <div className={`candidate-card ${election.myVoteCandidateId === candidate.id ? "voted" : ""}`} key={candidate.id}>
        <div className="candidate-rank">{index + 1}</div><div className="candidate-main"><strong>{candidate.displayName}{candidate.isMe ? " · вы" : ""}</strong><span>{candidate.statement || "Без предвыборной программы"}</span><i><em style={{ width: `${share}%` }} /></i></div><div className="candidate-votes"><b>{candidate.votes}</b><small>{share}%</small>{election.status === "open" && !ended && <button type="button" onClick={() => onPolitics("vote", { electionId: election.id, candidateId: candidate.id })}>{election.myVoteCandidateId === candidate.id ? "✓" : "Голос"}</button>}</div>
      </div>;
    })}</div>
    {election.status === "open" && !ended && !myCandidate && <div className="nominate"><input maxLength={120} value={statement} onChange={(e) => setStatement(e.target.value)} /><button type="button" onClick={() => onPolitics("nominate", { electionId: election.id, statement })}>Выдвинуться</button></div>}
    {election.status === "open" && ended && <button className="primary finalize-election" onClick={() => onPolitics("finalize", { electionId: election.id })}>Подвести итоги</button>}
  </div>;
}

function StateViewInner({ snapshot, onClaim, onPolitics, onCustomize }: Props) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 60_000); return () => window.clearInterval(timer); }, []);
  const seasonProgress = useMemo(() => {
    if (!snapshot.season) return 0;
    const start = new Date(snapshot.season.startsAt).getTime();
    const end = new Date(snapshot.season.endsAt).getTime();
    return Math.max(0, Math.min(100, (now - start) / Math.max(1, end - start) * 100));
  }, [snapshot.season, now]);
  return <div className={`state-screen game-scene state-theme-${snapshot.state.theme}`} style={{ ["--state-color" as any]: snapshot.state.color }}>
    <div className="hero-state identity-hero"><div className="state-emblem">{snapshot.state.emblem}</div><div className="flag"><span /></div><small>ГОСУДАРСТВО</small><h2>{snapshot.state.name}</h2><p className="state-motto">«{snapshot.state.motto}»</p></div>
    {snapshot.season && <div className="season-strip"><div><small>СЕЗОН {snapshot.season.number}</small><strong>{snapshot.season.name}</strong></div><div className="season-progress"><i><em style={{ width: `${seasonProgress}%` }} /></i><span>осталось {remaining(snapshot.season.endsAt, now)}</span></div><b>#{snapshot.state.seasonRank}</b></div>}
    <div className="stats-grid"><Stat label="Рейтинг" value={snapshot.state.rating.toLocaleString("ru-RU")} /><Stat label="Место" value={`#${snapshot.state.seasonRank}`} /><Stat label="Граждане" value={String(snapshot.state.memberCount)} /><Stat label="Территории" value={String(snapshot.state.territoryCount)} /></div>
    <ElectionPanel snapshot={snapshot} onPolitics={onPolitics} now={now} />
    <IdentityEditor snapshot={snapshot} onCustomize={onCustomize} />
    <div className="panel badge-panel"><div className="panel-head"><div><small>ЛЕТОПИСЬ</small><h3>Награды государства</h3></div><span>{snapshot.badges.length} получено</span></div>{snapshot.badges.length ? <div className="badge-grid">{snapshot.badges.map((badge) => <div className="state-badge" key={badge.id}><b>{badge.icon}</b><strong>{badge.title}</strong><span>{badge.description}</span></div>)}</div> : <p>Первая награда появится за рейтинг, территории или победы.</p>}</div>
    <div className="panel daily-ops"><div className="daily-head"><div><small>ЕЖЕДНЕВНЫЕ ОПЕРАЦИИ</small><h3>{snapshot.dailyMissions.filter((mission) => mission.claimed).length}/{snapshot.dailyMissions.length} наград получено</h3></div><b>до 00:00 UTC</b></div><div className="mission-list">
      {snapshot.dailyMissions.map((mission) => { const done = mission.progress >= mission.target; return <div className={`mission-row ${mission.claimed ? "claimed" : done ? "done" : ""}`} key={mission.id}><div className="mission-copy"><strong>{mission.title}</strong><span>{mission.description}</span><i><em style={{ width: `${Math.min(100, mission.progress / mission.target * 100)}%` }} /></i></div><div className="mission-reward"><small>{mission.progress}/{mission.target}</small><span>+{mission.rewardXp} XP<br/>+{mission.rewardCredits} ₡</span><button type="button" disabled={!done || mission.claimed} onClick={() => onClaim(mission.id)}>{mission.claimed ? "✓" : done ? "Забрать" : "…"}</button></div></div>; })}
    </div></div>
    <PlayerProgress snapshot={snapshot} />
    <div className="panel wars-panel"><small>ПОСЛЕДНИЕ БОИ</small>{snapshot.wars.length ? snapshot.wars.map((war) => <div className="war-row" key={war.id}><b>{war.attackerName}</b><span>{war.attackerPower} : {war.defenderPower}</span><b>{war.defenderName || "Нейтралы"}</b></div>) : <p>История пока пустая. Время испортить отношения с соседями.</p>}</div>
  </div>;
}
export const StateViewPanel = memo(StateViewInner);
