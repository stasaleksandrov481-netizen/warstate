import { createIslandBattle } from "@/lib/islands";
import { upgradeBuilding } from "@/lib/game";
import type { BuildingType, WarType } from "@/lib/types";
import { reconcileStateRuntime } from "@/lib/maintenance";

const WAR_ROLES = new Set(["president", "deputy", "founder"]);
const UPGRADE_ROLES = new Set(["president", "minister", "deputy", "curator"]);

export async function startWarAction(input: {
  actorRole: string;
  attackerStateId: string;
  defenderStateId: string;
  battleType: WarType;
  attackerIsFreeport?: boolean;
}) {
  if (!WAR_ROLES.has(input.actorRole)) throw new Error("Начинать войну может Президент, Заместитель или Основатель после одобренного голосования.");
  if (input.attackerIsFreeport) throw new Error("Freeport — нейтральная территория. Сначала вступите в государство.");
  await Promise.all([
    reconcileStateRuntime(input.attackerStateId, { force: true }),
    reconcileStateRuntime(input.defenderStateId, { force: true }),
  ]);
  return createIslandBattle(input.attackerStateId, input.defenderStateId, input.battleType);
}

export async function upgradeBuildingAction(input: {
  actorRole: string;
  stateId: string;
  buildingType: BuildingType;
  stateIsFreeport?: boolean;
}) {
  if (!UPGRADE_ROLES.has(input.actorRole)) throw new Error("Развивать остров может президент, заместитель или куратор.");
  if (input.stateIsFreeport) throw new Error("Freeport развивается через личный прогресс игроков, а не общую казну.");
  await reconcileStateRuntime(input.stateId, { force: true });
  return upgradeBuilding(input.stateId, input.buildingType);
}
