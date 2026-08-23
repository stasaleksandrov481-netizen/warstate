"use client";

import { memo } from "react";
import { eloLeague } from "@/lib/elo";
import type { GameSnapshot } from "@/lib/types";

function IslandRankingInner({ snapshot }: { snapshot: GameSnapshot }) {
  const rows = snapshot.leaderboard;
  const mine = eloLeague(snapshot.state.rating);
  return (
    <div className="ranking-screen">
      <div className="ranking-hero">
        <small>МИРОВОЙ ELO</small>
        <h2>{mine.icon} {mine.label} · {snapshot.state.rating}</h2>
        <p>Победа над сильным соперником даёт больше очков. Поражение слабому снимает больше. Серии побед не увеличивают ELO напрямую, но становятся отдельным показателем престижа.</p>
      </div>
      <div className="league-strip">
        {[1000, 1200, 1500, 1800, 2100, 2450].map((rating) => {
          const league = eloLeague(rating);
          return <span key={league.key} className={league.key === mine.key ? "active" : ""}><i>{league.icon}</i><b>{league.label}</b><small>{league.floor}+</small></span>;
        })}
      </div>
      <div className="ranking-list">
        {rows.map((row) => {
          const league = eloLeague(row.rating);
          return (
            <article key={row.id} className={row.id === snapshot.state.id ? "mine" : ""}>
              <span className="ranking-pos">{row.rank}</span>
              <span className="ranking-emblem" style={{ background: row.color }}>{row.name.slice(0,1)}</span>
              <div><b>{row.name}</b><small>{league.icon} {league.label} · 👥 {row.memberCount.toLocaleString("ru-RU")}</small></div>
              <strong>{row.rating}</strong>
            </article>
          );
        })}
      </div>
      <div className="elo-explain">
        <b>Как работает ELO</b>
        <p>Рейтинг учитывает силу противника. Если остров с рейтингом 1200 побеждает остров 1800, награда будет заметно выше обычной. Разрушение острова не даёт отдельного бонуса ELO: рейтинг приходит именно за победу в бою.</p>
      </div>
    </div>
  );
}

export const IslandRanking = memo(IslandRankingInner);
