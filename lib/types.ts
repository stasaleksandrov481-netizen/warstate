export type BuildingType = "hq" | "barracks" | "mine" | "refinery" | "farm" | "lab" | "outpost" | "trade_chamber";
export type BattleClass = "assault" | "medic" | "engineer" | "scout";
export type BattlePoint = "A" | "B" | "C";
export type BattleTeam = "attacker" | "defender";
export type BattleOrderKind = "attack" | "defend" | "rally";
export type DiplomacyStatus = "alliance_pending" | "allied" | "truce_pending" | "truce" | "war";
export type DiplomacyAction = "propose_alliance" | "accept_alliance" | "reject_alliance" | "declare_war" | "offer_truce" | "accept_truce" | "break_alliance";
export type MissionKey = "check_in" | "join_battle" | "battle_action" | "capture_point";
export type WarType = "raid" | "siege" | "territory";

export interface ActivityOptionView {
  key: string;
  label: string;
  risk: number;
  rewards: { credits: number; influence: number; tech: number; reputation: number; contribution: number };
}

export interface ActivityView {
  key: string;
  title: string;
  description: string;
  completed: boolean;
  beginnerAllowed: boolean;
  options: ActivityOptionView[];
}

export interface ContributionEventView {
  id: number;
  source: string;
  amount: number;
  createdAt: string;
}

export interface SupportableBattleView {
  id: string;
  side: "attacker" | "defender";
  allyStateId: string;
  allyName: string;
  enemyName: string;
  battleType: WarType;
  endsAt: string;
}

export interface StrategyView {
  activities: ActivityView[];
  completedToday: number;
  contributionEvents: ContributionEventView[];
  supportableBattles: SupportableBattleView[];
  canManage: boolean;
  canCommand: boolean;
  rules: { maxDailyActivities: number; maxAttackSizePenalty: number; maxUnderdogBonus: number; maxAggressionPenalty: number; maxAllianceSupport: number; raidLootBudgetPct: number; raidLootInfluencePct: number };
}

export interface PlayerView {
  id: string;
  telegramId: number;
  displayName: string;
  username?: string | null;
  level: number;
  xp: number;
  energy: number;
  contribution: number;
  role: string;
  dutyRole?: "diplomat" | "spy" | "miner" | "worker" | null;
}

export interface StateView {
  id: string;
  name: string;
  stateUsername?: string | null;
  telegramChatTitle?: string | null;
  color: string;
  motto: string;
  emblem: string;
  theme: string;
  telegramChatId: number | null;
  isFreeport: boolean;
  isBeginnerIsland: boolean;
  level: number;
  maxLevel: number;
  influence: number;
  reputation: number;
  armyPower: number;
  defensePower: number;
  activePlayers: number;
  stateSize: number;
  treasury: {
    credits: number;
    steel: number;
    fuel: number;
    food: number;
    tech: number;
  };
  productionPerHour: {
    credits: number;
    steel: number;
    fuel: number;
    food: number;
    tech: number;
  };
  rating: number;
  memberCount: number;
  seasonRank: number;
  worldX: number;
  worldY: number;
  islandWins: number;
  islandLosses: number;
  ratingPeak: number;
  islandIntegrity: number;
  winStreak: number;
  bestWinStreak: number;
  lastBattleAt?: string | null;
  destroyedUntil?: string | null;
  shieldUntil?: string | null;
  nextAttackAt?: string | null;
  avatarUrl?: string | null;
}

export interface BuildingView {
  type: BuildingType;
  level: number;
  upgradeTargetLevel?: number | null;
  upgradeStartedAt?: string | null;
  upgradeFinishesAt?: string | null;
  upgradeCooldownUntil?: string | null;
  upgradeCost: Partial<Record<keyof StateView["treasury"], number>>;
  label: string;
  description: string;
  x: number;
  y: number;
}

export interface WarView {
  id: string;
  attackerName: string;
  defenderName?: string | null;
  tileId?: string | null;
  winnerStateId?: string | null;
  attackerPower: number;
  defenderPower: number;
  status: string;
  createdAt: string;
}

export interface BattlePlayerView {
  id: string;
  playerId: string;
  displayName: string;
  team: BattleTeam;
  class: BattleClass;
  hp: number;
  point: BattlePoint;
  kills: number;
  deaths: number;
  contribution: number;
  squadCode?: string | null;
  cooldownUntil?: string | null;
  respawnAt?: string | null;
}


export interface BattleOrderView {
  id: string;
  team: BattleTeam;
  stateId: string;
  point: BattlePoint;
  kind: BattleOrderKind;
  issuedBy?: string | null;
  expiresAt: string;
}

export interface BattleEventView {
  id: number;
  type: string;
  text: string;
  createdAt: string;
}

