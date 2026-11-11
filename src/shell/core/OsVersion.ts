import { OS_VERSION } from '../../config/version';

/**
 * `data-os-version` の印が付いた要素に OS の版を書く（index.html の下の帯）。起動の最初に 1 度呼ぶ。
 * 番号の正は src/config/version.ts だけで、HTML には書かない。
 */
export function applyOsVersion(root: ParentNode = document, version: string = OS_VERSION): void {
  root.querySelectorAll('[data-os-version]').forEach((el) => {
    el.textContent = `v${version}`;
  });
}
