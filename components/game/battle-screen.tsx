"use client";

import { memo, useEffect, useState } from "react";
import type { BattleClass, BattleOrderKind, BattlePoint, BattleView } from "@/lib/types";

const POINTS: BattlePoint[] = ["A", "B", "C"];
const CLASSES: Array<[BattleClass,string,string]> = [
  ["assault","Штурмовик","урон"],["medic","Медик","лечение"],["engineer","Инженер","захват"],["scout","Разведчик","скорость"],
];
const ORDER_KINDS: Array<[BattleOrderKind,string]> = [["attack","Штурм"],["defend","Оборона"],["rally","Сбор"]];

function className(klass: BattleClass) { return ({assault:"Штурмовик",medic:"Медик",engineer:"Инженер",scout:"Разведчик"} as const)[klass]; }
function classGlyph(klass: BattleClass) { return ({assault:"✦",medic:"+",engineer:"◆",scout:"↟"} as const)[klass]; }
function orderKindLabel(kind: BattleOrderKind) { return ({attack:"ШТУРМОВАТЬ",defend:"УДЕРЖИВАТЬ",rally:"СОБРАТЬСЯ НА"} as const)[kind]; }
function orderKindIcon(kind: BattleOrderKind) { return ({attack:"⚔",defend:"◆",rally:"◎"} as const)[kind]; }
function formatBattleTime(seconds: number) { return `${Math.floor(seconds/60)}:${String(seconds%60).padStart(2,"0")}`; }

