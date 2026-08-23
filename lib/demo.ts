import type { BattleClass, BattlePoint, BattleView, BuildingType, DiplomacyAction, DiplomacyStatus, GameSnapshot, IslandView, MissionKey, PlayerView } from "@/lib/types";

const BUILDINGS: Array<{ type: BuildingType; label: string; description: string; x: number; y: number }> = [
  { type: "hq", label: "Штаб", description: "Управление государством", x: 50, y: 36 },
  { type: "barracks", label: "Казармы", description: "Сила атакующей армии", x: 31, y: 53 },
  { type: "mine", label: "Шахта", description: "Производство стали", x: 69, y: 56 },
  { type: "refinery", label: "НПЗ", description: "Производство топлива", x: 76, y: 30 },
  { type: "farm", label: "Ферма", description: "Продовольствие", x: 22, y: 27 },
  { type: "lab", label: "Лаборатория", description: "Технологии", x: 52, y: 67 },
];

const DEMO_ISLANDS: IslandView[] = [
  { id:"demo-state",name:"MEMEX COMMUNITY",color:"#5e73ff",emblem:"◈",worldX:0,worldY:0,memberCount:248,rating:1840,rank:2,wins:18,losses:7,integrity:86,winStreak:3,lastBattleAt:new Date(Date.now()-90*60_000).toISOString(),isMine:true,avatarUrl:null },
  { id:"alpha-state",name:"ALPHA SQUAD",color:"#8b45ff",emblem:"A",worldX:340,worldY:-260,memberCount:512,rating:2314,rank:1,wins:31,losses:9,integrity:100,winStreak:5,lastBattleAt:new Date(Date.now()-45*60_000).toISOString(),isMine:false,avatarUrl:null },
  { id:"enemy-state",name:"VOID LEGION",color:"#ef495d",emblem:"V",worldX:370,worldY:290,memberCount:238,rating:1775,rank:3,wins:14,losses:12,integrity:63,winStreak:0,lastBattleAt:new Date(Date.now()-20*60_000).toISOString(),isMine:false,avatarUrl:null,relation:"war" },
  { id:"north-state",name:"NORTH UNION",color:"#43c0ff",emblem:"N",worldX:-350,worldY:260,memberCount:312,rating:1690,rank:4,wins:12,losses:8,integrity:100,winStreak:2,lastBattleAt:new Date(Date.now()-3*60*60_000).toISOString(),isMine:false,avatarUrl:null,relation:"allied" },
  { id:"neon-state",name:"NEON DISTRICT",color:"#53e6a6",emblem:"N",worldX:-380,worldY:-280,memberCount:154,rating:1512,rank:5,wins:8,losses:11,integrity:74,winStreak:1,lastBattleAt:new Date(Date.now()-7*60*60_000).toISOString(),isMine:false,avatarUrl:null },
  { id:"ruins-state",name:"DARK LEGENDS",color:"#7d8796",emblem:"D",worldX:80,worldY:560,memberCount:86,rating:1320,rank:6,wins:4,losses:18,integrity:0,winStreak:0,lastBattleAt:new Date(Date.now()-35*60_000).toISOString(),isMine:false,avatarUrl:null,destroyedUntil:new Date(Date.now()+75*60_000).toISOString() },
];

