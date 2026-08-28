"use client";

import { memo, useState } from "react";
import type { GameSnapshot } from "@/lib/types";

type Props = {
  snapshot: GameSnapshot;
  onActivity: (activityKey: string, optionKey: string) => void;
  onSupport: (battleId: string, side: "attacker" | "defender") => void;
  onSurrender: () => void;
};

type StrategyTab = "overview" | "activities" | "balance" | "contribution";

const SOURCE_LABEL: Record<string, string> = {
  activity: "Активность",
  battle: "Бой",
  support: "Помощь союзнику",
  building: "Стройка",
  defense: "Оборона",
  alliance: "Альянс",
  migration: "История",
};

const RESOURCE_META = [
  ["credits", "КАЗНА", "₡"],
  ["steel", "СТАЛЬ", "▰"],
  ["fuel", "ТОПЛИВО", "◈"],
  ["food", "ЕДА", "◆"],
  ["tech", "TECH", "⌁"],
] as const;

function StrategyPanelInner({ snapshot, onActivity, onSupport, onSurrender }: Props) {
  const { state, strategy, activeBattle } = snapshot;
  const [tab, setTab] = useState<StrategyTab>("overview");
  const remaining = Math.max(0, strategy.rules.maxDailyActivities - strategy.completedToday);
  const productionTotal = Object.values(state.productionPerHour).reduce((sum, value) => sum + value, 0);
  const battleSide = activeBattle ? (activeBattle.attackerStateId === state.id ? "Атака" : "Оборона") : null;

  return (
    <div className="strategy-screen game-scene">
      <section className="strategy-hero strategy-hero-v2">
        <div className="strategy-hero-main">
          <small>ГОСУДАРСТВЕННЫЙ ШТАБ</small>
          <h2>{state.name}</h2>
          <p>Армия, экономика, решения и прозрачный расчёт войны в одном центре.</p>
          <div className="strategy-health-row">
            <span><i style={{ width: `${state.islandIntegrity}%` }} /><b>{state.islandIntegrity}%</b><small>прочность государства</small></span>
            <span><b>{state.activePlayers}</b><small>активных игроков</small></span>
          </div>
        </div>
        <span className="strategy-level"><small>УРОВЕНЬ</small><b>{state.level}</b><em>/ {state.maxLevel}</em></span>
      </section>

      {state.isBeginnerIsland && <div className="beginner-banner"><b>Государство новичков</b><span>Атаки запрещены · максимум ур. 5 · безопасные активности · поддержка только обороны.</span></div>}

      <nav className="strategy-tabs" aria-label="Разделы штаба">
        {([
          ["overview", "Обзор"],
          ["activities", `Решения ${strategy.completedToday}/${strategy.rules.maxDailyActivities}`],
          ["balance", "Баланс"],
          ["contribution", "Вклад"],
        ] as Array<[StrategyTab, string]>).map(([key, label]) => <button type="button" key={key} className={tab === key ? "active" : ""} onClick={() => setTab(key)}>{label}</button>)}
      </nav>

      <div className="strategy-tab-stage" key={tab}>
      {tab === "overview" && (
        <>
          <section className="strategy-stat-grid strategy-stat-grid-v2">
            <article><small>РАЗМЕР</small><b>{state.stateSize.toFixed(2)}</b><span>{state.activePlayers} активных</span></article>
            <article><small>АРМИЯ</small><b>{state.armyPower}</b><span>боевая сила</span></article>
            <article><small>ОБОРОНА</small><b>{state.defensePower}</b><span>{state.islandIntegrity}% прочности</span></article>
            <article><small>ВЛИЯНИЕ</small><b>{state.influence.toLocaleString("ru-RU")}</b><span>репутация {state.reputation}</span></article>
          </section>

          <section className="strategy-card strategy-economy-card">
            <div className="strategy-title"><div><small>ЭКОНОМИКА</small><h3>Ресурсы государства</h3></div><b>+{productionTotal.toLocaleString("ru-RU")}/ч</b></div>
            <div className="strategy-resource-grid">
              {RESOURCE_META.map(([key, label, icon]) => <span key={key}><i>{icon}</i><small>{label}</small><b>{state.treasury[key].toLocaleString("ru-RU")}</b><em>+{state.productionPerHour[key].toLocaleString("ru-RU")}/ч</em></span>)}
            </div>
          </section>

          {activeBattle ? (
            <section className="strategy-card strategy-battle-card">
              <div className="strategy-title"><div><small>ТЕКУЩИЙ БОЙ · {battleSide} · {activeBattle.battleType.toUpperCase()}</small><h3>{activeBattle.attackerName} vs {activeBattle.defenderName}</h3></div><b>{activeBattle.attackerScore}:{activeBattle.defenderScore}</b></div>
              <div className="strategy-battle-progress"><i style={{ width: `${Math.max(8, Math.min(92, activeBattle.attackerScore / Math.max(1, activeBattle.attackerScore + activeBattle.defenderScore) * 100))}%` }} /></div>
              <div className="battle-math-grid compact">
                <span><small>АТАКА</small><b>{activeBattle.attackerFinalPower}</b></span>
                <span><small>ЗАЩИТА</small><b>{activeBattle.defenderFinalPower}</b></span>
                <span><small>КОНЕЦ</small><b>{new Date(activeBattle.endsAt).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}</b></span>
              </div>
              <button className="strategy-detail-link" type="button" onClick={() => setTab("balance")}>Показать формулу и коэффициенты</button>
              {["president", "minister", "deputy"].includes(snapshot.player.role) && activeBattle.status === "active" && <button className="danger-strategy" type="button" onClick={onSurrender}>Сдаться и завершить бой</button>}
            </section>
          ) : (
            <section className="strategy-card strategy-peace-card"><div className="strategy-peace-mark">◌</div><div><small>ВОЕННАЯ ОБСТАНОВКА</small><h3>Активных боёв нет</h3><p>Армия свободен. Для атаки выберите государство на мировой карте.</p></div></section>
          )}

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
        </>
      )}

      {tab === "activities" && (
        <section className="strategy-card strategy-activities-card">
          <div className="strategy-title"><div><small>ЕЖЕДНЕВНЫЕ РЕШЕНИЯ</small><h3>Активности</h3></div><b>{remaining} осталось</b></div>
          <p className="strategy-note">У каждого задания есть несколько решений с разным риском и наградой. Выполненное решение закрывается до следующего дня.</p>
          <div className="activity-day-progress"><i style={{ width: `${Math.min(100, strategy.completedToday / Math.max(1, strategy.rules.maxDailyActivities) * 100)}%` }} /></div>
          <div className="activity-list">
            {strategy.activities.map((activity, index) => (
              <article key={activity.key} className={activity.completed ? "activity-complete" : ""}>
                <div className="activity-copy"><span className="activity-index">{String(index + 1).padStart(2, "0")}</span><div><small>{activity.completed ? "ВЫПОЛНЕНО" : activity.key}</small><b>{activity.title}</b><p>{activity.description}</p></div></div>
                <div className="activity-options">
                  {activity.options.map((option) => (
                    <button key={option.key} type="button" disabled={activity.completed || remaining <= 0} onClick={() => onActivity(activity.key, option.key)}>
                      <b>{option.label}</b>
                      <small>риск {Math.round(option.risk * 100)}% · вклад +{option.rewards.contribution}</small>
                      <span>₡ {option.rewards.credits} · влияние {option.rewards.influence} · tech {option.rewards.tech}</span>
                    </button>
                  ))}
                </div>
              </article>
            ))}
          </div>
        </section>
      )}

      {tab === "balance" && (
        <>
          {activeBattle && (
            <section className="strategy-card strategy-battle-card">
              <div className="strategy-title"><div><small>РАСЧЁТ ТЕКУЩЕГО БОЯ</small><h3>{activeBattle.attackerName} vs {activeBattle.defenderName}</h3></div><b>{activeBattle.attackerScore}:{activeBattle.defenderScore}</b></div>
              <div className="battle-math-grid">
                <span><small>РАЗМЕР АТАКИ</small><b>{activeBattle.attackerStateSize.toFixed(2)}</b></span>
                <span><small>РАЗМЕР ЗАЩИТЫ</small><b>{activeBattle.defenderStateSize.toFixed(2)}</b></span>
                <span><small>ШТРАФ АТАКИ</small><b>−{Math.max(0, Math.round((1 - activeBattle.attackerSizeModifier) * 100))}%</b></span>
                <span><small>UNDERDOG</small><b>+{Math.round(activeBattle.underdogBonus * 100)}%</b></span>
                <span><small>БУФЕР</small><b>+{Math.round(activeBattle.defenseBufferPct * 100)}%</b></span>
                <span><small>УСТАЛОСТЬ</small><b>−{Math.round(activeBattle.aggressionPenalty * 100)}%</b></span>
              </div>
              <p className="strategy-formula">Сила до модификаторов: {activeBattle.attackerRawPower} / {activeBattle.defenderRawPower}. Расчётная: {activeBattle.attackerFinalPower} / {activeBattle.defenderFinalPower}. Случайные коэффициенты фиксируются при старте и не меняются внутри боя.</p>
            </section>
          )}
          <section className="strategy-card balance-rules">
            <div className="strategy-title"><div><small>ПРОЗРАЧНЫЙ БАЛАНС</small><h3>Глобальные ограничения</h3></div></div>
            <div className="rule-grid">
              <span><b>−{Math.round(strategy.rules.maxAttackSizePenalty * 100)}%</b><small>макс. штраф большому атакующему</small></span>
              <span><b>+{Math.round(strategy.rules.maxUnderdogBonus * 100)}%</b><small>макс. бонус слабой защите</small></span>
              <span><b>−{Math.round(strategy.rules.maxAggressionPenalty * 100)}%</b><small>макс. усталость агрессора</small></span>
              <span><b>+{Math.round(strategy.rules.maxAllianceSupport * 100)}%</b><small>лимит союзной поддержки</small></span>
              <span><b>{Math.round(strategy.rules.raidLootBudgetPct * 100)}%</b><small>макс. бюджет рейда до cap</small></span>
              <span><b>{Math.round(strategy.rules.raidLootInfluencePct * 100)}%</b><small>макс. влияние рейда до cap</small></span>
            </div>
          </section>
        </>
      )}

      {tab === "contribution" && (
        <section className="strategy-card contribution-card-v2">
          <div className="strategy-title"><div><small>ЛИЧНЫЙ ВКЛАД</small><h3>{snapshot.player.contribution.toLocaleString("ru-RU")}</h3></div><b>{strategy.contributionEvents.length} событий</b></div>
          <p className="strategy-note">Вклад показывает участие в жизни государства: решения, бои, строительство и союзная помощь.</p>
          <div className="contribution-feed contribution-feed-v2">{strategy.contributionEvents.length ? strategy.contributionEvents.map((event) => <span key={event.id}><b>+{event.amount}</b><small>{SOURCE_LABEL[event.source] || event.source}</small></span>) : <p>Вклад появится после первой активности, боя или помощи союзнику.</p>}</div>
        </section>
      )}
      </div>
    </div>
  );
}

export const StrategyPanel = memo(StrategyPanelInner);
