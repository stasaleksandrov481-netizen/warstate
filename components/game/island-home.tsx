"use client";

import { memo, useEffect, useState } from "react";
import { eloLeague } from "@/lib/elo";
import type { BuildingType, GameSnapshot, RecruitmentRequestView } from "@/lib/types";
import { IslandArt } from "@/components/game/island-art";

const INFRA: Record<BuildingType, { icon: string; label: string; desc: string }> = {
  hq: { icon: "⚑", label: "Штаб острова", desc: "Управление, защита и командование" },
  barracks: { icon: "⚔", label: "Гарнизон", desc: "Подготовка бойцов к морским атакам" },
  mine: { icon: "▰", label: "Карьер", desc: "Добыча стали для инфраструктуры" },
  refinery: { icon: "◈", label: "Топливный порт", desc: "Топливо для флота" },
  farm: { icon: "◆", label: "Фермы", desc: "Продовольствие государства" },
  lab: { icon: "⌁", label: "Радарный центр", desc: "Технологии и разведка" },
};

type RecruitmentAction = (action: string, payload?: Record<string, unknown>) => void;

function RequestCard({ request, onRecruitment, mine }: { request: RecruitmentRequestView; onRecruitment: RecruitmentAction; mine?: boolean }) {
  const accepted = request.status === "accepted" && request.inviteLink;
  return (
    <article className={`recruit-request status-${request.status}`}>
      <span className="recruit-avatar" style={{ background: request.stateColor }}>{request.stateName.slice(0, 1)}</span>
      <div>
        <b>{mine ? request.stateName : request.playerName}</b>
        <small>{mine ? `${request.kind === "offer" ? "Предложение государства" : "Ваша заявка"} · ${request.status}` : `ур. ${request.playerLevel} · ${request.playerXp} XP · ${request.kind === "offer" ? "оффер" : "заявка"}`}</small>
        {request.message && <p>{request.message}</p>}
      </div>
      {accepted ? (
        <a className="recruit-join" href={request.inviteLink || "#"} target="_blank" rel="noreferrer">ВСТУПИТЬ</a>
      ) : mine && request.status === "pending" && request.kind === "offer" ? (
        <div className="recruit-actions"><button onClick={() => onRecruitment("accept_offer", { requestId: request.id })}>Принять</button><button className="soft" onClick={() => onRecruitment("reject", { requestId: request.id })}>Нет</button></div>
      ) : mine && request.status === "pending" ? (
        <button className="recruit-small" onClick={() => onRecruitment("withdraw", { requestId: request.id })}>Отозвать</button>
      ) : !mine && request.status === "pending" && request.kind === "application" ? (
        <div className="recruit-actions"><button onClick={() => onRecruitment("accept_application", { requestId: request.id })}>Принять</button><button className="soft" onClick={() => onRecruitment("reject", { requestId: request.id })}>Отказать</button></div>
      ) : null}
    </article>
  );
}

