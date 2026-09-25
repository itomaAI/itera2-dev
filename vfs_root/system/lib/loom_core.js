/**
 * system/lib/loom_core.js — Loom の核（解析・系譜・全景・転記の判定）。T-0531 / P-0013
 *
 * なぜ切り出したか:
 *   これまで Loom の画面（旧 apps/loom.html）が「画面」と「札の読み書き・運ぶ処理」を 1 本で持っていた。
 *   T-0531 で読み書きをデーモン（system/services/loom.html）へ移すので、**同じ算法を 2 つ持たない**ために
 *   純粋な部分をここへ集める。画面もデーモンもこのファイルを読む。
 *   <script src="/system/lib/loom_core.js"></script>  →  window.LoomCore
 *
 * ここに置くもの:  文字列と配列だけを相手にする関数（VFS を触らない）。
 * ここに置かないもの: 描画（mdRender・nodeCard ほか）と、VFS への書き込み。
 *
 * 札の形: { meta, body }（body は無くてもよい）。
 *   body から導ける事実（最後の日時・計画の進み・文脈の取り込み点・未送の総括の数 …）は
 *   derive() で 1 回だけ計算して n.d に持たせる。索引の行は body を持たず d だけを持つので、
 *   **一覧の描画は本文を読まずにできる**（索引の行と読み込んだ札を同じ関数で扱える）。
 *
 * 記法の正は docs/manual/loom_notation.md
 */
