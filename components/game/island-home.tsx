"use client";

import { memo } from "react";
import { eloLeague } from "@/lib/elo";
import type { BuildingType, GameSnapshot } from "@/lib/types";
import { IslandArt } from "@/components/game/island-art";

const INFRA: Record<BuildingType, { icon: string; label: string; desc: string }> = {
  hq: { icon: "⚑", label: "Штаб острова", desc: "Управление, защита и командование" },
  barracks: { icon: "⚔", label: "Гарнизон", desc: "Подготовка бойцов к морским атакам" },
  mine: { icon: "▰", label: "Карьер", desc: "Добыча стали для инфраструктуры" },
  refinery: { icon: "◈", label: "Топливный порт", desc: "Топливо для флота" },
  farm: { icon: "◆", label: "Фермы", desc: "Продовольствие государства" },
  lab: { icon: "⌁", label: "Радарный центр", desc: "Технологии и разведка" },
};

function IslandHomeInner({
  snapshot,
  onUpgrade,
  onRepair,
}: {
  snapshot: GameSnapshot;
  onUpgrade: (type: BuildingType) => void;
  onRepair: (amount?: number) => void;
}) {
  const state = snapshot.state;
  const destroyed = Boolean(state.destroyedUntil && new Date(state.destroyedUntil).getTime() > Date.now());
  const league = eloLeague(state.rating);
  const missingIntegrity = Math.max(0, 100 - state.islandIntegrity);
  const repairAmount = Math.min(25, missingIntegrity);
  const repairCredits = repairAmount * 24;
  const repairSteel = repairAmount * 3;
  const canRepair = !destroyed
    && repairAmount > 0
    && ["president", "minister"].includes(snapshot.player.role)
    && state.treasury.credits >= repairCredits
    && state.treasury.steel >= repairSteel;

  return (
    <div className="island-home-screen">
      <div className={`my-island-hero game-home-hero ${destroyed ? "ruined" : ""}`} style={{ ["--state-color" as any]: state.color }}>
        <div className="my-island-water" />
        <div className="home-island-art"><IslandArt id={state.id} members={state.memberCount} color={state.color} integrity={state.islandIntegrity} ruined={destroyed} /></div>
        <div className="my-island-identity">
          <span>{state.emblem}</span>
          <div><h2>{state.name}</h2><p>{state.motto}</p></div>
        </div>
        <div className="island-integrity-float">
          <span>ПРОЧНОСТЬ</span>
          <b>{state.islandIntegrity}%</b>
          <i><em style={{ width: `${state.islandIntegrity}%` }} /></i>
        </div>
      </div>

      <div className="island-kpi-grid">
        <article><small>ELO</small><b>{state.rating}</b><span>{league.icon} {league.label}</span></article>
        <article><small>Участники</small><b>{state.memberCount}</b><span>масштаб острова</span></article>
        <article><small>Серия</small><b>{state.winStreak}</b><span>рекорд {state.bestWinStreak}</span></article>
        <article><small>Место</small><b>#{state.seasonRank}</b><span>{state.islandWins}W · {state.islandLosses}L</span></article>
      </div>

      {destroyed ? (
        <div className="rebuild-card"><b>☠ Остров разрушен</b><p>Идёт аварийное восстановление. После выхода из руин остров вернётся с 55% прочности и защитным щитом, а остальное придётся ремонтировать из казны.</p></div>
      ) : state.islandIntegrity < 100 ? (
        <div className="repair-card">
          <div>
            <small>РЕМОНТ ОСТРОВА</small>
            <b>{state.islandIntegrity}% → {Math.min(100, state.islandIntegrity + repairAmount)}%</b>
            <span>Повреждённый остров производит меньше ресурсов.</span>
          </div>
          <button type="button" disabled={!canRepair} onClick={() => onRepair(repairAmount)}>
            Ремонт
            <small>{repairCredits} ₡ · {repairSteel} стали</small>
          </button>
        </div>
      ) : null}

      <section className="island-section">
        <div className="section-row"><div><small>ИНФРАСТРУКТУРА</small><h3>Развитие острова</h3></div><span>6 объектов</span></div>
        <div className="infra-grid">
          {snapshot.buildings.map((building) => {
            const meta = INFRA[building.type];
            const credits = building.upgradeCost.credits || 0;
            const steel = building.upgradeCost.steel || 0;
            const canUpgrade = state.treasury.credits >= credits && state.treasury.steel >= steel;
            return (
              <article className="infra-card" key={building.type}>
                <div className="infra-icon">{meta.icon}</div>
                <div className="infra-copy"><b>{meta.label}</b><small>{meta.desc}</small><span>ур. {building.level}</span></div>
                <button type="button" disabled={!canUpgrade} onClick={() => onUpgrade(building.type)}>
                  ↑ <small>{credits.toLocaleString("ru-RU")} ₡</small>
                </button>
              </article>
            );
          })}
        </div>
      </section>
    </div>
  );
}

export const IslandHome = memo(IslandHomeInner);