function FreeportHome({ snapshot, onRecruitment }: { snapshot: GameSnapshot; onRecruitment: RecruitmentAction }) {
  const [noteByState, setNoteByState] = useState<Record<string, string>>({});
  const player = snapshot.player;
  const recruitment = snapshot.recruitment;
  return (
    <div className="island-home-screen freeport-screen">
      <div className="freeport-hero" style={{ ["--state-color" as any]: snapshot.state.color }}>
        <div className="freeport-sea" />
        <div className="freeport-island-art"><IslandArt id={snapshot.state.id} members={snapshot.state.memberCount} color={snapshot.state.color} integrity={100} selected detail="near" freeport /></div>
        <div className="freeport-title"><small>НЕЙТРАЛЬНАЯ ГАВАНЬ</small><h2>Freeport</h2><p>Начни один. Прокачай профиль. Найди государство.</p></div>
        <div className="freeport-player-card"><span>УР. {player.level}</span><b>{player.displayName}</b><small>{player.xp.toLocaleString("ru-RU")} XP · свободный игрок</small></div>
      </div>

      <section className="freeport-guide">
        <article><b>1</b><div><strong>Развивай профиль</strong><small>Ежедневные задания и участие в событиях дают XP.</small></div></article>
        <article><b>2</b><div><strong>Выбери государство</strong><small>Открытые острова публикуют набор прямо в Freeport.</small></div></article>
        <article><b>3</b><div><strong>Вступи в Telegram-группу</strong><small>После принятия получишь одноразовую ссылку от бота.</small></div></article>
      </section>

      {recruitment.myRequests.length > 0 && (
        <section className="island-section recruitment-section">
          <div className="section-row"><div><small>МОИ ЗАЯВКИ И ПРЕДЛОЖЕНИЯ</small><h3>Вербовка</h3></div><span>{recruitment.myRequests.length}</span></div>
          <div className="recruit-list">{recruitment.myRequests.map((request) => <RequestCard key={request.id} request={request} onRecruitment={onRecruitment} mine />)}</div>
        </section>
      )}

      <section className="island-section recruitment-section">
        <div className="section-row"><div><small>ОТКРЫТЫЙ НАБОР</small><h3>Найти государство</h3></div><span>{recruitment.listings.length}</span></div>
        <div className="recruit-list">
          {recruitment.listings.length ? recruitment.listings.map((post) => {
            const alreadyPending = recruitment.myRequests.some((request) => request.stateId === post.stateId && request.status === "pending");
            return (
              <article className="recruit-post" key={post.stateId} style={{ ["--recruit-color" as any]: post.stateColor }}>
                <div className="recruit-state-mark" style={{ background: post.stateColor }}>{post.stateName.slice(0, 1)}</div>
                <div className="recruit-post-copy"><small>{post.memberCount.toLocaleString("ru-RU")} участников · {post.rating} ELO</small><b>{post.stateName}</b><strong>{post.headline}</strong>{post.message && <p>{post.message}</p>}<em>минимум ур. {post.minLevel}</em></div>
                <textarea value={noteByState[post.stateId] || ""} onChange={(event) => setNoteByState((current) => ({ ...current, [post.stateId]: event.target.value }))} placeholder="Коротко о себе" maxLength={180} />
                <button type="button" disabled={alreadyPending || player.level < post.minLevel} onClick={() => onRecruitment("apply", { targetStateId: post.stateId, message: noteByState[post.stateId] || "" })}>{alreadyPending ? "Заявка отправлена" : player.level < post.minLevel ? `Нужен ур. ${post.minLevel}` : "Подать заявку"}</button>
              </article>
            );
          }) : <div className="recruit-empty">Сейчас открытых наборов нет. Зайди позже или создай своё государство через Telegram-группу.</div>}
        </div>
      </section>
    </div>
  );
}

type IslandHomeProps = {
  snapshot: GameSnapshot;
  onUpgrade: (type: BuildingType) => void;
  onRepair: (amount?: number) => void;
  onRecruitment: RecruitmentAction;
};

