// ヤニブ オンライン対戦のゲームサーバー
// 手札と山札はこの関数の中（service role）だけで扱い、クライアントには
// 「全員に見せてよい情報（view）」と「本人の手札（me）」だけを返す。
import { createClient } from "npm:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

const SUITS = ["♠", "♥", "♦", "♣"];
const HAND = 5, MAX_PLAYERS = 4;
const LIMITS = [5, 4, 3]; // ヤニブ宣言できる点数の上限（選択式）
const CPU_NAMES = ["CPUサラ", "CPUヨニ", "CPUダナ"];
const CPU_WAIT = 900; // CPU が次に動くまでの最短間隔(ms)
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

type Card = { id: number; r: number; s: string };
type Player = { name: string; tokenHash: string; hand: Card[]; status: string; active: boolean; lastDraw: number | null; cpu?: boolean };
type Pile = { cards: Card[]; type: string; by: number | null };
type Row = { seat: number; name: string; hand: Card[]; total: number; pts: number };
type State = {
  phase: "lobby" | "play" | "roundEnd";
  rules: { joker: number; lap: boolean; limit: number; runs?: boolean };
  players: Player[];
  host: number;
  round: number;
  starter: number;
  deck: Card[];
  dead: Card[];
  pile: Pile | null;
  turn: number;
  pending: { caller: number; t: number; queue: number[] } | null;
  log: string;
  result: { caller: number; t: number; assaf: number | null; rows: Row[] } | null;
  lastAt?: number;
};

class GameError extends Error {
  constructor(msg: string, public status = 400) { super(msg); }
}

// ---------- ルール ----------
const rankLabel = (r: number) => r === 0 ? "★" : r === 1 ? "A" : r === 11 ? "J" : r === 12 ? "Q" : r === 13 ? "K" : String(r);
const cardText = (c: Card) => c.r === 0 ? "ジョーカー" : c.s + rankLabel(c.r);

