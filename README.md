# design-to-code

Figma の URL またはデザイン画像を渡すと、Claude Code が対象プロジェクトのコードへ実装し、デザインとの差分が閾値に収まるまで最大 3 回調整する Claude Code のプラグイン。実装の規約・トークン・ビルドのコマンドは対象プロジェクトの規約（エージェントに読み込まれている指示、README、既存コード）と `package.json` から読むため、設定ファイルは持たない。

## プロジェクトへの導入

1. Google Chrome を入れる。`design-diff` は、マシンに入っている Chrome で実装を撮影する。

2. Claude Code でプラグインを入れる。`design-diff` が使う `playwright-core` `pixelmatch` `pngjs` は、インストール時に Claude Code がプラグインの中に入れる。

   ```text
   /plugin install design-to-code --marketplace kinjo3/design-to-code
   ```

3. サンドボックス内では Chrome が起動しないため、Claude Code の設定の `sandbox.excludedCommands` に `design-diff *` を足す。`Bash(design-diff *)` は許可ルール（`permissions.allow`）に足さない。`design-diff` はサンドボックスの外で動き、`--design` などで渡されたファイルをサンドボックスの制限を受けずに読むので、実行のたびに引数を確かめてから承認する。

   撮影中の Chrome は、開発サーバーと、`--allow-domain` で渡したホストにだけ通信する。Web フォントなどの外部の宛先は、Claude Code が許可するかを確認したうえで `--allow-domain` に渡す。`--allow-domain` を付けた実行は、auto mode でも、プラグインの hook が「次の外部サイトと通信することを許可しますか？」と宛先を並べて承認を求める。同じセッションの間は、承認した宛先だけを使う実行では再び尋ねない。セッションを終えると承認を忘れるので、再開したセッションでは改めて尋ねる。並んだ宛先が、送ったデータを第三者が受け取れる宛先（オブジェクトストレージ、計測タグの送信先、誰でもサブドメインを持てるホスティングなど）でないかを確かめてから承認する。ページのコードは AI が書くので、許可した宛先へは、AI が読んだ内容を送れる。

4. 差分チェックの出力先 `.design-diff/` を `.gitignore` に足す。

5. Figma の URL から実装する場合は、Figma の MCP（`get_design_context` `get_screenshot` `get_variable_defs` `get_metadata` `download_assets`）を Claude Code に許可する。デザイン画像だけを使う場合は不要。

## 使い方

開発サーバーを起動した状態で、Claude Code に Figma の URL かデザイン画像（PNG）を渡して依頼する。デザイン画像の渡し方は、クリップボードからのコピーアンドペーストでも可能。

```text
https://www.figma.com/design/<file>?node-id=1-2 を実装して
```

```text
design/hero.png を実装して
```

合格の条件、差分チェックの出力、Claude Code が差分チェックを終えるまで終了しない仕組みは [docs/diff-check.md](docs/diff-check.md) を参照。

