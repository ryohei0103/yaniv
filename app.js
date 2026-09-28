(() => {
  const { url: SUPABASE_URL, anonKey: ANON } = window.YANIV_CONFIG;
  const FN = SUPABASE_URL + "/functions/v1/yaniv";

  const $ = (id) => document.getElementById(id);
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} },
    del(k) { try { localStorage.removeItem(k); } catch (e) {} },
  };

  // この端末のプレイヤーを識別する秘密の値。サーバーにはハッシュだけが保存される
  let token = store.get("yaniv.token");
  if (!token) { token = crypto.randomUUID() + crypto.randomUUID(); store.set("yaniv.token", token); }

  let code = null, subscribed = null, view = null, me = null, sel = [], busy = false, channel = null, poll = null;
  const sb = window.supabase ? window.supabase.createClient(SUPABASE_URL, ANON) : null;

  // ---------- カード ----------
  const isRed = (c) => c.s === "♥" || c.s === "♦";
  const rankLabel = (r) => r === 0 ? "★" : r === 1 ? "A" : r === 11 ? "J" : r === 12 ? "Q" : r === 13 ? "K" : String(r);
  const cardText = (c) => c.r === 0 ? "ジョーカー" : c.s + rankLabel(c.r);
  const val = (c) => c.r === 0 ? (view ? view.rules.joker : 0) : c.r === 13 ? -1 : c.r;
  const sum = (cs) => cs.reduce((a, c) => a + val(c), 0);
  const yanivLimit = () => (view && view.rules.limit) || 5;
  const signed = (n) => n < 0 ? `−${-n}` : `+${n}`;

  function setType(cs) {
    if (!cs.length) return null;
    if (cs.length === 1) return "single";
    const nj = cs.filter((c) => c.r > 0), jk = cs.length - nj.length;
    if (nj.length === 0 || nj.every((c) => c.r === nj[0].r)) return "set";
    if (cs.length >= 3 && nj.every((c) => c.s === nj[0].s)) {
      const rs = nj.map((c) => c.r).sort((a, b) => a - b);
      for (let i = 1; i < rs.length; i++) if (rs[i] === rs[i - 1]) return null;
      if (rs[rs.length - 1] - rs[0] + 1 - rs.length <= jk) return "run";
    }
    return null;
  }
  const pickable = (p) => p.type === "run" ? [0, p.cards.length - 1] : p.cards.map((_, i) => i);

  function cardEl(c, opts = {}) {
    const el = document.createElement(opts.tag || "div");
    el.className = "card" + (isRed(c) ? " red" : "") + (c.r === 0 ? " joker" : "") + (opts.mini ? " mini" : "");
    if (el.tagName === "BUTTON") el.type = "button";
    el.setAttribute("aria-label", cardText(c));
    el.innerHTML = c.r === 0
      ? `<div class="mid"><em>★</em><span>JOKER</span></div>`
      : `<div class="c"><span class="r">${rankLabel(c.r)}</span><span class="s">${c.s}</span></div><div class="mid">${c.s}</div>`;
    return el;
  }
  const esc = (s) => String(s).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);

  // ---------- 通信 ----------
  async function api(action, body = {}) {
    const res = await fetch(FN, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + ANON, apikey: ANON },
      body: JSON.stringify({ action, code, token, ...body }),
    });
    let data;
    try { data = await res.json(); } catch (e) { data = { error: "通信に失敗しました" }; }
    if (!res.ok || data.error) { const err = new Error(data.error || "通信に失敗しました"); err.status = res.status; throw err; }
    return data;
  }

  async function act(action, body) {
    if (busy) return;
    busy = true; render();
    try { apply(await api(action, body)); }
    catch (e) { toast(e.message); refresh(); }
    finally { busy = false; render(); }
  }

  function apply(data) {
    if (!data || !data.view) return;
    if (data.code) code = data.code;
    if (code && subscribed !== code) subscribe();
    view = data.view; me = data.me;
    const hand = me.hand.map((c) => c.id);
    sel = sel.filter((id) => hand.includes(id));
    render();
    driveCpu();
  }

  // CPUの番になったら、少し待ってからサーバーに1手進めてもらう（部屋にいる誰の画面からでもよい）
  let cpuTimer = null, cpuKey = null;
  function driveCpu() {
    if (!view || view.phase !== "play" || !view.players[view.turn] || !view.players[view.turn].cpu) {
      clearTimeout(cpuTimer); cpuKey = null; return;
    }
    const key = `${view.round}:${view.turn}:${view.log}`;
    if (key === cpuKey) return;
    cpuKey = key;
    clearTimeout(cpuTimer);
    cpuTimer = setTimeout(async () => {
      try { apply(await api("cpu")); } catch (e) {}
      cpuKey = null;
      driveCpu();
    }, 1200);
  }

  let refreshing = false, again = false;
  async function refresh() {
    if (!code) return;
    if (refreshing) { again = true; return; }
    refreshing = true;
    try { apply(await api("state")); }
    catch (e) { if (e.status === 403 || e.status === 404) { toast(e.message); leaveLocal(); } }
    finally { refreshing = false; if (again) { again = false; refresh(); } }
  }

  function subscribe() {
    if (channel) { sb.removeChannel(channel); channel = null; }
    clearInterval(poll);
    subscribed = code;
    if (!code) return;
    store.set("yaniv.room", code);
    history.replaceState(null, "", `?room=${code}`);
    if (sb) {
      channel = sb.channel("yaniv-" + code)
        .on("postgres_changes", { event: "*", schema: "public", table: "yaniv_public", filter: `code=eq.${code}` }, () => refresh())
        .subscribe();
    }
    // Realtime が切れても追いつけるように、ゆっくり定期確認もする
    poll = setInterval(() => { if (!document.hidden) refresh(); }, 8000);
  }

  function leaveLocal() {
    if (channel && sb) sb.removeChannel(channel);
    channel = null; clearInterval(poll);
    code = null; subscribed = null; view = null; me = null; sel = [];
    store.del("yaniv.room");
    history.replaceState(null, "", location.pathname);
    render();
  }

  async function leave() {
    if (view && view.phase === "play") { toast("ゲーム中は退出できません。ラウンドが終わってからにしてください"); return; }
    try { await api("leave"); } catch (e) {}
    leaveLocal();
  }

  let toastTimer = null;
  function toast(msg) {
    const t = $("toast"); t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 3200);
  }

  // ---------- 描画 ----------
  function render() {
    const screen = !view ? "join" : view.phase === "lobby" ? "lobby" : "game";
    $("screenJoin").hidden = screen !== "join";
    $("screenLobby").hidden = screen !== "lobby";
    $("screenGame").hidden = screen !== "game";
    if (screen === "join") renderJoin();
    else if (screen === "lobby") renderLobby();
    else renderGame();
  }

  function renderJoin() {
    $("createBtn").disabled = busy;
    $("cpuBtn").disabled = busy;
    $("joinBtn").disabled = busy;
  }

  function rulesOpts(el) {
    const locked = view.phase === "play" || busy;
    el.innerHTML = `
      <div class="opt">ジョーカー
        <span class="seg" role="group" aria-label="ジョーカーの点数">
          <button type="button" data-k="joker" data-v="0" aria-pressed="${view.rules.joker === 0}">0点</button><button type="button" data-k="joker" data-v="-2" aria-pressed="${view.rules.joker === -2}">−2点</button>
        </span>
      </div>
      <div class="opt">ヤニブ宣言
        <span class="seg" role="group" aria-label="ヤニブ宣言できる点数">
          ${[5, 4, 3].map((n) => `<button type="button" data-k="limit" data-v="${n}" aria-pressed="${yanivLimit() === n}">${n}点以下</button>`).join("")}
        </span>
      </div>
      <div class="opt">宣言後
        <span class="seg" role="group" aria-label="ヤニブ宣言後の進め方">
          <button type="button" data-k="lap" data-v="0" aria-pressed="${!view.rules.lap}">即終了</button><button type="button" data-k="lap" data-v="1" aria-pressed="${view.rules.lap}">もう1周</button>
        </span>
      </div>
      ${view.phase === "play" ? '<span class="note">ルールはラウンドの合間に変更できます</span>' : ""}`;
    el.querySelectorAll(".seg button").forEach((b) => {
      b.disabled = locked;
      b.onclick = () => {
        const k = b.dataset.k;
        const body = k === "lap" ? { lap: b.dataset.v === "1" } : { [k]: Number(b.dataset.v) };
        act("rules", body);
      };
    });
  }

  function renderLobby() {
    $("lobbyCode").textContent = code;
    $("shareUrl").value = `${location.origin}${location.pathname}?room=${code}`;
    $("memberCount").textContent = view.players.length;
    $("memberList").innerHTML = view.players.map((p, i) =>
      `<li class="${i === me.seat ? "me" : ""}">${esc(p.name)}${i === view.host ? "<small>部屋主</small>" : ""}${i === me.seat ? "<small>あなた</small>" : ""}${p.cpu ? `<button class="rm" type="button" data-seat="${i}" aria-label="${esc(p.name)}を外す">×</button>` : ""}</li>`
    ).join("");
    $("memberList").querySelectorAll(".rm").forEach((b) => { b.disabled = busy; b.onclick = () => act("removeCpu", { seat: Number(b.dataset.seat) }); });
    $("addCpuBtn").disabled = busy || view.players.length >= 4;
    rulesOpts($("lobbyOpts"));
    const enough = view.players.length >= 2;
    $("startBtn").disabled = !enough || busy;
    $("lobbyHint").textContent = enough ? "そろったら誰でも開始できます" : "もう1人以上の参加を待っています。コードかリンクを送ってください";
  }

  function renderGame() {
    const P = view.players;
    const mySeat = me.seat;
    const meP = P[mySeat];
    const playing = view.phase === "play";
    const myTurn = playing && view.turn === mySeat && meP.active && !busy;
    const pend = view.pending;

    $("meta").textContent = `部屋 ${code}　ラウンド ${view.round}`;
    $("gameLeaveBtn").disabled = playing;
    $("myName").textContent = meP.name;

    // 相手（自分の次の席から順に）
    const seats = $("seats"); seats.innerHTML = "";
    for (let k = 1; k < P.length; k++) {
      const i = (mySeat + k) % P.length, p = P[i];
      const d = document.createElement("div");
      const isTurn = playing && view.turn === i;
      d.className = "seat" + (isTurn ? " active" : "") + (!p.active ? " waiting" : "");
      const called = pend && pend.caller === i;
      const status = !p.active ? "次のラウンドから参加" : called ? "ヤニブ宣言！" : isTurn ? "考え中…" : p.status;
      d.innerHTML = `
        <div class="row"><span class="name">${esc(p.name)}</span><span class="cnt">${p.active ? p.count + "枚" : ""}</span></div>
        <div class="backs">${p.active ? "<b></b>".repeat(p.count) : ""}</div>
        <div class="status${called ? " call" : ""}">${esc(status)}</div>`;
      seats.appendChild(d);
    }

    // 結果 or テーブル
    const showResult = view.phase === "roundEnd" && view.result;
    $("table").hidden = !!showResult;
    $("result").hidden = !showResult;
    if (showResult) renderResult();

    const selCards = sel.map((id) => me.hand.find((c) => c.id === id)).filter(Boolean);
    const selType = setType(selCards);
    const canDraw = myTurn && !!selType;

    if (view.pile) {
      const deck = $("deck");
      deck.textContent = view.deckCount;
      deck.disabled = !canDraw;
      deck.classList.toggle("can", canDraw);
      const pile = $("pile"); pile.innerHTML = "";
      const pk = pickable(view.pile);
      view.pile.cards.forEach((c, i) => {
        const ok = canDraw && pk.includes(i);
        const el = cardEl(c, { tag: ok ? "button" : "div" });
        if (ok) { el.classList.add("can"); el.onclick = () => play("pile", i); }
        pile.appendChild(el);
      });
      $("pileLbl").textContent = view.pile.by === null ? "捨て札" : `${P[view.pile.by].name}の捨て札`;
    }

    $("log").textContent = view.log;

    // 自分の手札
    const total = me.total;
    const tb = $("myTotal"); tb.textContent = total; tb.classList.toggle("low", total <= yanivLimit());
    const hand = $("hand"); hand.innerHTML = "";
    me.hand.slice().sort((a, b) => (a.r || 99) - (b.r || 99) || a.s.localeCompare(b.s)).forEach((c) => {
      const el = cardEl(c, { tag: "button" });
      if (sel.includes(c.id)) el.classList.add("sel");
      if (c.id === me.lastDraw && view.pile && view.pile.by === mySeat && playing) el.classList.add("new");
      el.disabled = !myTurn;
      el.onclick = () => { sel = sel.includes(c.id) ? sel.filter((x) => x !== c.id) : [...sel, c.id]; render(); };
      hand.appendChild(el);
    });

    const hint = $("hint"); hint.className = "hint";
    if (!playing) hint.textContent = "";
    else if (!meP.active) hint.textContent = "次のラウンドから参加します";
    else if (pend && pend.caller === mySeat) hint.textContent = "ヤニブ宣言中。他の人の最後の1手を待っています";
    else if (view.turn !== mySeat) hint.textContent = `${P[view.turn].name}の番です`;
    else if (busy) hint.textContent = "送信中…";
    else if (pend && !selCards.length) { hint.textContent = `${P[pend.caller].name}がヤニブ宣言。最後の1手です（カードを捨てるか、パス）`; hint.classList.add("bad"); }
    else if (!selCards.length) hint.textContent = total <= yanivLimit() && !pend ? "ヤニブできます！ 続けるなら捨てるカードを選んでください" : "捨てるカードを選んでください";
    else if (!selType) { hint.textContent = "その組み合わせは捨てられません"; hint.classList.add("bad"); }
    else { hint.textContent = "山札か、光っている捨て札をタップして引く"; hint.classList.add("ok"); }

    $("yanivBtn").disabled = !(myTurn && !pend && total <= yanivLimit());
    $("yanivBtn").hidden = !!(myTurn && pend);
    $("passBtn").hidden = !(myTurn && pend);
  }

  function renderResult() {
    const R = view.result, P = view.players, el = $("result");
    const caller = P[R.caller];
    let title, cls, sub;
    if (R.assaf !== null) {
      title = R.assaf === me.seat ? "アサフ成功！" : "アサフ！"; cls = R.assaf === me.seat ? "win" : "assaf";
      sub = `${caller.name}のヤニブ（${R.t}点）に、${P[R.assaf].name}が返しました。`;
    } else {
      title = R.caller === me.seat ? "ヤニブ成功！" : `${caller.name}のヤニブ成功`; cls = R.caller === me.seat ? "win" : "";
      sub = `${caller.name}が${R.t}点で宣言しました。`;
    }
    el.innerHTML = `<h2 class="${cls}">${esc(title)}</h2><p class="sub">${esc(sub)}</p><div class="opts" id="resultOpts"></div><div class="res" id="res"></div>
      <button class="primary big" id="nextBtn" type="button">次のラウンドへ</button>`;
    rulesOpts(el.querySelector("#resultOpts"));
    const res = el.querySelector("#res");
    R.rows.forEach((row) => {
      const r = document.createElement("div"); r.className = "r";
      const cards = document.createElement("div"); cards.className = "cards";
      row.hand.forEach((c) => cards.appendChild(cardEl(c, { mini: true })));
      let tag = "";
      if (row.seat === R.caller) tag = `<span class="tag${R.assaf !== null ? " bad" : ""}">${R.assaf !== null ? "宣言失敗 +30" : "宣言"}</span>`;
      else if (row.seat === R.assaf) tag = `<span class="tag">アサフ</span>`;
      r.innerHTML = `<span class="nm">${esc(row.name)}${row.seat === me.seat ? "（あなた）" : ""}</span>`;
      r.appendChild(cards);
      const pts = document.createElement("div"); pts.className = "pts";
      pts.innerHTML = `<b class="${row.pts <= 0 ? "zero" : ""}">${row.pts}点</b><small>手札 ${row.total}</small>${tag}`;
      r.appendChild(pts);
      res.appendChild(r);
    });
    const nb = el.querySelector("#nextBtn");
    nb.disabled = busy || P.length < 2;
    nb.onclick = () => act("start");
  }

  function play(from, idx) {
    const ids = sel.slice();
    sel = [];
    act("play", { ids, from, idx });
  }

  // ---------- 入室 ----------
  const nameInput = $("nameInput"), codeInput = $("codeInput");
  nameInput.value = store.get("yaniv.name") || "";
  const params = new URLSearchParams(location.search);
  if (params.get("room")) codeInput.value = params.get("room").toUpperCase();

  function getName() {
    const n = nameInput.value.trim();
    if (!n) { $("joinError").textContent = "名前を入力してください"; nameInput.focus(); return null; }
    store.set("yaniv.name", n);
    $("joinError").textContent = "";
    return n;
  }
  async function enter(action, body) {
    if (busy) return;
    busy = true; render();
    try { apply(await api(action, body)); }
    catch (e) { $("joinError").textContent = e.message; }
    finally { busy = false; render(); }
  }
  $("createBtn").onclick = () => { const name = getName(); if (name) enter("create", { name }); };
  let cpus = 3;
  document.querySelectorAll("[data-cpus]").forEach((b) => b.onclick = () => {
    cpus = Number(b.dataset.cpus);
    document.querySelectorAll("[data-cpus]").forEach((x) => x.setAttribute("aria-pressed", x === b));
  });
  $("cpuBtn").onclick = () => { const name = getName(); if (name) enter("create", { name, cpus }); };
  $("addCpuBtn").onclick = () => act("addCpu");
  $("joinBtn").onclick = () => {
    const name = getName(); if (!name) return;
    const c = codeInput.value.trim().toUpperCase();
    if (c.length !== 4) { $("joinError").textContent = "部屋コードは4文字です"; return; }
    code = c; enter("join", { name });
  };
  codeInput.addEventListener("keydown", (e) => { if (e.key === "Enter") $("joinBtn").click(); });

  $("startBtn").onclick = () => act("start");
  $("yanivBtn").onclick = () => act("yaniv");
  $("passBtn").onclick = () => { sel = []; act("pass"); };
  $("deck").onclick = () => play("deck", -1);
  $("leaveBtn").onclick = leave;
  $("gameLeaveBtn").onclick = leave;
  $("copyBtn").onclick = async () => {
    const u = $("shareUrl");
    try { await navigator.clipboard.writeText(u.value); toast("招待リンクをコピーしました"); }
    catch (e) { u.select(); toast("リンクを選択しました。コピーして送ってください"); }
  };
  document.addEventListener("visibilitychange", () => { if (!document.hidden) refresh(); });

  // 前回いた部屋に自動で戻る
  const saved = store.get("yaniv.room");
  const target = (params.get("room") || saved || "").toUpperCase();
  render();
  if (target && (!params.get("room") || params.get("room").toUpperCase() === saved)) {
    code = target;
    api("state").then(apply).catch(() => { code = null; store.del("yaniv.room"); render(); });
  }
})();