export interface BattleView {
  id: string;
  tileId: string | null;
  battleKind: "territory" | "island";
  attackerStateId: string;
  defenderStateId?: string | null;
  attackerName: string;
  defenderName: string;
  attackerColor: string;
  defenderColor: string;
  status: "scheduled" | "active" | "resolved" | "cancelled";
  startsAt: string;
  endsAt: string;
  attackerScore: number;
  defenderScore: number;
  attackerSizeModifier: number;
  defenderSizeModifier: number;
  defenderBuffer: number;
  aggressionPenalty: number;
  battleType: WarType;
  attackerStateSize: number;
  defenderStateSize: number;
  attackerRawPower: number;
  defenderRawPower: number;
  attackerFinalPower: number;
  defenderFinalPower: number;
  underdogBonus: number;
  defenseBufferPct: number;
  attackerRandomModifier: number;
  defenderRandomModifier: number;
  stolenBudget: number;
  stolenInfluence: number;
  pointOwners: Record<BattlePoint, BattleTeam | null>;
  winnerStateId?: string | null;
  isDraw: boolean;
  myTeam?: BattleTeam | null;
  myRole?: string | null;
  me?: BattlePlayerView | null;
  players: BattlePlayerView[];
  orders: BattleOrderView[];
  events: BattleEventView[];
}


export interface DiplomacyRelationView {
  id: string;
  otherStateId: string;
  otherStateName: string;
  otherStateUsername?: string | null;
  otherStateColor: string;
  status: DiplomacyStatus;
  requestedByStateId?: string | null;
  truceUntil?: string | null;
  updatedAt: string;
}

export interface WorldEventView {
  id: number;
  kind: string;
  title: string;
  text: string;
  actorStateId?: string | null;
  actorStateName?: string | null;
  actorStateColor?: string | null;
  targetStateId?: string | null;
  targetStateName?: string | null;
  targetStateColor?: string | null;
  createdAt: string;
}

export interface LeaderboardStateView {
  id: string;
  name: string;
  stateUsername?: string | null;
  color: string;
  rating: number;
  rank: number;
  memberCount: number;
}


export interface IslandView {
  id: string;
  name: string;
  stateUsername?: string | null;
  color: string;
  emblem: string;
  worldX: number;
  worldY: number;
  memberCount: number;
  rating: number;
  rank: number;
  wins: number;
  losses: number;
  integrity: number;
  winStreak: number;
  lastBattleAt?: string | null;
  destroyedUntil?: string | null;
  shieldUntil?: string | null;
  avatarUrl?: string | null;
  relation?: DiplomacyStatus | null;
  isMine: boolean;
  isFreeport: boolean;
  isBeginnerIsland: boolean;
  level: number;
  maxLevel: number;
  influence: number;
  reputation: number;
  armyPower: number;
  defensePower: number;
  activePlayers: number;
  stateSize: number;
  presidentName?: string | null;
  allianceCount: number;
  treasuryCredits: number;
}

export interface DailyMissionView {
  id: string;
  key: MissionKey;
  title: string;
  description: string;
  progress: number;
  target: number;
  rewardXp: number;
  rewardCredits: number;
  claimed: boolean;
}


export interface SeasonView {
  id: string;
  name: string;
  number: number;
  startsAt: string;
  endsAt: string;
  active: boolean;
}

export interface ElectionCandidateView {
  id: string;
  playerId: string;
  displayName: string;
  statement: string;
  votes: number;
  isMe: boolean;
}

export interface ElectionView {
  id: string;
  status: "open" | "resolved" | "cancelled";
  startsAt: string;
  endsAt: string;
  winnerPlayerId?: string | null;
  myVoteCandidateId?: string | null;
  candidates: ElectionCandidateView[];
}

export interface StateBadgeView {
  id: string;
  key: string;
  title: string;
  description: string;
  icon: string;
  earnedAt: string;
}

export interface RecruitmentPostView {
  stateId: string;
  stateName: string;
  stateColor: string;
  memberCount: number;
  rating: number;
  headline: string;
  message: string;
  minLevel: number;
}

export interface RecruitmentRequestView {
  id: string;
  stateId: string;
  stateName: string;
  stateColor: string;
  playerId: string;
  playerName: string;
  playerLevel: number;
  playerXp: number;
  kind: "application" | "offer";
  status: "pending" | "accepted" | "rejected" | "withdrawn";
  message: string;
  inviteLink?: string | null;
  updatedAt: string;
}

export interface FreeAgentView {
  playerId: string;
  displayName: string;
  username?: string | null;
  level: number;
  xp: number;
  contribution: number;
}

export interface RecruitmentHubView {
  post: RecruitmentPostView | null;
  listings: RecruitmentPostView[];
  myRequests: RecruitmentRequestView[];
  incoming: RecruitmentRequestView[];
  freeAgents: FreeAgentView[];
}


export interface GovernmentMemberView {
  playerId: string;
  displayName: string;
  username?: string | null;
  role: string;
}

export interface GovernmentView {
  stateUsername?: string | null;
  telegramChatTitle?: string | null;
  founder: GovernmentMemberView | null;
  president: GovernmentMemberView | null;
  deputies: GovernmentMemberView[];
  canFounderManage: boolean;
  canProjectAdmin: boolean;
}

export interface GameSnapshot {
  player: PlayerView;
  state: StateView;
  buildings: BuildingView[];
  wars: WarView[];
  diplomacy: DiplomacyRelationView[];
  worldFeed: WorldEventView[];
  leaderboard: LeaderboardStateView[];
  islands: IslandView[];
  dailyMissions: DailyMissionView[];
  season: SeasonView | null;
  election: ElectionView | null;
  badges: StateBadgeView[];
  activeBattle?: BattleView | null;
  recruitment: RecruitmentHubView;
  strategy: StrategyView;
  government: GovernmentView;
  startParam?: string | null;
}
