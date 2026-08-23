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

function IslandAlliancesInner({ snapshot, onDiplomacy }: { snapshot: GameSnapshot; onDiplomacy: (id: string, action: DiplomacyAction) => void }) {
  return (
    <div className="alliances-screen">
      <div className="ranking-hero"><small>ДИПЛОМАТИЯ</small><h2>Отношения островов</h2><p>Союзные острова нельзя атаковать. Перемирие временно закрывает войну.</p></div>
      <div className="relations-list">
        {snapshot.diplomacy.length === 0 ? <div className="empty-state">У государства пока нет официальных отношений.</div> : snapshot.diplomacy.map((rel) => (
          <article key={rel.id}>
            <span className="relation-mark" style={{ background: rel.otherStateColor }}>{rel.otherStateName.slice(0, 1)}</span>
            <div><b>{rel.otherStateName}</b><small>{label(rel.status)}</small></div>
            <div className="relation-actions">
              {rel.status === "allied" && <button onClick={() => onDiplomacy(rel.otherStateId, "break_alliance")}>Разорвать</button>}
              {rel.status === "war" && <button onClick={() => onDiplomacy(rel.otherStateId, "offer_truce")}>Предложить мир</button>}
              {rel.status === "alliance_pending" && rel.requestedByStateId !== snapshot.state.id && <button onClick={() => onDiplomacy(rel.otherStateId, "accept_alliance")}>Принять</button>}
              {rel.status === "truce_pending" && rel.requestedByStateId !== snapshot.state.id && <button onClick={() => onDiplomacy(rel.otherStateId, "accept_truce")}>Принять</button>}
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}

export const IslandAlliances = memo(IslandAlliancesInner);
