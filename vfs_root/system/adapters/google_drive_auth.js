/**
 * system/adapters/google_drive_auth.js
 * Google Drive 認証アダプタ (Sync Adapter API v1)
 *
 * ホストの SyncAdapterHost から動的 import され、init(ctx) が呼ばれる。
 * ホスト側には Google Drive 固有のコードは一切存在しない。
 *
 * ── 方式 ──────────────────────────────────────────
 * GIS (Google Identity Services) のトークンクライアントを使う暗黙フロー。
 *   - アクセストークンのみ。有効期限 1 時間。リフレッシュトークンは発行されない。
 *   - Google 側のセッション Cookie が生きていれば prompt:'' で無音再取得できる。
 *     ただしサードパーティ Cookie がブロックされている環境では失敗し、
 *     ユーザー操作を伴う再認証が必要になる。
 *   - 恒久的な無人運転が要る場合は、ローカルヘルパー経由の
 *     Desktop クライアント方式（refresh_token を手元に保持）へ移行する。
 *     その場合もこのアダプタを差し替えるだけでよい。
 *
 * ── 実測済みの前提 ──────────────────────────────────
 *   - Drive API / トークンEP はいずれも CORS 対応済み。プロキシ不要。
 *   - blob: URL のゲストも親オリジンを継承するため、承認済み JavaScript 生成元は
 *     ホストのオリジン 1 つを登録すればよい。
 * ────────────────────────────────────────────────
 */

const GIS_SRC = 'https://accounts.google.com/gsi/client';
const CONFIG_PATH = 'system/config/gdrive.json';

// 同期デーモン（ゲスト側）へトークンを渡すための受け渡し場所。
//
// ★ 平文で VFS に置かれる点は明示的なトレードオフである。
//   - ゲストプロセスは MetaOS.fs 経由でしか読めず、system/temp は
//     セッションリセットで破棄される。
//   - 保存されるのは有効期限 1 時間のアクセストークンのみで、
//     リフレッシュトークンや client_secret は存在しない（暗黙フローのため）。
//   - Drive のスコープは drive.file に限定され、権限はアプリが作成した
//     ファイルにしか及ばない。
//   より強い分離が必要なら、IPC で直接デーモンへ渡す方式に変更すること。
const TOKEN_PATH = 'system/temp/gdrive_token.json';

const SYSTEM_PRINCIPAL = { type: 'system', id: 'system' };

/** 失効の何ミリ秒前に無音更新を試みるか */
const RENEW_MARGIN_MS = 5 * 60 * 1000;

let gisPromise = null;

function loadGis() {
  if (gisPromise) return gisPromise;
  gisPromise = new Promise((resolve, reject) => {
    if (window.google && window.google.accounts && window.google.accounts.oauth2) {
      return resolve(window.google.accounts.oauth2);
    }
    const s = document.createElement('script');
    s.src = GIS_SRC;
    s.async = true;
    s.onload = () => {
      if (window.google && window.google.accounts && window.google.accounts.oauth2) {
        resolve(window.google.accounts.oauth2);
      } else {
        reject(new Error('GIS loaded but oauth2 namespace is missing'));
      }
    };
    s.onerror = () => reject(new Error('Failed to load Google Identity Services'));
    document.head.appendChild(s);
  });
  return gisPromise;
}

