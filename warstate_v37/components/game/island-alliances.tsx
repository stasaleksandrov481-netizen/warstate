"use client";

import { memo } from "react";
import type { DiplomacyAction, GameSnapshot } from "@/lib/types";

function label(status: string) {
  if (status === "allied") return "Союз";
  if (status === "war") return "Война";
  if (status === "truce") return "Перемирие";
  if (status === "alliance_pending") return "Предложение союза";
  if (status === "truce_pending") return "Предложение мира";
  return status;
}

function relationTone(status: string) {
  if (status === "allied") return "ally";
  if (status === "war") return "enemy";
  if (status === "truce") return "truce";
  return "pending";
}

function IslandAlliancesInner({ snapshot, onDiplomacy }: { snapshot: GameSnapshot; onDiplomacy: (id: string, action: DiplomacyAction) => void }) {
  const diplomacy = snapshot.diplomacy;
  const allied = diplomacy.filter((rel) => rel.status === "allied").length;
  const wars = diplomacy.filter((rel) => rel.status === "war").length;
  const truces = diplomacy.filter((rel) => rel.status === "truce").length;
  const incoming = diplomacy.filter((rel) => rel.status.endsWith("_pending") && rel.requestedByStateId !== snapshot.state.id);

  return (
    <div className="alliances-screen game-scene">
      <section className="ranking-hero diplomacy-hero-v2">
        <div><small>ДИПЛОМАТИЯ</small><h2>Международные отношения</h2><p>Союзы защищают от прямой атаки и открывают поддержку в боях. Перемирия временно блокируют новые войны.</p></div>
        <span className="diplomacy-score"><small>СВЯЗЕЙ</small><b>{diplomacy.length}</b></span>
      </section>

      <section className="diplomacy-kpis">
        <span className="ally"><small>СОЮЗЫ</small><b>{allied}</b><em>активных</em></span>
        <span className="enemy"><small>ВОЙНЫ</small><b>{wars}</b><em>открытых</em></span>
        <span className="truce"><small>МИР</small><b>{truces}</b><em>перемирий</em></span>
        <span className="pending"><small>ВХОДЯЩИЕ</small><b>{incoming.length}</b><em>решений</em></span>
      </section>

      {incoming.length > 0 && <section className="diplomacy-inbox"><div className="section-row"><div><small>ТРЕБУЮТ РЕШЕНИЯ</small><h3>Входящие предложения</h3></div><span>{incoming.length}</span></div>{incoming.map((rel) => <article key={rel.id} className={relationTone(rel.status)}><span className="relation-mark" style={{ background: rel.otherStateColor }}>{rel.otherStateName.slice(0, 1)}</span><div><b>{rel.otherStateName}</b>{rel.otherStateUsername && <em className="state-inline-handle">@{rel.otherStateUsername}</em>}<small>{label(rel.status)}</small></div><div className="relation-actions">{rel.status === "alliance_pending" && <button onClick={() => onDiplomacy(rel.otherStateId, "accept_alliance")}>Принять союз</button>}{rel.status === "truce_pending" && <button onClick={() => onDiplomacy(rel.otherStateId, "accept_truce")}>Принять мир</button>}</div></article>)}</section>}

      <section className="diplomacy-book">
        <div className="section-row"><div><small>КНИГА ОТНОШЕНИЙ</small><h3>Все государства</h3></div><span>{diplomacy.length}</span></div>
        <div className="relations-list relations-list-v2">
          {diplomacy.length === 0 ? <div className="empty-state diplomacy-empty"><i>◇</i><b>Пока нейтрально</b><span>У государства ещё нет официальных дипломатических отношений.</span></div> : diplomacy.map((rel) => (
            <article key={rel.id} className={relationTone(rel.status)}>
              <span className="relation-mark" style={{ background: rel.otherStateColor }}>{rel.otherStateName.slice(0, 1)}</span>
              <div><b>{rel.otherStateName}</b>{rel.otherStateUsername && <em className="state-inline-handle">@{rel.otherStateUsername}</em>}<small>{label(rel.status)}</small>{rel.truceUntil && rel.status === "truce" && <em>до {new Date(rel.truceUntil).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}</em>}</div>
              <div className="relation-actions">
                {rel.status === "allied" && <button onClick={() => onDiplomacy(rel.otherStateId, "break_alliance")}>Разорвать</button>}
                {rel.status === "war" && <button onClick={() => onDiplomacy(rel.otherStateId, "offer_truce")}>Предложить мир</button>}
                {rel.status === "alliance_pending" && rel.requestedByStateId !== snapshot.state.id && <button onClick={() => onDiplomacy(rel.otherStateId, "accept_alliance")}>Принять</button>}
                {rel.status === "truce_pending" && rel.requestedByStateId !== snapshot.state.id && <button onClick={() => onDiplomacy(rel.otherStateId, "accept_truce")}>Принять</button>}
              </div>
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}

export const IslandAlliances = memo(IslandAlliancesInner);