export function createDemoSnapshot(): GameSnapshot {
  return {
    mode: "demo",
    player: {
      id: "demo-player",
      telegramId: 777000,
      displayName: "Konstantin",
      username: "demo",
      level: 7,
      xp: 2840,
      energy: 92,
      contribution: 1280,
      role: "president",
    },
    state: {
      id: "demo-state",
      name: "MEMEX COMMUNITY",
      color: "#9b7cff",
      motto: "Сначала строим. Потом забираем карту.",
      emblem: "◈",
      theme: "violet",
      telegramChatId: -100123456789,
      treasury: { credits: 8240, steel: 1920, fuel: 860, food: 2410, tech: 186 },
      productionPerHour: { credits: 510, steel: 310, fuel: 172, food: 360, tech: 44 },
      rating: 1840,
      memberCount: 248,
      territoryCount: 1,
      seasonRank: 2,
      worldX: 0,
      worldY: 0,
      islandWins: 18,
      islandLosses: 7,
      ratingPeak: 1922,
      islandIntegrity: 86,
      winStreak: 3,
      bestWinStreak: 7,
      lastBattleAt: new Date(Date.now()-90*60_000).toISOString(),
      destroyedUntil: null,
      avatarUrl: null,
      shieldUntil: null,
      nextAttackAt: null,
    },
    buildings: BUILDINGS.map((b, index) => ({
      ...b,
      level: index === 0 ? 3 : index < 3 ? 2 : 1,
      upgradeCost: { credits: 900 + index * 220, steel: 160 + index * 50 },
    })),
    tiles: [],
    wars: [],
    diplomacy: [
      { id: "rel-void", otherStateId: "enemy-state", otherStateName: "VOID LEGION", otherStateColor: "#ff5267", status: "war", requestedByStateId: "demo-state", updatedAt: new Date(Date.now()-45*60_000).toISOString() },
      { id: "rel-north", otherStateId: "north-state", otherStateName: "NORTH UNION", otherStateColor: "#55c9ff", status: "allied", requestedByStateId: null, updatedAt: new Date(Date.now()-3*60*60_000).toISOString() },
    ],
    worldFeed: [
      { id: 5, kind: "island_damaged", title: "Успешный рейд", text: "MEMEX COMMUNITY выиграл морскую операцию против VOID LEGION и повредил остров.", actorStateId: "demo-state", actorStateName: "MEMEX COMMUNITY", actorStateColor: "#9b7cff", targetStateId: "enemy-state", targetStateName: "VOID LEGION", targetStateColor: "#ff5267", createdAt: new Date(Date.now()-36*60_000).toISOString() },
      { id: 4, kind: "alliance", title: "Новый альянс", text: "MEMEX COMMUNITY и NORTH UNION заключили союз.", actorStateId: "demo-state", actorStateName: "MEMEX COMMUNITY", actorStateColor: "#9b7cff", targetStateId: "north-state", targetStateName: "NORTH UNION", targetStateColor: "#55c9ff", createdAt: new Date(Date.now()-3*60*60_000).toISOString() },
      { id: 3, kind: "war_declared", title: "Объявлена война", text: "VOID LEGION объявил войну NEON DISTRICT.", actorStateId: "enemy-state", actorStateName: "VOID LEGION", actorStateColor: "#ff5267", targetStateId: "neon-state", targetStateName: "NEON DISTRICT", targetStateColor: "#53e6a6", createdAt: new Date(Date.now()-5*60*60_000).toISOString() },
    ],
    dailyMissions: [
      { id: "demo-mission-checkin", key: "check_in", title: "На связи", description: "Открой GROUP WARS сегодня", progress: 1, target: 1, rewardXp: 80, rewardCredits: 300, claimed: false },
      { id: "demo-mission-join", key: "join_battle", title: "Мобилизация", description: "Войди хотя бы в одну битву", progress: 0, target: 1, rewardXp: 140, rewardCredits: 450, claimed: false },
      { id: "demo-mission-actions", key: "battle_action", title: "На передовой", description: "Совершите 5 действий в бою", progress: 0, target: 5, rewardXp: 180, rewardCredits: 600, claimed: false },
      { id: "demo-mission-capture", key: "capture_point", title: "Захватчик", description: "Захвати одну точку A/B/C", progress: 0, target: 1, rewardXp: 220, rewardCredits: 800, claimed: false },
    ],
    season: {
      id: "demo-season-1", name: "Founders Season", number: 1,
      startsAt: new Date(Date.now()-8*24*60*60_000).toISOString(),
      endsAt: new Date(Date.now()+20*24*60*60_000).toISOString(), active: true,
    },
    election: {
      id: "demo-election", status: "open",
      startsAt: new Date(Date.now()-2*60*60_000).toISOString(),
      endsAt: new Date(Date.now()+22*60*60_000).toISOString(),
      myVoteCandidateId: null, winnerPlayerId: null,
      candidates: [
        { id:"cand-me",playerId:"demo-player",displayName:"Konstantin",statement:"Качаем флот, инфраструктуру и рейтинг острова.",votes:84,isMe:true },
        { id:"cand-max",playerId:"ally-1",displayName:"Max",statement:"Больше дипломатии, меньше бессмысленных войн.",votes:61,isMe:false },
      ],
    },
    badges: [
      { id:"badge-1",key:"rating_1500",title:"На мировой сцене",description:"Достичь рейтинга 1500",icon:"★",earnedAt:new Date(Date.now()-2*24*60*60_000).toISOString() },
      { id:"badge-2",key:"island_wins_5",title:"Морские волки",description:"Победить в 5 островных войнах",icon:"☠",earnedAt:new Date(Date.now()-5*24*60*60_000).toISOString() },
    ],
    leaderboard: [
      { id: "alpha-state", name: "ALPHA SQUAD", color: "#8b45ff", rating: 2314, rank: 1, memberCount: 512 },
      { id: "demo-state", name: "MEMEX COMMUNITY", color: "#5e73ff", rating: 1840, rank: 2, memberCount: 248 },
      { id: "enemy-state", name: "VOID LEGION", color: "#ef495d", rating: 1775, rank: 3, memberCount: 238 },
      { id: "north-state", name: "NORTH UNION", color: "#43c0ff", rating: 1690, rank: 4, memberCount: 312 },
    ],
    islands: DEMO_ISLANDS,
    startParam: "gw_-100123456789",
  };
}

