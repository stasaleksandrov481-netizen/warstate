"use client";

import { memo } from "react";
import type { GameSnapshot } from "@/lib/types";

type Props = {
  snapshot: GameSnapshot;
  onActivity: (activityKey: string, optionKey: string) => void;
  onSupport: (battleId: string, side: "attacker" | "defender") => void;
  onSurrender: () => void;
};

const SOURCE_LABEL: Record<string, string> = {
  activity: "Активность",
  battle: "Бой",
  support: "Помощь союзнику",
  building: "Стройка",
  defense: "Оборона",
  alliance: "Альянс",
  migration: "История",
};

function StrategyPanelInner({ snapshot, onActivity, onSupport, onSurrender }: Props) {
  const { state, strategy, activeBattle } = snapshot;
  const remaining = Math.max(0, strategy.rules.maxDailyActivities - strategy.completedToday);
  return (
    <div className="strategy-screen game-scene">
      <section className="strategy-hero">
        <div><small>ГОСУДАРСТВЕННЫЙ ШТАБ</small><h2>{state.name}</h2><p>Единая панель экономики, армии, активности и прозрачного баланса.</p></div>
        <span className="strategy-level"><small>УРОВЕНЬ</small><b>{state.level}</b><em>/ {state.maxLevel}</em></span>
      </section>

      {state.isBeginnerIsland && <div className="beginner-banner"><b>Остров новичков</b><span>Атаки запрещены · максимум ур. 5 · безопасные активности · поддержка только обороны.</span></div>}

      <section className="strategy-stat-grid">
        <article><small>РАЗМЕР</small><b>{state.stateSize.toFixed(2)}</b><span>{state.activePlayers} активных</span></article>
        <article><small>АРМИЯ</small><b>{state.armyPower}</b><span>боевая сила</span></article>
        <article><small>ОБОРОНА</small><b>{state.defensePower}</b><span>{state.islandIntegrity}% прочности</span></article>
        <article><small>ВЛИЯНИЕ</small><b>{state.influence.toLocaleString("ru-RU")}</b><span>репутация {state.reputation}</span></article>
      </section>

      {activeBattle && (
        <section className="strategy-card strategy-battle-card">
          <div className="strategy-title"><div><small>ТЕКУЩИЙ БОЙ · {activeBattle.battleType.toUpperCase()} · до {new Date(activeBattle.endsAt).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}</small><h3>{activeBattle.attackerName} vs {activeBattle.defenderName}</h3></div><b>{activeBattle.attackerScore}:{activeBattle.defenderScore}</b></div>
          <div className="battle-math-grid">
            <span><small>РАЗМЕР АТАКИ</small><b>{activeBattle.attackerStateSize.toFixed(2)}</b></span>
            <span><small>РАЗМЕР ЗАЩИТЫ</small><b>{activeBattle.defenderStateSize.toFixed(2)}</b></span>
            <span><small>ШТРАФ АТАКИ</small><b>−{Math.max(0, Math.round((1 - activeBattle.attackerSizeModifier) * 100))}%</b></span>
            <span><small>UNDERDOG</small><b>+{Math.round(activeBattle.underdogBonus * 100)}%</b></span>
            <span><small>БУФЕР</small><b>+{Math.round(activeBattle.defenseBufferPct * 100)}%</b></span>
            <span><small>УСТАЛОСТЬ</small><b>−{Math.round(activeBattle.aggressionPenalty * 100)}%</b></span>
          </div>
          <p className="strategy-formula">Сила до модификаторов: {activeBattle.attackerRawPower} / {activeBattle.defenderRawPower}. Расчётная: {activeBattle.attackerFinalPower} / {activeBattle.defenderFinalPower}. Случайные коэффициенты фиксируются в записи боя и не меняются после старта.</p>
          {["president", "minister", "deputy"].includes(snapshot.player.role) && activeBattle.status === "active" && <button className="danger-strategy" type="button" onClick={onSurrender}>Сдаться и завершить бой</button>}
        </section>
      )}

      <section className="strategy-card">
        <div className="strategy-title"><div><small>ЕЖЕДНЕВНЫЕ РЕШЕНИЯ</small><h3>Активности</h3></div><b>{strategy.completedToday}/{strategy.rules.maxDailyActivities}</b></div>
        <p className="strategy-note">Это не кликер. У каждого задания есть варианты с разным риском и последствиями. Осталось решений сегодня: {remaining}.</p>
        <div className="activity-list">
          {strategy.activities.map((activity) => (
            <article key={activity.key} className={activity.completed ? "activity-complete" : ""}>
              <div><small>{activity.completed ? "ВЫПОЛНЕНО" : activity.key}</small><b>{activity.title}</b><p>{activity.description}</p></div>
              <div className="activity-options">
                {activity.options.map((option) => (
                  <button key={option.key} type="button" disabled={activity.completed || remaining <= 0} onClick={() => onActivity(activity.key, option.key)}>
                    <b>{option.label}</b>
                    <small>риск {Math.round(option.risk * 100)}% · +{option.rewards.contribution} вклад</small>
                    <span>₡ {option.rewards.credits} · влияние {option.rewards.influence} · tech {option.rewards.tech}</span>
                  </button>
                ))}
              </div>
            </article>
          ))}
        </div>
      </section>

      {strategy.supportableBattles.length > 0 && (
        <section className="strategy-card">
          <div className="strategy-title"><div><small>АЛЬЯНС</small><h3>Запросы поддержки</h3></div><b>{strategy.supportableBattles.length}</b></div>
          <div className="support-list">
            {strategy.supportableBattles.map((battle) => (
              <article key={battle.id}><div><small>{battle.battleType.toUpperCase()} · {battle.side === "defender" ? "ОБОРОНА" : "АТАКА"}</small><b>{battle.allyName}</b><span>против {battle.enemyName}</span></div><button type="button" disabled={!strategy.canManage || (state.isBeginnerIsland && battle.side === "attacker")} onClick={() => onSupport(battle.id, battle.side)}>Поддержать</button></article>
            ))}
          </div>
        </section>
      )}

      <section className="strategy-card balance-rules">
        <div className="strategy-title"><div><small>ПРОЗРАЧНЫЙ БАЛАНС</small><h3>Правила войны</h3></div></div>
        <div className="rule-grid">
          <span><b>−{Math.round(strategy.rules.maxAttackSizePenalty * 100)}%</b><small>макс. штраф большому атакующему</small></span>
          <span><b>+{Math.round(strategy.rules.maxUnderdogBonus * 100)}%</b><small>макс. бонус слабой защите</small></span>
          <span><b>−{Math.round(strategy.rules.maxAggressionPenalty * 100)}%</b><small>макс. усталость агрессора</small></span>
          <span><b>+{Math.round(strategy.rules.maxAllianceSupport * 100)}%</b><small>лимит союзной поддержки</small></span>
          <span><b>{Math.round(strategy.rules.raidLootBudgetPct * 100)}%</b><small>макс. бюджет рейда до cap</small></span>
          <span><b>{Math.round(strategy.rules.raidLootInfluencePct * 100)}%</b><small>макс. влияние рейда до cap</small></span>
        </div>
      </section>

      <section className="strategy-card">
        <div className="strategy-title"><div><small>ЛИЧНЫЙ ВКЛАД</small><h3>{snapshot.player.contribution.toLocaleString("ru-RU")}</h3></div></div>
        <div className="contribution-feed">{strategy.contributionEvents.length ? strategy.contributionEvents.map((event) => <span key={event.id}><b>+{event.amount}</b><small>{SOURCE_LABEL[event.source] || event.source}</small></span>) : <p>Вклад появится после первой активности, боя или помощи союзнику.</p>}</div>
      </section>
    </div>
  );
}

export const StrategyPanel = memo(StrategyPanelInner);
