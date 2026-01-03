import { UnitType } from "../../core/game/Game";
import { GameStateCache } from "../GameStateCache";
import { GameState, PlayerAction } from "../schema";

import { UNIT_COSTS } from "../../core/configuration/DefaultConfig";

export class ToolLogic {
  /**
   * Calculates the cost of a unit using shared logic.
   */
  private static getUnitCost(type: UnitType, existingCount: number): number {
    switch (type) {
      case UnitType.TransportShip:
      case UnitType.Shell:
      case UnitType.SAMMissile:
      case UnitType.TradeShip:
      case UnitType.MIRVWarhead:
      case UnitType.Train:
        return 0;

      case UnitType.Warship:
        return UNIT_COSTS.Warship(existingCount);

      case UnitType.Port:
        return UNIT_COSTS.Port(existingCount);

      case UnitType.AtomBomb:
        return UNIT_COSTS.AtomBomb();

      case UnitType.HydrogenBomb:
        return UNIT_COSTS.HydrogenBomb();

      case UnitType.MIRV:
        // MCP GameState currently doesn't track global stats like numMirvsLaunched.
        // Defaulting to 0 for now as an approximation for the tool.
        return UNIT_COSTS.MIRV(0);

      case UnitType.MissileSilo:
        return UNIT_COSTS.MissileSilo();

      case UnitType.DefensePost:
        return UNIT_COSTS.DefensePost(existingCount);

      case UnitType.SAMLauncher:
        return UNIT_COSTS.SAMLauncher(existingCount);

      case UnitType.City:
        return UNIT_COSTS.City(existingCount);

      case UnitType.Factory:
        return UNIT_COSTS.Factory(existingCount);

      default:
        return 999_999_999;
    }
  }

  static getPlayerActions(
    state: GameState,
    cache: GameStateCache,
    tileRef: number,
  ): PlayerAction {
    // Let's fix the cache access first.
    // We can just assume the caller handles x/y conversion or we improve Cache.
    // For now, let's assume valid tile data is passed or we can't do much.
    // Actually, let's use the map summary to get dimensions to decode ref if needed,
    // BUT GameMapImpl inside Cache has x/y getters.
    // Best to just expose getTileDataByRef in Cache?
    // Or just implement logic assuming we can get the tile info.

    // For now, let's rely on the Cache exposing a way to get tile info by Ref.
    // I'll assume we can get it via the public API I just added/checked.
    // Wait, I only added getNeighbors.
    // I should probably add `getTileDataByRef` to Cache for efficiency/convenience.
    // But let's proceed with the logic first.

    // Map Ref to X,Y
    const width = cache.getMapSummary()?.width ?? 0;
    const x = tileRef % width;
    const y = Math.floor(tileRef / width);
    const tileData = cache.getTileData(x, y);

    if (!tileData) {
      return {
        canAttack: false,
        buildableUnits: [],
        canSendEmojiAllPlayers: false,
        canEmbargoAll: false,
      };
    }

    const myPlayer = state.myPlayer;
    const isOwner = tileData.ownerID === myPlayer.id;
    const structure = state.units.find(
      (u) =>
        u.pos === tileRef &&
        u.unitType !== "Transport" &&
        u.unitType !== "Warship",
      // Filter out mobile units to check for buildings
    );

    const action: PlayerAction = {
      canAttack: false,
      buildableUnits: [],
      canSendEmojiAllPlayers: true, // Always true? simplify
      canEmbargoAll: true, // Always true? simplify
    };

    // 1. Own Tile Logic
    if (isOwner) {
      if (!structure) {
        // Can build structures
        const structures = [
          UnitType.City,
          UnitType.Port,
          UnitType.DefensePost,
          UnitType.MissileSilo,
          UnitType.SAMLauncher,
          UnitType.Factory,
        ];

        for (const type of structures) {
          // Count existing
          const count = state.units.filter(
            (u) => u.unitType === type && u.ownerID === myPlayer.id,
          ).length;
          const cost = this.getUnitCost(type, count);

          let canBuild = myPlayer.gold >= cost;

          // Specific checks (e.g. water for Port)
          if (
            type === UnitType.Port &&
            !tileData.isShoreline &&
            !tileData.isWater
          ) {
            canBuild = false; // Simplified, ports need water/shore
          }
          if (type !== UnitType.Port && tileData.isWater) {
            canBuild = false; // Land units need land
          }

          action.buildableUnits.push({
            type,
            cost,
            canBuild,
            canUpgrade: false,
          });
        }
      } else {
        // Check for upgrades
        // Simplified: Assume upgradable if it's a structure
        if (structure.level < 3) {
          // Arbitrary max level for simplicity
          // Add upgrade option
        }
      }
    }
    // 2. Other Tile Logic
    else if (tileData.ownerID && tileData.ownerID !== 0) {
      // Check adjacency
      const neighbors = cache.getNeighbors(tileRef);
      // We need to know if we own any neighbor.
      // This requires querying the map for ownership of neighbors.
      // GameStateCache doesn't expose ownership of arbitrary tiles easily without query.
      // But we can check `tileData.isBorder`? No, that means it's a border of the *owner*.

      let isAdjacent = false;
      for (const nRef of neighbors) {
        // Getting ownership of explicit tile ref from cache...
        // We don't have a direct method for this without x/y conversion again?
        // I will use x/y conversion for now.
        const nx = nRef % width;
        const ny = Math.floor(nRef / width);
        const nData = cache.getTileData(nx, ny);
        if (nData && nData.ownerID === myPlayer.id) {
          isAdjacent = true;
          break;
        }
      }

      action.canAttack = isAdjacent;

      // Interactions
      const owner = state.players.find((p) => p.id === tileData.ownerID);
      if (owner) {
        action.interaction = {
          ownerID: owner.id,
          ownerName: owner.name,
          sharedBorder: isAdjacent,
          canSendEmoji: true,
          canTarget: true,
          canSendAllianceRequest: !myPlayer.allies.includes(owner.id),
          canBreakAlliance: myPlayer.allies.includes(owner.id),
          canDonateGold: myPlayer.allies.includes(owner.id),
          canDonateTroops: myPlayer.allies.includes(owner.id),
          canEmbargo: !myPlayer.embargoes.includes(owner.id),
        };
      }
    }

    return action;
  }
}