const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, -1], [-1, 1]];

export function demoUpgrade(snapshot: GameSnapshot, type: BuildingType): GameSnapshot {
  const building = snapshot.buildings.find((b) => b.type === type);
  if (!building) return snapshot;
  const credits = building.upgradeCost.credits || 0;
  const steel = building.upgradeCost.steel || 0;
  if (snapshot.state.treasury.credits < credits || snapshot.state.treasury.steel < steel) return snapshot;
  return {
    ...snapshot,
    state: {
      ...snapshot.state,
      treasury: {
        ...snapshot.state.treasury,
        credits: snapshot.state.treasury.credits - credits,
        steel: snapshot.state.treasury.steel - steel,
      },
    },
    buildings: snapshot.buildings.map((b) =>
      b.type === type
        ? {
            ...b,
            level: b.level + 1,
            upgradeCost: {
              credits: Math.round((b.upgradeCost.credits || 900) * 1.65),
              steel: Math.round((b.upgradeCost.steel || 160) * 1.65),
            },
          }
        : b,
    ),
  };
}

export function demoAttack(snapshot: GameSnapshot, tileId: string) {
  const target = snapshot.tiles.find((t) => t.id === tileId);
  if (!target || target.ownerStateId === snapshot.state.id || snapshot.activeBattle) return { snapshot, result: null };
  const own = snapshot.tiles.filter((t) => t.ownerStateId === snapshot.state.id);
  const adjacent = own.some((o) => DIRS.some(([dq, dr]) => o.q + dq === target.q && o.r + dr === target.r));
  if (!adjacent || snapshot.state.treasury.fuel < 120 || snapshot.state.treasury.food < 80) return { snapshot, result: null };
  const now = Date.now();
  const battle: BattleView = {
    id: `demo-battle-${now}`,
    tileId,
    battleKind: "territory",
    attackerStateId: snapshot.state.id,
    defenderStateId: target.ownerStateId,
    attackerName: snapshot.state.name,
    defenderName: target.ownerName || "Нейтральный гарнизон",
    attackerColor: snapshot.state.color,
    defenderColor: target.ownerColor || "#ff5267",
    status: "active",
    startsAt: new Date(now).toISOString(),
    endsAt: new Date(now + 180_000).toISOString(),
    attackerScore: 0,
    defenderScore: 0,
    pointOwners: { A: "attacker", B: null, C: "defender" },
    myTeam: "attacker",
    myRole: snapshot.player.role,
    me: null,
    orders: [],
    players: [
      { id:"bot-1",playerId:"bot-1",displayName:"Raven",team:"defender",class:"assault",hp:100,point:"C",kills:0,deaths:0,contribution:0,squadCode:"OMEGA" },
      { id:"bot-2",playerId:"bot-2",displayName:"Volt",team:"defender",class:"engineer",hp:100,point:"C",kills:0,deaths:0,contribution:0,squadCode:"OMEGA" },
      { id:"ally-1",playerId:"ally-1",displayName:"Max",team:"attacker",class:"medic",hp:100,point:"A",kills:0,deaths:0,contribution:0,squadCode:"ALPHA" },
    ],
    events: [{ id: now, type:"join", text:"Операция началась. Захватите A/B/C.", createdAt:new Date(now).toISOString() }],
  };
  return {
    snapshot: {
      ...snapshot,
      state: { ...snapshot.state, nextAttackAt: new Date(now + 60_000).toISOString(), treasury: { ...snapshot.state.treasury, fuel: snapshot.state.treasury.fuel - 120, food: snapshot.state.treasury.food - 80 } },
      activeBattle: battle,
    },
    result: { started: true },
  };
}

