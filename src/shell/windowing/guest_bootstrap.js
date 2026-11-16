/**
 * src/shell/windowing/guest_bootstrap.js
 * Itera OS v2: ゲストの二段起動 — 1 段目（T-0770 / T-0784 / T-0827）
 *
 * 文書ひとつにつき 1 回走る小さなスクリプト。自分の本体（束 { html, assets }）を親の窓に頼み、**自分のオリジンで**
 * object URL を作り、本文の目印を置き換えて document.write で**同じ文書**に本体を書く。
 * ナビゲーションしないので「URL を作った文書 ＝ それを読む文書」が保たれる。
 *
 *   - 入口の文書: ProcessManager が iframe の srcdoc に置く。親はホスト。IPC の要求 `sys:boot` で頼む
 *   - 入れ子の文書（アプリが枠に書いた VFS の HTML。T-0827）: 親の文書がこの 1 段目を URL にして枠に入れる。
 *     親は**その文書**で、束（資源 kind: 'doc'）を持っている。IPC とは別の合図（`itera:doc:v1`）で頼む
 *
 * 入れ子の文書は親と別の文書（別のオリジン）なので、親が作った URL を読めない。だから文書ごとにこれを繰り返す:
 * 本体を書く文書は、自分の束の中の入れ子の文書の束を持ち続け、起きてきた子に渡す。
 *
 * ここにブリッジは無い（入口の本体にインラインで入っている）。要求は素のメッセージで組む。
 * 🔴 document.open() は Window のイベントリスナを全部外す（仕様。Chromium・Firefox で確認）。
 *    このスクリプトの応答待ちのリスナは応答を受けた時点で自分で外し、子に答えるリスナは open() の後に足す。
 * 書式は ES5（srcdoc にそのまま置く。ビルドの変換は通らない）。
 * 試験: guest_bootstrap.test.ts（jsdom で読み込み、要求と document.write の中身を見る）。
 */
(function (win, doc) {
  'use strict';
  var PROTOCOL = 'itera:ipc:v2';
  var DOC_PROTOCOL = 'itera:doc:v1';
  var pid = win.__ITERA_PID__;
  /** 入れ子の文書の 1 段目にだけ在る。親の束の中でこの文書を指す目印 */
  var docId = win.__ITERA_DOC__;
  var nested = typeof docId === 'string' && docId !== '';

  function fail(message) {
    // 本体が無いので、見えるのはこの文字だけ。入口ならホストのコンソールにも同じ失敗が出ている
    doc.body.textContent = message;
  }

  /**
   * 後順（子が先）の資源から object URL を作る。text の資源は、先に並ぶ資源の URL で目印を置き換えてから Blob にする。
   * 入れ子の文書（doc）は 1 段目の文書を URL にし、束は docs に預かる（中の資源の URL は、起きた子が自分の窓で作る）
   */
  function objectUrls(assets, docs) {
    var urls = [];
    for (var i = 0; i < assets.length; i++) {
      var a = assets[i];
      var blob;
      if (a.kind === 'doc') {
        docs[a.id] = a.doc;
        blob = new Blob([a.boot], { type: a.mime });
      } else if (a.kind === 'text') {
        blob = new Blob([substitute(a.text, urls)], { type: a.mime });
      } else {
        blob = a.blob;
      }
      urls.push([a.id, URL.createObjectURL(blob)]);
    }
    return urls;
  }

  /** 目印 → URL の置換（全部の出現。目印は 1 回の compile に固有の印を含むので誤って当たらない） */
  function substitute(text, urls) {
    for (var i = 0; i < urls.length; i++) text = text.split(urls[i][0]).join(urls[i][1]);
    return text;
  }

  /** 起きてきた入れ子の文書に、その束を渡す。枠が同じ文書を何度開いても、そのたびに渡す */
  function serve(docs) {
    win.addEventListener('message', function (e) {
      var m = e.data;
      if (!m || m.protocol !== DOC_PROTOCOL || m.type !== 'req' || !e.source) return;
      var known = Object.prototype.hasOwnProperty.call(docs, m.doc);
      e.source.postMessage(
        {
          protocol: DOC_PROTOCOL,
          type: 'res',
          id: m.id,
          payload: known ? docs[m.doc] : null,
          error: known ? null : 'Unknown document',
        },
        '*',
      );
    });
  }

  function mount(body) {
    var docs = {};
    var html = substitute(body.html, objectUrls(body.assets || [], docs));
    if (body.hash) win.location.hash = body.hash;
    doc.open();
    // open() の後に足したリスナは残る。入れ子の文書を持たない文書には何も足さない
    if (Object.keys(docs).length > 0) serve(docs);
    doc.write(html);
    doc.close();
  }

  if (!nested && (typeof pid !== 'string' || !pid)) {
    fail('Itera bootstrap: __ITERA_PID__ is missing');
    return;
  }

  var nonce = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
  var request = nested
    ? { protocol: DOC_PROTOCOL, type: 'req', id: 'doc-' + nonce, doc: docId }
    : {
        protocol: PROTOCOL,
        type: 'req',
        id: 'boot-' + pid + '-' + nonce,
        source: pid,
        target: 'host',
        action: 'sys:boot',
        payload: {},
        error: null,
      };

  function onResponse(e) {
    var m = e.data;
    if (e.source !== win.parent) return;
    if (!m || m.protocol !== request.protocol || m.type !== 'res' || m.id !== request.id) return;
    win.removeEventListener('message', onResponse);
    if (m.error) {
      fail(
        nested
          ? 'Itera: failed to load a nested document: ' + m.error
          : 'Itera: failed to start "' + pid + '": ' + m.error,
      );
      return;
    }
    mount(m.payload);
  }

  win.addEventListener('message', onResponse);
  win.parent.postMessage(request, '*');
})(window, document);