function rand(n: number) {
  const a = new Uint32Array(1);
  crypto.getRandomValues(a);
  return a[0] % n;
}
function shuffle<T>(a: T[]) {
  for (let i = a.length - 1; i > 0; i--) { const j = rand(i + 1); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
function makeDeck(): Card[] {
  const d: Card[] = []; let id = 0;
  for (const s of SUITS) for (let r = 1; r <= 13; r++) d.push({ id: id++, r, s });
  d.push({ id: id++, r: 0, s: "J" }, { id: id++, r: 0, s: "J" });
  return shuffle(d);
}
const val = (s: State, c: Card) => c.r === 0 ? s.rules.joker : c.r === 13 ? -1 : c.r;
const sum = (s: State, cs: Card[]) => cs.reduce((a, c) => a + val(s, c), 0);

// runs=false のときは階段（同じマークの連番）を認めない
function setType(cs: Card[], runs = true): string | null {
  if (!cs.length) return null;
  if (cs.length === 1) return "single";
  const nj = cs.filter((c) => c.r > 0), jk = cs.length - nj.length;
  if (nj.length === 0 || nj.every((c) => c.r === nj[0].r)) return "set";
  if (runs && cs.length >= 3 && nj.every((c) => c.s === nj[0].s)) {
    const rs = nj.map((c) => c.r).sort((a, b) => a - b);
    for (let i = 1; i < rs.length; i++) if (rs[i] === rs[i - 1]) return null;
    if (rs[rs.length - 1] - rs[0] + 1 - rs.length <= jk) return "run";
  }
  return null;
}
function arrange(cs: Card[], type: string): Card[] {
  if (type !== "run") return cs.slice();
  const nj = cs.filter((c) => c.r > 0).sort((a, b) => a.r - b.r);
  const jk = cs.filter((c) => c.r === 0);
  const out = [nj[0]];
  for (let i = 1; i < nj.length; i++) {
    for (let g = nj[i - 1].r + 1; g < nj[i].r; g++) out.push(jk.pop()!);
    out.push(nj[i]);
  }
  while (jk.length) out.push(jk.pop()!);
  return out;
}
const pickable = (p: Pile) => p.type === "run" ? [0, p.cards.length - 1] : p.cards.map((_, i) => i);

function nextActive(s: State, i: number) {
  const n = s.players.length;
  for (let k = 1; k <= n; k++) { const j = (i + k) % n; if (s.players[j].active) return j; }
  return i;
}

function drawDeck(s: State): Card | null {
  if (!s.deck.length) {
    if (!s.dead.length) return null;
    s.deck = shuffle(s.dead); s.dead = [];
  }
  return s.deck.pop() ?? null;
}

function newRound(s: State) {
  if (s.players.length < 2) throw new GameError("2人以上そろうと始められます");
  s.round++;
  s.deck = makeDeck(); s.dead = [];
  s.players.forEach((p) => { p.hand = []; p.status = ""; p.active = true; p.lastDraw = null; });
  for (let k = 0; k < HAND; k++) s.players.forEach((p) => p.hand.push(s.deck.pop()!));
  s.pile = { cards: [s.deck.pop()!], type: "single", by: null };
  s.turn = s.starter % s.players.length;
  s.phase = "play"; s.pending = null; s.result = null;
  s.log = `ラウンド ${s.round} 開始。${s.players[s.turn].name}の番から。`;
}

function play(s: State, seat: number, ids: number[], from: string, idx: number) {
  if (s.phase !== "play" || s.turn !== seat) throw new GameError("あなたの番ではありません");
  const P = s.players[seat];
  if (!Array.isArray(ids) || !ids.length || new Set(ids).size !== ids.length) throw new GameError("捨てるカードを選んでください");
  const cards = ids.map((id) => P.hand.find((c) => c.id === id));
  if (cards.some((c) => !c)) throw new GameError("手札にないカードです");
  const type = setType(cards as Card[], s.rules.runs !== false);
  if (!type) throw new GameError("その組み合わせは捨てられません");
  const old = s.pile!;
  let got: Card | null;
  if (from === "pile") {
    if (!pickable(old).includes(idx)) throw new GameError("そのカードは拾えません");
    got = old.cards.splice(idx, 1)[0];
  } else {
    got = null;
  }
  P.hand = P.hand.filter((c) => !ids.includes(c.id));
  if (from !== "pile") got = drawDeck(s);
  s.dead.push(...old.cards);
  if (got) P.hand.push(got);
  P.lastDraw = got ? got.id : null;
  const set = arrange(cards as Card[], type);
  s.pile = { cards: set, type, by: seat };
  const thrown = set.map(cardText).join(" ");
  const took = from === "pile" && got ? `${cardText(got)}を拾った` : "山札から引いた";
  P.status = `${thrown} を捨てた`;
  s.log = `${P.name}：${thrown} を捨てて、${took}。`;

  if (s.pending) advancePending(s);
  else s.turn = nextActive(s, seat);
}

// 「もう1周」中に1人分の番が終わったら次の人へ。全員終われば手札を比べる
function advancePending(s: State) {
  s.pending!.queue.shift();
  if (!s.pending!.queue.length) { resolve(s, s.pending!.caller); return; }
  s.turn = s.pending!.queue[0];
}

// 「もう1周」の最後の1手を、カードを捨てずに見送る
function pass(s: State, seat: number) {
  if (s.phase !== "play" || s.turn !== seat) throw new GameError("あなたの番ではありません");
  if (!s.pending) throw new GameError("パスできるのはヤニブ宣言後の最後の1手だけです");
  const P = s.players[seat];
  P.status = "パス";
  P.lastDraw = null;
  s.log = `${P.name}はパスしました。`;
  advancePending(s);
}

function callYaniv(s: State, seat: number) {
  if (s.phase !== "play" || s.turn !== seat) throw new GameError("あなたの番ではありません");
  if (s.pending) throw new GameError("すでにヤニブが宣言されています");
  const P = s.players[seat], t = sum(s, P.hand);
  const limit = s.rules.limit ?? 5;
  if (t > limit) throw new GameError(`手札の合計が${limit}点以下のときだけ宣言できます`);
  P.status = "ヤニブ宣言";
  if (!s.rules.lap) { resolve(s, seat); return; }
  const queue: number[] = [];
  for (let j = nextActive(s, seat); j !== seat; j = nextActive(s, j)) queue.push(j);
  if (!queue.length) { resolve(s, seat); return; }
  s.pending = { caller: seat, t, queue };
  s.turn = queue[0];
  // 宣言者の点数は公開しない（相手に手札の合計を知られないため）
  s.log = `${P.name}が「ヤニブ！」。残り1周、最後の1手です。`;
}

function resolve(s: State, caller: number) {
  const t = sum(s, s.players[caller].hand);
  let assaf: number | null = null, at = Infinity;
  for (let j = nextActive(s, caller); j !== caller; j = nextActive(s, j)) {
    const v = sum(s, s.players[j].hand);
    if (v <= t && v < at) { assaf = j; at = v; }
  }
  const rows: Row[] = [];
  s.players.forEach((p, j) => {
    if (!p.active) return;
    const total = sum(s, p.hand);
    const pts = j === caller ? (assaf !== null ? total : 0) : j === assaf ? 0 : total;
    rows.push({ seat: j, name: p.name, hand: p.hand.slice(), total, pts });
  });
  s.result = { caller, t, assaf, rows };
  // 次のラウンドは負けた人から（ヤニブ返しされた宣言者、それ以外は手札の合計が一番多い人）
  s.starter = assaf !== null ? caller : rows.reduce((a, b) => (b.total > a.total ? b : a)).seat;
  s.pending = null;
  s.phase = "roundEnd";
  s.log = assaf !== null
    ? `${s.players[assaf].name}が${s.players[caller].name}にヤニブ返し！`
    : `${s.players[caller].name}のヤニブ成功！`;
}

// ---------- CPU ----------
function addCpu(s: State) {
  if (s.players.length >= MAX_PLAYERS) throw new GameError("これ以上は入れません（最大4人）");
  const name = CPU_NAMES.find((n) => !s.players.some((p) => p.name === n)) ?? "CPU";
  s.players.push({ name, tokenHash: "", hand: [], status: "", active: false, lastDraw: null, cpu: true });
}

function removeSeat(s: State, seat: number) {
  s.players.splice(seat, 1);
  if (s.host === seat) s.host = s.players.findIndex((p) => !p.cpu); else if (s.host > seat) s.host--;
  if (s.host < 0) s.host = 0;
  if (s.starter >= s.players.length) s.starter = 0;
}

function cpuMove(s: State) {
  const pi = s.turn, P = s.players[pi];
  const t = sum(s, P.hand), limit = s.rules.limit ?? 5;
  if (!s.pending && t <= limit) {
    const others = s.players.filter((p, j) => j !== pi && p.active);
    const minCards = Math.min(...others.map((p) => p.hand.length));
    if (t <= 1 || minCards >= 3 || rand(100) < 45) { callYaniv(s, pi); return; }
  }
  // 最後の1手で手札が十分低ければ、崩さずにパスする
  if (s.pending && t <= 3) { pass(s, pi); return; }
  // 捨てる組み合わせ：合計点が最大、同点なら枚数が多いもの
  const h = P.hand; let best: Card[] = [h[0]], bv = -Infinity, bn = 0;
  for (let m = 1; m < (1 << h.length); m++) {
    const cs = h.filter((_, i) => m & (1 << i));
    if (!setType(cs, s.rules.runs !== false)) continue;
    const v = sum(s, cs);
    if (v > bv || (v === bv && cs.length > bn)) { best = cs; bv = v; bn = cs.length; }
  }
  const rest = h.filter((c) => !best.includes(c));
  // 引くカード：低い点か、残りの手札とペアになるなら拾う
  let pick: number | null = null, pv = Infinity;
  for (const i of pickable(s.pile!)) {
    const c = s.pile!.cards[i], v = val(s, c);
    const good = c.r === 0 || v <= 3 || (v <= 6 && rest.some((x) => x.r === c.r));
    if (good && v < pv) { pick = i; pv = v; }
  }
  play(s, pi, best.map((c) => c.id), pick === null ? "deck" : "pile", pick ?? -1);
}

// ---------- 公開用の情報 ----------
function publicView(s: State) {
  return {
    phase: s.phase,
    rules: { ...s.rules, limit: s.rules.limit ?? 5, runs: s.rules.runs !== false },
    round: s.round,
    host: s.host,
    turn: s.turn,
    pile: s.pile,
    deckCount: s.deck.length,
    // 宣言者の点数は伏せる
    pending: s.pending ? { caller: s.pending.caller, queue: s.pending.queue } : null,
    log: s.log,
    result: s.phase === "roundEnd" ? s.result : null,
    players: s.players.map((p) => ({ name: p.name, count: p.hand.length, status: p.status, active: p.active, cpu: !!p.cpu })),
  };
}
function mine(s: State, seat: number) {
  const p = s.players[seat];
  return { seat, hand: p.hand, lastDraw: p.lastDraw, total: sum(s, p.hand) };
}

// ---------- 保存 ----------
async function hash(token: string) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("yaniv:" + token));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function load(code: string) {
  const { data, error } = await db.from("yaniv_rooms").select("state, version").eq("code", code).maybeSingle();
  if (error) throw new GameError("読み込みに失敗しました", 500);
  if (!data) throw new GameError("部屋が見つかりません。コードを確認してください", 404);
  return data as { state: State; version: number };
}
async function save(code: string, s: State, version: number) {
  const now = new Date().toISOString();
  s.lastAt = Date.now();
  const { data, error } = await db.from("yaniv_rooms")
    .update({ state: s, version: version + 1, updated_at: now })
    .eq("code", code).eq("version", version).select("code");
  if (error) throw new GameError("保存に失敗しました", 500);
  if (!data || !data.length) throw new GameError("ほかの人の操作と重なりました。もう一度お試しください", 409);
  await db.from("yaniv_public").upsert({ code, view: publicView(s), version: version + 1, updated_at: now });
}

function cleanName(name: unknown) {
  const n = String(name ?? "").trim().slice(0, 12);
  if (!n) throw new GameError("名前を入力してください");
  return n;
}

// ---------- ハンドラ ----------
async function handle(body: Record<string, unknown>) {
  const action = String(body.action ?? "");
  const token = String(body.token ?? "");
  if (token.length < 16) throw new GameError("不正なリクエストです");
  const th = await hash(token);

  if (action === "create") {
    const name = cleanName(body.name);
    const s: State = {
      phase: "lobby", rules: { joker: body.joker === -2 ? -2 : 0, lap: body.lap === true, limit: LIMITS.includes(Number(body.limit)) ? Number(body.limit) : 5, runs: body.runs !== false },
      players: [{ name, tokenHash: th, hand: [], status: "", active: false, lastDraw: null }],
      host: 0, round: 0, starter: 0, deck: [], dead: [], pile: null, turn: 0, pending: null,
      log: "", result: null,
    };
    const cpus = Math.max(0, Math.min(3, Number(body.cpus) || 0));
    for (let k = 0; k < cpus; k++) addCpu(s);
    for (let tries = 0; tries < 8; tries++) {
      const code = Array.from({ length: 4 }, () => CODE_CHARS[rand(CODE_CHARS.length)]).join("");
      const { error } = await db.from("yaniv_rooms").insert({ code, state: s, version: 0 });
      if (error) continue;
      await db.from("yaniv_public").insert({ code, view: publicView(s), version: 0 });
      return { code, view: publicView(s), me: mine(s, 0) };
    }
    throw new GameError("部屋を作れませんでした。もう一度お試しください", 500);
  }

  const code = String(body.code ?? "").trim().toUpperCase();
  if (!/^[A-Z0-9]{4}$/.test(code)) throw new GameError("部屋コードは4文字です");
  const { state: s, version } = await load(code);
  let seat = s.players.findIndex((p) => !p.cpu && p.tokenHash === th);

  if (action === "join") {
    const name = cleanName(body.name);
    if (seat >= 0) {
      s.players[seat].name = name;
    } else {
      if (s.players.length >= MAX_PLAYERS) throw new GameError("この部屋は満員です（最大4人）");
      if (s.phase === "play") throw new GameError("ゲーム中です。ラウンドが終わってから参加してください");
      s.players.push({ name, tokenHash: th, hand: [], status: "", active: false, lastDraw: null });
      seat = s.players.length - 1;
      s.log = `${name}が参加しました。`;
    }
    await save(code, s, version);
    return { code, view: publicView(s), me: mine(s, seat) };
  }

  if (seat < 0) throw new GameError("この部屋のメンバーではありません", 403);

  switch (action) {
    case "state":
      return { code, view: publicView(s), me: mine(s, seat) };
    case "rules":
      if (s.phase === "play") throw new GameError("ルールはラウンドの合間に変更できます");
      if (body.joker === 0 || body.joker === -2) s.rules.joker = body.joker;
      if (typeof body.lap === "boolean") s.rules.lap = body.lap;
      if (LIMITS.includes(Number(body.limit))) s.rules.limit = Number(body.limit);
      if (typeof body.runs === "boolean") s.rules.runs = body.runs;
      break;
    case "start":
      if (s.phase === "play") throw new GameError("すでにゲーム中です");
      newRound(s);
      break;
    case "play":
      play(s, seat, body.ids as number[], String(body.from ?? "deck"), Number(body.idx ?? -1));
      break;
    case "yaniv":
      callYaniv(s, seat);
      break;
    case "pass":
      pass(s, seat);
      break;
    case "addCpu":
      if (s.phase === "play") throw new GameError("CPUはラウンドの合間に追加できます");
      addCpu(s);
      s.log = "CPUが参加しました。";
      break;
    case "removeCpu": {
      const t = Number(body.seat);
      if (s.phase === "play") throw new GameError("CPUはラウンドの合間に外せます");
      if (!s.players[t] || !s.players[t].cpu) throw new GameError("CPUを選んでください");
      removeSeat(s, t);
      s.log = "CPUが抜けました。";
      break;
    }
    case "cpu":
      // 誰の画面から呼ばれても、CPUの番で間隔が空いていれば1手だけ進める
      if (s.phase !== "play" || !s.players[s.turn].cpu || Date.now() - (s.lastAt ?? 0) < CPU_WAIT) {
        return { code, view: publicView(s), me: mine(s, seat) };
      }
      cpuMove(s);
      break;
    case "leave": {
      if (s.phase === "play") throw new GameError("ゲーム中は退出できません");
      removeSeat(s, seat);
      if (!s.players.some((p) => !p.cpu)) { await db.from("yaniv_rooms").delete().eq("code", code); return { left: true }; }
      s.log = "1人退出しました。";
      await save(code, s, version);
      return { left: true };
    }
    default:
      throw new GameError("不明な操作です");
  }
  await save(code, s, version);
  return { code, view: publicView(s), me: mine(s, seat) };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const body = await req.json();
    const out = await handle(body);
    return new Response(JSON.stringify(out), { headers: { ...cors, "Content-Type": "application/json" } });
  } catch (e) {
    const status = e instanceof GameError ? e.status : 500;
    const msg = e instanceof GameError ? e.message : "サーバーでエラーが起きました";
    if (!(e instanceof GameError)) console.error(e);
    return new Response(JSON.stringify({ error: msg }), { status, headers: { ...cors, "Content-Type": "application/json" } });
  }
});