export function demoBattleAction(battle: BattleView, action: string, payload: any, player: PlayerView): BattleView {
  const copy: BattleView = JSON.parse(JSON.stringify(battle));
  const event = (text: string) => copy.events.unshift({ id: Date.now() + Math.floor(Math.random()*999), type: action, text, createdAt: new Date().toISOString() });
  let me = copy.players.find((p) => p.playerId === player.id) || null;
  if (action === "join") {
    const klass = (payload.class || "assault") as BattleClass;
    me = { id:"demo-me", playerId:player.id, displayName:player.displayName, team:"attacker", class:klass, hp:100, point:"A", kills:0, deaths:0, contribution:0, squadCode:"BRAVO" };
    copy.players.push(me); copy.me = me; copy.myTeam = "attacker"; event(`${player.displayName} вошёл в бой`); return copy;
  }
  if (action === "order") {
    copy.orders = copy.orders.filter((o) => o.team !== "attacker");
    copy.orders.push({
      id: `demo-order-${Date.now()}`, team: "attacker", stateId: "demo-state",
      point: payload.point as BattlePoint, kind: payload.kind, issuedBy: player.displayName,
      expiresAt: new Date(Date.now() + 90_000).toISOString(),
    });
    event(`${player.displayName} отдал приказ на точку ${payload.point}`);
    return copy;
  }
  if (!me) return copy;
  if (action === "class") { me.class = payload.class as BattleClass; event(`${player.displayName} сменил класс`); }
  if (action === "move") { me.point = payload.point as BattlePoint; event(`${player.displayName} → точка ${me.point}`); }
  if (action === "capture") { copy.pointOwners[me.point] = me.team; copy.attackerScore += 20; me.contribution += 12; event(`${player.displayName} захватил точку ${me.point}`); }
  if (action === "fortify" && me.class === "engineer") { copy.attackerScore += 10; me.contribution += 10; event(`${player.displayName} укрепил точку ${me.point}`); }
  if (action === "heal" && me.class === "medic") { const ally=copy.players.find(p=>p.team===me!.team&&p.point===me!.point&&p.hp<100); if(ally) ally.hp=Math.min(100,ally.hp+35); event(`${player.displayName} оказал помощь отряду`); }
  if (action === "fire") {
    const enemy=copy.players.find(p=>p.team!==me!.team&&p.point===me!.point&&p.hp>0);
    if(enemy){ enemy.hp=Math.max(0,enemy.hp-42); if(enemy.hp===0){me.kills++;enemy.deaths++;copy.attackerScore+=18;event(`${player.displayName} выбил ${enemy.displayName}`)} else event(`${player.displayName} попал по ${enemy.displayName}`); }
  }
  copy.me = me;
  copy.events = copy.events.slice(0,12);
  return copy;
}


export function demoDiplomacyAction(snapshot: GameSnapshot, targetStateId: string, action: DiplomacyAction): GameSnapshot {
  const copy: GameSnapshot = JSON.parse(JSON.stringify(snapshot));
  const target = copy.leaderboard.find((state) => state.id === targetStateId);
  if (!target || target.id === copy.state.id) return copy;
  let relation = copy.diplomacy.find((item) => item.otherStateId === targetStateId);
  const addFeed = (kind: string, title: string, text: string) => copy.worldFeed.unshift({
    id: Date.now(), kind, title, text, actorStateId: copy.state.id, actorStateName: copy.state.name, actorStateColor: copy.state.color,
    targetStateId: target.id, targetStateName: target.name, targetStateColor: target.color, createdAt: new Date().toISOString(),
  });
  const setRelation = (status: DiplomacyStatus, requestedByStateId: string | null = copy.state.id, truceUntil?: string | null) => {
    if (!relation) {
      relation = { id: `demo-rel-${target.id}`, otherStateId: target.id, otherStateName: target.name, otherStateColor: target.color, status, requestedByStateId, truceUntil: truceUntil || null, updatedAt: new Date().toISOString() };
      copy.diplomacy.unshift(relation);
    } else { relation.status = status; relation.requestedByStateId = requestedByStateId; relation.truceUntil = truceUntil || null; relation.updatedAt = new Date().toISOString(); }
  };
  if (action === "propose_alliance") { setRelation("alliance_pending"); addFeed("alliance_offer", "Предложен союз", `${copy.state.name} предложил союз государству ${target.name}.`); }
  if (action === "accept_alliance") { setRelation("allied", null); addFeed("alliance", "Новый альянс", `${copy.state.name} и ${target.name} заключили союз.`); }
  if (action === "declare_war") { setRelation("war"); addFeed("war_declared", "Объявлена война", `${copy.state.name} объявил войну государству ${target.name}.`); }
  if (action === "offer_truce") { setRelation("truce_pending"); addFeed("truce_offer", "Предложено перемирие", `${copy.state.name} предложил ${target.name} прекратить огонь.`); }
  if (action === "accept_truce") { setRelation("truce", null, new Date(Date.now()+24*60*60*1000).toISOString()); addFeed("truce", "Огонь прекращён", `${copy.state.name} и ${target.name} заключили перемирие.`); }
  if (action === "break_alliance") { copy.diplomacy = copy.diplomacy.filter((item) => item.otherStateId !== targetStateId); addFeed("alliance_broken", "Альянс распался", `${copy.state.name} вышел из союза с ${target.name}.`); }
  copy.worldFeed = copy.worldFeed.slice(0, 24);
  return copy;
}