(function (global) {
  'use strict';

  var DIR = 'data/apps/loom';
  // 索引の形の版。derive() の中身を変えたら上げる（版の違う索引の行は信じず読み直す）
  var INDEX_VERSION = 1;

  // ---------- 時刻（toISOString は UTC。JST で 9 時間ずれる —— Handoff で事故った） ----------
  var localDate = function (d) {
    d = d || new Date();
    return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString();
  };
  var todayStr = function () {
    return localDate().slice(0, 10);
  };
  var stamp = function () {
    return localDate().slice(0, 16).replace('T', ' ');
  };
  var nowIso = function () {
    return new Date().toISOString();
  };

  // ---------- 器の型 ----------
  var P_STATUS = {
    live: { label: '生きている', cls: 'text-primary border-primary/40 bg-primary/10' },
    frozen: { label: '凍結', cls: 'text-text-muted border-border-main' },
    superseded: { label: '継承済み', cls: 'text-text-muted border-border-main' },
    abandoned: { label: '放棄', cls: 'text-text-muted border-border-main' },
  };
  // 手番（ball）は status から導く派生値で、保存しない。
  var T_STATUS = {
    inbox: { label: '下書き', ball: 'user', cls: 'text-text-muted border-border-main' },
    todo: { label: '依頼済み', ball: 'ai', cls: 'text-primary border-primary/40 bg-primary/10' },
    doing: { label: '作業中', ball: 'ai', cls: 'text-primary border-primary/40 bg-primary/10' },
    paused: { label: '中断中', ball: 'user', cls: 'text-warning border-warning/40 bg-warning/10' },
    blocked: { label: '質問待ち', ball: 'user', cls: 'text-error border-error/40 bg-error/10' },
    review: { label: '確認待ち', ball: 'user', cls: 'text-warning border-warning/40 bg-warning/10' },
    done: { label: '完了', ball: null, cls: 'text-success border-success/40 bg-success/10' },
    dropped: { label: '中止', ball: null, cls: 'text-text-muted border-border-main' },
  };
  var SECTIONS_P = ['意図', '文脈', '履歴', '成果物'];
  var SECTIONS_T = ['依頼', '計画', '追加要望', '進捗', '確認事項', '成果物'];
  var EVENTS = ['分岐', '継承', '起票', '分解', '完了', '転記', '中止', '再生成', '追随'];

  var isProject = function (n) {
    return !!n && n.meta.kind === 'project';
  };
  var statusDef = function (n) {
    return isProject(n) ? P_STATUS[n.meta.status] || P_STATUS.live : T_STATUS[n.meta.status] || T_STATUS.inbox;
  };
  // 「閉じた」= もう手番が無い。プロジェクトは live 以外、タスクは done/dropped。
  var isClosed = function (n) {
    return isProject(n) ? n.meta.status !== 'live' : n.meta.status === 'done' || n.meta.status === 'dropped';
  };
  var logSection = function (n) {
    return isProject(n) ? '履歴' : '進捗';
  };
  var recapName = function (n) {
    return isProject(n) ? '総括' : 'レポート';
  };
  var ballOf = function (n) {
    return isProject(n) ? null : (T_STATUS[n.meta.status] || {}).ball || null;
  };

  // ============================================================
  // 1. 解析（旧 apps/loom.html から移した。中身は変えていない）
  // ============================================================
  function parseNode(raw) {
    var m = String(raw).match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
    if (!m) return { meta: {}, body: String(raw) };
    var meta = {};
    m[1].split(/\r?\n/).forEach(function (line) {
      var i = line.indexOf(':');
      if (i < 0) return;
      var k = line.slice(0, i).trim();
      var v = line.slice(i + 1).trim();
      if (v === 'true') v = true;
      else if (v === 'false') v = false;
      else if (v.charAt(0) === '[') {
        try {
          v = JSON.parse(v);
        } catch (e) {
          v = [];
        }
      }
      meta[k] = v;
    });
    return { meta: meta, body: m[2] };
  }

  /**
   * front matter を書き戻す。
   * ★ 知らないキーを捨ててはいけない（2026-08-24 / T-0014: 移送で付けた origin が保存で消えていた）。
   *   知っているキーを順に、残りをその後ろに。
   */
  var FM_ORDER = [
    'id',
    'kind',
    'title',
    'status',
    'priority',
    'scheduled',
    'created',
    'updated',
    'parent',
    'supersedes',
    'refs',
  ];
  function serializeNode(meta, body) {
    var live = function (k) {
      return meta[k] !== undefined && meta[k] !== '';
    };
    var keys = FM_ORDER.filter(live).concat(
      Object.keys(meta).filter(function (k) {
        return FM_ORDER.indexOf(k) < 0 && live(k);
      }),
    );
    var fm = keys.map(function (k) {
      return k + ': ' + (Array.isArray(meta[k]) ? JSON.stringify(meta[k]) : meta[k]);
    });
    return '---\n' + fm.join('\n') + '\n---\n\n' + String(body).trim() + '\n';
  }

  function sectionRange(body, name) {
    var lines = String(body).split('\n');
    var s = -1;
    for (var i = 0; i < lines.length; i++)
      if (lines[i].trim() === '## ' + name) {
        s = i;
        break;
      }
    if (s < 0) return null;
    var e = s + 1;
    while (e < lines.length && !/^## /.test(lines[e])) e++;
    return [s + 1, e];
  }

  function sectionText(body, name) {
    var r = sectionRange(body, name);
    if (!r) return '';
    return String(body).split('\n').slice(r[0], r[1]).join('\n').trim();
  }

  function sectionNames(body) {
    return String(body)
      .split('\n')
      .filter(function (l) {
        return /^## /.test(l);
      })
      .map(function (l) {
        return l.slice(3).trim();
      });
  }

  function appendToSection(body, section, text) {
    var lines = String(body).split('\n');
    var head = -1;
    for (var i = 0; i < lines.length; i++)
      if (lines[i].trim() === '## ' + section) {
        head = i;
        break;
      }
    if (head < 0) return String(body).trim() + '\n\n## ' + section + '\n' + text + '\n';
    var end = head + 1;
    while (end < lines.length && !/^## /.test(lines[end])) end++;
    var at = end;
    while (at > head + 1 && lines[at - 1].trim() === '') at--;
    lines.splice(at, 0, text);
    return lines.join('\n');
  }

  // 節を丸ごと置き換える。**文脈にだけ使う**（写しなので畳み直してよい）。履歴・進捗には絶対に使わない。
  function replaceSection(body, section, text) {
    var lines = String(body).split('\n');
    var head = -1;
    for (var i = 0; i < lines.length; i++)
      if (lines[i].trim() === '## ' + section) {
        head = i;
        break;
      }
    if (head < 0) return String(body).trim() + '\n\n## ' + section + '\n\n' + text + '\n';
    var end = head + 1;
    while (end < lines.length && !/^## /.test(lines[end])) end++;
    var tail = lines.slice(end);
    return lines
      .slice(0, head + 1)
      .concat('', String(text).trim(), '')
      .concat(tail)
      .join('\n');
  }

  // 計画のチェックボックス。[ ]=未着手 [~]=作業中 [x]=完了
  function planStats(body) {
    var r = sectionRange(body, '計画');
    if (!r) return null;
    var lines = String(body).split('\n').slice(r[0], r[1]);
    var done = 0,
      doing = 0,
      total = 0;
    lines.forEach(function (l) {
      var m = l.match(/^\s*- \[( |x|X|~)\]/);
      if (!m) return;
      total++;
      var s = m[1].toLowerCase();
      if (s === 'x') done++;
      else if (s === '~') doing++;
    });
    return total ? { done: done, doing: doing, total: total } : null;
  }

  /** ## 文脈 を読む。取り込み点は front matter に持たず、最後の「… まで」から導く。 */
  function parseContext(body) {
    var r = sectionRange(body, '文脈');
    if (!r) return [];
    var lines = String(body).split('\n').slice(r[0], r[1]);
    var out = [];
    var cur = null;
    lines.forEach(function (l) {
      var src = l.match(/^###\s+([^「\s]+)\s*(?:「([^」]*)」)?\s*より\s*$/);
      if (src) {
        cur = { source: src[1], title: src[2] || '', external: !/^(?:P|T)-\d{4}$/.test(src[1]), marks: [] };
        out.push(cur);
        return;
      }
      var mk = l.match(/^####\s+(生成|追随|再生成)\s+(\d{4}-\d{2}-\d{2} \d{2}:\d{2})\s*(?:[（(]([^）)]*)[）)])?\s*$/);
      if (mk && cur) {
        var note = mk[3] || '';
        var upto = (note.match(/(\d{4}-\d{2}-\d{2} \d{2}:\d{2})\s*まで/) || [])[1] || '';
        cur.marks.push({ kind: mk[1], at: mk[2], upto: upto, note: note });
      }
    });
    out.forEach(function (c) {
      var withUpto = c.marks.filter(function (m) {
        return m.upto;
      });
      c.watermark = withUpto.length ? withUpto[withUpto.length - 1].upto : '';
    });
    return out;
  }

  /**
   * 履歴・進捗の中の `### 総括 日時` / `### レポート 日時` を拾う。
   * 転記で運ばれてきた塊（`### 総括 日時（P-0002）`）は from に出どころを入れて区別する。
   * 枠は「次の見出し」または「次の日時つきの行」で閉じる（記法 §0 / T-0195）。
   * start / end は body 全体での行の添字（枠の中へ差し込むのに使う。T-0200）。
   */
  function parseRecaps(body, section, name) {
    var r = sectionRange(body, section);
    if (!r) return [];
    var lines = String(body).split('\n').slice(r[0], r[1]);
    var out = [];
    var cur = null;
    var close = function (i) {
      if (cur) cur.end = r[0] + i - 1;
      cur = null;
    };
    var H = new RegExp(
      '^###\\s+' + name + '\\s+(\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2})\\s*(?:[（(]\\s*((?:P|T)-\\d{4})\\s*[）)])?',
    );
    for (var i = 0; i < lines.length; i++) {
      var l = lines[i];
      var h = l.match(H);
      if (h) {
        close(i);
        cur = { at: h[1], from: h[2] || '', lines: [], start: r[0] + i, end: r[1] - 1 };
        out.push(cur);
        continue;
      }
      if (/^###\s/.test(l)) {
        close(i);
        continue;
      }
      if (cur && /^\s*- \d{4}-\d{2}-\d{2} \d{2}:\d{2}(\s|$)/.test(l)) {
        close(i);
        continue;
      }
      if (cur) cur.lines.push(l);
    }
    out.forEach(function (c) {
      c.text = c.lines.join('\n').trim();
    });
    return out;
  }

  /** 追記行（日時つき）の一覧。出来事なら verb が入る。 */
  function parseEntries(body, section) {
    var r = sectionRange(body, section);
    if (!r) return [];
    var lines = String(body).split('\n').slice(r[0], r[1]);
    var out = [];
    lines.forEach(function (l) {
      var m = l.match(/^\s*- (\d{4}-\d{2}-\d{2} \d{2}:\d{2})\s+([^:：]+)[:：]\s*(.*)$/);
      if (!m) return;
      var who = m[2].trim();
      out.push({ at: m[1], who: who, verb: EVENTS.indexOf(who) >= 0 ? who : null, text: m[3], raw: l });
    });
    return out;
  }

  /** 自分が書いた総括・レポート（転記で運ばれてきた子のものを除く） */
  function ownRecaps(n) {
    return parseRecaps(n.body, logSection(n), recapName(n)).filter(function (r) {
      return !r.from || r.from === n.meta.id;
    });
  }

  /**
   * まだ親へ渡していない総括。基準は「転記した時刻」ではなく「どこまで渡したか」（総括の時間軸どうしで比べる）。
   */
  function pendingRecaps(n) {
    var rs = ownRecaps(n);
    var pushes = parseEntries(n.body, logSection(n)).filter(function (e) {
      return e.verb === '転記' && /へ/.test(e.text);
    });
    if (!pushes.length) return rs;
    var last = pushes[pushes.length - 1];
    var upto = (String(last.text).match(/(\d{4}-\d{2}-\d{2} \d{2}:\d{2})\s*まで/) || [])[1] || last.at;
    return rs.filter(function (r) {
      return r.at > upto;
    });
  }

  // ============================================================
  // 2. 派生値（本文から 1 回だけ導く。索引の行はこれだけを持つ）
  // ============================================================
  /**
   * body から導ける事実。**一覧の描画・系譜・全景・運んだかの判定は、これと meta だけで足りる。**
   *   lastLogAt  … 履歴／進捗の最後の日時（文脈の古びの判定に使う）
   *   plan       … 計画の進み { done, doing, total } | null
   *   ctx        … 文脈の源と取り込み点 [{ source, title, external, watermark }]
   *   pending    … まだ親へ渡していない自分の総括の数（プロジェクトの「↑ n」）
   *   ownRecaps  … 自分が書いた総括／レポートの数（「レポートに追記」ボタンを出すか）
   *   reports    … 進捗の中のレポートの数（タスクを確認へ回せるか）
   *   completed  … この札の履歴／進捗に「完了: <id>」として載っている id（＝運んだ証拠）
   *   sections   … 節の見出しの並び（壊れた札を見つけるため）
   *   lines      … 本文の行数
   */
  function derive(n) {
    var body = n.body == null ? '' : String(n.body);
    var node = { meta: n.meta, body: body };
    var entries = parseEntries(body, logSection(node));
    var completed = [];
    entries.forEach(function (e) {
      if (e.verb !== '完了') return;
      var m = String(e.text).match(/^\s*((?:P|T)-\d{4})/);
      if (m && completed.indexOf(m[1]) < 0) completed.push(m[1]);
    });
    return {
      v: INDEX_VERSION,
      lastLogAt: entries.length ? entries[entries.length - 1].at : '',
      plan: isProject(node) ? null : planStats(body),
      ctx: isProject(node)
        ? parseContext(body).map(function (c) {
            return { source: c.source, title: c.title, external: c.external, watermark: c.watermark };
          })
        : [],
      pending: pendingRecaps(node).length,
      ownRecaps: ownRecaps(node).length,
      reports: isProject(node) ? 0 : parseRecaps(body, '進捗', 'レポート').length,
      completed: completed,
      sections: sectionNames(body),
      lines: body.split('\n').length,
    };
  }

  /** n.d が無ければ body から作る（body も無ければ空の派生値） */
  function dOf(n) {
    if (!n) return null;
    if (!n.d || n.d.v !== INDEX_VERSION) n.d = derive(n);
    return n.d;
  }

  // ============================================================
  // 3. 系譜（札の配列を引数に取る。グローバルの nodes には頼らない）
  // ============================================================
  var byIdAsc = function (a, b) {
    return String(a.meta.id).localeCompare(String(b.meta.id));
  };

  /**
   * 札の配列から系譜の関数群を作る。配列が変わったら作り直す（中で id の表を持つ）。
   * getNodes を関数で渡すと、呼ぶたびに最新の配列を見る（画面側はこちら）。
   */
  function lineage(getNodes) {
    var get =
      typeof getNodes === 'function'
        ? getNodes
        : function () {
            return getNodes;
          };
    var cacheList = null,
      cacheMap = null;
    var map = function () {
      var list = get() || [];
      if (list !== cacheList) {
        cacheList = list;
        cacheMap = new Map();
        list.forEach(function (n) {
          if (!cacheMap.has(n.meta.id)) cacheMap.set(n.meta.id, n);
        });
      }
      return cacheMap;
    };
    var byId = function (id) {
      return map().get(id) || null;
    };
    var directChildren = function (id) {
      return (get() || [])
        .filter(function (n) {
          return n.meta.parent === id;
        })
        .sort(byIdAsc);
    };
    var predecessors = function (id) {
      var out = [];
      var seen = new Set([id]);
      var cur = byId(id);
      while (cur && cur.meta.supersedes && !seen.has(cur.meta.supersedes)) {
        seen.add(cur.meta.supersedes);
        var p = byId(cur.meta.supersedes);
        if (!p) break;
        out.push(p);
        cur = p;
      }
      return out;
    };
    var successorOf = function (id) {
      return (
        (get() || []).find(function (n) {
          return n.meta.supersedes === id;
        }) || null
      );
    };
    // 子を継承で引き継ぐ。**辺は書き換えない**（子の parent は前任を指したまま、ここで合併する）
    var childrenOf = function (id) {
      var n = byId(id);
      var ids = [id].concat(
        isProject(n)
          ? predecessors(id).map(function (p) {
              return p.meta.id;
            })
          : [],
      );
      var seen = new Set();
      var out = [];
      ids.forEach(function (i) {
        directChildren(i).forEach(function (c) {
          if (!seen.has(c.meta.id)) {
            seen.add(c.meta.id);
            out.push(c);
          }
        });
      });
      return out.sort(byIdAsc);
    };
    // 親を根まで（根が先頭）。継承の前任は親ではないので辿らない
    var ancestorsOf = function (id) {
      var out = [];
      var seen = new Set([id]);
      var cur = byId(id);
      while (cur && cur.meta.parent && !seen.has(cur.meta.parent)) {
        seen.add(cur.meta.parent);
        var p = byId(cur.meta.parent);
        if (!p) break;
        out.unshift(p);
        cur = p;
      }
      return out;
    };
    // 所属プロジェクト＝祖先を遡って最初に現れたプロジェクト。そこから後継を辿って生きている世代に着地する
    var owningProject = function (n) {
      if (!n) return null;
      var p = isProject(n) ? n : null;
      if (!p) {
        var anc = ancestorsOf(n.meta.id).slice().reverse();
        for (var i = 0; i < anc.length; i++)
          if (isProject(anc[i])) {
            p = anc[i];
            break;
          }
      }
      if (!p) return null;
      var seen = new Set();
      var cur = p;
      while (cur && !seen.has(cur.meta.id)) {
        seen.add(cur.meta.id);
        var s = successorOf(cur.meta.id);
        if (!s) break;
        cur = s;
      }
      return cur;
    };
    /**
     * 本文中の P-0001 / T-0001 を、表示のときに現在の題へ解決する。
     * 書かれている題があっても上書きする（出来事の行には起票時の仮の題が焼き付き、履歴は書き換えないため）。
     * 札が見つからないときだけ、書かれている題を残す。
     */
    var resolveTitles = function (s) {
      return String(s).replace(/((?:P|T)-\d{4})(\s*「[^」]*」)?/g, function (m, id, written) {
        var t = byId(id);
        return t ? id + '「' + t.meta.title + '」' : written ? id + written : id;
      });
    };
    var tasksOf = function (id) {
      return childrenOf(id).filter(function (c) {
        return !isProject(c);
      });
    };
    var subProjectsOf = function (id) {
      return childrenOf(id).filter(isProject);
    };
    var projectRoots = function () {
      return (get() || [])
        .filter(function (n) {
          return isProject(n) && (!n.meta.parent || !byId(n.meta.parent));
        })
        .sort(byIdAsc);
    };
    var lastLogAt = function (n) {
      return dOf(n).lastLogAt;
    };
    /** 源が伸びているか（追随が要るか）。畳んだ辺だけが古びる。 */
    var staleSources = function (n) {
      if (!isProject(n)) return [];
      var out = [];
      dOf(n).ctx.forEach(function (c) {
        if (c.external) return; // 外の文書は Loom の履歴を持たないので、伸びたかを機械では言えない
        var src = byId(c.source);
        if (!src) {
          out.push(Object.assign({}, c, { missing: true }));
          return;
        }
        var head = lastLogAt(src);
        if (head && (!c.watermark || c.watermark < head)) out.push(Object.assign({}, c, { head: head }));
      });
      return out;
    };
    /**
     * もう親へ運ばれたか。**証拠は親の履歴にある**（`- <日時> 完了: <id>「…」`）。
     * 札の側に印を作らない —— 作ると旧仕様で閉じた札を拾えない。
     */
    var deliveredAlready = function (t) {
      var hit = function (p) {
        return !!p && dOf(p).completed.indexOf(t.meta.id) >= 0;
      };
      return hit(owningProject(t)) || hit(byId(t.meta.parent));
    };
    return {
      byId: byId,
      directChildren: directChildren,
      predecessors: predecessors,
      successorOf: successorOf,
      childrenOf: childrenOf,
      ancestorsOf: ancestorsOf,
      owningProject: owningProject,
      resolveTitles: resolveTitles,
      tasksOf: tasksOf,
      subProjectsOf: subProjectsOf,
      projectRoots: projectRoots,
      lastLogAt: lastLogAt,
      staleSources: staleSources,
      deliveredAlready: deliveredAlready,
    };
  }

  // ============================================================
  // 4. 全景（板の健全さ。meta だけで数える）
  // ============================================================
  function censusOf(list) {
    var ids = new Set(
      list.map(function (n) {
        return n.meta.id;
      }),
    );
    var kidsOf = new Map();
    list.forEach(function (n) {
      var p = n.meta.parent;
      if (!p) return;
      if (!kidsOf.has(p)) kidsOf.set(p, []);
      kidsOf.get(p).push(n);
    });
    var proj = list.filter(isProject);
    var task = list.filter(function (n) {
      return !isProject(n);
    });
    var count = function (arr, key) {
      var m = {};
      arr.forEach(function (n) {
        var k = n.meta[key] || '(無し)';
        m[k] = (m[k] || 0) + 1;
      });
      return m;
    };
    var dup = {};
    list.forEach(function (n) {
      dup[n.meta.id] = (dup[n.meta.id] || 0) + 1;
    });
    var descCount = function (id, seen) {
      seen = seen || new Set();
      var c = 0;
      (kidsOf.get(id) || []).forEach(function (k) {
        if (seen.has(k.meta.id)) return;
        seen.add(k.meta.id);
        c += 1 + descCount(k.meta.id, seen);
      });
      return c;
    };
    var ball = { ai: 0, user: 0, none: 0 };
    task.forEach(function (t) {
      var b = (T_STATUS[t.meta.status] || {}).ball;
      ball[b === 'ai' ? 'ai' : b === 'user' ? 'user' : 'none']++;
    });
    return {
      total: list.length,
      projects: proj.length,
      tasks: task.length,
      pStatus: count(proj, 'status'),
      tStatus: count(task, 'status'),
      ball: ball,
      orphans: list.filter(function (n) {
        return n.meta.parent && !ids.has(n.meta.parent);
      }),
      badEdges: list.filter(function (n) {
        if (!isProject(n) || !n.meta.parent) return false;
        var p = list.find(function (x) {
          return x.meta.id === n.meta.parent;
        });
        return p && !isProject(p);
      }),
      dupIds: Object.keys(dup)
        .filter(function (id) {
          return dup[id] > 1;
        })
        .map(function (id) {
          return { id: id, c: dup[id] };
        }),
      roots: proj
        .filter(function (p) {
          return !p.meta.parent || !ids.has(p.meta.parent);
        })
        .map(function (r) {
          return { id: r.meta.id, title: r.meta.title, status: r.meta.status, desc: descCount(r.meta.id) };
        }),
      topParents: Array.from(kidsOf.entries())
        .filter(function (e) {
          return ids.has(e[0]);
        })
        .map(function (e) {
          return { id: e[0], n: e[1].length };
        })
        .sort(function (a, b) {
          return b.n - a.n;
        })
        .slice(0, 6),
    };
  }

  // ============================================================
  // 5. 新しい札の本文・id
  // ============================================================
  function newBody(kind) {
    if (kind === 'project') {
      return [
        '## 意図',
        '',
        '（なぜこの枝が在るのか。**あなたが置く。**ほぼ不変。これが圧縮の鍵になる。',
        '　満たされて消えるものは意図ではない。それはタスクの依頼）',
        '',
        '## 文脈',
        '',
        '（外の世界のうち、この枝に効くもの。Itera が畳む。源ごとに ### を立てる）',
        '',
        '## 履歴',
        '',
        '## 成果物',
        '',
      ].join('\n');
    }
    return [
      '## 依頼',
      '',
      '（何が満たされたら終わりか）',
      '',
      '## 計画',
      '',
      '（Itera が着手時に分解して書く。☐ をクリックすると 未着手→作業中→完了）',
      '',
      '## 追加要望',
      '',
      '## 進捗',
      '',
      '## 確認事項',
      '',
      '## 成果物',
      '',
    ].join('\n');
  }

  /** id はプロジェクトとタスクで別の番号帯（本文中の参照だけで型が読めるように） */
  function nextId(ids, kind) {
    var pre = kind === 'project' ? 'P-' : 'T-';
    var max = 0;
    (ids || []).forEach(function (id) {
      if (String(id).slice(0, 2) !== pre) return;
      var v = parseInt(String(id).slice(2), 10);
      if (!isNaN(v) && v > max) max = v;
    });
    return pre + String(max + 1).padStart(4, '0');
  }

  /** 'T-0001.md' / 'data/apps/loom/T-0001.md' → 'T-0001'。札でなければ null */
  function idOfPath(p) {
    var m = /(?:^|\/)([PT]-\d+)\.md$/.exec(String(p || ''));
    return m ? m[1] : null;
  }

  // ============================================================
  // 6. 自己試験（純粋な部分だけ。描画の試験は画面側の selfTest に残す）
  // ============================================================
  function selfTest() {
    var R = [];
    var ok = function (name, cond, got) {
      R.push({ name: name, pass: !!cond, got: cond ? undefined : got });
    };
    var raw = [
      '---',
      'id: P-0002',
      'kind: project',
      'title: テスト',
      'status: live',
      'parent: P-0001',
      'supersedes: P-0009',
      'refs: ["a.md","b.md"]',
      '---',
      '',
      '## 意図',
      '',
      'これは意図。',
      '',
      '## 文脈',
      '',
      '### P-0001「親の題」より',
      '',
      '#### 生成 2026-08-21 10:00（P-0001 を 2026-08-21 09:30 まで）',
      '',
      '- 畳んだ中身',
      '',
      '#### 追随 2026-08-23 17:00（2026-08-23 16:00 まで）',
      '',
      '- 差分',
      '',
      '## 履歴',
      '',
      '- 2026-08-22 10:00 分岐: P-0003「子」',
      '### 総括 2026-08-22 12:00',
      '',
      '**決定**',
      '- 決めた ／ 理由 ／ 対象: x.md',
      '',
      '- 2026-08-22 13:00 転記: P-0001「親の題」へ（1 件）',
      '### 総括 2026-08-23 09:00',
      '',
      '**決定**',
      '- 二つ目',
      '',
      '- 2026-08-23 10:00 Itera: ただの追記',
      '- 2026-08-23 11:00 完了: T-0042「何か」 ／ 成果物あり',
      '',
      '## 成果物',
      '',
      '- out.md',
      '',
    ].join('\n');

    var n = parseNode(raw);
    ok('front matter を読む', n.meta.id === 'P-0002' && n.meta.kind === 'project', n.meta);
    ok('refs が配列になる', Array.isArray(n.meta.refs) && n.meta.refs.length === 2, n.meta.refs);
    ok('節を切り出す', sectionText(n.body, '意図') === 'これは意図。', sectionText(n.body, '意図'));
    var ctx = parseContext(n.body);
    ok('文脈の源を 1 つ読む', ctx.length === 1 && ctx[0].source === 'P-0001', ctx);
    ok('取り込み点は最後の「まで」', ctx[0] && ctx[0].watermark === '2026-08-23 16:00', ctx[0] && ctx[0].watermark);
    var ec = parseContext(
      [
        '## 文脈',
        '',
        '### data/apps/handoff/tasks/T-0078.md「語彙」より',
        '',
        '#### 生成 2026-08-23 19:00（2026-08-23 18:00 まで）',
        '',
      ].join('\n'),
    );
    ok('外の文書も源にできる', ec.length === 1 && ec[0].external === true, ec);
    var rs = parseRecaps(n.body, '履歴', '総括');
    ok(
      '総括を 2 つ読む',
      rs.length === 2,
      rs.map(function (r) {
        return r.at;
      }),
    );
    var es = parseEntries(n.body, '履歴');
    ok(
      '出来事の動詞を見分ける',
      es.filter(function (e) {
        return e.verb;
      }).length === 3,
      es.map(function (e) {
        return e.verb;
      }),
    );
    ok('未送の総括は転記より後だけ', pendingRecaps({ meta: { kind: 'project' }, body: n.body }).length === 1, null);

    var carried = [
      '## 履歴',
      '',
      '### 総括 2026-08-23 12:00',
      '',
      '- 自分の決定',
      '',
      '- 2026-08-23 13:00 転記: P-0009「子」より（2026-08-23 11:00 以降の総括 1 件）',
      '### 総括 2026-08-23 11:00（P-0009）',
      '',
      '- 子の決定',
      '',
    ].join('\n');
    ok(
      '未送に数えるのは自分の総括だけ',
      pendingRecaps({ meta: { kind: 'project', id: 'P-0001' }, body: carried }).length === 1,
      null,
    );

    var framed = [
      '## 進捗',
      '',
      '- 2026-08-24 00:10 Itera: 着手した',
      '### レポート 2026-08-24 00:30',
      '',
      '**決定**',
      '- これはレポートの中身',
      '',
      '- 2026-08-24 00:42 Itera: レポートの後に書いた追記',
    ].join('\n');
    var fr = parseRecaps(framed, '進捗', 'レポート');
    ok(
      'レポートの枠は次の日時つきの行で閉じる',
      fr.length === 1 && !/追記/.test(fr[0].text) && /中身/.test(fr[0].text),
      fr,
    );

    var skewed = [
      '## 履歴',
      '',
      '### 総括 2026-08-23 19:20',
      '',
      '- 未来',
      '',
      '- 2026-08-23 18:40 転記: P-0001「親」へ（2026-08-23 19:20 まで／1 件）',
    ].join('\n');
    ok('時計がずれても渡し済みと分かる', pendingRecaps({ meta: { kind: 'project' }, body: skewed }).length === 0, null);

    var appended = appendToSection(n.body, '履歴', '- 2026-08-23 12:00 Itera: 追記した');
    ok(
      '追記が節の末尾に入る',
      /追記した\n\n## 成果物/.test(appended) || /追記した\n## 成果物/.test(appended),
      appended.slice(-120),
    );
    var replaced = replaceSection(n.body, '文脈', '### P-0001「親の題」より\n\n- 畳み直した');
    ok(
      '文脈を置換しても他の節が残る',
      /## 履歴/.test(replaced) && /## 成果物/.test(replaced) && !/差分/.test(replaced),
      null,
    );
    var round = parseNode(serializeNode(n.meta, n.body));
    ok(
      '直列化して読み直せる',
      round.meta.id === 'P-0002' && sectionText(round.body, '意図') === 'これは意図。',
      round.meta,
    );
    var extra = serializeNode(
      { id: 'T-9300', kind: 'task', title: 'x', status: 'todo', origin: 'o.md', scheduled_note: 'めも' },
      '## 依頼\n本文',
    );
    ok(
      '知らない front matter のキーを落とさない',
      /origin: o\.md/.test(extra) && /scheduled_note: めも/.test(extra),
      extra,
    );

    // 派生値
    var d = derive(n);
    ok('派生: 最後の日時', d.lastLogAt === '2026-08-23 11:00', d.lastLogAt);
    ok('派生: 文脈の取り込み点', d.ctx.length === 1 && d.ctx[0].watermark === '2026-08-23 16:00', d.ctx);
    ok('派生: 未送の総括の数', d.pending === 1, d.pending);
    ok('派生: 運んだ証拠の id', d.completed.length === 1 && d.completed[0] === 'T-0042', d.completed);
    ok('派生: 節の並び', d.sections.join(',') === '意図,文脈,履歴,成果物', d.sections);

    // 系譜（索引の行＝body の無い札でも動くこと）
    var mk = function (id, kind, status, parent, dd, extraMeta) {
      var meta = Object.assign(
        { id: id, kind: kind, title: id, status: status, parent: parent || '' },
        extraMeta || {},
      );
      return { meta: meta, d: Object.assign(derive({ meta: meta, body: '' }), dd || {}) };
    };
    var board = [
      mk('P-9100', 'project', 'live', ''),
      mk('P-9101', 'project', 'live', 'P-9100', {
        completed: ['T-9101'],
        ctx: [{ source: 'P-9100', title: '', external: false, watermark: '2026-08-01 00:00' }],
      }),
      mk('T-9100', 'task', 'todo', 'P-9101'),
      mk('T-9101', 'task', 'done', 'P-9101'),
      mk('T-9102', 'task', 'review', 'T-9100'),
      mk('P-9102', 'project', 'live', '', null, { supersedes: 'P-9101' }),
    ];
    board[0].d.lastLogAt = '2026-09-01 00:00';
    var L = lineage(board);
    ok(
      '系譜: 祖先は根から',
      L.ancestorsOf('T-9102')
        .map(function (n) {
          return n.meta.id;
        })
        .join(',') === 'P-9100,P-9101,T-9100',
      null,
    );
    ok('系譜: 所属は後継に着地する', L.owningProject(L.byId('T-9102')).meta.id === 'P-9102', null);
    ok(
      '系譜: 継承で子を引き継ぐ',
      L.childrenOf('P-9102').length === 2,
      L.childrenOf('P-9102').map(function (n) {
        return n.meta.id;
      }),
    );
    // T-9101 は親 P-9101 の履歴に「完了: T-9101」がある（所属は後継 P-9102 に着地するが、親の側でも見る）
    ok(
      '系譜: 運んだ証拠を派生値から見る',
      L.deliveredAlready(L.byId('T-9101')) === true && L.deliveredAlready(L.byId('T-9100')) === false,
      null,
    );
    ok('系譜: 源が伸びていれば古び', L.staleSources(L.byId('P-9101')).length === 1, L.staleSources(L.byId('P-9101')));
    ok(
      '系譜: 題の解決',
      L.resolveTitles('起票: T-9100「(無題)」') === '起票: T-9100「T-9100」',
      L.resolveTitles('起票: T-9100「(無題)」'),
    );
    var cs = censusOf(board.concat([mk('T-9103', 'task', 'todo', 'P-0000')]));
    ok('全景: 系譜から切れた札を拾う', cs.orphans.length === 1 && cs.orphans[0].meta.id === 'T-9103', null);
    ok(
      '採番: 番号帯ごとの最大 +1',
      nextId(['T-0009', 'P-0100', 'T-0010'], 'task') === 'T-0011' && nextId([], 'project') === 'P-0001',
      null,
    );
    ok(
      'パスから id',
      idOfPath('data/apps/loom/T-0531.md') === 'T-0531' && idOfPath('data/apps/loom_ui.json') === null,
      null,
    );

    var pass = R.filter(function (r) {
      return r.pass;
    }).length;
    return {
      pass: pass,
      fail: R.length - pass,
      results: R.filter(function (r) {
        return !r.pass;
      }),
      all: R.map(function (r) {
        return (r.pass ? 'OK ' : 'NG ') + r.name;
      }),
    };
  }

  var api = {
    DIR: DIR,
    INDEX_VERSION: INDEX_VERSION,
    localDate: localDate,
    todayStr: todayStr,
    stamp: stamp,
    nowIso: nowIso,
    P_STATUS: P_STATUS,
    T_STATUS: T_STATUS,
    SECTIONS_P: SECTIONS_P,
    SECTIONS_T: SECTIONS_T,
    EVENTS: EVENTS,
    isProject: isProject,
    statusDef: statusDef,
    isClosed: isClosed,
    logSection: logSection,
    recapName: recapName,
    ballOf: ballOf,
    FM_ORDER: FM_ORDER,
    parseNode: parseNode,
    serializeNode: serializeNode,
    sectionRange: sectionRange,
    sectionText: sectionText,
    sectionNames: sectionNames,
    appendToSection: appendToSection,
    replaceSection: replaceSection,
    planStats: planStats,
    parseContext: parseContext,
    parseRecaps: parseRecaps,
    parseEntries: parseEntries,
    ownRecaps: ownRecaps,
    pendingRecaps: pendingRecaps,
    derive: derive,
    dOf: dOf,
    byIdAsc: byIdAsc,
    lineage: lineage,
    censusOf: censusOf,
    newBody: newBody,
    nextId: nextId,
    idOfPath: idOfPath,
    selfTest: selfTest,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.LoomCore = api;
})(typeof window !== 'undefined' ? window : globalThis);
