/**
 * Grouping and presentation metadata for the read-only settings browser.
 *
 * The Palworld REST API only exposes `GET /settings`; there is no write endpoint, so this
 * module exists purely to make the flat key/value dump navigable.
 */

export interface SettingsGroup {
  id: string;
  label: string;
  description: string;
  keys: readonly string[];
}

/**
 * Grouped view of every documented `PalWorldSettings.ini` key.
 *
 * Anything the server returns that is not listed here falls into an "Other" bucket at render
 * time, so a new key added by a game update still shows up rather than being silently dropped.
 */
export const SETTINGS_GROUPS: readonly SettingsGroup[] = [
  {
    id: 'general',
    label: 'Difficulty & Rates',
    description: 'World difficulty and global progression speed multipliers.',
    keys: [
      'Difficulty',
      'DayTimeSpeedRate',
      'NightTimeSpeedRate',
      'ExpRate',
      'PalCaptureRate',
      'PalSpawnNumRate',
      'DeathPenalty',
    ],
  },
  {
    id: 'combat',
    label: 'Combat',
    description: 'Damage multipliers and player-versus-player toggles.',
    keys: [
      'PalDamageRateAttack',
      'PalDamageRateDefense',
      'PlayerDamageRateAttack',
      'PlayerDamageRateDefense',
      'bEnablePlayerToPlayerDamage',
      'bEnableFriendlyFire',
      'bEnableInvaderEnemy',
      'bEnableDefenseOtherGuildPlayer',
    ],
  },
  {
    id: 'survival',
    label: 'Survival & Regeneration',
    description: 'Hunger, stamina, and passive health regeneration rates.',
    keys: [
      'PlayerStomachDecreaceRate',
      'PlayerStaminaDecreaceRate',
      'PlayerAutoHPRegeneRate',
      'PlayerAutoHpRegeneRateInSleep',
      'PalStomachDecreaceRate',
      'PalStaminaDecreaceRate',
      'PalAutoHPRegeneRate',
      'PalAutoHpRegeneRateInSleep',
      'bEnableNonLoginPenalty',
      'bExistPlayerAfterLogout',
    ],
  },
  {
    id: 'building',
    label: 'Building & Base Camps',
    description: 'Structure durability, deterioration, and base camp limits.',
    keys: [
      'BuildObjectDamageRate',
      'BuildObjectDeteriorationDamageRate',
      'BaseCampMaxNum',
      'BaseCampWorkerMaxNum',
      'bCanPickupOtherGuildDeathPenaltyDrop',
    ],
  },
  {
    id: 'gathering',
    label: 'Gathering & Drops',
    description: 'Resource yields, node health, respawn speed, and dropped item limits.',
    keys: [
      'CollectionDropRate',
      'CollectionObjectHpRate',
      'CollectionObjectRespawnSpeedRate',
      'EnemyDropItemRate',
      'DropItemMaxNum',
      'DropItemMaxNum_UNKO',
      'DropItemAliveMaxHours',
    ],
  },
  {
    id: 'guild',
    label: 'Guild & Multiplayer',
    description: 'Guild size limits, inactivity resets, and co-op/PvP flags.',
    keys: [
      'bAutoResetGuildNoOnlinePlayers',
      'AutoResetGuildTimeNoOnlinePlayers',
      'GuildPlayerMaxNum',
      'bIsMultiplay',
      'bIsPvP',
      'CoopPlayerMaxNum',
    ],
  },
  {
    id: 'world',
    label: 'World & Quality of Life',
    description: 'Egg hatching, work speed, fast travel, and input assists.',
    keys: [
      'PalEggDefaultHatchingTime',
      'WorkSpeedRate',
      'bEnableFastTravel',
      'bIsStartLocationSelectByMap',
      'bEnableAimAssistPad',
      'bEnableAimAssistKeyboard',
      'bActiveUNKO',
    ],
  },
  {
    id: 'server',
    label: 'Server & Network',
    description: 'Identity, player cap, ports, region, and REST API / RCON configuration.',
    keys: [
      'ServerPlayerMaxNum',
      'ServerName',
      'ServerDescription',
      'PublicPort',
      'PublicIP',
      'RCONEnabled',
      'RCONPort',
      'Region',
      'bUseAuth',
      'BanListURL',
      'RESTAPIEnabled',
      'RESTAPIPort',
      'bShowPlayerList',
      'AllowConnectPlatform',
    ],
  },
  {
    id: 'save',
    label: 'Saves & Logging',
    description: 'Backup behaviour and log format.',
    keys: ['bIsUseBackupSaveData', 'LogFormatType'],
  },
];

/** Human-readable label for a settings key, e.g. `bEnablePlayerToPlayerDamage`. */
export function humanizeSettingKey(key: string): string {
  return key
    .replace(/^b(?=[A-Z])/, '')
    .replace(/_/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Render a settings value for display.
 *
 * Booleans become On/Off rather than true/false because that is how they read in-game, and
 * empty strings are called out explicitly so they are not mistaken for missing data.
 */
export function formatSettingValue(value: string | number | boolean | undefined): string {
  if (value === undefined || value === null) return '—';
  if (typeof value === 'boolean') return value ? 'On' : 'Off';
  if (typeof value === 'number') return String(value);
  if (value === '') return '(empty)';
  return value;
}

/** True when the value should be highlighted as "on" / enabled in the UI. */
export function isTruthySettingValue(value: string | number | boolean | undefined): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') return value === 'True' || value === 'true' || value === '1';
  return false;
}