export function demoProgressMission(snapshot: GameSnapshot, key: MissionKey, amount = 1): GameSnapshot {
  return {
    ...snapshot,
    dailyMissions: snapshot.dailyMissions.map((mission) =>
      mission.key === key && !mission.claimed
        ? { ...mission, progress: Math.min(mission.target, mission.progress + Math.max(1, amount)) }
        : mission,
    ),
  };
}

export function demoClaimMission(snapshot: GameSnapshot, missionId: string): GameSnapshot {
  const mission = snapshot.dailyMissions.find((item) => item.id === missionId);
  if (!mission || mission.claimed || mission.progress < mission.target) return snapshot;
  const nextXp = snapshot.player.xp + mission.rewardXp;
  return {
    ...snapshot,
    player: {
      ...snapshot.player,
      xp: nextXp,
      level: Math.max(snapshot.player.level, 1 + Math.floor(Math.sqrt(nextXp / 180))),
      contribution: snapshot.player.contribution + mission.rewardXp,
    },
    state: {
      ...snapshot.state,
      treasury: { ...snapshot.state.treasury, credits: snapshot.state.treasury.credits + mission.rewardCredits },
    },
    dailyMissions: snapshot.dailyMissions.map((item) => item.id === missionId ? { ...item, claimed: true } : item),
  };
}

export function demoCustomizeState(snapshot: GameSnapshot, patch: Partial<Pick<GameSnapshot["state"], "motto" | "emblem" | "theme" | "color">>): GameSnapshot {
  return { ...snapshot, state: { ...snapshot.state, ...patch } };
}

export function demoPoliticsAction(snapshot: GameSnapshot, action: string, payload: Record<string, string> = {}): GameSnapshot {
  const copy: GameSnapshot = JSON.parse(JSON.stringify(snapshot));
  if (action === "open") {
    copy.election = {
      id: `demo-election-${Date.now()}`,
      status: "open",
      startsAt: new Date().toISOString(),
      endsAt: new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
      winnerPlayerId: null,
      myVoteCandidateId: null,
      candidates: [{ id: "demo-candidate-me", playerId: copy.player.id, displayName: copy.player.displayName, statement: "Продолжить развитие государства.", votes: 0, isMe: true }],
    };
    return copy;
  }
  const election = copy.election;
  if (!election || election.status !== "open") return copy;
  if (action === "nominate") {
    const existing = election.candidates.find((candidate) => candidate.playerId === copy.player.id);
    if (existing) existing.statement = String(payload.statement || existing.statement).slice(0, 120);
    else election.candidates.push({ id: `demo-candidate-${Date.now()}`, playerId: copy.player.id, displayName: copy.player.displayName, statement: String(payload.statement || "").slice(0, 120), votes: 0, isMe: true });
  }
  if (action === "vote") {
    if (election.myVoteCandidateId) {
      const previous = election.candidates.find((candidate) => candidate.id === election.myVoteCandidateId);
      if (previous) previous.votes = Math.max(0, previous.votes - 1);
    }
    const candidate = election.candidates.find((item) => item.id === payload.candidateId);
    if (candidate) {
      candidate.votes += 1;
      election.myVoteCandidateId = candidate.id;
    }
  }
  if (action === "finalize" && new Date(election.endsAt).getTime() <= Date.now()) {
    const winner = [...election.candidates].sort((a, b) => b.votes - a.votes)[0];
    election.status = winner ? "resolved" : "cancelled";
    election.winnerPlayerId = winner?.playerId || null;
    if (winner?.playerId === copy.player.id) copy.player.role = "president";
  }
  return copy;
}