const BattleClock = memo(function BattleClock({ endsAt, resolved }: { endsAt: string; resolved: boolean }) {
  const [seconds, setSeconds] = useState(() => Math.max(0, Math.ceil((new Date(endsAt).getTime() - Date.now()) / 1000)));
  useEffect(() => {
    if (resolved) return;
    const tick = () => setSeconds(Math.max(0, Math.ceil((new Date(endsAt).getTime() - Date.now()) / 1000)));
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [endsAt, resolved]);
  return <strong>{resolved ? "FIN" : formatBattleTime(seconds)}</strong>;
});

function BattleScreenInner({ battle, playerName, freeport = false, onJoin, onAction, onOpenMap }: {
  battle: BattleView | null;
  playerName: string;
  freeport?: boolean;
  onJoin: (klass: BattleClass) => void;
  onAction: (action: string, payload?: Record<string, unknown>) => void;
  onOpenMap?: () => void;
}) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!battle?.me || battle.status !== "active") return;
    const timer = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(timer);
  }, [battle?.me?.id, battle?.status]);
  if (!battle) return <div className="empty-battle game-scene"><div className="battle-empty-orbit"><div className="battle-emblem">⚔</div></div><small>БОЕВОЙ ЦЕНТР</small><h2>{freeport ? "Учебный режим" : "Сейчас тихо"}</h2><p>{freeport ? "Freeport не начинает войны. Здесь можно освоиться, прокачать профиль и найти государство для настоящих сражений." : "Выберите на карте государство и подготовьте военную операцию."}</p>{onOpenMap && <button type="button" className="battle-map-cta" onClick={onOpenMap}>Открыть карту</button>}</div>;
  const myTeam = battle.me?.team || battle.myTeam;
  const teamPlayers = battle.players.filter((player) => player.team === myTeam);
  const enemyPlayers = battle.players.filter((player) => player.team !== myTeam);
  const activeOrder = battle.orders.find((order) => order.team === myTeam) || null;
  const canCommand = ["president", "minister", "deputy"].includes(battle.myRole || "");

  if (!battle.me && battle.status === "active") return (
    <div className="battle-screen join-screen game-scene">
      <div className="battle-head"><small>ОПЕРАЦИЯ</small><h2>{battle.attackerName} <i>VS</i> {battle.defenderName}</h2><BattleClock endsAt={battle.endsAt} resolved={false} /></div>
      <div className="class-grid class-grid-v2">{CLASSES.map(([key,title,desc]) => <button key={key} onClick={() => onJoin(key)}><i>{classGlyph(key)}</i><b>{title}</b><small>{desc}</small></button>)}</div>
      <p className="battle-hint">Выбери роль. Класс можно сменить позже, но действия имеют кулдаун.</p>
    </div>
  );

  const me = battle.me;
  const cooldownMs = me?.cooldownUntil ? Math.max(0, new Date(me.cooldownUntil).getTime() - now) : 0;
  const respawnMs = me?.respawnAt ? Math.max(0, new Date(me.respawnAt).getTime() - now) : 0;
  const actionLocked = battle.status !== "active" || cooldownMs > 0 || Boolean(me && me.hp <= 0);
  const actionStatus = respawnMs > 0 ? `ВОЗВРАТ ${(respawnMs / 1000).toFixed(1)}с` : cooldownMs > 0 ? `КД ${(cooldownMs / 1000).toFixed(1)}с` : "ГОТОВ";
  const playersByPoint = new Map(POINTS.map((point) => [point, battle.players.filter((player) => player.point === point && player.hp > 0)]));
  const totalScore = Math.max(1, battle.attackerScore + battle.defenderScore);
  const attackerShare = Math.max(4, Math.min(96, (battle.attackerScore / totalScore) * 100));
  const myStateId = myTeam === "attacker" ? battle.attackerStateId : battle.defenderStateId;
  const resolvedTone = battle.isDraw ? "draw" : battle.winnerStateId === myStateId ? "victory" : "defeat";
  const resolvedTitle = battle.isDraw ? "Ничья" : battle.winnerStateId === myStateId ? "Победа" : "Поражение";
  const teamKills = teamPlayers.reduce((sum, player) => sum + player.kills, 0);
  const enemyKills = enemyPlayers.reduce((sum, player) => sum + player.kills, 0);

  return (
    <div className="battle-screen game-scene">
      <div className="battle-head battle-head-v2"><div><small>{battle.status === "resolved" ? "БИТВА ЗАВЕРШЕНА" : "LIVE BATTLE"}</small><h2>{battle.attackerName} <i>VS</i> {battle.defenderName}</h2></div><BattleClock endsAt={battle.endsAt} resolved={battle.status === "resolved"} /></div>
      <div className="scoreboard scoreboard-v2" aria-label={`Счёт ${battle.attackerScore}:${battle.defenderScore}`}><span style={{width:`${attackerShare}%`,background:battle.attackerColor}} /><span className="score-a"><small>{battle.attackerName}</small>{battle.attackerScore}</span><b>:</b><span className="score-d"><small>{battle.defenderName}</small>{battle.defenderScore}</span></div>
      <div className="battle-kpi-row"><span><small>НАШИ</small><b>{teamPlayers.length}</b><em>{teamKills} устранений</em></span><span><small>ТОЧКИ</small><b>{POINTS.filter((point) => battle.pointOwners[point] === myTeam).length}/3</b><em>под контролем</em></span><span><small>ВРАГ</small><b>{enemyPlayers.length}</b><em>{enemyKills} устранений</em></span></div>
      {battle.status === "resolved" && <section className={`battle-result-card ${resolvedTone}`}><div><small>ОПЕРАЦИЯ ЗАВЕРШЕНА</small><h3>{resolvedTitle}</h3><p>{battle.isDraw ? "Силы сторон оказались слишком близки. Обе армии ушли на восстановление." : battle.winnerStateId === battle.attackerStateId ? `${battle.attackerName} завершает операцию победой.` : `${battle.defenderName} удерживает государство.`}</p></div><strong>{battle.attackerScore}<i>:</i>{battle.defenderScore}</strong>{(battle.stolenBudget > 0 || battle.stolenInfluence > 0) && <footer><span>Захвачено</span><b>₡ {battle.stolenBudget.toLocaleString("ru-RU")}</b><b>влияние {battle.stolenInfluence.toLocaleString("ru-RU")}</b></footer>}</section>}
      <div className="battle-balance-strip">
        <span><small>АТАКА</small><b>×{battle.attackerSizeModifier.toFixed(2)}</b></span>
        <span><small>ОБОРОНА</small><b>×{battle.defenderSizeModifier.toFixed(2)}</b></span>
        <span><small>БУФЕР</small><b>+{battle.defenderBuffer}</b></span>
        {battle.aggressionPenalty > 0 ? <span className="fatigue"><small>УСТАЛОСТЬ</small><b>−{Math.round(battle.aggressionPenalty * 100)}%</b></span> : null}
      </div>
      {activeOrder && <div className={`order-banner order-${activeOrder.kind}`}><small>ПРИКАЗ · {activeOrder.issuedBy || "КОМАНДИР"}</small><b>{orderKindLabel(activeOrder.kind)} ТОЧКУ {activeOrder.point}</b><span>{me?.squadCode ? `ОТРЯД ${me.squadCode}` : "ВСЕМ ОТРЯДАМ"}</span></div>}
      {canCommand && battle.status === "active" && <details className="commander-panel commander-panel-v2"><summary><span><small>КОМАНДНЫЙ КАНАЛ</small><b>Отдать приказ</b></span><i>⌄</i></summary><div className="commander-orders">{POINTS.flatMap((point) => ORDER_KINDS.map(([kind,label]) => <button key={`${point}-${kind}`} onClick={() => onAction("order", { point, kind })}><span>{point}</span>{label}</button>))}</div></details>}

      <div className="battlefield battlefield-v2">
        <div className="battle-grid-lines" /><div className="battle-smoke smoke-left" /><div className="battle-smoke smoke-right" />
        {POINTS.map((point) => {
          const owner = battle.pointOwners[point];
          const at = playersByPoint.get(point) || [];
          const allies = at.filter((player) => player.team === myTeam).length;
          const enemies = at.length - allies;
          const ordered = activeOrder?.point === point;
          return <button key={point} className={`capture-point capture-point-v2 point-${point.toLowerCase()} ${me?.point === point ? "current" : ""} ${ordered ? "ordered" : ""} owner-${owner || "none"}`} disabled={actionLocked || me?.point === point} onClick={() => !actionLocked && onAction("move", { point })}>
            {ordered && <i className="order-ping">{orderKindIcon(activeOrder!.kind)}</i>}
            <div className="point-ring"><i /><i /><i /></div>
            <div className="unit-cloud">{at.slice(0,10).map((unit, index) => <i key={unit.id} className={`unit-token team-${unit.team} class-${unit.class} ${unit.playerId === me?.playerId ? "is-me" : ""}`} style={{ ["--ux" as string]: `${14 + (index%5)*18}%`, ["--uy" as string]: `${18 + Math.floor(index/5)*25}%`, ["--delay" as string]: `${(index % 5) * -.17}s` }} title={unit.displayName}>{classGlyph(unit.class)}</i>)}</div>
            <span>{point}</span><small>{owner ? (owner === myTeam ? "НАША" : "ВРАГ") : "НЕЙТРАЛЬНАЯ"}</small><em>{allies} союзн. · {enemies} враг.</em>
          </button>;
        })}
      </div>

      {me && <div className="combat-card combat-card-v2">
        <div className="soldier"><div><small>{playerName}</small><b>{className(me.class)} · {me.point} · {me.squadCode || "БЕЗ ОТРЯДА"}</b></div><div className="soldier-status"><div className="hp"><span style={{width:`${me.hp}%`}} />{me.hp} HP</div><small className={actionLocked ? "locked" : "ready"}>{actionStatus}</small></div></div>
        <div className="combat-actions combat-actions-v2">
          <button disabled={actionLocked} onClick={() => onAction("fire")}><i>✦</i>Огонь</button>
          <button disabled={actionLocked} onClick={() => onAction("capture")}><i>◎</i>Захват</button>
          {me.class === "medic" && <button disabled={actionLocked} onClick={() => onAction("heal")}><i>+</i>Лечить</button>}
          {me.class === "engineer" && <button disabled={actionLocked} onClick={() => onAction("fortify")}><i>◆</i>Укрепить</button>}
        </div>
        <div className="class-switch">{CLASSES.map(([key]) => <button key={key} disabled={actionLocked} className={me.class === key ? "active" : ""} onClick={() => onAction("class", { class:key })}>{className(key).slice(0,3)}</button>)}</div>
      </div>}

      <div className="battle-columns">
        <div className="battle-roster"><small>НАШИ · {teamPlayers.length}</small>{teamPlayers.slice(0,5).map(player => <span key={player.id}><b>{player.displayName}<u>{player.squadCode || "-"}</u></b><i>{player.kills}/{player.deaths}</i></span>)}</div>
        <div className="battle-roster"><small>ПРОТИВНИК · {enemyPlayers.length}</small>{enemyPlayers.slice(0,5).map(player => <span key={player.id}><b>{player.displayName}<u>{player.squadCode || "-"}</u></b><i>{player.kills}/{player.deaths}</i></span>)}</div>
      </div>
      <div className="battle-feed"><small>ЭФИР БОЯ</small>{battle.events.slice(0,8).map(event => <p key={event.id}><time>{new Date(event.createdAt).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}</time>{event.text}</p>)}</div>
    </div>
  );
}

export const BattleScreen = memo(BattleScreenInner);
