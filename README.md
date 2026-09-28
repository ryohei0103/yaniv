# ヤニブ（オンライン対戦）

手札の合計を小さくするトランプゲーム「ヤニブ」を、2〜4人でオンライン対戦できるWebアプリ。

- 部屋を作ると4文字の部屋コードと招待リンクが発行される
- 手札の中身と合計は Supabase Edge Function の中だけで管理し、相手には枚数しか見えない
- 「CPUと対戦」で1人でも遊べる。友だちとCPUを混ぜることもできる（最大4人）
- ルール選択：ジョーカー（0点 / −2点）、ヤニブ宣言できる点数（5 / 4 / 3点以下）、宣言後（即終了 / もう1周）

## 構成

| ファイル | 役割 |
| --- | --- |
| `index.html` / `style.css` / `app.js` | 画面（GitHub Pages で配信） |
| `config.js` | Supabase の URL と anon キー（公開キー） |
| `supabase/functions/yaniv/index.ts` | ゲーム進行を行う Edge Function |
| `schema.sql` | テーブル定義 |

## ローカルで動かす

```bash
python3 -m http.server 8765
```

http://localhost:8765/ を開く。同じブラウザの別タブは同一プレイヤー扱いになるので、2人目は http://127.0.0.1:8765/ など別オリジンで開く。