export function demoIslandAttack(snapshot: GameSnapshot, targetStateId: string) {
  const target = snapshot.islands.find((island) => island.id === targetStateId);
  if (!target || target.isMine || snapshot.activeBattle) return { snapshot, result: null };
  if (target.destroyedUntil && new Date(target.destroyedUntil).getTime() > Date.now()) return { snapshot, result: null };
  if (target.relation === "allied" || target.relation === "truce") return { snapshot, result: null };
  if (snapshot.state.treasury.fuel < 120 || snapshot.state.treasury.food < 80) return { snapshot, result: null };
  const now = Date.now();
  const battle: BattleView = {
    id: `demo-island-battle-${now}`,
    tileId: null,
    battleKind: "island",
    attackerStateId: snapshot.state.id,
    defenderStateId: target.id,
    attackerName: snapshot.state.name,
    defenderName: target.name,
    attackerColor: snapshot.state.color,
    defenderColor: target.color,
    status: "active",
    startsAt: new Date(now).toISOString(),
    endsAt: new Date(now + 180_000).toISOString(),
    attackerScore: 0,
    defenderScore: 0,
    pointOwners: { A: "attacker", B: null, C: "defender" },
    myTeam: "attacker",
    myRole: snapshot.player.role,
    me: null,
    orders: [],
    players: [
      { id:"sea-enemy-1",playerId:"sea-enemy-1",displayName:"Harbor Guard",team:"defender",class:"assault",hp:100,point:"C",kills:0,deaths:0,contribution:0,squadCode:"COAST" },
      { id:"sea-ally-1",playerId:"sea-ally-1",displayName:"Navigator",team:"attacker",class:"medic",hp:100,point:"A",kills:0,deaths:0,contribution:0,squadCode:"ALPHA" },
    ],
    events: [{ id: now, type:"join", text:`Флот ${snapshot.state.name} подошёл к острову ${target.name}.`, createdAt:new Date(now).toISOString() }],
  };
  return {
    snapshot: {
      ...snapshot,
      state: {
        ...snapshot.state,
        nextAttackAt: new Date(now + 90_000).toISOString(),
        treasury: { ...snapshot.state.treasury, fuel: snapshot.state.treasury.fuel - 120, food: snapshot.state.treasury.food - 80 },
      },
      worldFeed: [{
        id: now, kind: "island_attack", title: "Морская атака",
        text: `${snapshot.state.name} атакует остров ${target.name}.`,
        actorStateId: snapshot.state.id, actorStateName: snapshot.state.name, actorStateColor: snapshot.state.color,
        targetStateId: target.id, targetStateName: target.name, targetStateColor: target.color, createdAt: new Date(now).toISOString(),
      }, ...snapshot.worldFeed].slice(0, 24),
      activeBattle: battle,
    },
    result: { started: true },
  };
}

export function demoRepairIsland(snapshot: GameSnapshot, amount = 25): GameSnapshot {
  if (snapshot.state.destroyedUntil && new Date(snapshot.state.destroyedUntil).getTime() > Date.now()) return snapshot;
  const missing = Math.max(0, 100 - snapshot.state.islandIntegrity);
  const repaired = Math.min(Math.max(1, amount), missing);
  if (!repaired) return snapshot;
  const creditsCost = repaired * 24;
  const steelCost = repaired * 3;
  if (snapshot.state.treasury.credits < creditsCost || snapshot.state.treasury.steel < steelCost) return snapshot;
  const nextIntegrity = snapshot.state.islandIntegrity + repaired;
  return {
    ...snapshot,
    state: {
      ...snapshot.state,
      islandIntegrity: nextIntegrity,
      treasury: {
        ...snapshot.state.treasury,
        credits: snapshot.state.treasury.credits - creditsCost,
        steel: snapshot.state.treasury.steel - steelCost,
      },
    },
    islands: snapshot.islands.map((island) => island.isMine ? { ...island, integrity: nextIntegrity } : island),
  };
}