function StateIslandHome({ snapshot, onUpgrade, onRepair, onRecruitment }: IslandHomeProps) {
  const state = snapshot.state;
  const [now, setNow] = useState(() => Date.now());
  const [headline, setHeadline] = useState(snapshot.recruitment.post?.headline || "Набор открыт");
  const [message, setMessage] = useState(snapshot.recruitment.post?.message || "");
  const [minLevel, setMinLevel] = useState(snapshot.recruitment.post?.minLevel || 1);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  const destroyed = Boolean(state.destroyedUntil && new Date(state.destroyedUntil).getTime() > now);
  const league = eloLeague(state.rating);
  const canManage = ["president", "minister"].includes(snapshot.player.role);
  const canRecruit = ["president", "minister", "general"].includes(snapshot.player.role);
  const missingIntegrity = Math.max(0, 100 - state.islandIntegrity);
  const repairAmount = Math.min(25, missingIntegrity);
  const repairCredits = repairAmount * 24;
  const repairSteel = repairAmount * 3;
  const canRepair = !destroyed && repairAmount > 0 && canManage && state.treasury.credits >= repairCredits && state.treasury.steel >= repairSteel;

  return (
    <div className="island-home-screen">
      <div className={`my-island-hero game-home-hero ${destroyed ? "ruined" : ""}`} style={{ ["--state-color" as any]: state.color }}>
        <div className="my-island-water" />
        <div className="home-island-art"><IslandArt id={state.id} members={state.memberCount} color={state.color} integrity={state.islandIntegrity} ruined={destroyed} selected detail="near" /></div>
        <div className="my-island-identity"><span>{state.emblem}</span><div><small>МОЯ СТОЛИЦА</small><h2>{state.name}</h2><p>{state.motto}</p></div></div>
        <div className="island-integrity-float"><span>ОБОРОНА</span><b>{state.islandIntegrity}%</b><i><em style={{ width: `${state.islandIntegrity}%` }} /></i></div>
      </div>

      <div className="island-command-strip">
        <span><small>ЛИГА</small><b>{league.icon} {league.label}</b><em>{state.rating} ELO</em></span>
        <span><small>НАСЕЛЕНИЕ</small><b>{state.memberCount.toLocaleString("ru-RU")}</b><em>{state.memberCount.toLocaleString("ru-RU")} домов</em></span>
        <span><small>СЕРИЯ</small><b>×{state.winStreak}</b><em>рекорд ×{state.bestWinStreak}</em></span>
        <span><small>МИР</small><b>#{state.seasonRank}</b><em>{state.islandWins}W · {state.islandLosses}L</em></span>
      </div>

      {destroyed ? <div className="rebuild-card"><b>☠ Остров разрушен</b><p>Идёт аварийное восстановление. После выхода из руин остров вернётся с базовой прочностью и щитом.</p></div> : state.islandIntegrity < 100 ? (
        <div className="repair-card"><div><small>РЕМОНТ ОСТРОВА</small><b>{state.islandIntegrity}% → {Math.min(100, state.islandIntegrity + repairAmount)}%</b><span>Повреждения снижают производство.</span></div><button type="button" disabled={!canRepair} onClick={() => onRepair(repairAmount)}>Ремонт<small>{repairCredits} ₡ · {repairSteel} стали</small></button></div>
      ) : null}

      <section className="island-section">
        <div className="section-row"><div><small>ИНФРАСТРУКТУРА</small><h3>Развитие острова</h3></div><span>{state.memberCount.toLocaleString("ru-RU")} жилых домов</span></div>
        <div className="infra-grid">
          {snapshot.buildings.map((building) => {
            const meta = INFRA[building.type];
            const credits = building.upgradeCost.credits || 0;
            const steel = building.upgradeCost.steel || 0;
            const canUpgrade = canManage && !destroyed && building.level < 12 && state.treasury.credits >= credits && state.treasury.steel >= steel;
            return <article className={`infra-card infra-${building.type}`} key={building.type}><div className="infra-icon">{meta.icon}</div><div className="infra-copy"><b>{meta.label}</b><small>{meta.desc}</small><span className="infra-level">ур. {building.level}<i>{Array.from({ length: Math.min(5, Math.max(1, Math.ceil(building.level / 2))) }, (_, i) => <em key={i} />)}</i></span></div><button type="button" disabled={!canUpgrade} onClick={() => onUpgrade(building.type)}>{building.level >= 12 ? "MAX" : "↑"}<small>{building.level >= 12 ? "уровень" : `${credits.toLocaleString("ru-RU")} ₡`}</small></button></article>;
          })}
        </div>
      </section>

      {canRecruit && (
        <section className="island-section recruitment-section state-recruitment">
          <div className="section-row"><div><small>КАДРОВЫЙ ПОРТ</small><h3>Набор из Freeport</h3></div><span>{snapshot.recruitment.incoming.length} входящих</span></div>
          <div className="recruit-editor">
            <input value={headline} onChange={(e) => setHeadline(e.target.value)} maxLength={48} placeholder="Заголовок набора" />
            <textarea value={message} onChange={(e) => setMessage(e.target.value)} maxLength={220} placeholder="Кого ищете и что предлагаете" />
            <label>Минимальный уровень <input type="number" min={1} max={1000} value={minLevel} onChange={(e) => setMinLevel(Math.max(1, Number(e.target.value) || 1))} /></label>
            <div><button onClick={() => onRecruitment("set_post", { headline, message, minLevel })}>Открыть / обновить набор</button>{snapshot.recruitment.post && <button className="soft" onClick={() => onRecruitment("close_post")}>Закрыть</button>}</div>
          </div>

          {snapshot.recruitment.incoming.length > 0 && <div className="recruit-list"><h4>Заявки</h4>{snapshot.recruitment.incoming.map((request) => <RequestCard key={request.id} request={request} onRecruitment={onRecruitment} />)}</div>}

          {snapshot.recruitment.freeAgents.length > 0 && <div className="free-agent-list"><h4>Свободные игроки</h4>{snapshot.recruitment.freeAgents.slice(0, 12).map((agent) => <article key={agent.playerId}><span>{agent.displayName.slice(0, 1)}</span><div><b>{agent.displayName}</b><small>ур. {agent.level} · {agent.xp} XP</small></div><button onClick={() => onRecruitment("offer", { targetPlayerId: agent.playerId, message: `Приглашение от ${state.name}` })}>Позвать</button></article>)}</div>}
        </section>
      )}
    </div>
  );
}

function IslandHomeInner(props: IslandHomeProps) {
  return props.snapshot.state.isFreeport
    ? <FreeportHome snapshot={props.snapshot} onRecruitment={props.onRecruitment} />
    : <StateIslandHome {...props} />;
}

export const IslandHome = memo(IslandHomeInner);