export async function init(ctx) {
  const { vfs, ui, log } = ctx;

  // ---------- 設定の読み込み ----------
  let config = {};
  try {
    const raw = await vfs.readFile(SYSTEM_PRINCIPAL, CONFIG_PATH).catch(() => '{}');
    config = JSON.parse(raw || '{}');
  } catch (e) {
    log(`Failed to parse ${CONFIG_PATH}: ${e.message}`, 'warn');
  }

  const clientId = config.clientId;
  const scope = config.scope || 'https://www.googleapis.com/auth/drive.file';

  // ---------- UI の構築 ----------
  const row = document.createElement('div');
  row.className =
    'flex items-center justify-between p-3 bg-card border border-border-main rounded-lg hover:border-primary/30 transition';

  const left = document.createElement('div');
  left.className = 'flex items-center gap-3 min-w-0';
  left.innerHTML = `
    <div class="w-8 h-8 rounded-full bg-white flex items-center justify-center shadow-sm shrink-0">
      <svg class="w-4 h-4" viewBox="0 0 24 24">
        <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
        <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
        <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
        <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
      </svg>
    </div>
    <div class="min-w-0">
      <div class="text-sm font-bold text-text-main">Google Drive</div>
      <div class="text-[10px] text-text-muted truncate" data-role="sub">Not connected</div>
    </div>
  `;
  const sub = left.querySelector('[data-role="sub"]');

  const right = document.createElement('div');
  right.className = 'flex items-center gap-1.5 shrink-0';

  const btnSignIn = document.createElement('button');
  btnSignIn.className =
    'px-3 py-1.5 bg-card hover:bg-hover border border-border-main text-text-main text-xs font-bold rounded shadow-sm transition';
  btnSignIn.textContent = 'Sign In';

  const btnSignOut = document.createElement('button');
  btnSignOut.className =
    'hidden px-3 py-1.5 bg-card hover:bg-error/10 border border-error/30 text-error text-xs font-bold rounded shadow-sm transition';
  btnSignOut.textContent = 'Sign Out';

  right.appendChild(btnSignIn);
  right.appendChild(btnSignOut);
  row.appendChild(left);
  row.appendChild(right);
  ui.container.appendChild(row);

  // 設定不備は UI 上で明示する（黙って動かないのが一番困るため）
  if (!clientId) {
    sub.textContent = 'clientId not configured';
    btnSignIn.disabled = true;
    btnSignIn.className = 'px-3 py-1.5 bg-card border border-border-main text-text-muted text-xs font-bold rounded';
    const hint = document.createElement('div');
    hint.className = 'text-[10px] text-text-muted leading-relaxed px-1';
    hint.innerHTML = `<span class="font-mono">${CONFIG_PATH}</span> に clientId を設定してください。`;
    ui.container.appendChild(hint);
    ui.setStatus({ state: 'error', label: 'Not Configured', detail: 'clientId missing' });
    return;
  }

  // ---------- 状態 ----------
  let tokenClient = null;
  let renewTimer = null;
  let currentToken = null;

  const setDisconnected = (detail) => {
    currentToken = null;
    btnSignIn.classList.remove('hidden');
    btnSignOut.classList.add('hidden');
    sub.textContent = detail || 'Not connected';
    ui.setStatus({ state: 'disconnected', label: 'Local Mode Only', detail: 'Not Signed In' });
  };

  const persistToken = async (token, expiresAt) => {
    const payload = { accessToken: token, expiresAt, scope, obtainedAt: Date.now() };
    try {
      await vfs.writeFile(SYSTEM_PRINCIPAL, TOKEN_PATH, JSON.stringify(payload, null, 2), {
        overwrite: true,
      });
    } catch (e) {
      log(`Failed to persist token: ${e.message}`, 'error');
    }
  };

  const clearToken = async () => {
    try {
      await vfs.writeFile(SYSTEM_PRINCIPAL, TOKEN_PATH, JSON.stringify({ accessToken: null }, null, 2), {
        overwrite: true,
      });
    } catch (e) {
      /* 消せなくても致命的ではない */
    }
  };

  /** 認証済みで Drive API を叩く小さなヘルパー */
  const driveFetch = async (url, options = {}) => {
    if (!currentToken) throw new Error('Not authenticated');
    const res = await fetch(url, {
      ...options,
      headers: {
        ...(options.headers || {}),
        Authorization: `Bearer ${currentToken}`,
      },
    });
    return res;
  };

  /**
   * 同期先フォルダを用意する。
   *
   * drive.file スコープでは「アプリが作成したファイル」に必ずアクセスできる。
   * したがって専用フォルダを作る方式なら Picker API も API キーも不要になる。
   * 既存の任意フォルダを選ばせたい場合は Google Picker が必要（要 API キー）。
   */
  const ensureFolder = async () => {
    if (config.folderId) return config.folderId;

    const folderName = config.folderName || 'Itera OS';

    // 既に作成済みのものを探す（アプリ作成物のみが見える）
    const q = encodeURIComponent(
      `mimeType='application/vnd.google-apps.folder' and name='${folderName}' and trashed=false`,
    );
    const listRes = await driveFetch(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name)`);
    if (listRes.ok) {
      const data = await listRes.json();
      if (data.files && data.files.length > 0) return data.files[0].id;
    }

    // 無ければ作る
    const createRes = await driveFetch('https://www.googleapis.com/drive/v3/files?fields=id', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: folderName, mimeType: 'application/vnd.google-apps.folder' }),
    });
    if (!createRes.ok) throw new Error(`Failed to create folder (HTTP ${createRes.status})`);
    const created = await createRes.json();
    return created.id;
  };

  const onTokenGranted = async (response) => {
    if (!response || !response.access_token) {
      setDisconnected('No token returned');
      return;
    }
    currentToken = response.access_token;
    const expiresInMs = (Number(response.expires_in) || 3600) * 1000;
    const expiresAt = Date.now() + expiresInMs;

    await persistToken(currentToken, expiresAt);

    // 利用者の識別とフォルダの用意
    let email = 'Connected';
    try {
      const aboutRes = await driveFetch('https://www.googleapis.com/drive/v3/about?fields=user(emailAddress)');
      if (aboutRes.ok) {
        const about = await aboutRes.json();
        email = (about.user && about.user.emailAddress) || email;
      }
    } catch (e) {
      log(`about.get failed: ${e.message}`, 'warn');
    }

    try {
      const folderId = await ensureFolder();
      if (folderId !== config.folderId) {
        config.folderId = folderId;
        await vfs.writeFile(SYSTEM_PRINCIPAL, CONFIG_PATH, JSON.stringify(config, null, 2), { overwrite: true });
      }
    } catch (e) {
      log(`Folder setup failed: ${e.message}`, 'error');
      ui.setStatus({ state: 'error', label: 'Folder Error', detail: e.message });
      return;
    }

    btnSignIn.classList.add('hidden');
    btnSignOut.classList.remove('hidden');
    sub.textContent = email;
    ui.setStatus({
      state: 'connected',
      label: 'Cloud Sync Active',
      detail: email,
      accentClass: 'text-[#4285F4]',
    });

    // 失効前に無音更新を試みる
    if (renewTimer) clearTimeout(renewTimer);
    const delay = Math.max(expiresInMs - RENEW_MARGIN_MS, 30 * 1000);
    renewTimer = setTimeout(() => {
      log('Attempting silent token renewal');
      try {
        // prompt:'' は Google セッションが生きている場合のみ無音で通る。
        // サードパーティ Cookie がブロックされていると失敗する。
        tokenClient.requestAccessToken({ prompt: '' });
      } catch (e) {
        log(`Silent renewal failed: ${e.message}`, 'warn');
        setDisconnected('Session expired — sign in again');
      }
    }, delay);
  };

  // ---------- GIS の初期化 ----------
  try {
    const oauth2 = await loadGis();
    tokenClient = oauth2.initTokenClient({
      client_id: clientId,
      scope,
      callback: (response) => {
        onTokenGranted(response).catch((e) => {
          log(`Token handling failed: ${e.message}`, 'error');
          ui.setStatus({ state: 'error', label: 'Error', detail: e.message });
        });
      },
      error_callback: (err) => {
        log(`Auth error: ${err && err.type ? err.type : 'unknown'}`, 'warn');
        setDisconnected('Sign-in cancelled or blocked');
      },
    });
  } catch (e) {
    log(`GIS init failed: ${e.message}`, 'error');
    sub.textContent = 'Failed to load Google Identity Services';
    ui.setStatus({ state: 'error', label: 'Error', detail: e.message });
    return;
  }

  btnSignIn.onclick = () => {
    ui.setStatus({ state: 'connecting', label: 'Connecting...' });
    // ユーザー操作の直下で呼ぶこと。ポップアップがブロックされる。
    tokenClient.requestAccessToken({ prompt: 'consent' });
  };

  btnSignOut.onclick = async () => {
    if (currentToken && window.google && window.google.accounts && window.google.accounts.oauth2) {
      try {
        window.google.accounts.oauth2.revoke(currentToken, () => {});
      } catch (e) {
        /* 失効に失敗してもローカル状態は落とす */
      }
    }
    if (renewTimer) clearTimeout(renewTimer);
    await clearToken();
    setDisconnected();
  };

  // 起動直後は未接続。暗黙フローではトークンを永続化できないため、
  // ページ再読み込みのたびにサインインが必要になる（案1の制約）。
  setDisconnected();
  log('Google Drive auth adapter ready');
}
