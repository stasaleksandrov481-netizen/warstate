"use client";

import { memo, useMemo, useState } from "react";
import { eloLeague } from "@/lib/elo";
import type { GameSnapshot } from "@/lib/types";

function IslandRankingInner({ snapshot }: { snapshot: GameSnapshot }) {
  const rows = snapshot.leaderboard;
  const mine = eloLeague(snapshot.state.rating);
  const [query, setQuery] = useState("");
  const mineRow = rows.find((row) => row.id === snapshot.state.id);
  const top = rows.slice(0, 3);
  const normalized = query.trim().toLocaleLowerCase("ru-RU");
  const filtered = useMemo(() => normalized ? rows.filter((row) => row.name.toLocaleLowerCase("ru-RU").includes(normalized)) : rows, [rows, normalized]);
  const podium = top.length === 3 ? [top[1], top[0], top[2]] : top;

  return (
    <div className="ranking-screen game-scene">
      <section className="ranking-hero ranking-hero-v2">
        <div><small>МИРОВОЙ ELO</small><h2>{mine.icon} {mine.label}</h2><p>Ваш рейтинг отражает силу соперников и результат реальных боёв.</p></div>
        <span className="ranking-my-rank"><small>МОЁ МЕСТО</small><b>#{mineRow?.rank || snapshot.state.seasonRank}</b><em>{snapshot.state.rating} ELO</em></span>
      </section>

      {podium.length > 0 && <section className="ranking-podium">{podium.map((row) => { const league = eloLeague(row.rating); return <article key={row.id} className={`podium-${row.rank} ${row.id === snapshot.state.id ? "mine" : ""}`}><i>{row.rank}</i><span style={{ background: row.color }}>{row.name.slice(0, 1)}</span><b>{row.name}</b><strong>{row.rating}</strong><small>{league.label}</small></article>; })}</section>}

      <div className="league-strip league-strip-v2">
        {[1000, 1200, 1500, 1800, 2100, 2450].map((rating) => {
          const league = eloLeague(rating);
          return <span key={league.key} className={league.key === mine.key ? "active" : ""}><i>{league.icon}</i><b>{league.label}</b><small>{league.floor}+</small></span>;
        })}
      </div>

      <label className="ranking-search"><span>⌕</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Найти государство" /></label>

      <div className="ranking-list ranking-list-v2">
        {filtered.length ? filtered.map((row) => {
          const league = eloLeague(row.rating);
          return (
            <article key={row.id} className={row.id === snapshot.state.id ? "mine" : ""}>
              <span className="ranking-pos">#{row.rank}</span>
              <span className="ranking-emblem" style={{ background: row.color }}>{row.name.slice(0,1)}</span>
              <div><b>{row.name}</b><small>{league.icon} {league.label} · {row.memberCount.toLocaleString("ru-RU")} участников</small></div>
              <strong>{row.rating}<small>ELO</small></strong>
            </article>
          );
        }) : <div className="ranking-empty">Такого государства в рейтинге нет.</div>}
      </div>

      <div className="elo-explain elo-explain-v2">
        <b>Как работает ELO</b>
        <p>Победа над более сильным государством приносит больше рейтинга. Поражение сопернику слабее стоит дороже. Серия побед отображается отдельно и не умножает ELO напрямую.</p>
      </div>
    </div>
  );
}

export const IslandRanking = memo(IslandRankingInner);
