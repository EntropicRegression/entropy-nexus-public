import type { AgentState, Backend, Zone } from '../../shared/types';

// 配色集中在這裡:主色青藍,琥珀與紅色只留給待授權與異常
export const COLOR = {
  bg: 0x060a12,
  grid: 0x3fd8e6,
  accent: 0x3fd8e6,
  text: 0xd8f4f8,
  dim: 0x6f8f9c,
  warn: 0xffb020,
  bad: 0xff4d5e,
};

export const BACKEND_COLOR: Record<Backend, number> = {
  claude: 0xb48cff,
  codex: 0x5ce0a0,
  antigravity: 0x5cb8ff,
};

export const ZONE_COLOR: Record<Zone, number> = {
  standby: COLOR.accent,
  planning: COLOR.accent,
  active: COLOR.accent,
  auth: COLOR.warn,
  fault: COLOR.bad,
};

export const ZONE_TITLE: Record<Zone, string> = {
  planning: '規劃 PLANNING',
  active: '執行 ACTIVE',
  standby: '待命 STANDBY',
  auth: '待授權 AUTH',
  fault: '異常 FAULT',
};

export const STATE_COLOR: Record<AgentState, number> = {
  idle: COLOR.accent,
  sleeping: COLOR.dim,
  planning: COLOR.accent,
  working: COLOR.accent,
  awaiting: COLOR.warn,
  error: COLOR.bad,
  lost: COLOR.bad,
};

export const hex = (n: number) => `#${n.toString(16).padStart(6, '0')}`;
