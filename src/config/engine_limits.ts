/**
 * src/config/engine_limits.ts
 * エンジンまわりの上限（T-0908）。定数から始める（設定項目にはしない）。
 *
 * 窓として数えるのは、画面を持つプロセス（type が app）。デーモンは数えない。
 */

/** 同時に生きていられる、アプリが作ったエンジンの数 */
export const MAX_SUB_ENGINES = 8;

/** OS のチャットのエンジン（ルート）に仕える窓の数。越えたら、背景の古いものから閉じる */
export const MAX_APPS_ROOT = 16;

/** アプリが作ったエンジン 1 つに仕える窓の数。越えるなら、起こす前に断る（押し出さない） */
export const MAX_APPS_SUB = 4;
